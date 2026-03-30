# 分散式交易 (Distributed Transactions)：2PC vs Saga vs TCC

## 1. 問題本質：為什麼單機交易不夠？

在單體應用 (Monolith) 中，一個資料庫交易 (ACID Transaction) 可以保證多個操作的原子性 (Atomicity)：

```sql
BEGIN;
  UPDATE accounts SET balance = balance - 100 WHERE user_id = 'A';
  UPDATE accounts SET balance = balance + 100 WHERE user_id = 'B';
COMMIT;
```

但當系統拆成微服務 (Microservices)，每個服務擁有自己的資料庫時，這個模式就壞了：

```
OrderService (MySQL)  ──→  InventoryService (PostgreSQL)  ──→  PaymentService (DynamoDB)
   各自獨立的 DB，沒有共享交易管理器
```

**根本矛盾：CAP 定理 (CAP Theorem)**

- **CP 路線**（犧牲可用性換一致性）：2PC 走這條路。所有節點必須同時可達才能完成交易，任一節點故障 → 整個交易阻塞。
- **AP 路線**（犧牲強一致性換可用性）：Saga 走這條路。接受最終一致性 (Eventual Consistency)，透過補償交易修復不一致。

**實務數據：** 一個跨 3 個服務的同步交易，假設每個服務 p99 延遲 50ms，加上 2PC 的 2 次網路往返（每次 0.5ms intra-DC），光是協調延遲就是 ~150ms+。若任一服務在此期間持有行鎖 (Row Lock)，其他想寫同一行的請求全部排隊等待——吞吐量直接崩塌。

---

## 2. 兩階段提交 (Two-Phase Commit, 2PC)

### 運作機制

```
                    Coordinator
                   /     |     \
                  v      v      v
           Participant  Participant  Participant
                A          B           C

Phase 1 (Prepare / Vote):
  Coordinator → A: "PREPARE"   A: 寫 redo/undo log, 鎖定資源 → "YES"
  Coordinator → B: "PREPARE"   B: 寫 redo/undo log, 鎖定資源 → "YES"
  Coordinator → C: "PREPARE"   C: 資源不足 → "NO"

Phase 2 (Commit / Abort):
  任一 NO → Coordinator 廣播 ABORT → 所有 Participant rollback
  全部 YES → Coordinator 廣播 COMMIT → 所有 Participant commit
```

### 時序分析

```
時間軸：
t0 ──── Coordinator 發送 PREPARE ────────────── 1 RTT (0.5ms intra-DC)
t1 ──── Participants 寫 WAL + 鎖定資源 ──────── 磁碟 fsync (~1-5ms SSD)
t2 ──── Participants 回覆 VOTE ──────────────── 1 RTT
t3 ──── Coordinator 寫 COMMIT 決定到 WAL ────── 磁碟 fsync (~1-5ms)
t4 ──── Coordinator 發送 COMMIT ─────────────── 1 RTT
t5 ──── Participants 執行 COMMIT ─────────────── 磁碟 fsync

總延遲：4 RTT + 3 次 fsync ≈ 2ms + 9ms = ~11ms (最佳情況, intra-DC, SSD)
鎖定持續時間：t1 到 t5 ≈ 整個交易期間全部鎖住
```

### 致命缺陷：阻塞問題 (Blocking Problem)

```
場景：Coordinator 在 Phase 1 結束後、Phase 2 開始前崩潰

Participant A: 已投 YES，持有行鎖，等待 COMMIT 或 ABORT...
Participant B: 已投 YES，持有行鎖，等待 COMMIT 或 ABORT...

  → 兩個 Participant 都不知道最終決定
  → 不能自行 commit（也許 C 投了 NO）
  → 不能自行 abort（也許所有人都投了 YES）
  → 只能等 Coordinator 恢復 → 鎖持續被佔用 → 其他交易超時
```

這是 2PC 的根本限制：**它不是容錯的 (Fault-tolerant)**。Coordinator 是單點故障 (Single Point of Failure)。

### 適用場景

| 條件 | 說明 |
|------|------|
| 同質資料庫 (Homogeneous DB) | 如 MySQL XA Transaction 跨同一叢集的多個分片 |
| 短命交易 | 鎖定時間 < 50ms，不會造成嚴重的鎖競爭 |
| 同一資料中心 | RTT 低（0.5ms），降低阻塞風險 |
| 強一致性是硬需求 | 金融核心帳務——寧可阻塞也不能不一致 |

