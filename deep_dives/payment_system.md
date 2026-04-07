# Payment System — 支付系統架構設計

## 1. 核心挑戰

支付系統的設計核心是 **資金正確性與一致性**——錢不能多也不能少：

```
規模（以 Stripe 等級為參考）：
  商家數量: ~數百萬
  日交易量: ~2.5 億筆 → ~3K TPS（均值），峰值 ~10K TPS（Black Friday）
  日交易金額: ~$10B+
  API 呼叫/日: ~10 億次（含查詢、webhook 等）

核心矛盾：
  - 使用者期望付款 < 2 秒完成（同步授權），但結算需要 T+1 ~ T+2（非同步）
  - 網路不可靠，但錢不能多扣也不能少扣（Exactly-once 語意）
  - 全球多幣種、多支付方式，但帳務必須精準到分
  - 需同時滿足速度（使用者體驗）與合規（PCI DSS, 反洗錢）

失敗的代價：
  - 重複扣款 → 客訴 + 法律風險
  - 漏扣款 → 商家損失
  - 帳務不平 → 審計不過，牌照可能被吊銷
```

---

## 2. 整體架構

```
┌──────────┐     ┌──────────────┐     ┌───────────────────┐
│ Client   │────▶│ API Gateway  │────▶│ Payment Service   │
│ (App/Web)│     │ (Rate Limit, │     │ (Orchestrator)    │
└──────────┘     │  Auth, TLS)  │     │                   │
                 └──────────────┘     │ ┌───────────────┐ │
                                      │ │ Idempotency   │ │
                                      │ │ Store (Redis) │ │
                                      │ └───────────────┘ │
                                      └────────┬──────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    │                          │                          │
                    ▼                          ▼                          ▼
          ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
          │ Fraud Detection │     │ Payment Processor │     │ Ledger Service   │
          │ Service         │     │ Adapter           │     │ (Double-entry    │
          │ (Risk Score)    │     │ (Stripe/Adyen/    │     │  Bookkeeping)    │
          │                 │     │  PayPal)          │     │                  │
          └─────────────────┘     └────────┬─────────┘     └──────────────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ External Payment  │
                                  │ Processor (Stripe)│
                                  │      │            │
                                  │      ▼            │
                                  │ Card Network      │
                                  │ (Visa/Mastercard) │
                                  │      │            │
                                  │      ▼            │
                                  │ Issuing Bank      │
                                  └──────────────────┘
                                           │
                                    Webhook callback
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ Webhook Handler   │──▶ Update payment status
                                  │ (Async callback)  │──▶ Ledger entries
                                  └──────────────────┘    ──▶ Notify merchant

                                  ┌──────────────────┐
                                  │ Reconciliation    │ ◀── 每日批次
                                  │ Service           │ ◀── Bank settlement files
                                  │ (End-of-day)      │──▶ Discrepancy alerts
                                  └──────────────────┘
```

---

## 3. 支付流程：同步授權 + 非同步結算

這是支付系統最基本也最重要的概念：**授權 (Authorization) 是同步的，結算 (Settlement) 是非同步的**。

### 完整流程

```
Step 1: Checkout（Client → Payment Service）
  POST /v1/payments
  {
    "idempotency_key": "uuid-abc-123",
    "amount": 9999,          // $99.99，以 cents 為最小單位
    "currency": "USD",
    "payment_method": "pm_card_visa_4242",
    "merchant_id": "merch_001"
  }

Step 2: Fraud Check（同步，< 100ms）
  Payment Service → Fraud Detection Service
  → 風險評分 < 閾值 → 通過
  → 風險評分 > 閾值 → 觸發 3DS 驗證或拒絕

Step 3: Authorization（同步，200-500ms）
  Payment Service → Payment Processor (Stripe API)
  → Stripe → Card Network (Visa) → Issuing Bank
  → Bank 檢查餘額/額度 → 授權成功/失敗
  → 回傳 authorization_code

Step 4: 回應 Client（總計 < 2 秒）
  → 200 OK { "payment_id": "pay_xxx", "status": "AUTHORIZED" }
  → 此時錢還沒有真正轉移，只是「凍結」了持卡人的額度

Step 5: Capture（可立即或延遲）
  → 電商通常在出貨時才 capture
  → 數位商品可以 auth + capture 一步完成（auto-capture）

Step 6: Settlement（非同步，T+1 ~ T+2）
  → Payment Processor 每日批次結算
  → 將資金從 Issuing Bank → Acquiring Bank → Merchant Account
  → 通過 Webhook 通知商家結算完成
```

