# Ad Serving / Real-Time Bidding — 廣告投放與即時競價系統架構

## 1. 核心挑戰

廣告系統的設計核心是 **在極端低延遲下完成高吞吐量的個人化廣告選擇與競價**：

```
規模（以 Google Ads 等級為參考）：
  DAU: ~2B（搜尋 + Display Network）
  Ad requests/day: ~100B → ~1.2M requests/sec
  RTB auctions/day: ~50B → ~580K auctions/sec
  Advertisers: ~10M active campaigns
  Ad inventory: ~數十億 ad slots/day

延遲約束：
  整個 RTB 拍賣流程（Bid Request → 收集出價 → 決定贏家 → 回傳廣告）: < 100ms
  DSP 回應時間: < 50ms（超時視為棄標）
  Ad Selection（自有平台如 Facebook）: < 200ms end-to-end

核心矛盾：
  - 每次 page load 都需要在 < 100ms 內跑完一場拍賣
  - 需同時考慮：targeting 匹配、預算控制、頻次上限、CTR 預估、反欺詐
  - 廣告主要精準投放（少花錢多轉換），Publisher 要最大化收益（每個 impression 賣最高價）
```

---

## 2. 整體架構

```
                         ┌──────────────────────────────────────────────────┐
                         │              RTB Ecosystem                       │
                         │                                                  │
  ┌──────────┐    Ad     │  ┌─────────┐  Bid Req  ┌────────────┐           │
  │ User     │──Request──│─▶│  SSP    │──────────▶│ Ad Exchange │           │
  │ Browser  │           │  │         │           │            │           │
  │          │◀──Ad──────│──│         │◀──Winner──│            │           │
  │          │  Creative  │  └─────────┘           │            │           │
  └────┬─────┘           │                         │   Auction  │           │
       │                 │              ┌──────────│   Engine   │           │
       │ Impression/     │              │          └────────────┘           │
       │ Click event     │         Fan-out to                              │
       │                 │         multiple DSPs                            │
       ▼                 │              │                                   │
  ┌──────────┐           │    ┌─────────▼──┐  ┌──────────┐  ┌──────────┐  │
  │ Tracking │           │    │   DSP #1   │  │  DSP #2  │  │  DSP #N  │  │
  │ Server   │           │    │ ┌────────┐ │  │          │  │          │  │
  │          │           │    │ │Bid     │ │  │  ...     │  │  ...     │  │
  │ (pixel / │           │    │ │Engine  │ │  │          │  │          │  │
  │  redirect)│          │    │ │        │ │  └──────────┘  └──────────┘  │
  └────┬─────┘           │    │ │CTR Model│ │                              │
       │                 │    │ │Budget  │ │                              │
       ▼                 │    │ │Pacer   │ │                              │
  ┌──────────┐           │    │ └────────┘ │                              │
  │  Kafka   │           │    └────────────┘                              │
  │  Event   │           └──────────────────────────────────────────────────┘
  │  Stream  │
  └────┬─────┘
       │
  ┌────▼──────────────────────────┐
  │ Analytics / Attribution       │
  │ (ClickHouse / BigQuery)       │
  │ + Fraud Detection Pipeline    │
  └───────────────────────────────┘
```

### Self-Serve 平台架構（Facebook / Google Ads 模式）

```
  ┌──────────┐    Page Load     ┌────────────────────────────────────────┐
  │  User    │──Ad Request──────▶  Ad Serving Pipeline                  │
  │  Browser │                   │                                      │
  │          │◀──Ad Creative─────│  ┌──────────┐  ┌──────────┐         │
  └──────────┘                   │  │Candidate │  │ CTR      │         │
                                 │  │Generation│─▶│Prediction│         │
                                 │  │(Targeting│  │ Model    │         │
                                 │  │ Index)   │  └────┬─────┘         │
                                 │  └──────────┘       │               │
                                 │                     ▼               │
                                 │               ┌──────────┐          │
                                 │               │ Ranking  │          │
                                 │               │ eCPM =   │          │
                                 │               │ bid×P(ck)│          │
                                 │               └────┬─────┘          │
                                 │                    │                │
                                 │               ┌────▼─────┐          │
                                 │               │ Ad       │          │
                                 │               │ Quality  │          │
                                 │               │ & Policy │          │
                                 │               └──────────┘          │
                                 └────────────────────────────────────────┘
```