---

## 3. 三階段提交 (Three-Phase Commit, 3PC)

3PC 在 Phase 1 和 Phase 2 之間插入一個 **Pre-commit** 階段：

```
Phase 1 (Can Commit?): Coordinator 詢問，Participant 回覆 YES/NO
Phase 2 (Pre-Commit):  全部 YES → Coordinator 發送 PRE-COMMIT
                        Participant 收到後知道「大家都同意了」
Phase 3 (Do Commit):   Coordinator 發送 DO-COMMIT → Participant 真正 commit
```

**解決了什麼？** 如果 Coordinator 在 Phase 2 後崩潰，Participant 知道所有人都投了 YES（因為收到了 PRE-COMMIT），可以安全地自行 commit。消除了 2PC 的不確定狀態 (Uncertainty Period)。

**為什麼實務上幾乎不用？**

- **不能容忍網路分區 (Network Partition)**：如果 Participant A 收到了 PRE-COMMIT 但 Participant B 沒收到（網路分區），A 可能自行 commit 而 B timeout 後 abort → 不一致。
- **額外一輪網路往返**：3 RTT → 延遲更高。
- **在真實分散式環境（跨機房、跨雲）毫無用武之地**：網路分區是常態，不是例外。

**結論：3PC 是一個理論上優美但實務上無用的協議。** 面試中知道它存在即可，不要在設計中使用它。

---

## 4. Saga 模式 (Saga Pattern)——實戰主流方案

Saga 將一個長交易拆成一系列本地交易 (Local Transactions)，每個本地交易都有對應的補償交易 (Compensating Transaction)。如果某一步失敗，依序執行前面步驟的補償交易來回滾。

```
正向流程：T1 → T2 → T3 → T4 → 完成 ✓
失敗在 T3：T1 → T2 → T3(fail) → C2 → C1 → 回滾 ✗

Ti = 第 i 步的正向交易
Ci = 第 i 步的補償交易
```

### 4a. 編排式 Saga (Orchestration-based Saga)

由一個中央 Saga 協調器 (Saga Orchestrator) 管理整個流程，維護狀態機 (State Machine)。

```
                    ┌─────────────────────┐
                    │   OrderSaga         │
                    │   Orchestrator      │
                    │                     │
                    │  State Machine:     │
                    │  STARTED            │
                    │  → INVENTORY_RESERVED│
                    │  → PAYMENT_CHARGED  │
                    │  → ORDER_CONFIRMED  │
                    │  or COMPENSATING... │
                    └─────┬───┬───┬───────┘
                          │   │   │
              ┌───────────┘   │   └───────────┐
              v               v               v
        InventoryService  PaymentService  ShippingService
        reserve()         charge()        ship()
        compensate()      refund()        cancelShip()
```

**Orchestrator 狀態機虛擬碼：**

```python
class OrderSaga:
    def execute(self, order):
        try:
            # Step 1: 預留庫存
            self.state = 'RESERVING_INVENTORY'
            inventory_result = inventory_service.reserve(order.items)
            self.save_state()  # 持久化狀態到 DB

            # Step 2: 扣款
            self.state = 'CHARGING_PAYMENT'
            payment_result = payment_service.charge(order.user_id, order.total)
            self.save_state()

            # Step 3: 安排出貨
            self.state = 'ARRANGING_SHIPMENT'
            shipping_result = shipping_service.ship(order.address, order.items)
            self.save_state()

            self.state = 'COMPLETED'
            self.save_state()

        except StepFailure as e:
            self.compensate(e.failed_step)

    def compensate(self, failed_step):
        """反向補償已完成的步驟"""
        compensation_steps = {
            'ARRANGING_SHIPMENT': [payment_service.refund, inventory_service.release],
            'CHARGING_PAYMENT':   [inventory_service.release],
            'RESERVING_INVENTORY': [],  # 第一步失敗不需要補償
        }
        for comp in compensation_steps[failed_step]:
            comp(self.saga_id)  # 帶 saga_id 確保冪等
```

