# Distributed Task Scheduler — 分散式任務排程系統架構

## 1. 核心挑戰

分散式任務排程器 (Distributed Task Scheduler) 的設計核心是 **在大規模下保證任務準時、恰好執行一次**：

```
規模：
  租戶數: ~10K organizations
  每日任務量: ~500M tasks/day → ~6K tasks/sec
  Cron 任務數: ~10M recurring jobs（每分鐘觸發 ~200K tasks）
  Worker 節點: ~50K heterogeneous workers（CPU / GPU / high-memory）
  任務延遲要求: one-time task 在 scheduled_time 後 < 5 秒內開始執行

核心矛盾：
  - 準時性：數百萬個任務需要在精確時間點觸發，但 Scheduler 不可能逐一輪詢
  - Exactly-once：Worker 可能隨時掛掉，任務不能丟也不能重複執行
  - 異構排程：不同任務需要不同資源（GPU、大記憶體），不能隨便分配
  - 優先級反轉：高優先任務不能被低優先任務餓死，但低優先也不能永遠不跑
```

---

## 2. 整體架構

```
┌──────────┐
│ Client   │
│ (API/UI) │
└────┬─────┘
     │ create / cancel / query task
     ▼
┌──────────────┐       ┌──────────────────────────┐
│  API Gateway │──────▶│  Task Service             │
│  (Rate Limit)│       │  (CRUD + validation)      │
└──────────────┘       └────┬──────────────────────┘
                            │ write
                            ▼
                   ┌──────────────────┐
                   │   Task Store     │
                   │  (MySQL sharded) │
                   │  + Redis Sorted  │
                   │    Sets (index)  │
                   └────┬─────────────┘
                        │ poll ready tasks
                        ▼
               ┌──────────────────────┐
               │   Scheduler Service  │◄──── Cron Evaluator
               │   (partitioned by    │      (time wheel)
               │    tenant/shard)     │
               └────┬─────────────────┘
                    │ push to queue
                    ▼
            ┌────────────────────┐
            │  Dispatch Queues   │
            │  (Redis / Kafka)   │
            │  P0 │ P1 │ P2     │
            └────┬───────────────┘
                 │ consume
                 ▼
        ┌──────────────────────┐
        │   Worker Pool        │
        │  ┌─────┐ ┌─────┐    │      ┌──────────────┐
        │  │ CPU │ │ GPU │    │─────▶│ Result Store  │
        │  │ wkr │ │ wkr │    │      │ (MySQL + S3)  │
        │  └─────┘ └─────┘    │      └──────────────┘
        │  ┌─────┐ ┌─────┐    │
        │  │ Mem │ │ CPU │    │      ┌──────────────┐
        │  │ wkr │ │ wkr │    │─────▶│ Dead Letter   │
        │  └─────┘ └─────┘    │      │ Queue (DLQ)   │
        └──────────────────────┘      └──────────────┘
```

---

## 3. Task Store 設計

### 資料模型

```sql
tasks:
  task_id         BIGINT PRIMARY KEY     -- Snowflake ID
  tenant_id       BIGINT NOT NULL        -- 多租戶隔離
  type            ENUM('ONE_TIME','RECURRING','EVENT_TRIGGERED')
  status          ENUM('PENDING','SCHEDULED','RUNNING',
                       'COMPLETED','FAILED','RETRYING','CANCELLED')
  priority        TINYINT DEFAULT 1      -- 0=highest, 2=lowest
  payload         JSON                   -- 任務執行的參數
  callback_url    VARCHAR(512)           -- 完成後 webhook 通知
  cron_expr       VARCHAR(64)            -- NULL if not recurring
  scheduled_time  TIMESTAMP NOT NULL     -- 下次應執行時間
  started_at      TIMESTAMP NULL
  completed_at    TIMESTAMP NULL
  max_retries     INT DEFAULT 3
  retry_count     INT DEFAULT 0
  lease_expiry    TIMESTAMP NULL         -- Worker 持有的租約到期時間
  lease_owner     VARCHAR(128) NULL      -- 持有租約的 Worker ID
  fencing_token   BIGINT DEFAULT 0       -- 單調遞增版本號
  created_at      TIMESTAMP
  updated_at      TIMESTAMP

-- 核心查詢索引：找出「到期且待排程」的任務
INDEX idx_ready_tasks (status, scheduled_time)
INDEX idx_tenant_tasks (tenant_id, status, created_at)
INDEX idx_lease_expiry (lease_expiry) -- 偵測過期租約
```

