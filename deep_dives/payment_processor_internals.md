# Payment Processor Internals（Airwallex / Stripe 視角）

> 這份 deep dive 從 **Processor 內部**的角度設計支付系統。
> 與 `payment_system.md`（商家視角）互補：那份講「怎麼用 Stripe API」，這份講「怎麼做出 Stripe」。

## Priority 分類

| Priority | 模組 | 為什麼 |
|----------|------|--------|
| **🅰️ 必考** | Four-Party Model + Auth/Clearing/Settlement | 基礎知識，不會就不用聊了 |
| **🅰️ 必考** | Smart Routing Engine | Airwallex 核心差異化，最可能被考 |
| **🅰️ 必考** | FX Engine（換匯引擎） | 跨境支付是 Airwallex 的賣點 |
| **🅰️ 必考** | Ledger System (multi-currency) | 金融系統的根基，double-entry 必懂 |
| **🅱️ 高頻** | Reconciliation at Scale | Processor 的日常 infra，很可能被問 |
| **🅱️ 高頻** | Tokenization & PCI DSS | 解釋架構隔離的核心理由 |
| **🅱️ 高頻** | Payment Gateway (API 設計) | 對外 API 的設計哲學 |
| **🅲 加分** | Risk & Fraud Engine (Processor 級) | 通常有獨立 team，但概念要知道 |
| **🅲 加分** | ISO 8583 概念 | 知道存在 + 基本概念就夠 |
| **🅲 加分** | Local Payment Rails | 各地支付方式差異 |

---

## 1. 四方模型 (Four-Party Model) 🅰️

```
                        Card Network
                      (Visa / Mastercard)
                       ↑            ↑
                       │            │
              Authorization    Clearing/Settlement
              (即時 ~500ms)    (T+1~T+2 batch)
                       │            │
                       ↓            ↓
  Cardholder → Issuing Bank    Acquiring Bank ← Merchant
  (持卡人)     (發卡銀行)       (收單銀行)        (商家)
                                    ↑
                                    │
                              ┌─────┴──────┐
                              │ Airwallex  │  ← 我們在這裡
                              │ (PSP /     │
                              │ Processor) │
                              └────────────┘

角色定義：
  Cardholder：持卡人（消費者）
  Issuing Bank：發卡銀行（持卡人的銀行，例如國泰世華）
  Acquiring Bank：收單銀行（商家的銀行，替商家收錢）
  Card Network：卡組織（Visa / Mastercard / Amex），制定規則 + 清算中心
  PSP (Payment Service Provider)：Airwallex / Stripe，代商家跟 Acquirer 和 Card Network 溝通

金流方向（結算時）：
  Issuing Bank → (interchange fee) → Card Network → Acquiring Bank → PSP → Merchant
  
手續費拆分：
  商家付的 ~2.5% 手續費拆成三份：
    Interchange fee (~1.5-2.0%): → Issuing Bank（最大塊，Card Network 定的）
    Scheme fee (~0.1-0.3%):      → Card Network (Visa/MC)
    Acquirer markup (~0.2-0.5%): → Acquiring Bank + PSP (Airwallex 的收入)

  Airwallex 的利潤空間在 acquirer markup 這一段：
    → 總手續費是 Card Network 定的，你壓不了
    → Airwallex 靠 volume discount + smart routing 壓低自己付出的成本
    → 用更低的 markup 報價給商家搶市場
```

---

## 2. 交易生命週期：Authorization → Clearing → Settlement 🅰️