**優勢：**
- 流程集中管理，易於理解全貌
- 新增步驟只需修改 Orchestrator
- 狀態持久化後可從任何中斷點恢復
- 容易實作超時 (Timeout) 和重試 (Retry) 策略

**劣勢：**
- Orchestrator 本身是單點故障（需要高可用部署）
- Orchestrator 與所有服務耦合（知道每個服務的 API）
- 隨著業務增長，Orchestrator 可能變成 God Object

### 4b. 編舞式 Saga (Choreography-based Saga)

沒有中央協調器。每個服務完成自己的本地交易後，發出領域事件 (Domain Event)，下一個服務監聽事件並執行。

```
OrderService          InventoryService       PaymentService        ShippingService
     │                      │                      │                     │
     │ ─── OrderCreated ──→ │                      │                     │
     │                      │                      │                     │
     │                      │ ─ InventoryReserved → │                     │
     │                      │                      │                     │
     │                      │                      │ ── PaymentCharged ─→ │
     │                      │                      │                     │
     │ ← ────────────────── │ ← ─────────────────  │ ← OrderShipped ──── │
     │                      │                      │                     │
     │   (更新訂單狀態)       │                      │                     │

失敗場景（PaymentService 扣款失敗）：
     │                      │                      │                     │
     │                      │ ← PaymentFailed ──── │                     │
     │                      │                      │                     │
     │ ← InventoryReleased  │ (補償：釋放庫存)      │                     │
     │                      │                      │                     │
     │   (標記訂單失敗)       │                      │                     │
```

**優勢：**
- 完全解耦——服務之間不直接通訊
- 沒有單點故障
- 天然的事件驅動架構 (Event-driven Architecture)

**劣勢：**
- 難以追蹤全局流程（事件鏈散落在各服務中）
- 有循環依賴 (Cyclic Dependency) 風險——Service A 監聽 Service B 的事件，B 又監聽 A 的
- 隨著服務增多，事件流變成「義大利麵」——極難除錯
- 沒有集中的狀態，難以回答「這筆訂單現在到哪一步了？」

### 4c. 補償交易 (Compensating Transactions) 的本質

**補償 ≠ 撤銷 (Undo)**。補償是一個新的正向交易，語意上抵消前一個交易的效果。

```
原始操作              補償操作                   備註
─────────────────────────────────────────────────────────
扣款 $100            退款 $100                  可補償 ✓
預留庫存 5 件         釋放庫存 5 件              可補償 ✓
寄出確認 Email       寄出取消通知 Email          不可真正撤銷 ⚠
實體出貨             發起退貨流程                代價高昂 ⚠
發送簡訊通知          無法收回                   不可補償 ✗
```

**設計原則：**

1. **Saga 的步驟排序要把不可補償的操作放在最後**——出貨、發 Email 等放在所有可補償步驟（預留庫存、扣款）之後。
2. **補償操作本身也可能失敗**——必須搭配重試機制 + 冪等設計。
3. **語意鎖 (Semantic Lock)**——在 Saga 執行期間，用狀態欄位標記資源為「處理中」（如 `order_status = PENDING`），防止其他 Saga 操作同一筆資源。

### 4d. Orchestration vs Choreography 比較

| 維度 | Orchestration | Choreography |
|------|---------------|--------------|
| **耦合度** | 中（Orchestrator 知道所有服務） | 低（服務只知道事件，不知道彼此） |
| **流程可見性** | 高（看 Orchestrator 狀態機即可） | 低（需要分散式追蹤工具才能看全貌） |
| **新增步驟** | 容易（修改 Orchestrator） | 困難（需確保新事件不破壞現有鏈） |
| **除錯難度** | 低（集中日誌 + 狀態機） | 高（需要 Correlation ID + 分散式追蹤） |
| **單點故障** | Orchestrator（需高可用） | 無（但 Message Broker 是隱含的 SPOF） |
| **適合規模** | 5–15 步的複雜流程 | 3–5 步的簡單流程 |
| **團隊邊界** | 適合單一團隊擁有整個流程 | 適合不同團隊各自擁有服務 |
| **可測試性** | 高（Mock 各服務，測試狀態機） | 低（需要整合測試驗證事件鏈） |

