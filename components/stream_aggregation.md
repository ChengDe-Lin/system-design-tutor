# 串流聚合 (Stream Aggregation)：即時計數、時間窗口與 Exactly-Once

> 主線案例：Ad Click Aggregator
> 可複用場景：Web Analytics、Top-K / Trending Topics、Rate Limiter、Real-time Dashboard

---

## 1. 問題定義

```
輸入：高頻事件流（click、impression、page view、transaction...）
輸出：按維度聚合的計數/統計，持續更新
     e.g. "ad_id=123 在過去 1 分鐘內被點擊 47 次"

規模（以大型廣告平台為參考）：
  Ad clicks/day: ~10B → ~115K events/sec
  Ad impressions/day: ~1T → ~11.6M events/sec
  聚合維度: ad_id × region × device_type × timestamp_window
  延遲要求: 秒級（即時 dashboard）到分鐘級（計費結算）
  正確性要求: 計費相關 → 必須 exactly-once（多算要賠錢，少算要虧錢）
```

---

## 2. 整體架構

```
                     ┌─────────────────────────────────────────────────────────┐
                     │                    Query Service                        │
                     │         (API: "ad_id=123 過去 1hr clicks?")             │
                     └──────────────────────┬──────────────────────────────────┘
                                            │ 讀取
                                            ▼
┌──────────┐    ┌─────────┐    ┌──────────────────┐    ┌────────────────────┐
│  Client   │──→│  Kafka   │──→│  Stream Processor │──→│   OLAP Storage     │
│ (SDK/App) │    │ (buffer) │    │  (Flink / Spark)  │    │ (ClickHouse/Druid) │
└──────────┘    └─────────┘    └──────────────────┘    └────────────────────┘
      │                                │
      │                                ▼
      │                        ┌──────────────┐
      │                        │  Dead Letter  │ ← 處理失敗的 event
      │                        │  Queue (DLQ)  │
      │                        └──────────────┘
      │
      ▼
┌──────────────┐
│  Click Fraud  │ ← 即時/近即時欺詐偵測
│  Detection    │
└──────────────┘
```

---

## 3. 各層設計

### 3.1 Event 收集層

```
Client（瀏覽器/App）
  → 發送 click event 到 Click Tracking Service（輕量 HTTP endpoint）
  → Service 做基本驗證後寫入 Kafka

Event Schema:
{
  "event_id": "uuid-v7",        ← 冪等 key（用於 dedup）
  "ad_id": "ad_123",
  "campaign_id": "camp_456",
  "user_id": "u_789",           ← 可能是匿名 ID
  "timestamp": 1712200000000,
  "event_type": "click",        ← click / impression / conversion
  "device_type": "mobile",
  "region": "us-west-2",
  "ip": "203.0.113.42",
  "user_agent": "..."
}
```

**Kafka Partition 策略**：按 `ad_id` hash → 同一個 ad 的 events 落在同一個 partition → 下游聚合不需跨 partition。

### 3.2 Stream Processing 層（核心）

#### 時間窗口 (Windowing)

```
Event Time:  ──────────────────────────────────────→
             |  Window 1  |  Window 2  |  Window 3  |

三種窗口類型：

Tumbling（翻滾窗口）：固定區間，不重疊
  |──── 1 min ────|──── 1 min ────|──── 1 min ────|

Sliding（滑動窗口）：固定大小，步進滑動
  |──── 5 min ─────|
       |──── 5 min ─────|
            |──── 5 min ─────|

Session（會話窗口）：以 inactivity gap 分割
  |─ events ─|  gap  |─ events ──|  gap  |─ events ─|
```

**Ad Click 場景**：
- **1 分鐘 tumbling window**：即時 dashboard 用
- **1 小時 tumbling window**：計費結算用
- 兩個 window 可以平行跑在同一個 Flink job 裡

#### Watermark 與 Late Event 處理

```
問題：event 可能遲到（網路延遲、client 離線後補送）

Timeline:
  00:00   00:01   00:02   00:03
    │       │       │       │
    ▼       ▼       ▼       ▼
  [events] [events] [close window 00:00-00:01]
                      │
                      │  ← 這時收到一筆 timestamp=00:00:45 的 event（遲到）
                      │
                      ▼
                   怎麼辦？

方案：
  1. Watermark：宣告 "我相信 T 之前的 event 都到齊了"
     → watermark = max(event_time) - allowed_lateness (e.g. 5 sec)
     → window 在 watermark 超過 window_end 時才觸發計算

  2. Late event 處理策略：
     a) Drop（丟棄）→ 簡單但會少算
     b) Side output → 寫到另一個 stream，後續修正
     c) Allowed lateness → 窗口保持 open 額外一段時間，遲到的仍可計入
```

