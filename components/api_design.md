# API Design Paradigms: REST vs gRPC vs GraphQL (+ WebSocket / SSE)

## 1. Comprehensive Comparison Matrix

| Dimension | REST | gRPC | GraphQL |
|-----------|------|------|---------|
| **Protocol** | HTTP/1.1 (可用 HTTP/2，但多數部署仍為 1.1) | HTTP/2 (強制) | HTTP/1.1 或 HTTP/2 (transport-agnostic，走 POST) |
| **Data Format** | JSON (文字，human-readable) | Protocol Buffers (二進位，machine-optimized) | JSON (回應)；自定義 query language (請求) |
| **Schema / Contract** | 無原生 schema；依賴 OpenAPI (Swagger) 等外掛規範 | `.proto` 檔案作為 **single source of truth**，強型別 | Schema Definition Language (SDL)，強型別，自帶 introspection |
| **Streaming** | 無原生支援 (需搭配 SSE / WebSocket) | **4 種模式**: Unary, Server Streaming, Client Streaming, Bidirectional | Subscriptions (通常透過 WebSocket 實作) |
| **Browser 原生支援** | **完全支援** (fetch / XMLHttpRequest) | **不直接支援** (需 gRPC-Web proxy 或 Connect protocol) | **完全支援** (就是 HTTP POST + JSON) |
| **Latency (典型值)** | 較高 — JSON serialization 慢、HTTP/1.1 head-of-line blocking、多次 round-trip | **最低** — binary serialization + HTTP/2 multiplexing + header compression | 中等 — 單一 round-trip 但 server 端 resolver 解析有開銷 |
| **Payload Size** | 較大 (JSON 含 key 名稱重複、文字編碼) | **最小** (Protobuf binary encoding，比 JSON 小 3-10x) | 可變 — client 只取所需欄位，但 JSON response 本身仍有文字開銷 |
| **Caching** | **最成熟** — HTTP 原生 cache (ETag, Cache-Control, CDN 友善) | 困難 — binary payload + HTTP/2 multiplexing 使傳統 HTTP cache 失效 | 困難 — 單一 endpoint + POST method = CDN 無法直接 cache；需 persisted queries 或 client-side normalized cache (Apollo) |
| **Error Handling** | HTTP status codes (200, 400, 404, 500…) + 自定義 error body | gRPC status codes (OK, NOT_FOUND, INTERNAL…) + rich error details via `google.rpc.Status` | 永遠回 200 OK；錯誤放在 response body 的 `errors` 陣列中 — 對 monitoring 工具不友善 |
| **Tooling 成熟度** | **最豐富** — Postman, curl, 任何 HTTP client, 所有 monitoring 工具 | 中等 — grpcurl, Buf, BloomRPC；生態系快速成長中 | 成熟 — GraphiQL, Apollo Studio, Relay DevTools；但 server 端 tooling 複雜度高 |
| **Learning Curve** | **最低** — HTTP method + URL + JSON，幾乎所有工程師都懂 | 中高 — 需學 Protobuf、code generation pipeline、HTTP/2 概念 | 中等 — SDL 容易學，但 production-grade 部署 (caching, security, N+1) 需深入理解 |
| **典型 Use Case** | Public-facing API、CRUD 應用、第三方整合 | Internal service-to-service、低延遲微服務、polyglot 環境 | Mobile / SPA 前端、data aggregation layer (BFF)、多種 client 需要不同資料形狀 |

---

## 2. Underlying Implementation Differences

### REST: The Resource-Oriented Architecture

```
Client --> HTTP/1.1 GET /users/123 --> Server
        <-- 200 OK, Content-Type: application/json
            {"id": 123, "name": "Alice", "email": "alice@example.com"}
```

**核心設計原則：**

REST 的理論基礎來自 Roy Fielding 的博士論文，定義了六個 architectural constraints：Client-Server、Stateless、Cacheable、Uniform Interface、Layered System、Code-on-Demand (optional)。實務上，絕大多數自稱 REST 的 API 其實只是 "HTTP JSON API"，真正遵循所有 constraints 的極為罕見。

**HATEOAS — 為什麼沒人用：**

