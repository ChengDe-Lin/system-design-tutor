# Notification System — 大規模通知推送系統架構

## 1. 核心挑戰

通知系統的設計核心是 **多管道可靠投遞 (Multi-channel Reliable Delivery)**，同時避免過度打擾用戶：

```
規模（以大型社群平台為例，如 Facebook/Instagram 級別）：
  DAU: ~500M
  通知事件/day: ~10B → ~115K events/sec
  Push 通知/day: ~5B → ~58K pushes/sec
  Email/day: ~1B → ~12K emails/sec
  SMS/day: ~50M → ~580 SMS/sec

管道特性差異：
  Push (APNs/FCM): 延遲 100-500ms, 免費, 到達率 ~60-80%（token 過期、關通知）
  Email (SES/SendGrid): 延遲 1-30s, ~$0.1/1K封, 到達率 ~95%（但開信率僅 ~20%）
  SMS (Twilio/SNS): 延遲 1-5s, ~$0.01/封, 到達率 ~98%（最貴但最可靠）

核心矛盾：
  - 需要即時投遞（安全警報 < 10s），但也要避免轟炸用戶（rate limiting）
  - 單一事件可能觸發百萬級通知（明星發文 → 粉絲通知）
  - 每個管道有不同的失敗模式、重試策略、費用結構
  - 用戶偏好高度個人化：有人只要 push、有人要 email、有人全部關閉
```

---

## 2. 整體架構

```
┌────────────────┐
│  Event Sources │  (各業務 Service: Social, Payment, Security, Marketing)
└───────┬────────┘
        │ publish event
        ▼
┌──────────────────┐     ┌─────────────────────┐
│   Message Queue  │     │  User Preference     │
│   (Kafka)        │     │  Service (Redis+DB)  │
└───────┬──────────┘     └──────────┬───────────┘
        │ consume                   │ query
        ▼                           │
┌──────────────────────────────────────────────┐
│           Notification Service               │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Dedup    │→│ Priority │→│ Rate Limiter │  │
│  │ Engine   │ │ Router   │ │              │  │
│  └──────────┘ └──────────┘ └──────┬───────┘  │
│                                   │          │
│  ┌────────────────────────────────▼───────┐  │
│  │         Template Engine                │  │
│  │  (render content per channel + locale) │  │
│  └────────────────────────────────┬───────┘  │
└───────────────────────────────────┼──────────┘
        ┌───────────────────────────┼───────────────┐
        ▼                          ▼                ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ Push Adapter │  │  Email Adapter   │  │ SMS Adapter  │
│ (APNs / FCM) │  │ (SES / SendGrid) │  │ (Twilio/SNS) │
└──────┬───────┘  └────────┬─────────┘  └──────┬───────┘
       │                   │                    │
       ▼                   ▼                    ▼
   ┌────────┐        ┌──────────┐         ┌─────────┐
   │ Device │        │ Mailbox  │         │  Phone  │
   └────────┘        └──────────┘         └─────────┘
        │                   │                    │
        └───────────┬───────┴────────────────────┘
                    ▼
           ┌────────────────┐
           │ Analytics      │
           │ Pipeline       │
           │ (delivery,     │
           │  open, click)  │
           └────────────────┘
```

---

## 3. 核心設計決策：通知管道選擇策略

不同管道適用於不同場景，選錯管道會導致用戶流失或安全事故。

### 管道特性比較

| 維度 | Push (APNs/FCM) | Email | SMS |
|------|-----------------|-------|-----|
| 延遲 | 100-500ms | 1-30s | 1-5s |
| 到達率 | 60-80% | ~95% | ~98% |
| 成本/封 | 免費 | ~$0.1/1K | ~$0.01/封 |
| 內容長度 | ~4KB payload | 無上限 | 160 字元 |
| 互動追蹤 | open/click 可追蹤 | open/click 可追蹤 | delivery receipt 僅部分 |
| 用戶感知 | 即時彈窗 | 被動檢查 | 即時彈窗 |
| 適用場景 | 即時互動、社群動態 | 報表、行銷、摘要 | 驗證碼、安全警報 |

### 管道選擇決策樹

