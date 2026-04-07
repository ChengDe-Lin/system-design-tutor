# Chat System (WhatsApp / Slack) — 即時通訊系統架構

## 1. 核心挑戰

Chat 系統的設計核心是 **即時性（Real-time Delivery）** 與 **可靠性（Message Reliability）**：

```
規模（以 WhatsApp 為參考）：
  DAU: ~500M
  Messages/day: ~100B → ~1.15M messages/sec
  1:1 chats 佔 80%，Group chats 佔 20%
  平均 group 大小: 10 人，最大: 500-1000 人
  同時在線連接數（Concurrent WebSocket connections）: ~200M
  Media messages: ~20% 含圖片/影片/語音

Read:Write ratio ≈ 1:1（不像 Twitter 偏讀，Chat 幾乎每條都要讀）

核心矛盾：
  - 要在 < 100ms 內送達訊息（使用者感知即時）
  - 同時要保證訊息不丟失（at-least-once delivery + 冪等去重，從使用者角度達到 effectively exactly-once）
    （分散式環境下真正的 exactly-once delivery 在傳輸層不可行，實務上用 client_msg_id 做冪等去重）
  - 離線用戶上線後要能同步所有漏掉的訊息
  - 要支援多裝置同步（手機 + 桌面 + Web）
```

---

## 2. 整體架構

```
┌──────────┐   WebSocket    ┌───────────────────┐
│ Client A │◄──────────────▶│  Connection       │
│ (sender) │                │  Gateway          │◄─── Stateful: 維護
└──────────┘                │  (WebSocket Srv)  │     user↔server 映射
                            └──────┬────────────┘
                                   │
                                   ▼
┌──────────┐   WebSocket    ┌──────────────┐    ┌──────────────────┐
│ Client B │◄──────────────▶│  Connection  │    │  Chat Service    │
│ (recvr)  │                │  Gateway     │◄───│  (Stateless)     │
└──────────┘                └──────────────┘    │  - 路由訊息      │
                                                │  - 寫入 DB       │
                                                │  - 觸發通知      │
                                                └──────┬───────────┘
                                                       │
                    ┌──────────────────────────────────┼──────────────────┐
                    │                                  │                  │
                    ▼                                  ▼                  ▼
           ┌───────────────┐                ┌──────────────┐   ┌─────────────────┐
           │ Message Store │                │ Presence     │   │ Push Notification│
           │ (Cassandra /  │                │ Service      │   │ Service          │
           │  HBase)       │                │ (Redis)      │   │ (APNs / FCM)    │
           └───────────────┘                └──────────────┘   └─────────────────┘
                    │
                    ▼
           ┌───────────────┐    ┌──────────────┐    ┌─────────────────┐
           │ Media Service │    │ Search       │    │ Group Service   │
           │ (S3 + CDN)   │    │ Service (ES) │    │ (成員管理)      │
           └───────────────┘    └──────────────┘    └─────────────────┘
```

---

## 3. 核心設計決策：連線管理（Connection Gateway）

這是 Chat 系統 **最獨特的挑戰**——所有其他系統（Twitter、Instagram）都是 HTTP request-response，但 Chat 需要 **Server Push**。

### 選項比較

| 方案 | Latency | 伺服器資源 | 實作複雜度 | 適用場景 |
|------|---------|-----------|-----------|---------|
| HTTP Polling | 依 polling interval（1-5s） | 高（大量空 request） | 低 | 不適合 chat |
| Long Polling | 數百 ms | 中（hold connection） | 中 | 可接受但非最佳 |
| **WebSocket** | **< 50ms** | **低（persistent conn）** | **高** | **Chat 首選** |
| Server-Sent Events (SSE) | < 50ms | 低 | 中 | 單向推送可，但 Chat 需雙向 |

### WebSocket 選擇的關鍵原因

