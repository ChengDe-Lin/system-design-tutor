# Card Network Internals（Visa / Mastercard 視角）

> 這份 deep dive 從 **Card Network 內部**的角度設計支付網路。
> 與 `payment_system.md`（商家視角）和 `payment_processor_internals.md`（PSP 視角）互補。
> Visa/MC 的產品是**網路本身**——連接全球所有 issuer 和 acquirer。

## Priority 分類

| Priority | 模組 | 為什麼 |
|----------|------|--------|
| **🅰️ 必考** | 高吞吐交易處理 (65K TPS + 99.999%) | VisaNet 的核心能力，最可能被考 |
| **🅰️ 必考** | Authorization Routing (BIN-based) | Card Network 的基本功能 |
| **🅰️ 必考** | Clearing & Settlement (全球清算) | 每天幾十億筆交易的 batch netting |
| **🅰️ 必考** | Multi-DC / Disaster Recovery | 金融級災備，zero data loss |
| **🅱️ 高頻** | Network-level Tokenization (VTS/MDES) | 跟 PSP tokenization 不同層 |
| **🅱️ 高頻** | Network-level Fraud Detection | 跨全球交易 pattern detection |
| **🅱️ 高頻** | Dispute / Chargeback Lifecycle | Visa/MC 是 issuer-acquirer 仲裁者 |
| **🅲 加分** | ISO 8583 深入 | 在 PSP 是加分，在 Card Network 是基礎 |
| **🅲 加分** | Interchange Fee 機制 | 商業模式 + 法規影響 |
| **🅲 加分** | EMV / Contactless / Digital Wallet | 實體卡 + Apple Pay/Google Pay 整合 |

---

## 1. Card Network 在四方模型中的位置 🅰️

```
              Card Network (Visa / Mastercard)
              ════════════════════════════════
              │                              │
     Authorization                  Clearing / Settlement
     (即時 ~200ms)                  (T+1 batch)
              │                              │
     ┌────────┴────────┐          ┌──────────┴──────────┐
     ↓                 ↓          ↓                     ↓
  Acquirer          Issuer     Acquirer              Issuer
  (收單銀行)        (發卡銀行)   (收單銀行)            (發卡銀行)
     ↑                 ↑
     │                 │
   PSP              Cardholder
 (Airwallex)        (持卡人)

Card Network 的角色：
  1. 路由器：把 acquirer 的 auth 請求送到正確的 issuer
  2. 清算所：每天算出所有銀行之間的淨應付/應收
  3. 規則制定者：interchange fee、3DS 標準、dispute 仲裁規則
  4. 風控中心：跨全球交易的 fraud detection
  5. 標準組織：ISO 8583、EMV、tokenization 標準

Card Network 不做的事：
  ✗ 不持有消費者的錢（不是銀行）
  ✗ 不直接面對商家（PSP 做這件事）
  ✗ 不做 FX（各銀行或 PSP 自己做）
  ✗ 不發卡（issuing bank 做）

商業模式：
  每筆交易收 scheme fee (~0.1-0.3%)
  + Data analytics 產品（交易趨勢、消費洞察）
  + Tokenization 服務費
  + 品牌授權費（銀行發 Visa 卡要付授權費）
  
  Visa 2024 年報：$35B+ revenue, ~200B+ transactions/year
```

---

## 2. 高吞吐交易處理系統 🅰️

### VisaNet / Banknet 核心數字

```
VisaNet (Visa 的全球網路)：
  Peak TPS:           65,000+ transactions/sec
  Average:            ~7,500 TPS（200B txn/year ÷ 365 ÷ 86400）
  Peak 是 average 的:  ~8-10x（Black Friday, 雙十一）
  Authorization latency: < 200ms end-to-end（acquirer → network → issuer → 回來）
  Network latency:      < 40ms（network 自身處理時間，不含 issuer 回應）
  Availability:         99.999%（每年 < 5 分鐘 downtime）
  Data processed:       ~500M+ messages/day

Banknet (Mastercard)：
  類似規模，略小於 VisaNet
  同樣的可用性要求
```

### 為什麼 65K TPS 很難？

