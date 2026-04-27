# Google Docs — 即時協作編輯系統架構

## 1. 核心挑戰

Google Docs 的設計核心是 **多人同時編輯同一份文件時，如何讓所有人看到一致的最終結果**：

```
規模：
  DAU: ~300M（Google Workspace 整體）
  同時在線文件數: ~50M
  每份文件的同時編輯者: 通常 2-10 人，極端 ~50 人
  按鍵操作頻率: 每人 ~5-10 ops/sec（打字速度）
  每份文件 ops/sec: 50 人 × 10 ops = ~500 ops/sec（極端情況）
  全局 ops/sec: 50M docs × avg 2 editors × 5 ops = ~500M ops/sec

核心矛盾：
  - 使用者打字時 latency 必須 < 50ms（否則感覺卡頓）
  - 但網路 RTT > 50ms → 不能每次按鍵都等 server 確認
  - 所以必須 optimistic local apply + 背景同步
  - 多人同時打字 → 操作順序不同 → 最終文件可能不一致
  - 核心問題：如何在不等待的情況下，保證所有人最終看到相同結果？
```

---

## 2. 整體架構

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Client (Browser)                           │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Editor   │  │ Local Op     │  │ OT / CRDT   │  │ Cursor &    │  │
│  │ Engine   │  │ Buffer       │  │ Transform   │  │ Presence    │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  │
│       │               │                 │                 │         │
└───────┼───────────────┼─────────────────┼─────────────────┼─────────┘
        │               │                 │                 │
        │          WebSocket 雙向連線                        │
        │               │                 │                 │
┌───────┼───────────────┼─────────────────┼─────────────────┼─────────┐
│       ▼               ▼                 ▼                 ▼         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              WebSocket Gateway (Connection Layer)            │    │
│  │         per-document pub/sub channel，每個 doc 一個 room     │    │
│  └──────────────────────┬──────────────────────────────────────┘    │
│                         │                                           │
│  ┌──────────────────────▼──────────────────────────────────────┐    │
│  │                Collaboration Service                         │    │
│  │  • 接收 client ops                                           │    │
│  │  • 序列化操作順序（assign sequence number）                    │    │
│  │  • OT Transform / CRDT Merge                                 │    │
│  │  • 廣播 transformed ops 給同一 doc 的其他 clients             │    │
│  └────┬────────────────┬────────────────────┬──────────────────┘    │
│       │                │                    │                       │
│       ▼                ▼                    ▼                       │
│  ┌─────────┐   ┌──────────────┐    ┌───────────────┐               │
│  │ Op Log  │   │ Doc Snapshot │    │ Presence      │               │
│  │ (Append │   │ Store        │    │ Service       │               │
│  │  only)  │   │ (Periodic)   │    │ (Redis)       │               │
│  └─────────┘   └──────────────┘    └───────────────┘               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Permission Service (ACL Check)                   │   │
│  │              Owner / Editor / Commenter / Viewer              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心設計決策：OT vs CRDT

這是協作編輯面試的 **第一個必答問題**。

### Operational Transform (OT)

OT 的核心概念：當兩個操作 (Operation) 併發產生時，透過一個 **transform function** 調整後面的操作，使它在前一個操作之後仍然語義正確。

```
操作類型：
  insert(pos, char)  — 在位置 pos 插入字元 char
  delete(pos)        — 刪除位置 pos 的字元

Transform 函數範例：

  初始文件："ABCD"

  User A: insert(3, 'X')  → "ABCXD"   （在 C 後面插入 X）
  User B: delete(1)       → "ACD"      （刪除 B）

  兩個操作併發，Server 先收到 A 的操作：
    1. 套用 A: "ABCD" → "ABCXD"
    2. 需要 transform B 的操作，使其在 A 之後仍正確：
       B 原本: delete(1)  → 刪除位置 1（原本是 B）
       A 插入在位置 3 > B 刪除位置 1 → B 的位置不受影響
       transformed B: delete(1)  → "ACXD"  ✓

  另一個情境：
    User A: insert(1, 'X')  → "AXBCD"  （在 A 後面插入 X）
    User B: delete(2)       → "ABD"     （刪除 C）

    Server 先套用 A:  "ABCD" → "AXBCD"
    Transform B: 原本 delete(2)，但 A 在位置 1 插入了 → 位置 2 之後都右移
    transformed B: delete(3)  → "AXBD"  ✓
```