```
HTTP Polling 的問題：
  200M 在線用戶 × 每 3 秒 poll 一次 = 66M requests/sec（純浪費）
  其中 90% 回傳「沒有新訊息」→ 浪費 bandwidth + 伺服器 CPU

WebSocket 的優勢：
  1. 一次 handshake 後保持長連接 → 省去 TCP + TLS handshake 開銷
  2. 雙向推送 → server 有訊息時主動 push，不需要 client 去問
  3. 每條訊息 overhead 只有 2-6 bytes frame header（vs HTTP 的 ~500 bytes headers）

  200M 並發 WebSocket 連接：
    每個連接 ~20-50KB memory（kernel socket buffer + app state）
    ⚠️ Linux 預設 socket buffer 為 128-256KB（send + recv 合計），
      必須調小 SO_SNDBUF/SO_RCVBUF（例如各 4KB）才能壓到此範圍
    以 ~30KB 估算：200M × 30KB = 6TB memory
    單機支持 ~500K connections（C10M 架構）
    → 需要 ~400 台 Gateway server（每台 ~15GB 用於連接記憶體）
```

### Connection Gateway 架構

```
Client 連接流程：
  1. Client → Load Balancer → 分配到某台 Gateway（sticky session by user_id）
  2. Gateway 驗證 auth token → 建立 WebSocket
  3. Gateway 在 Redis 註冊映射：user_id → gateway_server_id
     SET conn:{user_id} gateway-07 EX 300   ← 5 分鐘 TTL，靠 heartbeat 續期

訊息路由：
  Client A 發訊息給 Client B：
  1. A 的訊息到達 A 所在的 Gateway
  2. Gateway → Chat Service（stateless）
  3. Chat Service 查 Redis：conn:{B} → gateway-12
  4. Chat Service 把訊息送到 gateway-12
  5. gateway-12 透過 WebSocket push 給 B

如果 B 不在線（Redis 查不到 conn:{B}）：
  → 訊息存入 offline queue + 觸發 Push Notification
```

### Gateway 間通訊：用什麼？

```
方案 1: HTTP call（gateway-07 → gateway-12）
  → 簡單但增加一次 network hop + HTTP overhead

方案 2: Pub/Sub（每台 gateway subscribe 自己的 channel）
  → Chat Service publish 到 gateway-12 的 channel
  → Gateway-12 收到後 push 給 user B
  → Redis Pub/Sub 或 Kafka topic-per-gateway

實務選擇：Kafka + per-gateway topic
  → 每台 Gateway 訂閱自己的 topic：messages.gateway-12
  → Chat Service 寫入對應 topic → Gateway consume → push to client
  → 好處：Gateway crash 後重啟不會丟訊息（Kafka 有 retention）
```

---

## 4. 訊息收發流程與可靠性保證

### 訊息 ID 設計

```
需求：
  - 全局唯一（避免重複）
  - 同一個 conversation 內可排序
  - 不需要全局排序（Chat 只要 per-conversation ordering）

方案：conversation_id + 單調遞增 sequence number

message_id = {conversation_id}_{seq_num}
  → conversation_id 由建立對話時生成（UUID 或 Snowflake）
  → seq_num 由 Chat Service 透過 conversation-level counter 生成
  → 使用 Redis INCR conversation_seq:{conv_id} → atomic, 極快
    ⚠️ 耐久性風險：Redis AOF 預設每秒 fsync，crash 時最多丟失 1 秒的 seq_num
    緩解方案：(1) 使用 AOF always 模式（犧牲吞吐量），或
              (2) 接受罕見的 seq gap，應用層在 recovery 時偵測並修補

為什麼不用全局 Snowflake？
  → Chat 不需要跨 conversation 排序
  → 每個 conversation 獨立的 seq 更簡單，且能讓 client 知道「我是否漏了訊息」
     （如果收到 seq 5 後直接收到 seq 8 → 知道漏了 6, 7）
```

### 送達確認三階段