### 狀態機 (State Machine)

```
                    create
                      │
                      ▼
                  ┌────────┐
                  │PENDING │
                  └───┬────┘
                      │ scheduler picks up
                      ▼
                ┌──────────┐
                │SCHEDULED │
                └───┬──────┘
                    │ worker starts execution
                    ▼
                ┌───────┐
         ┌──────│RUNNING│──────┐
         │      └───────┘      │
         │ success        failure (retry < max)
         ▼                     ▼
   ┌──────────┐         ┌──────────┐
   │COMPLETED │         │RETRYING  │──▶ PENDING (re-enqueue)
   └──────────┘         └──────────┘
                               │ failure (retry >= max)
                               ▼
                         ┌────────┐
                         │ FAILED │──▶ Dead Letter Queue
                         └────────┘

  任何狀態 + user cancel ──▶ CANCELLED
```

### 為什麼用 MySQL + Redis 雙寫而不只用一個？

```
MySQL only 的問題：
  排程器每秒要找出「now() >= scheduled_time AND status = PENDING」的任務
  ~10M cron jobs → 即使有索引，頻繁 polling 仍造成 ~6K queries/sec
  DB CPU 會被 polling 吃掉

Redis only 的問題：
  Redis Sorted Set 按 scheduled_time 排序 → ZRANGEBYSCORE 極快（O(log N + M)）
  但 Redis 沒有 ACID → crash 時可能丟任務
  不適合當 source of truth

Hybrid 做法：
  MySQL = source of truth（持久化、ACID）
  Redis Sorted Set = scheduling index（score = scheduled_time epoch）

  寫入：先寫 MySQL，再 ZADD 到 Redis
  讀取：Scheduler 從 Redis ZRANGEBYSCORE 拿 ready tasks
  如果 Redis 掛了：fallback 到 MySQL polling（降級但不丟任務）
```

---

## 4. 排程策略：Polling vs Push vs Hybrid

這是排程器的 **核心設計決策**。

### 三種策略比較

| 維度 | Polling（Worker 主動拉） | Push（Scheduler 主動推） | Hybrid（Scheduler 預取 + Queue 分發） |
|------|------------------------|------------------------|--------------------------------------|
| 實作複雜度 | 低 | 中 | 高 |
| DB 負載 | **高**（每個 Worker 都 poll DB） | 低（只有 Scheduler poll） | **最低**（Scheduler poll Redis） |
| 負載均衡 | 天然均衡（忙的 Worker 不拉） | 需要 Scheduler 追蹤 Worker 負載 | Queue 自然均衡 |
| 即時性 | 有 polling interval delay | **即時** | 接近即時（Queue consume 延遲 < 10ms） |
| Worker 故障處理 | Worker 不拉 = 自動停止 | Scheduler 需偵測 + 重新分配 | 任務回到 Queue，其他 Worker 消費 |
| 適用規模 | < 100 Workers | < 1K Workers | **任意規模** |

### Hybrid 做法（推薦）

```
Scheduler 的工作：
  每 1 秒：
    1. ZRANGEBYSCORE ready_tasks 0 {now} LIMIT 1000
       → 從 Redis 拿出 scheduled_time <= now 的任務（最多 1000 個）
    2. 對每個 task：
       a. CAS 更新狀態 PENDING → SCHEDULED（MySQL + Redis）
       b. 根據 task.priority 推到對應的 Dispatch Queue
          LPUSH queue:P{priority}:{resource_type} {task_id}
    3. 如果本次拿到 1000 個 → 立刻再拉（說明有積壓）

Worker 的工作：
  loop:
    1. BRPOP queue:P0:cpu queue:P1:cpu queue:P2:cpu 5
       → 阻塞式消費（優先級高的 queue 排前面）
    2. 拿到 task_id → 從 MySQL 讀 task 詳情
    3. 嘗試獲取 lease（見下節）
    4. 執行任務 → 回報結果
```