### Transform 函數規則

```
transform(op1, op2) → (op1', op2')
  使得 apply(apply(doc, op1), op2') == apply(apply(doc, op2), op1')

具體規則（insert vs insert）：
  op1 = insert(p1, c1), op2 = insert(p2, c2)
  if p1 < p2:   op2' = insert(p2 + 1, c2)    // op1 在前面插入，op2 位置後移
  if p1 > p2:   op1' = insert(p1 + 1, c1)
  if p1 == p2:  用 user_id 做 tie-breaking

具體規則（insert vs delete）：
  op1 = insert(p1, c1), op2 = delete(p2)
  if p1 <= p2:  op2' = delete(p2 + 1)         // 插入在刪除位置前，刪除位置後移
  if p1 > p2:   op1' = insert(p1 - 1, c1)     // 刪除在插入位置前，插入位置前移

複雜度：
  N 個併發操作 → 需要 O(N²) 次 transform pair
  但實務上每份文件同時編輯者 < 50 人 → N 很小，完全可以承受
```

### Server-based OT（Google Docs 的做法）

```
Google Docs 採用 Server-authoritative OT：

  1. Client 打字 → 產生 op → optimistic apply 到本地（使用者立刻看到效果）
  2. 同時把 op 發送到 Server
  3. Server 收到後：
     a. 賦予全局 sequence number（序列化）
     b. 檢查是否有併發 ops → 如果有，transform
     c. 套用 transformed op 到 server 端文件
     d. 廣播 transformed op 給所有其他 clients
  4. 其他 Client 收到 → transform against 自己的 pending local ops → apply

  Server 是唯一的 "truth"：
    → 所有 ops 經過 server 序列化
    → 保證最終一致性 (Convergence)
    → 不需要複雜的分散式共識

  Client 端 state machine：
    三個狀態：
    - Synchronized: 本地無 pending ops，與 server 一致
    - AwaitingConfirm: 已送出一個 op，等待 server 確認
    - AwaitingWithBuffer: 等待確認中又產生新 op，暫存在 buffer

    → 一次只能有一個 in-flight op（簡化 transform 邏輯）
    → Server 確認後才送下一個
```

### CRDT (Conflict-free Replicated Data Types，無衝突複製資料型別)

```
CRDT 的核心概念：每個字元擁有一個全局唯一的 Position ID，
merge 操作是自動的，不需要 transform function。

字元結構：
  {
    id: (user_id, lamport_timestamp),   // 全局唯一 ID
    char: 'A',
    position: <fractional_index>,        // 決定在文件中的位置
    is_deleted: false                    // tombstone（標記刪除，不真的移除）
  }

Position 編碼方式：

  1. Fractional Indexing（分數索引）：
     文件: [A, B, C]
     位置: [0.25, 0.5, 0.75]
     在 A 和 B 之間插入 X → 位置 = (0.25 + 0.5) / 2 = 0.375
     問題：精度有限，深度插入會導致 fraction 越來越長

  2. Tree-based（Yjs 的 YATA 演算法）：
     每個字元記錄 (left_origin, right_origin)
     形成一棵 tree → 插入位置由 tree 結構決定
     不需要數值位置，避免精度問題

  3. RGA (Replicated Growable Array)：
     每個字元有 (timestamp, author) 組成的唯一 ID
     用 linked list + lookup table 實作
     Automerge 基於此演算法
```

### 為什麼 CRDT 不需要 transform？

```
OT：位置用 integer index → 併發操作會改變 index → 需要 transform 修正
CRDT：位置用 unique ID → 不管操作順序如何，每個字元的 ID 永遠不變

範例：
  初始: [(id1, 'A'), (id2, 'B'), (id3, 'C')]

  User A 在 A 和 B 之間插入 X → (idA, 'X', between id1 and id2)
  User B 在 A 和 B 之間插入 Y → (idB, 'Y', between id1 and id2)

  兩個操作都合法，merge 時用 ID 做 tie-breaking：
    if idA < idB → 結果: A X Y B C
    if idA > idB → 結果: A Y X B C

  不管先收到誰的操作，最終結果一致 → convergence guaranteed
```

