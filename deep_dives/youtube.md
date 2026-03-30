# YouTube — 影片串流平台架構

## 1. 核心挑戰

YouTube 的設計核心是 **大規模影片上傳、轉碼與低延遲串流分發**：

```
規模：
  DAU: ~800M
  影片上傳量: ~500 hours/min → ~720K 小時/天
  影片觀看量: ~1B hours/day → ~700M 影片播放/天
  總影片數: > 800M 支影片
  平均影片長度: ~7 min

儲存挑戰：
  原始影片上傳: 500 hr/min × 60 min × ~2GB/hr (原始) = ~60TB/天（原始檔）
  轉碼後多格式: 每支影片 × 6 解析度 × 3 編碼格式 ≈ 18 個版本
  → 每日新增儲存 > 500TB（含所有轉碼版本）

流量模式：
  Read:Write ratio ≈ 1000:1（觀看遠遠多於上傳）
  流量分佈極度不均：Top 20% 影片 ≈ 80% 流量（Pareto 分佈）
  長尾效應：數億支影片每天只有個位數觀看
```

---

## 2. 整體架構

```
┌──────────┐    Pre-signed URL     ┌──────────────────┐
│ Client   │ ─────upload──────────▶│ Object Storage   │
│ (App/Web)│                       │ (S3 / GCS)       │
│          │                       └────────┬─────────┘
│          │──upload metadata──▶ Upload Service       │
│          │                       │                   │
│          │                       ▼                   ▼
│          │               ┌─────────────────────────────────┐
│          │               │   Transcoding DAG (async)       │
│          │               │   Video split → encode (多解析度)│
│          │               │   Audio extract → encode         │
│          │               │   Thumbnail generation           │
│          │               └────────────┬────────────────────┘
│          │                            │ 完成後回寫
│          │                            ▼
│          │               ┌─────────────────────┐
│          │               │  Video Metadata DB   │
│          │               │  (MySQL / Vitess)    │
│          │               └─────────────────────┘
│          │
│          │──watch video──▶ CDN Edge PoP ─cache miss─▶ Origin Shield ──▶ Object Storage
│          │  (HLS/DASH)    │ (離用戶最近)              (區域中間層)
│          │                └─ cache hit ──▶ 直接回應影片 chunks
│          │
│          │──search──▶ Search Service (Elasticsearch)
│          │
│          │──get feed──▶ Recommendation Service
│          │               ├── Candidate Generation (ANN)
│          │               ├── Ranking (ML model)
│          │               └── Re-ranking (diversity / freshness)
│          │
│          │──comment──▶ Comment Service ──▶ Comment DB (sharded)
└──────────┘
```

---

## 3. 影片上傳流程：Pre-signed URL + 直傳 Object Storage

### 為什麼不經過 API Server 上傳？

```
如果影片經過 API Server：
  Client → API Server → Object Storage

  問題：
  - 一支 1GB 影片要先完整上傳到 API Server（占用連線 + 記憶體）
  - API Server 再轉傳到 S3 → 雙倍網路頻寬
  - API Server 成為瓶頸（不能 scale 儲存獨立於 compute）

Pre-signed URL 做法：
  1. Client → Upload Service：「我要上傳一支 1080p MP4, 500MB」
  2. Upload Service 驗證權限 + 生成 Pre-signed URL（有效 15 min）
  3. Upload Service → Client：回傳 Pre-signed URL
  4. Client → S3：直接用 Pre-signed URL 上傳到 Object Storage
  5. S3 上傳完成 → 觸發 Event Notification (S3 Event / Pub/Sub)
  6. Upload Service 收到通知 → 寫入 Video Metadata DB → 觸發 Transcoding
```

### 斷點續傳 (Resumable Upload)

