# Metrics & Monitoring System — 大規模可觀測性平台架構

## 1. 核心挑戰

監控系統是所有分散式系統的「神經系統」，負責即時偵測異常、支援除錯、保障可用性：

```
規模（以 Datadog 等級估算）：
  監控的主機數: ~100K hosts
  每台主機的 metric series: ~300 unique time series
  總 time series: ~30M active series
  每個 series 每 15 秒一個 data point → ~2M data points/sec
  每日寫入: ~170B data points/day

  Dashboard 查詢: ~500K queries/min（高峰時段）
  Alert rules: ~1M 條 active rules，每分鐘 evaluate 一次

三大支柱（Three Pillars of Observability）：
  - Metrics：結構化數值，適合聚合與告警（CPU 使用率、QPS、p99 latency）
  - Logs：離散事件的文字記錄，適合 debug 與審計（error stack trace）
  - Traces：跨服務請求的完整路徑，適合追蹤單一請求的瓶頸

核心矛盾：
  - 寫入極重（2M points/sec），查詢範圍可達數月
  - 原始資料保留成本高，但降精度又可能丟失異常 spike
  - Alert 必須低延遲（< 30s 偵測到異常），但不能製造 alert fatigue
```

---

## 2. 整體架構

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Data Sources                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ App Code │  │  OS/Infra │  │ K8s Pods │  │ Short-lived Jobs │    │
│  │ (counter,│  │ (node    │  │ (cAdvisor│  │  (batch, cron)   │    │
│  │  gauge)  │  │  exporter)│  │  metrics)│  │                  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    │
│       │              │              │                 │              │
│   ┌───▼──────────────▼──────────────▼──┐     ┌───────▼──────────┐   │
│   │   Pull: Scraper / Prometheus       │     │ Push: Agent/StatsD│   │
│   │   (service discovery + /metrics)   │     │ (push to gateway) │   │
│   └──────────────┬─────────────────────┘     └───────┬──────────┘   │
└──────────────────┼───────────────────────────────────┼──────────────┘
                   │                                   │
                   ▼                                   ▼
          ┌────────────────────────────────────────────────┐
          │              Ingestion Gateway                  │
          │  (validation, relabeling, rate limiting)        │
          └──────────────────┬─────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │  TSDB Shard 1│ │ TSDB ... │ │ TSDB Shard N │
     │  (in-mem +   │ │          │ │              │
     │   disk WAL)  │ │          │ │              │
     └──────┬───────┘ └────┬─────┘ └──────┬───────┘
            │              │              │
            └──────────────┼──────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌────────────┐  ┌──────────────┐  ┌────────────────┐
   │ Query      │  │ Alert        │  │ Downsampling   │
   │ Engine     │  │ Evaluator    │  │ & Compaction   │
   │ (PromQL)   │  │ (rule eval)  │  │ (rollup)       │
   └─────┬──────┘  └──────┬───────┘  └────────────────┘
         │                │
         ▼                ▼
   ┌────────────┐  ┌──────────────┐
   │ Dashboard  │  │ Alert Router │
   │ (Grafana)  │  │ (dedup +     │
   │            │  │  routing)    │
   └────────────┘  └──┬───┬───┬──┘
                      │   │   │
                PagerDuty Slack Email
```

---

## 3. 資料收集模型：Pull vs Push

這是面試中 **第一個必須釐清的設計選擇**。

### Pull Model（拉取模型，Prometheus 風格）

```
Scraper 每 15 秒輪詢所有 targets：

  for target in service_discovery.get_targets():
      response = HTTP_GET(target.url + "/metrics")
      # 回傳格式：
      # http_requests_total{method="GET", status="200"} 12345
      # http_requests_total{method="POST", status="500"} 42
      parse_and_ingest(response)

Service Discovery 來源：
  - Kubernetes API：根據 Pod labels 自動發現 targets
  - Consul / etcd：服務註冊中心
  - DNS SRV records：靜態或動態解析
  - File-based：config 檔列出 target 清單
```

### Push Model（推送模型，StatsD / Datadog Agent 風格）

```
應用程式主動推送 metric：

  # Application code
  statsd_client.increment("api.request.count", tags=["endpoint:/users"])
  statsd_client.histogram("api.latency_ms", elapsed_ms, tags=["endpoint:/users"])

  # Agent 在本機 aggregate，每 10 秒 flush 到 collector
  Agent → HTTP POST → Ingestion Gateway
