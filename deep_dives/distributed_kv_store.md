# Distributed Key-Value Store (Dynamo-style) — 分散式鍵值儲存系統架構

## 1. 核心挑戰

Dynamo-style KV Store 的設計核心是在 **無中心節點 (Leaderless)** 的架構下，同時達成高可用性、可擴展性與可調一致性：

```
規模（以 Amazon DynamoDB / Cassandra 等級為參考）：
  節點數: 數百～數千台
  資料量: PB 級
  QPS: 數百萬 reads/sec + 數十萬 writes/sec
  Latency 要求: p99 < 10ms（SLA 驅動，Amazon 內部要求 99.9th < 300ms）
  可用性: 99.995%（每年停機 < 26 分鐘）

資料模型：
  GET(key) → value
  PUT(key, value) → ack
  DELETE(key) → ack
  → 不支援 range query（Consistent Hashing 不保留 key 順序）
  → value 是 opaque blob（系統不解析內容）

核心矛盾（CAP Theorem 的實踐）：
  - 網路分區 (Partition) 必然發生 → 必須在 C 和 A 之間選擇
  - Dynamo 選擇 AP：永遠接受寫入 → 衝突事後解決
  - 但提供可調一致性 (Tunable Consistency)：透過 W, R, N 參數讓使用者選擇
```

---

## 2. 整體架構

```
         Client (SDK with partition-aware routing)
           │
           │  hash(key) → 決定 coordinator
           ▼
  ┌────────────────────────────────────────────────────┐
  │                  Hash Ring (虛擬節點)                 │
  │                                                    │
  │   Node A          Node B          Node C           │
  │  (vnode 0,3,7)  (vnode 1,4,8)  (vnode 2,5,9)      │
  │     │               │               │              │
  │     ▼               ▼               ▼              │
  │  ┌───────┐     ┌───────┐      ┌───────┐           │
  │  │Memtable│     │Memtable│      │Memtable│          │
  │  │(memory)│     │(memory)│      │(memory)│          │
  │  └───┬───┘     └───┬───┘      └───┬───┘           │
  │      ▼              ▼              ▼               │
  │  ┌───────┐     ┌───────┐      ┌───────┐           │
  │  │SSTable │     │SSTable │      │SSTable │          │
  │  │ (disk) │     │ (disk) │      │ (disk) │          │
  │  └───────┘     └───────┘      └───────┘           │
  │                                                    │
  │  ◄── Gossip Protocol: 節點狀態 + membership ──►     │
  │  ◄── Anti-entropy: Merkle Tree 背景同步 ──►         │
  │  ◄── Hinted Handoff: 暫存 + 故障恢復 ──►            │
  └────────────────────────────────────────────────────┘

寫入路徑：
  Client → Coordinator → W 個 replica 回 ack → 回 Client

讀取路徑：
  Client → Coordinator → R 個 replica 回資料 → 取最新版本 → 回 Client
                                              → 順便 Read Repair
```

---

## 3. 資料分區：Consistent Hashing 與虛擬節點 (Virtual Nodes)

### 為什麼不用簡單 Hash？

```
簡單 hash：hash(key) % N
  → 新增/移除節點時，N 改變 → 幾乎所有 key 要搬移
  → 3 個節點變 4 個：~75% 的資料需要遷移

Consistent Hashing：
  → 新增/移除節點時，只影響相鄰節點的資料
  → 平均只需搬 1/N 的資料（3 → 4 節點：只搬 ~25%）
```

### Hash Ring 機制

```
Hash 空間：0 ~ 2^128 - 1（環形）
  → 每個節點被 hash 到環上的一個位置
  → 每個 key 被 hash 後，順時鐘找到第一個節點 → 該節點負責此 key

節點加入（Node D 加入 A 和 B 之間）：
  Before: ... → A (owns range A~B) → B → ...
  After:  ... → A (owns range A~D) → D (owns range D~B) → B → ...
  → 只有 A 需要把部分資料轉給 D
  → B, C 完全不受影響

節點離開（Node D 離開）：
  → D 的資料由下一個節點 B 接手
  → 只影響一個範圍
```

