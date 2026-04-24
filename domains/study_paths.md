# System Design 面試準備路線圖

## 使用方式

按 Path 順序學習。每個 Path 內的題目按建議順序排列。
- 🔴 Path A：必刷（面試出現率 >60%）
- 🟡 Path B：高頻（出現率 30-60%）
- 🟢 Path C：差異化（出現率 15-30%，答好能拉開差距）

---

## 🔴 Path A — 必刷

> 預計時間：2 週。這些系統幾乎每輪面試都可能遇到。

| # | 系統 | 核心學習點 | 相關 Components |
|---|------|-----------|----------------|
| A1 | URL Shortener | KGS pattern、讀寫分離、多層快取 | Cache, Database, Scalability |
| A2 | Twitter Timeline | Hybrid fan-out、Snowflake ID、timeline cache | Message Queue, Cache, Database |
| A3 | Chat System (WhatsApp) | WebSocket 管理、message ordering、delivery receipt、E2E encryption | Real-time Communication, Message Queue |
| A4 | Notification System | Multi-channel dispatch、priority queue、per-user throttle | Message Queue, Rate Limiter |
| A5 | YouTube / Video Streaming | 上傳 DAG pipeline、transcoding、ABR streaming、video CDN | Networking (CDN), Scalability |
| A6 | Distributed KV Store | Consistent hashing、vector clock、Merkle tree、gossip protocol | Consistency & Consensus, Database, Fault Tolerance |
| A7 | Web Crawler + Search Engine | URL frontier、inverted index、BM25、dedup | Scalability, Database |
| A8 | Instagram | ML-ranked feed、photo pipeline、Stories TTL、Explore embedding | Cache, Scalability, Message Queue |

### Path A 學習建議
- A1-A2 是暖身題，概念密度適中，建議先從這兩題開始建立信心
- A3-A5 各自涵蓋一個獨立領域（即時通訊、通知、media processing），面試常見
- A6 是最底層的分散式系統設計，理解後對所有其他系統都有幫助
- A7-A8 概念較多但與前面系統有交集，可以加速學習

---

## 🟡 Path B — 高頻

> 預計時間：2 週。重點公司常考，特別是有特定領域偏好的公司。

| # | 系統 | 核心學習點 | 相關 Components |
|---|------|-----------|----------------|
| B1 | Uber (即時叫車) | Geospatial index、per-city sharding、即時配對 | Database, Real-time Communication |
| B2 | Ticketmaster (搶票) | Flash sale、Redis seat lock + DB optimistic lock、waiting room | Cache, Rate Limiter, Scalability |
| B3 | Payment System | Idempotency、double-entry ledger、Saga pattern | Distributed Transactions, Fault Tolerance |
| B4 | Google Maps | Contraction Hierarchies、tile serving、real-time traffic | Networking (CDN), Database |
| B5 | Google Docs | OT vs CRDT、cursor sync、operation log + snapshot | Consistency & Consensus, Real-time Communication |
| B6 | Distributed Task Scheduler | Lease-based locking、exactly-once、priority scheduling | Fault Tolerance, Message Queue |
| B7 | E-commerce (Amazon) | Inventory reservation、order state machine、checkout Saga | Distributed Transactions, Cache, Database |

### Path B 學習建議
- B1-B2 你已經有了，快速 review 即可
- B3 搭配 Distributed Transactions component 一起讀，效果最好
- B5 的 OT/CRDT 是進階概念，理解原理即可，不需要背實作細節
- B7 與 B3 (Payment) 有很大交集，建議連續學

---

## 🟢 Path C — 差異化

> 預計時間：1 週。這些題目較少見，但答得好能展示深度。

| # | 系統 | 核心學習點 | 相關 Components |
|---|------|-----------|----------------|
| C1 | Dropbox (檔案同步) | Content-defined chunking、delta sync、conflict resolution | Networking, Fault Tolerance |
| C2 | Metrics / Monitoring | Time-series DB、Gorilla compression、alerting pipeline | Database, Scalability |
| C3 | Typeahead / Autocomplete | Trie、pre-computed top-K、blue-green Trie swap | Cache, Scalability |
| C4 | Proximity Service (Yelp) | Geohash vs QuadTree (static vs dynamic)、composite ranking | Database |
| C5 | Stock Exchange | Matching engine、LMAX Disruptor、single-threaded 反模式 | — (打破所有分散式常規) |
| C6 | Ad Serving | RTB auction、eCPM ranking、fraud detection | Cache, Rate Limiter |
| C7 | **Payment Processor Internals** | Four-party model、Smart Routing、FX engine、Tokenization/PCI、Reconciliation at scale | Distributed Transactions, Database |
| C8 | **Card Network Internals** | 65K TPS in-memory processing、BIN routing、Clearing/Settlement netting、Multi-DC zero-data-loss DR、STIP | Fault Tolerance, Scalability |

### Path C 學習建議
- C1 你已經有了，review 即可
- C5 非常特殊 — 它故意違反所有分散式系統原則，面試時能展示你的靈活度
- C4 與 B1 (Uber) 形成對比：static vs dynamic geospatial，串起來理解效果很好
- C7 一般面試是 C 級，但**面 fintech (Airwallex / Stripe / Adyen) 時升級為 🔴 A 級**——這是他們的核心產品。與 B3 (Payment System) 的差別：B3 是商家視角（用 Stripe API），C7 是 Processor 視角（做出 Stripe）
- C8 一般面試是 C 級，但**面 Card Network (Visa / Mastercard) 時升級為 🔴 A 級**——這是他們的網路本身。與 C7 的差別：C7 是 PSP 層（代商家跟 acquirer 溝通），C8 是 Network 層（連接所有 issuer 和 acquirer）

---

## Components 學習路線

> 不需要單獨「學完所有 component 再做 deep dive」。建議在做每個 deep dive 時，同步深入相關 component。

### 基礎層（任何 deep dive 都會用到）
1. Database (SQL vs NoSQL)
2. Cache (Redis vs Memcached)
3. Scalability (Sharding, Replication, CQRS)
4. Estimation Framework ← **每天練一題 15 分鐘估算**

### 通訊層
5. API Design (REST vs gRPC vs GraphQL)
6. Message Queue (Kafka vs SQS vs RabbitMQ)
7. Real-time Communication (WebSocket, SSE, WebRTC)
8. Networking (DNS, CDN, HTTP/2/3)

### 可靠性層
9. Fault Tolerance (Retry, Circuit Breaker, Bulkhead)
10. Consistency & Consensus (Raft, Paxos, CAP/PACELC)
11. Distributed Transactions (Saga, 2PC, TCC) ← **新增**
12. Rate Limiter

### 進階層
13. Load Balancer (L4 vs L7)

---

## 每日練習建議

```
早上（30 min）：
  1. 選一個 deep dive，用面試策略章節的順序，計時 35 分鐘口述一遍
  2. 對照 Trade-off 總結，檢查自己是否漏掉關鍵決策

晚上（15 min）：
  1. 隨機選一個系統，做 back-of-the-envelope estimation
  2. 用 Estimation Framework 的步驟驗證
```
