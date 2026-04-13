# Instagram — 圖片社群網路系統架構

## 1. 核心挑戰

Instagram 的設計核心是 **媒體密集型社群平台的寫入、處理、與分發效率**：

```
規模：
  DAU: ~500M
  Photos uploaded/day: ~100M → ~1.2K uploads/sec
  Stories created/day: ~500M → ~5.8K stories/sec
  Feed reads/day: ~10B → ~115K reads/sec
  Explore page views/day: ~200M

Read:Write ratio ≈ 100:1（Feed reads 10B / Photo uploads 100M；若計入 stories + likes 等所有寫入則 ~15-20:1）

核心矛盾：
  - 每張照片需產生 3+ 種尺寸 + CDN 分發，寫入放大嚴重
  - Feed 不是按時間排序，而是 ML 排序 → 無法像 Twitter 一樣簡單 fan-out pre-computed list
  - Stories 有 24 小時 TTL + 觀看者追蹤，生命週期管理複雜
  - Media-heavy：每日新增 ~60TB 圖片資料，儲存成本是 Twitter 的數百倍

與 Twitter 的關鍵差異：
  - Twitter：文字為主，fan-out on write 預計算 timeline
  - Instagram：媒體為主，ML-ranked feed，無法完全預計算
```

---

## 2. 整體架構

```
┌──────────┐
│  Client  │
│ (iOS/    │
│  Android)│
└────┬─────┘
     │
     ├── upload photo ──▶ Upload Service ──▶ Object Storage (S3)
     │                        │
     │                        ▼
     │                   Media Processing Pipeline (async)
     │                   ├── Resize (150px, 640px, 1080px)
     │                   ├── Content Moderation (hash + ML)
     │                   └── CDN Warm-up
     │
     ├── read feed ──▶ Feed Service
     │                   ├──▶ Candidate Generation (followees' posts)
     │                   ├──▶ Ranking Service (ML model)
     │                   └──▶ Post Store (hydrate content + media URLs)
     │
     ├── stories ──▶ Story Service
     │                 ├──▶ Redis (TTL=24h, active stories)
     │                 └──▶ Story Viewer Tracking
     │
     ├── explore ──▶ Explore Service
     │                 ├──▶ Embedding Index (ANN search)
     │                 └──▶ Content Moderation
     │
     ├── like/comment ──▶ Engagement Service
     │                      ├──▶ Redis Counter (likes)
     │                      └──▶ Comment Store (MySQL)
     │
     ├── DM ──▶ Messaging Service (WebSocket + Message Queue)
     │
     └── follow ──▶ Social Graph Service (MySQL + Redis cache)
                        │
                        ▼
                   Notification Service (Kafka → APNs/FCM)
```

---

## 3. 核心設計決策：照片上傳與處理管線

### Pre-signed URL 直傳模式

```
傳統模式（不好）：
  Client → API Server → S3
  問題：API Server 成為瓶頸，大檔案佔用連線、記憶體

Pre-signed URL 模式（Instagram 實際做法）：
  1. Client → API Server：「我要上傳一張照片」
  2. API Server → 生成 S3 Pre-signed URL（含過期時間 + 上傳限制）
  3. API Server → Client：回傳 pre-signed URL
  4. Client → S3：直接上傳原始檔案（繞過 API Server）
  5. S3 → Event Notification → 觸發 Media Processing Pipeline

好處：
  - API Server 不處理大檔案 → CPU/Memory 不被佔用
  - 可以平行上傳（Client 直連 S3，頻寬不受 API Server 限制）
  - S3 原生支援 multipart upload（>5MB 的檔案分塊傳）
```

### 非同步處理管線