**經驗法則：** 超過 4 個步驟的 Saga，幾乎都應該用 Orchestration。Choreography 看起來優雅，但在生產環境中追蹤問題的成本遠高於維護一個 Orchestrator。

---

## 5. TCC 模式 (Try-Confirm-Cancel)

TCC 是 2PC 精神在業務層的實現——用業務語意的「預留」取代資料庫層的「鎖」。

### 三個階段

```
Phase 1 — Try（嘗試/預留）:
  AccountService.try(user_A, -100)   → 凍結 A 帳戶 $100（balance 不變，frozen += 100）
  AccountService.try(user_B, +100)   → 預留 B 帳戶的入帳空間
  InventoryService.try(sku, qty=5)   → 預留 5 件庫存（available -= 5, reserved += 5）

Phase 2a — Confirm（確認）:
  AccountService.confirm(txn_id)     → frozen -= 100, balance -= 100（真正扣款）
  InventoryService.confirm(txn_id)   → reserved -= 5（庫存正式扣除）

Phase 2b — Cancel（取消，如果 Try 階段任一失敗）:
  AccountService.cancel(txn_id)      → frozen -= 100（解凍）
  InventoryService.cancel(txn_id)    → reserved -= 5, available += 5（釋放預留）
```

**資料模型範例：**

```sql
-- 帳戶表：支援 TCC 的欄位設計
CREATE TABLE accounts (
    user_id     VARCHAR(36) PRIMARY KEY,
    balance     DECIMAL(18,2) NOT NULL,  -- 實際餘額
    frozen      DECIMAL(18,2) NOT NULL DEFAULT 0,  -- Try 階段凍結的金額
    -- 可用餘額 = balance - frozen
    CHECK (balance - frozen >= 0)
);

-- TCC 交易記錄表
CREATE TABLE tcc_transactions (
    txn_id      VARCHAR(36) PRIMARY KEY,
    status      ENUM('TRYING', 'CONFIRMED', 'CANCELLED') NOT NULL,
    created_at  TIMESTAMP NOT NULL,
    expired_at  TIMESTAMP NOT NULL,  -- Try 預留超時時間
    INDEX idx_expired (status, expired_at)  -- 用於掃描超時的 Try
);
```

### TCC vs Saga 的關鍵差異

| 維度 | TCC | Saga |
|------|-----|------|
| **資源隔離** | Try 階段用「預留」軟隔離資源 | 無隔離，直接執行交易 |
| **一致性窗口** | 更短——Try 成功後 Confirm 幾乎不會失敗 | 更長——補償交易有延遲 |
| **業務侵入性** | 高——每個服務必須實作 Try/Confirm/Cancel 三個 API | 中——每個服務實作操作 + 補償 |
| **適合場景** | 金融、庫存——「預留」是自然的業務概念 | 通用業務流程 |
| **失敗處理** | Cancel 釋放預留（較簡單） | 補償交易回滾效果（可能複雜） |
| **超時處理** | 必須處理 Try 超時——定時任務掃描過期的 Try 並自動 Cancel | 依賴 Orchestrator 的超時策略 |

**TCC 的核心優勢：** Confirm 階段幾乎不會失敗（因為資源已在 Try 階段預留成功）。相比之下，Saga 的第 N 步失敗後執行補償，可能發現前面的步驟效果已經被其他交易覆蓋。

---

## 6. Outbox 模式 (Outbox Pattern)——可靠事件發布的基石

### 問題：雙寫問題 (Dual Write Problem)

```
OrderService:
  1. INSERT INTO orders (...) VALUES (...);   -- 寫 DB ✓
  2. kafka.publish('OrderCreated', ...);       -- 發事件 ✓ or ✗？

如果步驟 2 失敗 → DB 有訂單，但沒有事件 → 下游服務不知道
如果步驟 1 成功但服務在步驟 2 前崩潰 → 同樣問題
不能用 DB 交易包住 Kafka 寫入——它們是不同的系統
```

### 解法：Outbox 表

```sql
-- 在同一個 DB 交易中寫入業務資料和事件
BEGIN;
  INSERT INTO orders (id, user_id, total, status)
    VALUES ('ord-123', 'user-A', 100.00, 'CREATED');

  INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, created_at)
    VALUES (uuid(), 'Order', 'ord-123', 'OrderCreated',
            '{"orderId":"ord-123","userId":"user-A","total":100.00}',
            NOW());
COMMIT;
-- 兩筆寫入在同一個 ACID 交易中 → 原子性保證
```