HATEOAS (Hypermedia as the Engine of Application State) 要求 response 內嵌導航連結，讓 client 不需要硬編碼 URL：

```json
{
  "id": 123,
  "name": "Alice",
  "_links": {
    "self": {"href": "/users/123"},
    "orders": {"href": "/users/123/orders"},
    "update": {"href": "/users/123", "method": "PUT"}
  }
}
```

理論上很美：client 只需知道 entry point，之後透過 hypermedia 動態發現所有操作。現實中沒人用的原因：

1. **Client 開發者不想 parse links** — 他們想看文件、硬編碼 URL，用 TypeScript type 確保正確性。
2. **額外 payload 開銷** — 每個 response 都要帶 links metadata，在高流量場景下浪費頻寬。
3. **沒有工具鏈支援** — 沒有主流 frontend framework 會根據 HATEOAS links 動態組裝 UI。
4. **Schema-first 方法勝出** — OpenAPI / Swagger 提供了更實用的 contract-first 開發流程。

**Versioning 策略比較：**

| 策略 | 範例 | 優點 | 缺點 |
|------|------|------|------|
| **URL Path** | `/v1/users`, `/v2/users` | 直觀、CDN 友善、易於路由 | 違反 REST 原則 (同一 resource 不同 URL)；版本爆炸 |
| **Header** | `Accept: application/vnd.api+json;version=2` | 符合 HTTP 規範；URL 保持乾淨 | Client 容易忘記帶 header；難以在瀏覽器直接測試 |
| **Query Param** | `/users?version=2` | 簡單、向後相容 | 不適合 caching (query string 常被 cache 忽略) |

**實務建議：** 大多數團隊選 URL Path versioning，因為認知負擔最低、debugging 最直覺。只有在極度追求 REST 純度時才用 header versioning。

**N+1 Query Problem 與 Over-fetching / Under-fetching：**

這是 REST 最根本的結構性問題：

```
# 取得使用者列表 — 1 次請求
GET /users --> [{id: 1, name: "Alice"}, {id: 2, name: "Bob"}, ...]

# 取得每位使用者的訂單 — N 次請求
GET /users/1/orders
GET /users/2/orders
...
```

- **Over-fetching**: `GET /users/123` 回傳 50 個欄位，但前端只需要 `name` 和 `avatar`。浪費頻寬，尤其在 mobile network 上影響顯著。
- **Under-fetching**: 一個頁面需要 user + orders + recent_reviews，必須發 3 個 request。每個 request 都是一個 network round-trip (intra-DC ~0.5ms，cross-region 50-150ms)。

**常見緩解手段：**
- **Compound resources**: `/users/123?include=orders,reviews` (如 JSON:API sparse fieldsets)
- **BFF (Backend for Frontend)**: 為每種 client 量身打造一個 aggregation layer
- **GraphQL**: 從根本上解決這個問題 (但引入其他問題)

---

### gRPC: The High-Performance RPC Framework

```
Client --> HTTP/2 POST /grpc.UserService/GetUser
           Binary Protobuf payload (field tags + varint encoding)
        <-- HTTP/2 200, trailers with grpc-status
           Binary Protobuf response
```

**HTTP/2 帶來的底層優勢：**

gRPC 強制使用 HTTP/2，這帶來三個關鍵性能改進：

1. **Multiplexing**: 單一 TCP connection 上同時跑多個 request/response stream，消除 HTTP/1.1 的 head-of-line blocking。在微服務間高頻通訊時，省下大量 TCP connection 建立成本 (TCP handshake 1 RTT + TLS handshake 1-2 RTT)。
2. **Header Compression (HPACK)**: HTTP headers 在 connection 生命週期內用動態表壓縮。微服務間的 request 通常有大量重複 header (authorization token, content-type 等)，壓縮效果顯著。
3. **Binary Framing**: HTTP/2 的 frame 是二進位格式，比 HTTP/1.1 的文字 parsing 更高效。

**Protocol Buffers 深入：**

```protobuf
syntax = "proto3";

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc ListUsers (ListUsersRequest) returns (stream User); // Server streaming
}

message User {
  int32 id = 1;       // field number, NOT value
  string name = 2;
  string email = 3;
  repeated Order orders = 4;
}
```