**Ad Click 場景用 (c)**：allowed lateness = 5 分鐘。超過 5 分鐘的 late click 進 side output → 觸發離線修正 job。

### 3.3 Flink Checkpoint 機制（Chandy-Lamport 分散式快照）

**問題**：Flink 是分散式系統，多個 operator 在不同機器上平行跑。如果其中一個掛了，怎麼恢復到一致的狀態？

**核心想法**：定期對整個 pipeline 拍一張「一致性快照」，失敗時從最近的快照恢復。

```
Flink Pipeline 範例：
  Source (Kafka) → Map → KeyBy(ad_id) → Window Aggregate → Sink

每個 operator 都有自己的 state：
  Source: 目前讀到的 Kafka offset
  Window Aggregate: 每個 ad_id 的窗口計數 {ad_123: 47, ad_456: 12, ...}
```

#### Checkpoint 流程（Chandy-Lamport 演算法簡化版）

```
Step 1: JobManager 發起 checkpoint，注入 barrier 到 Source

  Source          Map          Window Agg       Sink
    │               │              │              │
    │──barrier──→   │              │              │
    │  data         │              │              │
    │  data         │              │              │

Step 2: Source 收到 barrier → 快照自己的 state（Kafka offset=1000）→ 轉發 barrier

  Source          Map          Window Agg       Sink
    │               │              │              │
   [offset=1000]    │──barrier──→  │              │
    saved ✓         │  data        │              │

Step 3: 每個 operator 收到 barrier → 快照自己的 state → 轉發 barrier

  Source          Map          Window Agg       Sink
    │               │              │              │
   [offset=1000]  [stateless]   [{ad_123:47}]    │──barrier──→
    saved ✓        saved ✓       saved ✓          │

Step 4: 所有 operator 都完成 → checkpoint 成功
        State 存到持久化儲存（S3 / HDFS）
```

**Barrier 的關鍵**：它像一條分界線，把 stream 切成「checkpoint N 之前的資料」和「之後的資料」。Operator 看到 barrier 時，它的 state 剛好反映了 barrier 之前所有資料的處理結果。

#### Barrier Alignment（多輸入的情況）

```
Window Aggregate 有兩個輸入 channel（來自不同 partition）：

  Channel A: data, data, barrier, data, data ...
  Channel B: data, data, data, data, barrier ...
                                       ↑ barrier 還沒到

  Window Agg 做法：
    1. 收到 Channel A 的 barrier → 暫停消費 Channel A
    2. 繼續消費 Channel B 直到也收到 barrier
    3. 兩邊 barrier 都到齊 → 快照 state → 轉發 barrier → 恢復消費

  為什麼要等？→ 確保快照反映的是兩邊同一「邏輯時間點」的 state
```

#### 失敗恢復

```
正常執行：
  Checkpoint 1 (offset=1000, {ad_123:47})
  Checkpoint 2 (offset=2000, {ad_123:89})    ← 最近一次成功的 checkpoint
  ... 處理到 offset=2500 時 Window Agg 節點掛了 ...

恢復：
  1. 從 Checkpoint 2 恢復所有 operator 的 state
     → Source 回到 offset=2000
     → Window Agg 恢復 {ad_123:89}
  2. 從 offset=2000 重新消費 Kafka，重新處理 2000-2500 的 events
  3. 結果跟掛之前一樣（因為處理邏輯是 deterministic）

  → 這就是 exactly-once 的保證：不多不少，剛好處理一次
```

### 3.4 Event Time vs Processing Time

```
Event Time:      event 實際發生的時間（client 端 timestamp）
Processing Time: event 被 Flink 處理的時間（server 端收到的時間）

為什麼不能用 Processing Time？

  假設 Flink consumer 因為部署而暫停 5 分鐘：

  Event Time 視角：
    00:00-00:01 的 events 歸到 00:00-00:01 窗口 ✓（不管幾點被處理）

  Processing Time 視角：
    00:00-00:05 的 events 全部在 00:05 被處理
    → 全部擠進 00:05-00:06 的窗口
    → 00:00-00:04 的窗口全是空的，00:05 的窗口爆量
    → 聚合結果完全失真

結論：計費/分析場景必須用 Event Time
     只有「我不在乎精確時間」的監控場景才用 Processing Time
```