### 為什麼 Scheduler 用 ZRANGEBYSCORE 而不是 BRPOP？

```
BRPOP 問題：
  任務的觸發時間不同，不能全丟進一個 list
  例如：task_A 要在 10:05 執行，task_B 要在 10:03 執行
  如果 LPUSH 順序是 A 先 B 後，BRPOP 會先拿 A → 時間還沒到

Sorted Set 解法：
  ZADD ready_tasks {scheduled_time_epoch} {task_id}
  ZRANGEBYSCORE ready_tasks 0 {now} → 只拿時間已到的任務
  天然按時間排序，不會提前觸發
```

---

## 5. Exactly-once 執行（最困難的問題）

分散式環境下真正的 exactly-once 不存在。實際做法是 **at-least-once delivery + 冪等執行 (Idempotent Execution) = effectively exactly-once**。

### Lease-based Locking（租約鎖）

```
Worker 拿到 task 後：
  UPDATE tasks
  SET status = 'RUNNING',
      lease_expiry = NOW() + INTERVAL 5 MINUTE,
      lease_owner = 'worker-42',
      fencing_token = fencing_token + 1
  WHERE task_id = 123
    AND status = 'SCHEDULED'
    AND (lease_expiry IS NULL OR lease_expiry < NOW())

  → 只有一個 Worker 能 CAS 成功（MySQL row lock）
  → 租約 5 分鐘，Worker 必須在 5 分鐘內完成或續約

續約（長任務）：
  Worker 每 2 分鐘：
    UPDATE tasks SET lease_expiry = NOW() + INTERVAL 5 MINUTE
    WHERE task_id = 123 AND lease_owner = 'worker-42'
```

### Worker 掛了怎麼辦？

```
Lease Reaper（租約回收器）：
  每 30 秒掃描：
    SELECT task_id FROM tasks
    WHERE status = 'RUNNING' AND lease_expiry < NOW()

  對每個過期任務：
    UPDATE tasks
    SET status = 'PENDING',       -- 回到待排程
        lease_owner = NULL,
        lease_expiry = NULL,
        retry_count = retry_count + 1,
        fencing_token = fencing_token + 1
    WHERE task_id = {id} AND status = 'RUNNING' AND lease_expiry < NOW()

  → 任務重新進入排程 → 另一個 Worker 會撿起來
```

### Fencing Token（防止殭屍 Worker）

```
問題場景：
  1. Worker-A 拿到 task-123，fencing_token = 5
  2. Worker-A GC pause 60 秒 → lease 過期
  3. Lease Reaper 回收 → fencing_token = 6
  4. Worker-B 拿到 task-123，fencing_token = 6，開始執行
  5. Worker-A 甦醒，嘗試寫入結果 ← 這是過期操作！

解法：
  Worker 完成任務時，必須帶上自己拿到的 fencing_token：
    UPDATE tasks
    SET status = 'COMPLETED', result = '...'
    WHERE task_id = 123 AND fencing_token = 5  -- Worker-A 的 token
    → 0 rows affected（因為 token 已經是 6）→ Worker-A 知道自己過期了

  如果任務有外部副作用（寫 DB、呼叫 API）：
    → 外部系統也要接收 fencing_token，拒絕舊 token 的操作
    → 或者任務本身設計為冪等（用 idempotency_key）
```

### 冪等性設計

```
每個任務帶 idempotency_key（通常 = task_id + attempt_number）：

例子：「轉帳 $100 給 User-B」
  ✗ 非冪等：execute_transfer(from=A, to=B, amount=100)
    → 重試 = 轉兩次 = $200

  ✓ 冪等：execute_transfer(idempotency_key="task-123-attempt-2", ...)
    → 接收端檢查：這個 key 處理過了嗎？是 → 直接回傳上次結果
    → 不管重試幾次，結果都一樣

實作：
  Redis SET idempotency:{key} {result} EX 86400 NX
  → NX = only if not exists → 第一次成功，第二次失敗
```

---

## 6. 優先級排程

### 多優先級佇列 (Priority Queue)

