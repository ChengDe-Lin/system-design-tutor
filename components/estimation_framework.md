# Back-of-the-Envelope Estimation Framework

## 1. 為什麼估算重要

在 System Design 面試或真實架構設計中，粗略估算 (Back-of-the-Envelope Estimation) 是驗證設計可行性的第一道防線。它的價值在於：

1. **在寫任何程式碼之前驗證架構**：如果估算出每秒需要處理 1M 寫入，卻打算用單台 PostgreSQL 撐，那這個設計從一開始就不成立。估算讓你在白板階段就發現瓶頸。
2. **面試信號**：展現你對規模的直覺。面試官想看到的是：你不只會畫框圖，你知道每個框裡的數字量級。
3. **精度目標：數量級正確即可**。差 2 倍可以接受，差 10 倍就是紅旗。你說 "大約 10K QPS" 和實際的 17K QPS 都沒問題；你說 "大約 100 QPS" 就有問題了。

```
✓ 正確的精度水準：  "大約 10K QPS"   (實際 17K → 差 1.7x，OK)
✗ 危險的偏差：      "大約 100 QPS"   (實際 17K → 差 170x，架構決策會完全錯誤)
```

---

## 2. 估算框架：六步驟流程

每次估算都遵循這個流程。不要跳步驟——每一步的輸出是下一步的輸入。

```
┌─────────────────────────────────────────────────────────┐
│  Step 1: 釐清規模 (Clarify Scale)                        │
│    DAU, 峰值乘數 (Peak Multiplier), 讀寫比 (R:W Ratio)   │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 2: QPS 計算 (Throughput)                           │
│    DAU → requests/day → avg QPS → peak QPS              │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 3: 儲存估算 (Storage)                               │
│    資料模型 × 資料量 × 保留期限                              │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 4: 頻寬估算 (Bandwidth)                             │
│    QPS × 平均 payload 大小                                │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 5: 記憶體估算 (Memory / Cache)                      │
│    工作集大小 (Working Set)，80/20 法則                     │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Step 6: 機器數估算 (Machine Count)                       │
│    Peak QPS ÷ 單機吞吐量                                  │
└─────────────────────────────────────────────────────────┘
```

### Step 1: 釐清規模

面試中第一件事就是問清楚或假設合理的數字：

| 參數 | 說明 | 常見範圍 |
|------|------|---------|
| **DAU** (Daily Active Users) | 日活躍用戶數 | 小型 app: 100K, 中型: 10M, 大型: 100M-1B |
| **Peak Multiplier** | 峰值 QPS 相對平均 QPS 的倍數 | 一般 2-3x；促銷活動 5-10x |
| **Read:Write Ratio** | 讀寫比 | 社群媒體 100:1, 電商 10:1, 聊天 1:1 |
| **Actions per User** | 每個用戶每天的操作次數 | 依業務場景定義 |

### Step 2: QPS 計算

**公式**：

```
Average QPS = DAU × actions_per_user_per_day / 86,400
Peak QPS    = Average QPS × peak_multiplier
```

**範例：社群媒體的寫入 QPS**

```
DAU               = 300M
Posts per user/day = 2
Average Write QPS  = 300M × 2 / 86,400
                   ≈ 300M × 2 / 100K       ← 86,400 ≈ 10^5，直接用 100K 近似
                   = 600M / 100K
                   = 6,000 QPS
Peak Write QPS     = 6K × 3 = 18K QPS
```

### Step 3: 儲存估算

**公式**：

```
Daily Storage  = new_items_per_day × average_item_size
Yearly Storage = Daily Storage × 365
Total Storage  = Yearly Storage × retention_years × replication_factor
```

**範例：文字貼文儲存**

```
New posts/day   = 300M users × 2 posts = 600M posts
Avg post size   = 500 bytes (text + metadata)
Daily storage   = 600M × 500B = 300 GB/day
Yearly storage  = 300 GB × 365 ≈ 110 TB/year
5-year + 3x replication = 110 TB × 5 × 3 = 1.65 PB
```