```
Phase 1: Authorization（即時，~500ms）
  ────────────────────────────────────
  Merchant → Airwallex → Acquirer → Card Network → Issuing Bank
  
  「這張卡有 $100 額度嗎？」
  → Issuing Bank 凍結 $100 額度（不是真的扣）
  → 回傳 auth_code（授權碼）
  → 授權有效期：通常 7-30 天（超過自動釋放凍結額度）

  ISO 8583 message:
    0100 (Authorization Request) →
    ← 0110 (Authorization Response, response_code=00 approved)

Phase 2: Capture（商家觸發，通常出貨時）
  ────────────────────────────────────
  Auth ≠ 扣款。商家可以：
    - Auth + 立即 Capture（一般電商）
    - Auth only → 幾天後 Capture（飯店、租車：先凍結，退房時才知道最終金額）
    - Auth only → 不 Capture → 額度自動釋放（客戶取消）
    - Partial Capture → Auth $200，但只 Capture $150（部分出貨）

  Airwallex 的工作：
    - 追蹤每筆 auth 的狀態（authorized / captured / expired / voided）
    - Auto-capture 機制：商家設定 auto-capture delay（例如 7 天後自動 capture）
    - Expiry monitoring：auth 快過期時通知商家或自動重新授權

Phase 3: Clearing（T+1，batch）
  ────────────────────────────────────
  Airwallex 每天把當天所有 captured 交易打包成 clearing file
  → 送到 Card Network
  → Card Network 彙整所有 PSP / Acquirer 的 clearing file
  → 算出每個 Issuer 應付 / 應收的淨額（netting）

  Netting 範例：
    Issuer A 當天的交易：
      收到 1000 筆刷卡 → 應付 $500,000
      有 50 筆退款     → 應收 $25,000
      淨額 = 應付 $475,000

Phase 4: Settlement（T+1 ~ T+2）
  ────────────────────────────────────
  Card Network 指示各銀行進行實際資金轉移
  → Issuing Bank 轉帳到 Acquiring Bank
  → Acquiring Bank 轉到 Airwallex 的帳戶
  → Airwallex 扣掉手續費後，轉到 Merchant 帳戶（payout）

  Payout schedule（Airwallex 決定）：
    - Daily payout：每天結算（大商家）
    - Weekly payout：每週結算（小商家）
    - T+N delay：Airwallex 可能 hold 資金 2-7 天作為 chargeback 準備金
```

### Auth vs Capture 的設計考量

```
為什麼要分兩步？

  場景 1: 飯店
    Check-in 時 auth $500（預授權）
    Check-out 時 capture $320（實際消費 + minibar）
    → 如果一步完成，要先扣 $500 再退 $180，user 體驗差

  場景 2: 電商（部分出貨）
    訂單 $200（商品 A $120 + 商品 B $80）
    商品 A 先出貨 → capture $120
    商品 B 缺貨取消 → void 剩餘 $80 auth
    → 如果一步完成，要先扣 $200 再退 $80

  場景 3: Subscription
    月初 auth 下個月的費用
    月底檢查用量 → capture 實際金額

Airwallex 內部需要維護的狀態機：
  CREATED → AUTHORIZED → CAPTURED → SETTLED
                ↓             ↓
            VOIDED      PARTIALLY_CAPTURED
                              ↓
                          SETTLED (部分金額)
  任何階段都可能：→ FAILED / → EXPIRED
```

---

## 3. Airwallex 核心系統架構

### 3.1 Payment Gateway（接收商家請求）🅱️

```
對外 API 設計：

  POST /api/v1/payments/create
    → 建立 payment intent (金額、幣別、payment method)
    → 回傳 payment_id + client_secret

  POST /api/v1/payments/{id}/confirm
    → 帶 payment_method_token + idempotency_key
    → 觸發 fraud check → routing → authorization

  POST /api/v1/payments/{id}/capture
    → 把 authorized 的款項實際扣下來
    → 可以 partial capture

  POST /api/v1/payments/{id}/refund
    → 全額或部分退款
    → 產生 compensating ledger entries

  Webhook (async notification to merchant):
    payment.authorized
    payment.captured
    payment.failed
    payment.refunded
    payment.dispute.created

Gateway 的關鍵設計：
  1. Rate limiting：per-merchant API key，防惡意 / 爆量
  2. Idempotency：每個 request 帶 idempotency_key，重試不會雙重扣款
  3. API versioning：/v1/ /v2/，不能 break 商家的整合
  4. Request validation：金額 > 0、幣別合法、token 有效
  5. Async processing：confirm 後 return 202，結果透過 webhook 通知
     （因為 auth 可能要 500ms+，不適合同步等）

架構分層：
  ┌──────────────┐
  │ API Gateway  │  Rate limit, auth, routing
  │ (Nginx/Kong) │
  └──────┬───────┘
         ↓
  ┌──────────────┐
  │ Payment      │  Business logic, state machine
  │ Service      │
  └──────┬───────┘
         │
    ┌────┴────┬──────────┬───────────┐
    ↓         ↓          ↓           ↓
  Fraud    Routing    Processor    Ledger
  Engine   Engine     Adapter      Service
                     (Acquirer
                      通訊層)
```

### 3.2 Smart Routing Engine 🅰️