---

## 3. Real-Time Bidding (RTB) 拍賣流程

### 完整流程（< 100ms）

```
時間軸（典型 RTB）：

T+0ms    使用者瀏覽網頁，頁面載入觸發 ad slot
T+5ms    Publisher 的 SSP (Supply-Side Platform) 收到 ad request
T+10ms   SSP 向 Ad Exchange 發送 Bid Request（含 user context）
T+15ms   Ad Exchange fan-out Bid Request 到 10-20 個 DSP (Demand-Side Platform)
T+20ms   各 DSP 開始處理：
           - 查詢 User Profile（< 2ms, in-memory）
           - 匹配 targeting 條件（< 3ms, 預建 index）
           - CTR 預測（< 5ms, ML inference）
           - 預算檢查 + 頻次上限（< 2ms）
           - 出價決策（< 1ms）
T+55ms   各 DSP 回覆出價（或 no-bid）
T+60ms   Ad Exchange 執行拍賣 → 選出 winner
T+65ms   回傳 winning ad creative URL 給 SSP
T+70ms   SSP 回傳給使用者瀏覽器
T+90ms   瀏覽器開始渲染廣告
T+100ms  Impression pixel 觸發 → 計費
```

### Bid Request 內容

```json
{
  "id": "auction-uuid-12345",
  "imp": [{
    "id": "1",
    "banner": { "w": 728, "h": 90 },
    "bidfloor": 0.50
  }],
  "site": {
    "domain": "news-site.com",
    "page": "https://news-site.com/tech/article-123",
    "cat": ["IAB19"]
  },
  "user": {
    "id": "cookie-hash-abc",
    "geo": { "country": "US", "city": "San Francisco" }
  },
  "device": {
    "ua": "Mozilla/5.0...",
    "ip": "203.0.113.x"
  }
}
```

---

## 4. 拍賣機制 (Auction Mechanism)

### 二價拍賣 (Second-Price Auction / Vickrey Auction)

```
傳統 RTB 標準：
  - 贏家出價 $5.00，第二高出價 $3.20
  - 贏家實際支付：$3.20 + $0.01 = $3.21（第二高價 + 最小增量）

為什麼採用二價拍賣？
  → 誠實出價是最優策略 (Dominant Strategy Truthfulness)
  → 廣告主只需要出自己認為的真實價值，不需要猜其他人出多少
  → 數學證明：在二價拍賣中，出真實價值永遠不會比出其他價格差

例子：
  你認為一次點擊值 $5.00
  → 出 $5.00：如果贏了，你付的是第二高價（< $5.00），你賺
  → 出 $3.00（低報）：可能本來會贏的拍賣輸了，損失機會
  → 出 $8.00（高報）：可能在第二高價 > $5.00 時贏了但虧錢
```

### 一價拍賣 (First-Price Auction) — 近年趨勢

```
Google Ad Manager 2019 年轉向一價拍賣：
  - 贏家出多少就付多少
  - 規則更透明、更簡單
  - 但廣告主會 bid shading（故意出低價）

一價 vs 二價：
┌──────────────┬─────────────────────┬──────────────────────┐
│              │ Second-Price        │ First-Price          │
├──────────────┼─────────────────────┼──────────────────────┤
│ 支付金額     │ 第二高價 + $0.01    │ 出價金額本身         │
│ 出價策略     │ 誠實出價（最優）    │ Bid shading（出低價）│
│ 透明度       │ 低（中間層可操縱）  │ 高（所見即所付）     │
│ Publisher 收益│ 可能偏低            │ 通常更高             │
│ 複雜度       │ 廣告主不需策略      │ 需要 ML 模型做       │
│              │                     │ bid shading          │
└──────────────┴─────────────────────┴──────────────────────┘
```