```
事件產生
  │
  ├─ P0（安全類：登入異常、密碼變更、交易確認）
  │    → SMS + Push + Email（三管道同時投遞）
  │    → TTL: 5 min（過期無意義）
  │
  ├─ P1（互動類：like、comment、follow、mention）
  │    → Push only（若用戶有開啟）
  │    → Fallback: 累積 → daily email digest
  │    → TTL: 24h
  │
  └─ P2（行銷類：推薦、促銷、weekly digest）
       → Email only
       → 受 rate limit 控制（每用戶每天最多 1 封行銷 email）
       → TTL: 72h
```

---

## 4. Notification Pipeline 詳細設計

### 4.1 事件來源與 Kafka Topic 設計

```
各業務 Service 發送結構化事件到 Kafka：

Topic 設計（按優先級分 topic，確保 P0 不被 P2 堵塞）：
  notification.events.p0   → partition 8,  consumer group: notif-p0-workers (16 instances)
  notification.events.p1   → partition 32, consumer group: notif-p1-workers (32 instances)
  notification.events.p2   → partition 16, consumer group: notif-p2-workers (8 instances)

Event Schema:
{
  "event_id": "evt_abc123",          // 冪等鍵 (Idempotency Key)
  "event_type": "social.like",
  "priority": "P1",
  "source_service": "social-service",
  "actor_id": "user_456",            // 誰觸發的
  "recipient_id": "user_789",        // 要通知誰
  "recipient_ids": [...],            // 批量通知（fan-out 場景）
  "payload": {
    "tweet_id": "tw_001",
    "actor_name": "Alice"
  },
  "created_at": "2025-01-15T10:30:00Z",
  "ttl_seconds": 86400
}
```

### 4.2 為什麼按優先級分 Kafka Topic？

```
如果所有優先級共用一個 topic：
  假設行銷活動發出 1 億封 P2 通知 → 佔滿 consumer 處理能力
  → P0 安全警報被排在後面 → 用戶帳號被盜但 10 分鐘後才收到通知

分 topic 的好處：
  - P0 topic 的 consumer 數量少但優先級高、資源專屬
  - P2 backlog 不影響 P0/P1 的處理延遲
  - 可以獨立調整每個 priority 的 consumer 數量和處理策略

代價：
  - 多維護 3 個 topic
  - 業務方需要正確標記優先級（但這靠 schema validation 強制）
```

---

## 5. 去重 (Deduplication) 機制

重複通知是用戶體驗的頭號殺手。

### 為什麼會重複？

```
場景 1：Producer 重試
  Social Service 發了一個 like event → Kafka ACK timeout → 重發 → 兩條相同 event

場景 2：Consumer 重試
  Notification Service 處理完 → 發送 push → 還沒 commit offset → crash → restart → 重新處理

場景 3：業務邏輯重複
  用戶連續 like → unlike → like → 觸發 3 次 event，但只該通知 1 次
```

### 去重方案

```
兩層去重：

Layer 1: Event-level Dedup（精確去重）
  Key: event_id（由 producer 生成的 UUID）
  Storage: Redis SET with TTL
    SETNX dedup:{event_id} 1 EX 86400   // 24h TTL
    → 如果 SETNX 返回 0 → 已處理，skip
  成本：10B events/day × 36 bytes/key ≈ 360GB Redis → 分 4 個 Redis 節點

Layer 2: Business-level Dedup（語意去重）
  Key: {event_type}:{actor_id}:{recipient_id}:{object_id}
  例: "like:user_456:user_789:tw_001"
  Window: 最近 1 小時內同一組合只通知一次
    SET biz_dedup:{key} 1 EX 3600
  → 防止 like/unlike/like 連續通知
```

---

## 6. 優先級佇列 (Priority Queue) 與 Rate Limiting

### Priority Queue 設計

```
P0 (Security):
  - 處理延遲目標: < 10 秒
  - 不受 rate limit 限制（安全警報永遠送出）
  - 失敗立即重試（最多 3 次，間隔 1s, 2s, 4s）

P1 (Social Interaction):
  - 處理延遲目標: < 2 分鐘
  - 受 per-user rate limit 限制
  - 失敗重試（最多 3 次，間隔 30s, 60s, 120s）

P2 (Marketing):
  - 處理延遲目標: < 1 小時
  - 嚴格 rate limit + quiet hours 控制
  - 失敗不重試（行銷通知不值得重試成本）
```

### Per-User Rate Limiting