```
三個獨立的 Redis List（每種 resource type 各三個）：

  queue:P0:cpu    ← 最高優先（告警、支付結算）
  queue:P1:cpu    ← 一般優先（報表生成、通知發送）
  queue:P2:cpu    ← 最低優先（數據清理、日誌歸檔）

Worker 消費順序：
  BRPOP queue:P0:cpu queue:P1:cpu queue:P2:cpu 5
  → Redis BRPOP 按 key 順序優先：P0 有任務就先拿 P0
```

### 加權公平排程 (Weighted Fair Scheduling)

```
純優先級的問題：
  如果 P0 持續有任務 → P1、P2 永遠不會被執行 → 飢餓 (Starvation)

加權做法（Weighted Round Robin）：
  每輪消費比例：P0:P1:P2 = 6:3:1

  Scheduler 每批次分發 100 個任務：
    60 個從 P0 queue 拿
    30 個從 P1 queue 拿
    10 個從 P2 queue 拿

  如果 P0 不夠 60 個 → 剩餘配額給 P1 → P1 不夠給 P2

效果：
  P2 最差情況下仍能拿到 10% 的 Worker 資源
  P0 突然湧入大量任務時，最多佔用 60%（不會把 P1/P2 完全餓死）
```

### 優先級反轉 (Priority Inversion) 防止

```
場景：
  P0 任務依賴一個 P2 任務的結果（例：P0 需要 P2 先產生的資料）
  P2 被排在後面 → P0 卡住 → 實際延遲比 P2 還慘

解法：Priority Inheritance
  如果偵測到 P0 等待的任務是 P2 → 暫時將該 P2 任務提升為 P0
  → 借用 Linux 的 priority inheritance 概念

實務上較少在 Task Scheduler 實作完整的 priority inheritance，
通常用以下方式規避：
  1. 設計上避免跨優先級依賴
  2. 如有依賴 → 被依賴的任務自動繼承最高依賴者的優先級
  3. 設定 max_wait_time：P2 任務等超過 30 分鐘 → 自動提升為 P1
```

---

## 7. Cron 排程

### Cron 表達式 → 下次執行時間

```
Cron expression: "0 */5 * * *"（每 5 分鐘執行一次）

存儲方式：
  tasks 表的 type = 'RECURRING'
  cron_expr = "0 */5 * * *"
  scheduled_time = 下一次應觸發的時間

每次任務執行完畢：
  Scheduler 計算 next_execution_time(cron_expr, now())
  UPDATE tasks SET scheduled_time = {next_time}, status = 'PENDING'
  ZADD ready_tasks {next_time_epoch} {task_id}
```

### 時間輪 (Timing Wheel) 資料結構

```
問題：10M cron jobs，每秒都要檢查誰該觸發
  → 線性掃描 O(N) = 每秒掃 10M → 不可接受

Timing Wheel（Hierarchical）：
  ┌─────────────────────────────────────────────────┐
  │  Second Wheel: 60 slots（0-59 秒）              │
  │  ┌──┬──┬──┬──┬──┬──┬───────────┬──┐            │
  │  │ 0│ 1│ 2│ 3│ 4│ 5│  ...      │59│            │
  │  └──┴──┴──┴──┴──┴──┴───────────┴──┘            │
  │                                                  │
  │  Minute Wheel: 60 slots（0-59 分）              │
  │  Hour Wheel: 24 slots（0-23 時）                │
  │  Day Wheel: 31 slots（1-31 日）                 │
  └─────────────────────────────────────────────────┘

運作方式：
  - 每秒 tick → 檢查 second_wheel[current_second] 的任務 list → 觸發
  - 每分鐘 → minute_wheel cascade down → 把下一分鐘的任務倒入 second_wheel
  - 每小時 → hour_wheel cascade down

複雜度：
  插入：O(1)（直接放到對應 slot）
  觸發：O(1)（只看當前 slot）
  比 priority queue（O(log N)）更快，且在 10M 任務量下差異巨大

實務上可用 Redis Sorted Set 近似：
  → ZRANGEBYSCORE 是 O(log N + M)，N=10M 時 log N ≈ 23 → 仍然很快
  → 比自建 timing wheel 更易維運
```

### 處理錯過的執行 (Missed Executions)