---

## 4. OT vs CRDT 比較

| 維度 | OT | CRDT |
|------|-----|------|
| Consistency Model | 最終一致（server-authoritative 序列化保證收斂） | 最終一致（Eventual Consistency） |
| 需要中央 Server？ | **是**（server 做 transform + 序列化） | **否**（P2P 可行） |
| Latency | 本地立即 apply（optimistic），確認需 server round trip | 本地立即 apply，確認靠背景 P2P merge |
| Metadata Overhead | 低（ops 只有 type + position） | **高**（每個字元需要 unique ID + tombstone） |
| 離線編輯 | 困難（需要 server 在線做 transform） | **原生支持**（離線編輯，上線自動 merge） |
| 實作複雜度 | Transform 函數正確性難證明（O(N²) pairs） | 資料結構複雜但 merge 邏輯簡單 |
| 記憶體 / 儲存 | 低 | 高（tombstone 不能真刪，metadata per char） |
| P2P 支持 | 不適合（需中央序列化） | **天然適合** |
| 代表產品 | **Google Docs**、Google Wave | **Figma**、Yjs、Automerge |
| Notion | — | Hybrid（CRDT-inspired + server） |

### 選型 Decision Tree

```
需要 P2P 或離線優先？
  ├── 是 → CRDT（Yjs / Automerge）
  └── 否 → 有中央 server？
        ├── 是 → OT（較成熟、metadata overhead 低）
        └── 否 → CRDT

文件大小？
  ├── 大文件（>100 頁）→ OT（metadata overhead 低）
  └── 小文件 / 設計檔 → CRDT 皆可

團隊經驗？
  ├── 自建 → OT 的 transform 正確性非常難做對
  └── 用 library → Yjs（CRDT）生態系最成熟
```

---

## 5. Document Storage

### 操作日誌 + 快照 雙層儲存

```
Storage 設計：

  1. Operation Log（Append-only，追加寫入日誌）：
     每一筆使用者操作都 append 到 log
     → 完整的操作歷史，可以 replay 任意時間點的文件狀態

     op_log:
       doc_id     | seq_no | user_id | op_type | position | char | timestamp
       doc_123    | 1      | userA   | insert  | 0        | H    | 2024-01-01T00:00:01
       doc_123    | 2      | userA   | insert  | 1        | i    | 2024-01-01T00:00:01
       doc_123    | 3      | userB   | delete  | 0        |      | 2024-01-01T00:00:02
       ...

  2. Document Snapshot（週期性快照）：
     每 N 個操作（例如 100 ops）存一次完整文件快照
     → 載入文件時不需要從第一個 op replay

     snapshots:
       doc_id   | version | content          | created_at
       doc_123  | 100     | "完整文件內容..."  | 2024-01-01T01:00:00
       doc_123  | 200     | "完整文件內容..."  | 2024-01-01T02:00:00

  載入文件流程：
    1. 讀取最近的 snapshot（version 200）
    2. Replay version 201 之後的 ops
    3. 得到最新文件狀態
    → 最多 replay 100 個 ops，而非全部歷史
```

### Version History（版本歷史）

```
Google Docs 的「查看版本紀錄」功能：
  → 從 snapshot + op log 重建任意歷史版本
  → 標記「命名版本」（使用者手動存的節點）

Compaction（壓縮）：
  文件可能有數百萬個 ops（長期編輯的文件）
  → 定期 compact：把舊的 ops 合併成 snapshot
  → 只保留最近 N 天的完整 op log
  → 更舊的只保留 snapshot 節點

儲存量估算：
  一個活躍文件，每天 ~10K ops × 平均 50 bytes/op = 500KB/day
  一年 = ~180MB op log
  Compact 後：每天一個 snapshot（~50KB）+ 最近 7 天的 ops = ~3.5MB + 350KB
  → 壓縮比 ~50x
```

---

## 6. WebSocket 架構（大規模連線管理）

### Connection Gateway