### Step 4: 頻寬估算

**公式**：

```
Bandwidth = QPS × average_response_size
```

**範例：讀取頻寬**

```
Read QPS              = 350K
Average response size = 10 KB (JSON payload)
Bandwidth             = 350K × 10 KB = 3.5 GB/s = 28 Gbps
```

> **注意 MB vs Mb**：1 **B**yte = 8 **b**its。3.5 GB/s = 3.5 × 8 = 28 Gbps。在面試中務必區分大寫 B (Bytes) 和小寫 b (bits)。

### Step 5: 記憶體估算（Cache 大小）

**80/20 法則 (Pareto Principle)**：80% 的請求集中在 20% 的資料上。因此只需快取最熱門的 20% 資料。

**公式**：

```
Daily unique requests    = total_daily_reads / avg_reads_per_item
Hot items (20%)          = unique_items × 0.2
Cache size               = hot_items × avg_item_size
```

**範例**：

```
Daily read requests = 30B
Avg reads per item  = 5
Unique items/day    = 30B / 5 = 6B items
Hot items (20%)     = 6B × 0.2 = 1.2B items
Avg item size       = 1 KB
Cache needed        = 1.2B × 1 KB = 1.2 TB
Redis nodes         = 1.2 TB / 100 GB per node ≈ 12 nodes
```

### Step 6: 機器數估算

**公式**：

```
Machines = Peak QPS / throughput_per_machine
```

**範例：Web Server 數量**

```
Peak QPS              = 100K
Single server capacity = 5K req/s (with business logic)
Machines needed       = 100K / 5K = 20 servers
加上冗餘 (headroom)    ≈ 25-30 servers
```

**範例：資料庫節點**

```
Peak Write QPS        = 18K
Single MySQL capacity = 15K writes/s
MySQL masters needed  = 18K / 15K ≈ 2 masters (sharded)
Read replicas         = 3 per master = 6 replicas
```

---

## 3. 必須記住的關鍵數字

### 2 的冪次 (Powers of 2)

| 次方 | 精確值 | 近似值 | 名稱 |
|------|--------|--------|------|
| 2^10 | 1,024 | ~1 千 (1K) | Kilo |
| 2^20 | 1,048,576 | ~1 百萬 (1M) | Mega |
| 2^30 | 1,073,741,824 | ~10 億 (1G) | Giga |
| 2^40 | 1,099,511,627,776 | ~1 兆 (1T) | Tera |
| 2^50 | — | ~1P | Peta |

### 時間轉換

| 單位 | 秒數 | 近似值 |
|------|------|--------|
| 1 小時 | 3,600 | ~3.6K |
| 1 天 | 86,400 | **≈ 10^5** (最常用！) |
| 1 個月 | 2,592,000 | ≈ 2.5M |
| 1 年 | 31,536,000 | **≈ 3 × 10^7** |

> **關鍵記憶法**：1 天 ≈ 10^5 秒。這是估算 QPS 的核心換算。

### 資料大小參考

| 資料型別 | 大小 | 說明 |
|----------|------|------|
| ASCII 字元 | 1 byte | 英文字母、數字 |
| UTF-8 CJK 字元 | 3 bytes | 中日韓文字 |
| UUID | 16 bytes | 128-bit，常用作 primary key |
| Timestamp (Unix epoch) | 8 bytes | int64 |
| int64 | 8 bytes | — |
| int32 | 4 bytes | — |
| IPv4 | 4 bytes | — |
| IPv6 | 16 bytes | — |
| MD5 hash | 16 bytes | 128-bit |
| SHA-256 hash | 32 bytes | 256-bit |
| 一條 tweet (140 字 UTF-8) | ~280 bytes | 純文字，不含 metadata |
| 一張壓縮圖片 (中等品質) | 200-500 KB | JPEG |
| 一分鐘 720p 影片 | ~50 MB | H.264 編碼 |
| 一分鐘 1080p 影片 | ~150 MB | H.264 編碼 |