```
Smart Routing 是 Airwallex 對商家的核心價值之一：
  「同一筆交易走不同通道，成功率和成本可以差 10-30%」

可用通道舉例（同一筆 $100 USD 澳洲交易）：
  通道 A: Acquirer ANZ     → 手續費 2.1%, 成功率 96%
  通道 B: Acquirer Westpac → 手續費 1.8%, 成功率 93%
  通道 C: Local BECS rail  → 手續費 0.3%, 但只支援 AUD + 非即時
  通道 D: Acquirer 日本    → 手續費 2.5%, 但日本 JCB 卡只能走這條

Routing 決策因素（按權重排序）：

  1. 可行性過濾（硬條件）：
     - 卡種支援嗎？(Visa/MC/Amex/JCB/UnionPay)
     - 幣別支援嗎？
     - 地區合規嗎？(某些國家只能走當地 acquirer)
     - 通道目前健康嗎？(circuit breaker 狀態)
     → 過濾後剩餘候選通道

  2. 成本計算：
     - Interchange fee (Card Network 定，通道無關)
     - Scheme fee (Card Network 定，通道無關)
     - Acquirer markup (每個通道不同，這是 routing 能優化的部分)
     - FX conversion fee (跨境時的匯率 spread)
     → 算出每個通道的 total cost

  3. 成功率預測：
     - 歷史成功率 by (card_issuer, card_type, amount_range, region, time_of_day)
     - 例：日本 issuer 的 Visa 卡，$50-100 金額，亞洲 acquirer 成功率 97%，
           歐洲 acquirer 成功率 88%（跨區域 auth 成功率較低）
     → ML model 或統計模型預測成功率

  4. 商家偏好：
     - Cost-optimized：選最便宜（犧牲一點成功率）
     - Success-optimized：選成功率最高（多花一點手續費）
     - 混合策略：成功率差距 <2% 時選便宜的

  5. Load balancing：
     - 避免把所有流量壓到同一個 acquirer
     - Acquirer 有 TPS 限制，超過會被 throttle

Routing Algorithm：

  簡單版（Rule-based scoring）：
    score = w1 × success_rate + w2 × (1 - normalized_cost) + w3 × health_score
    選 score 最高的通道
    商家可以調 w1 / w2 的比例（偏成功率或偏成本）

  進階版（Multi-Armed Bandit）：
    把每個通道當一個 arm
    Exploration：偶爾導一些流量到非最佳通道，更新成功率估計
    Exploitation：大部分流量走目前最佳通道
    Thompson Sampling 或 UCB 策略
    好處：自動適應通道表現變化（例如某 acquirer 最近降級了）

  Cascade Retry（失敗自動換通道）：
    交易 → 通道 A 失敗（timeout / decline）
         → 自動切換通道 B 重試
         → B 也失敗 → 通道 C
         → 最多嘗試 N 次（通常 2-3 次）
    注意：
      - Soft decline (insufficient funds) → 不重試（換通道也沒用）
      - Hard decline (card stolen) → 不重試
      - Timeout / network error → 可以重試其他通道
      - 每次重試都需要新的 idempotency key 到 acquirer 端

Circuit Breaker（通道健康監控）：
  每個 acquirer 通道維護一個 circuit breaker：
    Closed (正常) → error rate > 30% → Open (斷路，流量轉走)
    Open → 30 秒後 → Half-Open (試探一小批)
    Half-Open → 成功 → Closed / 失敗 → Open
  
  監控指標：
    - Error rate (5xx / timeout)
    - P99 latency
    - Decline rate (可能是 acquirer 側問題)
```

### 3.3 FX Engine（換匯引擎）🅰️

