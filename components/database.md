# Database: SQL vs NoSQL — PostgreSQL, MySQL, MongoDB, Cassandra, DynamoDB

## 1. Comprehensive Comparison Matrix

| Dimension | PostgreSQL | MySQL (InnoDB) | MongoDB | Cassandra | DynamoDB |
|-----------|-----------|----------------|---------|-----------|----------|
| **Data Model** | Relational (tables, rows, columns); 支援 JSONB、array、composite types | Relational (tables, rows, columns); JSON 支援較弱 (5.7+ JSON type) | Document (BSON); 彈性 schema，nested documents + arrays | Wide-column (partition key + clustering columns); 每個 row 可有不同 columns | Key-value / Document (JSON); partition key + optional sort key |
| **Query Language** | SQL (最完整的標準實作); CTE, window functions, lateral join | SQL (大部分標準); window functions (8.0+), CTE (8.0+) | MQL (MongoDB Query Language); aggregation pipeline, `$lookup` for joins | CQL (Cassandra Query Language); 外觀像 SQL 但沒有 JOIN、沒有 subquery | PartiQL (SQL-compatible) 或 GetItem/Query/Scan API |
| **Scalability Model** | **Vertical 為主**; 原生不支援 auto-sharding。水平擴展靠 Citus extension 或 application-level sharding | **Vertical 為主**; 水平擴展靠 Vitess、ProxySQL 或 MySQL Group Replication | **水平擴展**; 內建 sharding (mongos router + config server + shard)。shard key 決定資料分布 | **水平擴展 (masterless)**; consistent hashing ring，加節點即可擴展，線性 scalability | **水平擴展 (fully managed)**; AWS 自動 partition splitting，理論上無限制 |
| **Consistency Model** | **Strong (ACID)**; Serializable isolation 可選，預設 Read Committed | **Strong (ACID)**; 預設 Repeatable Read (InnoDB) | **Tunable**; 預設 w:1/r:1 (eventual)。可設定 writeConcern: majority + readConcern: linearizable 達到 strong | **Tunable**; ONE/QUORUM/ALL per query。QUORUM read + QUORUM write = strong consistency (R+W > N) | **Tunable**; Eventually consistent (預設) 或 Strongly consistent read (加倍 RCU 消耗) |
| **Throughput (Read)** | ~50K-100K simple reads/s (single node, 適當 tuning + connection pooling) | ~80K-150K simple reads/s (single node, buffer pool hit ratio > 99%) | ~50K-100K reads/s per shard (WiredTiger，取決於 working set in RAM) | ~10K-50K reads/s per node (視 partition design 和 consistency level); 全 cluster 可達 millions | 按需模式自動擴展；provisioned 模式 1 RCU = 1 strongly consistent read/s (4KB item) |
| **Throughput (Write)** | ~10K-30K writes/s (single node, WAL + fsync bottleneck) | ~15K-40K writes/s (single node, group commit 優化) | ~20K-50K writes/s per shard (WiredTiger journal + checkpoint) | **~50K-100K writes/s per node** (LSM-tree, append-only, 寫入最快) | 1 WCU = 1 write/s (1KB item); 按需模式 auto-scale |
| **Latency (p99)** | 1-5ms (index hit, warm cache); complex joins 可達 100ms+ | 1-3ms (clustered index lookup, buffer pool hit) | 1-5ms (single document read with index); aggregation pipeline 可達 100ms+ | 5-20ms (QUORUM read, 需讀多節點比對); ONE read ~2-5ms | **< 10ms (single-digit ms guarantee)**; 使用 DAX cache 可達 microseconds |
| **Replication** | Streaming replication (WAL-based, async/sync); logical replication for selective tables | Semi-sync replication (at least 1 replica ACK); Group Replication (Paxos-based multi-primary) | Replica Set (primary + secondaries, oplog-based); automatic failover via election | **Leaderless**; 所有節點可讀寫，gossip protocol 同步 (anti-entropy repair) | Managed multi-AZ replication (3 AZ by default); Global Tables for cross-region |
| **Transactions (ACID)** | **完整 ACID**; Serializable, Repeatable Read, Read Committed, Read Uncommitted | **完整 ACID** (InnoDB); Serializable, Repeatable Read (default), Read Committed, Read Uncommitted | Multi-document transactions (4.0+); **但效能代價高**, 跨 shard transaction 需 two-phase commit | **不支援跨 partition transaction**; lightweight transactions (LWT, 用 Paxos) 效能差 (~10x 慢) | **TransactItems API** (最多 100 items, 4MB); 跨 table transaction 但受大小限制 |
| **Operational Complexity** | 中等; 需要 vacuum tuning, connection pooling (PgBouncer), monitoring bloat | 中低; 成熟工具鏈，但 schema migration 在大表上很痛 (gh-ost/pt-online-schema-change) | 中高; mongos + config server + shard 架構，shard key 選擇是生死決定 | **高**; compaction tuning, repair 排程, tombstone management, data modeling 限制多 | **低 (fully managed)**; 但 capacity planning 和 cost optimization 是挑戰 |
| **Cost Model** | Open source (免費); 託管服務 (RDS, Aurora) 按 instance 計費 | Open source (免費); 託管服務 (RDS, Aurora MySQL) 按 instance 計費 | Open source (免費); Atlas 按 instance/storage 計費 | Open source (免費); AWS Keyspaces / DataStax Astra 按需計費 | **Pay-per-use**; On-demand ($1.25/M WCU, $0.25/M RCU) 或 Provisioned (更便宜但需預估) |
| **Best Use Cases** | 複雜 relational data, OLTP+OLAP 混合, geospatial (PostGIS), full-text search | 高速 OLTP (web applications), 成熟生態系, read-heavy workloads | 快速迭代的產品 (schema 常變), content management, catalog, semi-structured data | **寫入密集 + 超大規模**; time-series, IoT telemetry, activity logs, messaging | Serverless applications, gaming leaderboards, session store, 需要 zero-ops 的 key-value 存取 |

---

## 2. Underlying Implementation Differences

### PostgreSQL: MVCC + WAL + Heap Table

PostgreSQL 的核心設計哲學是**正確性優先**。它用 Multi-Version Concurrency Control (MVCC) 達成高併發讀寫，用 Write-Ahead Log (WAL) 保證 crash recovery 的 durability。

**MVCC 機制 — Tuple Versioning:**

PostgreSQL 的 MVCC 不使用 undo log（與 MySQL/InnoDB 不同），而是直接在 heap table 中保存多個版本的 tuple。

```
Table Page (8KB block):
┌─────────────────────────────────────────────────────┐
│  Tuple v1 (xmin=100, xmax=200)  ← 已被 txn 200 更新  │
│  Tuple v2 (xmin=200, xmax=∞)    ← 目前可見版本        │
│  Tuple v3 (xmin=300, xmax=∞)    ← 另一筆新 row        │
│  [free space]                                        │
└─────────────────────────────────────────────────────┘

每個 tuple header 包含:
- xmin: 建立此版本的 transaction ID
- xmax: 刪除/更新此版本的 transaction ID (0 = 尚未刪除)
- ctid:  指向同一 row 的下一個版本 (update chain)
```

**可見性判斷規則**: 一個 transaction（假設 txid = 250）看到一個 tuple 的條件是 `xmin < 250 AND (xmax == 0 OR xmax > 250)`。這意味著每次 `UPDATE` 實際上是 `INSERT new version + mark old version as dead`。舊版本會累積在 table 中形成 **dead tuples**。

**VACUUM — 清理 dead tuples:**

VACUUM 是 PostgreSQL 最關鍵的背景作業。autovacuum daemon 預設在 dead tuples 超過 `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tuples` 時觸發（預設 50 + 20% of live tuples）。

VACUUM 做的事：
1. 掃描 table pages，找出所有 dead tuples（xmax < 所有活躍 transaction 中最小的 txid）。
2. 將 dead tuple 空間標記到 Free Space Map (FSM) 供後續 INSERT 重用。
3. 更新 Visibility Map (VM)，標記哪些 pages 是 "all-visible"（index-only scan 需要）。