```
User 上傳照片後的處理流程：

┌─────────┐    ┌──────────────┐    ┌──────────────────────┐
│ S3 Event │──▶│ Kafka Topic  │──▶│ Media Processing      │
│ (upload  │    │ (media.      │    │ Workers               │
│ complete)│    │  uploaded)   │    │                       │
└─────────┘    └──────────────┘    │ 1. Validate format    │
                                   │ 2. Strip EXIF (隱私)  │
                                   │ 3. Resize:            │
                                   │    - 150×150 thumbnail │
                                   │    - 640×640 feed      │
                                   │    - 1080×1080 full    │
                                   │ 4. Content moderation  │
                                   │ 5. Upload to CDN       │
                                   │ 6. Update Post Store   │
                                   └──────────────────────┘

時間估算：
  上傳確認（Client 收到 200）：< 500ms
  處理完成（所有尺寸就緒 + CDN）：3-10 秒
  → Client 先顯示本地預覽，背景 polling 或 WebSocket 通知處理完成

為什麼用 3 種尺寸？
  150px thumbnail：Story tray、通知頭像、搜尋結果 → ~15KB
  640px feed：Feed 流中顯示 → ~80KB
  1080px full：點擊放大檢視 → ~200KB
  → 節省頻寬：Feed 滑動時載入 640px 而非 1080px
  → 100M photos × 3 sizes × avg 100KB = ~30TB/day 處理後儲存
```

### Content Moderation（內容審核）

```
兩階段審核：

1. Hash Matching（同步，< 50ms）：
   - PhotoDNA / pHash：比對已知違規圖片資料庫
   - 命中 → 立即阻擋，不進入 feed

2. ML Classifier（非同步，~200ms）：
   - 分類：暴力、色情、仇恨言論、垃圾訊息
   - 每張圖片產生 safety score
   - Score > threshold → 自動下架 + 人工複審佇列
   - 灰色地帶 → 降低 Explore 曝光權重（soft penalty）

吞吐量：
  100M photos/day ÷ 86400 = ~1.2K photos/sec
  每張需要 ~200ms ML inference
  → 需要 ~240 個推論 worker（假設 1 worker 處理 ~5 req/sec on GPU）
```

---

## 4. Feed 排序：ML-Based Ranking

這是 Instagram 與 Twitter 最大的架構差異。Twitter 可以 fan-out on write 預計算 timeline，但 Instagram 的 feed 是**個人化排序**，無法完全預計算。

### 三階段 Ranking Pipeline

```
User 打開 Feed：

Stage 1: Candidate Generation（候選生成，< 50ms）
  ├── 來源 1：followees 最近 48h 的 posts（~500 posts if follow 200 人）
  ├── 來源 2：close friends 最近 7 天未看過的 posts
  └── 候選池：~500-1000 posts

Stage 2: First-pass Ranking（粗排，< 30ms）
  ├── 輕量模型（logistic regression / small neural net）
  ├── 特徵：post age, author relationship score, content type
  ├── 目標：過濾到 top-200
  └── 在 CPU 上即可運行

Stage 3: Fine Ranking（精排，< 100ms）
  ├── 重量模型（deep neural network）
  ├── 特徵：
  │   - User-Post interaction history
  │   - Author engagement rate
  │   - Content embedding similarity
  │   - Time decay (越新分數越高)
  │   - Relationship strength (互動頻率 / 有無 DM / 互相 follow)
  ├── 多目標優化：P(like) × w1 + P(comment) × w2 + P(save) × w3 + P(share) × w4
  ├── 輸出：排序後 top-50 posts → 回傳 Client
  └── 需要 GPU inference

End-to-end latency: < 200ms
```

### Ranking Features 細節

| Feature 類別 | 範例 | 儲存位置 |
|-------------|------|---------|
| User features | 活躍時段、偏好內容類型、互動歷史 | Feature Store (Redis) |
| Post features | 發佈時間、like 數、content embedding | Post metadata cache |
| Author features | follower 數、posting 頻率、engagement rate | Feature Store |
| Cross features | user-author 互動次數、最近互動時間 | Precomputed, Feature Store |

### Feed Caching 策略