```
跨境支付場景：澳洲商家賣東西給日本客戶
  客戶付 ¥10,000 JPY → 商家想收 AUD

══════════════════════════════════════════
  Rate Quote（報價機制）
══════════════════════════════════════════

  流程：
    1. 商家請求報價：POST /api/v1/fx/quote
       Input: sell_currency=JPY, buy_currency=AUD, amount=10000
    2. Airwallex 回傳 quote：
       {
         quote_id: "qt_xxx",
         rate: 0.0105,            // 1 JPY = 0.0105 AUD
         inverse_rate: 95.24,     // 1 AUD = 95.24 JPY
         buy_amount: 105.00,      // AUD
         sell_amount: 10000,      // JPY
         valid_until: "2026-04-22T10:30:00Z",  // 30 分鐘有效
         rate_type: "fixed"       // 鎖定匯率
       }
    3. 商家用 quote_id 建立交易 → 匯率鎖定

  匯率來源：
    - Airwallex 從多家流動性提供商 (LP, Liquidity Provider) 拿 real-time rate
    - LP = 大銀行 (HSBC, Citi, JPMorgan) + 電子市場 (Reuters, EBS)
    - 取 best bid/ask → 加上 Airwallex 的 spread → 報價給商家
    - Spread 是 Airwallex FX 業務的主要收入

  Rate 過期處理：
    - Quote 過期後商家必須重新詢價
    - 防止商家在匯率波動時只 confirm 對自己有利的 quote（cherry-picking）
    - 30 min TTL 是常見設定

══════════════════════════════════════════
  FX Hedging（避險）
══════════════════════════════════════════

  問題：Airwallex 鎖定匯率給商家後，自己承擔 30 分鐘的匯率波動風險
  
  策略：
    1. Instant hedge：報價同時在外匯市場反向操作鎖定成本
       → 零風險但成本高（每筆都要做市場操作）
    2. Batch hedge：累積一段時間的 exposure → 批次避險
       → 成本低但承擔短期波動風險
    3. Net exposure hedge：算出各幣別的淨曝險 → 只避險淨額
       → 例：同時有 JPY→AUD 和 AUD→JPY 的交易，互相抵消

  Airwallex 的 FX 風控：
    - 即時監控每個幣別的淨曝險（net exposure）
    - 設定曝險上限（例：JPY exposure 不超過 $1M equivalent）
    - 超過 → 自動觸發 hedge 操作
    - 極端波動 → 暫停該幣別的報價（widen spread 或 reject）

══════════════════════════════════════════
  Multi-hop Conversion（多跳轉換）
══════════════════════════════════════════

  不是所有幣別都有直接匯率：
    THB (泰銖) → NGN (奈及利亞奈拉) = 沒有直接市場

  解法：找中間幣別做多跳轉換
    THB → USD → NGN
    
  選擇中間幣別的考量：
    - 流動性：USD / EUR 通常是最佳 bridge currency
    - 成本：兩次 spread vs 一次直接匯率（如果有的話）
    - 法規：某些國家限制外匯交易必須通過特定幣別

══════════════════════════════════════════
  幣別精度處理
══════════════════════════════════════════

  每個幣別的最小單位不同（ISO 4217）：
    USD: 2 decimal places (cents)       → $1.00 = 100 cents
    JPY: 0 decimal places              → ¥100 = 100（沒有 sen）
    BHD: 3 decimal places (fils)       → 1.000 BHD = 1000 fils
    CLF: 4 decimal places              → 超小單位
  
  規則：
    - 永遠存整數最小單位 + ISO 4217 currency code
    - DB 欄位：amount BIGINT + currency VARCHAR(3)
    - 絕對不用 FLOAT / DOUBLE（精度問題會在百萬筆交易後累積成真金白銀的差異）
    - 換匯計算時用高精度 (DECIMAL(20,8) 或語言內建的 BigDecimal)
    - 最後 round 到該幣別的最小單位（round half even / banker's rounding）
```

### 3.4 Ledger System at Scale 🅰️