```
                    ┌─────────────────────────┐
                    │    Load Balancer (L7)    │
                    │  sticky session by       │
                    │  doc_id (consistent hash)│
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
      ┌──────────────┐ ┌──────────────┐  ┌──────────────┐
      │ WS Gateway 1 │ │ WS Gateway 2 │  │ WS Gateway 3 │
      │ doc_1..1000  │ │ doc_1001..2K │  │ doc_2001..3K │
      └──────┬───────┘ └──────┬───────┘  └──────┬───────┘
             │                │                  │
             └────────────────┼──────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  Redis Pub/Sub     │
                    │  Channel per doc   │
                    └────────────────────┘

設計要點：
  1. 同一 doc 的 editors 盡量分配到同一 Gateway（sticky session）
     → 減少跨 Gateway 的 pub/sub 通訊
     → 但不是強制：跨 Gateway 用 Redis Pub/Sub 廣播

  2. 每份 doc 的同時編輯者通常 < 50 人
     → Fan-out 很小（跟 chat room 不同，不需要發給百萬人）
     → 一個 Gateway 可以承載 ~100K WebSocket 連線

  3. 連線數估算：
     50M 活躍文件 × 平均 2 editors = 100M WebSocket 連線
     每個 Gateway ~100K 連線 → ~1000 Gateway instances

  4. Gateway 是 stateless（除了 WebSocket 連線本身）
     → 可以隨時 scale out
     → 連線斷掉後 client 自動 reconnect
```

### Per-document Pub/Sub Channel

```
為什麼用 per-document channel 而非 global broadcast？

  方案一：Global broadcast（所有 ops 發到一個 channel）
    → 每個 client 收到所有文件的 ops → filter 自己的
    → 500M ops/sec 全推給每個 client → 完全不可行

  方案二：Per-document channel ✓
    → 只 subscribe 自己正在編輯的 doc
    → 一份 doc 500 ops/sec × 50 subscribers = 25K messages/sec
    → 單個 channel 完全可以承受

  Redis Pub/Sub 的 channel 數量：
    50M 活躍文件 = 50M channels → Redis cluster 分散
    每個 channel 很小（< 50 subscribers）→ 記憶體開銷極低
```

---

## 7. Cursor & Selection 同步

### 游標即時追蹤

```
需求：
  每個使用者都能看到其他人的游標位置和選取範圍
  → 每個人用不同顏色標示（色碼由 server 分配）

游標同步流程：
  1. User A 移動游標 → 發送 cursor_update(doc_id, user_id, position, selection_range)
  2. Server 透過 WebSocket 廣播給同一 doc 的其他 clients
  3. 其他 clients 在 UI 上顯示 A 的游標（帶名字標籤 + 顏色）

關鍵問題：游標位置如何在併發編輯下保持正確？
  User A 的游標在位置 5
  User B 在位置 2 插入一個字元
  → A 的游標應該自動變成位置 6（因為前面多了一個字元）

  OT 解法：transform 游標座標
    游標 = integer index → 收到 remote op 時跑 transform_cursor(pos, op)
    跟 transform 文件 op 是同一套邏輯，O(N²) pair

  CRDT 解法：根本沒有 transform 這回事
    游標 = anchor 在某個 char 的 globally unique ID 之後
    Doc: [1@A:"A", 2@A:"B", 3@A:"C", 4@A:"D", 5@A:"E"]
    A 的 cursor = "在 5@A 之後"  ← 存的是 ID，不是 index
    B 插入後: [1@A, 2@A, 1@B:"X", 3@A, 4@A, 5@A]
    A 的 anchor 5@A 還在，render 時 lookup 它的 visual index = 6 ✓
    → Yjs 的 RelativePosition / Automerge 的 cursor API 就是這個

  Edge case (CRDT)：
    別人刪了我 anchor 的字元 → anchor 變 tombstone → fallback 到下一個活字元
    Range selection → start 和 end 兩個 anchor 獨立，遠離中間插入會自動擴張

頻率控制：
  打字時游標每秒移動 5-10 次
  → 不需要每次都同步，可以 throttle 到 ~100ms 一次
  → 或用 debounce：停止移動後 50ms 才發送
  → 減少 ~80% 的游標更新訊息
```

### OT vs CRDT cursor 對照