### 底價 (Reserve Price)

```
Publisher 設定最低接受價格：
  - 若所有出價都低於 reserve price → 不賣（寧可空著）
  - 防止廣告位被低價傾銷
  - 典型 reserve price：display $0.50 CPM，video $5.00 CPM
```

---

## 5. 廣告定向 (Ad Targeting) 與索引

### 定向類型

| 類型 | 機制 | 資料來源 | 精準度 |
|------|------|----------|--------|
| 上下文定向 (Contextual) | 頁面內容關鍵字 / 分類 | NLP 分析頁面 | 中 |
| 行為定向 (Behavioral) | 使用者瀏覽歷史 / 興趣 | Cookie / device ID | 高 |
| 人口統計 (Demographic) | 年齡、性別、地區 | 註冊資料 / 推斷 | 中高 |
| 再行銷 (Retargeting) | 使用者看過商品 → 追蹤投放 | Pixel tracking | 極高 |
| 相似受眾 (Lookalike) | 找跟現有轉換者相似的人 | ML model | 高 |

### 定向索引 (Targeting Index) — 核心資料結構

```
預建反向索引 (Inverted Index)：
  segment:age_25_34       → [campaign_101, campaign_205, campaign_789, ...]
  segment:interest_tech   → [campaign_101, campaign_456, ...]
  segment:geo_US_CA       → [campaign_205, campaign_333, ...]
  segment:retarget_shoe   → [campaign_999, ...]

查詢流程（< 10ms）：
  User profile: {age: 28, interests: [tech, travel], geo: US_CA}
  → 查索引：
    age_25_34 ∩ interest_tech ∩ geo_US_CA
    = {campaign_101, campaign_205}  ← 候選集

索引更新：
  - Campaign 建立 / 修改 → 近即時更新索引（< 1 分鐘延遲）
  - 使用 Kafka + Index Builder service
  - 全量索引放在記憶體中（每個 ad server 節點都有本地副本）

大小估算：
  10M active campaigns × 平均 5 個 targeting segments × 8 bytes campaign_id
  = ~400MB → 完全放得進記憶體
```

---

## 6. Ad Selection Pipeline（自有平台模式）

Facebook Ads / Google Ads 不走外部 RTB，而是內部跑完整的選擇管線：

### 四階段漏斗

```
Stage 1: Candidate Generation（候選生成）
  輸入：User context（profile, page, device）
  方法：查 Targeting Index → 匹配所有符合條件的 campaigns
  輸出：~10,000 candidates
  延遲：< 10ms

Stage 2: CTR Prediction（點擊率預估）
  輸入：(user, ad) pair
  模型：Logistic Regression / Deep Neural Network
  特徵：user demographics, ad features, context, historical CTR
  輸出：P(click) for each candidate
  延遲：< 20ms（批次 inference，GPU/custom ASIC）

Stage 3: Ranking（排名）
  公式：eCPM = bid × P(click) × 1000

  例：
    Ad A: bid $2.00/click, P(click) = 0.05 → eCPM = $100
    Ad B: bid $1.00/click, P(click) = 0.12 → eCPM = $120 ← 贏
    Ad C: bid $3.00/click, P(click) = 0.02 → eCPM = $60

  為什麼用 eCPM 而不是純 bid？
  → 平台想最大化每次 impression 的收益
  → 高 CTR 的廣告即使 bid 低，帶來的期望收入可能更高
  → 也改善用戶體驗（高 CTR = 使用者可能真的有興趣）

Stage 4: Ad Quality & Policy（品質審查）
  - 廣告內容是否違規（色情、詐騙、假新聞）
  - Landing page 品質分數
  - 使用者反饋歷史（多少人 hide 過這則廣告）
  - 不通過 → 排除
```

### Pseudocode