```
══════════════════════════════════════════
  Multi-Currency Double-Entry Ledger
══════════════════════════════════════════

  核心原則：
    1. 每筆交易 = 至少一對 DEBIT + CREDIT，金額相等
    2. 系統內所有帳戶的 DEBIT 總和 = CREDIT 總和（永遠平衡）
    3. Append-only：永遠不修改或刪除已寫入的 entry
    4. 每個 entry 標記幣別：同一筆交易可能涉及多幣別

  帳戶結構（Airwallex 內部）：

    merchant_accounts:
      merchant_001_AUD    ← 商家 001 的 AUD 帳戶
      merchant_001_USD    ← 商家 001 的 USD 帳戶
      merchant_002_EUR    ← 商家 002 的 EUR 帳戶

    airwallex_internal_accounts:
      airwallex_transit_JPY    ← 中轉帳戶（FX 中間態）
      airwallex_transit_AUD
      airwallex_revenue_AUD    ← 手續費收入帳戶
      airwallex_fx_pnl_USD     ← FX 損益帳戶

    external_accounts:
      acquirer_anz_AUD         ← ANZ 收單銀行帳戶（對帳用）
      card_network_visa_USD    ← Visa 清算帳戶

  完整跨境交易的 Ledger Entries：

    日本客戶刷 Visa 付 ¥10,000 → 澳洲商家收 AUD

    # 1. Authorization（凍結，不產生 ledger entry — 只記狀態）
    
    # 2. Capture（實際扣款）
    Entry 1: DEBIT  card_network_visa_JPY     ¥10,000   ← Visa 應付我們
             CREDIT airwallex_transit_JPY      ¥10,000   ← 我們中轉帳戶收到

    # 3. FX Conversion
    Entry 2: DEBIT  airwallex_transit_JPY      ¥10,000   ← JPY 出去
             CREDIT airwallex_transit_AUD      A$105     ← AUD 進來（按鎖定匯率）

    # 4. Fee deduction
    Entry 3: DEBIT  airwallex_transit_AUD      A$2.63    ← 手續費 (2.5%)
             CREDIT airwallex_revenue_AUD      A$2.63    ← Airwallex 收入

    # 5. Payout to merchant
    Entry 4: DEBIT  airwallex_transit_AUD      A$102.37  ← 餘額出去
             CREDIT merchant_001_AUD           A$102.37  ← 商家帳戶

    驗證：每個帳戶的 DEBIT 總和 = CREDIT 總和 ✓

══════════════════════════════════════════
  Schema 設計
══════════════════════════════════════════

    ledger_entries:
      entry_id      BIGINT PK (Snowflake ID)
      transaction_id BIGINT    ← 關聯的交易 ID
      account_id    VARCHAR    ← 帳戶 (merchant_001_AUD)
      entry_type    ENUM(DEBIT, CREDIT)
      amount        BIGINT     ← 整數最小單位 (cents / yen)
      currency      VARCHAR(3) ← ISO 4217
      created_at    TIMESTAMP
      description   VARCHAR    ← 人類可讀描述
      idempotency_key VARCHAR  ← 防重複寫入

      INDEX idx_transaction (transaction_id)
      INDEX idx_account_time (account_id, created_at DESC)

    account_balances (materialized aggregate):
      account_id     VARCHAR PK
      currency       VARCHAR(3)
      balance        BIGINT     ← 即時餘額（= SUM(credits) - SUM(debits)）
      last_updated   TIMESTAMP

    餘額更新：
      每筆 ledger entry 寫入時同步更新 account_balances
      使用 DB transaction 保證 entry + balance 更新的原子性：
        BEGIN;
          INSERT INTO ledger_entries (...);
          UPDATE account_balances SET balance = balance + amount WHERE ...;
        COMMIT;

      定期做 balance reconciliation：
        SUM(all credits) - SUM(all debits) 是否 = balance 欄位
        不一致 → 告警 + 人工調查

══════════════════════════════════════════
  Scale 考量
══════════════════════════════════════════

    寫入量級估算：
      假設 10M 交易/天 × 平均 4 entries/交易 = 40M entries/天
      = ~460 entries/sec (average), peak 可能 5-10x = 2-5K entries/sec
      → 單個 PostgreSQL 可以撐，但需要 partition by month

    Sharding 策略：
      - Shard by account_id → 同一帳戶的 entries 在同一 shard
      - 好處：balance 計算不需要 cross-shard
      - 壞處：大商家的 shard 會 hot → 用 sub-account 分散

    不可變性保證：
      - DB user 只有 INSERT 權限，沒有 UPDATE / DELETE
      - 應用層不實作 UPDATE / DELETE API
      - 年度審計時驗證：所有 table 的 row count 只增不減
```

### 3.5 Reconciliation at Scale 🅱️