```

### Pull vs Push 比較

| 維度 | Pull (Prometheus) | Push (StatsD/Datadog) |
|------|-------------------|----------------------|
| 控制權 | 中心端控制 scrape 頻率 | 客戶端控制 emission 頻率 |
| Target 存活偵測 | Scrape 失敗 = target down（免費 health check） | 需要額外心跳機制偵測 target down |
| NAT / 防火牆 | 困難（scraper 必須能連到 target） | 容易（client 主動往外推） |
| 短期任務 (Short-lived jobs) | 可能在下次 scrape 前就結束 | 任務結束前推送最終結果 |
| 資料一致性 | 所有 target 在同一時間點被 scrape | 各 target 推送時間不同步 |
| 規模瓶頸 | Scraper fan-out（10K targets × 15s interval） | Ingestion gateway 吞吐量 |
| 典型代表 | Prometheus, VictoriaMetrics | Datadog Agent, StatsD, OTLP |

### 面試關鍵觀點

```
為什麼 Prometheus 選 Pull？
  1. Central control：一個地方決定 scrape 頻率，不用協調上千個 targets
  2. 免費 health check：scrape 失敗 = target 掛了，push model 需要額外機制
  3. 可重現性：scraper 可以隨時重新 scrape，debugging 更簡單

為什麼 Datadog 選 Push？
  1. SaaS 架構：客戶的 infra 在防火牆後面，Datadog 不可能 pull
  2. Agent 做 local aggregation：減少上傳資料量
  3. 支援 serverless / ephemeral workloads：Lambda 執行 200ms 就結束

實際系統常常混合使用：
  Prometheus scrape 長期服務 + Pushgateway 接收短期 jobs
  Datadog Agent 本機 pull（本機 exporter）+ push 到 Datadog SaaS
```

---

## 4. Metric 類型

| 類型 | 語義 | 使用場景 | 底層實作 |
|------|------|---------|---------|
| Counter | 只遞增的累計值 | Request count, error count, bytes sent | 用 `rate()` 計算每秒速率 |
| Gauge | 瞬時值，可上可下 | Memory usage, CPU %, active connections | 直接讀取當前值 |
| Histogram (直方圖) | 觀測值分布，預設 buckets | Latency (p50/p95/p99), request size | 記錄落入各 bucket 的 count |
| Summary | 客戶端計算 quantile | 類似 Histogram，但在 client 端算 | 不支援跨 instance 聚合 |

```
Histogram 範例（HTTP latency）：

  http_request_duration_seconds_bucket{le="0.01"}   2400   ← ≤ 10ms 的請求數
  http_request_duration_seconds_bucket{le="0.05"}   4200   ← ≤ 50ms
  http_request_duration_seconds_bucket{le="0.1"}    4800   ← ≤ 100ms
  http_request_duration_seconds_bucket{le="0.5"}    4950   ← ≤ 500ms
  http_request_duration_seconds_bucket{le="1.0"}    4990   ← ≤ 1s
  http_request_duration_seconds_bucket{le="+Inf"}   5000   ← 全部

  計算 p99：
    histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
    → 利用線性插值在 bucket 邊界之間估算

為什麼偏好 Histogram 而非 Summary？
  Histogram 可以跨 instance 聚合（把多台的 bucket counts 加起來）
  Summary 在 client 端算好 quantile，無法跨 instance 合併
  （p99 of averages ≠ average of p99s）
```

---

## 5. 時序資料庫 (TSDB) 架構

這是整個系統 **最核心的元件**，直接決定寫入吞吐量和查詢效率。

### 資料模型

```
每條 time series = metric_name + label set → [(timestamp, value), ...]

範例：
  http_requests_total{service="api", method="GET", status="200"}
    → [(1710000000, 12345), (1710000015, 12389), (1710000030, 12456), ...]

  一個 metric name 可以有成千上萬個 label combination（稱為 cardinality）

  例：http_requests_total × 50 services × 5 methods × 10 status codes
      = 2,500 unique time series（from one metric name）