**如果 VACUUM 跟不上寫入速度**，table 會持續膨脹 (table bloat)，index 也會膨脹。極端情況下 transaction ID wraparound 會導致 PostgreSQL 強制 shutdown 來避免資料損壞。

**WAL (Write-Ahead Log):**

所有寫入先寫 WAL（sequential write），再異步寫回 data pages（random write）。這確保 crash recovery 只需重播 WAL 即可。WAL 也是 streaming replication 的基礎 — replica 接收 WAL records 並重播。

**B-tree Indexes:**

PostgreSQL 預設 index 是 B-tree。Index entry 指向 heap tuple 的 physical location (ctid)。這意味著 UPDATE 一個 indexed column 時，需要更新 index entry。為了緩解這個問題，PostgreSQL 引入了 **HOT (Heap-Only Tuple)** 優化：如果 UPDATE 不涉及任何 indexed column 且新 tuple 可以放在同一 page，就不需要更新 index。

**TOAST (The Oversized-Attribute Storage Technique):**

當一個 row 的大小超過約 2KB 時（page size 8KB 的 1/4），PostgreSQL 會自動將大型欄位壓縮並/或搬到外部 TOAST table 存放。使用者不需要特別處理，這是完全透明的。但這意味著讀取含大型欄位的 row 時需要額外的 I/O。

**連線模型 — Process-per-Connection:**

PostgreSQL 為每個 client connection fork 一個 OS process（不是 thread）。每個 process 消耗約 5-10MB RAM。1000 個連線 = 5-10GB RAM 僅用於連線管理。這就是為什麼 **PgBouncer 或 PgCat 等 connection pooler 在 production 環境是必備的**。沒有 connection pooling 的 PostgreSQL 在超過 200-300 連線後效能會顯著下降（context switch overhead + shared buffer contention）。

```
PostgreSQL Write Path:

Client                PostgreSQL Process           Disk
  │                        │                        │
  │── BEGIN ──────────────>│                        │
  │── INSERT/UPDATE ──────>│                        │
  │                        │── write WAL record ──>│ (sequential, WAL segment)
  │                        │   (in WAL buffer)      │
  │── COMMIT ────────────>│                        │
  │                        │── fsync WAL ─────────>│ (durability guarantee)
  │<── OK ────────────────│                        │
  │                        │                        │
  │                   [later, bgwriter/checkpointer]│
  │                        │── write dirty pages ─>│ (random I/O to heap)
```

**Capacity Planning Anchors:**
- 單節點 OLTP: ~10K-30K writes/s, ~50K-100K reads/s (8-16 cores, 64GB+ RAM, NVMe SSD)
- Connection pooling 建議: `max_connections` 設為 CPU cores * 2-4，前面放 PgBouncer
- shared_buffers: 設為 RAM 的 25% (e.g., 64GB RAM → 16GB shared_buffers)
- WAL 產生速度: heavy write workload ~100MB-1GB/s WAL
- Autovacuum workers: 預設 3，heavy write tables 建議調到 5-6 per table
- Table bloat 超過 20% 時考慮 `pg_repack` 進行線上 reorganization

---

### MySQL (InnoDB): Clustered Index + Redo/Undo Log + Buffer Pool

MySQL 的 InnoDB 引擎與 PostgreSQL 在儲存架構上有根本性差異。最核心的區別是 **clustered index** 和 **undo log-based MVCC**。

**Clustered Index — 資料就是 Primary Key Index:**

InnoDB 的 table 資料按照 primary key 的 B+tree 順序物理存放。Leaf node 直接包含完整的 row data。這意味著：
- Primary key range scan 極快（資料物理上連續）。
- 沒有 PostgreSQL 的 "heap table + index pointer" 間接層 — 不需要額外的 heap lookup。
- Secondary index 的 leaf node 存的是 primary key value（不是 physical address）。所以 secondary index 查詢需要兩次 B+tree traversal: secondary index → 拿到 PK → clustered index → 拿到 row。

```
InnoDB Clustered Index (B+tree):

         [Internal Node: PK 50, 100]
        /            |              \
   [Leaf: PK 1-49]  [Leaf: PK 50-99]  [Leaf: PK 100-149]
   ┌──────────┐     ┌──────────┐       ┌──────────┐
   │PK=1, row │     │PK=50, row│       │PK=100,row│
   │PK=2, row │     │PK=51, row│       │PK=101,row│
   │...       │     │...       │       │...       │
   └──────────┘     └──────────┘       └──────────┘
   (資料直接存在 leaf node 中，不需要額外 heap lookup)

Secondary Index:
   [Leaf: email='a@b.com' → PK=42]
     → 需要再到 clustered index 找 PK=42 的完整 row (回表查詢)
```

**MVCC — Undo Log 方式:**

與 PostgreSQL 不同，InnoDB 的 MVCC 不在 table 中保存多版本。而是：
1. Table page 只保存**最新版本**的 row。
2. 修改前的舊版本存在 **undo log** (rollback segment) 中。
3. 讀取時，如果 transaction 需要看到舊版本，從 undo log chain 往回追溯直到找到對該 transaction 可見的版本。

**與 PostgreSQL 的關鍵差異**: InnoDB 不需要 VACUUM — undo log 在所有需要它的 transaction 結束後由 purge thread 自動清理。但長時間未提交的 transaction 會導致 undo log 堆積（類似 PostgreSQL 的 long-running transaction 阻止 VACUUM）。

**Redo Log (WAL equivalent):**

InnoDB 的 redo log 等同於 PostgreSQL 的 WAL。寫入時先寫 redo log（sequential），再由 background thread 寫回 data pages。`innodb_flush_log_at_trx_commit` 控制 fsync 行為：
- `=1`: 每次 commit 都 fsync redo log（最安全，預設值）
- `=2`: 每次 commit 寫到 OS page cache，每秒 fsync 一次（crash-safe against MySQL crash, not OS crash）
- `=0`: 每秒寫入並 fsync（最快，但可能丟失 1 秒資料）

**Buffer Pool — InnoDB 的靈魂:**

Buffer pool 是 InnoDB 最重要的記憶體結構。所有資料頁和 index 頁的讀寫都經過 buffer pool。**buffer pool hit ratio 目標: > 99%**。如果 working set 能完全放進 buffer pool，讀取幾乎都是 memory access（~100ns）而非 disk I/O（~150μs SSD）。

```
innodb_buffer_pool_size 建議: RAM 的 70-80%
例: 128GB RAM → 100GB buffer pool
```

**Group Commit 優化:**

InnoDB 將多個 transaction 的 redo log fsync 合併為一次 I/O 操作，大幅提升寫入吞吐。這是 MySQL 在高併發寫入時 throughput 比 PostgreSQL 稍高的原因之一。

**Capacity Planning Anchors:**
- 單節點 OLTP: ~15K-40K writes/s, ~80K-150K reads/s (buffer pool hit ratio > 99%)
- Buffer pool: RAM 的 70-80%
- Redo log size: 建議 1-2GB per file, 2 files (可容納 1-2 小時的 redo)
- Table DDL 痛點: `ALTER TABLE` 在大表上會 lock 整張 table (需用 gh-ost 或 pt-online-schema-change 做線上 migration)
- Max row size: 約 8KB (half of 16KB page size); 超過用 external page (類似 TOAST)
- 連線模型: thread-per-connection (比 PostgreSQL 的 process-per-connection 輕量), 但建議仍用 ProxySQL 做 connection pooling

---

### MongoDB: Document Model + WiredTiger + Sharding

MongoDB 的核心價值是**彈性 schema 的 document model**，底層由 WiredTiger 儲存引擎驅動。

**Document Model (BSON):**

MongoDB 以 BSON (Binary JSON) 格式儲存 documents。BSON 是 JSON 的二進位編碼，支援 JSON 沒有的型別（Date, ObjectId, Binary, Decimal128 等）。