### 3.5 Exactly-Once 三段保證

```
計費場景：多算一次 click → 廣告主多付錢 → 要賠
          少算一次 click → 平台少收錢 → 虧

三個環節都要保證：

① Kafka → Flink：
   Checkpoint 記錄 Kafka offset → 失敗時從 checkpoint 的 offset 恢復
   → 保證不重複消費

② Flink 內部計算：
   Checkpoint（如上述 Chandy-Lamport 機制）
   → 定期把 state（各窗口計數）snapshot 到持久化儲存（S3/HDFS）
   → 失敗時從最近的 snapshot 恢復，重播中間的 events
   → Checkpoint interval 通常 1-5 分鐘（越頻繁 = 恢復時重播越少，但開銷越大）

③ Flink → Sink（OLAP DB）：
   兩種方式：
   a) 冪等寫入：用 (ad_id, window_start, window_end) 做 upsert key
      → 重複寫入同一個 key 結果不變
   b) Two-phase commit：Flink 2PC sink connector
      → 保證 checkpoint 與 sink 寫入原子性

推薦 (a) 冪等寫入 → 實作簡單，OLAP DB 天然支援 upsert

2PC 怎麼運作（簡述）：
  Pre-commit: Flink 把資料寫入 sink 但標記為「未確認」
  Checkpoint 成功 → Commit: 通知 sink 把資料標記為「已確認」（可被查詢）
  Checkpoint 失敗 → Abort: 通知 sink 丟棄未確認的資料
  → 保證 checkpoint 和 sink 寫入是原子的
  → 代價：sink 必須支援 transaction（Kafka sink 支援，但大部分 OLAP DB 不支援）
  → 所以實務上冪等寫入更常用
```

### 3.6 Dead Letter Queue (DLQ)

```
DLQ 是什麼：處理失敗的 event 被送到的「隔離區」

正常流程：
  Kafka → Flink 處理 → 成功 → 寫入 ClickHouse

某筆 event 處理失敗（格式錯誤、schema 不符、反序列化失敗）：
  Kafka → Flink 處理 → 失敗 → 寫入 DLQ（另一個 Kafka topic）

為什麼不直接丟掉？
  → 計費場景少算一筆就是虧錢
  → DLQ 裡的 event 後續可以人工檢查或修復後重新處理
  → 也是監控告警的來源：DLQ 積壓量突然上升 = 上游資料格式出問題

DLQ 的處理流程：
  1. 告警：DLQ 積壓 > 閾值 → 觸發 PagerDuty
  2. 診斷：查看失敗原因（schema 變更？新增未知欄位？）
  3. 修復：修好 parser → 把 DLQ 的 events 重新灌回主 pipeline
```

### 3.7 儲存層

| 選項 | 特性 | 適合 |
|------|------|------|
| **ClickHouse** | 列式儲存、極快聚合查詢、支援近即時 insert | 即時 dashboard + 歷史查詢 |
| **Apache Druid** | 預聚合 ingestion、亞秒查詢、原生 Kafka ingestion | 超低延遲 slice-and-dice |
| **TimescaleDB** | PostgreSQL 擴展、熟悉的 SQL | 中小規模、團隊已用 PG |

**Ad Click 場景推薦 ClickHouse**：
- 寫入：百萬行/秒（batch insert）
- 查詢：`SELECT ad_id, sum(clicks) FROM agg_table WHERE timestamp BETWEEN ... GROUP BY ad_id` → 毫秒級
- 自帶 TTL 機制可自動清理過期資料

### 3.8 Click Fraud Detection

```
常見欺詐模式：
  1. 同一 IP 對同一 ad 高頻點擊（bot）
  2. Click farm：大量不同 IP 但行為模式一致
  3. 點擊後 0 秒跳出（no engagement）

偵測方式：
  即時：Flink 維護 per-IP/per-user 的 sliding window counter
       → 超過閾值 → 標記為 suspicious → 不計入計費聚合
  
  近即時：batch job 跑 ML model
       → feature: CTR 異常、地理分佈異常、session duration 分佈
       → 標記後扣除已計費的 fraudulent clicks（退款機制）
```

---

## 4. 擴展性設計

### Kafka 層