```

### 寫入路徑

```
Data Point 到達 TSDB：
  1. 寫入 Write-Ahead Log (WAL)（磁碟，保證持久性）
  2. 寫入 In-Memory Buffer（Active Head Block）
  3. 當 buffer 滿或超過 2 小時 → flush 成 immutable block on disk
  4. Background compaction 合併小 block 為大 block

┌─────────────────────────────────────────────┐
│                 TSDB Instance                │
│                                             │
│  WAL ──────────────────────────────────     │
│  │ (append-only, sequential write)         │
│  │                                         │
│  ▼                                         │
│  Head Block (in-memory)                     │
│  │ ~2h of data, mmap-friendly              │
│  │                                         │
│  ▼ flush                                   │
│  Block 1   Block 2   Block 3  ...          │
│  [0h-2h]   [2h-4h]   [4h-6h]              │
│  (immutable, compressed on disk)            │
│                                             │
│  ▼ compact                                  │
│  Block A [0h-6h]  Block B [6h-12h]          │
│  (merged, larger, more compressed)          │
└─────────────────────────────────────────────┘
```

### 壓縮：Gorilla Paper（Facebook, 2015）

```
原始一個 data point = timestamp (8 bytes) + value (8 bytes) = 16 bytes

Gorilla 壓縮：
  Timestamp：Delta-of-Delta encoding
    時間戳通常等間隔（15s），delta 幾乎是常數
    delta-of-delta 大部分是 0 → 用 1 bit 表示
    壓縮率：8 bytes → ~1-2 bits per timestamp

  Value：XOR encoding
    連續的 float64 值變化不大（CPU 50.1% → 50.3%）
    XOR 前後兩個值 → 大量 leading/trailing zeros → 變長編碼
    壓縮率：8 bytes → ~1-2 bits per value（最佳情況）

實測壓縮效果：
  原始：16 bytes/sample
  壓縮後：平均 ~1.37 bytes/sample
  壓縮比：~12x

  30M series × 1 point/15s × 86400s/day × 1.37 bytes
  = ~237 GB/day（壓縮後）

  如果用原始格式：
  30M × 5760 points/day × 16 bytes = ~2.76 TB/day
```

### 為什麼不用 SQL DB？

```
PostgreSQL 寫入 benchmark：
  單節點 ~50K inserts/sec（optimized, batched）

需求：2M data points/sec

差距：40x shortfall → 即使 40 個 PostgreSQL 節點也勉強

TSDB 優勢：
  1. Append-only sequential writes → SSD 可達 500K-1M writes/sec per node
  2. 列式儲存：同一 metric 的值連續存放 → 壓縮效率極高
  3. 時間分區（Block per 2h）→ 刪除舊資料 = 刪除整個 block（O(1)）
  4. 專用 index：inverted index on labels → 快速查 {service="api"} 的所有 series
```

### Sharding 策略

```
按 metric label hash 做 consistent hashing：
  shard_id = hash(metric_name + sorted_labels) % N

30M series / 10 shards = 3M series per shard
每 shard ~200K writes/sec → 單節點可承受

跨 shard 查詢（scatter-gather）：
  Query Engine → fan-out 到所有相關 shards → merge 結果
  例：sum(rate(http_requests_total[5m])) by (service)
  → 每個 shard 返回 partial sum → Query Engine 做 final aggregation
```

---

## 6. 降精度與保留策略 (Downsampling & Retention)

```
目標：保留長期趨勢，但不耗費天文數字的儲存

保留策略：
  ┌────────────────────────────────────────────────────────────┐
  │ Resolution  │ Retention │ Storage per 30M series          │
  ├─────────────┼───────────┼─────────────────────────────────┤
  │ Raw (15s)   │ 15 days   │ 15 × 237 GB = ~3.5 TB          │
  │ 5-min rollup│ 90 days   │ 90 × (237/20) GB = ~1.07 TB    │
  │ 1-hr rollup │ 1 year    │ 365 × (237/240) GB = ~360 GB   │
  └────────────────────────────────────────────────────────────┘

  總儲存：~5 TB（vs 原始保留 1 年 = 86 TB）
  → 儲存節省 ~17x

Rollup 聚合：
  每個 5-min window 保存 5 個值：min, max, avg, count, sum
  → 可以從 rollup 重建：
    - avg latency = sum / count
    - 趨勢圖用 avg
    - Alert threshold 用 max（不遺漏 spike）