```
大檔案（1GB+）上傳經常中斷，必須支援 resumable upload：

Google Cloud Storage / S3 Multipart Upload：
  1. 將檔案切成 5-100MB 的 chunks
  2. 每個 chunk 獨立上傳（帶 chunk offset）
  3. 失敗時只需重傳該 chunk，不用從頭來
  4. 所有 chunks 上傳完成 → 呼叫 Complete Multipart Upload API → 合併

Client 端追蹤：
  uploaded_bytes = 0
  while uploaded_bytes < total_size:
    chunk = file.read(CHUNK_SIZE)  # 5MB
    upload_chunk(pre_signed_url, chunk, offset=uploaded_bytes)
    uploaded_bytes += CHUNK_SIZE
    save_progress(uploaded_bytes)  # 本地記錄進度
```

---

## 4. 轉碼 DAG：為什麼不是線性 Pipeline

### 線性 Pipeline 的問題

```
線性做法：Original → 240p → 360p → 480p → 720p → 1080p → 4K
  → 必須一個接一個，6 個解析度串行處理
  → 一支 10 分鐘影片，每個解析度轉碼 ~5 min → 30 min 才能上線

DAG 做法：
  Original ─┬── Video Track ─┬── H.264 240p ─┐
             │                ├── H.264 360p  │
             │                ├── H.264 720p  ├── 合併 manifest
             │                ├── H.264 1080p │    (.m3u8 / .mpd)
             │                ├── VP9 720p    │
             │                └── AV1 1080p   │
             │                                │
             ├── Audio Track ─┬── AAC 128kbps ─┤
             │                └── Opus 96kbps  │
             │                                │
             └── Thumbnail ── 生成 3 張候選 ───┘

好處：
  - Video / Audio / Thumbnail 三路平行處理
  - 同一路內的多個解析度也可以平行（獨立 worker）
  - 一支 10 分鐘影片：~5-8 min 全部完成（而非 30 min）
  - 可以優先產出 720p H.264（最常用），讓影片先上線
    → 其他解析度後續補上（progressive availability）
```

### 轉碼 Worker 架構

```
┌─────────────────────────────────────────────────────┐
│                  Transcoding Orchestrator            │
│  (DAG scheduler，追蹤每個 task 的 dependency)         │
│                                                     │
│  Video uploaded → 建立 DAG → 分發 tasks 到 queue     │
└────────┬───────────────┬────────────────┬───────────┘
         │               │                │
    ┌────▼────┐    ┌─────▼─────┐   ┌──────▼──────┐
    │ Video   │    │ Audio     │   │ Thumbnail   │
    │ Encoder │    │ Encoder   │   │ Generator   │
    │ Workers │    │ Workers   │   │ Workers     │
    │ (GPU)   │    │ (CPU)     │   │ (CPU)       │
    └─────────┘    └───────────┘   └─────────────┘

Worker pool sizing（粗估）：
  500 hr/min 上傳 → 假設每個 GPU worker 能 real-time encode 一路 1080p
  每支影片需 ~18 個 encode tasks
  → 需要 ~9000 個並行 encode tasks
  → 考慮 GPU worker 處理速度約 2x real-time
  → ~4500 GPU workers（peak，含 headroom）
```

### Codec 選擇 Trade-off

| Codec | 壓縮效率 | 編碼速度 | 解碼支援 | 適用場景 |
|-------|---------|---------|---------|---------|
| H.264 (AVC) | 基準 | 最快 (1x) | 99% 裝置 | 預設、低延遲需求 |
| VP9 | 比 H.264 好 30-40% | 慢 5-10x | Chrome, Android | 省頻寬、中等品質 |
| AV1 | 比 H.264 好 50%+ | 慢 20-50x | 新瀏覽器/裝置 | 4K、高流量影片 |

```
YouTube 的策略：
  - 所有影片必定轉 H.264（最大相容性）
  - 熱門影片額外轉 VP9 + AV1（省 CDN 頻寬成本）
  - AV1 編碼慢但省的頻寬 > 編碼 GPU 成本
    → 一支有 100M views 的影片，省 50% bitrate = 省數 TB 流量
    → 編碼多花幾小時 GPU 完全值得
```

---

## 5. Adaptive Bitrate Streaming (ABR)：HLS vs DASH

### 核心概念