```
Rate Limit 規則（Redis + Sliding Window）：

Push 通知：每用戶每小時最多 30 則
  Key: rl:push:{user_id}:{hour_bucket}
  INCR → 如果 > 30 → drop 或降級為 digest

Email：每用戶每天最多 5 封（行銷類每天 1 封）
  Key: rl:email:{user_id}:{day_bucket}

SMS：每用戶每天最多 3 封
  Key: rl:sms:{user_id}:{day_bucket}

Quiet Hours（勿擾時段）：
  用戶可設定 22:00 - 08:00 不接收 P1/P2 通知
  → P1/P2 在 quiet hours 期間排入延遲佇列
  → P0 不受影響（安全警報隨時發送）

實作：
def should_deliver(user_id, channel, priority, user_tz):
    if priority == "P0":
        return True  # 安全通知永遠投遞
    if is_quiet_hours(user_tz) and priority != "P0":
        enqueue_delayed(notification, next_active_time(user_tz))
        return False
    rate_key = f"rl:{channel}:{user_id}:{time_bucket()}"
    current = redis.incr(rate_key)
    if current == 1:
        redis.expire(rate_key, bucket_ttl)
    return current <= rate_limits[channel]
```

---

## 7. Template Engine：內容與投遞邏輯分離

### 為什麼需要 Template Engine？

```
同一個事件，不同管道需要不同格式：

Event: user_456 liked your tweet

Push:  "Alice liked your tweet"           (≤ 100 chars, no HTML)
Email: "<h1>Alice liked your tweet</h1>   (rich HTML, with images)
        <p>Check it out →</p>"
SMS:   "Alice liked your tweet. View: https://t.co/abc"  (≤ 160 chars)

同一管道，不同語言：
Push (en): "Alice liked your tweet"
Push (zh): "Alice 對你的推文按了讚"

沒有 template engine → 每個業務 Service 自己拼字串 → 格式混亂、改文案要改代碼
```

### Template 資料模型

```sql
notification_templates:
  template_id     VARCHAR(64) PRIMARY KEY  -- "social.like.push.en"
  event_type      VARCHAR(64)              -- "social.like"
  channel         ENUM('push','email','sms')
  locale          VARCHAR(10)              -- "en", "zh-TW"
  title_template  TEXT                     -- "{{actor_name}} liked your post"
  body_template   TEXT                     -- "See what {{actor_name}} said..."
  version         INT
  updated_at      TIMESTAMP

-- 查詢：
SELECT * FROM notification_templates
WHERE event_type = 'social.like'
  AND channel = 'push'
  AND locale = 'zh-TW'
ORDER BY version DESC LIMIT 1
```

```
渲染流程：
  1. 收到 event → 根據 event_type + channel + user locale 查 template
  2. Template cache 在 Redis（TTL 5min），避免每次都查 DB
  3. 用 Mustache/Jinja 渲染：template.render(event.payload)
  4. 結果交給對應 Channel Adapter
```

---

## 8. Channel Adapter 與失敗處理

每個管道有獨特的失敗模式，需要不同的重試策略。

### Push Adapter (APNs / FCM)

```
APNs (iOS):
  Protocol: HTTP/2 長連線
  Payload 上限: 4KB
  常見失敗：
    - 410 Unregistered → token 過期（用戶解除安裝 App）→ 標記 token invalid
    - 429 Too Many Requests → back off → 指數退避重試
    - 503 Service Unavailable → APNs 暫時不可用 → 重試

FCM (Android):
  Protocol: HTTP/2
  Payload 上限: 4KB
  常見失敗：
    - NotRegistered → token 過期 → 清除
    - MessageTooBig → payload 超過 4KB → 記 error log，不重試
    - Unavailable → 重試（指數退避）

重試策略（Push）:
  max_retries: 3
  backoff: exponential (1s, 2s, 4s) with jitter
  → 3 次失敗後 → 記入 Dead Letter Queue (DLQ) → 人工排查
```

### Email Adapter (SES / SendGrid)

```
常見失敗：
  - Bounce (Hard): 地址不存在 → 標記 email invalid，永不再發
  - Bounce (Soft): 信箱滿 → 重試 1 次，24h 後再試
  - Complaint: 用戶標記垃圾信 → 自動退訂 + 記錄 complaint rate
  - Throttle: SES rate limit (14 emails/sec per account) → 排隊等待

Bounce rate 監控：
  → 如果 bounce rate > 5% → 暫停行銷 email → alert oncall
  → 如果 complaint rate > 0.1% → 暫停所有非 P0 email → 保護 sender reputation

Webhook 回報：
  SES / SendGrid → HTTP callback → Analytics Pipeline
  Events: delivered, opened, clicked, bounced, complained
```