### Payment 狀態機 (State Machine)

```
                    ┌──────────┐
                    │ CREATED  │
                    └────┬─────┘
                         │ authorize()
                         ▼
        ┌───────── AUTHORIZED ──────────┐
        │                │              │
   void()          capture()       expire()
        │                │              │
        ▼                ▼              ▼
     VOIDED          CAPTURED       EXPIRED
                         │
                    settle()
                         │
                         ▼
                     SETTLED
                         │
                    refund()
                         │
                         ▼
                  PARTIALLY_REFUNDED
                    or REFUNDED

  失敗路徑：任何步驟都可能 → FAILED
```

**為什麼用狀態機？** 每次狀態轉移都有明確的合法前置狀態，防止非法操作（例如不能對 VOIDED 的交易做 capture）。狀態機搭配資料庫樂觀鎖 (Optimistic Locking) 可以避免併發問題。

---

## 4. 冪等性 (Idempotency)：Exactly-Once 語意

這是支付系統面試中 **最常被問到的設計要點**。網路不可靠，Client 可能因為 timeout 而重試，但我們必須保證一筆支付只執行一次。

### 機制

```
Client 生成 idempotency_key（UUID v4）→ 隨 request 送出

Payment Service 收到 request：
  1. 查 idempotency store：key 是否已存在？
     │
     ├── 不存在 → 正常處理，結果寫入 idempotency store
     │            Key: idempotency_key
     │            Value: { request_hash, status, response, created_at }
     │            TTL: 72 hours
     │
     └── 已存在 → 比對 request_hash
                  │
                  ├── Hash 匹配 → 回傳 cached response（不重新執行）
                  └── Hash 不匹配 → 422 Conflict（同一個 key 不同 request body）
```

### 為什麼 TTL 是 72 小時？

```
太短（< 24h）：
  → 使用者週五下單 timeout，週一才重試 → key 已過期 → 重複扣款

太長（> 7d）：
  → 儲存成本高，且 key collision 機率極低（UUID v4 = 2^122 種）

72 小時是業界常見值：
  → 涵蓋一個完整週末
  → Stripe 的 idempotency window 是 24 小時
```

### 實作細節：避免 Race Condition

```
// 錯誤做法：先查再寫（TOCTOU 問題）
result = redis.GET(idempotency_key)
if result is None:
    process_payment()           // 兩個相同 request 可能同時到這裡
    redis.SET(idempotency_key, response)

// 正確做法：用 SETNX（SET if Not eXists）原子操作
acquired = redis.SET(idempotency_key, "PROCESSING", NX=True, EX=72*3600)
if not acquired:
    // Key 已存在
    cached = redis.GET(idempotency_key)
    if cached.status == "PROCESSING":
        // 前一個 request 還在處理中 → 回傳 409 Conflict，Client 稍後重試
        return 409
    else:
        // 已完成 → 回傳 cached response
        return cached.response

// Key 剛被我鎖定 → 正常處理
response = process_payment()
redis.SET(idempotency_key, { status: "DONE", response: response, request_hash: hash })
return response
```

### 資料模型

```sql
idempotency_keys:
  idempotency_key   VARCHAR(64) PRIMARY KEY
  request_hash      VARCHAR(64)    -- SHA-256 of request body
  status            ENUM('PROCESSING', 'DONE', 'FAILED')
  response_code     INT
  response_body     JSON
  created_at        TIMESTAMP
  expires_at        TIMESTAMP      -- created_at + 72h

INDEX idx_expires (expires_at)     -- 定期清理過期 keys
```

---

## 5. 複式簿記 (Double-Entry Bookkeeping)

每一筆交易都必須同時產生一筆借方 (Debit) 和一筆貸方 (Credit)，金額相等。這不是「nice to have」，而是 **金融系統的根基**。

### 為什麼？