**Binary Encoding 原理：**

Protobuf 不傳 field name，只傳 field number + wire type。一個 `int32 id = 123` 在 JSON 是 `{"id": 123}` (10 bytes)；在 Protobuf 是 `08 7B` (2 bytes) — field tag `08` = field 1, varint type；value `7B` = 123。

**Backward / Forward Compatibility 規則：**
- **新增欄位**: 安全。舊 client 忽略不認識的 field number。
- **刪除欄位**: 安全 (但不能重用 field number)。用 `reserved` 關鍵字防止誤用。
- **改變欄位型別**: 危險。`int32` 改成 `int64` 可以 (wire-compatible)，但改成 `string` 會壞。
- **改變 field number**: 絕對不行。等同於刪舊欄位 + 加新欄位。

**四種通訊模式：**

```
1. Unary RPC (最常見，像一般 HTTP request)
   Client --[1 request]--> Server --[1 response]--> Client

2. Server Streaming (server 推送多筆資料，如即時 feed)
   Client --[1 request]--> Server --[stream of responses]--> Client

3. Client Streaming (client 上傳大量資料，如檔案上傳)
   Client --[stream of requests]--> Server --[1 response]--> Client

4. Bidirectional Streaming (即時雙向通訊，如 chat)
   Client <--[stream]--><--[stream]--> Server
```

**Server Streaming** 特別適合取代 long-polling：server 收到一次 request 後，持續推送 updates，直到結束。比反覆 polling 省下大量無謂的 connection 建立 + 空 response。

**Code Generation Workflow：**

```
user.proto --> protoc compiler --> user.pb.go (Go)
                                   user_pb2.py (Python)
                                   UserServiceGrpc.java (Java)
                                   user_pb.ts (TypeScript via ts-proto)
```

這是 gRPC 最大的生產力優勢之一：schema 變更後，所有語言的 client/server stub 自動重新生成，type safety 由編譯器保證。在 polyglot 微服務架構中，這比維護多語言的 REST client SDK 高效得多。

**Deadline / Timeout Propagation：**

gRPC 的 deadline 會沿著 call chain 自動傳播：

```
Client (deadline: 5s) --> Service A (remaining: 4.8s) --> Service B (remaining: 4.2s)
```

如果 Service B 在剩餘 deadline 內無法完成，它會立即回傳 `DEADLINE_EXCEEDED`，而不是浪費資源繼續處理。這在深度 call chain 中防止 cascading timeout failure 至關重要。

**Metadata：**

gRPC metadata 等同於 HTTP headers，用於傳遞 cross-cutting concerns：authentication token、request ID (distributed tracing)、routing hints。分為 initial metadata (隨 request 發送) 和 trailing metadata (隨 response 結束時發送，常用於回傳 server-side metrics)。

---

### GraphQL: The Client-Driven Query Language

```
Client --> POST /graphql
           {"query": "{ user(id: 123) { name orders { total } } }"}
        <-- 200 OK
            {"data": {"user": {"name": "Alice", "orders": [{"total": 99.50}]}}}
```

**核心架構：**

GraphQL 的設計哲學是「讓 client 決定需要什麼資料」。Server 定義完整的 data graph，client 從中挑選需要的子集。

**Schema Definition Language (SDL)：**

```graphql
type User {
  id: ID!
  name: String!
  email: String!
  orders(first: Int, after: String): OrderConnection!
  reviews: [Review!]!
}

type Query {
  user(id: ID!): User
  users(filter: UserFilter): [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
}

type Subscription {
  orderStatusChanged(userId: ID!): Order!
}
```

SDL 提供了 introspection 能力：client 可以在 runtime 查詢 schema 結構。這讓 GraphiQL / Apollo Explorer 等工具能自動產生文件和 autocomplete，developer experience 極佳。

**Resolver 架構與 N+1 問題：**

每個 field 對應一個 resolver function。GraphQL engine 逐層解析 query tree：

```
Query.user(id: 123)            --> 1 DB query: SELECT * FROM users WHERE id = 123
  User.name                     --> 從 parent 結果直接取值 (no DB query)
  User.orders                   --> 1 DB query: SELECT * FROM orders WHERE user_id = 123
    Order.items                 --> N DB queries: SELECT * FROM items WHERE order_id = ?
```