### SMS Adapter (Twilio / SNS)

```
常見失敗：
  - Invalid Number → 標記號碼無效
  - Carrier Block → 部分電信商擋短網址 → 用純文字 URL
  - Rate Limit → Twilio 每帳戶有 QPS 限制 → queue + backpressure

Delivery Report:
  Twilio → status callback → record delivery status
  狀態: queued → sent → delivered / undelivered / failed

成本控制：
  SMS 是最貴的管道 ($0.01/封)
  50M SMS/day × $0.01 = $500K/day → 必須嚴格限制 SMS 使用場景
  → 只用於 P0（安全驗證、交易確認）+ 用戶明確選擇的 P1
```

---

## 9. Fan-out：高追蹤數事件的通知處理

明星發文 → 百萬粉絲 → 百萬條通知，直接處理會壓垮系統。

### 方案：分層 Fan-out

```
Event: celebrity (50M followers) posts a new tweet
  → 不能在一個 worker 裡 loop 50M 次

分層 Fan-out 架構：

Layer 1: Event Splitter（1 個任務）
  收到 event → 查 Social Graph → 拿到 50M follower IDs
  → 分成 5000 個 batch（每 batch 10K users）
  → 每個 batch 發一條 Kafka message 到 notification.fanout topic

Layer 2: Batch Workers（consume fanout topic，並行處理）
  每個 worker 拿 1 個 batch（10K users）
  → 對每個 user：查偏好 → dedup → rate limit → render → 發送
  → 10K users per batch × 5000 batches = 50M 通知

吞吐量計算：
  50M 通知，目標 5 分鐘內完成
  = 50M / 300s = ~167K notifications/sec
  每個 worker 處理速度 ~1000 notifications/sec
  → 需要 ~167 個 workers（但可以用 32 workers 在 ~26 分鐘完成）

實際策略：
  P1 通知可以延遲幾分鐘 → 用 32 workers 慢慢消化
  P0 不會有 fan-out 場景（安全通知是 1:1 的）
```

### 避免 Thundering Herd

```
50M Push 通知同時發到 APNs/FCM → 會被 rate limit

解法：
  1. 每個 batch worker 加隨機 jitter delay（0-30s）
  2. 使用 token bucket 限制對 APNs/FCM 的 QPS
     → APNs 建議 < 10K requests/sec per connection
     → 開 10 條 HTTP/2 連線 → 100K/sec 上限
  3. 超出限制的排入本地 buffer → 下一秒再送
```

---

## 10. Offline Handling：離線用戶通知

### 問題

```
用戶手機關機、網路斷線、App 未啟動 → Push 到不了
  APNs/FCM 有內建 offline storage（會暫存最後一條），但只保留最新的
  → 用戶上線後只看到最後一條 → 中間的通知全丟了
```

### 解法：Server-side Notification Inbox

```sql
notification_inbox:
  notification_id   BIGINT PRIMARY KEY    -- Snowflake ID
  user_id           BIGINT
  event_type        VARCHAR(64)
  title             VARCHAR(256)
  body              TEXT
  payload           JSON                  -- deep link, action buttons
  is_read           BOOLEAN DEFAULT FALSE
  created_at        TIMESTAMP
  expires_at        TIMESTAMP             -- TTL

INDEX idx_user_unread (user_id, is_read, created_at DESC)
```

```
流程：
  1. 每條通知都寫入 Notification Inbox（DB）
  2. 同時嘗試 Push/Email/SMS 投遞
  3. 用戶開啟 App 時：
     GET /notifications?unread=true&since={last_seen_timestamp}
     → 從 Inbox 拉取所有未讀通知
     → 即使 Push 沒到，App 打開時一定拿得到

TTL 清理：
  P1 通知 TTL = 7 天 → 過期自動清理
  P2 通知 TTL = 3 天
  → Cron job 每小時：DELETE FROM notification_inbox WHERE expires_at < NOW()

Inbox 容量估算：
  500M DAU × 平均 20 條未讀 × 0.5KB/條 = ~5TB
  → MySQL sharded by user_id → 合理
```

---

## 11. Device Token 管理

Device token 是 Push 通知的命脈，管理不善 = Push 系統報廢。

### Token 生命週期