### 虛擬節點 (Virtual Nodes, vnodes)

```
問題：純 Consistent Hashing 可能造成負載不均
  → 3 個節點隨機分佈在環上 → 各自負責的範圍可能差很多
  → 極端情況：一個節點負責 60%，另一個只有 10%

解法：每個物理節點映射為多個虛擬節點

  Physical Node A → vnode_A1, vnode_A2, ..., vnode_A150
  Physical Node B → vnode_B1, vnode_B2, ..., vnode_B150
  Physical Node C → vnode_C1, vnode_C2, ..., vnode_C150

  → 環上有 450 個點（而非 3 個）
  → 統計上每個物理節點負責 ~1/3 的 key 空間
  → 標準差從 O(1/√N) 降到可控範圍
```

### 虛擬節點數量的 Trade-off

| 虛擬節點數/物理節點 | 優點 | 缺點 |
|---|---|---|
| 少（10-50） | Metadata 小，membership 廣播快 | 負載分佈不均 |
| 中（150-200）← 推薦 | 負載均勻（偏差 < 5%），故障時資料分散到多個節點恢復快 | Metadata 中等 |
| 多（500+） | 極均勻 | Metadata 膨脹，每次 membership 變更的 gossip 開銷大 |

```
Metadata 大小估算：
  1000 個物理節點 × 200 vnodes = 200K 個虛擬節點
  每個 vnode entry: token(16B) + node_id(8B) + status(4B) ≈ 28B
  200K × 28B = ~5.6MB
  → 每個節點都需要存一份完整的 ring metadata
  → Gossip 每秒交換一次，差異通常只有幾個 entry → 增量同步很小

異構硬體支援：
  高配機器（64GB RAM）→ 分配 300 vnodes
  低配機器（16GB RAM）→ 分配 75 vnodes
  → 自然按能力分配負載，不需額外機制
```

---

## 4. 資料複製 (Replication)：N, W, R 與 Sloppy Quorum

### Preference List

```
每個 key 被寫入到 hash ring 上順時鐘方向的 N 個「不同物理節點」：

  hash(key) → 落在 vnode_A3 → 物理節點 A
  順時鐘下一個不同物理節點 → B
  再下一個不同物理節點 → C

  N = 3 → preference list = [A, B, C]
  → A 是 coordinator（第一個），B 和 C 是 replica

注意：跳過同一物理節點的多個 vnode
  → 如果 vnode_A3 的下一個是 vnode_A7（同物理節點）→ 跳過
  → 確保 N 個 replica 在不同物理節點上（容錯有意義）
```

### 可調一致性 (Tunable Consistency)

```
N = replica 總數（通常 3）
W = 寫入需要幾個 replica 確認才回 ack
R = 讀取需要幾個 replica 回應才回 client

常見配置：
  N=3, W=2, R=2 → W+R=4 > N=3 → 保證讀寫交集 ≥ 1 → quorum consistency（非 linearizability，concurrent writes 仍需 conflict resolution）
  N=3, W=1, R=1 → W+R=2 < N=3 → 可能讀到 stale → 最終一致性
  N=3, W=3, R=1 → 寫入慢但讀取極快（適合 read-heavy）
  N=3, W=1, R=3 → 寫入極快但讀取慢（適合 write-heavy）
```

| 配置 | W+R vs N | 一致性 | Write Latency | Read Latency | 可用性 |
|------|----------|--------|---------------|--------------|--------|
| W=2, R=2 | 4 > 3 | Quorum（非 linearizable） | 等第 2 慢的 replica | 等第 2 慢的 replica | 容忍 1 節點故障 |
| W=1, R=1 | 2 < 3 | 最終一致 | 最快的 replica 即回 | 最快的 replica 即回 | 容忍 2 節點故障 |
| W=3, R=1 | 4 > 3 | Quorum（非 linearizable） | 等最慢的 replica | 最快即回 | Write 不容忍故障 |
| W=1, R=3 | 4 > 3 | Quorum（非 linearizable） | 最快即回 | 等最慢的 replica | Read 不容忍故障 |

