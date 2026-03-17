# Cache: Redis vs Memcached

## 1. Comprehensive Comparison Matrix

| Dimension | Redis | Memcached |
|-----------|-------|-----------|
| **Data Structures** | String, Hash, List, Set, Sorted Set, Stream, HyperLogLog, Bitmap, Geospatial | **僅 String (key-value blob)** |
| **Persistence** | RDB snapshots, AOF log, RDB+AOF hybrid | **無** (純 cache，by design) |
| **Replication** | Async primary-replica；Sentinel (HA) / Cluster (sharding) | **無** (client-side 分散) |
| **Clustering** | Redis Cluster：16384 hash slots，自動 resharding | Client-side consistent hashing；server 之間互不通訊 |
| **Memory Management** | jemalloc；per-key overhead ~90 bytes (dict entry + SDS + robj) | **Slab allocator**：預分配 slab classes，chunk 對齊，內部碎片化 |
| **Threading Model** | **單執行緒** event loop 處理命令 (6.0+ I/O threads 僅用於 network read/write) | **多執行緒**：worker threads 平行處理請求 |
| **Throughput** | ~100K-200K ops/s (single thread, pipeline 可達 1M+) | ~200K-700K ops/s (multi-thread，simple GET/SET) |
| **Latency (p99)** | < 1 ms (intra-DC) | < 1 ms (intra-DC)；simple ops 可更低 |
| **Max Value Size** | 512 MB (per key) | **1 MB** (default, 可調至更高但不建議) |
| **Eviction Policies** | noeviction, allkeys-lru, volatile-lru, allkeys-lfu, volatile-lfu, allkeys-random, volatile-random, volatile-ttl | **LRU only** (per slab class) |
| **Pub/Sub** | 支援 (Pub/Sub + Streams consumer groups) | **不支援** |
| **Lua Scripting** | 支援 (atomic execution, EVAL / EVALSHA) | **不支援** |
| **Transactions** | MULTI/EXEC (optimistic locking with WATCH) | **CAS** (Compare-And-Swap) |
| **Operational Complexity** | 中~高 (Sentinel/Cluster topology, persistence tuning, memory fragmentation) | **低** (stateless server, client 負責分散) |

---

## 2. Underlying Implementation Differences

### Redis: Single-Threaded Event Loop + Rich Data Structures

```
Client A ──┐
Client B ──┤──> [epoll/kqueue event loop] ──> 單執行緒依序處理命令
Client C ──┘         │
                     ├── 讀取命令 → 執行命令 → 回傳結果
                     └── 所有操作都在 memory，無 disk I/O blocking
```

**為什麼單執行緒仍然快？**

Redis 的設計哲學是：瓶頸不在 CPU，而在 **network I/O 和 memory access**。單執行緒帶來三個關鍵優勢：

1. **零 lock contention**：所有資料結構操作不需要鎖，沒有 mutex 競爭、沒有 context switch 開銷。在 multi-threaded cache 中，每次存取共享資料都需要加鎖，當 core 數增加時 lock contention 反而成為瓶頸。
2. **epoll/kqueue multiplexing**：一個執行緒透過 I/O multiplexing 同時監聽數萬個 socket，避免 thread-per-connection 的記憶體開銷。
3. **純 in-memory 操作**：每個命令的執行時間通常在微秒級別。CPU 不是瓶頸 — 一個 core 跑完一個命令只需要幾百奈秒到幾微秒。

Redis 6.0 引入的 **I/O threads** 僅用於 network read/write 的並行化（parsing request、writing response），命令執行仍然是單執行緒。這解決了高連線數場景下 network I/O 成為瓶頸的問題。

#### Data Structures 與使用場景