```
1. 註冊 (Registration)：
   App 啟動 → 向 APNs/FCM 註冊 → 拿到 device_token
   → App 呼叫後端 API：PUT /devices/{user_id}
   → 後端寫入 Device Registry

2. 更新 (Refresh)：
   APNs/FCM 可能隨時更換 token（iOS 每次 App 重裝、系統更新都可能換）
   → App 每次啟動都重新註冊 → 後端 upsert

3. 過期 / 清除 (Cleanup)：
   APNs 回傳 410 Unregistered → 標記 token inactive
   FCM 回傳 NotRegistered → 標記 token inactive
   用戶 6 個月未開啟 App → 排程清理
```

### 資料模型

```sql
device_tokens:
  token_id      BIGINT PRIMARY KEY
  user_id       BIGINT
  device_token  VARCHAR(512)       -- APNs/FCM token
  platform      ENUM('ios','android','web')
  app_version   VARCHAR(32)
  is_active     BOOLEAN DEFAULT TRUE
  created_at    TIMESTAMP
  last_seen_at  TIMESTAMP          -- App 最後一次回報的時間

UNIQUE INDEX idx_token (device_token)
INDEX idx_user_active (user_id, is_active)
```

```
一個用戶可能有多個設備（手機 + 平板 + Web）：
  → 查 device_tokens WHERE user_id = X AND is_active = TRUE
  → 對每個 active token 各發一條 Push
  → 用戶在手機和平板都收到通知 → 其中一台點開 → 兩邊都標已讀

Stale Token 清理（週期性 job）：
  SELECT * FROM device_tokens
  WHERE is_active = TRUE AND last_seen_at < NOW() - INTERVAL 6 MONTH
  → 標記 is_active = FALSE
  → 減少無效 Push 請求（省 APNs/FCM 配額 + 減少 error rate）
```

---

## 12. Third-party Provider 抽象層

### 為什麼需要抽象層？

```
直接耦合 APNs/Twilio 的問題：
  1. Vendor lock-in：Twilio 漲價 → 遷移成本巨大
  2. 容災：SendGrid 故障 → email 全部卡住，沒有 fallback
  3. A/B 測試：想比較 SendGrid vs Mailgun 的投遞率 → 改不動

解法：Provider-agnostic Interface
```

### 介面設計

```python
# 抽象介面
class NotificationChannel(ABC):
    @abstractmethod
    def send(self, recipient: str, message: Message) -> DeliveryResult:
        pass

    @abstractmethod
    def check_status(self, message_id: str) -> DeliveryStatus:
        pass

# Push 實作
class APNsProvider(NotificationChannel):
    def send(self, device_token, message):
        # HTTP/2 to api.push.apple.com
        ...

class FCMProvider(NotificationChannel):
    def send(self, device_token, message):
        # HTTP/2 to fcm.googleapis.com
        ...

# Email 實作 — 支援 failover
class EmailChannel:
    def __init__(self):
        self.primary = SESProvider()
        self.fallback = SendGridProvider()

    def send(self, email, message):
        try:
            return self.primary.send(email, message)
        except ProviderUnavailable:
            metrics.incr("email.failover.ses_to_sendgrid")
            return self.fallback.send(email, message)

# SMS 實作 — 按地區路由
class SMSRouter:
    def __init__(self):
        self.providers = {
            "US": TwilioProvider(),
            "TW": NexmoProvider(),     # 台灣用 Nexmo 更便宜
            "DEFAULT": TwilioProvider()
        }

    def send(self, phone_number, message):
        region = detect_region(phone_number)
        provider = self.providers.get(region, self.providers["DEFAULT"])
        return provider.send(phone_number, message)
```

---

## 13. Analytics Pipeline

### 追蹤指標

```
投遞漏斗 (Delivery Funnel)：
  Event Generated → Dedup Passed → Rate Limit Passed → Sent → Delivered → Opened → Clicked

每個環節都記錄到 Analytics Pipeline (Kafka → Flink → ClickHouse)：

notification_events (ClickHouse):
  notification_id   UInt64
  user_id           UInt64
  event_type        String
  channel           String        -- push / email / sms
  priority          String        -- P0 / P1 / P2
  status            String        -- sent / delivered / opened / clicked / bounced / dropped
  drop_reason       Nullable(String)  -- dedup / rate_limit / preference_off / quiet_hours
  provider          String        -- apns / fcm / ses / twilio
  latency_ms        UInt32        -- 從 event 產生到送達的延遲
  created_at        DateTime

關鍵指標：
  Delivery Rate = delivered / sent × 100%
    目標: Push > 70%, Email > 95%, SMS > 98%

  Open Rate = opened / delivered × 100%
    目標: Push > 30%, Email > 20%

  Click-Through Rate = clicked / opened × 100%
    目標: > 5%

  Drop Rate = dropped / (generated) × 100%
    = dedup + rate_limit + preference_off
    健康值: 20-40%（代表 rate limiting 在運作）
```