```
場景：Scheduler 掛了 10 分鐘，一個每分鐘執行的 cron job 錯過了 10 次

三種策略（透過 task 配置決定）：

1. Skip（跳過）：只執行下一次
   適用：指標採集、心跳檢查
   → 錯過就錯過，下次再來

2. Catch-up（追趕）：把錯過的都補跑
   適用：ETL pipeline、帳務結算
   → scheduled_time < now() 的全部觸發
   → 注意：可能瞬間觸發大量任務 → 需要 rate limiting

3. Coalesce（合併）：只補跑一次
   適用：快取刷新、報表生成
   → 不管錯過幾次，只跑最新一次
   → 最常用的策略
```

---

## 8. Worker 管理

### 註冊與心跳 (Registration & Heartbeat)

```
Worker 啟動時：
  POST /workers/register
  {
    "worker_id": "worker-42",
    "capabilities": ["cpu", "gpu:A100", "memory:64GB"],
    "max_concurrent_tasks": 4,
    "current_load": 0
  }

  → Scheduler 記錄到 Redis Hash:
    HSET workers:worker-42 capabilities "cpu,gpu:A100" max_tasks 4 load 0 last_heartbeat {now}

心跳（每 10 秒）：
  Worker → Scheduler: PUT /workers/heartbeat
  {
    "worker_id": "worker-42",
    "current_load": 2,         -- 正在跑 2 個任務
    "tasks_running": ["task-100", "task-200"]
  }

  → Scheduler 更新 Redis: HSET workers:worker-42 load 2 last_heartbeat {now}

故障偵測：
  Scheduler 每 30 秒掃描：
    HSCAN workers:* → 找 last_heartbeat < now - 30s 的 Worker
    → 標記為 dead → 該 Worker 持有的 lease 全部過期回收
```

### 任務路由 (Task Routing)

```
每個 task 有 resource_requirements：
  {
    "task_id": 456,
    "resource_requirements": {"type": "gpu", "gpu_model": "A100", "memory_gb": 32}
  }

路由邏輯（Scheduler dispatch 時）：
  1. 從 Worker 註冊表篩選符合條件的 Workers
  2. 按 queue 分流：task 推到 queue:P{priority}:{resource_type}
  3. 對應類型的 Worker 只消費自己的 queue

例如：
  GPU Worker  → BRPOP queue:P0:gpu queue:P1:gpu queue:P2:gpu
  CPU Worker  → BRPOP queue:P0:cpu queue:P1:cpu queue:P2:cpu
  High-Mem Worker → BRPOP queue:P0:highmem queue:P1:highmem queue:P2:highmem
```

### Auto-scaling

```
監控指標：
  queue_depth = LLEN queue:P{x}:{type}  → 每個 queue 的積壓量
  wait_time = now - oldest_task_scheduled_time  → 最老任務等了多久

Scale-up 規則：
  IF queue_depth > 1000 OR wait_time > 60s:
    → 向 K8s / cloud provider 請求增加 Worker Pod
    → 目標：queue_depth / tasks_per_worker_per_minute = 需要幾個新 Worker

Scale-down 規則：
  IF all workers load < 20% for 10 minutes:
    → 標記 Worker 為 draining（不接新任務）
    → 等現有任務完成 → 關閉 Worker

冷卻期：Scale-up 後 5 分鐘內不 scale-down（避免震盪）
```

---

## 9. 失敗處理

### 重試策略 (Retry with Exponential Backoff + Jitter)

```python
def calculate_retry_delay(retry_count, base_delay=1.0, max_delay=300.0):
    # Exponential backoff
    delay = base_delay * (2 ** retry_count)
    # Cap at max
    delay = min(delay, max_delay)
    # Full jitter: uniform random [0, delay]
    delay = random.uniform(0, delay)
    return delay

# retry_count=0 → [0, 1s]
# retry_count=1 → [0, 2s]
# retry_count=2 → [0, 4s]
# retry_count=3 → [0, 8s]
# ...
# retry_count=8 → [0, 256s]
# retry_count=9 → [0, 300s] (capped)
```

### 為什麼要加 Jitter？

```
不加 Jitter：
  100 個任務同時失敗 → 全部在 retry_count=2 時等 4 秒 → 同時重試
  → 「驚群效應」(Thundering Herd) → 下游又被打爆 → 又全部失敗

加 Full Jitter：
  100 個任務各自等 [0, 4s] 之間的隨機時間 → 重試分散在 4 秒內
  → 下游壓力平滑 → 成功率大幅提升
```