```
單式記帳的問題：
  UPDATE accounts SET balance = balance - 100 WHERE id = 'buyer'
  UPDATE accounts SET balance = balance + 100 WHERE id = 'seller'

  → 如果第一條成功、第二條失敗 → 錢憑空消失
  → 沒有審計軌跡，無法追溯錯誤
  → Reconciliation 時無法驗證帳務平衡

複式簿記的保證：
  → 每個 transaction 的 SUM(debit) == SUM(credit)
  → Ledger entries 不可修改（append-only, immutable）
  → 任何時間點都能驗證：所有帳戶的 total debit == total credit
  → 這就是為什麼 refund 是「新增一筆反向 entry」而不是「刪除原始 entry」
```

### 資料模型

```sql
ledger_entries:
  id              BIGINT PRIMARY KEY AUTO_INCREMENT
  transaction_id  VARCHAR(64)    -- 同一筆交易的 debit 和 credit 共用
  account_id      VARCHAR(64)    -- e.g., "buyer_wallet_001", "merchant_001", "platform_fee"
  amount          BIGINT         -- 以最小單位表示（cents），避免浮點數精度問題
  direction       ENUM('DEBIT', 'CREDIT')
  currency        CHAR(3)        -- ISO 4217: "USD", "TWD", "SGD"
  description     VARCHAR(256)
  created_at      TIMESTAMP

  -- Ledger entries 永遠不 UPDATE 或 DELETE

INDEX idx_transaction (transaction_id)
INDEX idx_account (account_id, created_at)
```

### 範例：一筆 $100 的支付

```
Transaction: txn_001（買家付 $100 給商家，平台抽 2.9% + $0.30）

Ledger entries:
  ┌─────────────┬──────────────────┬─────────┬──────────┐
  │ account_id  │ description      │ direction│ amount   │
  ├─────────────┼──────────────────┼──────────┼──────────┤
  │ buyer_001   │ Purchase payment │ DEBIT    │ 10000    │  ← 買家帳戶 -$100.00
  │ merchant_01 │ Sale revenue     │ CREDIT   │  9680    │  ← 商家帳戶 +$96.80
  │ platform    │ Processing fee   │ CREDIT   │   320    │  ← 平台手續費 +$3.20
  └─────────────┴──────────────────┴──────────┴──────────┘

驗證：DEBIT 總和 (10000) == CREDIT 總和 (9680 + 320 = 10000) ✓
```

### 帳戶餘額計算

```sql
-- 帳戶餘額 = SUM(CREDIT) - SUM(DEBIT)（對資產類帳戶反過來）
SELECT
  SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) -
  SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS balance
FROM ledger_entries
WHERE account_id = 'merchant_01';

-- 效能優化：每日快照 + 增量計算
account_snapshots:
  account_id    VARCHAR(64)
  snapshot_date DATE
  balance       BIGINT
  PRIMARY KEY (account_id, snapshot_date)

-- 查餘額 = 最近快照 + 快照之後的 entries
```

---

## 6. 分散式交易：Saga Pattern

支付流程往往跨越多個服務（庫存、支付、物流），無法用傳統的 ACID 事務。Saga 是主流解法。

### 範例：電商下單流程

```
正常路徑（Happy Path）：
  Step 1: Order Service     → 建立訂單（PENDING）
  Step 2: Inventory Service → 預留庫存
  Step 3: Payment Service   → 扣款授權
  Step 4: Shipping Service  → 建立出貨單
  Step 5: Order Service     → 更新訂單（CONFIRMED）

補償路徑（Step 3 支付失敗）：
  Step 3 失敗 → Payment Service 回報錯誤
  Compensate Step 2: Inventory Service → 釋放預留庫存
  Compensate Step 1: Order Service → 更新訂單（CANCELLED）

關鍵：補償 ≠ 撤銷 (Undo)
  → 釋放庫存是「新增一筆釋放記錄」，不是刪除預留記錄
  → 退款是「新增一筆退款 ledger entry」，不是刪除原始扣款
```

### Orchestration vs Choreography