```
══════════════════════════════════════════
  Processor 的對帳比商家複雜 10 倍
══════════════════════════════════════════

  商家對帳：我的 DB vs Stripe report（兩方）
  Processor 對帳：三方 + N 方

  三方對帳（每日必做）：
    Source 1: Airwallex 內部 ledger（我們自己記的）
    Source 2: Acquirer settlement report（收單銀行給的）
    Source 3: Card Network clearing file（Visa/MC 給的）

    → 三份資料的金額 / 筆數 / 幣別必須一致
    → 任何不一致 = 「break」，需要調查

  N 方對帳（額外）：
    - 銀行帳戶對帳：Airwallex 銀行帳戶餘額 vs 我們記的應有餘額
    - 商家帳戶對帳：商家看到的餘額 vs 我們 ledger 算的餘額
    - FX 對帳：匯率差異導致的分毫差

══════════════════════════════════════════
  Break 類型與處理
══════════════════════════════════════════

  | Break 類型 | 說明 | 原因 | 處理 |
  |-----------|------|------|------|
  | 我有對方沒有 | 我們記了一筆，但 acquirer report 沒有 | Auth timeout、網路問題 | 查 acquirer、可能需要 void |
  | 對方有我沒有 | Acquirer 記了一筆，我們沒有 | Webhook 漏收、系統 bug | 從 acquirer 拉資料補建 |
  | 金額不符 | 同一筆交易金額不同 | FX rounding、partial capture | 查哪邊正確，調整 ledger |
  | 狀態不符 | 我們記 captured，acquirer 記 declined | 延遲處理、race condition | 以 acquirer 為準（他們跟銀行通訊） |

  處理分級：
    差異 < $0.01      → 自動調整（rounding difference）
    差異 $0.01 - $10  → 自動調整 + 記 log
    差異 $10 - $1000  → 標記待審查，24h 內人工處理
    差異 > $1000      → 即時告警，立刻調查

══════════════════════════════════════════
  Reconciliation Pipeline 架構
══════════════════════════════════════════

  每日流程：
    06:00 UTC  Acquirer / Card Network 上傳 settlement file (CSV/SFTP)
       ↓
    06:30      Parse + normalize（各 acquirer 格式不同）
       ↓
    07:00      Match：用 (acquirer_ref, amount, date) 做三方 join
       ↓
    07:30      Break detection：找出所有不匹配的記錄
       ↓
    08:00      Auto-fix：小差異自動調整 + 補 ledger entry
       ↓
    08:30      Report：生成對帳報告，breaks 發到 ops team
       ↓
    09:00      人工處理大差異

  技術選型：
    - 資料量：10M txn/day × 30 天 = 300M 行做 matching
    - 適合 batch processing：Spark / BigQuery
    - 不需要即時（T+1 跑就好）
    - Matching 本質是 big table JOIN → OLAP 適合（你現在知道為什麼了）
```

### 3.6 Tokenization & PCI DSS 🅱️

```
══════════════════════════════════════════
  Vault 架構
══════════════════════════════════════════

  Airwallex 作為 Processor，直接碰卡號，必須有獨立的 Card Vault：

  ┌────────────────── PCI Scope（隔離環境）──────────────────┐
  │                                                          │
  │  ┌────────────┐    ┌─────────────┐    ┌──────────────┐  │
  │  │ Card Vault │    │    HSM      │    │ Tokenization │  │
  │  │ Service    │←──→│ (Hardware   │    │ Service      │  │
  │  │            │    │  Security   │    │              │  │
  │  │ Encrypted  │    │  Module)    │    │ PAN → Token  │  │
  │  │ PAN store  │    │ Key mgmt   │    │ mapping      │  │
  │  └────────────┘    └─────────────┘    └──────┬───────┘  │
  │                                              │          │
  └──────────────────────────────────────────────┼──────────┘
                                                 │ token only
                                                 ↓
  ┌──────────────── Non-PCI Scope ──────────────────────────┐
  │  Payment Service, Routing Engine, Ledger, API Gateway   │
  │  → 只碰 token (pm_xxxx)，永遠不碰明文卡號               │
  └─────────────────────────────────────────────────────────┘

  Vault 運作：
    1. 商家前端 → Airwallex.js SDK → 卡號直接送到 Vault Service（HTTPS）
    2. Vault 用 HSM 內的 key 加密 PAN → 存入加密 DB
    3. 生成 token (pm_xxxx) → 回傳前端 → 前端傳給商家 server
    4. 商家 server 用 token 呼叫 Airwallex API
    5. Payment Service 拿 token → 呼叫 Vault「給我明文 PAN」→ Vault 解密 → 送給 acquirer
    6. 明文 PAN 只在 PCI scope 內的 service 之間流動，never leaves

  HSM (Hardware Security Module)：
    - 專用硬體，tamper-proof（被拆就自毀 key）
    - 所有加密 / 解密操作在 HSM 內完成
    - Key 永遠不離開 HSM → 軟體層看不到 key
    - FIPS 140-2 Level 3 認證
    - 成本：每台 $10K-$50K，但是 PCI 合規必要

  Token 格式（常見做法）：
    - Format-preserving token：長度和格式跟原卡號一樣（16 位數字）
      → 好處：下游系統不用改 schema
      → 例：4242 4242 4242 4242 → 4242 XXXX XXXX 7890
    - Random token：完全隨機字串 (pm_xxxx)
      → Stripe / Airwallex 的 API 用這種

══════════════════════════════════════════
  PCI DSS Level 1 要求（摘要）
══════════════════════════════════════════

  1. 網路隔離：Cardholder Data Environment (CDE) 與其他系統物理/邏輯隔離
  2. 加密存儲：卡號 AES-256 加密，key 在 HSM
  3. 傳輸加密：TLS 1.2+ everywhere
  4. 存取控制：最小權限原則，MFA for CDE access
  5. 日誌審計：所有 CDE 存取都有 audit trail
  6. 漏洞管理：每季滲透測試，每年外部 QSA 審計
  7. Key rotation：加密 key 定期輪換（通常年度）
  8. 資料保留：過期卡號必須安全銷毀

  為什麼架構要這樣隔離？
    → PCI scope 越小越好：需要通過審計的系統越少，合規成本越低
    → Tokenization 的核心價值 = 把 PCI scope 縮到只有 Vault + HSM
    → 其他幾十個 service 都不碰卡號 → 不在 PCI scope → 開發速度快
```