**彈性 schema 的實際機制**: MongoDB 在 collection 層級不強制 schema。每個 document 可以有完全不同的 fields。底層實作是每個 document 的 BSON 中包含完整的 field names + values — 這意味著 field name 在每個 document 中重複儲存。對於大量小 document 且 field name 很長的場景，這會造成顯著的儲存浪費。WiredTiger 的 snappy/zstd 壓縮會緩解這個問題（典型壓縮率 50-70%）。

從 3.6+ 開始，MongoDB 支援 **JSON Schema Validation**，可以在 collection 層級定義 schema rules，介於完全無 schema 和 RDBMS 嚴格 schema 之間。

**WiredTiger 引擎:**

WiredTiger (MongoDB 3.2+ 預設引擎) 是一個高效能的 B-tree + LSM-tree hybrid 儲存引擎（MongoDB 中主要用 B-tree mode）。

核心機制：
- **Document-level locking**: 比舊的 MMAPv1 引擎 (collection-level lock) 大幅改善併發。
- **Compression**: 支援 snappy (預設, 快速) 和 zstd (更高壓縮率) 和 zlib。
- **Cache**: WiredTiger internal cache (預設 RAM 的 50% 或 256MB, 取較大者) + OS filesystem cache 雙層快取。
- **Checkpoint**: 每 60 秒或 journal 到達 2GB 時，WiredTiger 將記憶體中的 dirty pages flush 到 disk 建立一致性 snapshot。
- **Journal**: 類似 WAL，確保 crash recovery。預設每 100ms fsync 一次（可設定 `writeConcern: { j: true }` 強制每次寫入都 journal fsync）。

**Sharding 架構:**

```
                    ┌──────────┐
  Application ───>  │  mongos   │  (Query Router, stateless, 可部署多個)
                    │  (router) │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌────────┐
         │Shard 1 │ │Shard 2 │ │Shard 3 │
         │(RS)    │ │(RS)    │ │(RS)    │
         │P S S   │ │P S S   │ │P S S   │
         └────────┘ └────────┘ └────────┘
              ▲          ▲          ▲
              │          │          │
         ┌────────────────────────────────┐
         │       Config Servers           │
         │   (metadata: chunk → shard     │
         │    mapping, stored as RS)      │
         └────────────────────────────────┘

RS = Replica Set (1 Primary + N Secondaries)
P = Primary, S = Secondary
```

**Shard Key 是生死決定**: shard key 決定 document 如何分佈到各 shard。選錯 shard key 會導致：
- **Hot shard**: 如果用 monotonically increasing field (e.g., `_id` ObjectId, timestamp) 作為 shard key，所有新寫入都集中在最後一個 chunk 所在的 shard。
- **Scatter-gather queries**: 如果查詢條件不包含 shard key，mongos 必須向所有 shard 發送查詢再合併結果，延遲 = 最慢的 shard。
- **一旦選定 shard key，4.4 之前無法更改**（5.0+ 支援 `reshardCollection` 但代價很高）。

最佳實踐: 使用 **hashed shard key** (均勻分佈寫入) 或 **compound shard key** (高基數 field + 查詢常用 field)。

**Capacity Planning Anchors:**
- 單 shard (3-node replica set): ~20K-50K writes/s, ~50K-100K reads/s
- WiredTiger cache: RAM 的 50%，加上留 OS cache 給 filesystem
- 單個 document 最大: 16MB
- 單個 collection 建議不超過 ~1TB per shard (chunk migration 效能考量)
- Oplog size: 建議至少保留 24-72 小時的 oplog (secondary 斷線超過 oplog window 需 full resync)
- Shard 數量: 每增一個 shard 需 3 個節點 (replica set), mongos + config server 額外 overhead

---

### Cassandra: LSM-Tree + Consistent Hashing + Leaderless Replication

Cassandra 的設計目標是**永不停機、線性水平擴展、寫入極快**。它的架構來自 Amazon Dynamo (分散式) + Google Bigtable (storage engine) 的結合。

**LSM-Tree Write Path — 為什麼寫入極快:**

```
Write Path:

Client
  │
  ▼
┌─────────────┐
│ Commit Log   │  ← 1. 先寫 commit log (sequential append, durability)
│ (WAL on disk)│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Memtable    │  ← 2. 寫入記憶體中的 sorted data structure (Red-Black tree)
│ (in-memory)  │     寫入到此即可回覆 client "OK"
└──────┬──────┘
       │ (when memtable reaches threshold, e.g., 256MB)
       ▼
┌─────────────┐
│  SSTable     │  ← 3. Flush 到 disk 成為 immutable SSTable file
│ (on disk,    │     (Sorted String Table, 按 partition key 排序)
│  immutable)  │
└──────┬──────┘
       │ (background)
       ▼
┌─────────────┐
│ Compaction   │  ← 4. 合併多個 SSTable，消除 tombstones 和重複
│              │     (Size-Tiered / Leveled Compaction Strategy)
└─────────────┘
```

**寫入只需要 1 次 sequential disk write (commit log) + 1 次 memory write (memtable)**。不需要讀取舊資料、不需要更新 index in-place、不需要 lock。這就是 Cassandra 寫入吞吐極高的根本原因。

**LSM-Tree Read Path — 為什麼讀取相對慢:**

```
Read Path:

Client
  │
  ▼
┌─────────────┐
│  Memtable    │  ← 1. 先查記憶體 (最新資料)
└──────┬──────┘
       │ (miss)
       ▼
┌─────────────┐
│  Row Cache   │  ← 2. 查 row cache (如果啟用)
└──────┬──────┘
       │ (miss)
       ▼
┌─────────────┐
│ Bloom Filter │  ← 3. 對每個 SSTable 檢查 Bloom filter
│ (per SSTable)│     (快速排除不包含目標 key 的 SSTable, false positive ~1%)
└──────┬──────┘
       │ (possible match)
       ▼
┌─────────────┐
│ Partition    │  ← 4. 查 partition index 定位 SSTable 中的位置
│ Index        │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ SSTable Data │  ← 5. 從 disk 讀取實際資料
└─────────────┘

最壞情況: 需要查所有 SSTable 層級，I/O 次數 = SSTable 數量
```

讀取需要檢查 memtable + 可能多個 SSTable files。Bloom filter 幫助跳過不包含目標 key 的 SSTable，但如果 compaction 落後或 partition 很大，讀取延遲會顯著上升。**讀寫比例越高，Cassandra 的相對優勢越小。**

**B-tree vs LSM-tree 結構對比:**

```
B-tree (PostgreSQL, MySQL):              LSM-tree (Cassandra):
┌───────────────────┐                    ┌───────────────────┐
│    Root Node      │                    │    Memtable       │ ← 記憶體
├───┬───┬───┬───┬───┤                    │  (sorted, mutable)│
│ 10│ 20│ 30│ 40│ 50│                    └────────┬──────────┘
├───┴───┴───┴───┴───┤                             │ flush
│  Internal Nodes   │                    ┌────────▼──────────┐
├───┬───┬───┬───┬───┤                    │  L0 SSTables      │ ← disk
│ . │ . │ . │ . │ . │                    │  (may overlap)    │
├───┴───┴───┴───┴───┤                    ├───────────────────┤
│   Leaf Nodes      │                    │  L1 SSTables      │
│ [data pages,      │                    │  (non-overlapping) │
│  sorted, mutable] │                    ├───────────────────┤
└───────────────────┘                    │  L2 SSTables      │
                                         │  (larger, sorted)  │
Write: find leaf → update in-place       └───────────────────┘
  → random I/O (slow)                   Write: append to memtable → flush
Read: traverse tree → 1 seek              → sequential I/O (fast)
  → O(log N) (fast)                     Read: check all levels
                                           → multiple I/Os (slow)

Trade-off:
  B-tree  = 讀優化 (read-optimized)
  LSM-tree = 寫優化 (write-optimized)
```

**Consistent Hashing Ring — 資料分佈:**

Cassandra 將整個 token 範圍 (-2^63 to 2^63-1) 組成一個 ring。每個節點負責一段 token range。Partition key 經過 Murmur3 hash 計算後落在 ring 上的某個位置，由負責該 range 的節點存放（加上 replication factor 決定的 replica 節點）。