| Data Structure | 底層實作 | 適用場景 |
|----------------|---------|---------|
| **String** | SDS (Simple Dynamic String) | 快取整個物件 (JSON)、計數器 (`INCR`)、distributed lock (`SET NX EX`) |
| **Hash** | ziplist (小) / hashtable (大) | 儲存物件欄位（User profile 的 name, email, age），比 String 存 JSON 省記憶體且支援部分更新 |
| **List** | quicklist (ziplist 組成的 linked list) | 訊息佇列 (`LPUSH` + `BRPOP`)、最新 N 筆記錄、timeline feed |
| **Set** | intset (純整數小集合) / hashtable | 標籤系統、共同好友 (`SINTER`)、去重、隨機抽樣 (`SRANDMEMBER`) |
| **Sorted Set** | ziplist (小) / skiplist + hashtable | 排行榜 (`ZADD` + `ZRANGE`)、延遲佇列 (score = timestamp)、rate limiter sliding window |
| **Stream** | radix tree + listpack | 事件日誌、consumer group 消費模式（類似輕量 Kafka） |
| **HyperLogLog** | 稀疏/密集編碼，固定 12 KB | 基數估計：UV 統計（10 億個元素，誤差率 ~0.81%，只用 12 KB） |
| **Bitmap** | String 的 bit 操作 | 使用者簽到、線上狀態、布隆過濾器 (搭配 RedisBloom module) |
| **Geospatial** | Sorted Set (score = geohash) | 附近的人/店家查詢 (`GEORADIUS`)、距離計算 |

#### Persistence 機制

Redis 提供三種持久化策略，各有不同的 trade-off：

```
              寫入速度    資料完整性    恢復速度    磁碟空間
RDB Snapshot:  最快       可能遺失數分鐘  最快       最小
AOF Log:       較慢       可達每秒/每筆   較慢       最大
RDB + AOF:     中等       兼顧兩者       較快       中等
```

**RDB (Redis Database Snapshot)**

Redis 定期將整個記憶體資料集 dump 為一個二進位檔案（`.rdb`）。觸發條件可設定為 `save 900 1`（900 秒內有 1 次修改就觸發）。

關鍵機制是 **`fork()` system call**：

```
主程序                         子程序
  │                              │
  ├── fork() ──────────────────> │ (Copy-on-Write)
  │                              │
  │  繼續處理客戶端命令           │  遍歷記憶體，寫入 .rdb 檔案
  │  修改的 page 會被 COW 複製    │  讀取的是 fork 瞬間的 snapshot
  │                              │
  │                              └── 完成，通知主程序
```

**`fork()` 的 latency spike 問題**：`fork()` 本身需要複製 page table。當 Redis 使用 25 GB 記憶體時，page table 約 50 MB (假設 4 KB page)，複製耗時可達 **數十毫秒到數百毫秒**。在這段時間內，Redis 主執行緒被阻塞，所有客戶端請求都會 hang。此外，如果 fork 後主程序大量寫入，Copy-on-Write 會觸發實際的記憶體複製，導致 RSS 短暫膨脹至接近 2 倍。

**實務建議**：生產環境若使用 RDB，將 `fork()` 排程在低流量時段；或在 replica 上執行 RDB dump，避免影響 primary。

**AOF (Append Only File)**

每個寫入命令以 RESP 協議格式 append 到檔案尾端。`appendfsync` 設定控制刷盤頻率：

- `always`：每筆命令都 `fsync()`，最安全但效能最差（每秒數百 ops）
- `everysec`：每秒 `fsync()` 一次，**推薦設定**，最多遺失 1 秒資料
- `no`：由 OS 決定何時刷盤，效能最好但可能遺失數十秒資料

AOF 檔案會持續增長，Redis 透過 **AOF rewrite**（背景 `fork()` 重寫精簡版 AOF）來壓縮。

**RDB + AOF Hybrid (Redis 4.0+)**

AOF rewrite 時，先寫入 RDB 格式的 snapshot，後續增量部分用 AOF 格式。結合了 RDB 的快速載入和 AOF 的資料完整性。**這是目前生產環境的推薦配置。**

#### Replication 與高可用

**Async Primary-Replica Replication**