### 3.7 Risk & Fraud Engine (Processor 級) 🅲

```
══════════════════════════════════════════
  Processor 風控 vs 商家風控的差異
══════════════════════════════════════════

  | 維度 | 商家風控 | Processor 風控 (Airwallex) |
  |------|---------|--------------------------|
  | 資料範圍 | 只有自己的交易 | 所有商家的交易（cross-merchant signals） |
  | 看到什麼 | 自己的用戶行為 | 同一張卡在不同商家的消費模式 |
  | 關注點 | 自己的 chargeback rate | 整個平台的 fraud rate + 商家風險 |
  | 額外責任 | 無 | **商家盡職調查**（merchant onboarding KYC） |

  Processor 獨有的風控場景：

  1. 商家本身是詐騙（merchant fraud）
     - 假商家洗錢、三角詐欺
     - Airwallex 對商家做 KYB (Know Your Business)
     - 監控異常指標：突然大量退款、客單價異常、交易模式突變

  2. Cross-merchant 風險訊號
     - 同一張卡在 10 分鐘內在 5 個不同商家消費 → 高風險
     - 這是商家看不到的，只有 Processor 能看到全局

  3. BIN attack detection
     - 詐騙者用程式批量測試卡號（BIN = 卡號前 6 碼 = 發卡銀行）
     - 大量小額 auth request，測哪些卡號有效
     - Processor 要偵測 + block 這類 pattern

  4. Velocity check (per card, per IP, per device)
     - 同一張卡每小時交易次數
     - 同一 IP 每小時不同卡數
     - 超過閾值 → block 或 3DS challenge

  3DS 觸發決策：
    0-30  risk score → 通過（商家扛 fraud liability）
    30-70 risk score → 觸發 3DS（liability shift to issuer）
    70+   risk score → 直接拒絕
    
    3DS2 frictionless flow：
      所有中風險都送 3DS2 → 銀行判斷低風險 → 無感通過 + liability shift
      → 商家不犧牲轉換率 + 自動獲得保護
```

### 3.8 Local Payment Rails 🅲

```
Airwallex 支援的不只是信用卡，還有各地的本地支付方式：

  | 地區 | 支付方式 | 特性 |
  |------|---------|------|
  | 中國 | Alipay / WeChat Pay | QR code, 即時, 巨量 |
  | 東南亞 | GrabPay / GCash / DANA | 電子錢包, mobile-first |
  | 歐洲 | SEPA Direct Debit / iDEAL / Bancontact | 銀行轉帳, T+1 |
  | 日本 | Konbini / PayPay | 便利商店付款 / QR |
  | 印度 | UPI | 即時銀行轉帳, 政府推動 |
  | 澳洲 | BECS Direct Debit / PayTo | 銀行體系直連 |
  | 巴西 | PIX | 即時轉帳, 央行系統 |

  為什麼這對 Airwallex 重要？
    - 跨境商家需要接受當地消費者的習慣支付方式
    - 信用卡在很多亞洲市場不是主流
    - 本地支付的手續費通常 < 信用卡（沒有 interchange）
    - Smart Router 的一個決策：這筆交易可以走 local rail 嗎？

  對架構的影響：
    - 每種支付方式有不同的 API / protocol / settlement 流程
    - Processor Adapter 層需要適配 20+ 種不同的整合
    - Reconciliation 更複雜：每種支付方式的 report 格式不同
```

---

## 4. ISO 8583 概念 🅲