```
傳統做法（progressive download）：
  Client 下載一個完整的 MP4 檔案 → 邊下邊播
  問題：無法根據網速切換品質、seek 需要重新緩衝

ABR 做法：
  1. 影片被切成 2-10 秒的小片段 (segments/chunks)
  2. 每個品質等級都有一組完整的 segments
  3. Client 端 ABR 演算法根據目前頻寬選擇下一個 segment 的品質

     頻寬高 → 拿 1080p segment
     頻寬降 → 切換到 480p segment（無縫切換）
```

### HLS vs DASH 比較

| 維度 | HLS (HTTP Live Streaming) | DASH (Dynamic Adaptive Streaming) |
|------|--------------------------|----------------------------------|
| 開發者 | Apple | MPEG 標準組織 |
| Manifest 格式 | `.m3u8` (文字) | `.mpd` (XML) |
| Segment 格式 | `.ts` 或 `.fmp4` | `.m4s` (fragmented MP4) |
| DRM 支援 | FairPlay | Widevine, PlayReady |
| 瀏覽器支援 | Safari 原生，其他靠 JS | Chrome, Firefox, Edge 原生 |
| Segment 長度 | 通常 6 sec | 通常 2-4 sec |
| 延遲 | 較高 (18-30s) | 較低 (6-15s) |
| 低延遲變體 | LL-HLS | LL-DASH (~2-5s) |

### Manifest 檔案範例 (HLS .m3u8)

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
  360p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
  720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
  1080p/playlist.m3u8

--- 720p/playlist.m3u8 ---
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
  segment_001.ts
#EXTINF:6.0,
  segment_002.ts
  ...
```

### Client 端 ABR 演算法（簡化版）

```python
def select_next_quality(buffer_level, bandwidth_estimate, qualities):
    """
    buffer_level: 目前 buffer 剩餘秒數
    bandwidth_estimate: 近 3 個 segment 的平均下載速度
    qualities: [(bitrate, resolution), ...] 從低到高排序
    """
    # Buffer-based: buffer 低時保守選低品質
    if buffer_level < 5:  # 快要 rebuffer 了
        return qualities[0]  # 選最低品質

    # Throughput-based: 選不超過可用頻寬 80% 的最高品質
    safe_bandwidth = bandwidth_estimate * 0.8
    best = qualities[0]
    for q in qualities:
        if q.bitrate <= safe_bandwidth:
            best = q
    return best
```

---

## 6. CDN 架構：Origin Shield + Edge PoPs

### 三層架構

```
                        ┌────────────────┐
                        │ Origin Storage │
                        │ (S3 / GCS)     │  ← 所有影片的完整備份
                        └───────┬────────┘
                                │ cache miss
                        ┌───────▼────────┐
                        │ Origin Shield  │  ← 區域中間層（全球 3-5 個）
                        │ (Regional)     │     減少打回 Origin 的次數
                        └───────┬────────┘
                    ┌───────────┼───────────┐
              ┌─────▼─────┐ ┌──▼─────┐ ┌───▼────┐
              │ Edge PoP  │ │Edge PoP│ │Edge PoP│  ← 全球 200+ PoPs
              │ (台北)    │ │(東京)  │ │(新加坡)│     離用戶最近
              └─────┬─────┘ └────────┘ └────────┘
                    │
              ┌─────▼─────┐
              │  End User  │
              └───────────┘
```

### 快取策略

```
熱門影片（Top 20% → 80% 流量）：
  → 存在 Edge PoP 的 SSD 上
  → Cache hit rate 目標 > 95%
  → 使用 LRU 或 LFU eviction

溫影片（中等流量）：
  → Origin Shield cache（較大容量）
  → Cache hit rate ~80-90%

冷門影片（Long tail）：
  → 直接從 Origin Storage 拉取
  → 可搬到冷儲存 (S3 Glacier / Nearline) 降成本
  → 首次觀看延遲較高（~200-500ms 多一次 Origin round trip）

頻寬成本（YouTube 的最大開支之一）：
  假設每天 1B hours 觀看 × 平均 2.5 Mbps = ~1.1 EB/天 出站流量
  CDN egress 成本 ~$0.02/GB → ~$22M/天 → ~$8B/年
  → 這就是為什麼 Google 自建 CDN (Google Global Cache)
     部署到 ISP 機房裡，減少跨網路流量