### 延遲數字 (Latency Numbers)

| 操作 | 延遲 | 備註 |
|------|------|------|
| L1 cache 存取 | 0.5 ns | CPU 暫存器旁邊 |
| L2 cache 存取 | 7 ns | |
| Main memory 存取 | 100 ns | |
| SSD 隨機讀取 | 150 μs | = 150,000 ns |
| HDD 隨機讀取 | 10 ms | = 10,000,000 ns，比 SSD 慢 ~67x |
| Network RTT (同機房) | 0.5 ms | Intra-DC |
| Network RTT (跨地區) | 50-150 ms | Cross-region |
| Sequential disk read 1 MB | 1 ms (SSD) / 20 ms (HDD) | |
| Disk seek | 10 ms (HDD) | |

**直覺記憶法**：

```
Memory 是 SSD 的 ~1500 倍快        (100 ns vs 150 μs)
SSD 是 HDD 的 ~67 倍快             (150 μs vs 10 ms)
同機房 network 是跨區域的 ~100 倍快  (0.5 ms vs 50-150 ms)
```

### 吞吐量錨點 (Throughput Anchors)

| 元件 | 吞吐量 | 備註 |
|------|--------|------|
| **MySQL / PostgreSQL** (單機) | 10K-30K writes/s, 50K reads/s | 取決於 row size、index 數量、query 複雜度 |
| **Redis** (單執行緒) | 100K ops/s | Simple GET/SET；pipeline 可達 1M+ |
| **Kafka** (單 partition) | ~10 MB/s, ~100K msgs/s | Consumer throughput 通常更高 |
| **Single Web Server** | 1K-10K req/s | 取決於 computation weight (CPU-bound vs I/O-bound) |
| **CDN Edge PoP** | ~100K req/s per PoP | Static content serving |
| **Nginx (reverse proxy)** | 50K-100K req/s | 僅做 proxy forwarding，不含 business logic |
| **gRPC / HTTP/2** | 比 HTTP/1.1 高 2-5x | 多工 (multiplexing)、header 壓縮 |
| **10 Gbps NIC** | ~1.2 GB/s 實際吞吐 | 理論 10 Gbps，實際約 80-90% |

---

## 4. 常見估算模式 (Common Patterns)

### Pattern A: 社群媒體 QPS 估算

```
已知條件：
  DAU = 300M
  每用戶每天：5 posts + 100 reads
  Peak multiplier = 3x

寫入 QPS：
  Average Write QPS = 300M × 5 / 86,400
                    ≈ 1.5B / 100K
                    ≈ 15K (實際 17,361，差 1.15x，可接受)
  Peak Write QPS   = 15K × 3 = 45K

讀取 QPS：
  Average Read QPS  = 300M × 100 / 86,400
                    ≈ 30B / 100K
                    ≈ 300K (實際 347,222，差 1.15x)
  Peak Read QPS    = 300K × 3 = 900K ≈ 1M

結論：
  寫入 peak ~50K QPS → 單台 MySQL 撐不住 (上限 ~30K)，需要 sharding
  讀取 peak ~1M QPS  → 需要 cache layer (Redis) + read replicas
```

### Pattern B: 儲存增長估算

```
已知條件：
  每天新增 posts = 500M
  文字 post 平均大小 = 500 bytes
  20% 的 post 帶圖片，平均圖片大小 = 200 KB

文字儲存：
  Daily  = 500M × 500 B = 250 GB/day
  Yearly = 250 GB × 365 ≈ 91 TB/year ≈ 90 TB/year

圖片儲存：
  Daily  = 500M × 20% × 200 KB = 100M × 200 KB = 20 TB/day
  Yearly = 20 TB × 365 = 7.3 PB/year ≈ 7 PB/year

5 年 + 3x replication：
  文字：90 TB × 5 × 3 = 1.35 PB
  圖片：7 PB × 5 × 3  = 105 PB

結論：
  圖片儲存是文字的 ~80 倍。任何有 media 的系統，儲存設計的重心都在 media 上。
  文字資料用 sharded DB 即可；圖片必須用 object storage (S3) + CDN。
```