```
完全預計算 vs 按需計算：

完全預計算（Twitter 模式）：
  ✗ 不適用 Instagram → 因為排序依賴即時 context（剛看過什麼、當前時間）
  ✗ 每次 feature 更新都要重新排序所有 user 的 feed

按需計算（每次 request 都跑 full ranking）：
  ✗ GPU inference 太貴 → 500M DAU × 10 次打開/day = 5B ranking/day
  ✗ p99 latency 不穩定

Instagram 實際做法 — Hybrid：
  1. 預計算 candidate set（每 15 分鐘更新一次）
     → Redis sorted set: candidates:{user_id} → [(post_id, coarse_score), ...]
  2. 用戶打開 feed 時：從 candidate set 取 top-200 → 跑 fine ranking
     → 省去 Stage 1 的 DB 查詢，只做 Stage 2+3
  3. Cache 已排序的 feed（TTL=5 分鐘）
     → 短時間內重複打開不重新排序
     → 但下拉刷新強制觸發重新排序

成本估算：
  Fine ranking: ~200 posts × 1ms/post on GPU = ~200ms per request
  → 單 GPU 吞吐量：1000ms / 200ms = ~5 rankings/sec（sequential per request）
  → 實務上用 batch inference（多 request 併行）+ model parallelism，單 GPU 可達 ~50-100 rankings/sec
  5B rankings/day ÷ 86400 = ~58K rankings/sec
  → 以 batch throughput ~100 rankings/sec per GPU 計算 → 需要 ~600 GPU
  → 這就是為什麼 candidate generation 階段要先把 1000 → 200，省 5 倍 GPU
```

---

## 5. Stories 架構：24 小時 TTL 的暫時性內容

### 資料模型與 TTL 管理

```
Story 特性：
  - 24 小時後自動消失（對觀看者）
  - 但 Archive 版本永久保存（對作者）
  - 每個 user 可有多個 active stories（形成一組 story reel）
  - 需要追蹤誰看過

Storage 選擇：

Active Stories → Redis (with TTL)
  Key: stories:{user_id}
  Value: Sorted Set [(story_id, created_at), ...]
  TTL: 24 hours（每個 story 獨立 TTL）

  ZADD stories:user_123 {timestamp} {story_id}
  EXPIREAT story_data:{story_id} {created_at + 86400}

Story Content → Object Storage (S3) + CDN
  跟 feed 照片相同的處理管線
  但 story 偏好影片 → 需要 video transcoding（HLS, 多碼率）

Archived Stories → Cold Storage (S3 Glacier)
  24h 後從 Redis 移除 → 移至 S3 Glacier
  只有作者可以存取 archive
```

### Story Tray 排序

```
Story Tray（feed 頂部的頭像列）需要排序：

Input: user 的所有 followees 中有 active story 的人
Sort by:
  1. 有未讀 story 的排前面
  2. 未讀中：relationship closeness × recency 排序
  3. 已讀的排後面：recency 排序

Relationship closeness 計算：
  - 互相 follow: +3
  - 近 7 天有 DM: +2
  - 近 7 天有 like/comment 互動: +1
  → 預計算，存在 Social Graph Service 的 cache 中

實作：
  1. 查 followees list → 過濾有 active story 的 → ~30-50 人
  2. 查 viewed_stories:{user_id} set → 哪些已讀
  3. 按上述規則排序
  4. Cache 結果 5 分鐘（story tray 不需要即時精確）
```

### Viewer Tracking（誰看了我的 Story）

```
需求：story 作者可以看到觀看者列表

寫入 path：
  User A 看了 User B 的 story
  → SADD story_viewers:{story_id} {user_a_id}
  → INCR story_view_count:{story_id}

讀取 path：
  User B 查看自己 story 的觀看者
  → SMEMBERS story_viewers:{story_id}

規模估算：
  熱門用戶的 story 可能有 100K+ 觀看者
  → Redis Set 可以扛（100K × 8 bytes = 800KB per story，raw data）

  全局：500M stories/day × avg 100 viewers
  → 實際 Redis SET 每個 entry overhead ~60 bytes（dictEntry + SDS + RedisObject + jemalloc）
  → 500M × 100 × 60B = ~3TB 峰值
  → TTL 24h 後自動清理，但峰值需 ~30-40 Redis 節點（100GB each）
```

---

## 6. Explore / Discovery Feed

### Embedding-Based 推薦

```
Explore 頁面顯示「你可能喜歡的內容」：

Content Embedding Pipeline：
  每張照片上傳時 → CNN 提取 visual embedding (512-dim vector)
  → 存入 Embedding Index（Faiss / Milvus）

User Interest Embedding：
  User 最近 liked / saved / shared 的 posts 的 embedding → 加權平均
  → 得到 user interest vector

推薦流程：
  1. ANN Search (Approximate Nearest Neighbor)：
     用 user interest vector → 在 Embedding Index 中找 top-1000 相似的 posts
  2. 過濾：
     - 移除已看過的 posts
     - 移除 followees 的 posts（Explore 是發現新內容）
     - Content moderation score 過濾
  3. Diversity injection：
     - 不能全是同一類內容（打散同作者、同主題）
  4. Fine ranking：
     - 跟 Feed 共用同一套 ranking model（但權重不同）

Latency: < 300ms（ANN search ~50ms + ranking ~200ms）
```