Rollup Job：
  Background worker 每小時執行：
    1. 讀取上一個小時的 raw data
    2. 每 5-min window 計算 min/max/avg/count/sum
    3. 寫入 rollup storage
    4. Raw data 到 15 天自動 TTL 過期刪除
```

---

## 7. 查詢引擎

### PromQL 風格查詢語言

```
基本查詢：
  http_requests_total{service="api", status="500"}
  → 選出所有匹配 label 的 time series

速率計算：
  rate(http_requests_total{status="500"}[5m])
  → 過去 5 分鐘的每秒速率（counter 差值 / 時間）

聚合：
  sum(rate(http_requests_total[5m])) by (service)
  → 按 service 分組加總 → 每個 service 的總 QPS

分位數：
  histogram_quantile(0.99, sum(rate(http_request_duration_bucket[5m])) by (le))
  → 全局 p99 latency
```

### 查詢執行流程

```
Dashboard 查詢：sum(rate(http_requests_total[5m])) by (service)

1. Query Parser：解析 PromQL → AST

2. Series Selection：
   → 查 inverted index：label "service" 有哪些 series？
   → 交集過濾：返回匹配的 series ID list

3. Data Fetch（scatter-gather）：
   → Query Engine 對每個 TSDB shard 發 sub-query
   → 每個 shard 返回 [series_id → [(t1,v1), (t2,v2), ...]]
   → 平行 fan-out，latency = max(shard latencies)

4. Function Evaluation：
   → 對每個 series 計算 rate()：(v_last - v_first) / (t_last - t_first)
   → 按 service label 分組 sum

5. Return Result → Dashboard 渲染

查詢優化：
  - Query Result Cache：相同 query + 相同時間區間 → cache hit
  - Step alignment：Dashboard 每 30s refresh，query 的 step 對齊到 15s 邊界
  - Partial response：timeout 時返回已取得的部分結果（降級但不 block）
```

### 高基數 (High Cardinality) 問題

```
危險模式：把 user_id 或 request_id 當 label
  http_requests_total{user_id="12345"} → 每個 user 一條 series
  100M users = 100M time series → TSDB 爆炸

為什麼 high cardinality 致命？
  1. Inverted index 膨脹（每個 label value 一個 posting list）
  2. 記憶體中活躍 series 太多（每個 series 佔 ~1-2 KB in-memory）
  3. 查詢掃描量暴增

解法：
  - 限制 label cardinality < 10K per label
  - 高 cardinality 資料改用 Logs 或 Traces（不是 Metrics 的職責）
  - Ingestion gateway 做 cardinality limiting（自動 drop 超限的 series）
```

---

## 8. 告警管線 (Alerting Pipeline)

### Alert Rule 定義

```yaml
# 範例：API 500 error rate > 1% 持續 5 分鐘
- alert: HighErrorRate
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    /
    sum(rate(http_requests_total[5m]))
    > 0.01
  for: 5m           # PENDING 持續 5 分鐘才 FIRING
  labels:
    severity: critical
  annotations:
    summary: "API error rate is {{ $value | humanizePercentage }}"
```

### Alert 狀態機

```
          expr 首次為 true
INACTIVE ──────────────────▶ PENDING
                              │
                              │ for 持續時間達標（5m）
                              ▼
                            FIRING ──────▶ Notification
                              │
                              │ expr 恢復為 false
                              ▼
                           RESOLVED ──────▶ Recovery Notification
                              │
                              │ 清除
                              ▼
                           INACTIVE

為什麼需要 PENDING 階段？
  → 避免短暫 spike 觸發告警（網路抖動導致 1 個 scrape 異常 ≠ 真正的 incident）
  → for: 5m 表示連續 5 分鐘超過 threshold 才正式告警
  → Trade-off：for 太短 → false positive 多；for 太長 → 漏報延遲長
```

### Alert 去重與路由

```
Alert Deduplication：
  同一組 labels 的 alert 只觸發一次，不重複通知
  groupBy: [service, alertname]
  → 同 service 同 alert 歸為一組 → 一封通知含所有 instances

Notification Routing：
  ┌────────────────────────────────────────┐
  │ severity: critical → PagerDuty（立即 page on-call）
  │ severity: warning  → Slack #alerts（工作時間通知）
  │ severity: info     → Dashboard 標記（不主動通知）
  └────────────────────────────────────────┘