```
對比其他系統：
  Twitter: ~300K tweets/day ≈ 3.5 TPS（差 4 個數量級）
  Uber: ~2K rides/sec peak
  Instagram: ~58K likes/sec（接近，但 like 可丟、交易不能丟）

交易處理的特殊約束：
  1. Zero data loss：每筆交易都不能丟（金融監管要求）
  2. 嚴格 latency：< 200ms（超時 = issuer 不回應 = 交易失敗 = 商家損失營收）
  3. 嚴格 ordering：同一張卡的交易必須按序處理（防止 double-spend）
  4. 全球分佈：acquirer 在美國、issuer 在日本 → 跨洋通訊
  5. 24/7/365：不能停機維護

  像 Instagram 58K likes/sec → 丟幾個 like 沒人知道
  交易 65K TPS → 丟一筆 = 有人白付錢或白拿貨 = 訴訟
```

### 架構設計：怎麼做到 65K TPS + 99.999%

```
VisaNet 架構（公開資訊 + 推斷）：

┌─────────────────────────────────────────────────────────────┐
│                    Global Load Balancer                       │
│              (Anycast DNS / BGP routing)                      │
│          就近路由到最近的 Data Center                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
   ┌─────────┐    ┌─────────┐    ┌─────────┐
   │  DC-US  │    │ DC-EU   │    │ DC-APAC │   ← 3+ 全球 DC
   │ (East)  │    │         │    │         │      Active-Active
   └────┬────┘    └────┬────┘    └────┬────┘
        │              │              │
   每個 DC 內部：
   ┌──────────────────────────────────────────┐
   │                                          │
   │  ┌──────────┐   ┌──────────────────┐     │
   │  │ Protocol │   │ Authorization    │     │
   │  │ Gateway  │──→│ Engine           │     │
   │  │ (ISO8583 │   │ (核心處理)        │     │
   │  │  decode) │   │                  │     │
   │  └──────────┘   └────────┬─────────┘     │
   │                          │               │
   │              ┌───────────┼───────────┐   │
   │              ↓           ↓           ↓   │
   │         ┌────────┐  ┌────────┐  ┌──────┐│
   │         │ BIN    │  │ Fraud  │  │Stand-││
   │         │ Router │  │ Engine │  │In    ││
   │         │        │  │        │  │Proc. ││
   │         └────────┘  └────────┘  └──────┘│
   │                                          │
   │  ┌──────────────────────────────────┐    │
   │  │     Transaction Store            │    │
   │  │  (In-memory + persistent WAL)    │    │
   │  └──────────────────────────────────┘    │
   └──────────────────────────────────────────┘

關鍵設計決策：

  1. In-memory processing：
     交易資料在記憶體中處理，不走磁碟
     → 磁碟只用於 WAL (Write-Ahead Log) 保證 durability
     → 類似 Redis 的 AOF 機制，但金融級

  2. 按卡號 partition：
     同一張卡的交易路由到同一個 processing node
     → 保證 ordering（防 double-spend）
     → Partition key = card BIN (前 6-8 碼) 或 full PAN hash
     → 65K TPS / 1000 nodes = ~65 TPS/node → 單節點壓力不大

  3. Pipeline processing：
     decode → route → fraud check → forward to issuer
     每步 pipeline 化，不是串行等待
     → 總 latency = max(各步) + 網路，不是 sum(各步)

  4. Pre-allocated resources：
     連接池、記憶體、線程 全部預分配
     → 不在 runtime 做 allocation → 避免 GC pause / allocation latency
     → 很多 Card Network 核心系統用 C/C++，不用 JVM
```

### Stand-In Processing (STIP) — 當 Issuer 不回應時

```
問題：Auth request 送到 issuer，issuer 掛了 / timeout
  → 交易卡住 → 商家和消費者都在等

Stand-In Processing：Card Network 代替 issuer 做授權決策

  條件觸發：
    - Issuer 連續 N 次 timeout
    - Issuer 的 error rate > 閾值
    - Issuer 主動通知 "進入 stand-in 模式"

  決策依據：
    - 卡片狀態（過期？被 block？）
    - 交易金額 vs 預估額度
    - 歷史交易 pattern（突然異常？）
    - 風險評分

  限制：
    - Card Network 不知道持卡人的即時餘額（只有 issuer 知道）
    - 所以 STIP 是「盡力而為」的近似決策
    - 可能會 approve 一筆餘額不足的交易（事後 issuer 處理）
    - 金額上限：通常有 floor limit（超過就拒絕）

  這是 99.999% 可用性的關鍵之一：
    即使 issuer 掛了，交易仍然可以通過（在風險可控範圍內）
```

---

## 3. Authorization Routing 🅰️