```

### Google Global Cache (GGC)

```
傳統 CDN: User → ISP → CDN Edge → Internet → Origin
Google 做法: User → ISP → GGC (在 ISP 機房內) → 完

Google 直接在大型 ISP 的機房裡放伺服器（GGC nodes）：
  → 熱門影片的 segments 都在 ISP 內部
  → 不需要出 ISP 網路 → 延遲極低（< 5ms）、頻寬免費
  → ISP 也樂意：減少了他們的上游流量成本

這也是為什麼 YouTube 在大多數地方都比競爭對手流暢。
```

---

## 7. Video Metadata Service

### 資料模型

```sql
videos:
  video_id        BIGINT PRIMARY KEY     -- Snowflake / UUID
  creator_id      BIGINT
  title           VARCHAR(100)
  description     TEXT
  tags            JSON                    -- ["music", "tutorial"]
  category        ENUM('music','gaming','education',...)
  duration_sec    INT
  upload_status   ENUM('processing','ready','failed')
  visibility      ENUM('public','private','unlisted')
  view_count      BIGINT                  -- 非即時，async flush
  like_count      INT
  dislike_count   INT
  comment_count   INT
  thumbnail_url   VARCHAR(500)
  manifest_url    VARCHAR(500)            -- HLS .m3u8 位址
  created_at      TIMESTAMP
  published_at    TIMESTAMP

INDEX idx_creator (creator_id, published_at DESC)   -- 創作者的影片列表
INDEX idx_category (category, view_count DESC)       -- 分類排行
```

### View Count：Eventual Consistency 策略

```
為什麼不能每次觀看都直接 UPDATE view_count = view_count + 1？
  → 熱門影片 100K views/sec → 100K 次 DB write/sec 到同一行
  → MySQL single row update ≈ 10K QPS（樂觀估計）
  → 超過 10x 負荷，直接打爆 DB

解法：Redis Counter + Async Flush

  Client 觀看影片
    │
    ▼
  View Service → INCR view_count:{video_id}  (Redis, 原子操作)
    │              Redis 單機 100K+ INCR/sec → 輕鬆扛
    │
    ▼  (每 30 秒 or 每 1000 次，batch flush)
  Background Worker：
    count = GETSET view_count:{video_id} 0   -- 原子讀取並歸零
    UPDATE videos SET view_count = view_count + {count}
                  WHERE video_id = {id}
    → DB 只需要每 30 秒更新一次，而非每秒 100K 次

使用者看到的 view count 可能延遲 30-60 秒 → 完全可接受
（YouTube 實際上 view count 延遲更久，有時數小時才更新，
  因為還要做 bot detection / view validation）
```

### View Validation（防灌水）

```
不是每次 HTTP 請求都算一次「觀看」：
  - 同一 IP 短時間重複請求 → 去重
  - 觀看時間 < 30 秒 → 可能不算
  - 已知 bot/crawler 的 User-Agent → 過濾
  - 異常流量模式（同一影片 burst 觀看）→ 延遲計入，人工審核

Pipeline:
  Raw view events (Kafka) → Dedup (Flink) → Bot filter → Valid views → Flush to DB
```

---

## 8. 推薦系統（高層架構）

### 三階段 Pipeline

```
全部影片 (~800M)
    │
    ▼  Candidate Generation（候選生成）
    │  目標：從 800M → ~1000 支候選
    │  方法：
    │    - Collaborative Filtering: 跟你相似的人看了什麼
    │    - Content-based: 跟你看過的影片相似的有哪些
    │    - ANN (Approximate Nearest Neighbor): 用 embedding 做向量搜尋
    │    → 延遲要求 < 50ms（用 HNSW / ScaNN index）
    │
    ▼  Ranking（精排）
    │  目標：從 ~1000 → ~100，按預測分數排序
    │  方法：
    │    - 深度學習模型（Wide & Deep / Transformer）
    │    - Features: 用戶歷史、影片 metadata、context (時間/裝置)
    │    - 預測目標: P(click), P(watch_time > 60s), P(like), P(share)
    │    → 延遲要求 < 100ms
    │
    ▼  Re-ranking（重排序）
    │  目標：加入業務規則和多樣性
    │  規則：
    │    - 不要連續推相同創作者的影片
    │    - 新鮮度加權（新上傳的影片 boost）
    │    - 廣告插入位置
    │    - 內容政策過濾（成人、暴力等）
    │
    ▼  最終 Feed (~30-50 支影片一頁)
