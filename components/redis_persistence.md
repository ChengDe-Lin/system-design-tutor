# Redis 持久化機制 — RDB / AOF / 寫入外部 DB 的差別

> **核心釐清**：「Redis 持久化」有兩個完全不同的層次，不要混淆：
> 1. **Redis 對「自己的磁碟」的持久化**（RDB / AOF）→ 本機檔案，跟外部 DB 無關
> 2. **Redis 寫到「外部 DB」**（write-behind / event-driven）→ 為了讓 DB 當 source of truth
>
> 兩者通常**並存**，不是二擇一。

## TL;DR

```
                  ┌─────────────────┐
              ┌──▶│ RAM (Redis Hash)│ ← 對外服務
              │   └────────┬────────┘
   client ───┤            │
              │   ┌────────┴────────┐
              │   │ 第 1 層持久化    │
              │   │ RDB + AOF       │ ← 本機磁碟 (dump.rdb / appendonly.aof)
              │   │ 救 Redis 重啟   │
              │   └─────────────────┘
              │
              └─▶ 雙寫 / Kafka event
                  ┌─────────────────┐
                  │ 第 2 層持久化    │
                  │ External DB     │ ← Postgres / MySQL / Cassandra
                  │ Source of Truth │
                  │ 救 Redis 整個爆 │
                  └─────────────────┘
```

| 層次 | 機制 | 救什麼災難 | 必要性 |
|------|------|-----------|--------|
| **L1：RDB / AOF** | Redis 寫本機磁碟 | Redis process 重啟（保住記憶體狀態） | 高（單純 cache 場景可以不開） |
| **L2：External DB** | App 雙寫 / Kafka event | Redis 機器爆炸、整個 cluster 失效 | 必要（如果資料是 source of truth） |

## L1：RDB / AOF — Redis 對自己負責

### RDB (Redis Database)：定期 Snapshot

```
config:
  save 900 1       # 900 秒內有 ≥1 次寫 → 觸發
  save 300 10      # 300 秒內有 ≥10 次寫
  save 60 10000    # 60 秒內有 ≥10000 次寫
  dbfilename "dump.rdb"

工作流程：
  1. 條件達成 → fork 子 process（COW，瞬間複製）
  2. 子 process 序列化整個 RAM 到 dump.rdb（二進位壓縮）
  3. 父 process 繼續服務 client，新寫入透過 COW 不影響 snapshot
  4. 完成後 atomic rename 取代舊 dump.rdb

重啟流程：
  讀 dump.rdb → 反序列化載回 RAM
```

**優缺點**：
- ✅ 檔案小、reload 快（不需 replay）、對主執行緒影響極小
- ❌ **兩次 snapshot 之間的寫入會丟**——預設 config 最差可能丟 15 分鐘資料

**適用**：Cache 場景、容忍少量資料丟失、需要快速 reload

### AOF (Append-Only File)：操作日誌

```
config:
  appendonly yes
  appendfsync always    # 每筆都 fsync，最安全但最慢
  appendfsync everysec  # 每秒 fsync，預設，最差丟 1 秒
  appendfsync no        # 交給 OS，可能丟分鐘級
  appendfilename "appendonly.aof"

工作流程：
  每個寫指令 → append 到 AOF 檔（純文字 RESP 協定）
    *3
    $3
    SET
    $5
    user:1
    $5
    Alice

重啟流程：
  reload 把整個 AOF replay 一遍 → 重建 RAM 狀態
```

**優缺點**：
- ✅ 丟資料少（everysec 最差丟 1 秒，always 幾乎不丟）
- ✅ 純文字可讀，緊急時可手改修補
- ❌ 檔案大（要定期 BGREWRITEAOF 壓縮）
- ❌ reload 慢（10 GB AOF replay 可能要幾分鐘）
- ❌ 主執行緒每寫一筆 fsync 一次（everysec mode 影響較小）

**適用**：高可靠性需求、容忍慢速重啟、AOF rewrite 可定期排程

### RDB vs AOF 對照

| 維度 | RDB | AOF (everysec) | AOF (always) |
|------|-----|----------------|--------------|
| 最差丟資料 | 分鐘級 | 1 秒 | <1 ms |
| 檔案大小 | 小 (~20-30% RAM) | 大 (~1-3x RAM) | 大 |
| 寫入 throughput 影響 | 幾乎無 | -10% | **-50% 以上** |
| reload 速度 | 快 (秒級) | 慢 (分鐘級) | 慢 |
| 適用 | 容災備份 | **生產預設** | 金融級 |