| 維度 | Orchestration（中央編排） | Choreography（事件驅動） |
|------|--------------------------|-------------------------|
| **控制方式** | 中央 Saga Orchestrator 依序呼叫每個服務 | 每個服務發 event，下一個服務 react |
| **流程可見度** | 高：Orchestrator 知道全貌與目前狀態 | 低：流程分散在各服務的 event handler |
| **耦合度** | Orchestrator 與所有服務耦合 | 服務之間低耦合，但隱式依賴 event schema |
| **錯誤處理** | 容易：Orchestrator 統一處理補償邏輯 | 困難：每個服務各自處理，容易遺漏 |
| **Debugging** | 容易：查 Orchestrator 的狀態日誌 | 困難：需跨多個服務追蹤 event chain |
| **擴展性** | 新增步驟需改 Orchestrator | 新增服務只需訂閱 event |
| **適用場景** | 支付流程（步驟明確、補償邏輯複雜） | 通知、分析等非關鍵路徑 |
| **業界使用** | Uber Cadence/Temporal, Netflix Conductor | 微服務間的鬆散整合 |

### 建議

```
支付系統 → 幾乎一定用 Orchestration
  原因：
  1. 支付步驟有嚴格順序（先風控 → 再授權 → 再 capture）
  2. 補償邏輯複雜（退款需要知道原始交易的所有細節）
  3. 需要完整的 audit trail（誰在什麼時候做了什麼）
  4. 出錯時需要人工介入的可能性高 → 需要集中的狀態查詢

推薦工具：Temporal / Cadence
  → Workflow as Code：用程式語言寫 saga 邏輯，不是 JSON/YAML
  → 內建 retry、timeout、compensation
  → 執行歷史完整記錄，支援 replay debugging
```

---

## 7. 對帳 (Reconciliation)

**「信任但要驗證」(Trust but verify)。** 即使所有邏輯都正確，仍然需要每日對帳確保資金一致。

### 三方對帳

```
對帳對象：
  1. 內部帳本 (Ledger) — 我們自己記錄的每筆交易
  2. 支付處理商 (Stripe/Adyen) — 他們記錄的交易與手續費
  3. 銀行 (Bank) — 實際入帳金額

每日對帳流程（通常 T+1 凌晨 batch job）：
  1. 下載 Stripe settlement report（CSV/API）
  2. 下載 Bank statement
  3. 比對三方資料：
     ┌───────────────┬────────────┬────────────┬──────────┐
     │ transaction_id│ Our Ledger │ Stripe     │ Bank     │
     ├───────────────┼────────────┼────────────┼──────────┤
     │ txn_001       │ $100.00    │ $100.00    │ $96.80   │ ← 正確（扣除手續費）
     │ txn_002       │ $50.00     │ $50.00     │ —        │ ← 還在結算中（T+1）
     │ txn_003       │ —          │ $30.00     │ $29.13   │ ← 異常！我們沒記錄
     │ txn_004       │ $75.00     │ —          │ —        │ ← 異常！Stripe 沒記錄
     └───────────────┴────────────┴────────────┴──────────┘

差異處理規則：
  小額差異（< $0.01）  → 自動調整（匯率四捨五入差異）
  中額差異（$0.01-$10）→ 自動標記 + 隔日再驗證
  大額差異（> $10）     → 立即告警 + 人工審查
```

### 結算週期

```
T+0: 交易發生 → Authorization
T+0 ~ T+1: Capture（商家確認出貨後）
T+1 ~ T+2: Settlement（支付處理商撥款到商家帳戶）

實際到帳時間取決於：
  - 支付方式：信用卡 T+2, 電子錢包 T+0 ~ T+1
  - 地區法規：歐盟強制 D+1
  - Stripe 的 payout schedule: 每日 or 每週

這就是為什麼電商的「已付款」和「錢到帳」是兩件事。
```

---

## 8. 退款處理 (Refund)

### 核心原則：退款是新交易，不是刪除

```
原始交易 txn_001（買家付 $100 給商家）：
  buyer_001   DEBIT   10000
  merchant_01 CREDIT   9680
  platform    CREDIT    320

全額退款 refund_001：
  merchant_01 DEBIT    9680    ← 商家退錢
  platform    DEBIT     320    ← 平台退手續費（視政策而定）
  buyer_001   CREDIT  10000    ← 買家收到退款

部分退款 refund_002（退 $30）：
  merchant_01 DEBIT    2904    ← 商家退 $30 的淨額
  platform    DEBIT      96    ← 平台退 $30 對應的手續費
  buyer_001   CREDIT   3000    ← 買家收到 $30

注意：
  - 原始 ledger entries 完全不動
  - 退款是一組新的 ledger entries
  - 平台是否退手續費是商業決策（Stripe 不退處理費）
```