### Pattern C: Cache 大小估算 (80/20 法則)

```
已知條件：
  Daily read requests = 30B
  平均每個 item 被讀 5 次
  平均 item 大小 = 1 KB

計算：
  Unique items/day    = 30B / 5 = 6B items
  Hot items (20%)     = 6B × 0.2 = 1.2B items
  Cache size needed   = 1.2B × 1 KB = 1.2 TB

部署：
  Redis 單機建議 < 100 GB (避免 fork() overhead)
  Nodes needed = 1.2 TB / 100 GB = 12 nodes
  加上 replicas (每個 master 配 1 replica) = 24 nodes total
```

### Pattern D: 頻寬估算

```
已知條件：
  Read QPS = 350K
  平均 response size = 10 KB

出站頻寬 (Egress Bandwidth)：
  Bandwidth = 350K × 10 KB = 3.5 GB/s

轉換為 bits：
  3.5 GB/s × 8 = 28 Gbps

部署：
  10 Gbps NIC 實際吞吐 ~1.2 GB/s
  NICs needed = 3.5 GB/s / 1.2 GB/s ≈ 3 NICs (或 3 台以上的 load-balanced servers)
  → 或者用 CDN 分擔 static content
```

---

## 5. 完整範例 (Worked Examples)

### 範例 1：URL Shortener (簡單)

**需求**：設計一個類似 bit.ly 的短網址服務。

```
=== Step 1: 釐清規模 ===
  DAU             = 100M
  每用戶每天建立  = 0.1 個短網址 (大部分人只是讀取)
  每用戶每天點擊  = 5 個短網址
  Read:Write ratio = 50:1
  保留期限        = 10 年

=== Step 2: QPS ===
  Write QPS (建立短網址):
    = 100M × 0.1 / 86,400
    ≈ 10M / 100K
    = 100 QPS
    Peak = 100 × 3 = 300 QPS   ← 非常低，單機 DB 輕鬆搞定

  Read QPS (重導向):
    = 100M × 5 / 86,400
    ≈ 500M / 100K
    = 5,000 QPS
    Peak = 5K × 3 = 15K QPS    ← 中等，需要 cache

=== Step 3: 儲存 ===
  每筆 URL record:
    - short_code: 7 bytes (Base62, 7 字元)
    - long_url:   平均 100 bytes
    - created_at: 8 bytes
    - user_id:    8 bytes
    - 合計:       ~128 bytes ≈ 130 bytes

  New records/day = 100M × 0.1 = 10M
  Daily storage   = 10M × 130 B = 1.3 GB/day
  10 年           = 1.3 GB × 365 × 10 ≈ 4.7 TB
  加 3x replication = ~15 TB

  結論：15 TB 在一個 sharded DB cluster 中完全可行。

=== Step 4: 頻寬 ===
  Read bandwidth  = 15K × 130 B = 1.95 MB/s ≈ 2 MB/s ← 微不足道
  結論：頻寬完全不是瓶頸。

=== Step 5: Cache ===
  80/20 rule：20% 的短網址佔了 80% 的流量
  Daily unique reads = 5K QPS × 86,400 / avg 10 reads per URL ≈ 43M unique URLs
  Hot URLs (20%)     = 43M × 0.2 = 8.6M
  Cache size         = 8.6M × 130 B ≈ 1.1 GB ← 一台 Redis 綽綽有餘

=== Step 6: 機器 ===
  Web servers: 15K QPS / 5K per server = 3 servers (+ 2 備援 = 5)
  DB:          1 master + 2 read replicas 足夠
  Cache:       1 Redis node

=== 架構摘要 ===
  URL Shortener 是一個 read-heavy、低寫入量的系統。
  瓶頸不在 storage 或 bandwidth，而在 read latency → 用 cache 解決。
  規模相對小，不需要複雜的分散式架構。
```

