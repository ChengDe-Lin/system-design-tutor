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

### 3.3 Exactly-Once 語意

```
計費場景：多算一次 click → 廣告主多付錢 → 要賠
          少算一次 click → 平台少收錢 → 虧

三個環節都要保證：

① Kafka → Flink：
   Flink Kafka Consumer checkpoint offset → 失敗時從 checkpoint 恢復
   → 保證不重複消費

② Flink 內部計算：
   Flink checkpoint（Chandy-Lamport 分散式快照）
   → 定期把 state（各窗口計數）snapshot 到持久化儲存
   → 失敗時從最近的 snapshot 恢復，重播 Kafka offset 之間的 events

③ Flink → Sink（OLAP DB）：
   兩種方式：
   a) 冪等寫入：用 (ad_id, window_start, window_end) 做 upsert key
      → 重複寫入同一個 key 結果不變
   b) Two-phase commit：Flink 2PC sink connector
      → 保證 checkpoint 與 sink 寫入原子性

推薦 (a) 冪等寫入 → 實作簡單，OLAP DB 天然支援 upsert
```

### 3.4 儲存層

| 選項 | 特性 | 適合 |
|------|------|------|
| **ClickHouse** | 列式儲存、極快聚合查詢、支援近即時 insert | 即時 dashboard + 歷史查詢 |
| **Apache Druid** | 預聚合 ingestion、亞秒查詢、原生 Kafka ingestion | 超低延遲 slice-and-dice |
| **TimescaleDB** | PostgreSQL 擴展、熟悉的 SQL | 中小規模、團隊已用 PG |

**Ad Click 場景推薦 ClickHouse**：
- 寫入：百萬行/秒（batch insert）
- 查詢：`SELECT ad_id, sum(clicks) FROM agg_table WHERE timestamp BETWEEN ... GROUP BY ad_id` → 毫秒級
- 自帶 TTL 機制可自動清理過期資料

### 3.5 Click Fraud Detection

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

```
Ad Click 場景：精確計數（因為計費）
Top-K Trending：用 Count-Min Sketch + Min-Heap → 省記憶體
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

## 8. 決策樹

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

## 9. 常見面試陷阱

| 陷阱 | 正確理解 |
|------|---------|
| "用 Redis 做即時計數就好" | Redis 可以做，但單點記憶體有限、沒有時間窗口語意、crash 時 state 可能丟失。適合 rate limiter，不適合大規模聚合 |
| "Kafka 本身可以做聚合" | Kafka Streams 可以，但大規模場景 Flink 的 state management 和 checkpoint 更成熟 |
| "直接寫 DB 累加" | 高 QPS 下 DB 扛不住大量 increment；先在 stream processor 聚合再批次寫入 |
| "Event time 和 processing time 沒差" | 差很多。用 processing time 會因為 consumer lag 導致聚合結果錯誤 |
| "Exactly-once 很簡單" | 需要 source（Kafka offset）+ processor（checkpoint）+ sink（冪等/2PC）三段配合 |