### Sloppy Quorum + Hinted Handoff（暗示移交）

```
嚴格 Quorum 的問題：
  N=3, preference list = [A, B, C]
  如果 A 掛了 → 只剩 B, C → 如果 W=2 還能寫，但如果 B 也掛了 → 寫入失敗
  → 可用性不夠高

Sloppy Quorum：
  A 掛了 → 暫時把 A 的那一份寫到 D（hash ring 上 A 的下一個節點）
  → D 不是 preference list 的成員，但暫代 A
  → 只要叢集中有任意 W 個活著的節點就能寫入

Hinted Handoff 機制：
  1. Coordinator 發現 A unreachable
  2. 將資料寫到 D，但附帶一個 hint：
     { target: A, data: {key, value, vector_clock}, timestamp }
  3. D 在本地建立一個 hint 資料夾，定期檢查 A 是否恢復
  4. A 恢復後，D 把所有 hint 資料回傳給 A
  5. A 確認接收後，D 刪除 hint 資料

優點：寫入永不拒絕（極高可用性）
缺點：如果 D 也掛了 → hint 遺失 → 需要 anti-entropy 補救
      Sloppy quorum 下 W+R > N 不保證強一致性
      （因為讀寫可能命中不同的「暫代」節點）
```

---

## 5. 衝突解決：Vector Clock vs Last-Writer-Wins

### 為什麼會有衝突？

```
Leaderless 架構 → 任何節點都能接受寫入 → 並發寫入 (Concurrent Writes)

情境：
  Client X → Node A: PUT(key, "apple")   at time T1
  Client Y → Node B: PUT(key, "banana")  at time T1
  → A 和 B 各自寫入不同的值
  → 哪個是對的？→ 系統無法判斷 → 需要衝突解決機制
```

### Vector Clock（向量時鐘）

```
概念：每個節點維護一個向量，記錄「每個節點的寫入版本」

初始狀態：key 不存在

Step 1: Client X → Node A: PUT(key, "apple")
  vector clock: [A:1]
  → 所有 replica 同步後都是 [A:1, value="apple"]

Step 2: Client Y → Node A: PUT(key, "banana")  （基於 [A:1]）
  vector clock: [A:2]
  → value="banana"

Step 3: 並發！（兩個 client 都基於 [A:2] 做寫入）
  Client X → Node A: PUT(key, "cherry")  → [A:3]
  Client Y → Node B: PUT(key, "date")    → [A:2, B:1]

  → [A:3] 和 [A:2, B:1] 無法比較大小 → 偵測到衝突！

比較規則：
  VC1 > VC2  ⟺  VC1 的每個分量都 ≥ VC2 的對應分量，且至少一個 >
  [A:3]       vs [A:2, B:1]
  A: 3 > 2 ✓   B: 0 < 1 ✗  → 無法比較 → 並發衝突
```

```
衝突解決策略：
  1. 回傳所有衝突版本給 Client（Amazon 購物車做法）
     → Client 決定如何 merge（例如：購物車取聯集）
     → 最正確但增加 client 複雜度

  2. Application-level resolver（在 server 端註冊 merge function）
     → 例如 Riak 的 CRDT (Conflict-free Replicated Data Types)
     → 適合 counter, set 等可自動 merge 的資料類型

Amazon 購物車範例：
  User 在 Node A 加入 item_1 → cart = {item_1}  [A:1]
  User 在 Node B 加入 item_2 → cart = {item_2}  [B:1]
  → 並發衝突 → 讀取時回傳兩個版本
  → Client merge: {item_1} ∪ {item_2} = {item_1, item_2}
  → 寫回 merged version
  → 結果：不會丟失任何加入的商品（但刪除可能復活 → 需要 tombstone）
```

### Last-Writer-Wins (LWW)