### Interest Graph（興趣圖譜）

```
User → likes Post A (tagged: #travel, #japan)
User → saves Post B (tagged: #food, #ramen)
→ User interest: {travel: 0.8, food: 0.6, japan: 0.7, ramen: 0.3}

Interest Graph 是一個 bipartite graph：
  User nodes ←→ Topic nodes
  Edge weight = interaction count × recency decay

用途：
  1. Explore 推薦的候選召回
  2. Ad targeting（廣告投放）
  3. Trending topics detection per interest cluster

資料流（兩層更新）：

  即時：User 互動 → Kafka → Consumer 做 Redis HINCRBY interests:{user_id} travel 1
       → 只做加分，不做衰減（快）

  每日 Batch Job：
    → 從 Data Warehouse（BigQuery / Hive）讀全部互動紀錄
    → 套用 recency decay（7 天前 ×0.9、30 天前 ×0.5、90 天前 ×0.1）
    → 重算每個 user 的完整 interest vector
    → 寫入 Feature Store（持久化）+ 同步更新 Redis（cache）

  為什麼用 Data Warehouse 而非 MySQL：
    → 查詢模式是「掃幾十億行互動紀錄、只讀 tag + timestamp、做 GROUP BY 聚合」
    → 列式儲存只讀需要的 column → I/O 少幾十倍
    → BigQuery serverless 按掃描量計費，每天跑一次 batch 很便宜
    → MySQL 對 10B 行的 GROUP BY 會極慢

儲存分層：
  Data Warehouse（BigQuery）：原始互動紀錄的 source of truth（永久保存）
  Feature Store：每日重算的 interest vector（持久化，模型訓練用）
  Redis：Feature Store 的 cache（即時查詢用，掛了從 Feature Store 重建）

  Redis 掉了的影響：推薦降級到昨天的 interest vector → 可接受
```

---

## 7. 媒體儲存與 CDN 策略

### Storage Tiering（儲存分層）

```
Hot Tier（最近 7 天的內容）：
  → S3 Standard + CloudFront CDN edge cache
  → ~60TB/day × 7 = ~420TB
  → CDN hit rate 目標 > 95%（熱門內容幾乎都命中 edge）

Warm Tier（7 天 ~ 1 年）：
  → S3 Standard-IA (Infrequent Access)
  → 比 Standard 便宜 ~40%
  → 仍然可以即時存取（< 100ms）
  → ~60TB/day × 365 = ~22PB

Cold Tier（> 1 年的內容）：
  → S3 Glacier Instant Retrieval
  → 比 Standard 便宜 ~68%
  → 存取延遲 ~幾百 ms（可接受，舊內容不頻繁存取）

生命週期策略（S3 Lifecycle Policy 自動搬遷）：
  Upload → S3 Standard（7 天）→ S3 Standard-IA（1 年）→ S3 Glacier

成本估算（每月）：
  Hot:  420TB × $0.023/GB = ~$9,660/mo
  Warm: 22PB × $0.0125/GB = ~$275,000/mo
  Cold: 50PB+ × $0.004/GB = ~$200,000/mo
  → 總儲存成本：~$500K/mo（這還只是存儲，不含 CDN 出口費用）
```

### CDN 策略

```
Instagram 是 media-heavy workload，CDN 是生命線：

多層 CDN 架構：
  L1: Edge PoP（全球 200+ 節點）→ cache 最熱門的內容
  L2: Regional PoP（~20 個區域節點）→ cache warm content
  L3: Origin Shield（1-2 個節點）→ 擋住對 S3 的直接請求

Cache Key 設計：
  /{post_id}/{size}/{version}
  例：/post_abc123/640/v2

Cache 命中率目標：
  Feed 中的圖片：> 95%（因為 feed 中的 posts 被大量用戶同時瀏覽）
  Profile 頁面舊照片：~60-70%（長尾內容，CDN cache 可能已過期）
  → 對於 cache miss：Origin Shield 擋住大部分 thundering herd

頻寬估算：
  500M DAU × avg 50 photos viewed × avg 80KB = ~2PB/day outbound
  CDN 出口費用 ~$0.02/GB = ~$40K/day = ~$1.2M/mo
```