```

### 為什麼分三層？

```
精排模型（Ranking）每支影片 inference ~0.1ms：
  100 支 → 10ms ✓
  800M 支 → 22 小時 ✗

所以需要候選生成先做粗篩：
  ANN 搜尋 800M embedding → top 1000 → ~30ms
  精排 1000 支 → ~100ms
  重排序 100 支 → ~5ms
  總延遲 < 200ms ✓
```

---

## 9. Video Search

### 搜尋架構

```
搜尋來源（multi-signal）：
  1. Title + Description（最強信號）
  2. Tags（創作者標註）
  3. Auto-generated captions（語音轉文字）→ 能搜尋到影片「說」了什麼
  4. User engagement signals（CTR, watch time）→ 排序用

Indexing Pipeline:
  影片上傳 → Metadata 寫入 → Kafka event
    → Elasticsearch indexer consumer
    → 建立 inverted index:
       keyword → [(video_id, score, field_type), ...]

  語音轉字幕（非同步，可能延遲幾分鐘）：
    影片上傳 → Speech-to-Text Service (Whisper 等)
    → 字幕文字寫入 captions table
    → 更新 Elasticsearch index（追加 caption field）
```

### 資料模型（Elasticsearch）

```json
{
  "video_id": "abc123",
  "title": "如何設計分散式系統",
  "description": "本影片介紹 System Design 的核心概念...",
  "tags": ["system design", "distributed systems", "interview"],
  "captions": "今天我們來聊聊分散式系統的設計原則...",
  "creator_name": "Tech Channel",
  "view_count": 150000,
  "like_ratio": 0.95,
  "published_at": "2026-01-15T10:00:00Z",
  "duration_sec": 720,
  "language": "zh-TW"
}
```

```
搜尋排序公式（簡化）：
  score = text_relevance × 0.4
        + engagement_score × 0.3   -- CTR × watch_completion_rate
        + freshness_score × 0.15   -- 越新越高
        + creator_authority × 0.15 -- 訂閱數、歷史表現

Elasticsearch 的 function_score query 可以實現這種加權排序。
```

---

## 10. Live Streaming 基礎

### RTMP Ingest → HLS/DASH Fan-out

```
直播與 VOD（隨選影片）的最大差異：
  - VOD：影片預先完整轉碼，所有 segments 已備好
  - Live：影片即時產生，需要 real-time 轉碼 + 即時分發

Pipeline:
  Streamer (OBS/手機)
    │ RTMP (Real-Time Messaging Protocol, TCP-based)
    │ bitrate: 4-10 Mbps
    ▼
  Ingest Server (接收 RTMP stream)
    │ 在全球主要區域部署 (US, EU, Asia)
    │ 選離 streamer 最近的 ingest point
    ▼
  Live Transcoder
    │ 即時轉碼成多個品質 (360p, 720p, 1080p)
    │ 切成 2-4 秒的 segments
    │ 延遲瓶頸在這裡：segment duration = 最小延遲
    ▼
  Origin Server
    │ 持續更新 manifest (.m3u8)
    │ 每個新 segment 產出 → append 到 playlist
    ▼
  CDN Edge
    │ 觀眾從 Edge 拿最新的 manifest → 拿最新 segment → 播放
    │
    ▼
  Viewer (HLS/DASH player)

端到端延遲：
  RTMP ingest:    ~1s
  Transcoding:    ~2s (segment duration)
  CDN propagation: ~1s
  Client buffer:  ~2s
  Total:          ~5-8s（一般直播）

  Low-latency mode (LL-HLS/LL-DASH):
    使用 partial segments (CMAF chunks, ~200ms)
    → 端到端 ~2-3s
