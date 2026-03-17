# 訊息佇列 (Message Queue)：SQS vs Kafka vs RabbitMQ

## 1. 綜合比較表格

| 維度 | AWS SQS | Apache Kafka | RabbitMQ |
|------|---------|--------------|----------|
| **吞吐量 (Throughput)** | 約 3,000 msg/s（單一佇列，Standard）；批次可提升 | **百萬級 msg/s**（靠連續寫入磁碟 Sequential I/O） | 約 10,000–50,000 msg/s（單節點） |
| **延遲 (p99 Latency)** | 10–20ms（經由網路到 AWS） | 2–5ms（資料中心內，批次寫入） | **< 1ms**（單節點，Direct Exchange） |
| **訊息排序 (Ordering)** | Best-effort（Standard）/ 嚴格排序（FIFO Queue，限 300 msg/s/group） | **嚴格保證 Partition 內排序** | 單一佇列內 FIFO 排序 |
| **持久化 (Persistence)** | 完全託管，預設保留 4 天（最多 14 天） | **可設定保留時間**（小時到永久），Append-only Log 落磁碟 | 持久化佇列 + 持久化訊息（每筆或批次 fsync） |
| **投遞語意 (Delivery)** | At-least-once（Standard）/ Exactly-once（FIFO） | 預設 At-least-once；支援 Exactly-once（冪等 Producer + 交易 API） | At-least-once（搭配手動 ACK）；Publisher Confirms 保證送達 |
| **路由彈性 (Routing)** | 無（點對點佇列） | Topic + Partition Key | **最豐富**：Direct / Fanout / Topic / Headers Exchange |
| **消費模型** | 拉取 (Long-polling) | **拉取** (Consumer 輪詢 Broker) | **推送** (Broker 主動派發給 Consumer) |
| **訊息重播 (Replay)** | 不支援（處理後刪除） | **支援**（Consumer 可 seek 到任意 Offset） | 不支援（ACK 後移除） |
| **擴展模型** | 完全託管，自動擴展 | 增加 Partition + Broker（手動/半自動） | 加入叢集節點（鏡像佇列有額外負擔） |
| **維運複雜度 (Ops)** | **幾乎為零**（Serverless） | 高（ZooKeeper/KRaft、Partition Rebalance、ISR 管理） | 中（Erlang 執行環境、叢集管理、Quorum Queues） |
| **計費模式** | 按請求計費（$0.40/百萬次） | 基礎設施成本（Broker + 儲存空間） | 基礎設施成本（節點 + 儲存空間） |

---

## 2. 底層實作差異

### Kafka：分散式提交日誌 (Distributed Commit Log)

```
Producer --> [Broker: Partition 0] --> 附加到不可變日誌（連續磁碟寫入）
             [Broker: Partition 1]     Consumer 帶著 Offset 主動拉取
             [Broker: Partition 2]     Consumer 自行追蹤讀取位置
```

**核心機制：**

- **追加寫入日誌 (Append-only Log)**：訊息按順序寫入磁碟。這是關鍵——連續磁碟 I/O 在現代硬碟上可達約 600 MB/s（HDD）到 3 GB/s（NVMe SSD），接近網路吞吐量。
- **拉取模型 (Pull Model)**：Consumer 從指定的 Offset 開始批量請求訊息。Producer 與 Consumer 完全解耦——慢速 Consumer 不會對 Broker 造成背壓 (Back-pressure)。
- **Partition = 平行處理單位**：每個 Partition 是一個有序、不可變的訊息序列。Consumer Group 會將每個 Partition 分配給恰好一個 Consumer。更多 Partition = 更高平行度，但 Broker 記憶體開銷更大，且 Leader 選舉時間更長。
- **複製機制 (Replication)**：每個 Partition 有一個 Leader 和 N-1 個 Follower（ISR = In-Sync Replicas）。寫入僅經過 Leader；Follower 複製資料。`acks=all` 表示所有 ISR 成員確認後，Producer 才收到 ACK。
- **零拷貝傳輸 (Zero-copy)**：Kafka 使用 `sendfile()` 系統呼叫，將資料從磁碟頁面快取直接傳輸到網路 Socket，繞過使用者空間。這就是高吞吐量的秘密。
- **基於保留期的訊息管理**：訊息在消費後**不會被刪除**，而是依據時間或大小策略保留。這使得重播、多消費者模式和稽核軌跡成為可能。