```
Card Network 不用 REST API，用二進位 message protocol：

  0100: Authorization Request     → 「可以扣嗎？」
  0110: Authorization Response    → 「可以 / 不行」
  0200: Financial Transaction     → 「真的扣」
  0210: Financial Response
  0400: Reversal Request          → 「剛才那筆取消」
  0410: Reversal Response
  0800: Network Management        → Health check

關鍵欄位：
  DE 2:  PAN (卡號)
  DE 3:  Processing Code
  DE 4:  Amount
  DE 49: Currency Code
  DE 38: Auth Code
  DE 39: Response Code (00=通過, 05=拒絕, 51=餘額不足)

面試不會問欄位細節，但知道「Card Network 用二進位 protocol 不是 REST」
= 展示你了解 infrastructure depth
```

---

## 5. 設計決策總結

| 設計決策 | 選擇 | 為什麼 |
|---------|------|--------|
| Ledger 格式 | **Double-entry, append-only, multi-currency** | 金融合規 + 可追溯 + 每筆餘額可驗算 |
| 金額儲存 | **BIGINT 最小單位 + VARCHAR(3) currency** | 避免浮點精度問題，支援所有幣別精度 |
| Routing 策略 | **Rule-based scoring + cascade retry** | 平衡成本 vs 成功率，失敗自動換通道 |
| FX rate 機制 | **Quote + lock (30min TTL)** | 防止 cherry-picking，明確 Airwallex 的風險窗口 |
| 卡號儲存 | **Isolated Vault + HSM + AES-256** | PCI DSS 合規，最小化 PCI scope |
| Auth vs Capture | **分離（Two-phase）** | 支援飯店/租車/subscription 的延遲扣款場景 |
| 對帳頻率 | **每日三方對帳 + break 分級** | 及時發現差異，自動處理小差異降低人工成本 |
| 3DS 觸發 | **Risk-based（分層觸發，非全開）** | 全開犧牲 10-15% 轉換率；分層在安全和營收間取平衡 |
| Reconciliation 引擎 | **Batch (Spark / BigQuery)，每日 T+1** | 300M 行 matching 是典型 OLAP workload |
| Settlement to merchant | **Daily payout with holdback** | Hold 一部分作為 chargeback 準備金 |

---

## 6. 面試 15 分鐘分配（Processor 視角）

```
1. 需求釐清 + 容量估算（2 分鐘）
   - 是 PSP（代商家處理支付），不是商家自己的支付系統
   - TPS / 日交易量 / 支援幣別數 / 地區
   - 可用性要求：99.999%（支付 downtime = 直接損失營收）

2. 四方模型 + 交易生命週期（2 分鐘）🅰️
   - 畫出 Cardholder → Issuer → Card Network → Acquirer → Airwallex → Merchant
   - 說明 Auth / Capture / Clearing / Settlement 四階段
   - 強調 Auth ≠ 扣款，Clearing 是 batch

3. 核心架構（3 分鐘）🅰️
   - Gateway → Fraud → Routing → Processor Adapter → Ledger
   - 每個模組一句話說明角色

4. Smart Routing（3 分鐘）🅰️
   - 為什麼需要 routing：同一筆走不同通道成本和成功率不同
   - Scoring algorithm (cost × w1 + success_rate × w2)
   - Cascade retry + circuit breaker

5. FX Engine（2 分鐘）🅰️
   - Rate quote + lock 機制
   - Multi-currency ledger entries
   - Hedging 概念（不用太深）

6. Deep Dive（3 分鐘，面試官選）
   - Reconciliation at scale 🅱️
   - Tokenization / PCI 🅱️
   - Idempotency / exactly-once 🅱️（跟 payment_system.md 共用）
   - Fraud detection at processor level 🅲
```

---

## 7. 跟 `payment_system.md` 的對照

```
這兩份文件的關係：

  payment_system.md（商家視角）：
    「我要在我的電商網站接入 Stripe，怎麼設計我這邊的系統？」
    重點：Idempotency, Ledger, Saga, State Machine, Webhook handling

  payment_processor_internals.md（Processor 視角）：
    「我要設計 Stripe/Airwallex 本身，怎麼架構？」
    重點：Smart Routing, FX, Tokenization/PCI, Reconciliation, Auth lifecycle

  共用的知識（兩邊都要會）：
    ✓ Double-entry bookkeeping
    ✓ Idempotency
    ✓ State machine (payment lifecycle)
    ✓ Saga (Orchestration)
    ✓ Webhook 設計
    ✓ 3DS / fraud detection 概念

  Processor 額外要會的：
    + Four-party model + 手續費拆分
    + Auth / Clearing / Settlement 三階段
    + Smart Routing
    + FX Engine
    + Tokenization / Vault / PCI DSS
    + Reconciliation at scale（三方對帳）
    + Local payment rails
    + ISO 8583 概念
```