---

## 8. Like / Comment 系統

### Like 計數器：Redis + 非同步刷盤

```
Like 是 Instagram 最高頻的操作之一：
  估算：500M DAU × 10 likes/day = 5B likes/day → ~58K likes/sec

即時寫 DB 的問題：
  58K writes/sec to MySQL → 吃不消（尤其是更新同一行的 like_count）

解法：Redis 計數器 + 非同步 flush

Like 寫入 path：
  1. INCR post_likes:{post_id}        ← Redis，原子操作，< 1ms
  2. SADD liked_by:{post_id} {user_id} ← 記錄誰 liked（防重複）
  3. 每 30 秒批次 flush：
     → 從 Redis 讀取 dirty counters
     → UPDATE posts SET like_count = {value} WHERE post_id = {id}
     → 一次 batch update 幾千筆

Unlike path：
  1. DECR post_likes:{post_id}
  2. SREM liked_by:{post_id} {user_id}

「我有沒有 like 過這則貼文？」：
  → SISMEMBER liked_by:{post_id} {user_id} → O(1)
  → 如果 Set 太大（百萬 likes），用 Bloom Filter 先擋
```

### Comment 系統

```
Instagram comments 是扁平結構（不像 Reddit 的巢狀樹）：

comments:
  comment_id    BIGINT PRIMARY KEY (Snowflake)
  post_id       BIGINT
  user_id       BIGINT
  content       VARCHAR(2200)
  created_at    TIMESTAMP

  INDEX idx_post_comments (post_id, created_at DESC)

讀取：
  SELECT * FROM comments WHERE post_id = X ORDER BY created_at DESC LIMIT 20
  → cursor-based pagination

Sharding：
  Shard by post_id → 同一篇 post 的 comments 在同一個 shard
  → 讀取不需要 scatter-gather

Comment count：
  同樣用 Redis counter（跟 like 一樣的 pattern）
  INCR post_comments:{post_id}
```

---

## 9. Direct Messages（簡要）

```
DM 架構關鍵元件：

連線管理：
  Client ←→ WebSocket Gateway ←→ Message Service

發送訊息：
  1. Client → WebSocket Gateway → Message Service
  2. Message Service → 寫入 Message Store (Cassandra, partition by conversation_id)
  3. Message Service → 查收件者是否在線 (Presence Service)
     → 在線：透過 WebSocket Gateway 即時推送
     → 離線：push notification (APNs/FCM)

Message Store：
  Cassandra 選型理由：
  - 寫入密集（append-only messages）
  - 按 conversation_id partition → 同一對話在同一節點
  - Time-series 友善（按時間排序的訊息）

E2E Encryption（端到端加密）：
  Instagram DM 支援可選的 E2E encryption
  → Server 只存密文，無法讀取內容
  → Key exchange via Signal Protocol
```

---

## 10. 資料模型與 Sharding 策略

### 核心 Tables

```sql
-- 用戶
users:
  user_id       BIGINT PRIMARY KEY
  username      VARCHAR(30) UNIQUE
  bio           VARCHAR(150)
  profile_pic   VARCHAR(500)     -- CDN URL
  follower_count  INT
  following_count INT
  post_count    INT
  created_at    TIMESTAMP

-- 貼文
posts:
  post_id       BIGINT PRIMARY KEY    -- Snowflake ID
  user_id       BIGINT
  caption       VARCHAR(2200)
  media_urls    JSON                   -- [{"url": "...", "type": "image", "size": "640"}]
  location      POINT                  -- 地理位置 (optional)
  like_count    INT
  comment_count INT
  created_at    TIMESTAMP
  INDEX idx_user_posts (user_id, created_at DESC)

-- Follow 關係
follows:
  follower_id   BIGINT
  followee_id   BIGINT
  created_at    TIMESTAMP
  PRIMARY KEY (follower_id, followee_id)
  INDEX idx_followee (followee_id)

-- Likes
likes:
  user_id       BIGINT
  post_id       BIGINT
  created_at    TIMESTAMP
  PRIMARY KEY (user_id, post_id)
  INDEX idx_post_likes (post_id, created_at DESC)

-- Stories
stories:
  story_id      BIGINT PRIMARY KEY
  user_id       BIGINT
  media_url     VARCHAR(500)
  media_type    ENUM('image', 'video')
  created_at    TIMESTAMP
  expires_at    TIMESTAMP              -- created_at + 24h
  INDEX idx_user_stories (user_id, created_at DESC)
```