### 退款方式

```
原路退回 (Original Method Refund)：
  → 退回原支付方式（信用卡退回信用卡）
  → 時間：3-10 個工作天（銀行處理速度）
  → 這是監管要求的預設方式

餘額退回 (Credit Refund)：
  → 退到使用者在平台的餘額/錢包
  → 即時到帳
  → 使用者體驗好，但需要使用者同意
```

---

## 9. 反詐欺 (Fraud Detection)

### 三層防線

```
Layer 1: 規則引擎（Rule-based, < 10ms）
  ┌─────────────────────────────────────────────────┐
  │ 速度檢查：同一張卡 1 分鐘內 > 3 筆 → 攔截      │
  │ 金額檢查：單筆 > $5,000 → 額外驗證              │
  │ 地理檢查：IP 在越南，卡片發行國美國 → 風險提升    │
  │ 時間檢查：凌晨 3-5 點的大額交易 → 風險提升        │
  │ 黑名單：已知詐欺 BIN / IP / Device fingerprint   │
  └─────────────────────────────────────────────────┘

Layer 2: ML 模型（Real-time, < 50ms）
  Features:
  - 使用者歷史交易模式（平均金額、頻率、時段）
  - Device fingerprint（瀏覽器指紋、裝置 ID）
  - Behavioral signals（打字速度、滑鼠軌跡）
  - Graph features（這張卡跟多少帳號關聯？）

  Output: risk_score 0-100
  Threshold:
    0-30  → 通過
    30-70 → 觸發 3D Secure（3DS）驗證
    70+   → 直接拒絕

Layer 3: 3D Secure (3DS)
  → 銀行的額外身份驗證（OTP、生物辨識）
  → 將詐欺責任從商家轉移到銀行（liability shift）
  → 增加摩擦 → 轉換率下降 ~5-10%
  → 因此只對中高風險交易觸發，而非所有交易
```

### Trade-off：安全 vs 轉換率

```
太嚴格 → 誤拒合法交易（False Positive）→ 損失營收
  → 業界平均 False Positive Rate: 5-10%
  → 每 1% 的 FPR 降低 ≈ 數百萬美金營收增加

太寬鬆 → 詐欺通過（False Negative）→ chargeback 成本
  → Chargeback rate > 1% → Card Network 會罰款或終止合約

黃金指標：
  → Fraud Rate < 0.1%（每 $1000 交易中 < $1 是詐欺）
  → Approval Rate > 95%（合法交易通過率）
```

---

## 10. 多幣種處理 (Multi-Currency)

### 金額表示

```
錯誤做法：
  amount = 99.99  (float/double)
  → 0.1 + 0.2 = 0.30000000000000004（IEEE 754 浮點數精度問題）
  → 累積千萬筆交易後，誤差可能達數千元

正確做法：
  amount = 9999  (integer, 以 cents 為最小單位)
  → 所有運算都是整數運算，零精度損失
  → 不同貨幣最小單位不同：
     USD: 1 cent = $0.01 → amount 9999 = $99.99
     JPY: 1 yen = ¥1（無小數）→ amount 9999 = ¥9999
     BHD: 1 fils = 0.001 BHD → 三位小數

  → 用 ISO 4217 的 exponent 欄位判斷小數位數
```

### 匯率處理

```
問題：匯率每秒都在變動，使用者看到的價格和實際扣款可能不同

解法：Rate Locking（匯率鎖定）
  1. 使用者進入結帳頁 → 呼叫 Exchange Rate Service 取得當前匯率
  2. 鎖定匯率 15-30 分鐘（存在 Redis，TTL = 30min）
  3. 使用者確認付款 → 用鎖定的匯率計算
  4. 超過鎖定時間 → 重新取得匯率（顯示新價格）

匯差風險由平台承擔（或加 1-3% 匯率 spread 作為 buffer）
```

---

## 11. PCI DSS 合規

### Tokenization（代碼化）