```
┌──────────────┐        ┌──────────────┐        ┌──────────┐
│  OrderService │       │  Outbox       │       │  Kafka    │
│              │  TX    │  Relay        │  poll  │          │
│  orders 表   │──────→│  (獨立 Process)│──────→│  Topic   │
│  outbox 表   │       │  讀 outbox 表  │       │          │
└──────────────┘       │  發 Kafka     │       └──────────┘
                        │  標記已發送    │
                        └──────────────┘
```

**Outbox Relay 虛擬碼：**

```python
# 方案 A：輪詢 (Polling)
while True:
    events = db.query(
        "SELECT * FROM outbox WHERE published = FALSE ORDER BY created_at LIMIT 100"
    )
    for event in events:
        kafka.publish(event.event_type, event.payload)
        db.execute("UPDATE outbox SET published = TRUE WHERE id = ?", event.id)
    sleep(100ms)  # 輪詢間隔——延遲 vs DB 負載的 trade-off
```

### CDC (Change Data Capture) 替代方案

```
┌──────────────┐        ┌──────────────┐        ┌──────────┐
│  OrderService │       │  Debezium     │       │  Kafka    │
│              │  WAL   │  (CDC)        │       │          │
│  orders 表   │──────→│  讀取 DB WAL  │──────→│  Topic   │
│  outbox 表   │       │  (binlog/WAL) │       │          │
└──────────────┘       └──────────────┘       └──────────┘
```

**Polling vs CDC 比較：**

| 維度 | Polling | CDC (Debezium) |
|------|---------|----------------|
| **延遲** | 100ms–數秒（取決於輪詢間隔） | 近即時（ms 級，直接讀 WAL） |
| **DB 負擔** | 高頻 SELECT 查詢 | 幾乎為零（讀 replication stream） |
| **維運複雜度** | 低（一個 cron job） | 高（Debezium + Kafka Connect 叢集） |
| **順序保證** | 依靠 `created_at` 排序 | WAL 天然有序 |
| **適合規模** | 中小規模（< 10K events/s） | 大規模（100K+ events/s） |

**Outbox 模式是讓 Saga 可靠運作的地基。** 沒有 Outbox，Saga 的事件發布就不是原子性的，整個補償機制建立在不可靠的基礎上。

---

## 7. 冪等性 (Idempotency)——分散式交易的安全網

在分散式系統中，網路故障導致重試是常態。所有分散式交易模式（2PC 的 Commit 重傳、Saga 的補償重試、TCC 的 Confirm 重試）都依賴冪等性來保證正確性。

### 冪等鍵 (Idempotency Key) 設計

```python
# Client 端：每個請求帶唯一的冪等鍵
POST /payments
Headers:
  Idempotency-Key: "pay-ord123-attempt1"  # 業務語意的 key，非隨機 UUID
Body:
  {"order_id": "ord-123", "amount": 100.00}
```

```sql
-- Server 端：去重表 (Deduplication Table)
CREATE TABLE idempotency_keys (
    idempotency_key  VARCHAR(128) PRIMARY KEY,
    response_code    INT,
    response_body    TEXT,
    created_at       TIMESTAMP NOT NULL,
    INDEX idx_created (created_at)  -- 用於定期清理過期記錄
);
```

```python
# Server 端處理邏輯
def process_payment(request):
    key = request.headers['Idempotency-Key']

    # 1. 檢查是否已處理過
    existing = db.query("SELECT * FROM idempotency_keys WHERE idempotency_key = ?", key)
    if existing:
        return existing.response_code, existing.response_body  # 直接回傳上次結果

    # 2. 在同一個交易中：執行業務邏輯 + 記錄冪等鍵
    BEGIN;
      result = execute_payment(request.body)
      INSERT INTO idempotency_keys (idempotency_key, response_code, response_body, created_at)
        VALUES (key, result.code, result.body, NOW());
    COMMIT;

    return result
```

### 常見冪等設計技巧