### Sharding 策略

```
Posts: Shard by user_id
  → User Profile 頁面只查一個 shard（SELECT WHERE user_id = X）
  → Feed ranking 時需要跨 shard（但已由 candidate generation cache 預處理）

Follows: Shard by follower_id
  → 「我 follow 了誰」只查一個 shard
  → 「誰 follow 了我」需要 scatter-gather → 用 Redis cache 加速

Likes: Shard by post_id
  → 「這篇 post 有誰 liked」只查一個 shard
  → 「我 liked 了哪些 posts」需要 secondary index or 另一份 shard by user_id

Comments: Shard by post_id
  → 同一篇 post 的 comments 在同一個 shard

Stories: Shard by user_id
  → 但 active stories 主要在 Redis，MySQL 只做持久化備份
```

---

## 11. Notification Service

```
觸發條件與優先級：

HIGH priority（即時推送）：
  - DM 訊息
  - Live 開播通知（已開啟通知的 followees）
  - @mention in post/story

MEDIUM priority（聚合後推送）：
  - Like（「Alice 和其他 99 人 liked 你的照片」→ 聚合）
  - Comment
  - New follower

LOW priority（in-app only）：
  - 推薦（「你可能認識 Alice」）
  - 產品功能更新

架構：
  Event Sources → Kafka topic: notifications.raw
    │
    ▼
  Notification Aggregation Service
  （5 分鐘 window，聚合同類 events）
  例：100 個 likes → 1 條通知「Alice 和其他 99 人 liked 你的照片」
    │
    ▼
  Notification Delivery Service
  ├── Push: APNs (iOS) / FCM (Android) → 單日推送量 ~2B
  ├── In-app: Redis list → notifications:{user_id}
  └── Email: (low priority, batch)

Rate limiting：
  每個 user 每小時最多 N 條 push notification
  → 避免刷屏（爆紅貼文不會觸發 10000 條 push）
```

---

## 12. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 500M |
| Photos uploaded/day | 100M → **~1.2K/sec** |
| Stories created/day | 500M → **~5.8K/sec** |
| Feed reads/day | 10B → **~115K/sec** |
| Likes/day | 5B → **~58K/sec** |
| Avg photo size (original) | 2MB |
| Processed sizes per photo | 3 (150px ~15KB, 640px ~80KB, 1080px ~200KB) |
| New media storage/day | 100M × (2MB + 300KB) = **~230TB/day raw + processed** |
| New media storage/year | ~84PB |
| CDN outbound/day | 500M DAU × 50 photos × 80KB = **~2PB/day** |
| Redis (timeline candidates) | 500M users × 2KB avg = **~1TB** |
| Redis (stories) | Active stories + viewer tracking = **~500GB** |
| Redis (like counters) | ~1B active posts × 16B = **~16GB** |
| ML ranking GPU instances | ~5000 (for feed + explore ranking) |

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 照片上傳模式 | **Pre-signed URL 直傳 S3** | API Server 不處理大檔案，避免成為瓶頸 |
| 媒體處理 | **非同步 pipeline (Kafka + Workers)** | 上傳即時回應 < 500ms，處理在背景完成 |
| Feed 排序 | **ML-ranked (非 chronological)** | 提升 engagement，但需要 GPU inference infrastructure |
| Feed cache 策略 | **Hybrid: 預計算 candidates + 按需 fine ranking** | 純預計算無法反映即時 context；純按需太貴 |
| Stories 儲存 | **Redis with TTL + S3 Archive** | 24h TTL 天然適合 Redis；過期自動清理 |
| Like 計數器 | **Redis counter + 非同步 flush to DB** | 58K writes/sec 直接打 DB 會崩 |
| Storage 分層 | **Hot/Warm/Cold (S3 Standard → IA → Glacier)** | 媒體成本是最大支出，分層省 ~60% 儲存費用 |
| Comment 結構 | **扁平結構（非巢狀）** | 簡化查詢、sharding、UI rendering |
| DM 儲存 | **Cassandra (partition by conversation)** | 寫入密集 + time-series friendly |
| Content moderation | **Two-pass: hash matching (sync) + ML (async)** | 已知違規即時攔截；新型違規非同步分類 |