### 即時監控 Dashboard

```
告警規則：
  - Delivery rate < 50% 持續 5 分鐘 → P1 alert → oncall
  - P0 notification latency p99 > 30s → P0 alert → 立即排查
  - Email bounce rate > 5% → 暫停行銷 email
  - SMS error rate > 10% → 檢查 Twilio 帳戶狀態
  - DLQ depth > 10K → consumer 可能有 bug
```

---

## 14. 容量估算

```
DAU: 500M
通知事件/day: 10B
  → Push: 5B/day → 58K/sec
  → Email: 1B/day → 12K/sec
  → SMS: 50M/day → 580/sec

Kafka:
  3 topics × 平均 20 partitions = 60 partitions
  Message size ~500B → 10B × 500B = 5TB/day
  Retention 3 days → 15TB Kafka storage
  Broker 數量: 6-10 nodes (3 replicas)

Dedup Redis:
  10B events/day × 36 bytes/key = 360GB
  TTL 24h → 穩態 ~360GB → 4 Redis 節點 (100GB each)

Rate Limit Redis:
  500M users × 3 channels × ~50 bytes = 75GB
  → 1-2 Redis 節點

Notification Inbox (MySQL):
  500M DAU × 20 條 × 0.5KB = 5TB
  Sharded by user_id → 50 shards × 100GB each

Device Token Registry:
  500M users × 1.5 devices/user × 0.5KB = 375GB
  → 4 MySQL shards

Template Cache (Redis):
  ~5K templates × 2KB = 10MB → 微不足道

Push Provider 連線:
  APNs: 10 HTTP/2 persistent connections × 10K req/sec = 100K/sec 上限
  FCM: HTTP/2, 可用 batch API (每次 500 tokens) → 更高效

Email 成本:
  1B emails/day × $0.1/1K = $100K/day = $3M/month

SMS 成本:
  50M SMS/day × $0.01 = $500K/day = $15M/month
  → 這就是為什麼 SMS 只用於 P0
```

| 指標 | 估算 |
|------|------|
| DAU | 500M |
| 通知事件/day | 10B → **~115K events/sec** |
| Push/day | 5B → **~58K pushes/sec** |
| Email/day | 1B → **~12K emails/sec** |
| SMS/day | 50M → **~580 SMS/sec** |
| Kafka storage | 60 partitions, **15TB** (3-day retention) |
| Dedup Redis | **360GB → 4 nodes** |
| Notification Inbox | **5TB** (MySQL sharded, 50 shards) |
| Device Token DB | **375GB** (4 MySQL shards) |
| Email 月費 | **~$3M/month** |
| SMS 月費 | **~$15M/month** |

---

## 15. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Priority 隔離 | **分 Kafka Topic** | P2 行銷洪水不堵塞 P0 安全警報；每個 priority 獨立 scale consumer |
| 去重層級 | **Event + Business 雙層** | Event-level 防基礎設施重試；Business-level 防語意重複（like/unlike/like） |
| Rate Limiting | **Per-user Sliding Window (Redis)** | 比 fixed window 精確避免邊界雙倍問題；Redis INCR + EXPIRE 簡單高效 |
| Template Engine | **獨立服務 + Redis Cache** | 內容與投遞邏輯解耦；改文案不需改代碼、不需 redeploy |
| Fan-out 策略 | **分層 Batch Fan-out** | 50M 通知分成 5000 batch 並行；避免單 worker 瓶頸和 OOM |
| Offline Handling | **Server-side Inbox + TTL** | APNs/FCM 只保留最後一條；Inbox 確保用戶上線時拿到完整未讀列表 |
| Provider 抽象 | **Vendor-agnostic Interface** | 避免 lock-in；支援 failover（SES 掛 → SendGrid）；按地區路由省 SMS 費 |
| SMS 使用場景 | **僅限 P0** | $0.01/封 × 大量 = 天價；只用在安全驗證等必須到達的場景 |
| Push token 管理 | **每次啟動 upsert + 定期清理** | Token 會過期且不通知你；定期清理減少無效請求和 error rate |
| Analytics 儲存 | **ClickHouse (column-oriented)** | 通知事件是典型 append-heavy + 聚合查詢場景；列式壓縮比 MySQL 省 10 倍空間 |

