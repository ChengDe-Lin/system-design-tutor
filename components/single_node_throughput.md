# 單節點吞吐量速查 (Single-Node Throughput Cheat Sheet)

> **面試 / 設計時最常用的「量級感」**。所有數字都是 **per-node** rough order of magnitude，不是精確保證。實際 throughput 受 workload 複雜度、message size、CPU / NIC / 磁碟、語言 client 影響，可能上下浮動 2-5x。
>
> **核心規則：引用任何 QPS 數字時，永遠先講「per-node 還是 cluster-aggregate」，否則量級判斷會錯一個數量級。**

## 1. In-Memory 快取 / KV

| 服務 | 讀 QPS | 寫 QPS | 備註 |
|------|--------|--------|------|
| **Redis (簡單 GET/SET)** | **100K-200K** | **100K-200K** | 單 thread，CPU-bound；網路是主要瓶頸 |
| Redis GEOADD / ZADD / SADD | 50-100K | 50-100K | Sorted Set / Geo 比 string 慢 |
| Redis 複雜 Lua / 大 key | 10-30K | 10-30K | 長 script 會 block event loop |
| Redis Pipeline | **500K-1M** | **500K-1M** | Batch amortize RTT |
| Memcached | 200K+ | 200K+ | 比 Redis 更簡單更快 (multi-thread) |
| Hazelcast / Ignite | 50-100K | 50-100K | JVM-based, GC 是變數 |

**瓶頸順序**：網路 > CPU (Redis single-thread) > RAM。1 Gbps NIC 大概 150K small ops/sec 就飽和。

## 2. 關聯式資料庫 (OLTP SQL)

| 服務 | 讀 QPS | 寫 QPS | 備註 |
|------|--------|--------|------|
| **MySQL (InnoDB, simple PK lookup)** | **20-50K** | 5-10K | Buffer pool hit 時 |
| MySQL 一般混合 workload | 5-10K | 1-5K | Index / JOIN / WHERE complexity 影響大 |
| MySQL 複雜寫 (多 index + FK) | - | **1-3K** | Redo log + buffer flush 瓶頸 |
| **PostgreSQL (simple lookup)** | 15-40K | 3-8K | MVCC overhead 略高於 MySQL |
| PostgreSQL 一般 workload | 5-10K | 2-5K | autovacuum 背景開銷 |

**瓶頸順序**：磁碟 IOPS (寫) > CPU (查詢解析) > 記憶體 (buffer pool hit rate)。

## 3. NoSQL (Wide-Column / Document)

| 服務 | 讀 QPS | 寫 QPS | 備註 |
|------|--------|--------|------|
| **Cassandra** | 10-30K | **20-50K** | LSM-Tree 寫快，讀要 merge 多個 SSTable |
| ScyllaDB | 100K+ | 100K+ | C++ 重寫 Cassandra，shared-nothing per core |
| **MongoDB** | 10-30K | 10-20K | 單 collection；index 命中與否差很多 |
| HBase | 10-20K | 20-40K | 類似 Cassandra 架構 |
| **DynamoDB (per partition)** | **3000 RCU** | **1000 WCU** | Serverless 自動 scale，但單 partition 有上限 |

**DynamoDB 陷阱**：1 RCU = 1 strongly consistent 4KB read；1 WCU = 1 × 1KB write。Hot partition 超過 3K RCU 就 throttle，設計時要避免。

## 4. Message Queue / Streaming

| 服務 | Producer 吞吐 | Consumer 吞吐 | 備註 |
|------|--------------|--------------|------|
| **Kafka broker** | **100K-1M msg/sec** | 100K-1M msg/sec | 小 message 可達 GB/s throughput；partition 數決定並行度 |
| Kafka (1KB message, RF=3) | ~300K msg/sec | - | 實務 benchmark |
| **RabbitMQ (classic queue)** | 20-50K | 20-50K | Persistent + ack 會降到 10K |
| RabbitMQ (quorum queue) | 10-20K | 10-20K | Raft 一致性成本 |
| **NATS (core)** | **1M+ msg/sec** | 1M+ msg/sec | 無持久化時極快 |
| NATS JetStream | 100K-500K | 100K-500K | 加持久化後 |
| Redis Streams | 100K+ | 100K+ | 借用 Redis 本體 throughput |
| AWS SQS | - | - | Serverless，無 per-node 概念 |