| 技巧 | 說明 | 範例 |
|------|------|------|
| **去重表** | 記錄已處理的請求 ID | 如上所示 |
| **條件更新 (Conditional Update)** | 用樂觀鎖版本號 | `UPDATE ... WHERE version = 5` |
| **天然冪等操作** | SET 比 INCREMENT 更安全 | `SET balance = 900` 而非 `balance -= 100` |
| **狀態機守衛 (State Guard)** | 只在預期狀態下執行 | `UPDATE orders SET status = 'PAID' WHERE status = 'PENDING'` |

**冪等鍵的生命週期：** 通常保留 24–72 小時後清理。太短可能無法防重複（客戶端延遲重試）；太長浪費儲存。Stripe 的冪等鍵保留 24 小時。

---

## 8. 綜合比較矩陣

| 維度 | 2PC | Saga (Orchestration) | Saga (Choreography) | TCC |
|------|-----|----------------------|---------------------|-----|
| **一致性模型** | 強一致性 (Strong Consistency) | 最終一致性 (Eventual Consistency) | 最終一致性 | 最終一致性（但窗口更短） |
| **可用性** | 低——任一參與者不可用 → 整體阻塞 | 高——各服務獨立運作 | 高——完全解耦 | 中——Try 超時需處理 |
| **延遲 (p99)** | ~11ms（intra-DC, 3 節點）；隨參與者數線性增長 | 各步驟延遲累加，但非阻塞 | 同 Orchestration，加上事件傳播延遲 | 2 輪（Try + Confirm），比 Saga 快 |
| **鎖定策略** | DB 層行鎖——阻塞其他交易 | 無鎖——用補償回滾 | 無鎖——用補償回滾 | 業務層軟鎖（預留欄位） |
| **吞吐量** | 低——鎖競爭是瓶頸 | 高——無全局鎖 | 高——無全局鎖 | 中高——預留減少衝突 |
| **實作複雜度** | 低（DB 原生支援 XA） | 中（需寫 Orchestrator + 狀態機） | 高（需設計事件流 + 分散式追蹤） | 高（每個服務 3 個 API + 超時處理） |
| **業務侵入性** | 低（透明的 DB 層協議） | 中（需定義補償邏輯） | 中（需定義事件 + 補償） | 高（需重新設計資料模型支援 Try/Confirm/Cancel） |
| **可擴展性** | 差——參與者越多延遲和阻塞風險越高 | 好——步驟間非同步 | 最好——完全事件驅動 | 好——但每個服務需支援 TCC |
| **跨服務支援** | 僅限支援 XA 的同質資料庫 | 任意服務——只需 HTTP/gRPC | 任意服務——只需 Message Broker | 任意服務——但 API 改動大 |
| **典型使用場景** | 單一叢集內跨分片交易 | 電商訂單流程、跨微服務業務流程 | 簡單的事件驅動工作流 | 金融轉帳、庫存預留 |

---

## 9. 架構師的決策樹

```
起點：「我需要跨多個服務/資料庫保證資料一致性」
│
├── Q1: 所有參與者是同一種資料庫且在同一叢集中嗎？
│   ├── 是 → 考慮 2PC (XA Transaction)
│   │         適合：跨分片事務、短命交易 (<50ms)
│   │         前提：能接受鎖阻塞、不需跨資料中心
│   └── 否 → 繼續
│
├── Q2: 能接受最終一致性嗎？（幾秒到幾分鐘的不一致窗口）
│   ├── 否 → 重新審視架構
│   │         可能不應該拆成微服務（合併服務）
│   │         或使用同一個 DB + 本地交易
│   └── 是 → 繼續
│
├── Q3: 業務操作是否天然有「預留」語意？
│   │   （如：凍結金額、預留庫存、鎖定座位）
│   ├── 是 → TCC 模式
│   │         Confirm 幾乎不會失敗 → 一致性窗口更短
│   │         適合：金融系統、資源預留型業務
│   └── 否 → Saga 模式，繼續
│
├── Q4: 流程步驟超過 4 個，或需要複雜的條件分支？
│   ├── 是 → Orchestration Saga
│   │         集中狀態機、易於監控和除錯
│   │         搭配 Outbox Pattern 確保事件可靠發布
│   └── 否 → 繼續
│
├── Q5: 不同團隊各自擁有服務，且流程簡單（3-4 步）？
│   ├── 是 → Choreography Saga
│   │         事件驅動、鬆耦合
│   │         必須投資分散式追蹤 (Distributed Tracing) 基礎設施
│   └── 否 → 預設選 Orchestration Saga（最平衡的選擇）
│
└── 不管選哪個，都必須搭配：
    ├── Outbox Pattern（原子性事件發布）
    ├── 冪等性設計（處理重試安全）
    └── 分散式追蹤（Correlation ID 貫穿全流程）
```