### 範例 2：Twitter 級別估算 (中等)

**需求**：設計類似 Twitter 的社群媒體平台。

```
=== Step 1: 釐清規模 ===
  DAU             = 300M
  每用戶每天：2 tweets, 50 home timeline 刷新
  每次 home timeline = 20 tweets
  Avg followers per user = 200 (power-law distribution)
  保留期限        = 永久

=== Step 2: QPS ===
  Tweet 寫入：
    Write QPS = 300M × 2 / 86,400 ≈ 600M / 100K = 6K QPS
    Peak      = 6K × 5 = 30K QPS (重大事件時 spike 更高)

  Timeline 讀取：
    Read QPS  = 300M × 50 / 86,400 ≈ 15B / 100K = 150K QPS
    Peak      = 150K × 3 = 450K QPS

  Fan-out 寫入 (pre-computed timeline):
    每條 tweet 需要寫入到所有 follower 的 timeline cache
    Fan-out QPS = 6K × 200 avg followers = 1.2M writes/s to cache
    Peak        = 1.2M × 5 = 6M writes/s

  結論：Fan-out 的 cache 寫入量是最大的瓶頸。
        名人帳號 (1M+ followers) 不能用 fan-out-on-write，需要 fan-out-on-read。

=== Step 3: 儲存 ===
  Tweet storage:
    - tweet_id:    8 bytes
    - user_id:     8 bytes
    - content:     280 bytes (140 CJK chars × 2 or 280 ASCII)
    - timestamp:   8 bytes
    - metadata:    ~100 bytes (like count, retweet count, lang, etc.)
    - 合計:        ~400 bytes

    Daily   = 300M × 2 × 400 B = 240 GB/day
    Yearly  = 240 GB × 365 ≈ 88 TB/year
    5 年    = 440 TB

  Media (20% 帶圖片):
    120M tweets/day with image × 200 KB = 24 TB/day
    Yearly  = 24 TB × 365 = 8.76 PB/year

  Timeline cache (pre-computed):
    每個 user 快取最近 800 tweets 的 tweet_id (8 bytes each)
    Cache size = 300M × 800 × 8 B = 1.92 TB
    → 分散在 ~20 Redis nodes

=== Step 4: 頻寬 ===
  Timeline read:
    每次回傳 20 tweets × 400 bytes = 8 KB (text only)
    加上 embedded media thumbnails ≈ 50 KB per timeline
    Bandwidth = 450K × 50 KB = 22.5 GB/s = 180 Gbps
    → 需要 CDN 分擔 media traffic

=== Step 5: 機器估算 ===
  Web servers:  450K QPS / 5K per server = 90 servers (+冗餘 = ~120)
  Redis cache:  ~20 nodes for timeline + ~12 nodes for tweet cache
  DB:           Tweet storage sharded by user_id, 至少 10+ shards
  Kafka:        Fan-out events, 6M writes/s / 100K per partition = 60 partitions

=== 架構關鍵決策 ===
  1. Fan-out-on-write for 普通用戶 (< 10K followers)
  2. Fan-out-on-read for 名人帳號 (> 10K followers)
  3. Media 完全走 S3 + CDN，不經過 application server
  4. Timeline cache 是核心元件，需要 Redis Cluster
```

### 範例 3：YouTube 級別估算 (複雜 — 影片儲存 + 頻寬)

**需求**：設計類似 YouTube 的影片平台。