```
Primary ──async──> Replica 1
    │               │
    │          (非同步複製，有 replication lag)
    │
    └──async──> Replica 2
```

Replica 連線到 Primary 後，Primary 執行 `BGSAVE` 產生 RDB 發送給 Replica，之後持續傳送增量命令。**非同步複製意味著 Primary 故障時可能遺失尚未複製的寫入。** 可透過 `WAIT` 命令實現半同步（等待 N 個 replica 確認），但這會增加寫入延遲。

**Redis Sentinel vs Redis Cluster**

| | Redis Sentinel | Redis Cluster |
|--|----------------|---------------|
| **目的** | 高可用 (HA) — 自動 failover | 高可用 + 水平擴展 (sharding) |
| **資料分佈** | 每個 node 持有完整資料 | 資料分散在 16384 個 hash slots |
| **擴展瓶頸** | 單機記憶體上限 | 可線性擴展至數百 TB |
| **Failover** | Sentinel 投票選出新 Primary | Cluster nodes 互相偵測，自動 failover |
| **Client 複雜度** | 需要 Sentinel-aware client | 需要 Cluster-aware client (MOVED/ASK redirect) |

**Redis Cluster 深入**

Redis Cluster 將 key space 分成 **16384 個 hash slots**。每個 key 透過 `CRC16(key) % 16384` 決定歸屬的 slot，每個 master node 負責一部分 slots。

```
Node A: slots 0-5460      (+ Replica A')
Node B: slots 5461-10922  (+ Replica B')
Node C: slots 10923-16383 (+ Replica C')
```

**Multi-key 操作限制**：`MGET key1 key2` 只有在 key1 和 key2 落在同一個 slot 時才能執行。跨 slot 的 multi-key 操作會回傳 `CROSSSLOT` 錯誤。解法是使用 **hash tags**：`{user:1000}.profile` 和 `{user:1000}.session` 會被 hash 到同一個 slot（只計算 `{}` 內的部分）。

**Resharding** 是線上操作：將 slot 從一個 node 搬移到另一個 node，過程中透過 `ASK` redirect 確保遷移中的 key 仍可存取。但遷移期間 latency 會略為上升。

---

### Memcached: Multi-Threaded Simplicity

```
Client ──> [Worker Thread 1] ──> Slab Allocator ──> Memory
Client ──> [Worker Thread 2] ──>      │
Client ──> [Worker Thread 3] ──>      │
Client ──> [Worker Thread 4] ──>   (global hash table + fine-grained locking)
```

**多執行緒架構**

Memcached 使用 **libevent** 搭配多個 worker threads。主執行緒負責 accept 新連線，然後透過 round-robin 分配給 worker threads。每個 worker thread 有自己的 event loop。對於 simple GET/SET，多執行緒使 Memcached 能更好地利用多核 CPU — 在高吞吐場景下，Memcached 的 raw throughput 可以顯著超過單執行緒 Redis。

**Slab Allocator 機制**

Memcached 不使用 `malloc()`/`free()` 管理記憶體（避免碎片化），而是採用 **slab allocation**：

```
Slab Class 1:  chunk size = 96 bytes    ──> [chunk][chunk][chunk]... (1 MB slab page)
Slab Class 2:  chunk size = 120 bytes   ──> [chunk][chunk][chunk]...
Slab Class 3:  chunk size = 152 bytes   ──> [chunk][chunk][chunk]...
...
Slab Class 42: chunk size = 1 MB        ──> [chunk]
                                              │
每個 class 的 chunk size 以 factor (default 1.25x) 遞增
```

儲存一個 item 時，Memcached 選擇 **最小的能容納該 item 的 slab class**。例如一個 100 bytes 的 item 會放進 120 bytes 的 chunk，**浪費 20 bytes（內部碎片化）**。

**Slab allocator 的陷阱**：