| 維度 | OT | CRDT |
|------|----|----|
| Cursor 內部表示 | `int index` | `RelativePosition`（指向某個 char ID） |
| 收到 remote op 時 | 手寫 `transform_cursor(pos, op)` | **不需要做事**（render 時 lookup ID） |
| Range selection 處理 | 兩個端點各做 transform | 兩個 anchor 獨立，range 自動擴縮 |
| 邏輯成本 | O(N²) pair transform | O(1) anchor lookup |
| Anchor 被刪時 | 自然處理 | 需要 tombstone + neighbor fallback |
| 離線重連 | 大量 transform catch-up | anchor 還在，無事 |

**核心 insight**：OT 把位置當「絕對座標 (index)」，所以前面的編輯一改，座標就要修；CRDT 把位置當「相對 anchor (char ID)」，anchor 不會被別人動到，所以座標自動對。這不是「CRDT 比較聰明」——是兩套**位置語意**從根本不同。

---

## 8. Presence Service（在線狀態）

```
功能：顯示「誰正在查看 / 編輯這份文件」

實作：
  ┌──────────┐        ┌──────────────────┐        ┌────────────┐
  │ Client   │──WS──▶│ WebSocket Gateway │──────▶│ Redis      │
  │          │        │ heartbeat 30s     │        │ Presence   │
  └──────────┘        └──────────────────┘        └────────────┘

  加入文件：
    Client 連線到 doc → Gateway 發送 JOIN event
    → Redis SADD presence:{doc_id} {user_id}
    → Redis EXPIRE presence:{doc_id} 60s（TTL 自動清理）
    → 廣播給同一 doc 的其他 clients：「User A joined」

  心跳：
    Client 每 30 秒發 heartbeat
    → Gateway 延長 Redis key TTL
    → 如果 60 秒沒收到 heartbeat → key 過期 → 視為離開

  離開文件：
    Client 關閉 tab / 斷線 → Gateway 發送 LEAVE event
    → Redis SREM presence:{doc_id} {user_id}
    → 廣播：「User A left」

  查詢誰在線：
    SMEMBERS presence:{doc_id} → [userA, userB, userC]
    → 返回使用者資訊（名字、頭像、顏色碼）
```

---

## 9. Permission Model（權限模型）

```
四層權限（Google Docs 實際模型）：

  Owner:      讀 + 寫 + 分享 + 刪除 + 轉移 ownership
  Editor:     讀 + 寫 + 留言
  Commenter:  讀 + 留言（不能修改文件內容）
  Viewer:     只能讀

每次操作都必須檢查權限：
  Client 送出 op → Server 先查 Permission Service
    → user_id + doc_id → 查 ACL（Access Control List）
    → 如果是 Viewer 送出 insert op → reject

ACL Storage：
  doc_permissions:
    doc_id   | user_id  | role     | granted_by | created_at
    doc_123  | userA    | owner    | system     | 2024-01-01
    doc_123  | userB    | editor   | userA      | 2024-01-02
    doc_123  | userC    | viewer   | userA      | 2024-01-03

  Link sharing：
    doc_sharing:
      doc_id   | link_type      | role
      doc_123  | anyone_with_link| viewer
      doc_456  | organization   | editor

  Cache：
    ACL check 在每個 op 都要做（500M ops/sec）
    → Redis cache: perm:{doc_id}:{user_id} → role（TTL 5 min）
    → Cache miss → 查 DB → 寫 cache
    → 權限變更時 invalidate cache
```

---

## 10. 離線編輯（Offline Editing）

```
情境：使用者在飛機上 / 無網路環境繼續打字

OT 的離線策略：
  1. Client 把操作存到本地 queue（IndexedDB）
  2. 離線期間：所有 ops 都 apply 到本地副本
  3. 重新上線時：
     a. 從 server 拉取離線期間其他人的 ops
     b. Transform 本地 pending ops against server ops
     c. 送出 transformed ops 到 server
     d. Server 再做一次 transform + 廣播
  → 問題：離線時間長 → pending ops 很多 → transform 計算量大
  → Google Docs 的離線支持有限（需要安裝 Chrome extension）

CRDT 的離線策略：
  1. 同樣存到本地 queue
  2. 重新上線時：直接送出所有 ops
  3. CRDT merge 自動處理衝突（因為每個字元有 unique ID）
  4. 不需要 transform → 離線任意長時間都沒問題
  → 這是 CRDT 最大的優勢
  → Figma、Notion 的離線編輯因此更自然

比較：
  | 維度                  | OT                    | CRDT                 |
  |-----------------------|-----------------------|----------------------|
  | 離線支持              | 有限，需額外處理         | 原生支持              |
  | 重連 Merge 複雜度     | O(local × remote ops) | O(local + remote ops) |
  | 重連後衝突機率         | 高（需要大量 transform） | 低（自動 merge）      |
  | 離線時的資料量         | 只存 ops（小）          | ops + metadata（較大）|
```