```
問題：acquirer 送來一筆 auth request，怎麼送到正確的 issuer？

答案：BIN (Bank Identification Number) routing

BIN = 卡號前 6-8 位數字（2022 年起擴展到 8 位）：
  4242 42xx xxxx xxxx
  └──────┘
    BIN = 424242 → 某家銀行（例如 Chase）

BIN Table：
  Card Network 維護一張全球 BIN table：
    BIN → Issuing Bank → Routing endpoint

  | BIN range | Issuer | Country | Product | Endpoint |
  |-----------|--------|---------|---------|----------|
  | 400000-400099 | Chase | US | Visa Classic | chase-us-east.visa.net |
  | 400100-400199 | Chase | US | Visa Gold | chase-us-east.visa.net |
  | 521000-521099 | HSBC | UK | MC World | hsbc-uk.mastercard.net |
  | ...（數百萬條）|

Routing 流程：
  1. Acquirer 送 auth request（ISO 8583 0100 message）
  2. Protocol Gateway 解碼 → 取出 PAN (DE-2)
  3. 從 PAN 取 BIN
  4. 查 BIN table → 找到 issuer 的 routing endpoint
  5. 轉發 auth request 到 issuer
  6. 等 issuer 回應（timeout ~3-5 秒）
  7. 回傳 auth response 給 acquirer

BIN table 的維護：
  - 新銀行加入 Visa/MC → 分配 BIN range
  - 銀行合併 → BIN range 重新指向
  - 更新頻率：每週 ~ 每月
  - 分發到所有 processing node 的記憶體中（不查 DB）

Co-brand / 多發卡行的複雜性：
  Costco Visa (by Citibank)：BIN 屬於 Citi 但品牌是 Costco
  Apple Card (by Goldman Sachs)：BIN 屬於 Goldman
  → routing 跟品牌無關，只看 BIN → issuing bank
```

### Multi-network Routing (Debit)

```
美國 debit card 特殊：一張卡可能同時在 Visa (Debit) 和 PULSE/STAR 等小網路上

Durbin Amendment (2010)：
  法規要求每張 debit card 至少要有 2 個 network 可以 route
  → 商家可以選走哪個 network（通常選手續費低的）
  → Visa debit 的 interchange ~0.05% + $0.21
  → PULSE 可能更低

  這就是 PSP 的 smart routing 可以優化的空間之一
  Card Network 的角色：確保 routing 正確 + 遵守 Durbin 規則
```

---

## 4. Clearing & Settlement（全球清算）🅰️

```
每天結束後，需要算出「誰欠誰多少錢」：

═══════════════════════════════════════
  Clearing（清算 — 算帳）
═══════════════════════════════════════

  每個 acquirer 每天提交 clearing file：
    「今天我代理的商家一共 capture 了 50,000 筆交易，
     涉及 2000 家 issuing bank，總金額 $3.5M」

  Card Network 彙整所有 acquirer 的 clearing file：
    
  Issuer A 的帳：
    應付（持卡人刷了）：
      To Acquirer X: $200,000 (5000 筆)
      To Acquirer Y: $150,000 (3000 筆)
      To Acquirer Z: $80,000  (2000 筆)
    應收（退款、手續費）：
      Interchange from Acquirer X: $3,000
      Interchange from Acquirer Y: $2,250
    ────────────────────────────
    Net position: 應付 $424,750

  全球每天：
    200B txn/year ÷ 365 ≈ 550M txn/day
    彙整成 net position → 每家銀行只需要做 1 筆轉帳（net settlement）
    而不是 550M 筆轉帳

═══════════════════════════════════════
  Settlement（結算 — 真的轉錢）
═══════════════════════════════════════

  Card Network 通知各銀行：
    「Issuer A，你今天 net 應付 $424,750」
    「Acquirer X，你今天 net 應收 $197,000」

  資金流動通過 settlement bank（Visa 用多家大銀行做 settlement agent）：
    Issuer 的帳戶 → debit $424,750
    Acquirer 的帳戶 → credit $197,000
    ...

  時間：
    T+1 (大部分地區) 到 T+2
    不同地區可能不同 settlement cycle

═══════════════════════════════════════
  Netting 的效果
═══════════════════════════════════════

  沒有 netting（gross settlement）：
    550M 筆交易 → 550M 筆銀行轉帳 → 不可能

  有 netting（net settlement）：
    550M 筆交易 → 算 net position → ~10,000 筆銀行轉帳
    （每家銀行跟 Card Network 之間 1 筆）
    → 可行

  這就是 Card Network 存在的核心價值之一：
    把 N×M 的銀行互轉 → 簡化成 N+M 筆（每家銀行跟 network 結算）
```

