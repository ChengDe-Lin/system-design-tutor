# Timeout 釋放機制 — 5 種做法 + 適用判斷

> **核心釐清**：「設定 15 分鐘後過期釋放」是常見需求，但實作機制差很大。**選錯機制會直接丟錢/丟資料**。判斷依據是「過期時要做什麼」，不是「需要 timeout」。

## 判斷規則：Passive Expiry vs Active Expiry

| 類型 | 定義 | 例子 | 適用機制 |
|------|------|------|---------|
| **Passive Expiry**（過期=自動正確） | Key/State 消失就達到目標，不需執行邏輯 | 座位鎖、Session、OTP、Idempotency key、Rate limit | Redis TTL ✅ |
| **Active Expiry**（過期=需做事） | 必須執行 business logic 才到正確狀態 | Inventory 釋放、訂單取消、預約過期、Scheduled job | DB scan / Delayed Queue ✅，Redis TTL alone ❌ |

**判斷自問**：「如果過期時什麼程式都不跑，系統狀態正確嗎？」
- 「正確」→ Passive，用 Redis TTL
- 「不正確（庫存沒回、DB 沒更新、event 沒發）」→ Active，需要可靠觸發

## 5 種做法總覽

| 方法 | 觸發機制 | 延遲 | 可靠性 | 複雜度 | 適用 |
|------|---------|------|-------|--------|------|
| A. **DB 欄位 + Worker Scan** | `WHERE expires_at < NOW()` 每分鐘 | ~1 分鐘 | ⭐⭐⭐⭐⭐ | 低 | 中小規模、簡單可靠 |
| B. **Delayed Queue** | RabbitMQ TTL / SQS delay | ~秒級 | ⭐⭐⭐⭐⭐ | 中 | 生產主流（金融級） |
| C. **Redis ZSET Priority Queue** | `ZRANGEBYSCORE` 找最早過期 | ~秒級 | ⭐⭐⭐ | 中 | 高 throughput，搭配 DB 雙寫 |
| D. **Redis TTL + Keyspace Notifications** | Pub/Sub on expire event | ~秒級 | ⭐ at-most-once | 低 | ❌ 錢的場景禁用 |
| E. **Pure Redis TTL（什麼都不做）** | Key 自然消失 | 0 | ⭐⭐⭐⭐⭐ | 0 | 只適用 Passive Expiry |

## 詳解每種做法

### A. DB 欄位 + Worker Scan

```sql
CREATE TABLE reservations (
  reservation_id  BIGINT PRIMARY KEY,
  order_id        BIGINT,
  sku_id          VARCHAR(50),
  qty             INT,
  expires_at      TIMESTAMP,
  status          VARCHAR(20),
  INDEX (status, expires_at)            -- 關鍵 index
);

-- Worker 每分鐘執行
WITH expired AS (
  UPDATE reservations
  SET status = 'released'
  WHERE status = 'active' AND expires_at < NOW()
  RETURNING reservation_id, sku_id, qty
)
UPDATE inventory
SET reserved = reserved - expired.qty
FROM expired
WHERE inventory.sku_id = expired.sku_id;
```

**優點**：
- 最簡單，debug 友善（直接 SQL 查狀態）
- DB transaction 保證 atomic
- Worker 重啟不漏（從 DB 重算）

**缺點**：
- 1 分鐘 granularity（user 等到下次 scan）
- 大規模 scan 慢 → 必須加 `(status, expires_at)` index、考慮 partition

**適用**：QPS < 1K reservations/sec、可容忍分鐘級延遲

### B. Delayed Queue（生產主流）

#### RabbitMQ Delayed Message Plugin

```python
# 安裝 rabbitmq_delayed_message_exchange plugin
channel.exchange_declare(
    "delayed_release",
    exchange_type="x-delayed-message",
    arguments={"x-delayed-type": "direct"}
)

# 預留時：發 delayed message
def reserve_inventory(order_id, sku_id, qty):
    db.execute("INSERT INTO reservations ...")
    db.execute("UPDATE inventory SET reserved += ?")

    channel.basic_publish(
        exchange="delayed_release",
        routing_key="release",
        body=json.dumps({"reservation_id": id}),
        properties=pika.BasicProperties(headers={"x-delay": 900_000})  # 15 min
    )

# Consumer
def release_consumer(message):
    reservation = db.query("SELECT * FROM reservations WHERE id = ?", message.id)
    if reservation.status == 'active':
        # release 邏輯
        ...
```

#### AWS SQS DelaySeconds

```python
sqs.send_message(
    QueueUrl=...,
    MessageBody=json.dumps({"reservation_id": id}),
    DelaySeconds=900  # max 900 in SQS standard, longer needs Step Functions
)
```

#### Kafka 沒有原生 delay (需用 wheel timer 或 multiple-tier topic)

→ Kafka 不適合 delayed message，要其他方案。

**優點**：
- 秒級觸發
- At-least-once + retry + DLQ
- Consumer group auto scale

**缺點**：
- 多一個依賴（RabbitMQ / SQS）
- High load 時 RabbitMQ TTL 可能延遲（不嚴格保證）
- **必須做 idempotency**：consumer 可能收到重複 message

**適用**：金融、ecommerce、任何錢相關的場景

### C. Redis ZSET 當 Priority Queue

