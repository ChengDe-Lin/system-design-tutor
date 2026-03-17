# Message Queue: SQS vs Kafka vs RabbitMQ

## 1. Comprehensive Comparison Matrix

| Dimension | AWS SQS | Apache Kafka | RabbitMQ |
|-----------|---------|--------------|----------|
| **Throughput** | ~3,000 msg/s per queue (standard); batching helps | **Millions msg/s** per cluster (append-only sequential I/O) | ~10,000-50,000 msg/s per node |
| **Latency (p99)** | 10-20ms (network to AWS) | 2-5ms (intra-DC, batched) | **< 1ms** (single node, direct exchange) |
| **Message Ordering** | Best-effort (Standard) / FIFO (FIFO queue, 300 msg/s per group) | **Strict per-partition** ordering guaranteed | Per-queue FIFO ordering |
| **Persistence** | Fully managed, 4-day default retention (up to 14 days) | **Configurable retention** (hours to infinite); append-only log on disk | Durable queues + persistent messages (fsync per msg or batch) |
| **Delivery Semantics** | At-least-once (Standard) / Exactly-once (FIFO) | At-least-once by default; Exactly-once with idempotent producer + transactional API | At-least-once (with manual ack); publisher confirms for guaranteed delivery |
| **Routing Flexibility** | None (point-to-point queue) | Topic + partition key | **Rich routing**: Direct, Fanout, Topic, Headers exchanges |
| **Consumer Model** | Pull (long-polling) | **Pull** (consumer polls broker) | **Push** (broker dispatches to consumer) |
| **Message Replay** | No (message deleted after processing) | **Yes** (consumers can seek to any offset) | No (message removed after ack) |
| **Scaling Model** | Fully managed, auto-scales | Add partitions + brokers (manual/semi-auto) | Add nodes to cluster (queue mirroring has overhead) |
| **Ops Complexity** | **Near-zero** (serverless) | High (ZooKeeper/KRaft, partition rebalancing, ISR management) | Medium (Erlang runtime, cluster management, quorum queues) |
| **Cost Model** | Per-request pricing ($0.40/1M requests) | Infrastructure cost (brokers + storage) | Infrastructure cost (nodes + storage) |

---

## 2. Underlying Implementation Differences

### Kafka: The Distributed Commit Log

```
Producer --> [Broker: Partition 0] --> append to immutable log (sequential disk write)
             [Broker: Partition 1]     Consumer polls with offset
             [Broker: Partition 2]     Consumer tracks own position
```

**Core Mechanism:**
- **Append-only log**: Messages are written sequentially to disk. This is critical -- sequential disk I/O on modern drives achieves ~600 MB/s (HDD) to ~3 GB/s (NVMe SSD), rivaling network throughput.
- **Pull model**: Consumers request batches of messages starting from an offset. This decouples producers from consumers entirely -- a slow consumer doesn't back-pressure the broker.
- **Partition = unit of parallelism**: Each partition is an ordered, immutable sequence. Consumer Group assigns each partition to exactly one consumer. More partitions = more parallelism, but more memory on broker + longer leader election.
- **Replication**: Each partition has a leader and N-1 followers (ISR = In-Sync Replicas). Writes go to leader; followers replicate. `acks=all` means all ISR members confirmed before producer gets ACK.
- **Zero-copy transfer**: Kafka uses `sendfile()` syscall to transfer data from disk page cache directly to network socket, bypassing user-space. This is why throughput is so high.
- **Retention-based, not deletion-based**: Messages are NOT deleted after consumption. They are retained by time or size policy. This enables replay, multi-consumer patterns, and audit trails.

**Capacity Planning Anchor:**
- 1 partition sustains ~10 MB/s write throughput
- 1 broker typically handles 2,000-4,000 partitions
- Storage = `(avg_msg_size * msg_per_sec * retention_seconds * replication_factor)`

---

### RabbitMQ: The Smart Broker (Exchange + Queue)

```
Producer --> [Exchange] --routing key--> [Queue A] --> push to Consumer 1
                        --routing key--> [Queue B] --> push to Consumer 2
                        --binding rule--> [Queue C] --> push to Consumer 3
```

**Core Mechanism:**
- **Exchange routing**: Messages don't go directly to queues. They hit an Exchange first, which routes based on type:
  - **Direct**: Exact match on routing key (like a hash map lookup).
  - **Fanout**: Broadcast to ALL bound queues (pub/sub).
  - **Topic**: Wildcard pattern matching on routing key (`order.*.created`).
  - **Headers**: Route based on message header attributes.
- **Push model**: Broker actively dispatches messages to consumers via `basic.consume`. This gives lower latency for small message volumes (no polling interval) but means a fast producer can overwhelm a slow consumer (mitigated by `prefetch_count`).
- **Message lifecycle**: Message is removed from the queue once the consumer sends an ACK. No replay capability.
- **Quorum Queues** (v3.8+): Raft-based replicated queues replacing classic mirrored queues. Stronger consistency guarantees, but higher latency on writes (Raft consensus round).
- **Erlang/OTP runtime**: Built on Erlang's actor model. Each queue is an Erlang process. Lightweight processes enable millions of queues, but GC pauses can cause latency spikes under heavy load.

**Capacity Planning Anchor:**
- Single queue throughput bottleneck: ~50K msg/s (Erlang process is single-threaded per queue)
- Memory: Messages in-flight are held in RAM. If consumers lag, memory pressure rises fast.
- Disk: Persistent messages do `fsync` -- this is the latency cliff. Batch publishing or `publisher confirms` with async handling mitigates this.