新增節點時，只需要從相鄰節點遷移一部分 token range 的資料，不需要全局重新分佈。使用 virtual nodes (vnodes, 預設 256 per node) 讓分佈更均勻。

**Tunable Consistency:**

| Level | 意義 | 延遲 | 一致性 |
|-------|------|------|--------|
| ONE | 任一 replica 回覆即可 | 最低 | 最弱 (eventual) |
| QUORUM | (RF/2)+1 replicas 回覆 | 中等 | 可達 strong (R+W > N) |
| ALL | 所有 replicas 回覆 | 最高 | 最強但可用性最差 |
| LOCAL_QUORUM | 本地 DC 的 quorum | 跨 DC 時用 | 本地強一致 |

典型設定: RF=3, read QUORUM + write QUORUM = 2+2 > 3，保證 strong consistency 且容忍 1 個節點故障。

**Capacity Planning Anchors:**
- 單節點: ~50K-100K writes/s, ~10K-50K reads/s (視 partition design)
- 線性擴展: 3 節點 → 6 節點 ≈ 吞吐翻倍
- Partition 大小建議: < 100MB (超過會導致 compaction 和 read 效能問題)
- 每個 partition 的 row 數建議: < 100K rows
- Compaction 需要 50% 額外磁碟空間 (Size-Tiered) 或 10% (Leveled)
- Tombstone 累積超過 100K per query 會觸發 warning, 效能急劇下降
- Repair 週期: 必須在 `gc_grace_seconds` (預設 10 天) 內完成一次 full repair，否則 tombstone 復活

---

### DynamoDB: Fully Managed + Partition Key + Single-Digit ms Latency

DynamoDB 是 AWS 的 fully managed NoSQL 服務，源自 Amazon 內部的 Dynamo 論文，但在 managed service 層面上大幅簡化了操作複雜度。

**Partition Key + Sort Key 資料模型:**

```
Table: Orders
┌──────────────────────────────────────────────────────────┐
│ Partition Key (PK)  │ Sort Key (SK)   │ Attributes...    │
├─────────────────────┼─────────────────┼──────────────────┤
│ customer_123        │ order#2024-001  │ {total: 99.99}   │
│ customer_123        │ order#2024-002  │ {total: 149.50}  │
│ customer_123        │ order#2024-003  │ {total: 29.99}   │
│ customer_456        │ order#2024-001  │ {total: 75.00}   │
└──────────────────────────────────────────────────────────┘

PK: 決定資料存放在哪個 physical partition (hash-based)
SK: 同一個 PK 內的排序依據，支援 range query
PK + SK = 唯一識別一個 item
```

**Internal Architecture — Partition & Storage Nodes:**

DynamoDB 背後是一個分散式系統，每個 table 被拆成多個 partitions，分佈在 AWS 內部的 storage nodes 上。一個 partition 有三個 replicas 分佈在同一個 region 的三個 AZ 中。

寫入流程：
1. Request router 根據 partition key hash 找到目標 partition 的 leader node。
2. Leader 寫入並等待至少 1 個 follower 確認（2/3 replicas, 類似 quorum write）。
3. 回覆 client。

讀取流程（eventually consistent，預設）：
- 可以從任何一個 replica 讀取，不需要等 leader。更快，但可能讀到稍微過時的資料（通常在毫秒級內同步完成）。

讀取流程（strongly consistent）：
- 必須從 leader 讀取，確保看到最新資料。消耗 2x RCU。

**Single-digit millisecond 延遲保證的機制:**

1. **SSD-backed storage**: 所有資料存放在 SSD 上，random read ~150μs。
2. **Memory-resident metadata**: partition map 和 routing table 在 request router 的記憶體中，routing 決策 < 1ms。
3. **單一 partition 服務**: 一個 GetItem/Query 操作只涉及一個 partition（因為必須提供 partition key），消除了跨 partition 的協調開銷。
4. **預先分配容量**: Provisioned mode 下，AWS 預先分配足夠的 partition 來滿足 throughput 需求。每個 partition 上限: 3000 RCU + 1000 WCU + 10GB data。
5. **沒有 query optimizer overhead**: DynamoDB 的 access pattern 極其簡單（hash lookup + optional range scan），不需要像 RDBMS 那樣做 query planning。

**GSI (Global Secondary Index) / LSI (Local Secondary Index):**

```
GSI: 完全獨立的 table (不同的 partition key)
┌───────────────────┐       ┌─────────────────────┐
│ Base Table         │       │ GSI: by_status       │
│ PK: customer_id   │──────>│ PK: status           │
│ SK: order_id       │ async │ SK: created_at       │
│                    │ repl  │ (eventually consistent│
└───────────────────┘       │  with base table)    │
                             └─────────────────────┘

LSI: 與 base table 共享 partition key, 不同的 sort key
  - 必須在建表時定義, 之後不能新增
  - 與 base table 共享 10GB partition limit
  - 支援 strongly consistent read
```

**GSI 本質上是一個由 DynamoDB 自動維護的、異步複製的獨立 table。** 這意味著 GSI 讀取永遠是 eventually consistent，且 GSI 寫入消耗額外的 WCU (如果 GSI 的 WCU 被 throttle，base table 的寫入也會被 throttle)。

**DAX (DynamoDB Accelerator):**

DAX 是一個 in-memory cache 層，放在 application 和 DynamoDB 之間。讀取延遲從 single-digit milliseconds 降到 **microseconds**。DAX 是一個 write-through cache（寫入同時更新 cache 和 DynamoDB），支援 item cache (GetItem) 和 query cache (Query)。

適用場景: 讀取密集且 access pattern 有 locality (hot keys)。不適用場景: 寫入密集 (cache invalidation 頻繁) 或需要 strongly consistent read (DAX only supports eventually consistent)。

**On-Demand vs Provisioned Capacity:**

| Mode | 適用場景 | 計費 | 注意事項 |
|------|---------|------|---------|
| On-Demand | 流量不可預測, 新應用, spiky workloads | $1.25/M WCU, $0.25/M RCU | 比 provisioned 貴約 5-7x; 有 burst limit (前一個 peak 的 2x) |
| Provisioned | 流量可預測, 穩定 workloads | ~$0.00065/WCU-hr, ~$0.00013/RCU-hr | 可搭配 Auto Scaling; Reserved Capacity 可再省 53-76% |

**Capacity Planning Anchors:**
- 1 RCU = 1 strongly consistent read/s (item ≤ 4KB) 或 2 eventually consistent reads/s
- 1 WCU = 1 write/s (item ≤ 1KB)
- 單個 item 最大: 400KB
- 單個 partition: 3000 RCU + 1000 WCU + 10GB
- GSI 數量限制: 20 per table
- LSI 數量限制: 5 per table
- BatchGetItem: 最多 100 items, 16MB
- TransactWriteItems: 最多 100 items, 4MB
- Scan 是全表掃描，每次最多回傳 1MB，代價極高 — 設計 schema 時必須避免需要 Scan 的 access pattern

---

## 3. Architect's Decision Tree