問題出在 **Order.items** resolver：如果有 10 筆 orders，它會對每筆 order 各執行一次 DB query，產生 N+1 問題。

**DataLoader 解法：**

DataLoader 是一個 batching + caching utility，在同一個 event loop tick 內收集所有 key，合併成一次批次查詢：

```
# 沒有 DataLoader:
SELECT * FROM items WHERE order_id = 1
SELECT * FROM items WHERE order_id = 2
... (N 次)

# 有 DataLoader:
SELECT * FROM items WHERE order_id IN (1, 2, 3, ..., 10)  -- 1 次
```

DataLoader 的 cache 是 per-request scope (不是 global cache)。它解決的是 **同一個 request 內** 的重複查詢。

**Query Complexity 與 Depth Limiting (Security)：**

GraphQL 暴露了一個 REST 不存在的攻擊面：client 可以構造任意深度和複雜度的 query：

```graphql
# 惡意 query — 指數級 explosion
{
  user(id: 1) {
    friends {
      friends {
        friends {
          friends {
            name
            orders {
              items {
                reviews { ... }
              }
            }
          }
        }
      }
    }
  }
}
```

**防禦策略：**

| 策略 | 做法 | 適用場景 |
|------|------|----------|
| **Depth Limiting** | 拒絕超過 N 層嵌套的 query (通常 7-10 層) | 基本防護，所有 production 環境必須啟用 |
| **Complexity Scoring** | 為每個 field 賦予成本分數，加總超過閾值則拒絕 | 精細控制；list field 的成本 = 子 field 成本 * estimated count |
| **Persisted Queries** | Client 只能發送預先註冊的 query hash，不接受 arbitrary query | 最安全；適合 first-party client (mobile app) |
| **Rate Limiting** | 基於 complexity score 的 rate limiting (而非 request count) | 結合 complexity scoring 使用 |
| **Timeout** | Server-side query execution timeout | 最後防線；防止 slow resolver 拖垮系統 |

**Subscriptions：**

GraphQL Subscription 通常透過 WebSocket (使用 `graphql-ws` protocol) 實作。Client subscribe 一個 query，server 在資料變更時推送 update：

```
Client --> WebSocket --> {"type": "subscribe", "payload": {"query": "subscription { orderStatusChanged(userId: 1) { status } }"}}
Server --> WebSocket --> {"type": "next", "payload": {"data": {"orderStatusChanged": {"status": "SHIPPED"}}}}
```

注意：Subscription 的 scaling 是 GraphQL 最大的 operational 挑戰之一。每個 subscription 是一個 long-lived connection，需要 connection 管理、heartbeat、reconnection logic，以及 pub/sub backend (Redis, Kafka) 來在多個 server instance 間同步事件。

---

### Real-time Communication: WebSocket vs Server-Sent Events (SSE)

```
WebSocket:
Client <==full-duplex==> Server    (TCP 上的雙向 binary/text frames)

SSE:
Client <--server push-- Server    (HTTP 上的單向 text/event-stream)
```

**WebSocket 深入：**

WebSocket 建立在 HTTP Upgrade 機制上：

```
# Handshake (HTTP → WebSocket)
GET /chat HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Handshake 之後，connection 升級為持久 TCP connection，client 和 server 可以隨時互送 frame。

**關鍵特性：**
- **Full-duplex**: 雙方可同時發送和接收，無需等待對方。
- **Binary + Text**: 支援 binary frame (適合 protobuf、binary 檔案) 和 text frame (適合 JSON)。
- **低 overhead**: 連建立後，每個 frame 只有 2-14 bytes 的 header (相比 HTTP 每次 request 都帶上百 bytes header)。
- **Connection lifecycle**: Open → Message exchange → Ping/Pong heartbeat → Close。需要處理 reconnection、buffering、backpressure。

**Operational 挑戰：**
- **Connection 管理**: 每個 WebSocket 是一個長連線，消耗 server memory (~10-50KB per connection)。10 萬 concurrent connections = ~1-5 GB RAM 僅用於 connection state。
- **Load balancer 設定**: 需要 sticky sessions 或 L4 load balancing (L7 proxy 如 Nginx 需要特別設定 `proxy_pass` + `upgrade`)。
- **Scaling**: 跨 server instance 的 message routing 需要 pub/sub layer (Redis Pub/Sub、Kafka)。
- **Firewall / Proxy 相容性**: 某些企業 proxy 和 firewall 會中斷 WebSocket connection 或不支援 Upgrade。

**Server-Sent Events (SSE) 深入：**

SSE 使用標準 HTTP connection，server 以 `text/event-stream` 格式持續推送事件：

```
# Request
GET /events HTTP/1.1
Accept: text/event-stream