```
       Sent          Delivered        Read
Client A ──────▶ Server ──────▶ Client B ──────▶ Client B 開啟對話

  ✓ (單勾)       ✓✓ (雙勾)       ✓✓ 藍勾

1. Sent（已送達 Server）：
   A 送出 → Server 寫入 DB 成功 → 回 ACK 給 A → A 顯示 ✓
   如果 A 沒收到 ACK → Client 重試（用 client_msg_id 做 idempotency）

2. Delivered（已送達 B 的裝置）：
   Server push 給 B → B 的 Client 收到 → B 送 delivery_ack 回 Server
   → Server 更新 message status = DELIVERED
   → Server push status_update 給 A → A 顯示 ✓✓

3. Read（B 已讀）：
   B 開啟對話 → B 的 Client 送 read_ack(conversation_id, last_read_seq=42)
   → Server 更新 → push 給 A → A 顯示藍勾
   → 用 last_read_seq 而非逐條 ack → 減少 ack 數量
```

### Idempotency 保證

```
問題：Client A 送訊息 → Server 寫入成功 → ACK 在網路中丟失 → A 重試 → 重複訊息

解法：Client 生成 client_msg_id（UUID），Server 用它做 dedup

INSERT INTO messages (msg_id, conv_id, client_msg_id, ...)
  → 對 (conv_id, client_msg_id) 加 UNIQUE constraint
  → 重試時 INSERT 會因為 duplicate key 而被忽略
  → Server 回傳已存在的 msg_id 給 Client
```

---

## 5. 訊息存儲與分片策略

### 資料模型

```sql
messages:
  message_id      BIGINT          -- server-assigned
  conversation_id BIGINT          -- partition key
  seq_num         INT             -- per-conversation 排序
  sender_id       BIGINT
  content         TEXT            -- 加密後的密文（E2EE 場景）
  msg_type        ENUM('text','image','video','audio','file','system')
  media_url       VARCHAR(512)    -- 若有 media，指向 Object Storage
  client_msg_id   UUID            -- idempotency key
  status          ENUM('sent','delivered','read')
  created_at      TIMESTAMP
  PRIMARY KEY (conversation_id, seq_num)

conversations:
  conversation_id BIGINT PRIMARY KEY
  type            ENUM('direct','group')
  created_at      TIMESTAMP
  last_message_at TIMESTAMP       -- 用來排序對話列表

conversation_members:
  conversation_id BIGINT
  user_id         BIGINT
  joined_at       TIMESTAMP
  last_read_seq   INT             -- 已讀指標
  PRIMARY KEY (conversation_id, user_id)
  INDEX idx_user_conversations (user_id, last_message_at DESC)
```

### Sharding 策略

```
Shard by conversation_id：
  → 同一個 conversation 的所有訊息在同一個 shard
  → 查「某對話的最近 50 條訊息」只打一個 shard → 極快
  → 這是 Chat 最常見的查詢模式

為什麼不 shard by user_id？
  → 一個 user 可能在 100 個 group 裡
  → 查「某 group 的訊息」需要 scatter-gather 到多個 shard
  → Chat 的查詢 pattern 是 per-conversation 而非 per-user

為什麼不 shard by message_id？
  → 同理，查同一對話的訊息會散落各處

DB 選型：Cassandra 或 HBase
  → Wide-column store 天然適合：partition key = conversation_id, clustering key = seq_num
  → 支援 range scan：SELECT * WHERE conv_id = X AND seq_num > 100 LIMIT 50
  → 寫入快（append-only, LSM-tree）
  → WhatsApp 實際使用 Mnesia（Erlang 原生 DB），但面試講 Cassandra 更通用
```

### Hot / Cold 分離