```
機制：每次寫入附帶 timestamp → 衝突時選最大 timestamp 的值

  Client X: PUT(key, "cherry",  ts=1000)
  Client Y: PUT(key, "date",    ts=1001)
  → 衝突解決：ts=1001 勝 → value="date"

優點：極簡，不需要 client 處理衝突
缺點：
  - 時鐘偏差 (Clock Skew) → 物理時鐘不精確 → 可能選錯
  - 資料遺失：cherry 的寫入直接被丟棄，沒有 merge 的機會
  - 對購物車場景不適用（丟商品 = 金錢損失）

適用場景：
  - Immutable data（寫一次不改）
  - Cache（丟了可以重算）
  - Last-state-wins 語義合理的場景（例如 sensor 最新讀數）

Cassandra 預設用 LWW → 簡單但使用者需理解語義
Dynamo (Amazon) 預設用 Vector Clock → 複雜但不丟資料
```

| 特性 | Vector Clock | LWW |
|------|-------------|-----|
| 衝突偵測 | 精確偵測並發 | 不偵測，直接覆蓋 |
| 資料遺失 | 無（交給 client merge） | 有（被覆蓋的值直接丟棄） |
| Client 複雜度 | 高（需處理 merge） | 低（無需額外邏輯） |
| Metadata 開銷 | 每個 key 存向量 [N1:v, N2:v, ...] | 只存 timestamp |
| 向量膨脹問題 | 節點多時向量變大 → 需定期 pruning | 無 |
| 時鐘依賴 | 不依賴物理時鐘 | 強依賴（NTP 偏差可達 100ms+） |

---

## 6. 反熵機制 (Anti-entropy)：Merkle Tree

### 問題：Replica 之間如何偵測資料不一致？

```
場景：
  Node A 和 Node B 各有 100 萬個 key 的 replica
  因為網路問題，其中 3 個 key 不一致
  → 如何找出這 3 個 key？

暴力法：逐一比較所有 100 萬個 key
  → 每個 key 的 hash 32B × 1M = 32MB 資料傳輸
  → 太慢、太浪費頻寬

解法：Merkle Tree（雜湊樹）
```

### Merkle Tree 運作原理

```
建構（每個節點為其負責的 key range 建一棵 Merkle Tree）：

Level 0 (葉節點)：每個 key 的 hash
  H(k1)=a1  H(k2)=b2  H(k3)=c3  H(k4)=d4  H(k5)=e5  H(k6)=f6  H(k7)=g7  H(k8)=h8

Level 1：相鄰 hash 合併
  H(a1+b2)=X1    H(c3+d4)=X2    H(e5+f6)=X3    H(g7+h8)=X4

Level 2：
  H(X1+X2)=Y1                    H(X3+X4)=Y2

Level 3 (根節點)：
  H(Y1+Y2)=ROOT

比較流程（Node A vs Node B）：
  1. 交換 root hash → 如果相同 → 全部一致，結束（1 次比較）
  2. 如果不同 → 交換 Level 2 的 hash
     → Y1 相同但 Y2 不同 → 右子樹有差異
  3. 展開 Y2 → 交換 X3, X4
     → X3 不同，X4 相同 → 差異在 X3 對應的 key range
  4. 展開 X3 → 找到具體不一致的 key

複雜度：
  100 萬個 key → 樹高 ~20（log2(1M) ≈ 20）
  最差情況：每層比較 2 個 hash → ~40 次比較
  → O(log N) 而非 O(N)
  → 每次同步只傳幾 KB 而非幾十 MB
```

### Anti-entropy 的定位

```
Anti-entropy 是「最後防線」，不在 critical path 上：

  寫入路徑：
    Quorum write (W=2) → 即時保證 W 個 replica 有最新資料
    → 第 3 個 replica 透過 read repair 或 anti-entropy 最終同步

  背景同步：
    每個節點定期（例如每 10 分鐘）與 replica 節點交換 Merkle Tree
    → 找到差異 → 傳輸不一致的 key-value → 修復

  Merkle Tree 重建成本：
    key range 有任何寫入 → 需要重新計算受影響的 subtree
    → 可增量更新（只重算改變的葉節點到根的路徑）
    → 但高寫入量下仍有開銷 → 可延後批次重建
```