```

---

## 11. Comment System

### 資料模型（巢狀留言）

```sql
comments:
  comment_id    BIGINT PRIMARY KEY     -- Snowflake ID
  video_id      BIGINT
  user_id       BIGINT
  parent_id     BIGINT                 -- NULL = 頂層留言, 非 NULL = 回覆
  content       TEXT
  like_count    INT
  is_pinned     BOOLEAN
  is_hearted    BOOLEAN                -- 創作者愛心
  status        ENUM('visible','deleted','spam')
  created_at    TIMESTAMP

INDEX idx_video_comments (video_id, created_at DESC)     -- 影片的留言列表
INDEX idx_replies (parent_id, created_at ASC)             -- 某留言的回覆
```

### 分頁與排序

```
頂層留言分頁：
  GET /comments?video_id=X&sort=top&cursor=comment_id_123&count=20

排序模式：
  - Top: ORDER BY (like_count × recency_weight) DESC
  - Newest: ORDER BY created_at DESC

回覆載入（lazy load）：
  點擊「查看 15 則回覆」→ GET /comments/{parent_id}/replies?cursor=...
  → 只查 parent_id = X 的子留言

為什麼只有兩層（頂層 + 回覆）不做深層巢狀？
  - 深層巢狀 UI 在手機上不好顯示
  - 查詢複雜度增加（遞迴查詢 or closure table）
  - YouTube / Reddit 等平台都限制在 2 層
```

### Spam Detection

```
多層防線：
  1. Rule-based: 包含已知詐騙連結、重複貼文 → 直接標記
  2. ML classifier: 訓練模型判斷 spam probability
  3. User signals: 檢舉次數超過閾值 → 人工審核
  4. Rate limiting: 同一用戶每分鐘最多 N 則留言

流量：
  假設每天 500M 則留言 → ~6K comments/sec
  → Sharding by video_id：熱門影片的 shard 壓力大
  → 可以用 video_id 作為 partition key 搭配 write buffer
```

---

## 12. 容量估算

```
每日上傳量：
  500 hours/min × 60 min/hr × 24 hr = 720,000 hours/day

原始儲存（上傳）：
  平均原始影片 bitrate: ~5 Mbps = 0.625 MB/s
  720K hours × 3600 sec × 0.625 MB/s = ~1.6 PB/day (原始檔)

轉碼後儲存：
  每支影片 × 多解析度多 codec：
  假設轉碼後所有版本總計 ≈ 3× 原始大小
  → ~4.8 PB/day 新增儲存

  年度新增: ~1.75 EB/year
  累計（假設 15+ 年營運）: 數十 EB 級
```

| 指標 | 估算 |
|------|------|
| DAU | ~800M |
| 每日影片觀看量 | ~1B hours |
| 上傳速率 | 500 hours/min → **720K hours/day** |
| 影片播放 QPS | ~700M plays/day → **~8K plays/sec** |
| Segment 請求 QPS（每次播放含多次 chunk 請求）| 8K × 60 segments/video avg → **~480K req/sec** |
| CDN 出站流量 | 1B hrs × 2.5 Mbps avg = **~1.1 EB/day** |
| 每日新增儲存（含轉碼） | **~4.8 PB/day** |
| 每年新增儲存 | **~1.75 EB/year** |
| Transcoding workers (GPU) | **~4500 (peak)** |
| CDN Edge PoPs | **200+ 全球** |
| Video Metadata DB size | 800M videos × 2KB = **~1.6TB** |
| View count Redis | 熱門 50M videos × 16 bytes = **~800MB** |

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 上傳方式 | **Pre-signed URL 直傳 S3** | 避免 API Server 成為瓶頸，節省雙倍頻寬 |
| 轉碼架構 | **DAG（非線性 pipeline）** | Video/Audio/Thumbnail 平行處理，轉碼時間減少 3-5x |
| Codec 策略 | **H.264 必轉 + 熱門影片加轉 VP9/AV1** | 相容性優先，熱門影片的頻寬節省 > 編碼成本 |
| 串流協議 | **HLS + DASH 雙支援** | HLS 覆蓋 Apple 生態，DASH 覆蓋其他平台 |
| CDN 層級 | **Edge PoP + Origin Shield + GGC** | 三層快取最大化 cache hit，GGC 部署到 ISP 降低延遲 |
| View count | **Redis counter + async flush** | 避免 DB hot row，接受秒級延遲 |
| 推薦系統 | **三階段 pipeline（候選→精排→重排）** | 800M 影片不可能全部精排，逐層篩選控制延遲 |
| 留言結構 | **兩層巢狀（非遞迴）** | 簡化查詢、手機 UI 友好、效能可預測 |
| 冷熱分離 | **SSD (hot) + S3 (warm) + Glacier (cold)** | 80% 流量集中在 20% 影片，冷門影片存便宜儲存 |

---

## 14. 面試常見 Follow-up

### Q: 如果一支影片突然爆紅（viral），CDN 怎麼扛？

```
Cache stampede 問題：
  影片剛上傳 → CDN 尚未快取 → 短時間大量 cache miss → 全打回 Origin