### Clearing Pipeline 架構

```
  06:00 UTC  Cut-off time — 昨天的交易截止
     ↓
  06:00-08:00  各 acquirer 上傳 clearing file（SFTP / API）
     ↓
  08:00-10:00  Validation & Matching
     - 每筆 clearing 記錄 match 到對應的 authorization（by auth_code + amount）
     - 不 match 的 → exception 佇列（人工處理）
     - 金額不符 → partial capture / 修改金額 → 允許但標記
     ↓
  10:00-12:00  Fee Calculation
     - 每筆交易計算 interchange fee（根據卡種、MCC、地區、交易方式）
     - interchange fee schedule 極其複雜：數千種費率組合
     - 每筆交易的 fee 可能不同
     ↓
  12:00-14:00  Netting
     - 按 (issuer, acquirer) pair 做 net
     - 再按 issuer 做 grand net（一家 issuer 的所有 acquirer 淨額）
     ↓
  14:00-16:00  Settlement Instructions
     - 發送 settlement 指令到 settlement banks
     - 各銀行執行實際資金轉移
     ↓
  16:00  Settlement complete

  技術選型：
    每天 550M 筆交易做 matching + fee calculation + netting
    → 典型 OLAP batch workload
    → 大量 JOIN + aggregation
    → Spark / Flink / 自建 batch engine
    → 必須在幾小時內完成（有 cut-off deadline）
```

---

## 5. Multi-DC / Disaster Recovery 🅰️

```
金融系統的災備要求：

  RPO (Recovery Point Objective) = 0：不能丟任何一筆已確認的交易
  RTO (Recovery Time Objective) < 30 秒：failover 要在 30 秒內完成
  
  這比一般系統嚴格得多：
    一般 web app: RPO ~1min, RTO ~5min → 可接受
    Card Network: RPO=0, RTO<30s → 丟一筆交易就是金融事故

═══════════════════════════════════════
  Multi-DC Active-Active 架構
═══════════════════════════════════════

  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  DC-US   │ ←──→│  DC-EU   │←──→ │ DC-APAC  │
  │ (Primary │     │ (Primary │     │ (Primary │
  │  for US  │     │  for EU  │     │  for APAC│
  │  issuers)│     │  issuers)│     │  issuers)│
  └──────────┘     └──────────┘     └──────────┘
       ↕ sync            ↕ sync          ↕ sync
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  DC-US   │     │  DC-EU   │     │ DC-APAC  │
  │ (Standby)│     │ (Standby)│     │ (Standby)│
  └──────────┘     └──────────┘     └──────────┘

  設計原則：
    1. Geographic affinity：美國 issuer 的交易盡量在 US DC 處理
       → 減少跨洋 latency
    2. Active-Active at region level：每個地區有 primary + standby
       → 地區內 failover 秒級完成
    3. Cross-region failover：如果整個地區掛了 → 流量切到另一個地區
       → 依賴 BGP / DNS failover → 可能需要 30s-幾分鐘

═══════════════════════════════════════
  如何做到 RPO = 0（Zero Data Loss）
═══════════════════════════════════════

  方案 1: Synchronous replication（同步複製）
    每筆交易寫入 primary → 同步寫入 standby → 才回 ACK
    ✓ RPO = 0
    ✗ 每筆交易多一次 DC 間 RTT（同城 ~1ms, 跨城 ~5-20ms）
    → 同城 DC pair 用這個方案

  方案 2: Transaction log shipping
    Write-Ahead Log 即時串流到 standby
    → 接近 RPO=0（lag 通常 <100ms）
    → 跨區 failover 可能丟最後幾十筆（可從 acquirer 重送恢復）

  方案 3: Consensus-based replication（Raft / Paxos）
    每筆交易需要 majority nodes ACK
    ✓ RPO = 0 + 自動 leader election
    ✗ 跨區域 latency 高（majority 要包含遠端 DC）
    → 可能用於 critical metadata（BIN table, card status）
    → 不太可能用於每筆交易（latency 要求太嚴）

  VisaNet 實務（推斷）：
    - 同城 active-standby: synchronous replication → RPO = 0
    - 跨區: async log shipping → near-zero RPO
    - 交易有唯一 ID → failover 後可以 reconcile + 從 acquirer 重送
    - 最壞情況：丟幾筆 → 事後 reconciliation 修復（而不是默默丟掉）
```