Alert Fatigue 防治：
  1. Inhibition（抑制）：父告警觸發時抑制子告警
     - 例：node_down 觸發 → 抑制該 node 上所有 service 的 alert
  2. Silence（靜默）：maintenance window 期間暫停特定 alert
  3. Rate limiting：同一 group 每 5 分鐘最多通知一次
  4. Auto-resolve：恢復後自動發 RESOLVED 通知
```

---

## 9. 分散式追蹤 (Distributed Tracing)

```
Trace = 一個請求跨多個服務的完整路徑

               Trace ID: abc-123
  ┌──────────────────────────────────────────────────┐
  │ API Gateway (span 1)        [0ms ─── 120ms]     │
  │   ├─ Auth Service (span 2)  [5ms ── 20ms]       │
  │   ├─ User Service (span 3)  [25ms ── 80ms]      │
  │   │   └─ DB Query (span 4)  [30ms ── 75ms]      │
  │   └─ Cache Lookup (span 5)  [85ms ── 90ms]      │
  └──────────────────────────────────────────────────┘

Trace ID 傳播：
  HTTP Header: X-Trace-Id: abc-123
  每個服務收到 header → 建立 child span → 帶同個 Trace ID 繼續傳遞
  → span 包含：trace_id, span_id, parent_span_id, start_time, duration, tags
```

### 取樣策略 (Sampling)

```
全量儲存 trace 不現實：
  100K RPS × 5 spans/request × 500 bytes/span = 250 MB/sec = 21 TB/day

Head-based Sampling（入口決定）：
  在 API Gateway 決定：hash(trace_id) % 100 < 1 → 取樣 1%
  優點：簡單，所有服務都知道是否取樣
  缺點：可能漏掉有趣的 trace（error trace 也只有 1% 被保留）

Tail-based Sampling（看完整 trace 後決定）：
  收集所有 spans → buffer 30 秒 → 組裝完整 trace → 決定保留或丟棄
  保留規則：duration > 2s、含 error span、或特定 service 觸發
  優點：100% 保留異常 trace
  缺點：需要 buffer 所有 spans，記憶體需求大（100K RPS × 30s = 3M traces in buffer）

實務做法：Head-based 1% 保底 + Tail-based 保留 100% 異常 trace
```

### Trace 儲存

```
儲存選項：
  - Elasticsearch：全文搜尋友好，但寫入吞吐量受限
  - Grafana Tempo：Object Storage (S3) 後端，成本低，依賴 trace ID 查詢
  - ClickHouse：列式 DB，適合分析型查詢（按 service/operation 聚合）

典型查詢：
  - 按 trace ID 查完整路徑
  - 按 service + operation 查 p99 latency
  - 按 error tag 查失敗 trace
```

---

## 10. 日誌聚合 (Log Aggregation)

```
日誌管線架構：

  App → stdout/stderr
    │
    ▼
  Log Agent（Fluentd / Vector / Filebeat）
  - 收集、解析、結構化
  - Tail log files 或 read from stdout
    │
    ▼
  Kafka（Buffer + Decouple）
  - Topic per service or per log level
  - 解耦生產者與消費者速度差異
    │
    ▼
  Indexer / Processor
  - Parse JSON / regex
  - Enrich：加上 K8s metadata（pod, namespace, node）
  - Filter：丟棄 DEBUG level in production
    │
    ▼
  Storage（Elasticsearch / ClickHouse / Loki）
  - Elasticsearch：Inverted index，全文搜尋，但儲存成本高
  - ClickHouse：列式壓縮，query 快，但不擅長全文搜尋
  - Loki：只 index labels（不 index log content），儲存極便宜
```

### 結構化日誌 vs 非結構化

```
非結構化：
  "2024-03-15 10:23:45 ERROR Failed to process payment for user 12345, amount=99.99"
  → 需要 regex 解析 → 脆弱、慢

結構化 (JSON)：
  {"ts":"2024-03-15T10:23:45Z", "level":"ERROR", "service":"payment",
   "msg":"Failed to process payment", "user_id":12345, "amount":99.99,
   "trace_id":"abc-123"}
  → 可直接 index 每個欄位 → 查詢快、關聯方便
  → trace_id 欄位串聯 Metrics → Traces → Logs（三大支柱互通的關鍵）