```
觀察：80% 的讀取是最近 7 天的訊息

Hot tier（最近 30 天）：
  → SSD-backed Cassandra cluster
  → 較多 replica（RF=3），較少 node
  → 覆蓋 95% 的讀取

Cold tier（30 天以上）：
  → HDD-backed Cassandra cluster 或 Object Storage（S3）
  → 壓縮存儲，RF=2 即可
  → 讀取 latency 高但可接受（使用者滾到很舊的訊息時本就預期等待）

遷移：
  → 背景 job 定期掃描 hot tier → 將超過 30 天的 partition 搬到 cold tier
  → 在 routing layer（Chat Service）根據 seq_num 判斷去 hot 還是 cold 查詢

儲存量估算：
  100B messages/day × 100 bytes avg（加密後文本）= 10TB/day
  30 天 hot tier = 300TB
  加上 index + overhead × 3 replica → ~1PB hot storage
```

---

## 6. Group Chat：小群推送 vs 大群拉取

### Fan-out 策略

```
小群（< 200 人，覆蓋 99% 的 groups）：Push Model
  → 訊息送達 Chat Service → 查 group members → 逐個 push
  → 10 人 group = 10 次 push → 極快

大群/Channel（200-100K 人，如 Slack channel、Discord）：Pull Model
  → 不逐個 push → 只寫入 conversation partition
  → members 的 client 定期 pull 或用 cursor sync
  → 或者：只 push 一個「有新訊息」的 notification，client 自己去 fetch

為什麼 200 人分界？
  一個活躍的 200 人群：
    假設 100 條訊息/小時 → 100 × 200 = 20K push/小時 → 可接受
  一個 10K 人的 channel：
    100 條/小時 × 10K = 1M push/小時 → 一個 channel 就 1M push → 太多
    而且 10K 人不需要即時看到每條訊息（channel 模式本就非即時）
```

| 策略 | 適用場景 | Latency | 伺服器負擔 | 實現 |
|------|---------|---------|-----------|------|
| Push（write fanout） | 1:1 + 小群 (< 200人) | < 100ms | 低（少量 push） | 查 members → 逐個 push |
| Pull（read fanout） | 大群/Channel | 數秒（polling interval） | 低（按需讀取） | Client 定期 fetch new messages |
| Hybrid notification | 大群 + 需要提示 | 1-2s | 中 | Push "有新訊息" → Client fetch detail |

---

## 7. 在線狀態（Presence Service）

### 設計挑戰

```
需求：顯示「在線」「離線」「最後上線時間」
  → WhatsApp: "Last seen today at 14:32"
  → Slack: 綠點/灰點

天真做法：每秒上報 heartbeat → 500M DAU × 1 heartbeat/sec = 500M writes/sec → 爆炸

實際做法：較長間隔 heartbeat + 事件觸發
  Heartbeat interval: 30 秒
  200M 在線 / 30s = ~6.7M writes/sec → Redis 可以扛（cluster）

  Key: presence:{user_id}
  Value: {status: "online", last_seen: 1711800000}
  TTL: 60 秒（如果 60 秒沒 heartbeat → 自動過期 → 離線）
```

### 狀態變更通知

```
問題：user A 想知道 user B 何時上線
  → 不能讓每個人 subscribe 所有好友的狀態 → fan-out 爆炸

解法：Lazy pull + 小範圍 subscribe

1. 開啟對話頁面時：
   → Client 查詢對方的 presence（GET presence:{user_id}）
   → 同時 subscribe 對方的狀態變更（僅限當前開啟的對話）

2. 好友列表頁面：
   → 批次查詢好友的 presence（MGET）
   → 不 subscribe（列表頁只需要快照，不需要即時更新）

3. 狀態變更發布：
   → User B 從 offline → online → publish event 到 presence channel
   → 只有當前正在跟 B 聊天的人才會收到（subscribe 了 B 的 channel）
   → 這大幅減少了 fan-out 量
```

### Slack vs WhatsApp 的差異