---

### SQS: The Fully Managed Queue

```
Producer --> HTTP PUT --> [SQS Service] --> Consumer long-polls (HTTP GET)
                          Distributed across multiple AZs automatically
                          Visibility Timeout hides message during processing
```

**Core Mechanism:**
- **Visibility Timeout**: When a consumer receives a message, it becomes invisible to other consumers for a configurable duration (default 30s). If the consumer doesn't delete the message before timeout expires, it reappears for another consumer. This is SQS's core mechanism for at-least-once delivery without distributed locks.
- **Standard vs FIFO**:
  - Standard: Nearly unlimited throughput, but messages may be delivered out of order or duplicated. Uses distributed hash-based storage across multiple servers.
  - FIFO: Strict ordering within a Message Group ID, exactly-once processing via deduplication ID, but capped at 300 msg/s per Message Group (3,000 with batching).
- **Dead Letter Queue (DLQ)**: After N failed processing attempts (configurable `maxReceiveCount`), message is moved to a DLQ for investigation. This is a pattern, not a Kafka/RabbitMQ-native feature.
- **Long Polling**: Consumer issues HTTP GET with `WaitTimeSeconds` up to 20s. Reduces empty responses and cost (fewer API calls).
- **No message replay**: Once deleted, gone forever. No consumer offset, no retention-based model.

**Capacity Planning Anchor:**
- Cost = `(number_of_API_calls * $0.40 / 1M)` + data transfer
- Batch up to 10 messages per API call to reduce cost by 10x
- Max message size: 256 KB (use S3 pointer pattern for larger payloads)
- Max retention: 14 days

---

## 3. Architect's Decision Tree

```
START: "I need asynchronous message processing"
│
├── Q1: Do you need to replay messages or have multiple independent consumers
│        read the same data stream?
│   ├── YES --> Kafka
│   │          (append-only log, consumer offset, multi-consumer by design)
│   └── NO --> continue
│
├── Q2: Is the throughput requirement > 100K msg/s?
│   ├── YES --> Kafka
│   │          (sequential I/O + zero-copy = unmatched throughput)
│   └── NO --> continue
│
├── Q3: Do you need complex routing logic? (e.g., route by message type,
│        wildcard patterns, selective fanout)
│   ├── YES --> RabbitMQ
│   │          (Exchange routing is the most flexible model)
│   └── NO --> continue
│
├── Q4: Is sub-millisecond latency critical and volume is moderate?
│   ├── YES --> RabbitMQ
│   │          (push model, direct exchange, in-memory dispatch)
│   └── NO --> continue
│
├── Q5: Do you want zero operational overhead and you're on AWS?
│   ├── YES --> SQS
│   │          (fully managed, scales automatically, pay-per-use)
│   └── NO --> continue
│
├── Q6: Is this a simple task queue / job queue pattern?
│   ├── YES --> SQS or RabbitMQ
│   │          (both excel at competing-consumer pattern)
│   └── NO --> continue
│
└── Q7: Do you need event sourcing, audit trail, or stream processing?
    ├── YES --> Kafka
    │          (immutable log IS the event store; integrates with Kafka Streams / Flink)
    └── NO --> Default to SQS (simplest) or RabbitMQ (most flexible)
```

### Quick Reference: Absolute Rules

| Scenario | Pick | Why |
|----------|------|-----|
| Event streaming / log aggregation at scale | **Kafka** | Sequential I/O, retention, replay, multi-consumer |
| Microservice task queue with no replay needs | **SQS** | Zero ops, auto-scale, pay-per-use |
| Complex routing with moderate volume | **RabbitMQ** | Exchange model is unmatched for routing flexibility |
| Event sourcing / CQRS backbone | **Kafka** | Immutable log IS the event store |
| Serverless / Lambda trigger | **SQS** | Native AWS Lambda integration, no servers |
| Real-time analytics pipeline | **Kafka** | Kafka Streams / ksqlDB / Flink connector ecosystem |
| Request-reply (RPC over message queue) | **RabbitMQ** | Built-in reply-to + correlation-id support |
| "I just need a queue and don't want to think" | **SQS** | Managed, cheap, good enough for 90% of use cases |

---

## 4. Common Pitfalls

1. **"We chose Kafka for a simple task queue."**
   - Overkill. You're paying for ZooKeeper/KRaft ops complexity, partition management, and consumer group rebalancing -- all for a pattern where SQS or RabbitMQ is simpler and cheaper.

2. **"We need exactly-once processing, so we chose Kafka."**
   - Kafka's exactly-once is **within Kafka** (idempotent producer + transactional consumer). End-to-end exactly-once requires idempotent consumers in YOUR application regardless of which queue you use.

3. **"RabbitMQ couldn't handle our throughput."**
   - Likely hitting single-queue bottleneck. RabbitMQ scales throughput by sharding across multiple queues + consistent hashing exchange. But if you truly need millions msg/s, Kafka's architecture is fundamentally better suited.

4. **"SQS ordering is broken."**
   - You're using Standard queues. FIFO queues guarantee ordering within a Message Group ID, but at reduced throughput. Understand the trade-off before complaining.

5. **"We put 5MB payloads in our messages."**
   - All three systems degrade with large messages. Use the **Claim Check pattern**: store payload in S3/blob storage, put a pointer in the message.