---

## 16. 面試常見 Follow-up

### Q: 如何保證通知的 exactly-once delivery？

```
嚴格的 exactly-once 在分散式系統中不可能（Two Generals Problem）。
實際做法是 at-least-once delivery + client-side dedup：

1. Producer: 帶 event_id → Kafka idempotent producer
2. Consumer: Redis dedup（SETNX event_id）→ 防重複處理
3. Channel: APNs/FCM 的 collapse_key → 同 key 的通知覆蓋前一條
4. Client: Notification Inbox 有 notification_id → App 拉取時用 id 去重

結果：用戶感知上是 exactly-once，底層是 at-least-once + dedup
```

### Q: 行銷活動要發 1 億封 email，怎麼處理？

```
不能一次性灌 1 億條到 Kafka → 會把 P1/P2 consumer 打爆

方案：Scheduled + Throttled Batch Send
  1. 行銷系統建立 Campaign（目標用戶清單、排程時間、throttle rate）
  2. Campaign Executor 按 rate 慢慢發 event 到 Kafka
     → 例如限制 10K events/sec → 1 億封需要 ~2.8 小時
  3. 走正常 P2 pipeline → dedup → rate limit → template → email adapter
  4. 即時監控 delivery rate 和 complaint rate
     → complaint rate > 0.08% → 自動暫停 campaign

SES rate limit:
  預設 14 emails/sec → 申請提升到 50K/sec
  1 億封 / 50K/sec = ~33 分鐘（provider 端不是瓶頸）
```

### Q: 用戶設定「只接收來自 follow 的人的通知」，怎麼實作？

```
User Preference Service 存用戶的通知偏好：

user_notification_preferences:
  user_id       BIGINT
  channel       ENUM('push','email','sms')
  event_type    VARCHAR(64)        -- "social.like", "social.follow", "*"
  enabled       BOOLEAN
  filter_rule   JSON               -- {"only_from": "following"}

Notification Service 處理流程：
  1. 收到 event: user_456 liked user_789's tweet
  2. 查 user_789 的偏好 → social.like → filter: only_from = following
  3. 查 Social Graph: user_789 是否 follow user_456？
     → Yes → 發通知
     → No → drop（記錄 drop_reason = "preference_filter"）

性能考量：
  偏好查詢走 Redis cache（TTL 10min）
  Social Graph 查詢走 Redis Set（SISMEMBER followers:{789} 456）→ O(1)
  → 增加 2 次 Redis 查詢，但每次 < 1ms → 可接受
```

### Q: 通知如何支援 i18n（國際化）？

```
Template Engine 天然支援：
  template key = {event_type}.{channel}.{locale}

  "social.like.push.en"    → "{{actor}} liked your post"
  "social.like.push.zh-TW" → "{{actor}} 對你的貼文按了讚"
  "social.like.push.ja"    → "{{actor}} があなたの投稿にいいねしました"

Locale 決定順序：
  1. 用戶明確設定的 notification language
  2. App language setting
  3. Device locale
  4. Fallback: en

新增語言 = 只需新增 template rows，不需改任何代碼
```

---

## 17. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— 釐清 DAU、每日通知量、管道比例（Push 50% / Email 30% / SMS 5%），算出各管道 QPS，強調 SMS 成本是核心約束
2. **整體 Pipeline（核心）**（3 分鐘）— 畫出 Event Source → Kafka → Notification Service → Channel Adapter 的流程，解釋為什麼用 Kafka 解耦、按 priority 分 topic
3. **去重 + Rate Limiting**（2 分鐘）— 兩層 dedup（event-level + business-level），per-user sliding window rate limit，quiet hours
4. **Channel Adapter + 失敗處理**（2 分鐘）— 每個管道的失敗模式（APNs 410、Email bounce、SMS carrier block），重試策略差異，provider abstraction layer
5. **Fan-out + Offline**（2 分鐘）— 分層 batch fan-out 處理百萬級通知，server-side Inbox 處理離線用戶
6. **Deep Dive（面試官選）**（2 分鐘）— Template Engine、Device Token 管理、Analytics Pipeline、i18n 支援