```python
# 預留時
expires_at = int((datetime.now() + timedelta(minutes=15)).timestamp())
redis.zadd("reservation_expirations", {f"order_{id}": expires_at})

# Worker 每秒執行
now_ts = int(datetime.now().timestamp())
expired = redis.zrangebyscore("reservation_expirations", 0, now_ts, start=0, num=100)
for order_id in expired:
    if release_reservation(order_id):
        redis.zrem("reservation_expirations", order_id)
```

**優點**：
- O(log N) 找最早過期，遠快於 DB scan
- 秒級 granularity
- Worker 簡單

**缺點**：
- Redis down + AOF 救不回 → 過期事件遺失
- → 必須與 DB 雙寫保留 backup

**適用**：高 throughput (>10K reservations/sec)、能接受少量遺失或有 DB backup

### D. Redis TTL + Keyspace Notifications ❌

```
CONFIG SET notify-keyspace-events "Ex"
SET reservation:order_999 {data} EX 900
SUBSCRIBE __keyevent@0__:expired
```

**致命缺陷**：
- ⚠️ Pub/Sub at-most-once，consumer 斷線那刻 event 永久遺失
- ⚠️ 無 replay、無 consumer group、無 ack
- ⚠️ Redis 重啟後 expired events 不重發
- ⚠️ Cluster 模式下 expire event 只在 key 所在 node 發出，跨 shard 訂閱複雜

**判斷**：**錢的場景禁用**。只能在「漏一兩個無所謂」的場景（cache 失效通知、debug 工具）用。

### E. Pure Redis TTL（Passive Expiry）

```
SET seat_lock:event_42:seat_A12 user_123 EX 900
SET session:abc123 {user_data} EX 1800
SET otp:phone_xxx 123456 EX 60
SET idempotency:request_xxx 1 EX 86400
```

**前提**：過期 = 達到正確狀態（passive）。

**判斷對的場景**：
- ✅ 座位鎖（過期=鎖消失=可選）
- ✅ Session（過期=要重新登入）
- ✅ OTP（過期=驗證碼失效）
- ✅ Idempotency key（過期=可重新發送）
- ✅ Rate limiter window
- ❌ Inventory release（過期還要 UPDATE inventory.reserved）
- ❌ 訂單取消（過期還要 UPDATE order.status + refund）
- ❌ 預約過期（過期還要 release 醫師時段 + 通知）

## 為什麼 Ticketmaster 用 Redis TTL 而 Inventory 不能？

```
Ticketmaster 座位鎖：
  鎖的「存在」本身就是 source of truth
  → 過期 = key 消失 = 其他 user 看到沒鎖 = 自動可選
  → 不需要任何 active action ✅ Passive

Inventory 預留：
  Source of truth 在 DB inventory.reserved 欄位
  → 過期 != Redis key 消失 = inventory.reserved 自動歸零
  → 必須跑 UPDATE 邏輯才正確 ❌ Active
```

**關鍵差別**：source of truth 在哪。
- Source of truth 在 Redis 本身 → Redis TTL 夠
- Source of truth 在 DB → 需 active trigger 同步 DB

## Production 推薦：Belt-and-Suspenders

對 active expiry 場景，業界最佳實踐是**雙保險**：

```
主路徑（低延遲）：Delayed Queue
  - RabbitMQ TTL / SQS delay
  - 秒級觸發 release
  - 處理 99.9% case

備援路徑（safety net）：DB Worker Scan
  - 每 10 分鐘掃 expires_at < NOW() - 5 min AND status = 'active'
  - 撿起 delayed queue 漏掉的（極少數）
  - 不會丟，因為 DB 是真相

兩個路徑都要 idempotent：
  release_reservation(id) {
    UPDATE reservations SET status='released' WHERE id=? AND status='active'
    if affected_rows == 0: return  // 已被另一條路徑處理
    UPDATE inventory.reserved -= qty
  }
```

→ 用 row-level locking 或 `WHERE status='active'` 條件 + `affected_rows` 檢查保證 idempotent。

## 容量估算 anchor

| 規模 | 推薦方案 |
|------|---------|
| < 100 reservations/sec | Worker scan + DB 即可 |
| 100-10K reservations/sec | Delayed Queue (RabbitMQ/SQS) |
| > 10K reservations/sec | Redis ZSET + DB 雙寫 + Delayed Queue |

## 常見坑

1. **錯把 active expiry 當 passive 用 Redis TTL** → 過期了什麼都沒發生，庫存永遠沒回
2. **用 Keyspace Notifications 處理錢** → at-most-once 事件遺失，Redis 重啟更慘
3. **沒做 idempotency** → Delayed queue 重投或多 worker 同時處理 → 重複扣 inventory
4. **Worker scan 沒加 index** → 全表掃描，dataset 大時 minutes 級 query
5. **Delayed queue TTL 不嚴格保證** → 高負載時可能延遲幾秒到分鐘
6. **跨 timezone bug** → expires_at 必須 UTC，否則 daylight saving 切換時亂套
7. **重啟 Worker 漏 release** → 必須從 DB 重算，不能依賴 in-memory state

## 一句話總結

> **看「過期時要做什麼」決定機制：**
>
> **過期 = 自動消失即正確**（lock、session、OTP、idempotency）→ **Redis TTL** 夠了
>
> **過期 = 需執行業務邏輯**（inventory、order、reservation）→ **DB scan / Delayed Queue**，雙保險最佳
>
> 「需要 15 分鐘後過期」不是技術判斷，「過期時要不要主動做事」才是。