```
START: "我需要選一個 database"
│
├── Q1: 你的資料有複雜的 relational 結構嗎？
│       (多對多關係、需要 JOIN、referential integrity)
│   │
│   ├── YES ──> 你需要 RDBMS
│   │   │
│   │   ├── Q1a: 需要進階 SQL 功能嗎？
│   │   │        (CTE, Window Functions, JSONB, Full-text Search,
│   │   │         GIS, Custom Types, Stored Procedures in multiple languages)
│   │   │   ├── YES ──> PostgreSQL
│   │   │   │           (最完整的 SQL 實作，extension 生態系豐富)
│   │   │   └── NO ──> continue
│   │   │
│   │   ├── Q1b: 是 read-heavy web application 且需要最成熟的生態系？
│   │   │   ├── YES ──> MySQL
│   │   │   │           (最大的社群、最多的 hosting 選項、
│   │   │   │            InnoDB buffer pool 對 read-heavy 特別有效)
│   │   │   └── NO ──> PostgreSQL (safer default)
│   │   │
│   │   └── Q1c: 需要水平擴展 RDBMS 嗎？
│   │       ├── YES ──> PostgreSQL + Citus / MySQL + Vitess / Aurora
│   │       │           (或考慮重新設計 data model 避免 cross-shard JOIN)
│   │       └── NO ──> 單節點 PostgreSQL/MySQL 能撐到很遠
│   │                   (vertical scale: 96 cores, 768GB RAM 能處理
│   │                    大多數 10K-50K QPS 的 OLTP workload)
│   │
│   └── NO ──> continue
│
├── Q2: 你的 data model 是 document / semi-structured 嗎？
│       (embedded objects, variable fields, JSON-like structure)
│   │
│   ├── YES
│   │   │
│   │   ├── Q2a: 需要水平擴展到 TB-PB 級別嗎？
│   │   │   ├── YES ──> MongoDB (with sharding)
│   │   │   │           (內建 sharding, 但注意 shard key 設計)
│   │   │   └── NO ──> MongoDB (replica set) 或 PostgreSQL JSONB
│   │   │               (如果主要是 JSON 查詢, PG JSONB + GIN index
│   │   │                可能比你想的更強大，且不放棄 ACID)
│   │   │
│   │   └── Q2b: Schema 變動頻率很高嗎？ (快速迭代, prototyping)
│   │       ├── YES ──> MongoDB
│   │       │           (schema-less 讓開發速度最快)
│   │       └── NO ──> 考慮 PostgreSQL JSONB
│   │                   (同時保有 relational 能力以備不時之需)
│   │
│   └── NO ──> continue
│
├── Q3: 你的 workload 是 write-heavy + 超大規模嗎？
│       (IoT telemetry, time-series, activity logs, messaging,
│        > 100K writes/s, multi-region)
│   │
│   ├── YES
│   │   │
│   │   ├── Q3a: 可以接受 eventually consistent 嗎？
│   │   │   ├── YES ──> Cassandra
│   │   │   │           (LSM-tree 寫入最快, leaderless = 無單點故障,
│   │   │   │            線性水平擴展)
│   │   │   └── NO ──> Cassandra with QUORUM read + QUORUM write
│   │   │               (R+W > N = strong consistency, 但犧牲延遲)
│   │   │
│   │   └── Q3b: 查詢模式是否簡單？ (known partition key, no ad-hoc query)
│   │       ├── YES ──> Cassandra
│   │       │           (Cassandra 的 data model 要求你預先知道
│   │       │            所有 query patterns 並據此設計 table)
│   │       └── NO ──> 考慮 MongoDB 或重新評估需求
│   │                   (Cassandra 不適合 ad-hoc queries)
│   │
│   └── NO ──> continue
│
├── Q4: 你需要 zero-ops + key-value/document access pattern 嗎？
│   │
│   ├── YES
│   │   │
│   │   ├── Q4a: 在 AWS 生態系中嗎？
│   │   │   ├── YES ──> DynamoDB
│   │   │   │           (fully managed, single-digit ms latency,
│   │   │   │            auto-scaling, pay-per-use)
│   │   │   └── NO ──> MongoDB Atlas / Cassandra (managed)
│   │   │               或考慮 cloud-specific alternatives
│   │   │
│   │   └── Q4b: 預算敏感嗎？
│   │       ├── YES ──> 注意 DynamoDB on-demand pricing 可能很貴
│   │       │           ($1.25/M writes); 高 throughput 穩定 workload
│   │       │           用 provisioned + reserved capacity 更划算
│   │       └── NO ──> DynamoDB (最省心)
│   │
│   └── NO ──> continue
│
├── Q5: 需要 OLAP / 分析 workload 嗎？
│   │
│   ├── YES ──> 這五個都不是最佳選擇
│   │           考慮: ClickHouse, BigQuery, Redshift, Snowflake
│   │           PostgreSQL 勉強可用 (columnar extensions, parallel query)
│   │           但大規模 OLAP 不是它的主戰場
│   │
│   └── Mixed OLTP + OLAP ──> PostgreSQL
│       (最佳的 hybrid 選擇, 支援 parallel query, partitioning,
│        且可搭配 read replica 分流分析 workload)
│
└── DEFAULT: 不確定 / 通用用途
    ├── 小到中規模 ──> PostgreSQL (最安全的預設選擇)
    │                  ("Nobody ever got fired for choosing PostgreSQL")
    └── 已在 AWS + 需要 serverless ──> DynamoDB
```

### Quick Reference: 絕對規則

| Scenario | Pick | Why |
|----------|------|-----|
| 複雜 relational data + ACID 需求 | **PostgreSQL** | 最完整的 SQL 實作, MVCC, 強大的 type system |
| Read-heavy web app + 最成熟生態系 | **MySQL** | Buffer pool hit ratio 極高, 社群最大 |
| 快速迭代 + schema 常變 + document model | **MongoDB** | 彈性 schema, 開發速度快 |
| Write-heavy 超大規模 + 可接受 eventual consistency | **Cassandra** | LSM-tree 寫入最快, 線性擴展, 永不停機 |
| Zero-ops + key-value/document + AWS | **DynamoDB** | Fully managed, single-digit ms, auto-scale |
| 不確定選什麼 | **PostgreSQL** | 最安全的預設, 幾乎什麼都能做得足夠好 |

---

## 4. Common Pitfalls

1. **「用 MongoDB 存高度 relational 的資料」**
   許多團隊被 MongoDB 的 "flexible schema" 吸引而選用它，但資料本質上是高度 relational 的（多對多關係、需要跨 collection 一致性）。結果是在 application layer 手動實作 JOIN 和 referential integrity，code complexity 遠超直接用 RDBMS。MongoDB 的 `$lookup` (aggregation pipeline JOIN) 效能遠不如 RDBMS 的 native JOIN — 它本質上是 nested loop join，沒有 hash join 或 merge join 優化。如果你的 ER diagram 超過 5 張 tables 且有 foreign key 關係，先考慮 PostgreSQL。

2. **「沒有為 Cassandra 預先設計 partition key」**
   Cassandra 的 data modeling 與 RDBMS 完全相反 — 你必須先知道所有 query patterns，然後根據 query 設計 table (query-first design)。常見錯誤：照 RDBMS 的 normalized schema 建 table，然後發現 Cassandra 不支援 JOIN、不支援任意 WHERE clause (只能查 partition key + clustering column 的前綴)。正確做法是**反正規化 (denormalization)**: 為每個 query pattern 建一張 table，接受資料重複。如果 partition 設計錯誤（partition 太大或 hot partition），修改的代價是整個 table 重建 + 資料遷移。

3. **「PostgreSQL 在 production 不用 connection pooling」**
   PostgreSQL 的 process-per-connection 模型意味著 300+ 直接連線就會造成顯著效能下降。常見場景：Kubernetes 中 50 個 pod，每個 pod 開 10 個 connection = 500 connections 直連 PostgreSQL。CPU 花在 context switching 而非 query execution。解法：部署 PgBouncer (transaction mode) 或 PgCat，將數百個 application connection 複用為 20-50 個實際的 PostgreSQL connection。Aurora PostgreSQL 的 built-in proxy 或 RDS Proxy 也可以解決這個問題。

4. **「DynamoDB 的 Scan 操作拿來做查詢」**
   DynamoDB 的 Scan 是全表掃描，每次最多讀取 1MB 資料，需要 pagination。一張 100GB 的 table 做 Scan 需要 ~100,000 次 API call，消耗大量 RCU 且耗時極久。正確做法是在 schema design 階段就確保所有 access pattern 都能用 Query (指定 partition key) 滿足。如果需要新的 access pattern，新增 GSI 而非 Scan。如果真的需要 full-table analytics，把資料 export 到 S3 + Athena 處理。