解法：
  1. Request coalescing: Edge PoP 收到 100 個同 segment 的請求
     → 只發 1 個請求到 Origin，其他 99 個等結果 → 一起回應
  2. Origin Shield: 即使 Edge miss，也只打到 Origin Shield 而非直接打 S3
     → Origin Shield 也做 coalescing
  3. Pre-warm: 轉碼完成後主動推最常用的前幾個 segments 到 Edge PoP
  4. 實際上大部分 viral 影片是漸進式爆紅（幾小時內增長）
     → 第一波觀眾就已經幫忙 warm 了 cache
```

### Q: 怎麼處理影片版權偵測（Content ID）？

```
YouTube Content ID 流程：
  1. 版權方上傳「參考檔案」（reference file）→ 建立指紋 (fingerprint)
  2. 新影片上傳 → 轉碼同時做 fingerprint matching
     - 音訊指紋: Chromaprint / 頻譜特徵比對
     - 視訊指紋: 關鍵幀 perceptual hash 比對
  3. 匹配到 → 依版權方設定：封鎖 / 投放廣告分潤 / 追蹤

技術挑戰：
  - 參考資料庫 > 100M 支影片的指紋
  - 每分鐘 500 小時新影片都要比對
  → 需要高效的近似搜尋（LSH / ANN 索引）
```

### Q: 怎麼實現影片「快轉預覽」(Seek Preview Thumbnails)？

```
轉碼時額外產出：
  - 每隔 1-2 秒擷取一張小縮圖 (160×90)
  - 打包成 Sprite Sheet (一張大圖包含 N 張小圖)
  - 產出 VTT 檔案標注每張縮圖對應的時間

一支 10 分鐘影片：
  600 秒 / 2 秒間隔 = 300 張縮圖
  每張 160×90 × 3 bytes ≈ 43KB (壓縮後 ~3KB)
  Sprite Sheet: 300 × 3KB = ~900KB → CDN cache

使用者拖動進度條時：
  Client 根據 hover 時間查 VTT → 從 Sprite Sheet 裁切對應區域 → 顯示
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU、上傳速率 (500 hr/min)、觀看量 (1B hr/day)、read:write ratio ~1000:1、儲存量級 (PB/day)
2. **上傳 + 轉碼 Pipeline（核心）**（4 分鐘）— Pre-signed URL 直傳 S3、Resumable Upload、Transcoding DAG（非線性！平行處理 video/audio/thumbnail）、Codec 選擇策略
3. **ABR Streaming（核心）**（3 分鐘）— HLS/DASH 概念、Manifest + Segments 切片、Client 端品質自適應切換
4. **CDN 三層架構**（2 分鐘）— Edge PoP → Origin Shield → Origin、hot/cold 分離、Google Global Cache 直接進 ISP
5. **Metadata + View Count**（1 分鐘）— Redis counter async flush、View validation pipeline
6. **Deep Dive（面試官選）**（2 分鐘）— 推薦系統三階段、Live Streaming、Content ID、Comment system