**容量估算錨點：**
- 單一 Partition 支撐約 10 MB/s 寫入吞吐量
- 單一 Broker 通常可管理 2,000–4,000 個 Partition
- 儲存空間 = `平均訊息大小 × 每秒訊息數 × 保留秒數 × 複製因子`

---

### RabbitMQ：智慧型 Broker（Exchange + Queue 架構）

```
Producer --> [Exchange] --routing key--> [Queue A] --> 推送給 Consumer 1
                        --routing key--> [Queue B] --> 推送給 Consumer 2
                        --binding rule--> [Queue C] --> 推送給 Consumer 3
```

**核心機制：**

- **Exchange 路由機制**：訊息不會直接進入佇列，而是先到 Exchange，再依類型決定路由：
  - **Direct**：精確匹配 Routing Key（類似 Hash Map 查找）。
  - **Fanout**：廣播到所有綁定的佇列（發佈/訂閱模式）。
  - **Topic**：萬用字元匹配 Routing Key（如 `order.*.created`）。
  - **Headers**：依訊息 Header 屬性路由。
- **推送模型 (Push Model)**：Broker 主動透過 `basic.consume` 將訊息派發給 Consumer。對小量訊息來說延遲更低（沒有輪詢間隔），但快速 Producer 可能壓垮慢速 Consumer（透過 `prefetch_count` 緩解）。
- **訊息生命週期**：Consumer 發送 ACK 後，訊息從佇列中移除。**不支援重播**。
- **Quorum Queues（v3.8+）**：基於 Raft 共識的複製佇列，取代傳統鏡像佇列。一致性保證更強，但寫入延遲較高（需要 Raft 共識回合）。
- **Erlang/OTP 執行環境**：基於 Erlang 的 Actor 模型。每個佇列是一個 Erlang Process。輕量級 Process 可支撐百萬個佇列，但 GC 暫停可能在高負載下造成延遲尖峰。

**容量估算錨點：**
- 單一佇列吞吐量瓶頸：約 50K msg/s（Erlang Process 是單執行緒）
- 記憶體：處理中的訊息保存在 RAM。若 Consumer 落後，記憶體壓力急速上升。
- 磁碟：持久化訊息需要 `fsync`——這是延遲懸崖。批次發佈或 `publisher confirms` 搭配非同步處理可緩解。

---

### SQS：完全託管佇列

```
Producer --> HTTP PUT --> [SQS 服務] --> Consumer Long-poll（HTTP GET）
                          自動跨多個可用區 (AZ) 分散
                          Visibility Timeout 在處理期間隱藏訊息
```

**核心機制：**

- **可見性逾時 (Visibility Timeout)**：當 Consumer 收到訊息後，該訊息在設定的時間內（預設 30 秒）對其他 Consumer 不可見。若 Consumer 未在逾時前刪除訊息，訊息會重新出現供其他 Consumer 處理。這是 SQS 實現 At-least-once 投遞的核心機制，不需要分散式鎖。
- **Standard vs FIFO**：
  - Standard：幾乎無限吞吐量，但訊息可能亂序或重複。底層使用跨多台伺服器的分散式 Hash 儲存。
  - FIFO：在同一 Message Group ID 內嚴格排序，透過去重 ID (Deduplication ID) 實現 Exactly-once，但限制為 300 msg/s（批次可達 3,000）。
- **死信佇列 (Dead Letter Queue, DLQ)**：經過 N 次處理失敗（可設定 `maxReceiveCount`）後，訊息被移至 DLQ 供調查。這是一種模式，Kafka 和 RabbitMQ 非原生支援。
- **Long Polling**：Consumer 發出帶 `WaitTimeSeconds`（最多 20 秒）的 HTTP GET。減少空回應和成本（更少的 API 呼叫）。
- **不支援訊息重播**：刪除後永遠消失。沒有 Consumer Offset，沒有基於保留期的模型。

**容量估算錨點：**
- 成本 = `API 呼叫次數 × $0.40 / 百萬次` + 資料傳輸費
- 每次 API 呼叫最多批次 10 則訊息，可降低成本 10 倍
- 最大訊息大小：256 KB（較大負載使用 S3 指標模式 Claim Check Pattern）
- 最長保留期：14 天

---