---

## 11. Comments & Suggestions（留言與建議模式）

```
留言功能：
  使用者在文件中選取一段文字 → 新增留言

  Comment 資料結構：
    {
      comment_id: "c_123",
      doc_id: "doc_456",
      author_id: "userA",
      text: "這段需要修改",
      anchor: {
        start: { type: "position_marker", id: "pm_001" },
        end:   { type: "position_marker", id: "pm_002" }
      },
      status: "open",    // open | resolved
      created_at: "2024-01-01T10:00:00Z"
    }

  Position Marker（位置標記）的追蹤：
    留言錨定在文件中的某個位置 → 但文件會持續被編輯
    → 如果用 integer index → 其他人插入/刪除後 index 會錯位
    → 解法：插入不可見的 marker 字元到文件中
      → marker 跟一般字元一樣參與 OT transform / CRDT merge
      → 位置永遠正確

Suggestion Mode（建議模式）：
  Editor 切換到「建議」模式
  → 所有編輯變成 suggested change（tracked change）
  → 不直接修改文件，而是記錄：
    {
      suggestion_id: "s_789",
      type: "replace",
      original: "舊文字",
      replacement: "新文字",
      anchor: { start: pm_003, end: pm_004 },
      status: "pending"    // pending | accepted | rejected
    }
  → 文件 owner 可以 accept（真正套用修改）或 reject（丟棄）
  → 跟 Git 的 diff/patch 概念類似
```

---

## 12. 容量估算

| 指標 | 估算 |
|------|------|
| 總文件數 | ~5B（Google Workspace 累計） |
| 活躍文件數 / 日 | ~50M |
| 平均每份活躍文件的同時編輯者 | 2-3 人 |
| 全局 WebSocket 連線數 | 50M × 2.5 = **~125M 連線** |
| 每人 ops/sec（打字中） | 5-10 ops/sec |
| 全局 ops/sec | 50M × 2.5 × 5 = **~625M ops/sec**（峰值） |
| 單份文件 ops/sec（50 人同時打字） | 50 × 10 = **500 ops/sec** |
| Op 大小 | ~50 bytes（type + position + char + metadata） |
| Op Log 寫入量 | 625M × 50B = **~31GB/sec** |
| Snapshot 大小（平均文件） | ~50KB |
| Snapshot 儲存（5B 文件） | 5B × 50KB = **~250PB**（需壓縮 + 分層儲存） |
| WebSocket Gateway 數量 | 125M / 100K = **~1,250 instances** |
| Redis Pub/Sub channels | **~50M**（每份活躍文件一個） |

```
Op Log 儲存策略：
  31GB/sec = ~2.7PB/day（raw）
  → 不可能全部持久化

  解法：
  1. Hot ops（最近 24 小時）→ 存在記憶體 / SSD（快速 replay）
  2. 每 100 ops 存一次 snapshot → 只需保留最近的 ops
  3. 30 天後 compact：只保留每日 snapshot + named versions
  4. 壓縮後實際寫入量降到 ~50GB/day（可承受）
```

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 衝突解決演算法 | **OT（Google Docs）** | Server-authoritative，強一致，metadata overhead 低；<50 concurrent editors 時 transform 成本低 |
| Client 策略 | **Optimistic Local Apply** | 打字必須 < 50ms 回饋，不能等 server RTT（50-150ms） |
| 即時通訊協議 | **WebSocket** | 雙向、低 latency；HTTP polling 的 overhead 太高（每秒 5-10 次操作） |
| 文件儲存 | **Op Log + Periodic Snapshot** | Op Log 保留完整歷史可 replay；Snapshot 避免載入時從頭 replay |
| Snapshot 頻率 | **每 100 ops** | 平衡載入速度（最多 replay 100 ops）和儲存空間 |
| 游標同步 | **Throttled broadcast（100ms）** | 減少 80% 訊息量，人眼分辨不出 100ms 差異 |
| 權限檢查 | **每次 op 都檢查 + Redis cache** | 安全性要求：每個操作都必須驗證；cache 避免 DB 成為瓶頸 |
| 離線支持（OT） | **有限支持 + reconnect transform** | OT 天生不適合長時間離線；如果離線是核心需求，選 CRDT |
| 大規模連線 | **Sticky Session + Redis Pub/Sub** | 同一 doc 的 editors 盡量在同一 Gateway 減少跨節點通訊 |