### 不間斷部署 (Zero-Downtime Deployment)

```
  24/7/365 不能停機 → 怎麼更新系統？

  Rolling deployment：
    1. 從 load balancer 摘掉一批 nodes
    2. 等 in-flight 交易 drain（~30 秒）
    3. 更新這批 nodes
    4. 健康檢查通過 → 加回 load balancer
    5. 重複直到所有 nodes 更新完

  Canary release：
    新版本先導 1% 流量
    → 監控 error rate, latency, auth success rate
    → 沒問題 → 逐步擴大到 100%
    → 出問題 → 立刻 rollback（<1 分鐘）

  Blue-Green at DC level：
    整個 DC 跑新版本，另一個 DC 跑舊版本
    → 如果新版本有問題，切流量到舊版本 DC
    → 金融系統常用（比 rolling 更安全但更貴）
```

---

## 6. Network-level Tokenization 🅱️

```
跟 PSP Tokenization 不同層：

  PSP tokenization (Airwallex/Stripe)：
    PAN → PSP 的 token (pm_xxxx)
    → 只在 PSP 生態系統內有效
    → 商家用 token 透過 PSP API 操作

  Network tokenization (VTS / MDES)：
    PAN → Network token (看起來也像卡號但不是)
    → 在整個 Card Network 生態系統內有效
    → Issuer 認識這個 token
    → 可以直接送到 Card Network 做 auth（不需要 de-tokenize 回 PAN）

  VTS (Visa Token Service) / MDES (Mastercard Digital Enablement Service)：

    使用場景：
      Apple Pay / Google Pay：
        手機裡存的不是你的卡號，是 network token
        → 刷 Apple Pay → 送 network token 到 Card Network
        → Card Network 知道 token 對應的真實 PAN
        → 轉成 PAN → 送給 issuer 做 auth
        → 或直接用 token auth（如果 issuer 支援）

    優勢 vs PSP tokenization：
      - 卡號換卡 / 過期 → network token 不變 → 商家不用更新
        （Card-on-file 場景：Netflix 的月扣款不會因為你換卡而中斷）
      - Token 有 domain restriction（只能在特定商家 / 特定裝置使用）
        → 偷了 token 也沒用
      - Issuer 可以看到 token → 更好的 fraud detection

    架構：
      ┌──────────────┐
      │ Token Vault  │  ← Card Network 維護
      │              │
      │ Token ←→ PAN │  mapping
      │ + domain     │  (哪個商家 / 哪台裝置)
      │ + status     │  (active / suspended)
      └──────────────┘

    Token lifecycle：
      Provision: 用戶加卡到 Apple Pay → Apple → Card Network → 驗證 → 發 token
      Auth: token 進來 → 查 vault → 轉 PAN → 送 issuer（或直接 token auth）
      De-provision: 用戶刪卡 / 卡被 block → 廢止 token

    規模：
      數十億 active tokens
      每筆 Apple Pay / Google Pay 交易都要查 Token Vault
      → 必須 in-memory + replicated
```

---

## 7. Network-level Fraud Detection 🅱️

```
Card Network 看得到全球所有交易 → 比任何單一 issuer 或 PSP 的視野都大

═══════════════════════════════════════
  Card Network 的獨特優勢
═══════════════════════════════════════

  Issuer 看到的：
    「Alice 在 7-11 刷了 $5」— 只有 Alice 的交易

  PSP 看到的：
    「這張卡在我的商家刷了 $5」— 只有這個 PSP 的商家

  Card Network 看到的：
    「這張卡在過去 10 分鐘內在 5 個國家刷了 20 筆」
    → 只有 Card Network 能看到跨 issuer、跨 acquirer 的全局 pattern

  Visa Advanced Authorization (VAA)：
    每筆 auth request 過 Visa 時，Visa 附加一個 risk score
    → 送給 issuer 做 approve/decline 的參考
    → 即時 (<5ms)，不能影響 auth latency

═══════════════════════════════════════
  Fraud Detection 的挑戰：65K TPS 下做即時 scoring
═══════════════════════════════════════

  每筆交易過來，要在 <5ms 內算出 risk score：
    Features:
      - 這張卡過去 1h / 24h / 7d 的交易次數和金額
      - 地理距離：上一筆交易在哪？travel velocity 合理嗎？
      - 商家風險等級（高風險 MCC：賭博、加密貨幣）
      - 裝置 / channel（線上 vs 實體店 vs ATM）
      - Cross-merchant pattern：同一張卡短時間在多少商家消費

  架構：
    - Feature store: per-card 的即時特徵（最近交易、累計金額）
      → 必須 in-memory（<1ms 查詢）
      → 按 card partition → 跟 auth engine 同一個 node
    - ML model: gradient boosted tree / neural network
      → 模型本身載入記憶體
      → inference <1ms（輕量模型，不是 LLM）
    - 結果附加在 auth response 的 DE-48 (Additional Data) 欄位

═══════════════════════════════════════
  Fraud 的類型
═══════════════════════════════════════

  1. Counterfeit fraud（偽卡）：
     盜取磁條資料 → 製造偽卡 → 在實體店使用
     → EMV chip 大幅減少了這種 fraud

  2. Card-Not-Present (CNP) fraud：
     盜取卡號 → 線上購物
     → 目前最大宗的 fraud 類型
     → 3DS 是主要防禦手段

  3. Account takeover：
     駭入持卡人的銀行帳戶 → 修改地址 → 申請新卡
     → 需要 issuer 的 KYC / 身份驗證防禦

  4. BIN attack：
     批量測試卡號（自動化生成可能的卡號 + 到期日）
     → Card Network 偵測異常的 auth decline 爆量 → block source IP / merchant
```