# Response (持續推送，不關閉 connection)
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"type": "price_update", "symbol": "AAPL", "price": 175.50}

event: notification
data: {"message": "New order received"}

id: 12345
data: {"type": "heartbeat"}
```

**關鍵特性：**
- **Auto-reconnect**: 瀏覽器原生 `EventSource` API 自動在斷線後重連，並帶上 `Last-Event-ID` header 讓 server 知道從哪裡續傳。這是 SSE 相對 WebSocket 最大的開發體驗優勢。
- **HTTP 原生**: 不需要 Upgrade，走標準 HTTP — CDN、proxy、firewall 全部相容。
- **僅 Text**: 只支援 UTF-8 text (通常是 JSON)。不支援 binary。
- **單向**: 只有 server → client。Client 要發資料需要用一般 HTTP request。

**WebSocket vs SSE 決策：**

| 場景 | 選擇 | 原因 |
|------|------|------|
| **即時聊天 (chat)** | WebSocket | 需要雙向低延遲通訊 |
| **多人協作編輯** | WebSocket | 雙向 + 高頻率更新 + 可能需要 binary (OT/CRDT ops) |
| **即時通知 / feed 更新** | SSE | Server → client 單向推送，auto-reconnect 省事 |
| **股票行情 / dashboard** | SSE | Server push 即可；HTTP 相容性好，穿越企業 firewall |
| **線上遊戲** | WebSocket | 雙向 + 低延遲 + binary frame 支援 |
| **串流 LLM 回應 (如 ChatGPT)** | SSE | Server 端逐 token 推送；client 只需被動接收 |

**實務建議：** 如果你的 use case 只需要 server → client push，**優先選擇 SSE**。它比 WebSocket 簡單得多 (不需處理 Upgrade、不需自己實作 reconnect、不需擔心 proxy 相容)，而且效能足夠應付大多數場景。只有在確定需要 full-duplex 或 binary frame 時才升級到 WebSocket。

---

## 3. Architect's Decision Tree

```
START: "我需要設計一個 API"
│
├── Q1: 這是 internal service-to-service 通訊嗎？
│   ├── YES --> 需要 streaming (server push / bidirectional) 嗎？
│   │   ├── YES --> gRPC (4 種 streaming 模式原生支援)
│   │   └── NO  --> gRPC (binary + HTTP/2 = 最高效能 + code generation = 最高生產力)
│   └── NO --> continue
│
├── Q2: 這是 public-facing API，需要第三方開發者整合嗎？
│   ├── YES --> REST + OpenAPI
│   │          (universally understood, 工具鏈最成熟, 最低整合門檻)
│   └── NO --> continue
│
├── Q3: Client 端有多種 data access pattern？
│        (Mobile 要精簡資料, Web 要完整資料, 不同頁面要不同 field 組合)
│   ├── YES --> GraphQL
│   │          (client-driven query 解決 over/under-fetching)
│   └── NO --> continue
│
├── Q4: 效能是最高優先級？(Ultra-low latency, 高 throughput)
│   ├── YES --> gRPC
│   │          (Protobuf binary + HTTP/2 = 比 REST JSON 快 2-5x)
│   └── NO --> continue
│
├── Q5: 需要 real-time server → client push？
│   ├── YES --> 需要 client → server 嗎？
│   │   ├── YES --> WebSocket
│   │   └── NO  --> SSE (更簡單，HTTP 原生)
│   └── NO --> continue
│
└── Default: REST
    (最簡單、最 well-understood、最安全的選擇)