```
核心原則：我們的系統永遠不存儲、不處理、不傳輸完整卡號

流程：
  1. Client 端直接將卡號送到 Stripe（Stripe.js / Stripe Elements）
     → 卡號不經過我們的 server
  2. Stripe 回傳一個 token (pm_card_visa_4242)
  3. 我們只儲存 token + 卡片後四碼（用於顯示）
  4. 後續扣款都用 token 而非卡號

好處：
  → 我們的系統完全脫離 PCI 範疇（PCI scope reduction）
  → PCI DSS 全合規需要 300+ 項控制措施，成本數百萬
  → 用 Stripe/Adyen tokenization 只需完成 SAQ-A（最簡單的自評問卷）
```

---

## 12. 重試與失敗處理

### 黃金法則：支付超時不能直接重試

```
危險場景：
  Client → Payment Service → Stripe API（timeout after 30s）
  → Client 沒收到回應 → 重試 → Stripe 收到兩次 → 雙重扣款！

正確做法：Query Before Retry
  1. Client timeout → 不直接重試扣款
  2. 先查詢：GET /v1/payments/{payment_id}/status
  3. 根據狀態決定：
     ├── AUTHORIZED / CAPTURED → 不需要重試，已成功
     ├── FAILED → 安全重試（用同一個 idempotency_key）
     └── CREATED / PROCESSING → 等待 + 再查詢（Stripe 可能還在處理中）
```

### Stripe 端的 Idempotency

```
Stripe API 也支援 idempotency key：
  POST /v1/charges
  Headers: Idempotency-Key: uuid-abc-123

  → 即使我們因為 timeout 重試，Stripe 會回傳第一次的結果
  → 雙重保護：我們的 idempotency + Stripe 的 idempotency
```

### Webhook 可靠性

```
Stripe Webhook callback 也可能失敗（我們的 server 宕機、網路問題）

Stripe 的重試策略：
  → 指數退避，最多重試 ~20 次，持續 3 天
  → 我們的 Webhook Handler 必須是冪等的（idempotency_key = event_id）

我們的防護：
  1. Webhook Handler 收到 event → 先確認 event_id 沒處理過
  2. 處理完畢 → 回傳 200（Stripe 停止重試）
  3. 如果 Webhook 全部失敗 → Reconciliation batch job 會補上

→ Webhook 是 primary notification，Reconciliation 是 safety net
```

---

## 13. 容量估算

| 指標 | 估算 |
|------|------|
| 日交易量 | 2.5 億筆 → **~3K TPS（均值）** |
| 峰值 TPS（Black Friday） | **~10K TPS** |
| 單筆 payment 資料 | ~2KB（含 metadata）|
| Payment storage/day | 250M × 2KB = **500GB/day** |
| Ledger entries/day | 250M × 3 entries（avg）= 750M entries → **~1.5TB/day** |
| Idempotency keys（active） | ~250M（72h window）× 128B metadata = **~32GB Redis**（僅存 status + response pointer；完整 response_body 存 DB） |
| Webhook events/day | ~500M（每筆 payment 平均 2 個 event）|
| Reconciliation batch size | ~250M records/day → **需要 Spark/Flink** |
| Redis nodes（idempotency） | 32GB / 30GB per node ≈ **2 primary + 2 replica** |
| Payment DB shards | 500GB/day × 365 = ~180TB/year → **按 merchant_id shard** |
| Ledger DB shards | 1.5TB/day × 365 = ~550TB/year → **按 account_id range shard + 冷熱分離** |

### Ledger 冷熱分離

```
熱資料（< 90 天）：MySQL / PostgreSQL，SSD
  → 佔 ~135TB，供即時查詢餘額、近期帳單

冷資料（> 90 天）：ClickHouse / BigQuery，HDD/Object Storage
  → 供對帳、審計、年度報表
  → 壓縮率高（ledger entries 重複欄位多），~10:1 壓縮

遷移：每日 batch job 將 > 90 天的 entries 搬到冷儲存
```

---