---

## 7. 故障偵測：Gossip Protocol（八卦協議）

### 為什麼不用中央化健康檢查？

```
中央化方案：一個 Monitor Server 定期 ping 所有節點
  → Monitor 本身是 SPOF (Single Point of Failure)
  → 1000 個節點 → Monitor 每秒送 1000 個 heartbeat → 自身成為瓶頸
  → Monitor 與某節點之間的網路問題 → 誤判該節點死亡

Gossip 方案：去中心化，每個節點只跟「少數隨機鄰居」交換狀態
  → 無 SPOF
  → 資訊在 O(log N) 輪內傳播到所有節點
```

### Gossip 機制

```
每個節點維護一個 membership list：
  { node_id: (heartbeat_counter, timestamp) }

每秒（或每 200ms）：
  1. 自己的 heartbeat_counter++
  2. 隨機選 1-3 個節點，交換完整 membership list
  3. 合併：對每個 node_id，取較大的 heartbeat_counter

故障偵測：
  如果 Node X 的 heartbeat 在 T_fail 秒內沒增加
  → 標記為 suspected（疑似故障）
  → 再等 T_cleanup 秒後仍無更新 → 標記為 down → 通知系統

典型參數：
  Gossip 間隔: 1 秒
  T_fail: 10 秒（連續 10 次沒收到更新）
  T_cleanup: 30 秒

傳播速度：
  1000 個節點，每秒 gossip 3 個鄰居
  → 資訊到達所有節點需要 ~log(1000)/log(3) ≈ 6-7 輪
  → ~7 秒內全叢集都知道新節點加入/離開
  → 加上 T_fail → 故障偵測延遲 ~17-20 秒
```

### 為什麼 Gossip 而非 Consensus（Paxos/Raft）？

| 特性 | Gossip | Paxos/Raft |
|------|--------|------------|
| 用途 | Membership + 故障偵測 | Leader election + 複製 log |
| 一致性 | 最終一致 | 強一致 |
| 容錯 | 任意數量節點故障仍能運作 | 需要多數 (majority) 存活 |
| 延遲 | O(log N) 輪 | O(1) 輪（leader 直接廣播） |
| 適用規模 | 數千節點 | 通常 3-7 節點 |

```
Dynamo-style 系統的選擇：
  → Membership / failure detection → Gossip（去中心化、大規模）
  → 資料複製 → 不用 consensus（用 quorum + 衝突解決）
  → 這也是為什麼 Dynamo 犧牲強一致性換取可用性

  vs. 對比：etcd / ZooKeeper 用 Raft/ZAB → 強一致 but 只適合少量節點
```

---

## 8. 讀寫路徑詳解

### 寫入路徑 (Write Path)

```
Client: PUT(key="user:123", value="{name: 'Alice'}")

1. Client SDK 計算 hash(key) → 對照本地快取的 ring metadata
   → 找到 preference list [A, B, C]
   → 選 A 為 coordinator（或 client 直接連到任意節點，該節點轉發給 A）

2. Coordinator (Node A):
   a. 並行發送 write request 到 [A(自己), B, C]
   b. 等待 W 個回應（假設 W=2）
   c. A 和 B 先回 ack → 成功 → 回 Client
   d. C 的回應可以晚點（或失敗 → 後續 anti-entropy 修復）

3. 每個 Replica 節點的本地寫入（Write-Ahead Log + LSM-Tree）：
   a. 寫入 Commit Log（WAL, append-only, sequential write）
      → 保證持久性：crash 後可從 WAL 恢復
      → Sequential write → SSD ~200μs, HDD ~2ms
   b. 寫入 Memtable（in-memory sorted structure, 通常 Red-Black Tree 或 Skip List）
      → O(log N) 插入
   c. 回 ack 給 Coordinator
   → 完全不碰磁碟上的 SSTable → 寫入極快

4. Memtable flush（背景）：
   → Memtable 滿（~64MB）→ 整個 dump 到磁碟成為一個 SSTable
   → SSTable: Sorted String Table，key 有序，immutable
   → 新建空的 Memtable 繼續接受寫入
```