- **Slab calcification**：如果早期大量寫入小 item 占滿了小 chunk 的 slab pages，之後寫入大 item 時即使總記憶體充足也可能分配不到空間（因為 slab pages 已被小 chunk class 佔用）。`slab_reassign` 和 `slab_automove` 設定可以緩解但無法完全解決。
- **Internal fragmentation**：value 大小分佈不均時，平均浪費可達 10-15% 記憶體。

**Client-Side Consistent Hashing**

Memcached server 之間不通訊。所有的分散邏輯由 client library 負責：

```
Key "user:1000" ──> client 計算 hash ──> 對應到 Server B
                    (consistent hashing ring / ketama)
```

這意味著：
- **新增/移除 server**：consistent hashing 確保只有 ~1/N 的 key 被重新映射（而非全部 rehash）。
- **沒有自動 failover**：一台 server 掛掉，那些 key 就消失了。client 可以做 fallback（例如去 DB 撈），但 Memcached 本身不做任何 replication。
- **不同 client library 必須用相同的 hashing 演算法**，否則同一個 key 會被路由到不同 server。

**CAS (Compare-And-Swap)**

Memcached 透過 CAS token 解決 concurrent update 問題：

```
1. Client A: gets key → value="v1", cas_token=100
2. Client B: gets key → value="v1", cas_token=100
3. Client A: cas key "v2" 100 → SUCCESS (token matches, update + new token=101)
4. Client B: cas key "v3" 100 → FAIL (token mismatch, 100 ≠ 101)
```

這是 Memcached 唯一的 concurrency control 機制。相較 Redis 的 `WATCH` + `MULTI/EXEC` (optimistic locking) 或 Lua scripting (atomic execution)，功能更簡單但也更輕量。

---

## 3. Caching Strategies

### Cache-Aside (Lazy Loading)

最常見的 caching pattern。應用程式完全控制 cache 的讀寫。

```
[Application]                    [Cache]              [Database]
     │                              │                      │
     ├── 1. GET key ──────────────> │                      │
     │ <── 2a. Cache HIT (return) ──│                      │
     │                              │                      │
     │ <── 2b. Cache MISS ─────────>│                      │
     ├── 3. Query DB ──────────────────────────────────────>│
     │ <── 4. Return data ─────────────────────────────────│
     ├── 5. SET key (with TTL) ───> │                      │
     │ <── 6. Return data to caller │                      │
```

**優點**：
- 只快取實際被請求的資料（不浪費記憶體在冷資料上）
- Cache 故障時，應用程式仍可直接讀 DB（降級而非掛掉）
- 實作最簡單，對 cache 和 DB 無侵入

**缺點**：
- **Cache miss penalty**：第一次請求必然 miss，需要承受 DB 查詢延遲
- **Stale data**：DB 被更新後，cache 中的舊資料直到 TTL 過期才會更新。常見的緩解策略是寫入 DB 時同時 **invalidate cache**（`DEL key`），下次讀取會重新載入

**適用場景**：讀多寫少的應用、不要求強一致性的場景（使用者 profile、商品資訊、設定資料）

---

### Write-Through

寫入時同步更新 cache 和 DB，確保 cache 永遠是最新的。

```
[Application]              [Cache]              [Database]
     │                        │                      │
     ├── 1. Write data ─────> │                      │
     │                        ├── 2. Write to DB ───>│
     │                        │ <── 3. DB ACK ───────│
     │                        ├── 4. Update cache    │
     │ <── 5. ACK ───────────│                      │
```

**優點**：
- Cache 與 DB 始終一致（在沒有 race condition 的前提下）
- 讀取永遠是 cache hit（資料在寫入時就已進入 cache）

**缺點**：
- **寫入延遲增加**：每次寫入都要等 cache + DB 兩者都完成
- **Cache 污染**：可能寫入大量永遠不會被讀取的資料到 cache
- **實作複雜度**：需要確保 cache 寫入和 DB 寫入的原子性（或至少一致性）。若 DB 寫入成功但 cache 寫入失敗，會導致不一致

**適用場景**：讀寫頻率接近、對資料一致性要求高、可以容忍較高寫入延遲的場景