```python
def select_ad(user, page_context, ad_slot):
    # Stage 1: Candidate generation
    user_segments = get_user_segments(user)  # < 2ms, in-memory
    candidates = targeting_index.query(user_segments, ad_slot.format)  # < 10ms

    # Budget + frequency filter
    candidates = [c for c in candidates
                  if budget_service.has_budget(c.campaign_id)      # < 3ms, local cache
                  and freq_cap.check(user.id, c.campaign_id) < c.max_freq]  # < 2ms

    # Stage 2: CTR prediction (batch inference)
    features = build_features(user, candidates, page_context)
    p_clicks = ctr_model.predict_batch(features)  # < 20ms, GPU

    # Stage 3: Ranking by eCPM
    ranked = sorted(
        zip(candidates, p_clicks),
        key=lambda c, p: c.bid * p * 1000,
        reverse=True
    )

    # Stage 4: Policy check
    for candidate, p_click in ranked:
        if policy_check(candidate):  # pre-computed, < 1ms
            return candidate

    return None  # no eligible ad
```

---

## 7. 出價最佳化 (Bid Optimization) — DSP 側

### 預算節奏控制 (Budget Pacing)

```
問題：
  廣告主日預算 $1,000
  如果不控制 → 早上 9 點全花完 → 下午沒有曝光

解法：Budget Pacer

  均勻分配法 (Uniform Pacing)：
    每小時分配：$1,000 / 24 = $41.67/hr
    每秒預算：$41.67 / 3600 = $0.012/sec
    每次拍賣前檢查：當前小時花費是否已超標？

  PID 控制器法（更精密）：
    目標：到 T 時刻應該花掉 (T/24) × 日預算
    實際：可能多或少
    調整：如果花太快 → 降低 bid multiplier；花太慢 → 提高

    bid_multiplier = base_bid × (1 + Kp × error + Ki × integral + Kd × derivative)

  為什麼近似計數就夠？
    → 數百個 DSP 節點同時出價，精確全域預算追蹤需要強一致性 → 延遲太高
    → 每個節點本地記 counter，定期（每 5-10 秒）同步到中央
    → 可能超花 1-3%，但遠好過放棄出價機會
```

### Bid Shading（一價拍賣下的出價策略）

```
問題：一價拍賣中，出 $5.00 就付 $5.00
  → 如果第二高價其實只有 $2.00，你多付了 $3.00

Bid Shading ML Model：
  輸入：ad slot 特徵、歷史成交價分佈、競爭強度
  輸出：建議出價 = 估計的市場清算價格 + 小幅溢價

  例：
    廣告主願付最高 $5.00
    模型預測：這個 slot 的中位數成交價 = $2.50
    Shaded bid = $2.80（在 $2.50 基礎上加一點以確保贏）

  效果：廣告主平均節省 20-30% 花費
```

### 頻次上限 (Frequency Capping)

```
規則：同一使用者每天最多看到某廣告 N 次（典型 N = 3-5）

實作：
  Key: freq:{user_id}:{campaign_id}:{date}
  Value: counter (atomic increment)
  Storage: Redis（TTL = 當日剩餘秒數）

  每次 ad selection 前：
    count = INCR freq:{user_id}:{campaign_id}:{today}
    if count == 1: EXPIRE key (seconds_until_midnight)
    if count > max_freq: skip this campaign

  為什麼放 Redis 不放 DB？
    → 每秒 1.2M ad requests 都要查 → DB 扛不住
    → Redis 單節點 100K+ ops/sec，cluster 可到數百萬
    → 過期自動清理，不需要額外 GC
```

---

## 8. Click / Impression 追蹤與歸因

### 曝光追蹤 (Impression Tracking)

```
1×1 透明 Pixel 法：
  廣告 HTML 中嵌入：
    <img src="https://track.ad-platform.com/imp?
      auction_id=xxx&campaign_id=yyy&ts=1234567890"
      width="1" height="1" style="display:none" />

  瀏覽器渲染廣告時自動請求這個 URL → Tracking Server 記錄一次 impression

  為什麼用 1×1 pixel 而不是 JS callback？
    → 1×1 pixel 幾乎所有環境都支援（包括 email、RSS reader）
    → 不受 JS 阻擋影響
    → 現代做法也用 JS beacon（navigator.sendBeacon）提供更豐富的 viewability 資料
```