---

## 8. Dispute / Chargeback Lifecycle 🅱️

```
當持卡人對一筆交易有爭議：
  「這筆我沒刷」「貨沒收到」「跟說好的不一樣」

Card Network 的角色 = 仲裁者（在 issuer 和 acquirer 之間）

═══════════════════════════════════════
  Dispute Lifecycle（以 Visa 為例）
═══════════════════════════════════════

  Day 0:    持卡人向 issuing bank 投訴
  Day 1-5:  Issuer 初步調查
            → 如果明顯是 fraud（有 3DS 但 3DS 沒過）→ issuer 直接賠
            → 不明確 → 發起 dispute

  Day 5:    Issuer 透過 Card Network 發 chargeback 給 acquirer
            → 資金暫時從 acquirer 扣回
            → Reason code：
              10.1 = EMV liability shift (counterfeit)
              10.4 = Other fraud
              13.1 = Merchandise not received
              13.3 = Not as described

  Day 5-30: Acquirer 通知商家 → 商家可以 representment（反駁）
            → 提供證據：出貨證明、簽收單、IP log、3DS 結果
            → 透過 Card Network 回傳給 issuer

  Day 30-45: Issuer 審查證據
             → Accept representment → 資金還給 acquirer → 案件結束
             → Reject → 進入 pre-arbitration

  Day 45-75: Pre-arbitration
             → 雙方最後一次協商機會
             → 多數案件在此階段解決

  Day 75-120: Arbitration（最終仲裁）
              → Card Network 做最終裁決
              → 輸的一方付仲裁費 $500（Visa）
              → 裁決不可上訴

  時限：
    持卡人必須在交易後 120 天內發起 dispute
    整個流程通常 45-120 天結束

═══════════════════════════════════════
  系統設計考量
═══════════════════════════════════════

  Dispute management system 需要：
    - 案件狀態機：opened → chargeback → representment → pre-arb → arbitration → resolved
    - 文件管理：上傳/儲存/傳遞證據文件
    - 時限管理：每個階段有 deadline，超時 = 自動判輸
    - 資金 hold / release：爭議期間資金凍結
    - Reporting：每家銀行的 chargeback rate（>1% → 罰款）

  規模：
    ~200B txn/year × ~0.1% dispute rate = ~200M disputes/year
    → ~550K disputes/day
    → 中等規模的 OLTP workload
```

---

## 9. ISO 8583 深入 🅲

