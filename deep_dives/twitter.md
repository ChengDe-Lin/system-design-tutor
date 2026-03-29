# Twitter (X) — 社群動態推文系統架構

## 1. 核心挑戰

Twitter 的設計核心是 **Timeline（動態牆）的生成效率**：

```
規模：
  DAU: ~300M
  Tweets/day: ~500M → ~6K tweets/sec
  Timeline reads/day: ~30B → ~350K reads/sec
  Follow 關係: 平均每人 follow 200 人，少數人（明星）有千萬+ followers

Read:Write ratio ≈ 60:1（讀 timeline >> 發 tweet）

核心矛盾：
  - 發 tweet 的人少，但每條 tweet 可能要出現在百萬人的 timeline 上
  - 讀 timeline 的人多，但要在 < 200ms 內組裝好一個人的 timeline
```

---

## 2. 整體架構

```
┌──────────┐                                    ┌──────────────────┐
│ Client   │──post tweet──▶ Tweet Service ──▶   │ Tweet Store      │
│          │                    │                │ (MySQL sharded)  │
│          │                    │                └──────────────────┘
│          │                    │
│          │                    ▼
│          │              Fan-out Service ──▶ Home Timeline Cache
│          │              (async, Kafka)      (Redis, per-user)
│          │                    │
│          │                    │ query followers
│          │                    ▼
│          │              Social Graph Service
│          │              (who follows whom)
│          │
│          │──read timeline──▶ Timeline Service
│          │                    │
│          │                    ├──▶ Home Timeline Cache (Redis)
│          │                    └──▶ Tweet Store (hydrate tweet content)
│          │
│          │──search──▶ Search Service (Elasticsearch / Earlybird)
│          │
│          │──follow──▶ Social Graph Service (MySQL + cache)
└──────────┘
```

---

## 3. 核心設計決策：Fan-out on Write vs Fan-out on Read

這是 Twitter 面試的 **第一個必答問題**。

### Fan-out on Read（Pull Model）

```
發 tweet 時：
  只寫一次到 Tweet Store

讀 timeline 時：
  1. 查 Social Graph：「我 follow 了誰？」→ [user_A, user_B, user_C, ...]
  2. 去 Tweet Store 查每個人的最新 tweets
  3. 合併排序 → 回傳 top N

Timeline = SELECT * FROM tweets
           WHERE user_id IN (my_followings)
           ORDER BY created_at DESC
           LIMIT 50
```

| 優點 | 缺點 |
|------|------|
| 寫入極快（一次 write） | 讀取慢（follow 200 人 = 查 200 次 + merge sort） |
| 無浪費（不活躍用戶不佔空間） | p99 latency 高（follow 多的人更慢） |
| 即時（發了就能被看到） | DB fan-out 在高 QPS 下扛不住 |

### Fan-out on Write（Push Model）← Twitter 主要採用

```
發 tweet 時：
  1. 寫入 Tweet Store
  2. 查 Social Graph：「誰 follow 了我？」→ [follower_1, follower_2, ...]
  3. 把 tweet_id 推到每個 follower 的 Home Timeline Cache（Redis List）

讀 timeline 時：
  直接讀 Redis List → 拿到 tweet_id list → hydrate tweet content
  → O(1) 讀取，超快
```

| 優點 | 缺點 |
|------|------|
| **讀取極快（Redis LRANGE，< 5ms）** | 寫入放大（1 條 tweet → N 個 follower 的 cache 都要寫） |
| 讀 path 簡單、latency 穩定 | 明星問題（1 條 tweet → 千萬次寫入） |
| 可以預計算 timeline | 浪費空間（不活躍用戶的 cache 也佔空間） |

### Twitter 的實際做法：Hybrid

```
普通用戶（followers < 10K）：Fan-out on Write
  → 發 tweet 時推到所有 follower 的 timeline cache

明星用戶（followers > 10K）：Fan-out on Read
  → 不推。讀 timeline 時即時拉取明星的最新 tweets，merge 進去

讀 timeline 時：
  1. 從 Redis 拿預計算的 timeline（已包含普通用戶的 tweets）
  2. 查明星用戶的最新 tweets（fan-out on read）
  3. Merge sort → 回傳
```