### 讀取路徑 (Read Path)

```
Client: GET(key="user:123")

1. Client SDK 找到 preference list [A, B, C] → 向 Coordinator (A) 發 request

2. Coordinator 並行向 [A, B, C] 發 read request → 等 R 個回應

3. 每個 Replica 的本地讀取：
   a. 查 Memtable（O(log N) lookup）→ 找到就回
   b. 沒找到 → 從最新的 SSTable 開始查（Bloom Filter 先過濾）
      → Bloom Filter 回 "definitely not here" → 跳過此 SSTable
      → Bloom Filter 回 "maybe here" → 二分搜尋此 SSTable
   c. 依序查到最舊的 SSTable 直到找到

4. Coordinator 收到 R 個回應：
   a. 比較版本（vector clock 或 timestamp）
   b. 回傳最新版本給 Client
   c. 如果發現某 replica 的版本較舊 → 觸發 Read Repair

Read Repair：
  → Coordinator 在回 Client 之後，非同步地把最新版本寫回 stale replica
  → 不在 critical path 上（不影響 client latency）
  → 被動修復：只有被讀到的 key 會被修復
  → 配合 anti-entropy（主動修復）確保所有 key 最終一致
```

---

## 9. 儲存引擎：LSM-Tree

### 為什麼選 LSM-Tree 而非 B-Tree？

| 特性 | LSM-Tree | B-Tree |
|------|----------|--------|
| 寫入模式 | Sequential（append-only） | Random（in-place update） |
| 寫入放大 (Write Amplification) | 10-30x（compaction 造成） | 5-15x（WAL + full page writes + page split） |
| 寫入吞吐量 | **極高**（sequential I/O） | 中等（random I/O） |
| 讀取效率 | 中等（可能查多個 SSTable） | **高**（一次 B-Tree lookup） |
| 空間放大 | 有（多版本共存直到 compaction） | 低（in-place update） |
| 適用場景 | Write-heavy（KV Store, Time Series） | Read-heavy（RDBMS） |

```
Dynamo-style 系統選 LSM-Tree 的原因：
  1. KV Store 通常 write-heavy（尤其 fan-out、log 類場景）
  2. Sequential write → 充分利用 SSD 的高 sequential throughput
     → SSD sequential write: ~500MB/s
     → SSD random write: ~50MB/s (10x 差距)
     → HDD 差距更大: sequential 100MB/s vs random 1MB/s (100x)
  3. 讀取效率靠 Bloom Filter + Cache 彌補
```

### LSM-Tree 內部結構

```
                    ┌─────────────┐
  Write ──────────▶ │  Memtable   │  (In-memory, ~64MB, sorted)
                    │ (Skip List) │
                    └──────┬──────┘
                           │ flush (when full)
                           ▼
                    ┌─────────────┐
                    │  SSTable L0  │  (Disk, sorted, immutable)
                    │  SSTable L0  │  ← L0 的 SSTable 之間 key range 可重疊
                    │  SSTable L0  │
                    └──────┬──────┘
                           │ compaction (merge sort)
                           ▼
                    ┌──────────────┐
                    │  SSTable L1   │  ← 同一 Level 內 key range 不重疊
                    │  SSTable L1   │
                    └──────┬───────┘
                           │ compaction
                           ▼
                    ┌──────────────┐
                    │  SSTable L2   │  ← L(i+1) 容量是 L(i) 的 10 倍
                    │  SSTable L2   │
                    │  ...          │
                    └──────────────┘

Compaction 策略：
  Size-Tiered (STCS)：同大小的 SSTable 合併 → 寫入友好，空間放大大
  Leveled (LCS)：嚴格分層，每層容量 10x → 讀取友好，寫入放大大

  Cassandra 預設 STCS，RocksDB 預設 LCS
```

### Bloom Filter：讀取最佳化