```
=== Step 1: 釐清規模 ===
  DAU                = 800M
  每用戶每天觀看     = 5 支影片
  每天上傳影片       = 500K 支
  平均影片長度       = 5 分鐘
  影片解析度         = 提供 360p / 720p / 1080p 三種

=== Step 2: QPS ===
  影片觀看 (metadata request + video stream initiation):
    Read QPS  = 800M × 5 / 86,400 ≈ 4B / 100K = 40K QPS
    Peak      = 40K × 3 = 120K QPS

  影片上傳：
    Upload QPS = 500K / 86,400 ≈ 6 QPS   ← QPS 極低
    但每次上傳的 payload 極大！重點不在 QPS 而在 bandwidth。

  搜尋 / 推薦：
    Search QPS = 800M × 3 searches / 86,400 ≈ 28K QPS
    Peak       = 28K × 3 = 84K QPS

=== Step 3: 儲存 (最複雜的部分) ===

  原始影片大小:
    5 min × 150 MB/min (1080p) = 750 MB per video (原始)

  轉碼 (Transcoding) 後的多解析度版本:
    360p:  5 min × 15 MB/min  = 75 MB
    720p:  5 min × 50 MB/min  = 250 MB
    1080p: 5 min × 150 MB/min = 750 MB
    合計 per video             ≈ 1,075 MB ≈ 1 GB (含原始檔)

  每日新增儲存:
    500K videos × 1 GB = 500 TB/day ← 每天半個 PB！

  每年儲存:
    500 TB × 365 = 182.5 PB/year ≈ 180 PB/year

  5 年 (不含 replication):
    180 PB × 5 = 900 PB ≈ 1 EB (Exabyte)

  加上 replication (通常 3x for object storage):
    1 EB × 3 = 3 EB

  結論：YouTube 級別的影片平台是 Exabyte-scale storage 問題。
        必須使用 distributed object storage (如 Google Colossus / S3)。

=== Step 4: 頻寬 (影片平台的核心瓶頸) ===

  影片串流頻寬:
    假設 50% 用戶看 720p, 30% 看 1080p, 20% 看 360p
    加權平均 bitrate = 0.5 × 5 Mbps + 0.3 × 8 Mbps + 0.2 × 1.5 Mbps
                     = 2.5 + 2.4 + 0.3 = 5.2 Mbps per stream

    同時在線觀看人數 (concurrent viewers):
      DAU 800M，假設每人每天看 25 min，分散在 24 小時
      平均同時在線 = 800M × 25 / (24 × 60) = 800M × 25 / 1440 ≈ 14M concurrent
      Peak = 14M × 2 = 28M concurrent streams

    Total bandwidth:
      28M × 5.2 Mbps = 145.6 Tbps ≈ 150 Tbps

    結論：150 Tbps 的出站頻寬，必須靠全球 CDN 網路分擔。
          單一資料中心不可能承載——YouTube 使用 Google 的 Peering + Edge Cache。

  上傳頻寬:
    500K videos/day × 750 MB / 86,400 = 4.3 GB/s = 34 Gbps (ingress)
    → 需要多個 upload endpoints 分散在不同地區

=== Step 5: 記憶體 / Cache ===
  影片 metadata cache:
    假設 10% 的影片佔 90% 的觀看量
    總影片數 (5 年) = 500K/day × 365 × 5 = 912.5M ≈ 1B 支影片
    Hot videos (10%) = 100M
    Metadata per video = 1 KB (title, description, stats, thumbnail URLs)
    Cache = 100M × 1 KB = 100 GB → 1 台 Redis 即可

  推薦系統的 feature cache:
    User embedding cache = 800M × 256 floats × 4 bytes = 819 GB ≈ 800 GB
    → 需要 8-10 Redis nodes

=== Step 6: 機器估算 ===
  API servers:     120K QPS / 5K per server = 24 servers (+冗餘 = ~35)
  Transcoding:     500K videos/day, 每支需要 ~30 min CPU time
                   = 500K × 30 min / (24 × 60 min) = 10,416 machines
                   → 使用 spot instances / 自動擴縮 ≈ 維持 ~5K-10K transcoding workers
  Storage servers:  Exabyte-scale → 完全依賴 distributed object storage
  CDN:             全球數百個 PoP (Points of Presence)

=== 架構關鍵決策 ===
  1. Storage 和 bandwidth 是核心瓶頸，不是 QPS
  2. 影片必須走 CDN，不經過 origin server
  3. Transcoding 是 CPU-intensive batch job，與 serving path 分離
  4. 使用 adaptive bitrate streaming (ABR) 根據用戶網路動態切換解析度
  5. 儲存分層：hot content → SSD cache at CDN, warm → SSD at DC, cold → HDD / tape
```