5. **「MySQL 大表上直接跑 ALTER TABLE」**
   InnoDB 的許多 ALTER TABLE 操作（加 column、改 column type、加 index）會觸發 table rebuild，在此期間整張 table 被 lock（或長時間持有 metadata lock）。一張 500GB 的 table 做 ALTER TABLE 可能需要數小時，期間所有寫入被 block。解法：使用 gh-ost (GitHub Online Schema Migration) 或 pt-online-schema-change (Percona)。這些工具透過建立 shadow table + trigger/binlog 實現線上 migration。MySQL 8.0 的 Instant DDL 可以秒級加 column (在 table 最後面)，但其他 DDL 操作仍需注意。

6. **「沒有監控 Cassandra 的 tombstone 和 compaction」**
   Cassandra 的 DELETE 不是真正刪除資料，而是寫入一個 tombstone marker。Tombstone 在 `gc_grace_seconds`（預設 10 天）後才會被 compaction 清除。如果你的 workload 有大量 DELETE 或 TTL expiration，tombstone 會快速累積。一個 query 遇到超過 `tombstone_warn_threshold`（預設 1000）個 tombstone 時會 log warning；超過 `tombstone_failure_threshold`（預設 100,000）會直接報錯。常見受害場景：time-series 資料使用 TTL，但 compaction strategy 選擇不當（應該用 Time Window Compaction Strategy, TWCS）。

7. **「MongoDB 選了 monotonically increasing 的 shard key」**
   使用 `_id` (ObjectId, 包含 timestamp) 或 timestamp 作為 shard key，所有新寫入都會集中在同一個 chunk (最大的 shard key range)，只有一個 shard 承受所有寫入壓力。其他 shard 完全閒置。解法：使用 hashed shard key (`{ _id: "hashed" }`) 讓寫入均勻分佈，或設計 compound shard key 將高基數 field 放在前面。代價是 hashed shard key 不支援 range query — 這是 trade-off。

8. **「以為 DynamoDB 的 GSI 是 strongly consistent 的」**
   GSI 與 base table 之間是**異步複製**。寫入 base table 後，GSI 的更新通常在毫秒級完成，但不保證。如果你的業務邏輯依賴 "寫入後立即從 GSI 讀到" 這個假設，就會遇到 stale read。只有 LSI 支援 strongly consistent read（因為 LSI 和 base table 在同一個 partition）。如果需要 consistent secondary access pattern，考慮使用 LSI（但受限於建表時定義 + 10GB partition limit）或在 application layer 加入 retry/verification logic。

---

## 5. Capacity Planning Anchors

### PostgreSQL

| Metric | 數值 | 備註 |
|--------|------|------|
| Simple point query (index hit) | ~50K-100K QPS | 單節點, warm cache, 8-16 cores |
| Write throughput | ~10K-30K TPS | WAL fsync 是瓶頸, NVMe SSD 幫助大 |
| Max table size (practical) | ~1-5TB per table | 超過需 partitioning, vacuum 變慢 |
| Connection overhead | ~5-10MB per connection | process-per-connection model |
| shared_buffers | 25% of RAM | e.g., 64GB RAM → 16GB |
| effective_cache_size | 75% of RAM | 包含 OS page cache |
| WAL generation rate | ~100MB-1GB/s | heavy OLTP workload |
| VACUUM speed | ~10-50 MB/s of dead tuples | autovacuum 需要 CPU + I/O |
| Streaming replication lag | ~0-100ms | async; sync replication 加 1 RTT per commit |

### MySQL (InnoDB)

| Metric | 數值 | 備註 |
|--------|------|------|
| Simple point query (PK lookup) | ~80K-150K QPS | clustered index, buffer pool hit > 99% |
| Write throughput | ~15K-40K TPS | group commit 優化, innodb_flush_log_at_trx_commit=1 |
| Buffer pool size | 70-80% of RAM | e.g., 128GB RAM → 100GB buffer pool |
| Buffer pool hit ratio target | > 99% | 低於此需加 RAM 或 optimize queries |
| Redo log size | 1-2GB per file, 2 files | 容納 1-2 小時的 redo |
| Max row size | ~8KB | half of 16KB page; 超過用 external page |
| Semi-sync replication lag | ~1-5ms | 1 replica ACK; group replication 用 Paxos |
| Online DDL (instant) | < 1 second | MySQL 8.0+ 加 column at end |
| Online DDL (rebuild) | 數小時 for TB-level table | 需 gh-ost / pt-osc |

### MongoDB

| Metric | 數值 | 備註 |
|--------|------|------|
| Single shard reads | ~50K-100K QPS | WiredTiger, working set in cache |
| Single shard writes | ~20K-50K TPS | journal fsync 每 100ms |
| Max document size | 16MB | 超過用 GridFS |
| WiredTiger cache | 50% of (RAM - 1GB) | 預設值; 留空間給 OS cache |
| Oplog window 建議 | 24-72 小時 | secondary 斷線超過此需 full resync |
| Compression ratio (snappy) | ~50-70% | BSON field name 重複被壓縮 |
| Chunk size (sharding) | 128MB (default) | 影響 balancer migration 速度 |
| Replica set failover time | ~10-30 秒 | election timeout + detection |
| Max BSON nesting depth | 100 levels | 實務上不應超過 3-5 levels |

### Cassandra

| Metric | 數值 | 備註 |
|--------|------|------|
| Write throughput per node | ~50K-100K TPS | LSM-tree, sequential I/O |
| Read throughput per node | ~10K-50K QPS | 視 partition size 和 SSTable 數量 |
| Linear scalability | ~1.8-2x per doubling nodes | 實測約 1.8x (非理想 2x, 因 coordination overhead) |
| Max partition size | < 100MB recommended | 超過 compaction + read 效能下降 |
| Max rows per partition | < 100K recommended | 實際 hard limit ~20億 cells per partition |
| Compaction extra disk space | 50% (STCS) / 10% (LCS) | Size-Tiered vs Leveled Compaction |
| Repair cycle | < gc_grace_seconds (10 days) | 逾期 tombstone 可能復活 |
| Bloom filter false positive | ~1% | 每 SSTable 一個 bloom filter |
| Tombstone warn threshold | 1,000 per query | 超過 log warning |
| Tombstone failure threshold | 100,000 per query | 超過直接 fail |
| Gossip protocol 收斂時間 | ~1-3 秒 | cluster state propagation |

### DynamoDB

| Metric | 數值 | 備註 |
|--------|------|------|
| Read latency (eventually consistent) | 1-5ms | single-digit ms guarantee |
| Read latency (strongly consistent) | 2-10ms | 2x RCU, must go to leader |
| Read latency (DAX cache hit) | ~200-500 μs | in-memory, microsecond-level |
| 1 RCU | 1 strongly consistent read/s (≤4KB) | 或 2 eventually consistent reads/s |
| 1 WCU | 1 write/s (≤1KB) | transactional write = 2 WCU |
| Max item size | 400KB | 超過需拆分或存 S3 |
| Single partition limit | 3000 RCU + 1000 WCU + 10GB | hot partition = throttling |
| GSI propagation delay | < 1 second (typical) | 但不保證, eventually consistent |
| BatchGetItem | max 100 items, 16MB | 超過需分批 |
| TransactWriteItems | max 100 items, 4MB | cross-table transaction |
| On-demand burst capacity | 前一個 peak 的 2x | 如果 traffic 突增超過 2x 會 throttle |
| On-demand pricing | $1.25/M WCU, $0.25/M RCU | 比 provisioned 貴 5-7x |
| Reserved capacity discount | 53-76% off provisioned | 1 year or 3 year commitment |
| Max GSI per table | 20 | 每個 GSI 消耗額外 WCU |
| Max LSI per table | 5 | 必須建表時定義 |

---

## 6. OLAP 儲存引擎：ClickHouse / Druid / BigQuery

> OLTP 優化「找到特定幾行」，OLAP 優化「掃描海量行的少數幾個欄位」。
> 這是完全不同的存取模式，需要不同的儲存引擎。

### Row-oriented vs Column-oriented