```
WhatsApp: 精確 last seen 時間 → 需要記錄每次下線時間
Slack: 只需要「Active / Away」→ 更粗粒度

Slack 的 Away 判定：
  → 5 分鐘無操作 → auto-away
  → Client 側判定 + server 側 heartbeat 雙重機制
  → 更寬鬆，減少 server 負擔
```

---

## 8. 離線訊息與 Push Notification

### 離線訊息隊列

```
User B 離線時收到訊息：
  1. Chat Service 查 Redis → conn:{B} 不存在 → B 離線
  2. 訊息已寫入 Message Store（永久保存）
  3. 觸發 Push Notification Service → 透過 APNs (iOS) / FCM (Android) 推送

B 上線時的同步流程：
  1. B 建立 WebSocket → Gateway 註冊連接
  2. B 的 Client 發送 sync_request(conversations: [{conv_id: X, last_seq: 42}, ...])
  3. Chat Service 查 Message Store：
     SELECT * FROM messages WHERE conv_id = X AND seq_num > 42
  4. 回傳所有漏掉的訊息 → Client 端合併顯示

為什麼不需要額外的 offline queue？
  → Message Store 本身就是 queue → 用 last_read_seq 當 cursor
  → 不需要像 email 一樣的 inbox 概念 → 直接從 conversation partition 讀
```

### Push Notification 整合

```
Push Notification 要考慮的問題：

1. 合併通知（Notification Collapsing）：
   → 同一個群 10 條新訊息 → 不送 10 個 push → 合併成「群組 X: 10 條新訊息」
   → 用 APNs 的 collapse_id / FCM 的 collapse_key

2. Badge Count：
   → push payload 帶 badge number = 所有未讀 conversation 數
   → 需要 server 端維護 per-user unread count
   → Redis: INCR unread:{user_id}（收到訊息 +1），讀取後 reset

3. 不擾動已在線用戶：
   → 如果 B 的 WebSocket 正常連接 → 不發 push notification
   → 但 WebSocket 可能看起來連著但實際已斷（mobile 切換到背景）
   → 延遲策略：訊息 push 到 WebSocket 後等 3 秒，如果沒收到 delivery_ack → 補發 push notification

4. 速率限制：
   → 高頻群聊不能每條都 push → 每 N 秒最多 1 個 push per conversation per user
```

---

## 9. 多裝置同步（Multi-device Sync）

### Cursor-based Sync Protocol

```
每個裝置維護自己的 sync cursor：

Device sync state:
  device_id: "phone_001"
  conversations:
    conv_A: last_synced_seq = 145
    conv_B: last_synced_seq = 89

同步流程：
  1. 裝置上線 → 送 sync_request 包含每個 conversation 的 last_synced_seq
  2. Server 回傳差異：
     conv_A: messages with seq 146-152
     conv_B: messages with seq 90-91
  3. 裝置更新本地 DB + 移動 cursor

增量 vs 全量：
  - 離線 < 7 天 → 增量 sync（只拉差異）
  - 離線 > 7 天 → 全量 sync（重新拉最近 N 條 per conversation）

WhatsApp 的特殊做法：
  → 主裝置（手機）是 source of truth
  → Web/Desktop 是 companion device，從手機同步
  → 2023 年後支持獨立多裝置（Multi-device 2.0）
  → 每個裝置各自跟 server 同步，不再依賴手機
```

---

## 10. 端對端加密（End-to-End Encryption）

### Signal Protocol 基礎（面試只需講高階概念）