---

## 6. 常見錯誤

### 錯誤 1: 混淆 MB 和 Mb

```
✗ "3.5 GB/s 的頻寬，需要 4 條 1 Gbps 線路"
✓ "3.5 GB/s = 28 Gbps，需要 3 條 10 Gbps 線路"

記住：1 Byte = 8 bits → GB/s × 8 = Gbps
```

### 錯誤 2: 忘記 Peak Multiplier

```
✗ Average QPS = 10K → 用 10K 來 sizing
✓ Average QPS = 10K → Peak = 10K × 3 = 30K → 用 30K 來 sizing

系統不是設計來撐平均負載的。你的機器數要能撐住 peak。
```

### 錯誤 3: 忘記 Replication Factor

```
✗ "5 年需要 500 TB 儲存"
✓ "5 年需要 500 TB × 3 (replication) = 1.5 PB 實際磁碟空間"

幾乎所有生產系統都至少 3 副本 (三份資料)。
Object storage (S3) 預設 3x replication。
Kafka 預設 replication factor = 3。
```

### 錯誤 4: 忽略 Metadata 與額外開銷

```
✗ "1B rows × 100 bytes = 100 GB for the table"
✓ "100 GB raw data + ~50 GB for indexes + ~30 GB WAL/binlog + ~20% fragmentation ≈ 250 GB"

實際磁碟使用量通常是 raw data 的 2-3 倍：
  - B-tree indexes: 每個 index 約 raw data 的 10-30%
  - WAL / binlog: 連續寫入日誌
  - Fragmentation: 頁面分裂、deleted rows 空間未回收
  - Temporary files: sort / join 操作的暫存空間
```

### 錯誤 5: 過度精確

```
✗ "Write QPS = 300,000,000 × 5 / 86,400 = 17,361.11 QPS"
✓ "Write QPS ≈ 1.5B / 100K ≈ 15K QPS"

Back-of-the-envelope 的目的是快速得到數量級。
說 "大約 15K-20K QPS" 比 "17,361.11 QPS" 更有意義。
過度精確反而顯得你不理解估算的目的。
```

### 錯誤 6: 沒有 Sanity Check

每次算完一個數字，問自己：「這合理嗎？」

```
例子：算出一個社群 app 需要 1 EB 的文字儲存
Sanity check: Twitter 全球每天 5 億條 tweets × 280 bytes = 140 GB/day
              → 一年 ~50 TB，10 年 ~500 TB
              → 1 EB = 1,000 PB = 1,000,000 TB → 差了 2000 倍！
              → 回去檢查計算過程，一定哪裡算錯了
```

---

## 7. 快速參考表 (Quick Reference)

一張表包含所有估算需要的數字，面試前快速瀏覽：

| 類別 | 項目 | 數值 |
|------|------|------|
| **時間** | 1 天 | ≈ 10^5 秒 |
| | 1 月 | ≈ 2.5 × 10^6 秒 |
| | 1 年 | ≈ 3 × 10^7 秒 |
| **2 的冪次** | 2^10 / 2^20 / 2^30 / 2^40 | 1K / 1M / 1G / 1T |
| **字元大小** | ASCII / UTF-8 CJK / UUID / int64 | 1B / 3B / 16B / 8B |
| **媒體大小** | 壓縮圖片 / 1min 720p / 1min 1080p | 200KB / 50MB / 150MB |
| **延遲** | Memory / SSD / HDD / Network(DC) / Network(跨區) | 100ns / 150μs / 10ms / 0.5ms / 50-150ms |
| **DB 吞吐** | MySQL writes / reads | 10K-30K/s / 50K/s |
| **Cache 吞吐** | Redis ops | 100K/s |
| **MQ 吞吐** | Kafka per partition | ~100K msgs/s, ~10MB/s |
| **Web Server** | 單機 request 處理 | 1K-10K/s |
| **CDN** | 單 PoP | ~100K req/s |
| **網路** | 10 Gbps NIC 實際吞吐 | ~1.2 GB/s |
| **Peak** | Peak multiplier | 一般 2-3x, 促銷 5-10x |
| **Replication** | 典型副本數 | 3x |
| **Cache Rule** | 80/20 Pareto Principle | 20% data 服務 80% requests |