```
Partition 數 = 目標吞吐量 / 單一 partition 吞吐量
  115K events/sec ÷ 10K events/sec/partition ≈ 12 partitions（clicks）
  11.6M events/sec ÷ 10K/partition ≈ 1,200 partitions（impressions）

注意：partition 數只能增不能減，初始設定要留餘量
```

### Flink 層

```
Parallelism = Kafka partition 數（1:1 對應最簡單）
State backend: RocksDB（大 state）或 Heap（小 state）
Checkpoint interval: 1-5 分鐘（trade-off：頻繁 = 低數據損失但高開銷）
```

### 查詢層

```
即時查詢（最近 1 小時）→ 打 OLAP DB（ClickHouse）
歷史查詢（過去 30 天）→ 打 pre-aggregated 表
超長期查詢（年度報表）→ 打 data warehouse（BigQuery / Redshift）
```

---

## 5. 同樣模式可複用的場景

| 場景 | Event | 聚合維度 | 特殊需求 |
|------|-------|---------|---------|
| **Ad Click Aggregator** | click/impression | ad_id × region × time | Exactly-once 計費、fraud detection |
| **Web Analytics (GA-like)** | page_view, session | page × source × time | Session 窗口、bounce rate 計算 |
| **Top-K / Trending** | search/hashtag/view | keyword × time | 近似計數（Count-Min Sketch, HeavyKeeper） |
| **Distributed Rate Limiter** | API request | user_id × endpoint × time | Sliding window、低延遲判定 |
| **Real-time Dashboard** | 任意 metric | 多維度 | 低延遲查詢、auto-refresh |
| **IoT Sensor Aggregation** | sensor reading | device × location × time | 亂序 event、高 fan-in |

---

## 6. 近似計數演算法（Top-K / 高基數場景）

當 unique key 數量極大（如十億級 URL 的 view count），精確計數的記憶體成本太高：

| 演算法 | 用途 | 空間複雜度 | 誤差 |
|--------|------|-----------|------|
| **Count-Min Sketch** | 頻率估計（每個 key 的 count） | O(width × depth)，固定大小 | 只會高估，不會低估 |
| **HyperLogLog** | 基數估計（unique count） | ~12 KB 可估 10⁹ unique | ~0.81% 標準誤差 |
| **HeavyKeeper** | Top-K 高頻元素 | O(K × depth) | 高頻元素幾乎精確 |

### Count-Min Sketch 運作原理

```
結構：一個 depth × width 的二維陣列，初始全為 0
     每一行（row）對應一個獨立的 hash function

寫入 "ad_123" 的 click：
  hash_1("ad_123") % width = 3  → row 1, col 3 += 1
  hash_2("ad_123") % width = 7  → row 2, col 7 += 1
  hash_3("ad_123") % width = 1  → row 3, col 1 += 1

查詢 "ad_123" 的 click count：
  取 row 1[3], row 2[7], row 3[1] 中的最小值
  → 為什麼取最小值？因為其他 key hash 到同一位置會導致高估
  → 取最小值 = 取受 collision 影響最小的那個
  → 所以 Count-Min Sketch 只會高估，不會低估

空間：固定大小（e.g. 1000 × 5 = 5000 個 counter）
     不管追蹤多少個 key 都一樣大
     → 10 億個 key 也只用幾 KB
```

### HyperLogLog 運作原理

```
問題：統計 unique visitor count（不是每個 key 的 count，是有多少不同的 key）

精確做法：HashSet → 10 億 unique user 要 ~幾十 GB 記憶體
HyperLogLog：~12 KB 記憶體，誤差 ~0.81%

核心觀察：
  對隨機 hash 值，看二進位表示中「開頭連續 0 的最大長度」
  → 如果你看到 0000001... （6 個前導零），大概觀察了 2⁶ = 64 個不同值

  直覺：丟硬幣連續 6 次正面的機率是 1/64
       → 如果你觀察到這個現象，推測你大概丟了 ~64 次

  HyperLogLog 把 hash 空間分成很多 bucket（2¹⁴ = 16384 個）
  每個 bucket 記錄看到的最大前導零數 → 最後做調和平均估算

為什麼叫 "HyperLogLog"：
  → 記錄的值是 log(log(N)) 等級的大小 → 極省空間
```

### HeavyKeeper（Top-K 高頻元素）