### 速查表：場景直覺

| 場景 | 選擇 | 原因 |
|------|------|------|
| 跨分片的資料庫事務 | **2PC (XA)** | 同質 DB、短命交易、強一致性 |
| 電商訂單（下單→扣庫存→付款→出貨） | **Orchestration Saga** | 多步驟、需要清晰的狀態追蹤 |
| 簡單的事件通知鏈 | **Choreography Saga** | 步驟少、團隊分散、鬆耦合 |
| 銀行轉帳（凍結→扣款→入帳） | **TCC** | 「凍結」是天然的 Try 語意 |
| 機票預訂（選位→付款→出票） | **TCC** | 座位預留是天然的 Try 語意 |
| 跨微服務資料同步 | **Outbox + CDC** | 不需要交易語意，只需可靠事件傳播 |
| 單體應用內多表操作 | **本地 DB 交易** | 別過度工程——能用 ACID 就用 ACID |

---

## 10. 常見踩坑

### 1.「我們用 2PC 跨三個微服務。」
致命錯誤。2PC 要求所有參與者支援 XA 協議且在同一個交易管理器下。跨微服務的 2PC 意味著：任一服務 deploy、重啟、網路波動都可能導致全局阻塞。跨微服務請用 Saga。

### 2.「補償交易就是 Undo 嘛，很簡單。」
不是。補償是正向操作。`charge($100)` 的補償不是「撤銷扣款」，而是「執行退款 $100」。有些操作（發簡訊、實體出貨）**根本不可補償**——必須在 Saga 設計階段就把不可補償步驟排在最後。

### 3.「我們的 Saga 不需要冪等，因為我們用的是 Exactly-once Message Queue。」
不存在端到端的 Exactly-once。即使 Kafka 內部保證 Exactly-once，你的服務處理完訊息但在 ACK 前崩潰 → Kafka 重新投遞 → 服務看到重複訊息。**所有 Saga 步驟和補償操作都必須是冪等的。**

### 4.「Choreography Saga 更好，因為沒有單點故障。」
理論上正確，實務上 Choreography 的除錯和監控成本遠超維護一個高可用 Orchestrator 的成本。Netflix、Uber、Airbnb 都從 Choreography 遷移到了 Orchestration（分別開發了 Conductor、Cadence/Temporal、Orchestrator）。生產環境的可觀察性比架構純粹性重要。

### 5.「我們直接 DB 寫完就發 Kafka 事件。」
雙寫問題 (Dual Write Problem)。DB 寫成功但 Kafka 發失敗 → 資料不一致。必須用 Outbox Pattern 或 CDC，保證 DB 寫入和事件發布的原子性。這不是可選的最佳實踐，而是正確性的基本要求。

### 6.「TCC 的 Try 超時了怎麼辦？我們不管它。」
Try 預留的資源如果不清理，會永久凍結。必須有定時任務 (Scheduled Job) 掃描過期的 Try 記錄並自動 Cancel。建議 Try 超時設為 30 秒–5 分鐘，取決於業務流程長度。

### 7.「我們的 Saga 沒有 Correlation ID。」
沒有 Correlation ID，你就無法追蹤一筆訂單在 5 個服務中的流轉。出了問題時只能逐個服務查日誌。在 Saga 設計的第一天就決定 Correlation ID 的格式和傳播機制——不要事後補。

### 8.「最終一致性對使用者來說太慢了。」
不一定。最終一致性的「最終」通常是 100ms–2s，使用者幾乎感知不到。技巧：立即回傳「訂單處理中」的 UI 狀態，背景非同步完成 Saga，透過 WebSocket/SSE 推送最終結果。Amazon 的下單頁面就是這麼做的——你看到的「訂單確認」其實是樂觀回覆，真正的庫存確認和扣款在背景進行。