```
核心原理：Server 只看到密文，無法解密

Key Exchange（X3DH — Extended Triple Diffie-Hellman）：
  1. 每個用戶註冊時生成 identity key pair（長期）
  2. 上傳 signed pre-key + one-time pre-keys 到 server
  3. A 想跟 B 聊天 → 從 server 拿 B 的 public keys
  4. A 用自己的 private key + B 的 public keys 計算 shared secret
  5. B 收到第一條訊息後，用自己的 private key + A 的 public key 推導同一個 shared secret
  → Server 從頭到尾不知道 shared secret

Double Ratchet（持續更新加密金鑰）：
  → 每條訊息用不同的 message key 加密
  → Forward secrecy：即使某條訊息的 key 洩露，不能解密之前/之後的訊息
  → Key 每次都透過 ratchet 演算法推進 → 不重複

Group Chat E2EE：
  → Sender Keys protocol：群組中每人分發自己的 sender key
  → 發訊息用自己的 sender key 加密 → 群內所有人都能用該 sender key 解密
  → 成員加入/離開 → 重新生成 sender key（防止前成員解密新訊息）

對系統設計的影響：
  → Server 端搜尋不可能（密文無法 index）
  → 搜尋只能在 Client 端做（WhatsApp 就是這樣）
  → 或者放棄 E2EE，Server 端搜尋（Slack 的做法）
```

---

## 11. 訊息搜尋

### Server-side Search（非 E2EE 場景，如 Slack）

```
架構：
  訊息寫入 Message Store 的同時 → 非同步 index 到 Elasticsearch

Elasticsearch Index：
  {
    "conversation_id": 12345,
    "sender_id": 678,
    "content": "meeting at 3pm tomorrow",
    "created_at": "2024-01-15T10:30:00Z"
  }

查詢：
  POST /messages/_search
  {
    "query": {
      "bool": {
        "must": [
          {"match": {"content": "meeting"}},
          {"terms": {"conversation_id": [user 有權限的 conv_ids]}}  ← 權限過濾
        ]
      }
    },
    "sort": [{"created_at": "desc"}]
  }

權限模型：
  → 使用者只能搜到自己所在 conversation 的訊息
  → 查詢時帶入 user 的 conversation_id list 做 filter
  → Slack: workspace-wide search = 搜尋所有 public channel + 自己加入的 private channel
```

### Client-side Search（E2EE 場景，如 WhatsApp）

```
  → Client 本地 SQLite DB 建 full-text index
  → 搜尋只在裝置上進行
  → 限制：只能搜已下載到裝置的訊息
  → 換裝置時搜尋歷史消失（除非從 backup 還原）
```

---

## 12. Media 訊息處理

### 核心原則：Data Plane 與 Control Plane 分離

```
Media binary（MB~GB 級）→ 走 HTTPS upload 直傳 Object Storage
訊息 metadata（bytes 級）→ 走 WebSocket，只帶 URL reference
```

→ 不把 binary 塞進 WebSocket frame（幾 MB~幾百 MB 會阻塞連線）

### 上傳方案比較

```
方案 A：Client → Media Service → S3     （Server 代理上傳）
方案 B：Client → Pre-signed URL → S3    （Client 直傳）  ← 大規模首選
```

| 考量 | Pre-signed URL 直傳 (B) | 經過 Media Service (A) |
|------|------------------------|----------------------|
| 頻寬壓力 | Server 零負擔，S3 扛 | Server 扛全部流量 |
| 水平擴展 | S3 天然無限擴展 | 要自己擴 Media Service |
| 上傳前驗證 | 有限（可限 file size/content-type，但無法檢查實際內容） | 可即時做 virus scan、格式驗證、EXIF strip |
| Resumable upload | S3 multipart upload 原生支援 | 要自己實作 |
| 處理觸發 | 靠 S3 Event → SQS/Lambda（異步） | 同步或異步都行，控制力強 |

### 推薦做法：Pre-signed URL + 異步 Pipeline

```
Client                     API Server              S3              Processing Queue
  │  請求上傳                  │                    │                    │
  │ ──────────────────────────→│ 驗證 auth/quota   │                    │
  │  回傳 signed URL           │                    │                    │
  │ ←──────────────────────────│                    │                    │
  │  PUT 直傳 ────────────────────────────────────→ │                    │
  │                            │         S3 Event ──────────────────────→│
  │                            │                    │   thumbnail,       │
  │                            │                    │   transcode,       │
  │                            │                    │   virus scan       │
  │  訊息帶 media_ref          │                    │                    │
  │ ──────────────────────────→│                    │                    │
```