### 點擊追蹤 (Click Tracking)

```
重定向法 (Click Redirect)：
  廣告連結不直接指向廣告主網站，而是：
    href="https://track.ad-platform.com/click?
      auction_id=xxx&redirect=https://advertiser.com/product"

  流程：
    1. 使用者點擊 → 請求 Tracking Server
    2. Tracking Server 記錄 click event
    3. 回傳 HTTP 302 Redirect 到廣告主的 landing page
    4. 延遲增加 < 20ms（使用者幾乎無感）
```

### 歸因 (Attribution)

```
問題：使用者看了 5 則廣告後購買，功勞歸誰？

Last-Click Attribution（最簡單）：
  → 最後一次點擊的廣告拿全部功勞
  → 問題：忽略了前面的 awareness 階段

Multi-Touch Attribution（更公平）：
  → Linear：每個觸點平均分
  → Time-decay：越接近購買的觸點分數越高
  → Data-driven：ML 模型根據歷史資料學習各觸點的貢獻

  典型 attribution window：
    Click-through：7-30 天
    View-through：1-7 天（看了廣告沒點，但後來自己來買）
```

### 事件管線 (Event Pipeline)

```
Tracking Server → Kafka → 多個下游消費者：

  ┌── ClickHouse / BigQuery（分析報表）
  │
  Kafka ─┼── Fraud Detection Service（即時偵測）
  │
  ├── Budget Service（更新花費）
  │
  └── Attribution Service（歸因計算）

規模：
  Impressions: ~100B/day → ~1.2M events/sec
  Clicks: ~1B/day → ~12K events/sec
  Kafka topic: 分 partition 按 campaign_id hash
  ClickHouse: 列式儲存，日查詢 PB 級數據，< 1 秒回應

為什麼選 ClickHouse 而非 MySQL？
  → 100B rows/day，MySQL 撐不住
  → 列式壓縮：100B impressions × 200 bytes ≈ 20TB/day raw → 壓縮後 ~2TB/day
  → 聚合查詢（GROUP BY campaign, date）極快
```

---

## 9. 反欺詐偵測 (Fraud Detection)

### 欺詐類型

| 類型 | 手法 | 偵測方式 |
|------|------|----------|
| 機器人流量 (Bot Traffic) | 腳本自動請求曝光 | User-agent 分析、行為模式（無滑鼠移動） |
| 點擊農場 (Click Farm) | 真人低薪大量點擊 | 地理異常、設備指紋重複 |
| 不可見曝光 (Hidden Impression) | 廣告放在 0×0 iframe | Viewability SDK（intersection observer） |
| 點擊注入 (Click Injection) | 手機 App 在安裝前注入假點擊 | 點擊到安裝時間異常短（< 2 秒） |
| Domain Spoofing | 假冒高流量網站賣 inventory | ads.txt / sellers.json 驗證 |

### 即時 vs 批次偵測

```
即時（< 100ms，在 ad serving path 上）：
  - IP 黑名單檢查（Bloom filter, < 1ms）
  - 設備指紋信譽分數（Redis lookup, < 2ms）
  - 基本速率限制（同一 IP 每分鐘 > 100 次 ad request → 可疑）

批次（分鐘~小時級）：
  - Kafka → Flink streaming job：
    - Sliding window 內同一 user_id 的 click 數量異常
    - CTR 異常高的 publisher（正常 display CTR ~0.1%，> 5% = 異常）
    - 轉換漏斗分析（大量 click 但零 conversion → 可疑）

  - 每日 batch job：
    - 設備指紋聚類分析（大量「不同」user 來自同一設備特徵）
    - 跨 campaign 的異常相關性

欺詐影響：
  廣告行業每年因欺詐損失 ~$65B（2023 年估計）
  偵測率目標：> 95% 的無效流量 (Invalid Traffic, IVT)
  誤殺率要低：< 0.1%（錯殺真實流量 = 損失收入）
```

---