```
Row-oriented (MySQL, PostgreSQL):
  磁碟排列：[id=1, name="Alice", age=30, region="US"] [id=2, name="Bob", age=25, ...]
  → SELECT SUM(age) 要讀每一整行，大量無關 column 被讀入 = I/O 浪費

Column-oriented (ClickHouse, Parquet):
  磁碟排列：
    id:     [1, 2, 3, 4, 5, ...]
    name:   ["Alice", "Bob", "Carol", ...]
    age:    [30, 25, 28, 35, ...]
    region: ["US", "EU", "US", "AP", ...]
  → SELECT SUM(age) 只讀 age 那一列，跳過所有其他 column
  → 同型別資料連續排列 → 壓縮率極高（10-30x）
```

### ClickHouse 核心特性

| 特性 | 說明 |
|------|------|
| **列式儲存** | 只讀需要的 column，大幅減少 I/O |
| **壓縮率** | 同型別資料連續排列 → LZ4/ZSTD 壓縮 10-30x |
| **向量化執行 (Vectorized Execution)** | 一次處理整個 column batch（用 SIMD 指令），CPU cache 友好 |
| **MergeTree 引擎** | 寫入先到記憶體 buffer → flush 成 sorted part → 背景 merge（類似 LSM-Tree） |
| **寫入速度** | Batch insert 百萬行/秒 |
| **分散式查詢** | 資料 shard 到多節點，查詢平行掃描 |

### MergeTree 寫入與更新機制

```
INSERT batch → Memory Buffer → flush → Disk Part (sorted by primary key)
                                           │
                                    背景非同步 merge
                                           │
                                    Merged Part (更大的 sorted part)

「更新」怎麼做（沒有 in-place UPDATE）：
  1. INSERT 新版本的 row（append-only）
  2. 舊版和新版同時存在於不同 Part
  3. 背景 merge 時，ReplacingMergeTree 保留最新版、丟棄舊版
  4. Merge 完成前查詢可能讀到兩筆 → 用 SELECT ... FINAL 強制去重（較慢）

其他 MergeTree 變體：
  ReplacingMergeTree  → 按 primary key 去重，保留最新版
  SummingMergeTree    → merge 時自動累加數值欄位（適合 counter）
  AggregatingMergeTree → merge 時執行聚合函數（pre-aggregation）
```

### 沒有 ACID 的影響與應對

```
ClickHouse 保證的：
  ✓ 單次 INSERT batch 是原子的（整批成功或整批失敗）
  ✓ 資料寫入就不會丟（有 replication）

ClickHouse 不保證的：
  ✗ 跨表 transaction（INSERT A 成功 + INSERT B 失敗 = 不一致）
  ✗ 即時一致性（merge 完成前可能讀到重複或舊版資料）
  ✗ 隔離性（沒有 MVCC，查詢期間可能看到部分寫入結果）

為什麼 OLAP 場景不怕：
  → 資料來源是 Kafka/Flink pipeline，不是用戶直接操作
  → Pipeline 本身有 exactly-once / 重試機制保證上游正確性
  → 聚合查詢（SUM/COUNT/AVG）對少量重複不敏感
  → 資料不會「丟了就丟了」— Kafka 保留原始 event，重跑 pipeline 即可修復
```

### Sharding 設定

```sql
-- 自動 sharding 仍需指定 shard key：
CREATE TABLE clicks_distributed AS clicks_local
ENGINE = Distributed(
  'my_cluster',
  'default',
  'clicks_local',
  sipHash64(ad_id)    -- ← shard key（你決定）
);

Shard key 選擇原則：
  ad_id      → WHERE ad_id=X 只打一個 shard（推薦：查詢幾乎都帶 ad_id）
  rand()     → 均勻分散，但每次查詢掃全部 shard
  region     → 地區查詢快，但可能不均勻（US 資料遠多於其他）
```

### ClickHouse 不適合的場景

| 場景 | 原因 |
|------|------|
| 單行 point lookup（WHERE id = 123） | 列式儲存要讀多個 column file 組出一行，不如 row-oriented |
| 高頻小量更新 | 沒有原地 UPDATE，要靠非同步 mutation 重寫 part |
| ACID Transaction | 無跨表 transaction |
| 高並發短查詢（數千 QPS 小查詢） | 設計給少量大查詢，不是高並發 OLTP |

### OLAP 選型比較

| | ClickHouse | Apache Druid | BigQuery / Redshift |
|--|-----------|-------------|-------------------|
| **部署** | 自建 / ClickHouse Cloud | 自建 | 全託管 (Serverless) |
| **寫入** | Batch insert 極快 | 原生 Kafka ingestion | Batch 或 streaming insert |
| **查詢延遲** | 亞秒~秒 | **亞秒**（預聚合 + bitmap index） | 秒~分鐘 |
| **預聚合** | Materialized View | **原生 roll-up ingestion** | Partition + clustering |
| **SQL 支援** | 完整 | 有限（Druid SQL → 轉原生查詢） | 完整標準 SQL |
| **成本** | 基礎設施（便宜） | 基礎設施（叢集複雜） | **按掃描量計費** |
| **適合** | 即時 dashboard、log analytics | 超低延遲 slice-and-dice | Ad-hoc 分析、不想維運 |
| **維運** | 中 | 高（多種節點角色） | **零** |

### OLAP Capacity Planning

| Metric (ClickHouse) | 數值 | 備註 |
|---------------------|------|------|
| Batch insert throughput | 百萬行/秒 | 取決於 column 數和大小 |
| 壓縮率 | 10-30x | LZ4 預設；ZSTD 更高但 CPU 開銷大 |
| 單節點掃描速度 | ~1-2 GB/s (compressed) | 受磁碟和 CPU 限制 |
| 查詢並發 | ~50-100 concurrent | 大查詢吃 CPU，不適合高並發小查詢 |
| 寫入到可查詢延遲 | ~1 秒 | Buffer flush interval |
| Merge 背景開銷 | ~10-30% CPU | 持續進行，需要預留資源 |
| 單節點儲存建議 | < 10TB (compressed) | 超過建議 sharding |
| Replication factor | 通常 2-3 | 用 ReplicatedMergeTree |

### OLAP 決策樹

```
需要分析/聚合查詢？
├── 資料量 < 100GB，查詢不頻繁
│   └── PostgreSQL 就夠了（columnar extension 或 parallel query）
│
├── 即時 dashboard + 自己維運
│   ├── 需要亞秒 slice-and-dice → Druid
│   └── 通用分析 + SQL → ClickHouse（首選）
│
├── 不想維運
│   └── BigQuery (GCP) / Redshift (AWS) / Snowflake (multi-cloud)
│
└── 同時需要 OLTP + OLAP
    ├── 小規模 → PostgreSQL (read replica 分流)
    └── 大規模 → OLTP DB + CDC → ClickHouse（HTAP 分離架構）
```

---

## 7. 跨題通用心智模型：Precompute on Write、State vs Event、OLAP 觸發

> 這一節整理 system design 裡最常重複出現的三個核心觀念。Instagram / WhatsApp / Ticketmaster / Payment 幾乎每一題都會用到，先在此抽象化，回到單題時就是「套公式」。

### 7.1 原則：Precompute on Write（把運算從讀路徑搬到寫路徑）

**適用條件**：讀流量 >> 寫流量（10:1 以上）。

核心邏輯：讀便宜 = 多付一點寫代價也划算。社交 / feed / e-commerce 幾乎都是 read-heavy，這條原則反覆出現。

#### Precompute on Write 家族

| Pattern | 在寫路徑做什麼 | 讀路徑變成 | 典型場景 |
|---------|---------------|-----------|---------|
| **Fan-out on write** | 把一份資料複製到 N 個 inbox | 讀自己的 inbox = O(1) | Twitter / IG feed、通知系統 |
| **Materialized aggregate** | 更新一個彙總值 (INCR / UPDATE) | 讀彙總欄位 = O(1) | like_count、follower_count、comment_count |
| **Denormalization** | 把 JOIN 結果先展平存 | 讀不用 JOIN | MongoDB 嵌入子文件、Cassandra wide row |
| **Materialized view** | 把複雜 query 結果 precompute 成表 | 讀預算好的結果 | PostgreSQL MATERIALIZED VIEW、ClickHouse AggregatingMergeTree |
| **Secondary / Inverted index** | 寫時同步維護反向索引 | 按不同 key 查 O(log n) / O(1) | DB 的 secondary index、Elasticsearch |
| **Cache warming** | 寫入時順便寫 cache | 讀打 cache 不打 DB | Write-through / write-behind cache |