## 5. 搜尋 / 分析

| 服務 | Query QPS | Index / Ingest QPS | 備註 |
|------|-----------|--------------------|------|
| **Elasticsearch node** | 1-10K | 5-20K docs/sec | 重 query (aggregation) 更慢 |
| OpenSearch | 1-10K | 5-20K | 同 ES |
| **ClickHouse** | 10-100 concurrent | **100K-1M rows/sec** (batch) | OLAP 不看 QPS 看 scan GB/s |
| ClickHouse scan speed | ~1-2 GB/s compressed | - | CPU + disk bound |
| Apache Druid | 亞秒 query (高並發 OK) | 10-100K events/sec | 預聚合 ingestion |

**OLAP 不要用 QPS 思考**，用「每日掃描 TB」或「每 query scan 多少 GB」。

## 6. 負載平衡 / Proxy / API Gateway

| 服務 | Req/sec | 備註 |
|------|---------|------|
| **Nginx** | 50-100K | Reverse proxy / LB |
| **HAProxy** | **100K-300K** | 純 L4/L7 LB，通常比 Nginx 快 |
| Envoy | 50-100K | L7 feature 多，overhead 比 HAProxy 略高 |
| AWS ALB | 數 K per unit (LCU-based) | 自動 scale，單 LCU 限制見 AWS 文件 |
| API Gateway (Kong / Tyk) | 20-50K | 加上 auth / rate-limit 會降 |

## 7. Web / Application Server

| 服務 | Req/sec (per node) | 備註 |
|------|-------------------|------|
| Node.js (express) | 5-20K | 簡單 handler；async I/O 友好 |
| Python Flask/Django (sync) | 500-2K | WSGI single-process 瓶頸 |
| Python FastAPI (async) | 5-15K | uvicorn / asyncio |
| Go net/http | **30-80K** | Goroutine model 強 |
| Java Spring Boot | 10-30K | JVM 暖機後穩定 |
| Rust Actix / Axum | **50-150K** | 最快的 mainstream 選項之一 |

數字是純 hello-world 等級，加上 DB call / JSON parse / auth 會降 5-10x。

## 8. Long-lived Connection (WebSocket / SSE / long polling)

長連線系統的「per-node 容量」**不是 QPS**，是**同時在線連線數**。瓶頸跟 stateless API 完全不同。

| 服務 | 單機連線數 | 備註 |
|------|----------|------|
| **典型 Go / Node.js WebSocket server** | **10K-100K** | 一般調優，idle-heavy workload |
| Java / Spring WebFlux | 50K-200K | Netty-based，event loop |
| **Erlang/Elixir (Phoenix)** | **500K-2M** | Discord ~25K/server 保守設定，WhatsApp 2012 做到 2M |
| Rust (tokio + axum) | 100K-500K | 接近 Erlang 等級 |
| Nginx (做 WebSocket proxy) | 100K-500K | 純 proxy 不處理應用邏輯 |

### 怎麼推導「單機 N 條連線」

四個瓶頸依序檢查（**永遠是記憶體最先撞牆**）：

**(1) 記憶體**：每條 idle WebSocket 約 **30-50 KB**
- Linux kernel TCP buffer (`tcp_rmem` + `tcp_wmem`)：20-30 KB（可調到 4-8 KB）
- WS 框架 state (heartbeat、frame parser)：2-5 KB
- 應用層 session (user_id、subscriptions)：2-10 KB
- → 100K × 40 KB ≈ 4 GB RAM；極端調優可壓到 10 KB/conn → 1M conn 需要 10 GB

**(2) File Descriptor**：1 conn = 1 FD，預設 `ulimit -n = 1024`
- 必須調到 1M+（`/etc/security/limits.conf`）
- **這是設定問題不是物理極限**

**(3) Port**（破解迷思）：server **不受 65535 port 限制**
- TCP 連線是 4-tuple: `(src_ip, src_port, dst_ip, dst_port)`
- Server 監聽單一 port，不同 client 的 `(src_ip, src_port)` 區分，理論無限
- 只有 outbound 主動連別人時才受 ephemeral port range 限制