## 10. 預算管理 (Budget Management)

```
三層預算架構：
  Account Balance（帳戶餘額）→ Daily Budget（日預算）→ Campaign Budget

Daily Budget 控制：
  ┌──────────────────────────────────────┐
  │  Central Budget Service              │
  │  (source of truth, MySQL/Postgres)   │
  │                                      │
  │  campaign_123: daily=$1000, spent=$0 │
  └───────────┬──────────────────────────┘
              │ 每 5-10 秒同步
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  ┌─────┐  ┌─────┐  ┌─────┐
  │Node1│  │Node2│  │Node3│
  │local│  │local│  │local│
  │$50  │  │$50  │  │$50  │  ← 每個節點分到一份 budget quota
  └─────┘  └─────┘  └─────┘

  流程：
    1. Central Service 將日預算分 shard 給各 ad server 節點
    2. 每個節點本地扣減（無需 RPC → 零延遲）
    3. 本地額度用完 → 向 Central 請求新額度
    4. Central 額度用完 → campaign 暫停投放

  為什麼不每次都查 Central？
    → 1.2M ad requests/sec × 查一次 budget = 1.2M RPC/sec → 太多
    → 本地 quota 法：每個節點只需幾百次/秒 RPC 向 Central 同步

預付 vs 後付：
  預付 (Pre-pay)：小廣告主，先儲值再投放
    → 扣款即時從 balance 扣
    → 餘額不足 → 暫停
  後付 (Post-pay)：大廣告主，月結
    → 先投放，月底出帳單
    → 需要信用額度控制
```

---

## 11. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 2B |
| Ad Requests/day | 100B → **~1.2M req/sec** |
| RTB Auctions/day | 50B → **~580K auctions/sec** |
| DSPs per auction | 10-20 |
| Bid responses/sec | 580K × 15 = **~8.7M bid eval/sec** |
| Impressions/day | ~50B |
| Clicks/day | ~1B（avg CTR ~2% for search, ~0.1% for display） |
| Event tracking throughput | **~1.2M events/sec**（impression + click） |
| Targeting Index size (memory) | 10M campaigns × 5 segments × 8B = **~400MB** |
| User Profile store | 2B users × 1KB = **~2TB**（Redis cluster） |
| Freq cap entries (Redis) | 2B users × 10 campaigns/day × 20B = **~400GB** |
| Impression log storage/day | 50B × 200B = **~10TB/day**（壓縮後 ~1TB） |
| Ad creative storage (CDN) | 10M active creatives × 500KB = **~5TB** |
| CTR model inference | ~1.2M inferences/sec（batch: 100 candidates/request） |
| End-to-end latency budget | **< 200ms**（self-serve）/ **< 100ms**（RTB） |

---

## 12. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 拍賣類型 | **First-price（趨勢）** | 更透明，但 DSP 需要 bid shading model；二價仍在部分市場使用 |
| 預算追蹤 | **本地 quota + 非同步同步** | 精確全域計數需強一致性 → 延遲不可接受；容忍 1-3% 超花 |
| Targeting Index 位置 | **每節點記憶體本地副本** | 400MB 完全放得進 RAM；遠端查詢會增加 5-10ms 延遲 |
| CTR 模型部署 | **線上 inference（非預計算）** | User-ad pair 組合太多無法預計算；GPU batch inference < 20ms |
| 事件管線 | **Kafka → ClickHouse** | 列式存儲支撐 PB 級分析；Kafka 解耦生產消費 |
| 頻次上限存儲 | **Redis + TTL** | 高 QPS 查詢 + 自動過期清理；不需要持久化（丟了重新計數即可） |
| Fraud detection 路徑 | **即時 Bloom filter + 批次 ML** | 即時過濾明顯壞流量（< 1ms）；複雜模式用批次分析（分鐘級） |
| 廣告 creative 分發 | **CDN 預緩存** | 廣告素材不常變；CDN cache hit rate > 95%，全球延遲 < 20ms |
| 歸因模型 | **Last-click → Multi-touch** | Last-click 簡單但不公平；data-driven multi-touch 需要大量資料 |
| Budget pacing | **PID 控制器** | 比簡單均分更能適應流量波動；避免早上花完、下午空轉 |