### 處理 Pipeline（異步，S3 Event 觸發）

1. 圖片：生成 thumbnail（150x150）+ compressed（720p）+ original
2. 影片：transcode to H.264 multiple bitrates（240p, 480p, 720p）
3. 語音：統一轉為 Opus codec
4. Virus scan / content moderation
5. 處理完成 → URL 指向 CDN

### E2EE 下的 Media 加密

```
→ Client 端加密 media → 用 pre-signed URL 直傳密文到 S3
→ 訊息中帶 media_url + media_decryption_key
→ 接收方下載密文 → 用 key 解密
→ Server 和 CDN 看到的都是密文（無法辨識內容）
→ Pre-signed URL 直傳在 E2EE 場景完全可行，且更合適（server 本來就不該碰明文）
```

### Storage 估算

```
100B messages/day × 20% media × 500KB avg（壓縮後）= 10PB/day
→ 這是 CDN + Object Storage 的主要成本
→ 用 lifecycle policy：90 天後從 hot storage 移到 Glacier
```

---

## 13. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 500M |
| Messages/day | 100B → **~1.15M msgs/sec** |
| Concurrent WebSocket connections | 200M |
| Gateway servers（500K conn/server） | **~400 台** |
| Message avg size (text) | ~100 bytes (加密後) |
| Text message storage/day | 100B × 100B = **10TB/day** |
| Text storage/year | **~3.6PB** |
| Hot tier (30 days, RF=3) | 10TB × 30 × 3 = **~900TB** |
| Media storage/day | ~10PB (含 thumbnails + transcoded) |
| Seq counter QPS (Redis) | ~1.15M INCR/sec → 分散到多個 conv → **可扛** |
| Presence heartbeat QPS | 200M / 30s = **~6.7M writes/sec** |
| Push notifications/day | ~20B（離線用戶的訊息）|

---

## 14. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Client-Server 通訊 | **WebSocket** | 雙向即時推送，overhead 極低；HTTP polling 浪費 66M req/sec |
| 訊息排序 | **Per-conversation seq_num** | 不需要全局排序；per-conversation 更簡單且 client 可偵測 gap |
| 訊息存儲 | **Cassandra (partition by conv_id)** | Wide-column store 天然適合 time-series append；range scan 快 |
| Group fan-out | **小群 push + 大群 pull (200人分界)** | < 200人 push 即時且負擔低；> 200人 push fan-out 太大，改 pull |
| Presence | **30s heartbeat + Redis TTL** | 比每秒 heartbeat 省 30x QPS；60s TTL 自動判定離線 |
| 離線訊息 | **Message Store 即 queue（cursor sync）** | 不需要額外 offline queue；用 last_synced_seq 做差異同步 |
| Media 處理 | **分離上傳（HTTPS）+ reference（WebSocket）** | Media binary 不適合走 WebSocket frame；分離後可獨立 scale |
| 搜尋 | **Slack: ES server-side / WhatsApp: client-side** | E2EE 下 server 無法 index 明文；非 E2EE 用 ES 做 full-text search |
| 加密 | **Signal Protocol（X3DH + Double Ratchet）** | Forward secrecy + 每條訊息獨立 key；業界標準 |
| 多裝置同步 | **Cursor-based incremental sync** | 每裝置維護自己的 cursor；離線 < 7天增量，> 7天全量 |
| Gateway 間通訊 | **Kafka per-gateway topic** | Gateway crash 不丟訊息（Kafka retention）；解耦 gateway 間依賴 |
| 訊息 ID | **conv_id + seq_num（非 Snowflake）** | Per-conversation 排序足夠；client 用 seq gap 偵測訊息遺漏 |