```
Card Network 的核心通訊協議（在 PSP 那份只列了概念，這裡補充）

═══════════════════════════════════════
  Message Structure
═══════════════════════════════════════

  ISO 8583 message = MTI + Bitmaps + Data Elements

  MTI (Message Type Indicator, 4 位):
    0100 = Authorization Request
    0110 = Authorization Response
    0120 = Authorization Advice（通知性，不需要回應）
    0200 = Financial Transaction Request（combined auth + capture）
    0210 = Financial Response
    0400 = Reversal Request
    0410 = Reversal Response
    0800 = Network Management Request（健康檢查、sign-on/sign-off）
    0810 = Network Management Response

  Bitmap：
    64 or 128 bits，每個 bit 代表一個 Data Element 是否存在
    → bit 2 = 1 → DE-2 (PAN) 存在
    → 緊湊編碼，不浪費空間

  常用 Data Elements（面試知道這些就夠）：
    DE-2:   PAN (Primary Account Number, 卡號)
    DE-3:   Processing Code (purchase / cash advance / refund)
    DE-4:   Transaction Amount
    DE-7:   Transmission Date and Time
    DE-11:  STAN (System Trace Audit Number, 追蹤碼)
    DE-12:  Local Transaction Time
    DE-22:  POS Entry Mode (swipe / chip / contactless / e-commerce)
    DE-38:  Authorization Code (issuer 回的授權碼)
    DE-39:  Response Code (00=approved, 05=declined, 51=insufficient funds)
    DE-41:  Card Acceptor Terminal ID
    DE-42:  Card Acceptor ID (Merchant ID)
    DE-43:  Card Acceptor Name/Location
    DE-49:  Transaction Currency Code (ISO 4217)
    DE-55:  ICC Data (EMV chip 資料)

═══════════════════════════════════════
  為什麼不用 REST API / gRPC？
═══════════════════════════════════════

  1. 歷史原因：ISO 8583 在 1987 年制定，REST 還不存在
  2. 效率：binary encoding 比 JSON 小 5-10x → 頻寬和解析都快
  3. 成熟穩定：40 年來全球金融系統都用這個 → 換的成本不可承受
  4. 低延遲：TCP 長連接 + binary → 比 HTTP/JSON 少很多 overhead
  
  但新趨勢：
    Visa 和 MC 都有提供 REST API wrapper
    → 給 PSP / fintech 用（在上面包一層 REST）
    → 內部核心仍然是 ISO 8583

═══════════════════════════════════════
  面試怎麼用
═══════════════════════════════════════

  不需要背欄位。但說到通訊協議時：

  「Card Network 內部核心用 ISO 8583——一個 binary 的 message protocol，
   不是 REST API。每筆交易 ~200 bytes（vs JSON 可能 2-5KB），
   在 65K TPS 下 bandwidth 差異顯著。
   對外提供 REST API wrapper 給 PSP/fintech 整合。」

  → 展示你知道基礎設施的深度，而不是停在 API 層面
```

---

## 10. Interchange Fee 機制 🅲

```
Interchange fee 是 Card Network 最重要的商業規則之一

═══════════════════════════════════════
  Interchange 是什麼
═══════════════════════════════════════

  每筆交易，acquirer 要付一筆 interchange fee 給 issuer：
    Consumer 刷 $100
    → Issuer 只轉 $98.30 給 acquirer（扣掉 $1.70 interchange）
    → Acquirer 從 $98.30 扣自己的 markup → 給商家 $97.50
    → Issuer 的 $1.70 就是 interchange fee

  誰定的？Card Network (Visa/MC) 定的
  誰付的？Acquirer 付（最終轉嫁給商家）
  誰收的？Issuing bank 收

  為什麼 issuer 能收？
    → Issuer 承擔信用風險（持卡人不還錢）
    → Issuer 承擔 fraud 損失
    → Interchange 是對這些風險的補償

═══════════════════════════════════════
  Fee Schedule 的複雜度
═══════════════════════════════════════

  Interchange fee 不是固定費率——有數千種組合：

  影響 fee 的因素：
    - Card type: Classic (低) vs Platinum (高) vs Corporate (更高)
    - Transaction type: chip (低) vs e-commerce (高) vs MOTO (最高)
    - MCC (Merchant Category Code): grocery (低) vs electronics (中) vs gambling (高)
    - Region: domestic (低) vs cross-border (高)
    - 3DS status: authenticated (低) vs not (高)

  範例（Visa US, 簡化）：
    | 情境 | Interchange |
    |------|-------------|
    | Supermarket, debit, chip | 0.05% + $0.21 |
    | Retail, credit classic, chip | 1.51% + $0.10 |
    | E-commerce, credit rewards, no 3DS | 2.10% + $0.10 |
    | Cross-border, premium card | 2.40% + $0.10 |

  Clearing pipeline 必須精確計算每筆交易的 interchange fee
  → 數千種規則 → 這是 clearing 系統最複雜的部分之一

═══════════════════════════════════════
  法規影響
═══════════════════════════════════════

  EU Interchange Fee Regulation (IFR, 2015)：
    Cap: consumer debit 0.2%, consumer credit 0.3%
    → 大幅壓低了歐洲的 interchange → issuer 收入減少
    → Card Network 的 scheme fee 反而漲了一些（補收入）

  Durbin Amendment (US, 2010)：
    Cap: debit interchange ~$0.21 + 0.05%（只限大銀行）
    + 必須支援至少 2 個 network routing（打破 Visa/MC 壟斷 debit）
```