---

### Write-Behind / Write-Back

寫入只進 cache，由 cache 層非同步批次刷回 DB。

```
[Application]              [Cache]                      [Database]
     │                        │                              │
     ├── 1. Write data ─────> │                              │
     │ <── 2. ACK (立即回傳) ──│                              │
     │                        │                              │
     │                        ├── 3. 非同步 batch flush ──────>│
     │                        │    (每 N 秒或每 N 筆)         │
     │                        │ <── 4. DB ACK ───────────────│
```

**優點**：
- **寫入延遲極低**（只寫 cache，microseconds 級別）
- **批次合併寫入**：同一個 key 被更新 10 次，只需要刷回 DB 一次（最終值），大幅降低 DB 壓力
- 適合 write-heavy workload

**缺點**：
- **資料遺失風險**：cache 故障時，尚未 flush 到 DB 的資料會遺失。這是最大的 trade-off
- **最終一致性**：DB 中的資料有延遲
- **實作複雜**：需要可靠的 flush 機制、retry logic、failure handling

**適用場景**：寫入密集且可容忍少量資料遺失（view count、like count）、或有其他機制可補償遺失（event sourcing replay）

---

### Read-Through

Cache 層自己負責在 miss 時去 DB 載入資料，應用程式只跟 cache 互動。

```
[Application]              [Cache Layer / Proxy]         [Database]
     │                              │                        │
     ├── 1. GET key ──────────────> │                        │
     │                              ├── (if miss) ──────────>│
     │                              │ <── 2. Return data ────│
     │                              ├── 3. Store in cache    │
     │ <── 4. Return data ─────────│                        │
```

**與 Cache-Aside 的差異**：Cache-Aside 中，application 自己去查 DB 並寫回 cache。Read-Through 中，application 不知道 DB 的存在 — cache 層是唯一的資料介面。

**優點**：
- 應用程式代碼更乾淨（只與 cache 互動，不關心資料來源）
- Cache 層可以統一處理 miss logic、serialization、compression

**缺點**：
- Cache 層必須知道如何存取 DB（增加 cache 的複雜度）
- 通常需要專門的框架或中介層（如 NCache、Apache Ignite）

**適用場景**：大型系統中，cache 作為獨立的資料存取層；搭配 Write-Through 使用效果最佳

---

### Cache Eviction Policies

| Policy | 機制 | 適用場景 |
|--------|------|---------|
| **LRU (Least Recently Used)** | 淘汰最久沒被存取的 key | **通用預設**。大多數 workload 都有 temporal locality（最近存取的資料很可能再次被存取） |
| **LFU (Least Frequently Used)** | 淘汰存取頻率最低的 key（Redis 用 Morris counter 近似計算） | 存取模式穩定的場景。避免 LRU 被 scan 操作汙染（一次性大量讀取冷資料把熱資料擠出去） |
| **TTL (Time-To-Live)** | key 設定過期時間，到期自動刪除 | 資料有明確時效性（session、token、rate limit counter）；搭配 LRU/LFU 一起使用 |
| **Random** | 隨機淘汰 | 所有 key 存取機率均等（罕見）；或測試用 |

**Redis 的 LRU 實作**：Redis 不是真正的 LRU（全局 LRU 需要對所有 key 維護 linked list，記憶體開銷太大）。Redis 使用 **近似 LRU**：隨機取樣 N 個 key（`maxmemory-samples`，預設 5），淘汰其中最舊的。樣本數越大越接近真正 LRU，但 CPU 開銷越高。預設值 5 在實測中已足夠接近。

**Redis 4.0+ 的 LFU**：使用 **Morris counter**（概率計數器）在每個 key 上維護存取頻率近似值，僅用 8 bits 就能表示很大的計數。還搭配 decay factor 讓舊的存取逐漸降權。

---

## 4. Architect's Decision Tree