### 生產建議：兩個都開（混合模式）

Redis 4.0+ 支援 RDB-AOF mixed format：
```
aof-use-rdb-preamble yes
```

→ AOF rewrite 時前段用 RDB 快照、後段用 AOF 增量，**兼顧 reload 速度和資料完整性**。

## L2：寫到外部 DB — 三種 Pattern

### Pattern A：Application 雙寫 (最常見，業界 95% 用這個)

```python
def update_cart(user_id, item_id, qty):
    # 同步寫 Redis (給 user 立即回應)
    redis.hset(f"cart:{user_id}", item_id, qty)

    # 發 Kafka event (非同步寫 DB)
    kafka.send("cart_updates", {
        "user_id": user_id,
        "item_id": item_id,
        "qty": qty,
        "timestamp": now()
    })

# Consumer (獨立 service)
def cart_consumer(event):
    db.execute(
        "UPDATE cart SET qty = ? WHERE user_id = ? AND item_id = ?",
        event.qty, event.user_id, event.item_id
    )
```

**優點**：
- App 完全掌控雙寫邏輯，最靈活
- Kafka 提供 retry / replay / consumer group
- DB 寫慢不影響 user 看到的延遲

**缺點**：
- **不是 atomic**：寫 Redis 成功但 Kafka 失敗 → 不一致
- → 解法：用 Outbox Pattern (寫 Redis + outbox 表 in single transaction，再由 publisher 發 Kafka)

### Pattern B：Redis Keyspace Notifications (內建事件)

```
# 啟用
CONFIG SET notify-keyspace-events "KEA"
  K = keyspace events
  E = keyevent events
  A = all events (set, del, expire, ...)

# 訂閱
SUBSCRIBE __keyspace@0__:cart:*
SUBSCRIBE __keyevent@0__:expired

# 收到的訊息只有 key name，沒有 value!
  channel: __keyspace@0__:cart:user_123
  message: "hset"
```

**重大限制**：
- ⚠️ 只通知 **key name + 操作類型**，**沒有 value**
- → Consumer 收到 event 還要 GET 一次拿 value，**有 race condition**（拿到的可能是另一次寫入後的值）
- ⚠️ Pub/Sub at-most-once，consumer 斷線就漏訊息
- ⚠️ 沒有 consumer group / offset / replay

**適用場景**（很窄）：
- Key 過期觸發業務動作（座位鎖過期 → 釋放庫存）
- 不需要精確 value 同步、只要知道「有事發生」

→ **不要用它做主要的 Redis → DB 同步機制**

### Pattern C：Redis Streams (Pub/Sub 進階版)

把 Redis Stream 當 event log，App 寫 Redis 時順便 XADD：

```python
def update_cart(user_id, item_id, qty):
    pipe = redis.pipeline()
    pipe.hset(f"cart:{user_id}", item_id, qty)
    pipe.xadd("cart_events", {
        "user": user_id, "item": item_id, "qty": qty
    })
    pipe.execute()  # 兩個操作 atomic

# Consumer (有 consumer group)
results = redis.xreadgroup(
    "db_writers", "consumer_1",
    {"cart_events": ">"},
    block=0
)
for stream, events in results:
    for event_id, data in events:
        db.execute("UPDATE cart SET ...")
        redis.xack("cart_events", "db_writers", event_id)
```

**優點**：
- 事件帶 payload（不像 Keyspace Notifications）
- 持久化（RDB/AOF 一起保存）
- Consumer group + offset + replay
- Pipeline 包住可保證 atomic 寫入

**缺點**：
- Stream 占 RAM (要定期 XTRIM)
- 比 Kafka 弱很多（無 partition、無 replication 之外的容錯）

**適用**：小規模場景當 Kafka 替代品

### 三 pattern 比較

| Pattern | 事件帶 value | 持久化 | Consumer Group | 推薦度 |
|---------|-------------|--------|----------------|--------|
| Application 雙寫 | ✅ | ✅ (Kafka) | ✅ | ⭐⭐⭐⭐⭐ 業界主流 |
| Keyspace Notifications | ❌ 只有 key | ❌ Pub/Sub at-most-once | ❌ | ⭐⭐ 過期事件 only |
| Redis Streams | ✅ | ✅ (Redis 本身) | ✅ | ⭐⭐⭐ 小規模替代 Kafka |

