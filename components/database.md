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