### Dead Letter Queue (DLQ)

```
任務失敗 retry_count >= max_retries：
  1. 狀態 → FAILED
  2. 推入 DLQ（獨立的 Kafka topic 或 Redis List）
  3. 發送告警通知（PagerDuty / Slack）

DLQ 的後續處理：
  - 人工檢查：看 payload、error log → 判斷是 bug 還是暫時性故障
  - 批次重放 (Replay)：修復 bug 後，把 DLQ 裡的任務重新 enqueue
  - 自動分類：根據 error type 分類 → transient error 自動重放，permanent error 歸檔
```

### 毒藥偵測 (Poison Pill Detection)

```
某個 task 每次執行都讓 Worker crash（例：OOM、segfault）：
  → Worker 拿到 → crash → lease 過期 → 另一個 Worker 拿到 → 又 crash
  → 循環消耗 Worker 資源

偵測方式：
  task.retry_count > max_retries / 2 AND 每次 error 都在 < 5 秒內發生
  → 標記為 poison pill → 立刻移到 DLQ → 不再分配

額外保護：
  Worker 執行 task 前先檢查 retry_count：
    IF retry_count > 3 AND avg_execution_time < 5s:
      → 拒絕執行 → 回報 Scheduler → 直接移入 DLQ
```

### 熔斷器 (Circuit Breaker)

```
場景：某類型任務（例：call external API）連續失敗率 > 50%
  → 繼續重試只是浪費資源

Circuit Breaker 狀態機：
  CLOSED（正常）→ 失敗率 > 50%（最近 100 次中）→ OPEN（停止該類型任務）
  OPEN → 等 60 秒 → HALF_OPEN（放 10% 流量試探）
  HALF_OPEN → 成功率恢復 → CLOSED
  HALF_OPEN → 仍然失敗 → OPEN（再等 120 秒）

實作：
  Redis key: circuit:{task_type}:failures = 計數器
  Scheduler dispatch 前檢查 circuit 狀態 → OPEN 則跳過
```

---

## 10. 可擴展性設計

### Scheduler 分區 (Partitioned Scheduler)

```
單一 Scheduler 的瓶頸：
  6K tasks/sec → 一個 Scheduler 可以扛
  但 50K tasks/sec → 單點瓶頸

分區策略：
  按 tenant_id % N 分配給 N 個 Scheduler instance

  Scheduler-0: 負責 tenant_id % 4 == 0 的所有任務
  Scheduler-1: 負責 tenant_id % 4 == 1 的所有任務
  ...

  每個 Scheduler 只 poll 自己分區的 Redis Sorted Set：
    ZRANGEBYSCORE ready_tasks:shard_{i} 0 {now} LIMIT 1000

Leader Election：
  使用 ZooKeeper / etcd 做 Scheduler 的 leader election
  → Leader 負責分配 partition → Scheduler mapping
  → 某個 Scheduler 掛了 → Leader 重新分配該 partition 給活著的 Scheduler
```

### Task Store Sharding

```
MySQL sharding by tenant_id：
  → 同一租戶的任務在同一 shard → 查詢不需要 scatter-gather
  → Shard 數量根據 tenant 數量和資料量決定

估算：
  10K tenants × 50K tasks/tenant（活躍中）= 500M 行
  每行 ~500 bytes → ~250GB
  4 個 shard → 每 shard ~62GB → 舒適範圍

Redis Sorted Set 也按 shard 分：
  ready_tasks:shard_0, ready_tasks:shard_1, ...
  每個 Scheduler instance 負責一個 shard
```

### 多區域部署 (Multi-Region)

```
全球部署時（例：US-East, EU-West, AP-Southeast）：

方式 1：區域獨立
  每個 region 完整的 Scheduler + Worker + Store
  任務不跨區域 → 低延遲但無法用其他 region 的 idle Workers

方式 2：全局排程 + 區域執行
  全局 Scheduler → 知道所有 region 的 Worker 負載
  任務 preferably 在指定 region 執行，但 overflow 可轉移

通常選擇方式 1：
  → 簡單、低延遲、無跨區域依賴
  → 全局排程帶來的跨 region 資料同步成本 > 收益
```