## 14. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Authorization 同步 or 非同步 | **同步** | 使用者需要即時知道是否扣款成功 |
| Settlement 同步 or 非同步 | **非同步（T+1/T+2 batch）** | 涉及銀行系統，無法即時完成 |
| Idempotency store | **Redis + DB 雙寫** | Redis 提供原子 SETNX，DB 提供持久化保障 |
| Idempotency window | **72 小時** | 涵蓋週末，平衡儲存成本與安全性 |
| 帳務系統 | **複式簿記（append-only ledger）** | 金融合規要求，防止「錢從哪裡來」不可追溯 |
| 金額儲存 | **整數最小單位（cents）** | 避免浮點精度問題，累積千萬筆不出錯 |
| Saga 模式 | **Orchestration** | 支付流程步驟明確、補償邏輯複雜、需要完整 audit trail |
| 卡號儲存 | **Tokenization（Stripe 代管）** | PCI scope reduction，省下合規成本 |
| 風控 vs 轉換率 | **分層：規則 + ML + 3DS 按風險觸發** | 低風險交易不加摩擦，高風險才驗證 |
| 對帳策略 | **每日三方對帳 + 差異分級處理** | Trust but verify，自動處理小差異，人工處理大差異 |
| Payment timeout 處理 | **Query before retry** | 直接重試可能雙重扣款 |

---

## 15. 面試常見 Follow-up

### Q: 如果 Payment Service 在扣款成功後、更新 DB 前 crash 了怎麼辦？

```
場景：
  1. Payment Service 呼叫 Stripe → 扣款成功（Stripe 已扣錢）
  2. Payment Service crash → DB 沒更新為 AUTHORIZED
  3. 重啟後 → DB 顯示 CREATED，但 Stripe 已經扣了錢

解法（多重保護）：
  1. Stripe Webhook → 會收到 payment_intent.succeeded event
     → Webhook Handler 更新 DB 狀態
  2. Reconciliation Job → 每日比對 Stripe records vs 我們的 DB
     → 發現不一致 → 自動修復或標記人工審查
  3. Saga Orchestrator 有 timeout → 超時後主動查詢 Stripe 狀態

→ 不依賴單一機制，多層安全網
```

### Q: 如何處理高並發的搶購場景（Flash Sale）？

```
1. 流量控制：API Gateway rate limiting + 排隊機制
2. 庫存預留：Redis 原子遞減（DECR）→ 比 DB 快 100 倍
3. 非同步下單：搶到名額 → 放入 Kafka → 背景處理支付
4. 支付超時釋放：預留庫存 + 支付授權設定 15 分鐘 timeout
   → 超時自動取消 → 庫存回池

峰值 TPS 估算：
  100 萬人同時搶 → 前端分批放行（每批 10K）
  → Payment Service: ~10K TPS → 需要 ~50 個 instances
  → Stripe rate limit: ~100 req/sec per API key → 需要多個 API key 或 Stripe 提前申請提額
```

### Q: 支付系統如何做灰度發布？

```
支付系統 rollout 極度保守：

1. 影子模式 (Shadow Mode)：
   → 新邏輯並行執行，但不寫入 DB
   → 比對新舊邏輯結果 → 確認一致才上線

2. 灰度比例：
   → 1% → 5% → 20% → 50% → 100%
   → 每階段觀察至少 24 小時（等一個完整的對帳週期）

3. 灰度維度：
   → 按 merchant_id hash 分流（不是 random）
   → 確保同一商家的所有交易走同一版本（避免狀態不一致）

4. 回滾：
   → 隨時可以把流量切回舊版本
   → 但已經用新版本處理的交易不能「回滾」
   → 需要確保新舊版本的 ledger entries 格式相容
```

---

## 16. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— TPS、日交易量、授權 vs 結算的時間差、可用性要求（99.999%）
2. **支付流程與狀態機（核心）**（3 分鐘）— 畫出 Checkout → Authorization → Capture → Settlement 的完整流程，強調同步授權 + 非同步結算，說明狀態機每個轉移的條件
3. **Idempotency（最重要的設計點）**（3 分鐘）— 解釋為什麼支付需要 exactly-once，idempotency key 機制，SETNX 避免 race condition，72h TTL 的考量
4. **複式簿記 + Ledger 設計**（2 分鐘）— 為什麼每筆交易都是 debit + credit，append-only 的好處，退款是新 entry 不是刪除
5. **Saga Pattern（分散式交易）**（2 分鐘）— 用訂單流程舉例，Orchestration vs Choreography 比較，為什麼支付用 Orchestration
6. **Deep Dive（面試官選）**（2 分鐘）— Reconciliation、Fraud Detection、Multi-currency、Retry/Failure Handling、PCI Compliance