---

## 14. 面試常見 Follow-up

### Q: 如果兩個人同時在完全相同的位置打字怎麼辦？

```
OT 的處理：
  User A: insert(5, 'X')
  User B: insert(5, 'Y')

  Server 先收到 A → 套用 → 文件有 X 在位置 5
  Transform B: 因為 A 已在位置 5 插入 → B 的位置變成 6
  → 最終: ...XY...

  tie-breaking 規則用 user_id 決定誰的字在前面
  → 確保所有 client 最終順序一致

CRDT 的處理：
  每個字元有 unique ID → 用 ID 做排序
  → 不需要特殊處理，merge 自動決定順序
```

### Q: 文件很大（1000 頁）怎麼優化？

```
1. 分塊載入（Chunked Loading）：
   文件分成多個 block（每 block ~1 頁）
   → 先載入可視區域的 blocks
   → 滾動時 lazy load 其他 blocks

2. 分塊 OT：
   ops 標記所屬 block
   → 只 transform / broadcast 同一 block 的 ops
   → 不同 block 的操作互不影響（平行處理）

3. 壓縮傳輸：
   ops batch 壓縮（gzip），每 50ms 發送一次 batch
   → 減少 WebSocket frame 數量
```

### Q: 如何處理 rich text（粗體、斜體、字體大小）？

```
操作不只有 insert/delete，還有 format：
  format(start, end, attribute, value)
  例：format(3, 7, 'bold', true) → 位置 3-7 設為粗體

Transform 也需要處理 format 操作：
  insert 在 format range 內 → range 擴大
  delete 在 format range 內 → range 縮小

Google Docs 的做法：
  文件 = 純文字 + annotation layer
  annotation: [(start, end, {bold: true, font-size: 14}), ...]
  → OT 同時 transform text ops 和 annotation ops
```

### Q: 如何防止惡意使用者快速發送大量 ops？

```
Rate Limiting：
  per-user per-document：max 100 ops/sec（正常打字 ~10 ops/sec）
  超過 → 暫時 buffer，不立即 reject（避免打字中斷）
  持續超過 → 斷開 WebSocket + 提示「操作過於頻繁」

Op Validation：
  Server 端驗證每個 op 的合法性：
  - position 是否在文件範圍內？
  - insert 的 char 是否合法？
  - 是否有 editor 權限？
  → reject 不合法的 ops，不廣播
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU、同時編輯者數量、ops/sec、latency 要求（< 50ms 回饋）
2. **核心問題定義**（1 分鐘）— Optimistic local apply + 背景同步 → 併發衝突怎麼解？
3. **OT vs CRDT（核心）**（4 分鐘）— 先解釋 OT 的 transform function（用具體範例），再對比 CRDT 的 unique ID 做法，最後給出 trade-off 表格和 decision tree
4. **Server-based OT 架構**（2 分鐘）— Client state machine（Synchronized / AwaitingConfirm / AwaitingWithBuffer）、Server 序列化 + transform + 廣播
5. **Document Storage**（1 分鐘）— Op Log + Periodic Snapshot、compaction 策略
6. **WebSocket 架構**（1 分鐘）— Gateway sticky session、per-doc pub/sub channel、連線數估算
7. **Deep Dive（面試官選）**（2 分鐘）— Cursor sync、Presence、Permission、Offline editing、Comments