---

## 11. 容量估算

| 指標 | 估算 |
|------|------|
| 每日任務量 | 500M → **~6K tasks/sec** |
| Cron 觸發量 | 10M jobs × 平均每小時 1 次 = ~2.8K triggers/sec |
| Peak QPS (2x avg) | **~12K tasks/sec** |
| Task record size | ~500 bytes |
| Task Store (active) | 500M × 500B = **~250GB** |
| Task Store (archival/year) | 500M/day × 365 × 500B = **~91TB** |
| Redis Sorted Set (scheduling index) | 500M × (8B score + 8B task_id) = **~8GB** |
| Redis Dispatch Queues | Peak 100K pending × 8B = **< 1MB** |
| Worker heartbeat (Redis) | 50K workers × 200B = **~10MB** |
| MySQL shards | 4 shards × 2 replicas = **12 MySQL instances** |
| Redis nodes (scheduling) | 3 primary + 3 replica = **6 Redis instances** |
| Scheduler instances | **4**（各負責 1 partition） |
| Bandwidth (task dispatch) | 12K/sec × 500B = **~6MB/s** |

### 歸檔策略

```
熱資料（< 7 天）：MySQL primary shards → SSD
溫資料（7-30 天）：MySQL replica → HDD（只供查詢）
冷資料（> 30 天）：歸檔到 S3 + Hive（batch analytics）

COMPLETED / FAILED 任務超過 7 天 → 搬到 archive 表
  → Primary 表維持在 ~50M 行 → 索引效率高
```

---

## 12. 監控與告警

```
核心指標（Prometheus + Grafana）：

1. Queue Depth（每個 priority × resource_type）
   → queue_depth > 5000 持續 2 分鐘 → P1 告警
   → queue_depth > 20000 → P0 告警（可能需要 scale-up）

2. Task Completion Rate
   → 成功率 < 95% 持續 5 分鐘 → P1 告警
   → 成功率 < 80% → P0 告警 + circuit breaker

3. Scheduling Latency（from scheduled_time to started_at）
   → p50 < 1s, p99 < 5s → 正常
   → p99 > 10s → Scheduler 可能過載

4. Task Execution Time
   → p99 > task 的 expected_duration × 3 → 可能有問題

5. Stuck Tasks
   → status = RUNNING AND started_at < now() - 2 × expected_duration
   → 可能 Worker 假死但 lease 還沒過期

6. DLQ Size
   → DLQ 增長率 > 100/hour → 某類型任務系統性故障

7. Lease Expiry Rate
   → lease 過期率 > 5% → Worker 不穩定或 lease TTL 太短
```

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Task Store | **MySQL + Redis 雙層** | MySQL 保證 durability；Redis Sorted Set 做 O(log N) 時間索引，避免 DB polling 壓力 |
| 排程模型 | **Hybrid（Scheduler 預取 → Queue 分發 → Worker 消費）** | 純 polling 打爆 DB；純 push 需追蹤 Worker 狀態；hybrid 結合兩者優點 |
| Exactly-once | **Lease + Fencing Token + 冪等** | 真正 exactly-once 不存在；lease 防止任務卡死；fencing token 防殭屍 Worker；冪等保證重試安全 |
| 優先級 | **多佇列 + 加權公平排程（6:3:1）** | 純優先級導致低優先飢餓；加權保證每個級別最低 10% 資源 |
| Cron 觸發 | **Redis Sorted Set（生產首選）/ Timing Wheel（極端規模）** | Sorted Set 夠快且易維運；Timing Wheel 在 100M+ 任務時 O(1) 優勢明顯 |
| 錯過執行 | **Coalesce 為預設策略** | 大多數場景不需要追趕所有錯過的執行；catch-up 可能造成瞬間負載暴增 |
| Scheduler HA | **分區 + Leader Election** | 每個 Scheduler 負責一個 partition → 水平擴展 + 故障自動轉移 |
| 失敗處理 | **Exponential Backoff + Jitter + Circuit Breaker + DLQ** | Backoff 避免打爆下游；Jitter 避免驚群；Circuit Breaker 快速失敗；DLQ 兜底 |
| Worker 管理 | **心跳 + 資源標籤路由 + Auto-scaling** | 心跳偵測故障；標籤匹配異構資源；auto-scaling 應對波峰波谷 |