## 完整持久化策略（生產級）

```
┌─────────────────────────────────────────────────────────┐
│                   生產級 Redis 部署                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Master Redis ──┬── RDB snapshot (每 5 分鐘)            │
│                 ├── AOF (everysec)                      │
│                 └── Replication ──→ 2 個 replica         │
│                                                          │
│  App ─── 雙寫 ──→ Master Redis                           │
│       └── async ──→ Kafka ──→ Consumer ──→ Postgres     │
│                                                          │
│  災難恢復順序：                                            │
│    1. Master 掛 → Sentinel/Cluster failover 到 replica  │
│    2. 整個 Redis 集群掛 → 從 RDB/AOF 重啟，丟 ≤1 秒資料  │
│    3. 連 RDB/AOF 都壞 → 從 Postgres 完整重建 Redis      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## 何時開 RDB/AOF / 何時不開

| 場景 | RDB | AOF | 寫外部 DB |
|------|-----|-----|----------|
| 純 cache (e.g. session, hot product) | 開 | 開 (everysec) | ❌ 不需要 (cache 重建即可) |
| Source of truth 在 DB，Redis 是加速層 | 開 | 不開或 everysec | ✅ 必要 |
| **Redis 是 primary store** (高度依賴 in-memory speed) | 開 | 開 (always) | ✅ 必要 (背景備份) |
| Redis 用作 message queue (Streams) | 開 | 開 | 看需求 |
| 短期 ephemeral state (TTL < 1 hr) | 不開 | 不開 | ❌ |

→ **單純 cache 可以兩個都不開**，反正 cache miss 會回 DB 重建。但生產建議至少開 RDB（每小時 snapshot），重啟時不用全部 cache miss。

## 容量估算

RDB / AOF 對磁碟和效能的影響：

| 項目 | 影響 |
|------|------|
| RDB 子 process fork | RAM 大時 fork 時間 ~10 ms/GB（COW 後續無壓力） |
| AOF 檔案大小 | 通常 1-3x of RAM (rewrite 後降到 ~1x) |
| AOF appendfsync everysec 寫入影響 | <10% throughput drop |
| AOF appendfsync always 寫入影響 | 50%+ throughput drop |
| RDB snapshot 期間磁碟 IO | 寫入速率 ~RAM size / 30 sec (~30 GB/min) |

→ 16 GB RAM Redis：RDB 檔案 ~5 GB、AOF 檔案 ~30 GB（rewrite 後 ~16 GB）。磁碟要至少 100 GB。

## 常見坑

1. **以為 RDB/AOF 會幫你寫到外部 DB** ← 你剛剛的盲區。它們只是寫本機磁碟
2. **只開 RDB 沒開 AOF**：機器突然斷電會丟最多一個 snapshot 週期（分鐘級）
3. **AOF rewrite 期間磁碟暴增**：BGREWRITEAOF 會新建一個壓縮版本，**期間磁碟用量瞬間 2x**
4. **fork 失敗 (OOM)**：Linux overcommit_memory=0 時，RAM 用超過 50% 後 fork 會失敗 → 設 `vm.overcommit_memory = 1`
5. **Replication 不算持久化**：3 個 replica 同時掛或網路分區仍會丟資料；replication ≠ 持久化
6. **Keyspace Notifications 當主同步機制**：value 沒帶、at-most-once、漏訊息——這些坑都會踩到
7. **AOF/RDB 都開 + 雙寫 DB 還會丟資料嗎？** 會：(a) Redis fsync 沒到磁碟前斷電 (b) Kafka producer 沒 ack 就斷 (c) Outbox 沒實作 → 雙寫不 atomic

## 一句話總結

> **RDB/AOF 是 Redis 對自己負責的本機磁碟持久化，跟外部 DB 完全沒關係。**
>
> **「async 寫到外部 DB」是另一套 pattern**（write-behind / event-driven），業界主流是「Application 雙寫到 Kafka，Consumer 寫 DB」。
>
> **生產通常兩層都做**：RDB/AOF 救 Redis 重啟、寫 DB 救整個 Redis 爆炸。