---

## 11. 設計決策總結

| 設計決策 | 選擇 | 為什麼 |
|---------|------|--------|
| 處理模型 | **In-memory + WAL** | 65K TPS 不能走磁碟；WAL 保證 durability |
| Partition 策略 | **By card BIN / PAN hash** | 同一張卡的交易路由到同一 node → 保證 ordering |
| Routing 機制 | **BIN table in-memory lookup** | 毫秒級 routing，不能查 DB |
| Clearing 引擎 | **Batch processing (Spark-like)** | 550M txn/day 的 JOIN + aggregation = OLAP 任務 |
| Replication | **同城 sync + 跨區 async** | 同城 RPO=0；跨區 near-zero + 事後 reconciliation |
| Deployment | **Blue-Green / Rolling + Canary** | 24/7/365 不能停機 |
| Issuer 故障處理 | **Stand-In Processing (STIP)** | 保證 99.999% 可用性即使 issuer 掛了 |
| 通訊協議 | **ISO 8583 (binary)** | 低延遲 + 低頻寬 + 40 年成熟標準 |
| Tokenization | **Network-level (VTS/MDES)** | 支援 Apple Pay/Google Pay + card-on-file token 更新 |
| Fee 計算 | **Rule engine with 數千種組合** | Interchange 複雜度要求靈活的 rule system |

---

## 12. 面試 15 分鐘分配（Card Network 視角）

```
1. 需求釐清 + 規模估算（2 分鐘）🅰️
   - 我們要設計什麼？全球 Card Network 的 authorization + settlement 系統
   - 65K TPS peak, 550M txn/day, <200ms e2e latency, 99.999% availability
   - RPO = 0（zero data loss）

2. 四方模型 + Network 的角色（1 分鐘）🅰️
   - Card Network 是路由器 + 清算所 + 規則制定者
   - 不是銀行、不持有錢、不面對商家

3. Authorization 系統（4 分鐘）🅰️
   - Protocol Gateway → BIN Routing → Fraud Scoring → Forward to Issuer
   - In-memory processing + WAL
   - Partition by card BIN → ordering 保證
   - Stand-In Processing (issuer 掛了怎麼辦)
   - 65K TPS 怎麼做到：pipeline processing + pre-allocated resources

4. Clearing & Settlement（3 分鐘）🅰️
   - Clearing file → matching → fee calculation → netting → settlement
   - 550M txn → net 成 ~10K 筆銀行轉帳
   - Batch pipeline (OLAP workload)

5. Multi-DC / DR（2 分鐘）🅰️
   - Active-Active per region
   - Sync replication 同城 → RPO=0
   - Async + reconciliation 跨區
   - Zero-downtime deployment

6. Deep Dive（3 分鐘，面試官選）
   - Network tokenization (VTS/MDES) 🅱️
   - Fraud detection at network scale 🅱️
   - Dispute lifecycle 🅱️
   - ISO 8583 protocol 🅲

```

---

## 13. 跟其他 Payment Deep Dive 的對照

```
三份文件的關係：

  payment_system.md（商家視角）：
    「我要在電商網站接入支付，怎麼設計我這邊的系統？」
    重點：Idempotency, Ledger, Saga, State Machine

  payment_processor_internals.md（PSP 視角 — Airwallex）：
    「我要設計 Stripe/Airwallex 本身，怎麼架構？」
    重點：Smart Routing, FX, Tokenization/PCI, Reconciliation

  card_network_internals.md（Card Network 視角 — Visa/MC）：
    「我要設計 Visa/Mastercard 的交易網路，怎麼架構？」
    重點：65K TPS, BIN Routing, Clearing/Settlement, Multi-DC DR

  三者在四方模型中的位置：
    Merchant ← payment_system.md
       ↓
    PSP (Airwallex) ← payment_processor_internals.md
       ↓
    Card Network (Visa/MC) ← card_network_internals.md (本文件)
       ↓
    Issuing Bank

  共用知識：
    ✓ Four-party model（三份都要知道，但各自的視角不同）
    ✓ Auth / Clearing / Settlement lifecycle
    ✓ Idempotency
    ✓ Double-entry bookkeeping
```