#### Fan-out on write vs Materialized aggregate 的關鍵差別（容易搞混）

| | Fan-out on write | Materialized aggregate |
|---|------------------|------------------------|
| **問題本質** | 資料**擴散** (1 → N) | 資料**壓縮** (N → 1) |
| **寫成本** | **O(N)** — 名人發文推 100M followers 很貴 | **O(1)** — 改一個 counter |
| **典型場景** | Feed 推送、notification 分發 | Counter、leaderboard、小 summary |
| **瓶頸** | 名人 fan-out amplification（需要 fan-out on read 混合） | Hot-row contention（需要 Redis counter 做 shard） |

### 7.2 State vs Event：同一份資訊可以同時存兩份

設計任何寫 path 時，先拆開「當前狀態」和「事件歷史」兩個角色——它們存的是不同語意、用不同儲存、服務不同 query。

```
         User action (e.g., click like)
                    │
                    ↓
                 Kafka  ← single source of event
                    │
         ┌──────────┼──────────────┐
         ↓          ↓              ↓
      OLTP        OLAP          Cache
    (State)     (Event Log)   (加速層)
         │          │              │
    現在是什麼？  發生過什麼？   常查的熱資料
    dedup/UPDATE  全量 append     Redis
    point lookup  batch aggregate
```

| 維度 | State 表 | Event log 表 |
|------|---------|-------------|
| **語意** | 當前事實（誰現在 like 了什麼） | 歷史事件（所有動作紀錄） |
| **寫入** | INSERT / UPDATE / DELETE | **永遠 append**（unlike 也是一筆 `action=unlike` event） |
| **主要 query** | Point lookup、單筆 UPDATE | Full scan、GROUP BY、跨時間聚合 |
| **儲存** | **OLTP** (MySQL / Cassandra / DynamoDB) | **OLAP** (BigQuery / ClickHouse / S3 Parquet) |
| **Latency** | <10ms | 秒~分鐘 |
| **使用者** | 線上 API（終端 user） | 內部 team、ML、BI dashboard |
| **例子** | `likes`, `orders`, `accounts`, `inventory` | `interaction_log`, `audit_log`, `event_store`, `metrics` |

#### 同一個「like」動作的 dual storage

| 資料 | 存哪 | 回答的 query |
|------|------|-------------|
| `likes(post_id, user_id, ts)` | OLTP MySQL/Cassandra | 「User X 有沒有 like post Y？」「列出 post Y 最新 50 個 likers」 |
| `interaction_log(user_id, post_id, action, tag, ts)` | OLAP BigQuery | 「過去 90 天 user X 互動過哪些 tag？」「trending posts 計算」 |
| `post_likes:{post_id}` counter | Redis | 「post Y 現在有幾 like」(高 QPS read) |
| `posts.like_count` | OLTP (materialized aggregate) | Redis miss fallback、持久化彙總 |

**選儲存的鐵則：看 dominant query pattern，不看資料形狀。** append-only 不代表要用 OLAP；millions of rows 不代表要用 OLAP。要看**每次 query 觸碰幾 row + latency 要求**。

### 7.3 OLTP vs OLAP 判斷 checklist（7 題）

遇到「這張表放哪？」的設計問題時，依序問：

| # | 問題 | OLTP | OLAP |
|---|------|------|------|
| 1 | Dominant query 觸碰幾 row？ | 1 ~ 幾百 (by index) | 百萬 ~ 數十億 |
| 2 | Latency 要求？ | <100ms | 秒 ~ 分鐘 OK |
| 3 | 寫入 pattern？ | 高 QPS single-row | Batch (萬筆起) |
| 4 | 是否需要 point lookup (by PK)？ | **需要（且高頻）** | 幾乎沒有 |
| 5 | 是否需要 DELETE/UPDATE 單筆？ | **需要** | 不需要（append-only） |
| 6 | 是否需要 transaction？ | 需要 | 不需要（eventually consistent） |
| 7 | 查詢 QPS？ | 高（每次 user action） | 低（分析師 / cron / dashboard） |

**決策法則：7 題超過 4 題偏 OLTP 答案 → 放 OLTP。剩下的 analytics 需求用 CDC → OLAP。**

### 7.4 什麼時候要想到 OLAP？（最常遺漏的 6 個場景）

大多數 system design 題的線上服務路徑不需要 OLAP，但**面試時提一句「analytics 走 CDC → warehouse」是 senior 訊號**。

| # | 場景 | 例子 | 典型技術 |
|---|------|------|---------|
| 1 | **BI Dashboard / 產品指標** | MAU, DAU, retention, conversion funnel | BigQuery + Looker/Tableau |
| 2 | **ML Feature Pipeline** | User interest vector 每日重算、embedding 訓練 | Spark / BigQuery → Feature Store |
| 3 | **Ad-hoc 探索性分析** | 「上週 DAU 為什麼掉 5%？」「哪些 feature 影響留存？」 | BigQuery / Snowflake + SQL |
| 4 | **Batch 排名 / Trending 計算** | Top 100 posts this week、trending hashtags、viral detection | Hive / Spark 每小時跑 |
| 5 | **Compliance / Reporting** | 每日財報、監管 audit、稅務報告 | Snowflake / Redshift |
| 6 | **Cold Data Archive** | 5 年前的訂單歸檔、歷史 log 查詢 | S3 Parquet + Athena |

**OLAP 觸發訊號（任一符合就要考慮）：**
- 要掃 million+ rows 做 GROUP BY / SUM / AVG
- Latency 可容忍秒級以上
- Read QPS 低（分析師 / dashboard / cron）
- Query 是 ad-hoc 探索性（不能預建 index）
- 終端使用者是內部 team / ML pipeline（不是 C-end user）

### 7.5 真實系統的 Dual Architecture（每個成熟系統都有）

```
┌────────────────────────────────────────────────────────────────────┐
│  ONLINE WORLD  (OLTP + cache + search)                             │
│  ──────────────────────────────────────────────────                │
│  MySQL / Cassandra / DynamoDB  +  Redis  +  Elasticsearch          │
│  服務 end user、ms latency、high QPS                                │
│  📌 大部分 system design 題主要討論這一層                            │
└───────────────────────────┬────────────────────────────────────────┘
                            │ CDC (Debezium) / Kafka event stream
                            ↓
┌────────────────────────────────────────────────────────────────────┐
│  OFFLINE WORLD  (OLAP + data lake + feature store)                 │
│  ──────────────────────────────────────────────────                │
│  BigQuery / Snowflake / ClickHouse  +  S3 Parquet  +  Feast        │
│  服務內部 team + ML + BI、秒~分鐘 latency、low QPS                  │
│  📌 面試時主動提這一層 → senior architect 訊號                       │
└────────────────────────────────────────────────────────────────────┘
```

### 7.6 一頁總結（套路化檢查清單）

設計任何 read-heavy 系統時，依序檢查：

1. **Read:Write ratio > 10:1 嗎？** → 考慮 Precompute on Write 家族
2. **某個欄位是聚合值（count / sum）嗎？** → Materialized aggregate（Redis counter + 週期 flush）
3. **一份資料要給多個 user 即時看嗎？** → Fan-out on write（或混合 fan-out on read 處理名人）
4. **寫入會集中在少數 hot row 嗎？** → Redis 吸收爭用，避免 DB row lock
5. **同一份事件有沒有 analytics 需求？** → CDC → OLAP，線上 OLTP 不動
6. **每個 query 掃幾 row？** → <1000 用 OLTP、million+ 用 OLAP（看 dominant query）
7. **這張表是 state 還是 event？** → State 用 OLTP、event log 用 OLAP（可並存）

> **記憶口訣：寫路徑多付代價、讀路徑白吃；State 和 Event 是雙胞胎、各住各家；選儲存看 query 不看資料形狀。**