## 3. 架構師的決策樹

```
起點：「我需要非同步訊息處理」
│
├── Q1: 你需要重播訊息，或讓多個獨立 Consumer 讀取同一份資料流嗎？
│   ├── 是 --> Kafka
│   │         （Append-only Log、Consumer Offset、天生支援多消費者）
│   └── 否 --> 繼續
│
├── Q2: 吞吐量需求 > 100K msg/s？
│   ├── 是 --> Kafka
│   │         （Sequential I/O + Zero-copy = 無與倫比的吞吐量）
│   └── 否 --> 繼續
│
├── Q3: 需要複雜的路由邏輯？（如依訊息類型路由、萬用字元、選擇性廣播）
│   ├── 是 --> RabbitMQ
│   │         （Exchange 路由是最彈性的模型）
│   └── 否 --> 繼續
│
├── Q4: 亞毫秒延遲是關鍵，且流量中等？
│   ├── 是 --> RabbitMQ
│   │         （推送模型、Direct Exchange、記憶體內派發）
│   └── 否 --> 繼續
│
├── Q5: 想要零維運負擔，且在 AWS 上？
│   ├── 是 --> SQS
│   │         （完全託管、自動擴展、按用量計費）
│   └── 否 --> 繼續
│
├── Q6: 這是簡單的任務佇列 / 工作佇列模式？
│   ├── 是 --> SQS 或 RabbitMQ
│   │         （兩者都擅長競爭消費者 Competing Consumer 模式）
│   └── 否 --> 繼續
│
└── Q7: 需要事件溯源 (Event Sourcing)、稽核軌跡、或串流處理？
    ├── 是 --> Kafka
    │         （不可變日誌本身就是事件儲存；整合 Kafka Streams / Flink）
    └── 否 --> 預設選 SQS（最簡單）或 RabbitMQ（最彈性）
```

### 速查表：絕對法則

| 場景 | 選擇 | 原因 |
|------|------|------|
| 事件串流 / 大規模日誌聚合 | **Kafka** | Sequential I/O、保留期、重播、多消費者 |
| 微服務任務佇列，不需重播 | **SQS** | 零維運、自動擴展、按用量計費 |
| 中等流量下的複雜路由 | **RabbitMQ** | Exchange 路由彈性無可匹敵 |
| 事件溯源 / CQRS 骨幹 | **Kafka** | 不可變日誌本身就是事件儲存 |
| Serverless / Lambda 觸發 | **SQS** | 原生 AWS Lambda 整合，無需伺服器 |
| 即時分析管線 | **Kafka** | Kafka Streams / ksqlDB / Flink Connector 生態系 |
| 請求-回應模式 (RPC over MQ) | **RabbitMQ** | 內建 reply-to + correlation-id 支援 |
| 「我只需要一個佇列，不想多想」 | **SQS** | 託管、便宜、90% 場景足夠 |

---

## 4. 常見踩坑

1. **「我們選了 Kafka 來做簡單的任務佇列。」**
   - 殺雞用牛刀。你要承擔 ZooKeeper/KRaft 維運、Partition 管理、Consumer Group Rebalancing 的複雜度——而這個模式用 SQS 或 RabbitMQ 更簡單也更便宜。

2. **「我們需要 Exactly-once，所以選了 Kafka。」**
   - Kafka 的 Exactly-once 是**在 Kafka 內部**（冪等 Producer + 交易型 Consumer）。端到端的 Exactly-once 不管用哪個佇列，**都需要你的應用程式實作冪等 Consumer**。

3. **「RabbitMQ 撐不住我們的吞吐量。」**
   - 很可能是撞到單一佇列瓶頸。RabbitMQ 可以透過分片到多個佇列 + Consistent Hashing Exchange 來擴展吞吐量。但如果你真的需要百萬級 msg/s，Kafka 的架構從根本上更適合。

4. **「SQS 的排序壞了。」**
   - 你用的是 Standard Queue。FIFO Queue 保證同一 Message Group ID 內的排序，但吞吐量會降低。先理解這個 Trade-off 再抱怨。

5. **「我們把 5MB 的 Payload 塞進訊息裡。」**
   - 三個系統在大訊息下都會性能退化。使用**領取支票模式 (Claim Check Pattern)**：將 Payload 存到 S3/Blob Storage，訊息裡只放一個指標。