---

## 14. 面試常見 Follow-up

### Q: Feed ranking 的冷啟動問題？新用戶沒有互動歷史怎麼排？

```
新用戶冷啟動策略：

1. Registration-time signals：
   - 連結通訊錄 → 推薦已有帳號的朋友 → 初始 follow 關係
   - 選擇興趣標籤 → 初始 interest vector

2. Popularity-based fallback：
   - 沒有個人化 features 時 → 用 global popularity ranking
   - 熱門 posts（高 engagement rate）排前面

3. 快速學習（Exploration-Exploitation）：
   - 前 7 天內穿插不同類型內容（explore）
   - 根據互動即時更新 user embedding（exploit）
   - ~50 次互動後，ranking quality 接近成熟用戶
```

### Q: 如果一張照片突然爆紅（viral），CDN 如何應對？

```
Thundering Herd 防護：

1. CDN Origin Shield：
   - 所有 cache miss 先打 Origin Shield（而非直接打 S3）
   - Origin Shield 一次拉取 → 扇出到所有 edge PoP
   - 防止 S3 被 100 個 edge 同時請求同一張圖

2. Request Coalescing：
   - 同一個 edge PoP 在 cache miss 時，合併相同 key 的請求
   - 只發一個請求到 origin，其他等待結果 → 大幅降低 origin 負載

3. Pre-warming：
   - 當 engagement rate 異常飆升 → 預測可能 viral
   - 主動推送到主要 edge PoP（不等 cache miss）
```

### Q: 如何保證 "unlike" 後立即反映在 UI 上？

```
Optimistic UI + Eventual Consistency：

1. Client 端 optimistic update：
   - 點 unlike → UI 立即更新（like count - 1，heart 變灰）
   - 非同步發 API call

2. Server 端：
   - DECR post_likes:{post_id} in Redis（< 1ms）
   - SREM liked_by:{post_id} {user_id}
   - 非同步 flush to DB

3. 如果 API call 失敗：
   - Client 偵測到 failure → 回滾 UI（re-like）
   - 重試 3 次 with exponential backoff

4. 其他用戶看到的 like count 可能有 ~30 秒延遲（DB flush interval）
   → 對社群應用完全可以接受
```

### Q: Stories 過期後的清理如何做？不會一次刪除大量資料？

```
TTL-based 自然清理（不需要 batch job）：

Redis 層：
  每個 story 設定 EXPIREAT → Redis 自動清理
  → 過期自然分散（不是同一時間全部過期）

S3 層：
  S3 Lifecycle Policy：
  - 24h 後 transition to Glacier（archive for 作者）
  - 或 30 天後 delete（如果作者選擇不保留）
  → S3 lifecycle 是背景任務，不影響線上服務

Viewer tracking（Redis Set）：
  story_viewers:{story_id} → TTL 24h → 自動清理
  → 與 story 同步過期
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU 500M、100M photos/day、feed reads 115K/sec、強調 media-heavy 與 Twitter 的差異
2. **照片上傳管線（核心）**（3 分鐘）— Pre-signed URL 直傳、非同步處理 3 種尺寸、content moderation two-pass
3. **Feed Ranking（核心）**（4 分鐘）— 為什麼不能像 Twitter 直接 fan-out on write → 三階段 ranking pipeline → candidate cache + on-demand fine ranking 的 hybrid 策略
4. **Stories 架構**（2 分鐘）— Redis TTL、viewer tracking、story tray 排序
5. **Media Storage + CDN**（2 分鐘）— Hot/Warm/Cold 三層、CDN multi-tier、thundering herd 防護
6. **Like/Comment + Notification**（1 分鐘）— Redis counter + async flush pattern
7. **Deep Dive（面試官選）**（2 分鐘）— Explore 推薦系統、DM、Content Moderation、Viral content handling