---

## 13. 面試常見 Follow-up

### Q: 如果 DSP 超時（> 50ms）怎麼辦？

```
Ad Exchange 設硬性 timeout：
  - 50ms 到 → 未回覆的 DSP 視為放棄（no-bid）
  - 只用已收到的出價做拍賣
  - 絕不等所有 DSP → 否則一個慢 DSP 拖垮整個系統

DSP 側優化：
  - 所有依賴都必須 in-memory（user profile, targeting index）
  - Pre-filter：快速判斷 no-bid（沒有匹配的 campaign）→ 立即回 no-bid
  - 機房就近部署（DSP server 與 Exchange 在同一 region）
```

### Q: 如何處理 Ad Blocker？

```
技術面：
  - 可偵測 ad blocker（檢查 ad container 是否被隱藏）
  - 部分網站：偵測到 → 要求關閉 ad blocker 才能看內容

商業面：
  - Native advertising（原生廣告，跟內容混在一起，難被 block）
  - Server-side ad insertion（SSAI）：在 server 端把廣告嵌入內容流
    → 影片平台常用（廣告跟內容是同一個串流 URL）
  - 使用者約 25-30% 有裝 ad blocker → 損失顯著但非致命
```

### Q: 如何保證廣告在可見區域？(Viewability)

```
IAB 標準：
  - Display ad: 50% 的 pixel 在可見區域 ≥ 1 秒
  - Video ad: 50% 的 pixel 在可見區域 ≥ 2 秒連續播放

技術實作：
  - Intersection Observer API（瀏覽器原生）
  - 當 ad container 進入 viewport → 開始計時
  - 達標 → 才算一個 viewable impression → 才計費

  → vCPM (viewable CPM) 正逐漸取代傳統 CPM
  → 行業平均 viewability rate ~50-60%（display），~70% (video)
```

### Q: 隱私法規（GDPR / iOS ATT）如何影響系統設計？

```
影響：
  - 第三方 Cookie 即將消亡（Chrome 2025 年開始限制）
  - iOS ATT (App Tracking Transparency)：使用者可拒絕追蹤（~75% 拒絕）
  - GDPR：明確同意才能追蹤

系統調整：
  1. Contextual targeting 回歸（不需要使用者資料）
  2. First-party data 價值暴增（平台自己的登入資料）
  3. Privacy Sandbox / Topics API（Chrome 提案，瀏覽器端做粗略興趣分類）
  4. On-device ML：在使用者裝置上做 ad matching，不傳原始資料

架構變化：
  - User Profile Store 可能從詳細行為歷史 → 粗略 cohort label
  - Targeting Index 維度減少，但每個 segment 更大
  - 歸因更困難 → 需要 probabilistic attribution（統計推斷）
```

---

## 14. 面試策略：講述順序建議

1. **需求釐清 + 規模估算**（2 分鐘）— 釐清是 RTB 還是 self-serve；DAU、ad request QPS、延遲約束 < 100ms
2. **RTB 拍賣流程（高層）**（2 分鐘）— SSP → Exchange → DSP fan-out → 拍賣 → 回傳。畫 ASCII 圖
3. **Ad Selection Pipeline（核心）**（4 分鐘）— Candidate generation（targeting index）→ CTR prediction → eCPM ranking → policy check。解釋每一步的延遲預算
4. **拍賣機制**（2 分鐘）— 二價 vs 一價，truthful bidding，bid shading
5. **追蹤與歸因**（2 分鐘）— Impression pixel、click redirect、Kafka → ClickHouse pipeline
6. **預算管理 + 頻次上限**（1 分鐘）— 本地 quota 法，Redis freq cap
7. **反欺詐**（1 分鐘）— 即時 Bloom filter + 批次 ML
8. **Deep Dive（面試官選）**（2 分鐘）— Privacy/GDPR 影響、bid optimization、fraud detection 細節