```
START: "我需要 caching 層"
│
├── Q1: 你需要的只是 simple key-value GET/SET，且 value 是 opaque blob？
│   ├── YES ──> Q1a: 吞吐量需求 > 500K ops/s，且有足夠多核 CPU？
│   │   ├── YES ──> Memcached
│   │   │          (multi-threaded, 在 simple GET/SET 場景下 throughput 更高)
│   │   └── NO ──> Redis (功能更多，同等場景下效能也足夠)
│   └── NO ──> continue
│
├── Q2: 你需要 rich data structures？
│       (Sorted Set 做排行榜、HyperLogLog 做 UV 統計、Stream 做事件佇列)
│   ├── YES ──> Redis
│   │          (Memcached 只有 String，無法做到)
│   └── NO ──> continue
│
├── Q3: 你需要 cache 資料的持久化？（重啟後不丟資料）
│   ├── YES ──> Redis (RDB/AOF/Hybrid)
│   │          (Memcached 重啟 = 所有資料歸零)
│   └── NO ──> continue
│
├── Q4: 你需要 Pub/Sub 或 message broker 功能？
│   ├── YES ──> Redis (Pub/Sub + Streams)
│   └── NO ──> continue
│
├── Q5: 你需要 atomic operations 超越 simple CAS？
│       (Lua scripting, MULTI/EXEC transactions)
│   ├── YES ──> Redis
│   └── NO ──> continue
│
├── Q6: 你的團隊已經在用 Memcached 且運作良好？
│   ├── YES ──> 繼續用 Memcached
│   │          (遷移成本通常不值得，除非遇到上述需求)
│   └── NO ──> 預設選 Redis (功能超集，社群更活躍，生態系更豐富)
│
└── Q0: 你真的需要 cache 嗎？
    ├── Database 本身夠快 (< 10ms, QPS < 1000) ──> 不需要
    ├── 資料變動頻繁且需要強一致性 ──> Cache 帶來的一致性複雜度可能不值得
    └── 讀取模式高度隨機且無熱點 ──> Cache hit rate 會很低，效益有限
```

### Quick Reference: Absolute Rules

| Scenario | Pick | Why |
|----------|------|-----|
| Simple session store / object cache | **Redis** | 功能超集，TTL + persistence + replication |
| 排行榜 / 計分板 | **Redis** | Sorted Set 原生支援，O(log N) 插入與排名查詢 |
| Rate limiter (sliding window) | **Redis** | Sorted Set + Lua scripting 實現精確 sliding window |
| Distributed lock | **Redis** | `SET NX EX` + Redlock algorithm |
| Pure GET/SET cache, 極致 throughput | **Memcached** | Multi-threaded，多核利用率更高 |
| Legacy 系統已用 Memcached 且只需 simple cache | **Memcached** | 沒有遷移的理由 |
| 需要 message queue 但不想引入 Kafka/RabbitMQ | **Redis Streams** | Consumer group, ACK, 持久化，適合中等規模 |
| 完全不需要持久化，團隊熟 Memcached | **Memcached** | 更簡單、更少攻擊面 |

---

## 5. Common Pitfalls

### 1. Cache Stampede / Thundering Herd

**問題**：一個 hot key 過期的瞬間，大量並發請求同時 cache miss，全部衝向 DB 查詢同一筆資料，導致 DB 瞬間過載。

```
TTL expires ──> 1000 concurrent requests ──> all miss ──> 1000 DB queries (同一筆資料)
```

**解法**：

- **Mutex lock (分散式鎖)**：第一個 miss 的請求取得 lock，去 DB 查詢並寫回 cache，其他請求等待或 retry。Redis 的 `SET key lock_value NX EX 5` 可以實現。
  ```
  if cache.get(key) == null:
      if cache.set("lock:" + key, 1, NX, EX=5):   // 取得鎖
          value = db.query(key)
          cache.set(key, value, EX=3600)
          cache.del("lock:" + key)
      else:
          sleep(50ms)  // 等待鎖釋放
          retry
  ```