### 為什麼 10K 是分界線？

```
普通用戶發 tweet → fan-out 到 200 followers → 200 次 Redis write
  → 200 × 6K tweets/sec = ~1.2M Redis writes/sec → 可以扛

如果明星（50M followers）也 fan-out：
  1 條 tweet → 50M 次 Redis write
  → 光一條 tweet 就要寫幾十秒（unacceptable）
  → 而且明星的 tweet 會觸發大量同時 fan-out，互相搶資源

10K 分界線讓 99% 的 tweets 走 push（fast read），
只有 1% 走 pull（明星），merge 時多查幾個人而已。
```

---

## 4. Home Timeline Cache（Redis）

### 資料結構

```
每個 user 一個 Redis List：

Key: timeline:{user_id}
Value: [tweet_id_1, tweet_id_2, ..., tweet_id_800]
  → 只存 tweet_id（8 bytes），不存 tweet 內容
  → 最多保留 800 條（更早的截斷）

每次 fan-out：
  LPUSH timeline:{follower_id} {tweet_id}
  LTRIM timeline:{follower_id} 0 799   ← 保持最多 800 條
```

### 為什麼只存 tweet_id 不存 tweet 內容？

```
如果存完整 tweet（text + metadata ≈ 1KB）：
  300M users × 800 tweets × 1KB = 240TB → Redis 放不下

如果只存 tweet_id（8 bytes）：
  300M users × 800 × 8B = 1.9TB → 合理（Redis cluster 幾十個節點）

讀取時：
  1. LRANGE timeline:{user_id} 0 49 → 拿 50 個 tweet_ids
  2. MGET tweet:{id1} tweet:{id2} ... → 從 Tweet Cache 批次拿內容
  3. 組裝回傳

多一次 round trip，但省了 100 倍空間。
```

### Redis Cluster Sizing

```
300M users × 800 tweet_ids × 8 bytes = ~1.9TB

Redis 每節點建議 < 100GB memory：
  → ~20 個 Redis 節點（primary）
  → 每個 primary 配 1-2 個 replica
  → 共 40-60 個 Redis instances

Sharding: hash(user_id) % N → 哪個 shard
```

---

## 5. Fan-out Service

### 架構

```
User 發 tweet
  │
  ▼
Tweet Service
  ├── 寫入 Tweet Store（同步，確認成功才回 200）
  └── 發 event 到 Kafka（非同步）
         │
         ▼
    Fan-out Workers（consume from Kafka）
      1. 查 Social Graph：follower list of tweet author
      2. 過濾：follower 是明星？→ 跳過（fan-out on read）
      3. 對每個 follower：LPUSH + LTRIM 到 Redis timeline
      4. 通知 Notification Service（@mention, reply 等）
```

### 為什麼用 Kafka 非同步？

```
同步 fan-out 的問題：
  User 發 tweet → 等 fan-out 完成 → 回 200
  如果有 10K followers → fan-out 需要幾秒 → 使用者等幾秒才看到「發送成功」

非同步：
  User 發 tweet → 寫 Tweet Store → 立即回 200（< 100ms）
  Fan-out 在背景慢慢做（使用者不感知）

使用者能接受嗎？
  → 你的 follower 晚 1-2 秒看到你的 tweet → 完全可以接受
  → 但你自己的 User Timeline 是直接從 Tweet Store 讀的（不經過 fan-out）
     → 你自己發完立刻能看到
```

---

## 6. Tweet Store

### 資料模型

```sql
tweets:
  tweet_id      BIGINT PRIMARY KEY   -- Snowflake ID（時間排序 + 全局唯一）
  user_id       BIGINT
  content       VARCHAR(280)
  media_urls    JSON                  -- ["https://cdn.../img1.jpg"]
  reply_to      BIGINT               -- NULL if not a reply
  retweet_of    BIGINT               -- NULL if not a retweet
  like_count    INT
  retweet_count INT
  reply_count   INT
  created_at    TIMESTAMP

INDEX idx_user_timeline (user_id, created_at DESC)  -- User Timeline 查詢
```