```
問題：找出 Top-K 最高頻的元素（e.g. 最熱門的 100 個搜尋關鍵字）

結構：Count-Min Sketch 的變體 + Min-Heap (size K)

差異：Count-Min Sketch 對每個 hash 碰撞都累加（高估）
     HeavyKeeper 對低頻元素有「衰減」機制 → 高頻元素的 count 更精確

流程：
  1. 新 element 進來 → hash 到各行的 bucket
  2. 如果 bucket 裡的 fingerprint 匹配 → 累加（是同一個 key）
  3. 如果不匹配 → 以一定機率衰減現有 count（機率隨 count 值指數下降）
     → 高頻元素幾乎不會被衰減掉，低頻元素很快歸零
  4. Count 歸零 → 被新 element 替換
  5. Min-Heap 維護 Top-K：count 超過 heap 最小值就替換

適用：trending hashtags、熱門商品、Top-K 搜尋詞
```

```
使用場景對應：
  Ad Click 場景：精確計數（因為計費，不能用近似）
  Top-K Trending：用 Count-Min Sketch + Min-Heap 或 HeavyKeeper → 省記憶體
  Unique Visitors：用 HyperLogLog → 12KB 追蹤十億 UV
```

---

## 7. 容量估算（Ad Click Aggregator）

| 指標 | 估算 |
|------|------|
| Daily clicks | 10B |
| Peak QPS | ~115K × 3（peak factor）≈ **345K events/sec** |
| Event size | ~500 bytes |
| Raw daily ingestion | 10B × 500B = **5 TB/day** |
| Kafka retention（7 天） | 5TB × 7 × RF=3 = **105 TB** |
| Aggregated output（1-min window） | 遠小於 raw → ~50 GB/day |
| ClickHouse storage（90 天 aggregated） | ~4.5 TB |
| Flink state size | Per-window counter × active ad count → ~幾十 GB |
| Flink cluster | ~20-30 TaskManagers（中型叢集） |

---

## 8. 處理引擎選型：Flink vs Spark vs Hadoop MapReduce

### 本質差異：處理模型

```
Flink:          event → process → event → process → event → process
                逐條處理，真正的 stream-native

Spark Streaming: [event, event, event] → batch process → [event, event, event] → batch process
                 Micro-batch：每隔 N 秒收一批再處理

Hadoop MR:      [整個 dataset] → Map → 寫磁碟 → Shuffle → 寫磁碟 → Reduce → 寫磁碟
                純 batch，每步都落磁碟
```

### 比較矩陣

| 維度 | Flink | Spark (Structured Streaming) | Hadoop MapReduce |
|------|-------|------------------------------|------------------|
| **處理模型** | 逐條 event（真串流） | Micro-batch（每 100ms~數秒一批） | 純 batch（分鐘~小時） |
| **延遲** | **毫秒級** | 秒級（最低 ~100ms） | 分鐘級 |
| **吞吐量** | 百萬 events/sec | 百萬 events/sec | 高（但延遲大） |
| **State Management** | **原生支援**，RocksDB backend（見下方說明），可管理 TB 級 state | 有但較受限，大 state 效能下降 | 無原生 state（要靠外部儲存） |
| **Exactly-once** | Chandy-Lamport checkpoint，**最成熟** | Checkpoint + WAL，可靠但機制較簡單 | 靠 HDFS 寫入的原子性 |
| **Windowing** | Event time 原生支援、Watermark 機制完整 | 支援但基於 micro-batch 觸發 | 要自己實作 |
| **Late event 處理** | Allowed lateness + side output，**最靈活** | 支援 watermark，但粒度受 batch interval 限制 | 不支援 |
| **Batch 處理** | 可以（視 batch 為有界 stream） | **主場優勢**，生態豐富 | 主場（但已被 Spark 取代） |
| **SQL 支援** | Flink SQL（持續改進中） | **Spark SQL，非常成熟** | Hive（另一套系統） |
| **ML 整合** | 有 FlinkML 但生態小 | **MLlib，生態最大** | Mahout（已淘汰） |
| **學習曲線** | 較陡（stream 思維、watermark 等概念） | 較平（會 SQL/DataFrame 就能上手） | 中（Map/Reduce 概念簡單但程式繁瑣） |
| **社群/生態** | 串流領域最強，中國公司大量採用 | **整體生態最大**（Databricks 主推） | 逐漸被 Spark 取代 |
| **維運複雜度** | 中高（state 管理、checkpoint tuning） | 中（Databricks 託管版很省事） | 高（Hadoop 叢集管理） |

### Flink State Backend：為什麼用 RocksDB