- **Stale-while-revalidate**：cache 中的 value 附帶一個 soft TTL。soft TTL 過期後仍可回傳舊值（stale），但觸發一個背景執行緒去更新。硬 TTL 設定為 soft TTL 的 2-3 倍。
- **提前隨機重整 (Probabilistic early expiration)**：在 TTL 到期前，每次存取根據剩餘時間計算一個概率決定是否提前重新載入。距離過期越近，概率越高。避免所有請求在同一瞬間 stampede。

---

### 2. Cache Penetration

**問題**：大量請求查詢 **DB 中也不存在** 的 key（例如惡意攻擊用不存在的 ID 查詢）。每次都 cache miss → 查 DB → DB 也沒有 → 不寫 cache → 下次還是 miss。Cache 形同虛設。

```
GET user:99999999 ──> cache miss ──> DB miss ──> 不快取 ──> 無限循環
```

**解法**：

- **快取空值 (Cache null/empty)**：DB 查不到也把結果寫入 cache（`SET user:99999999 NULL EX 60`），設較短 TTL。簡單有效，但如果攻擊者用大量不同的 key，cache 會被灌滿垃圾。
- **Bloom Filter**：在 cache 前面加一層 Bloom Filter，存放所有合法 key 的集合。請求先查 Bloom Filter，不存在則直接返回，連 cache 都不查。Redis 的 `RedisBloom` module 可以直接用 `BF.EXISTS`。空間效率極高：1% 誤判率約需 10 bits per element。
- **請求層防護**：在 API gateway 層驗證 ID 格式、範圍，擋掉明顯非法的查詢。

---

### 3. Cache Avalanche

**問題**：大量 key **同時過期**（例如系統重啟後批次載入資料，都設了相同的 TTL），導致瞬間大量 cache miss 衝擊 DB。

```
t=0:    批次寫入 10 萬個 key，TTL = 3600s
t=3600: 10 萬個 key 同時過期 ──> DB 被打爆
```

**解法**：

- **TTL 加隨機抖動**：`TTL = base_ttl + random(0, jitter)`。例如基礎 TTL 3600s，加上 0-600s 的隨機值，讓過期時間分散在 3600-4200s 之間。
- **多層 cache**：L1 (local in-process cache, 如 Caffeine/Guava) + L2 (Redis)。即使 L2 avalanche，L1 仍可擋住部分流量。
- **永不過期 + 非同步更新**：key 設為永不過期，由背景執行緒定期更新。適合可預測的、數量有限的 hot data。
- **限流降級**：DB 前面加 rate limiter，超過閾值的請求直接返回降級結果（cached stale data、default value、或 error）。

---

### 4. Hot Key Problem

**問題**：某些 key 被極度頻繁存取（明星微博、秒殺商品），單一 Redis node 承受不住。即使在 Redis Cluster 中，一個 key 只存在於一個 node 上。

**解法**：

- **Local cache 分擔**：在 application server 的 process 內用 in-memory cache (Caffeine, Guava) 快取 hot key，TTL 設為數秒。大部分請求在本地就被攔截。
- **Key 分片 (Read replicas)**：將 `hot_key` 拆成 `hot_key:0`, `hot_key:1`, ..., `hot_key:N`，讀取時隨機選一個。這些 key 會被分散到不同的 Redis node 上。寫入時需要廣播更新所有分片。
- **Redis Cluster 的 replica 讀取**：`READONLY` 命令讓 client 可以從 replica 讀取，分擔 primary 的讀取壓力。但要注意 replication lag 帶來的資料延遲。

---

### 5. Stale Data and Consistency Issues

**問題**：Cache 與 DB 之間的資料不一致。這是分散式系統的根本性挑戰 — cache 本質上是一個沒有分散式事務保證的額外資料副本。

**常見不一致場景**：

```
Race Condition (Cache-Aside + DB Update):

Thread A: 讀取 DB → 獲得 value=1
Thread B: 更新 DB → value=2
Thread B: 刪除 cache (invalidate)
Thread A: 將 value=1 寫入 cache (stale!)
```