```
問題：讀一個 key 可能需要查 5-10 個 SSTable → 5-10 次磁碟 I/O
解法：每個 SSTable 附帶一個 Bloom Filter（常駐記憶體）

Bloom Filter：概率性資料結構
  → "definitely not in this SSTable" → 跳過（100% 準確）
  → "maybe in this SSTable" → 去磁碟查（有 false positive 機率）

False positive rate 與空間的 trade-off：
  10 bits/key → ~1% false positive rate
  15 bits/key → ~0.1% false positive rate

  1 億個 key × 10 bits = ~125MB memory
  → 常駐記憶體完全可以接受

效果：
  沒有 Bloom Filter → 讀取平均 5 次磁碟 I/O
  有 Bloom Filter (1% FP) → 平均 1.04 次磁碟 I/O
  → 讀取效能提升 ~5x
```

---

## 10. 容量估算

```
假設：
  叢集: 100 個物理節點
  資料量: 10TB (replicated 前)
  Replication factor N=3 → 實際儲存 30TB
  QPS: 500K reads/sec + 100K writes/sec

每節點負擔：
  資料: 30TB / 100 = 300GB / node
  Read QPS: 500K / 100 = 5K reads/sec/node
  Write QPS: 100K / 100 = 1K writes/sec/node (× N 因為 replica → 3K)

單節點硬體需求：
  Storage: 300GB SSD (加上 compaction 暫用空間 → 600GB SSD)
  Memory:
    Memtable: 2 × 64MB = 128MB (double buffering)
    Bloom Filter: 假設 5 億 keys/node × 10 bits = 625MB
    Row Cache: ~4GB (hot key cache)
    OS page cache: ~10GB
    → 總計 ~16GB RAM
  Network: 5K reads × 1KB avg = 5MB/s + 3K writes × 1KB = 3MB/s → ~64Mbps
    → 1Gbps NIC 綽綽有餘

Latency 分析：
  Write: WAL append (~200μs) + Memtable insert (~1μs) ≈ 200μs local
    → Quorum W=2: max(node_A, node_B) + network RTT (0.5ms)
    → p50 ≈ 1ms, p99 ≈ 5ms

  Read (cache hit): Memtable or Row Cache → < 100μs + network
    → p50 ≈ 0.5ms

  Read (cache miss): Bloom Filter check + SSD read (~150μs) + network
    → p50 ≈ 1ms, p99 ≈ 10ms
```

| 指標 | 估算 |
|------|------|
| 節點數 | 100 physical nodes |
| 每節點資料 | 300GB (with replication) |
| 每節點 RAM | 16GB |
| 每節點 Read QPS | 5K/sec |
| 每節點 Write QPS | 3K/sec (含 replica) |
| 虛擬節點 | 100 × 200 = **20,000 vnodes** |
| Ring metadata | 20K × 28B = **~560KB/node** |
| Bloom Filter 記憶體 | ~625MB/node |
| Write latency (p50) | ~1ms |
| Read latency (p50) | ~0.5ms (cache hit), ~1ms (cache miss) |
| Read latency (p99) | ~10ms |

---

## 11. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 架構模式 | **Leaderless (Dynamo-style)** | 無 leader → 無 SPOF → 寫入可到任意節點 → 極高可用性 |
| 分區策略 | **Consistent Hashing + vnodes** | 節點增減只搬 1/N 資料；vnodes 確保負載均衡 + 異構硬體支援 |
| 一致性模型 | **可調 (W, R, N)** | 讓使用者按場景選擇：AP (W=1,R=1) 或 CP (W=2,R=2) |
| 衝突解決 | **Vector Clock（or LWW）** | VC 不丟資料但 client 複雜；LWW 簡單但有資料遺失風險 |
| Failure detection | **Gossip Protocol** | 去中心化、無 SPOF、O(log N) 傳播、支援大規模叢集 |
| Replica 同步 | **Read Repair + Anti-entropy (Merkle Tree)** | Read repair 被動修復 hot key；Merkle tree 主動修復 cold key |
| 寫入可用性 | **Sloppy Quorum + Hinted Handoff** | 永不拒絕寫入 → 99.995% 可用性 |
| 儲存引擎 | **LSM-Tree** | Write-heavy 場景的 sequential I/O 遠優於 B-Tree 的 random I/O |
| 讀取最佳化 | **Bloom Filter** | 1% FP rate × 10 bits/key → 讀取從 5 次磁碟 I/O 降到 ~1 次 |