```

### Quick Reference: Absolute Rules

| Scenario | Pick | Why |
|----------|------|-----|
| Internal microservice mesh (polyglot) | **gRPC** | Code generation + type safety 跨語言；binary 省頻寬 |
| Public API for third-party developers | **REST** | 所有開發者都懂 HTTP + JSON；Swagger 文件即開即用 |
| Mobile app + Web app 共用 backend | **GraphQL** | 不同 client 取不同 field set；一次 request 拿到所有需要的資料 |
| Real-time bidirectional (chat, game) | **WebSocket** | Full-duplex + low overhead per frame |
| Real-time unidirectional (notifications, streaming) | **SSE** | Auto-reconnect + HTTP 相容 + 簡單 |
| Latency-critical internal path | **gRPC** | Protobuf + HTTP/2 = 最低序列化 + 傳輸開銷 |
| BFF (Backend for Frontend) aggregation layer | **GraphQL** | 自然扮演 data aggregation 角色；federation 可組合多個 service |

### Nuances 與例外

**"gRPC 用於 internal" 的例外：**
- 如果團隊全部用同一語言、服務數量少 (<10)、不需要 streaming，REST 的認知負擔可能更低。gRPC 的 build pipeline (protoc + plugin) 有 setup cost。
- 如果需要精細的 HTTP caching (例如 read-heavy 的配置服務)，REST 的 cache 生態更成熟。

**"GraphQL 用於 mobile" 的例外：**
- 如果 mobile client 只有一個團隊維護、資料需求固定，BFF + REST 可能比 GraphQL 更簡單。GraphQL 的價值在 client 端需求多樣化時才充分體現。
- GraphQL 的 client library (Apollo, Relay) 有學習曲線且增加 bundle size。對 bundle-sensitive 的 mobile app 需要評估。

**"REST 用於 public API" 的例外：**
- GitHub、Shopify、Yelp 等都有 public GraphQL API。如果你的 API consumer 需要靈活查詢大量關聯資料 (如 GitHub 的 repo → issues → comments → author)，GraphQL 確實比 REST 更好。但你需要投入更多在 rate limiting 和 security 上。

---

## 4. Common Pitfalls

### REST 常見陷阱

1. **Chatty APIs (過多 round-trips)**
   - 症狀：前端一個頁面要打 5-10 個 API call。
   - 根因：過度遵循 "one resource per endpoint" 原則，忽略實際使用場景。
   - 解法：引入 compound endpoints (`/users/123?include=orders,reviews`)、BFF layer、或考慮 GraphQL。

2. **命名不一致**
   - `/getUsers` vs `/user/list` vs `/users` — 同一個 API 三種風格。
   - 規範：用名詞複數 (`/users`, `/orders`)、HTTP method 表達動作 (GET = 讀, POST = 建, PUT = 全量更新, PATCH = 部分更新, DELETE = 刪)。
   - 非 CRUD 操作：用子資源 (`POST /orders/123/cancel`) 或 action endpoint (`POST /users/123/actions/deactivate`)。

3. **忽略 Pagination**
   - `GET /users` 回傳 10 萬筆資料，直接打爆 client 和 server 的記憶體。
   - 方案：Cursor-based pagination (`?after=cursor_abc&limit=20`) 優於 Offset-based (`?page=3&per_page=20`)，因為 offset 在資料變動時會漏/重複資料，且 `OFFSET N` 在大 N 時 DB 效能差。

4. **不回傳有意義的 error response**
   - `500 Internal Server Error` + 空 body，讓 client 完全無法 debug。
   - 規範：統一 error format，例如 RFC 7807 Problem Details：
   ```json
   {
     "type": "https://api.example.com/errors/insufficient-funds",
     "title": "Insufficient Funds",
     "status": 422,
     "detail": "Account balance is $10.00, but transaction requires $25.00.",
     "instance": "/transactions/abc123"
   }
   ```

### gRPC 常見陷阱

1. **忘記 Browser 不直接支援 gRPC**
   - gRPC 依賴 HTTP/2 trailers，瀏覽器的 fetch API 不支援。
   - 解法：
     - **gRPC-Web**: Envoy proxy 做 translation (server streaming 支援、但無 client/bidirectional streaming)。
     - **Connect Protocol** (by Buf): 同一個 protobuf service 同時提供 gRPC + gRPC-Web + HTTP JSON endpoint。推薦新專案使用。
     - **API Gateway**: 在 edge 用 REST/GraphQL 接前端，內部用 gRPC。

2. **Protobuf Schema Evolution 錯誤**
   - **重用已刪除的 field number**: 舊 client 會把新 field 的資料用舊 field 的 type 解析 → 資料損壞。永遠用 `reserved` 標記。
   - **改變 field type**: `int32` → `string` = binary incompatible。需要新增 field + deprecate 舊 field。
   - **Required fields** (proto2): 永遠不要用。新增 required field = 所有舊 client 立即壞。Proto3 移除 required 是有原因的。

3. **不設定 Deadline**
   - 沒有 deadline 的 gRPC call 會無限等待。在分散式系統中，一個 slow downstream service 可以 cascading block 整個 call chain。
   - 規範：**每個 gRPC call 都必須設定 deadline**。在 service mesh 中，可以在 middleware 層統一注入。

4. **忽略 Load Balancing 的複雜度**
   - gRPC 使用 HTTP/2 long-lived connections。L4 load balancer 只在 connection 建立時分配 backend，之後所有 request 都走同一條 connection → 負載不均。
   - 解法：使用 L7 load balancing (Envoy, Linkerd) 在 request 層面做分配，或使用 client-side load balancing (gRPC 內建 `round_robin` / `pick_first` policy)。

### GraphQL 常見陷阱

1. **Unbounded Query Depth — 沒有防護就上線**
   - 惡意 client 可以構造指數級複雜 query，一個 request 就能壓垮 server。
   - **必做**: Depth limiting + complexity scoring。沒有例外。

2. **沒有 Caching 策略**
   - GraphQL 用 POST + 單一 endpoint，HTTP cache 完全無法生效。
   - 解法階梯：
     - **Client-side normalized cache** (Apollo Client InMemoryCache): 以 `__typename:id` 為 key 做 entity-level caching。
     - **Persisted Queries**: Client 發 query hash 而非完整 query → 可以 GET + CDN cache。
     - **Response caching**: Server 端根據 query + variables 做 cache (如 `@cacheControl` directive)。

3. **Complexity Explosion — Schema 設計失控**
   - 起初很美好：一個 unified graph。隨著業務成長，schema 膨脹到上千個 type，resolver 互相 depend，任何改動都可能 break downstream consumer。
   - 解法：
     - **Schema governance**: 明確定義 ownership (哪個 team 負責哪個 type)。
     - **Federation / Subgraph**: 用 Apollo Federation 或 Schema Stitching 將 schema 拆分到各個 service，各自管理。
     - **Breaking change detection**: 用 `graphql-inspector` 或 Apollo Studio 的 schema check 在 CI 中偵測 breaking change。

4. **N+1 Problem 在 Resolver 層被忽略**
   - 很多團隊只寫 naive resolver，完全不用 DataLoader。在小資料量時沒感覺，上到 production 立刻 DB query 爆炸。
   - **規則：任何 resolver 內做 DB/API call 的，都必須透過 DataLoader。** 這應該是 code review checklist 的 mandatory item。

---

## 5. Capacity Planning

### Throughput 基準數字

| Stack | Typical Throughput | Bottleneck |
|-------|-------------------|------------|
| **REST (Nginx + Node.js)** | ~10K-50K req/s per Nginx instance | JSON parsing, event loop, DB I/O |
| **REST (Nginx + Go)** | ~50K-100K req/s per instance | 主要受 DB I/O 限制；Go 的 goroutine 處理 concurrent request 高效 |
| **gRPC (Go)** | ~100K-200K req/s per instance (unary) | Protobuf 序列化極快；HTTP/2 multiplexing 省 connection overhead |
| **gRPC vs REST** | **gRPC 約 2-5x 更高效** | Binary serialization + header compression + multiplexing |
| **GraphQL** | **高度不確定 — 取決於 query complexity** | 一個簡單 query 可能 = 1 DB call；一個複雜 nested query 可能 = 100+ DB calls |

### Payload Size 比較

以一個典型的 User object (id, name, email, 3 addresses, 5 orders) 為例：

| Format | Approximate Size | 說明 |
|--------|-----------------|------|
| **JSON (REST)** | ~800 bytes | 含 key 名稱重複、引號、空格 |
| **JSON (GraphQL, 只取 name + email)** | ~80 bytes | Client 指定 field，省掉不需要的資料 |
| **Protobuf (gRPC, 全部 field)** | ~200-250 bytes | Binary encoding，無 key 名稱，varint 壓縮整數 |

**關鍵洞察：**
- REST → GraphQL 的 payload 改善來自 **減少不必要的 field** (application-level 優化)。
- REST → gRPC 的 payload 改善來自 **更高效的序列化格式** (encoding-level 優化)。
- 兩者可以疊加：gRPC + 只傳必要 field = 最小 payload。但 gRPC 不像 GraphQL 那樣讓 client 動態選擇 field (schema 是固定的)。

### Latency 拆解

一個典型的 API call 延遲組成：

```
Total Latency = Network RTT + TLS Handshake + Serialization + Server Processing + Deserialization