**解法**：

- **延遲雙刪 (Delayed Double Delete)**：更新 DB 後先刪 cache，等待一小段時間（例如 500ms，超過一次 DB 讀取的時間），再刪一次 cache。第二次刪除可以清除在這段時間內被寫入的 stale data。
  ```
  1. 更新 DB
  2. 刪除 cache
  3. sleep(500ms)   // 或透過 message queue 延遲
  4. 再次刪除 cache
  ```
- **基於 binlog 的 cache 更新**：使用 Canal (MySQL) / Debezium (通用) 監聽 DB 的 binlog/WAL 變更，由獨立的 consumer 負責更新或刪除 cache。這是最可靠的方式 — DB 是 single source of truth，cache 更新由 DB 事件驅動。
- **版本號/時間戳**：cache 中的 value 附帶版本號，寫入時只有版本號更大才允許更新（類似 CAS）。
- **接受最終一致性 + 設短 TTL**：對大多數應用來說，cache TTL 設為 30s-5min 的最終一致性是可以接受的。這是最簡單也最常用的策略。

---

## 6. Capacity Planning Anchors

### Redis

| Metric | Reference Value | Notes |
|--------|----------------|-------|
| **Single-thread throughput** | ~100K-200K ops/s | Simple GET/SET；pipeline 模式可達 1M+ ops/s |
| **p99 Latency** | < 1 ms | Intra-DC；注意 `fork()` 和 `KEYS *` 等 blocking 命令會造成 spike |
| **Memory overhead per key** | ~90 bytes (small key/value) | 包含 dictEntry (24 bytes) + RedisObject (16 bytes) + SDS header + jemalloc alignment |
| **Memory overhead per Hash field** | ~70 bytes (hashtable encoding) | 小 Hash 使用 ziplist encoding 時 overhead 大幅降低 (~20-30 bytes) |
| **Max memory per instance** | 建議 < 25 GB | 超過此值 `fork()` 的 latency spike 和 COW memory overhead 變得顯著 |
| **Replication lag** | 通常 < 1 ms (intra-DC) | 取決於 network 和 write volume；大量寫入時可達數十 ms |

**Memory 估算公式**：
```
Total Memory ≈ (num_keys × per_key_overhead) + (sum of all value sizes) + (fragmentation ratio × 1.1~1.5)
```

`INFO memory` 的 `mem_fragmentation_ratio` 正常值在 1.0-1.5 之間。若 > 2.0，表示有嚴重碎片化，考慮 `MEMORY PURGE` 或重啟。

### Memcached

| Metric | Reference Value | Notes |
|--------|----------------|-------|
| **Multi-thread throughput** | ~200K-700K ops/s | 取決於核心數和 value size；4-8 threads 通常足夠 |
| **p99 Latency** | < 1 ms | Simple GET/SET |
| **Memory overhead per item** | ~56 bytes + chunk 對齊浪費 | item header (key + flags + exptime + cas + pointers) + slab class 內部碎片 |
| **Internal fragmentation** | 平均 10-15% | 取決於 value size 分佈與 slab growth factor |
| **Max value size** | 1 MB (default) | 可透過 `-I` 參數調高，但大 value 會影響效能 |

### Network Bandwidth 考量

```
單條 Redis GET/SET (1 KB value):
  Request:  ~50 bytes (command + key)
  Response: ~1,050 bytes (value + protocol overhead)

100K ops/s × 1.1 KB ≈ 110 MB/s ≈ 880 Mbps
```

在 100K ops/s 的場景下，**1 Gbps NIC 已接近飽和**。Value size 越大，network 越早成為瓶頸。解法：
- 使用 10 Gbps / 25 Gbps NIC
- 壓縮 value（client-side compression，如 LZ4、Snappy）
- 減少 value size（只快取必要欄位，不是整個物件）
- Pipeline / MGET 批次操作減少 round-trip 次數