```
Flink 每個 operator 可以有 state（e.g. 窗口計數、per-key counter）
State 需要存在某個地方 → 兩個選項：

Heap State Backend:
  → State 存在 JVM heap 記憶體裡
  → 讀寫極快（記憶體操作）
  → 限制：state 不能超過記憶體大小（幾 GB）
  → 適合：state 很小的場景

RocksDB State Backend:
  → State 存在本地磁碟的 RocksDB（嵌入式 key-value store，LSM-Tree 結構）
  → 熱資料在記憶體（block cache），冷資料在磁碟
  → 可管理 TB 級 state（遠超記憶體大小）
  → 讀寫比 Heap 慢（可能涉及磁碟 I/O），但對串流場景夠快
  → Checkpoint 時做增量快照（只傳差異），不用每次傳整份 state

Ad Click 場景：
  數百萬 ad_id × 多個窗口 × 每個窗口的 counter = 幾十 GB state
  → 超過記憶體 → 必須用 RocksDB
```

### 什麼場景選什麼

```
選 Flink 當：
  ✓ 延遲要求毫秒級（ad click 計費、fraud detection、即時風控）
  ✓ 需要複雜的 event time windowing + late event 處理
  ✓ State 很大（per-key counter 跨數百萬 key）
  ✓ 正確性要求極高（金融、計費 → exactly-once 最成熟）

選 Spark 當：
  ✓ 團隊已有 Spark batch pipeline，想統一技術棧
  ✓ 秒級延遲可接受（dashboard、monitoring、日誌分析）
  ✓ 同時需要 batch ETL + streaming（一套 code 兩種模式）
  ✓ 需要 ML pipeline 整合（MLlib 生態遠大於 FlinkML）
  ✓ 想用 Databricks 託管，少操心維運

選 Hadoop MapReduce 當：
  ✗ 幾乎不選了。唯一場景：維護 legacy 系統
```

### 面試中怎麼答

```
面試官問："為什麼選 Flink 不選 Spark？"

回答框架：
  1. 先說處理模型差異：Flink 逐條 vs Spark micro-batch
  2. 再說這個差異在此場景的影響：
     - Ad click 計費 → 毫秒級延遲 + exactly-once → Flink
     - 日誌分析 dashboard → 秒級夠用 + 團隊熟 Spark → Spark
  3. 補一句：不是 Flink 一定比 Spark 好，是 stream-first vs batch-first 的設計哲學不同

不要說："Flink 比 Spark 快" ← 這太籠統
要說："Flink 的逐條處理模型在延遲敏感場景下優於 Spark 的 micro-batch，
      但 Spark 在 batch ETL 和 ML 整合的生態更成熟"
```

---

## 9. 決策樹（整體）

```
需要聚合事件流？
├── 延遲要求 < 1 秒？
│   ├── 是 → Flink（真正的 stream processing）
│   └── 否 → Spark Structured Streaming（micro-batch, 延遲 ~秒級）
│
├── 需要 exactly-once？
│   ├── 是（計費/金融）→ Flink checkpoint + 冪等 sink
│   └── 否（dashboard/監控）→ at-least-once + 冪等 upsert 也夠
│
├── 需要近似還是精確？
│   ├── 精確（計費）→ 精確 counter
│   └── 近似可接受（Top-K, UV）→ Count-Min Sketch / HyperLogLog
│
└── 查詢模式？
    ├── 固定維度 slice-and-dice → ClickHouse / Druid
    ├── Ad-hoc SQL → BigQuery / Redshift
    └── 超低延遲 key lookup → Redis pre-aggregated
```

---

## 10. 常見面試陷阱

| 陷阱 | 正確理解 |
|------|---------|
| "用 Redis 做即時計數就好" | Redis 可以做，但單點記憶體有限、沒有時間窗口語意、crash 時 state 可能丟失。適合 rate limiter，不適合大規模聚合 |
| "Kafka 本身可以做聚合" | Kafka Streams 可以，但大規模場景 Flink 的 state management 和 checkpoint 更成熟 |
| "直接寫 DB 累加" | 高 QPS 下 DB 扛不住大量 increment；先在 stream processor 聚合再批次寫入 |
| "Event time 和 processing time 沒差" | 差很多。用 processing time 會因為 consumer lag 導致聚合結果錯誤 |
| "Exactly-once 很簡單" | 需要 source（Kafka offset）+ processor（checkpoint）+ sink（冪等/2PC）三段配合 |