REST (HTTP/1.1, JSON):
  Network RTT:      0.5ms (intra-DC) or 50-150ms (cross-region)
  TLS Handshake:    1-2 RTT (每個新 connection)
  Serialization:    0.1-1ms (JSON.stringify, 依 payload 大小)
  Server Processing: 1-100ms (依業務邏輯)
  Deserialization:   0.1-1ms (JSON.parse)

gRPC (HTTP/2, Protobuf):
  Network RTT:      0.5ms (intra-DC) — connection reuse, 不需重複 handshake
  TLS Handshake:    0ms (connection 已建立, multiplexing)
  Serialization:    0.01-0.1ms (Protobuf encode, 比 JSON 快 ~10x)
  Server Processing: 1-100ms (依業務邏輯 — 這部分不變)
  Deserialization:   0.01-0.1ms (Protobuf decode)

GraphQL:
  Network RTT:      0.5ms (intra-DC) — 單一 round-trip (這是最大優勢)
  Serialization:    0.1-1ms (JSON)
  Server Processing: 1-500ms (!!!) — 取決於 query complexity, resolver chain, DataLoader 是否生效
  Deserialization:   0.1-1ms (JSON)
```

**關鍵洞察：**
- 在 server processing 被 DB I/O 主導的場景 (大多數 CRUD app)，REST vs gRPC 的序列化差異幾乎可忽略。gRPC 的優勢在 **高頻率、小 payload** 的 internal call 中才充分顯現。
- GraphQL 的「一次 round-trip」看似省延遲，但 **server 端的延遲可能爆增** — 一個 nested query 觸發大量 resolver → DB query chain。Net effect 不一定比 REST 的多次 parallel request 快。
- **真正的 latency killer 是 Network RTT**。在 cross-region 場景 (50-150ms per round-trip)，GraphQL 的「減少 round-trip 次數」優勢最明顯。在 intra-DC (0.5ms RTT)，REST 打 5 個 parallel request 也就多 0.5ms。

### Scaling 考量

| Paradigm | Horizontal Scaling 特性 | 注意事項 |
|----------|------------------------|----------|
| **REST** | **最簡單** — stateless, 任何 load balancer 即可 | 無特殊考量 |
| **gRPC** | 需要 L7 load balancing 或 client-side LB | HTTP/2 long-lived connection 使 L4 LB 不均；新 deploy 時舊 connection 不會自動遷移 |
| **GraphQL** | 與 REST 相同 (走 HTTP POST) | Query 間的 resource consumption 差異巨大 — 一個 complex query 可能比 100 個 simple query 耗更多資源。需要 per-query resource tracking |
| **WebSocket** | 需要 connection affinity / sticky session | 每個 connection 消耗 server memory；跨 instance 通訊需 pub/sub layer |
| **SSE** | 與 WebSocket 類似但更簡單 | HTTP connection keep-alive；大多數 load balancer 原生支援 |