---

## 15. 面試常見 Follow-up

### Q: 如何保證訊息不丟失？

```
三層保障：
1. Client → Server: client_msg_id idempotent retry + Server ACK
2. Server → DB: 寫入 Cassandra (RF=3, quorum write) → 持久化
3. Server → Receiver: push via WebSocket + delivery_ack
   如果沒收到 ack → 存入 offline queue → 上線後 cursor sync 補齊

End-to-end: Client A 不顯示 ✓ 直到收到 Server ACK
             Client A 看到 ✓✓ 表示 B 的裝置已確認收到
```

### Q: 如何處理訊息順序問題？

```
Per-conversation seq_num 保證同一對話內的順序。

邊界情況：
  - A 和 B 同時發訊息 → Server 的 INCR 是 atomic → 總有先後
  - Network delay 導致 B 先收到 seq 5 再收到 seq 3
    → Client 端根據 seq_num 排序顯示，不按收到順序
  - 不保證跨 conversation 的全局順序（也不需要）
```

### Q: 如何處理 10 萬人的大型 Channel？

```
純 Pull Model：
  1. 訊息寫入 conversation partition（Cassandra）
  2. 不做 fan-out push
  3. Client 開啟 channel 時 fetch recent messages
  4. 開啟後 subscribe channel 的 update stream（WebSocket）
  5. 未開啟的 channel → 只更新 unread badge count

Unread count 優化：
  → 不追蹤「哪條已讀」→ 只記 last_read_seq per user per channel
  → unread_count = latest_seq - last_read_seq
  → O(1) 計算，不用 scan
```

### Q: 如何支援 typing indicator（「對方正在輸入...」）？

```
  → 純即時信號，不持久化，不保證可靠
  → Client 輸入時 → 透過 WebSocket 送 typing_start event
  → Server 轉發給對話中其他在線的人（不經過 Message Store）
  → 3 秒沒有新 typing event → Client 端自動隱藏 indicator
  → 這是 fire-and-forget — 丟了無所謂（UX 影響極小）
```

### Q: 訊息撤回/刪除怎麼實現？

```
  → 發送 delete_message(msg_id) → Server 標記 soft delete
  → Push "message_deleted" event 給對話中所有成員
  → Client 端收到後更新 UI：「此訊息已撤回」
  → E2EE 下：密文仍在 Server，但 Client 端刪除明文 + 顯示撤回
  → 時間限制：WhatsApp 允許 2 天內撤回
```

---

## 16. 面試策略：講述順序建議

1. **需求釐清 + 規模估算**（3 分鐘）— DAU、messages/sec、concurrent connections、1:1 vs group 比例。問面試官：要不要涵蓋 E2EE？大群/Channel？

2. **連線管理 — WebSocket Gateway**（4 分鐘）— 為什麼選 WebSocket（vs polling）、Gateway 架構、user→gateway 映射（Redis）、200M 連接需要 400 台 gateway。這是 Chat 獨特之處，展現你理解長連接的挑戰。

3. **訊息收發核心流程**（4 分鐘）— 1:1 完整流程：A 發 → Gateway → Chat Service → Message Store + push to B's Gateway → B 收。三階段確認（sent/delivered/read）。Idempotency key 防重複。

4. **訊息存儲**（3 分鐘）— Cassandra、partition by conv_id、seq_num 排序、hot/cold 分離。用數字：10TB/day、900TB hot tier。

5. **Group Chat Fan-out**（2 分鐘）— 小群 push vs 大群 pull、200 人分界線、為什麼。

6. **Presence + Offline + Push**（2 分鐘）— 30s heartbeat、TTL 自動過期、cursor-based sync。

7. **Deep Dive（面試官選）**（3-5 分鐘）— E2EE（Signal Protocol）、Multi-device sync、Media pipeline、Search、Typing indicator。準備好這些模組的 2 分鐘版本。