---

## 12. 面試常見 Follow-up

### Q: 如何支援 Range Query？

```
Consistent Hashing 用 hash(key) 分佈資料 → key 的原始順序被打散
→ Range query (e.g., "所有 user:100 ~ user:200") 需要 scatter-gather 所有節點

解法：
  1. 改用 Range-based Partitioning（像 Bigtable / HBase）
     → 按 key 的原始值分區 → 保留順序 → 支援 range query
     → 但熱點問題（sequential key 集中在一個分區）

  2. Composite key: partition_key + sort_key（像 DynamoDB）
     → hash(partition_key) 決定分區
     → 同一 partition 內按 sort_key 排序
     → 支援 partition 內的 range query

  結論：純 Dynamo-style 不支援 range query → 這是設計取捨
```

### Q: Vector Clock 會無限膨脹嗎？

```
理論上是的：每個參與寫入的 node 都增加向量的一個分量
  → 1000 個節點參與過寫入 → 向量長度 1000

實務做法（Dynamo paper）：
  → 設定 timestamp pruning：向量中超過 T 天沒更新的 entry → 移除
  → 代價：可能把並發誤判為因果（but 極少發生）
  → Amazon 實務中向量長度通常 < 10（因為大部分 key 只被少數節點寫入）
```

### Q: 如果一整個 datacenter 掛了怎麼辦？

```
跨 DC 複製策略：
  → N=3 中，配置 2 個 replica 在本地 DC，1 個在遠端 DC
  → 或 N=5: 3 本地 + 2 遠端
  → Write: W=2 在本地 DC 完成 → 低延遲
  → 遠端 replica 非同步複製 → 跨 DC latency (~50-150ms) 不影響 write path

  本地 DC 全掛：
    → Client 自動 failover 到遠端 DC
    → 遠端有 1-2 個 replica → 可繼續服務
    → 可能讀到稍舊的資料（因為非同步複製）→ 但系統可用
```

### Q: 如何處理 Hot Key？

```
單一 key 被高頻訪問（例如：某明星的 profile）：
  → 無論怎麼分區，這個 key 都在同一組 N 個節點上 → 這 N 個節點過載

解法：
  1. Client-side cache：SDK 快取 hot key → 不打 server
  2. Read replica 加倍：hot key 額外複製到更多節點（N=3 → N=7）
  3. Key 加 salt：key = "celeb:123" → "celeb:123#0", "celeb:123#1", ...
     → 分散到不同節點 → 讀取時 scatter-gather → trade latency for throughput
  4. Dedicated cache tier：hot key 放 Redis → 攔截在 KV Store 之前
```

---

## 13. 面試策略：講述順序建議

1. **需求釐清 + 資料模型**（2 分鐘）— GET/PUT/DELETE API、資料量、QPS 估算、CAP 取捨（面試官明確要 AP 或 CP）
2. **分區：Consistent Hashing**（3 分鐘）— 畫 hash ring、解釋 virtual nodes、說明節點加入/離開只搬 1/N 資料
3. **複製 + 可調一致性**（3 分鐘）— N/W/R 參數、W+R > N 的意義、Sloppy Quorum + Hinted Handoff 保證可用性
4. **衝突解決**（2 分鐘）— Vector Clock 機制、LWW 的取捨、Amazon 購物車範例
5. **儲存引擎 (LSM-Tree)**（2 分鐘）— Memtable → SSTable → Compaction 寫入路徑、Bloom Filter 讀取最佳化
6. **故障偵測與修復**（1 分鐘）— Gossip Protocol、Merkle Tree anti-entropy、Read Repair
7. **Deep Dive（面試官選）**（2 分鐘）— Hot Key、跨 DC 複製、Range Query 限制、Compaction 策略