---

## 14. 面試常見 Follow-up

### Q: 如果 Scheduler 掛了，任務會不會丟失？

```
不會。因為 MySQL 是 source of truth：
  1. Scheduler 掛 → Leader election 在 < 10 秒內選出新 Leader
  2. 新 Leader 重新分配 partition → 新 Scheduler 接手
  3. 新 Scheduler 從 Redis Sorted Set 繼續 poll（Redis 資料還在）
  4. 即使 Redis 也掛了 → fallback 到 MySQL polling（慢但不丟）

期間影響：
  - 任務觸發延遲 10-30 秒（leader election + recovery）
  - 不會丟任務（MySQL 裡都有）
  - 不會重複執行（lease + fencing token 保護）
```

### Q: 如何處理數百萬個 cron job 同時到期（例：整點觸發）？

```
「整點風暴」（Top of Hour Storm）：
  假設 10M cron jobs 中 20% 是整點觸發 → 2M tasks 在同一秒到期

解法一：Jitter injection
  創建 cron job 時自動加 random jitter（0-30 秒）
  "0 * * * *" → 實際觸發在 00:00:00 ~ 00:00:30 之間分散

解法二：Scheduler 批次限流
  每秒最多 dispatch 10K tasks → 2M tasks 分散在 200 秒內
  → 任務延遲 < 200 秒 vs 系統崩潰 → 可接受的降級

解法三：Pre-scheduling
  Scheduler 提前 5 分鐘把 「將在 5 分鐘內到期」的任務推入 Dispatch Queue
  Queue 裡用 delayed message（Kafka timestamp / Redis keyspace notification）
  → 到點時任務已在 queue 裡 → Worker 直接消費，無瞬時壓力
```

### Q: 任務之間有依賴關係怎麼辦（DAG scheduling）？

```
DAG（有向無環圖）排程：
  Task A → Task B → Task C（B 要等 A 完成，C 要等 B 完成）

資料模型擴展：
  task_dependencies:
    task_id        BIGINT
    depends_on_id  BIGINT
    PRIMARY KEY (task_id, depends_on_id)

觸發邏輯：
  Task A 完成 → 查詢「誰依賴 A？」→ Task B
  → 檢查 Task B 的所有依賴是否都完成
  → 如果都完成 → Task B 狀態 → PENDING（可排程）

這本質上就是 Airflow 的核心：
  → 小規模：自建 DAG evaluator
  → 大規模：直接用 Airflow / Temporal / Cadence 等成熟方案
```

### Q: 如何確保多租戶之間的公平性？

```
一個大租戶提交 1M 任務 → 佔滿所有 Worker → 其他租戶沒資源

解法：Tenant-level Rate Limiting + Fair Scheduling
  1. 每個 tenant 有 quota：max_concurrent_tasks = 1000
  2. Scheduler dispatch 前檢查：
     current_running[tenant_id] >= quota → 暫不排程
  3. 使用 Weighted Fair Queue：
     每個 tenant 一個 virtual queue → round-robin 在 tenants 之間分配 Worker 時間
  4. Burst 容許：短期超過 quota 的 20% → 但持續超過 → 限流
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— 任務類型（one-time / cron / event-triggered）、QPS、Worker 規模、延遲要求
2. **整體架構**（2 分鐘）— 畫出 API → Task Store → Scheduler → Queue → Worker → Result Store 的完整鏈路
3. **Task Store 設計 + 狀態機**（2 分鐘）— MySQL schema、狀態流轉、Redis Sorted Set 做 scheduling index
4. **排程策略（核心）**（3 分鐘）— Polling vs Push vs Hybrid 三選一，推導出 hybrid 的優勢，解釋 Scheduler 如何預取 + Queue 分發
5. **Exactly-once（核心）**（3 分鐘）— Lease + Fencing Token + 冪等的三層防護，畫出 Worker crash → lease 過期 → re-assign 的時序圖
6. **Deep Dive（面試官選）**（2 分鐘）— 優先級排程 / Cron timing wheel / 失敗處理 / Worker 管理 / 多租戶隔離