**(4) CPU**：idle 不耗，**活躍訊息才耗**
- Idle 連線只有 30s 一次 heartbeat，CPU ~0
- 100K conn × 每秒 1 則訊息 = 100K msg/sec → 單核接近極限
- 100K conn × 每分鐘 1 則訊息 = 1.7K msg/sec → 毫無壓力

### 估算範例：Slack 規模

需求：5M 同時在線，平均 10s 一則訊息

- **記憶體**：5M × 40 KB = 200 GB → 7 台 32GB（buffer 開 10 台）
- **訊息**：5M / 10s = 500K msg/sec → 單機 50K msg/sec → 需要 10+ 台
- **取交集**：50 台 × 100K conn（保守，方便 rolling deploy）

### 引用 WS 容量的鐵律

- **「100K conn / node」是 idle-heavy workload 的 anchor**，活躍訊息高的場景（即時遊戲、股價推送）可能只剩 10-20K
- **永遠分開講「連線數」和「訊息率」**，混為一談量級會錯
- **VM 配置先估記憶體，再估 CPU**——記憶體幾乎一定先撞牆

## 9. 網路硬體極限 (絕對天花板)

| 規格 | 吞吐 | 備註 |
|------|------|------|
| 1 Gbps NIC | ~125 MB/s = ~150K small ops/sec | 家用等級，已過時 |
| **10 Gbps NIC** | **~1.25 GB/s** | 現代 DC 標配 |
| 25 Gbps NIC | ~3 GB/s | 高階服務器 |
| 40/100 Gbps NIC | 5-12 GB/s | 骨幹 / 儲存網 |
| **NVMe SSD random 4K read** | 100K-1M IOPS | 遠超磁碟時代 |
| NVMe SSD sequential | 3-7 GB/s | 單 drive |
| DRAM bandwidth | 20-50 GB/s | 記憶體內處理的理論上限 |

## 如何使用這些數字

### 初步估算的 3 步驟

1. **估總 QPS**：DAU × 平均動作數 / 86400
2. **除以單節點能力**（查上表）
3. **加安全係數 × 2-3**（peak burst、degraded mode、replication overhead）

**範例**：Instagram like 58K QPS
- 用 Redis counter (100K+ ops/sec/node 簡單 INCR)
- 單節點綽綽有餘，但為了 HA + hot post sharding 開 3-5 個節點

### 引用數字時的鐵律

- **永遠標「per-node」或「cluster-aggregate」**——否則量級會錯一個 0
- **永遠標 workload 類型**——simple GET vs 複雜 query 差 10x
- **永遠講條件**——peak QPS vs 平均 QPS、warm cache vs cold、同步 vs 非同步

### 快速心算 anchor

| 量級 | 可能的系統 | 代表性數字 |
|------|-----------|-----------|
| 1K QPS | 中小型 app 全站 | 一台 MySQL 就搞定 |
| 10K QPS | 爆紅小服務 | 單節點 Redis / Go server 可扛 |
| 100K QPS | 區域頭部服務 | 要 cluster + cache，不能 single-node |
| 1M QPS | Twitter/IG tier | 需要 10-30 個節點 shard + CDN + fan-out |
| 10M QPS | Google / Meta tier | 全球部署 + edge cache + 客製化 stack |

## 常見誤區

1. **「Redis 能做 1M QPS」** → 那是 cluster 總和，單節點 100-200K。
2. **「MySQL 只能 1K QPS」** → 只指複雜寫；PK lookup 單節點可到 50K。
3. **「Kafka 很慢」** → 單 broker 可達 GB/s，瓶頸通常是 consumer 處理速度。
4. **「NoSQL 一定比 SQL 快」** → Simple PK lookup MySQL 可能比 MongoDB 快；NoSQL 的優勢在**橫向擴展**和 schema flexibility。
5. **「ClickHouse 超快」** → 對 OLAP 聚合快，單筆 point lookup 比 MySQL 慢幾個數量級。

---

**每次看到 QPS 數字先問三件事**：per-node 還是 aggregate？workload 類型？什麼硬體？三問缺一就不要信那個數字。