---

## 8. 面試技巧

### 技巧 1: 積極取整

用 10 的冪次簡化計算。面試官在意的是你的思路，不是你的算術能力。

```
86,400 → 用 100,000 (10^5)     誤差 ~15%，完全可接受
2,592,000 → 用 2.5 × 10^6      或直接用 "約 3M"
31,536,000 → 用 3 × 10^7
```

### 技巧 2: 先寫公式，再代入數字

展示結構化思維。先把公式寫出來，再一步步帶入數字。

```
✓ "QPS = DAU × actions / seconds_per_day
       = 300M × 5 / 100K
       = 15K"

✗ 直接說 "大概 15K QPS" (面試官不知道你怎麼算的)
```

### 技巧 3: Sanity Check

算完每個數字後，用已知的系統做比較。

```
"我算出需要 50K write QPS。Twitter 每天 5 億條 tweet，
 平均 write QPS 約 6K。我們的系統寫入量是 Twitter 的 8 倍，
 考慮到我們的場景...這合理 / 不合理。"
```

### 技巧 4: 說「大約」

```
✓ "大約 15K QPS"
✓ "roughly 300 TB"
✓ "on the order of 10K"
✗ "exactly 17,361 QPS"  ← 面試官會覺得你不理解估算的精神
```

### 技巧 5: 識別瓶頸比精確數字更重要

估算的最終目的是找出系統的瓶頸在哪裡，從而做出正確的架構決策。

```
URL Shortener → 瓶頸是 read latency → 需要 cache
Twitter       → 瓶頸是 fan-out write volume → 需要 hybrid fan-out
YouTube       → 瓶頸是 storage + bandwidth → 需要 CDN + tiered storage
Chat System   → 瓶頸是 concurrent connections → 需要 WebSocket + connection pooling
```

### 技巧 6: 準備好「如果規模再大 10 倍」的回答

面試官常問：「如果 DAU 從 100M 變成 1B 呢？」提前想好哪些元件需要重新設計。

```
10x 用戶 → QPS 10x → 單機瓶頸在哪裡？需要新增什麼層？
  - 可能需要從 single DB 變成 sharded DB
  - 可能需要從 single region 變成 multi-region
  - 可能需要從 fan-out-on-write 變成 hybrid fan-out
```

---

## 附錄：單位速查

| 前綴 | 符號 | 10 進位 | 2 進位 |
|------|------|---------|--------|
| Kilo | K | 10^3 = 1,000 | 2^10 = 1,024 |
| Mega | M | 10^6 = 1,000,000 | 2^20 = 1,048,576 |
| Giga | G | 10^9 | 2^30 |
| Tera | T | 10^12 | 2^40 |
| Peta | P | 10^15 | 2^50 |
| Exa  | E | 10^18 | 2^60 |

| 容易混淆的單位 | 說明 |
|---------------|------|
| **MB** (Megabyte) | 百萬位元組，儲存常用 |
| **Mb** (Megabit) | 百萬位元，網路常用 |
| **MBps** = MB/s | 每秒百萬位元組 |
| **Mbps** = Mb/s | 每秒百萬位元 |
| **1 MBps = 8 Mbps** | 永遠記住：1 Byte = 8 bits |