### Sharding

```
Shard by tweet_id（not user_id）：
  → tweet_id 用 Snowflake，天然含時間 → 可以按時間範圍做 range sharding
  → 新 tweets 集中在最新的 shard（hot shard）→ 但 write 不算多（~6K/sec）

或者 Shard by user_id：
  → User Timeline 查詢只打一個 shard（SELECT WHERE user_id = X）
  → 但 fan-out on read 時需要 scatter-gather（查多個 user 的 tweets）

Twitter 實際用法：按 tweet_id range shard
  → 配合 Home Timeline Cache 已經預計算好，不需要跨 shard 查詢
  → User Timeline 靠 secondary index（user_id, created_at）
```

---

## 7. Social Graph Service

### 資料模型

```sql
follows:
  follower_id   BIGINT
  followee_id   BIGINT
  created_at    TIMESTAMP
  PRIMARY KEY (follower_id, followee_id)

-- 兩個方向的查詢都需要：
INDEX idx_followers (followee_id)    -- 「誰 follow 了我」→ fan-out 用
INDEX idx_following (follower_id)    -- 「我 follow 了誰」→ timeline merge 用
```

### Cache

```
Fan-out 時需要快速查「某人的所有 followers」：
  → Redis Set: followers:{user_id} → {follower_1, follower_2, ...}
  → 明星有 50M followers → 這個 Set 很大 → 分頁處理

Follow/Unfollow 時：
  → 寫 DB + 更新 Redis Set（SADD / SREM）
  → Unfollow 後需要從 follower 的 timeline cache 移除該人的 tweets
    （或 lazy：下次讀 timeline 時過濾掉已 unfollow 的人的 tweets）
```

---

## 8. User Timeline vs Home Timeline

```
User Timeline（某人的個人頁面）：
  → 直接查 Tweet Store：SELECT * FROM tweets WHERE user_id = X ORDER BY created_at DESC
  → 可以加 cache（Redis sorted set 或 list）
  → 簡單、不涉及 fan-out

Home Timeline（首頁動態牆）：
  → 從 Redis Timeline Cache 讀取（fan-out on write 的結果）
  → Merge 明星用戶的最新 tweets（fan-out on read）
  → 這是整個系統最複雜的部分
```

---

## 9. Search（搜尋 / 趨勢）

### Tweet Search

```
Tweet 發佈時：
  → 同步寫 Tweet Store
  → 非同步 index 到搜尋引擎（Elasticsearch / Twitter 自建的 Earlybird）

搜尋引擎：
  → Inverted index: keyword → [tweet_id_1, tweet_id_2, ...]
  → 支援 full-text search、hashtag search、@mention search
  → 按 relevance + recency 排序
```

### Trending Topics

```
Streaming pipeline（Kafka → Flink/Spark Streaming）：
  1. 從 tweet stream 提取 hashtags 和 keywords
  2. Sliding window 計算（過去 1 小時的 tweet 量）
  3. 跟歷史基線比較 → 異常爆發 = trending
  4. 按地區分群（台灣 trending ≠ 美國 trending）

Storage：
  → Redis sorted set: trending:{region} → [(topic, score), ...]
  → 每幾分鐘更新一次
  → CDN cache（trending 頁面不需要即時精確）
```

---

## 10. Media 處理

```
Tweet 附帶圖片 / 影片：

上傳 Flow：
  1. Client 先上傳 media 到 Upload Service → 回傳 media_id
  2. Client 發 tweet 時帶 media_ids
  3. Upload Service 非同步處理：
     - 圖片：resize（thumbnail, medium, full）、壓縮、CDN
     - 影片：transcode（多碼率 HLS/DASH）、CDN

Storage：
  原始檔案 → Object Storage（S3）
  處理後 → CDN 分發
  metadata（media_id, type, urls）→ Media DB

media 不存在 Tweet Store 裡：
  tweet.media_urls = ["https://pbs.twimg.com/media/xxx.jpg"]
  → 跟 Dropbox 一樣的 metadata vs block 分離原則
```

---

## 11. Notification Service