```

### 日誌量管理

```
典型規模：
  100K hosts × 平均 1 KB/sec per host = 100 MB/sec = 8.6 TB/day

控制策略：
  1. Log Level 控制：Production 只記 INFO+，DEBUG 用 dynamic flag 臨時開啟
  2. Sampling：高流量 path 只記 1% 的 access log
  3. Retention：Hot (7 days, SSD) → Warm (30 days, HDD) → Cold (1 year, S3)
  4. 成本對比：
     - Elasticsearch：~$25/GB/month（indexed, SSD）
     - S3 cold storage：~$0.004/GB/month
     - 差距 6000x → 只有近期需要 full-text search 的資料放 Elasticsearch
```

---

## 11. Dashboard 與視覺化

```
Dashboard 查詢模式：
  - 一個 dashboard 有 10-30 個 panel
  - 每個 panel = 一個 PromQL query
  - Auto-refresh 每 30 秒 → 30 panels × 500K active dashboards / 30s = ~500K queries/min

Pre-computed vs On-demand：
  ┌─────────────────┬─────────────────────┬──────────────────────────┐
  │                 │ Pre-computed         │ On-demand                │
  ├─────────────────┼─────────────────────┼──────────────────────────┤
  │ 方式            │ Recording rules 定期 │ 每次 refresh 即時查      │
  │                 │ 計算並儲存結果       │                          │
  │ Latency         │ < 10ms（讀 pre-stored）│ 50-500ms（看 series 量）│
  │ Freshness       │ Rule interval（通常 1m）│ Real-time               │
  │ 適用場景        │ 高流量 dashboard      │ Ad-hoc 探索性查詢        │
  │ 成本            │ 額外 series 儲存      │ 查詢時 CPU 消耗          │
  └─────────────────┴─────────────────────┴──────────────────────────┘

Recording Rules 範例：
  # 每分鐘預計算，儲存為新 series
  - record: job:http_requests:rate5m
    expr: sum(rate(http_requests_total[5m])) by (job)
  → Dashboard 查 job:http_requests:rate5m 而非原始 expr → 快 10-100x

Query Result Cache：
  Cache key = hash(query_string + start_time + end_time + step)
  TTL = step interval（30s query → cache 30s）
  同一 dashboard 多人同時看 → cache hit rate 高達 70-90%
```

---

## 12. 容量估算

| 指標 | 估算 |
|------|------|
| 監控主機數 | 100K hosts |
| Active time series | 30M series |
| 寫入速率 | 30M / 15s = **~2M data points/sec** |
| 每日原始資料量（壓縮後） | 2M × 86400 × 1.37 bytes = **~237 GB/day** |
| 每日原始資料量（未壓縮） | 2M × 86400 × 16 bytes = **~2.76 TB/day** |
| 15 天原始保留 | 237 GB × 15 = **~3.5 TB** |
| 1 年含 rollup 總儲存 | **~5 TB** |
| TSDB 節點數（寫入） | 2M / 200K per node = **~10 nodes** |
| Query QPS（高峰） | **~500K queries/min** |
| Alert rules | ~1M rules, evaluate every 60s |
| Log 日增量 | **~8.6 TB/day** (100K hosts × 1 KB/s) |
| Trace 日增量（1% 取樣後） | **~2.16 TB/day** |

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 收集模型 | **Hybrid（Pull 為主 + Push for short-lived jobs）** | Pull 提供 centralized control + 免費 health check；Push 解決 NAT 和短期任務 |
| 時序壓縮 | **Gorilla（Delta-of-Delta + XOR）** | 12x 壓縮比，1.37 bytes/sample，大幅降低儲存和 I/O |
| 儲存引擎 | **專用 TSDB（非 SQL DB）** | Sequential append + 列式壓縮 + 時間分區 → 2M writes/sec 遠超 RDBMS |
| 降精度 | **分層 rollup（15s → 5min → 1h）** | 長期趨勢不需要 15s 精度，儲存節省 17x |
| Alert 延遲 vs 誤報 | **PENDING 等待期（for: 5m）** | 避免短暫抖動觸發 false alarm，trade-off 是偵測延遲增加 5 分鐘 |
| High cardinality | **Labels cardinality < 10K，高 cardinality 用 Logs/Traces** | Metrics 為聚合而生，不該存 per-request / per-user 粒度 |
| Trace 取樣 | **Head-based 1% + Tail-based 100% 異常** | 控制成本同時確保所有 error traces 被捕獲 |
| Log 儲存 | **Hot (ES) → Warm (HDD) → Cold (S3)** | 全放 Elasticsearch 太貴（$25/GB vs $0.004/GB），分層節省 6000x |
| Dashboard 查詢 | **Recording rules 預計算熱門查詢** | 高頻 dashboard 直接讀預計算結果，query latency 從 500ms → 10ms |

---

## 14. 面試常見 Follow-up

### Q: 如何處理 metric cardinality explosion？

```
場景：有人加了 user_id 作為 label → 一夜之間 series 從 30M 爆到 300M