```
觸發條件：
  - 有人 @mention 你
  - 有人 like / retweet 你的 tweet
  - 有人 reply 你的 tweet
  - 有人 follow 你

架構：
  各 Service → publish event to Kafka → Notification Service consume
    → 查收件者的 notification preference（email? push? in-app?）
    → 發送（push notification via APNs/FCM, email, in-app badge）

in-app notification：
  → Redis List: notifications:{user_id} → [event_1, event_2, ...]
  → 跟 timeline cache 一樣的結構
```

---

## 12. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 300M |
| Tweets/day | 500M → **~6K tweets/sec** |
| Timeline reads/day | 30B → **~350K reads/sec** |
| Avg followers per user | 200 |
| Fan-out writes/sec | 6K × 200 = **~1.2M Redis writes/sec** |
| Tweet size（text + metadata） | ~1KB |
| Tweet storage/day | 500M × 1KB = **500GB/day** |
| Tweet storage/year | ~180TB |
| Timeline cache（Redis） | 300M users × 800 × 8B = **~1.9TB** |
| Redis nodes（timeline） | ~20 primary + 20 replica = **40 nodes** |
| Media storage/day | ~100M media × 2MB avg = **200TB/day** |

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Fan-out 策略 | **Hybrid**（普通 push + 明星 pull） | 普通用戶 push 保證讀取快；明星 pull 避免寫入爆炸 |
| Timeline cache 存什麼 | **只存 tweet_id** | 存完整 tweet = 240TB，只存 id = 1.9TB |
| Fan-out 同步 or 非同步 | **非同步（Kafka）** | 發 tweet 立即回應，fan-out 延遲 1-2 秒可接受 |
| Tweet ID 生成 | **Snowflake** | 全局唯一 + 時間排序 + 分散式生成 |
| Trending 計算 | **Streaming pipeline** | 需要 sliding window + 異常偵測，不是簡單的 COUNT |
| Media storage | **Object Storage + CDN** | 跟 tweet 資料分離，獨立 scale |

---

## 14. 面試常見 Follow-up

### Q: 如果一個用戶 follow 了 10K 人，Home Timeline 怎麼辦？

```
Fan-out on write 已經處理了：
  那 10K 人每次發 tweet 都會推到你的 timeline cache
  你讀的時候只需要 LRANGE → 極快

問題是：你的 timeline cache 更新頻率很高
  10K followings × 平均 5 tweets/day = 50K writes/day 到你的 cache
  → 但 Redis 完全扛得住
```

### Q: 刪除 tweet 怎麼處理？

```
1. 從 Tweet Store 標記 deleted（soft delete）
2. 從搜尋引擎移除
3. Timeline cache 不主動清理（lazy deletion）：
   → 讀 timeline 時，hydrate tweet content 發現 deleted → 跳過
   → 或者非同步 fan-out 一個 DELETE event → 從所有 follower cache 移除
   → 後者更乾淨但成本高（跟發 tweet 一樣的 fan-out 量）
```

### Q: 怎麼做 infinite scroll / pagination？

```
Cursor-based pagination（不用 offset）：

GET /timeline?cursor=tweet_id_123&count=20
  → 回傳 tweet_id_123 之後的 20 條
  → 下一頁：cursor = 最後一條的 tweet_id

為什麼不用 offset？
  → Timeline 持續更新，offset 會重複或跳過
  → Cursor 指向固定的位置，不受新增 tweets 影響
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU、tweet QPS、timeline read QPS、fan-out 放大倍率
2. **Fan-out 策略（核心）**（4 分鐘）— 先講 fan-out on write 和 on read 的 trade-off，然後推導出 hybrid approach，解釋 10K 分界線
3. **Timeline Cache（Redis）**（2 分鐘）— 只存 tweet_id、LPUSH + LTRIM、Redis cluster sizing
4. **Fan-out Service（Kafka 非同步）**（1 分鐘）— 為什麼非同步、使用者體驗不受影響
5. **Tweet Store + Social Graph**（1 分鐘）— Sharding 策略、Snowflake ID
6. **Deep Dive（面試官選）**（2 分鐘）— Search/Trending、Media、Notification、Celebrity problem