防禦措施：
  1. Ingestion Gateway 設 per-metric cardinality limit（例如每個 metric 最多 10K series）
  2. 超限時自動 drop 或 aggregate（把 high-cardinality label 移除）
  3. CI/CD pipeline 檢查：新增 metric 時驗證 label 設計
  4. 監控 "活躍 series 數" 本身（meta-monitoring）
     → 設 alert：active_series > 50M → 有人可能搞砸了
```

### Q: 單一 TSDB 節點掛了怎麼辦？

```
寫入端：
  - WAL 保證 crash recovery（重啟後 replay WAL 恢復 in-memory state）
  - Replication：每條 data point 寫 2-3 個 replica（Thanos / Cortex 做法）
  - 一個 replica 掛 → 其他 replica 繼續服務讀寫

查詢端：
  - Query Engine fan-out 所有 replica → 取第一個回應（or merge）
  - 短暫資料缺失 → 查詢返回 partial data + warning flag

長期儲存：
  - Compact 後的 block 上傳到 Object Storage（S3）
  - S3 天然 11 個 9 的 durability → 不怕磁碟壞
```

### Q: 怎麼監控「監控系統本身」？

```
Meta-monitoring（監控系統的監控）：
  1. 獨立的小型 Prometheus 監控主 Prometheus cluster 的 health
  2. 監控指標：scrape duration, WAL size, query latency, ingestion rate
  3. 這個 meta-monitor 盡量簡單（單節點 + 本地儲存），降低故障連鎖風險
  4. Dead man's switch：
     → 一個永遠為 true 的 alert rule
     → 如果 alert 沒有按時觸發 → 說明 alerting pipeline 自己掛了
     → 外部服務（Deadman Snitch / PagerDuty Heartbeat）偵測到缺失 → 通知
```

### Q: 如何從 Metrics 關聯到 Logs 和 Traces？

```
三大支柱的串聯（Correlation）：

  1. Metrics alert 觸發：error_rate > 1% on service="payment"
  2. 點進 Dashboard → 看到是 status=500 暴增
  3. 點 "View Traces" → 過濾 service=payment, error=true, 時間範圍 = alert 時段
     → 看到具體哪個 endpoint、哪個 downstream service 慢
  4. 點 span → "View Logs" → 用 trace_id 查該請求的完整 log
     → 看到 "Connection refused to payments-db:5432"

關鍵：統一 metadata
  - 所有三種資料都帶 service, environment, pod, trace_id
  - Exemplar：Metrics data point 附帶一個 trace_id sample
    → 從 metric 直接跳到對應的 trace（Prometheus 原生支援）
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 規模估算**（2 分鐘）— 三大支柱定義、聚焦 Metrics、估算 series 數量和寫入 QPS（30M series, 2M points/sec）
2. **資料收集 Pull vs Push**（2 分鐘）— 說明兩者 trade-off，推導出 hybrid 方案，展示 service discovery 機制
3. **TSDB 核心設計**（4 分鐘）— data model、write path（WAL → head block → flush → compact）、Gorilla 壓縮（12x）、為什麼不用 SQL DB
4. **降精度策略**（1 分鐘）— 分層 rollup、storage 計算、TTL 管理
5. **查詢引擎**（2 分鐘）— PromQL 範例、scatter-gather fan-out、recording rules 預計算、high cardinality 問題
6. **告警管線**（2 分鐘）— PENDING → FIRING → RESOLVED 狀態機、dedup + routing、alert fatigue 防治
7. **Deep Dive（面試官選）**（2 分鐘）— Distributed tracing 取樣策略、Log aggregation 分層儲存、三大支柱串聯
