# 即時通訊模式 (Real-time Communication Patterns)

## 1. 綜合比較表格

```
Short Polling:    Client --[request]--> Server --[response]--> Client  (重複)
Long Polling:     Client --[request]--> Server ......(等待)...... --[response]--> Client  (重複)
SSE:              Client --[request]--> Server ===[持續推送事件]===> Client
WebSocket:        Client <==[全雙工持續通訊]==> Server
WebRTC:           Peer A <==[P2P 直連]===> Peer B  (經 signaling server 建立)
Webhook:          Server A --[HTTP POST callback]--> Server B  (事件驅動)
```

| Dimension | Short Polling | Long Polling | SSE | WebSocket | WebRTC | Webhook |
|-----------|--------------|-------------|-----|-----------|--------|---------|
| **方向** | Client → Server | Client → Server | Server → Client | 雙向 (Client ↔ Server) | **雙向 (Peer ↔ Peer)** | Server → Server |
| **連線模式** | 每次新 HTTP request | HTTP request hold 到有資料 | 單一長 HTTP connection | 持久 TCP connection (HTTP Upgrade) | **P2P 直連** (UDP/DTLS/SRTP) | 事件觸發的 HTTP POST |
| **延遲** | Polling interval (1-30s) | 接近即時 | **即時** | **即時** | **最低** (P2P 無中繼) | 接近即時 |
| **Server 資源** | 低 (stateless) | 中 (hold connections) | 中 (hold connections) | 高 (stateful connections) | **最低** (建立後 server 不參與) | 最低 (fire-and-forget) |
| **Client 資源** | 高 (持續發 request) | 中 | 低 | 低 | **高** (encoding/decoding) | N/A |
| **Scalability** | 最簡單 | 中 | 中 | 難 (sticky sessions, pub/sub) | **最好** (server 幾乎零負載) | 最簡單 |
| **瀏覽器支援** | 完全 | 完全 | EventSource API | WebSocket API | **RTCPeerConnection API** | N/A |
| **穿透 NAT/FW** | 完全 | 完全 | 完全 (HTTP) | 可能被阻擋 (Upgrade) | **需要 STUN/TURN** | 完全 |
| **支援 Binary** | 否 (JSON over HTTP) | 否 | **否** (僅 text) | **是** (binary frame) | **是** (audio/video/data) | 否 |
| **斷線重連** | 天然 | 天然 | **自動** (EventSource) | 需自己實作 | 需自己實作 | N/A |
| **典型場景** | 低頻檢查 | 相容性優先的通知 | Dashboard、LLM streaming | 聊天、協作編輯 | **視訊通話、螢幕分享** | 支付回調、CI/CD |

---

## 2. 底層實作差異

### Short Polling

最簡單也最浪費的方式：client 每隔 N 秒發一次 request 詢問「有新資料嗎？」

```
Client                          Server
  │── GET /messages?since=100 ──→ │
  │←── 200 OK, [] (沒有新訊息) ──│     ← 白跑一趟
  │                               │
  │  ... (等 5 秒) ...            │
  │                               │
  │── GET /messages?since=100 ──→ │
  │←── 200 OK, [{id:101, ...}] ──│     ← 終於有了，但等了 0-5 秒
```

**問題：** 90%+ 的 request 回傳空結果。10 萬 client 每 5 秒 poll 一次 = 20K QPS，其中 18K 是浪費的。

**唯一適用場景：** 更新頻率非常低、client 數量少、且完全不想處理長連線（例如：每 30 秒檢查一次部署狀態）。

### Long Polling

Server 收到 request 後 **不立即回應**，hold 住 connection 直到有新資料或 timeout。

```
Client                          Server
  │── GET /messages?since=100 ──→ │
  │                               │  ← Server hold 住，不回應
  │   ... (等待 25 秒) ...        │
  │                               │  ← 新訊息到了！
  │←── 200 OK, [{id:101, ...}] ──│
  │                               │
  │── GET /messages?since=101 ──→ │  ← Client 立即發下一個 long poll
```

**比 short polling 好的地方：**
- 有資料時幾乎即時送達
- 沒資料時不產生大量空 response

**仍然存在的問題：**
- 每次回應後要重新建立 connection
- Server 要 hold 大量 pending connections
- Timeout 後仍有空 response

**定位：** WebSocket/SSE 出現前的主流方案。現在主要用在不支援 WebSocket/SSE 的受限環境，或作為 fallback（Dropbox 的 notification service 就是 long polling）。

### Server-Sent Events (SSE)

使用標準 HTTP connection，server 以 `text/event-stream` 格式持續推送：

```
# Request
GET /events HTTP/1.1
Accept: text/event-stream

# Response (持續推送，不關閉 connection)
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"type": "price_update", "symbol": "AAPL", "price": 175.50}

event: notification
data: {"message": "New order received"}

id: 12345
data: {"type": "heartbeat"}
```

**關鍵特性：**
- **Auto-reconnect**: 瀏覽器原生 `EventSource` API 自動重連，帶上 `Last-Event-ID` 讓 server 知道從哪裡續傳。**這是 SSE 相對 WebSocket 最大的開發體驗優勢。**
- **HTTP 原生**: 不需要 Upgrade，CDN、proxy、firewall 全部相容。
- **僅 Text**: 只支援 UTF-8 text (通常是 JSON)。不支援 binary。
- **單向**: 只有 server → client。Client 要發資料需要用一般 HTTP request。

### WebSocket

建立在 HTTP Upgrade 機制上，升級為持久 TCP connection：

```
# Handshake (HTTP → WebSocket)
GET /chat HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

# 之後雙方可隨時互送 frame（binary 或 text）
```

**關鍵特性：**
- **Full-duplex**: 雙方可同時發送和接收。
- **Binary + Text**: 支援 binary frame（protobuf、檔案）和 text frame（JSON）。
- **低 overhead**: 建立後每個 frame 只有 2-14 bytes header（HTTP 每次 request 上百 bytes）。

**Operational 挑戰：**
- **Connection 管理**: 每個 connection ~10-50KB memory。10 萬 concurrent = 1-5 GB RAM。
- **Load balancer**: 需要 sticky sessions 或 L4 LB（L7 proxy 需特別設定 upgrade）。
- **跨 instance routing**: 需要 pub/sub layer（Redis Pub/Sub、Kafka）。
- **Firewall 相容性**: 某些企業 proxy 會中斷 WebSocket 或不支援 Upgrade。

### WebRTC — Peer-to-Peer 即時通訊

WebRTC 跟上面四種根本不同 — 它是 **peer-to-peer** 的，建立連線後 server 不參與資料傳輸。

```
                  Signaling Server
                 (WebSocket / HTTP)
                /                   \
          offer/answer            offer/answer
          ICE candidates          ICE candidates
              /                       \
         Peer A <=== P2P 直連 ===> Peer B
                 (UDP/DTLS/SRTP)
```

**建立連線的步驟：**

```
1. Peer A 建立 RTCPeerConnection
2. Peer A 建立 offer (SDP) → 透過 Signaling Server 發給 Peer B
3. Peer B 收到 offer → 建立 answer (SDP) → 透過 Signaling Server 發回
4. 雙方交換 ICE candidates (網路路徑資訊)
5. ICE 協商成功 → P2P 直連建立
6. 之後所有 audio/video/data 直接在 peers 之間傳輸，不經 server
```

**三大核心組件：**

| 組件 | 用途 | 說明 |
|------|------|------|
| **Signaling Server** | 交換 SDP offer/answer 和 ICE candidates | 只在建立連線時使用，之後不參與。用 WebSocket 或 HTTP 實作都行 |
| **STUN Server** | NAT 穿越 — 讓 peer 知道自己的 public IP | 免費（Google 提供 stun:stun.l.google.com:19302）。~80% 的情況 STUN 就夠 |
| **TURN Server** | NAT 穿越失敗時的 relay 中繼 | P2P 不通時，流量經 TURN relay。消耗大量頻寬，是 WebRTC infra 的主要成本 |

**為什麼用 UDP 而非 TCP？**

```
Audio/Video 傳輸特性：
  - 即時性 > 可靠性（掉一個 frame 可以接受，延遲不行）
  - TCP 的重傳機制會導致 head-of-line blocking → 卡頓
  - UDP 沒有重傳，丟了就丟了 → 延遲最低

WebRTC 在 UDP 之上加了：
  - DTLS (Datagram TLS) → 加密
  - SRTP (Secure Real-time Transport Protocol) → 音視頻傳輸
  - SCTP (Stream Control Transmission Protocol) → Data Channel（可靠或不可靠，可選）
```

**Data Channel — 不只是音視頻：**

WebRTC 除了 audio/video，還有 **Data Channel** 可以傳任意資料：

```javascript
const dc = peerConnection.createDataChannel("game", {
  ordered: false,      // 不保證順序（低延遲優先）
  maxRetransmits: 0,   // 不重傳（UDP 風格）
});
dc.send(JSON.stringify({ action: "move", x: 100, y: 200 }));
```

Data Channel 可以設定 reliable（類似 TCP）或 unreliable（UDP 風格），適合遊戲、P2P 檔案傳輸等場景。

**WebRTC 的 Scalability 問題：**

```
1:1 通話：完美，P2P 直連
3-4 人：Mesh topology（每個 peer 連所有其他 peer）
  → 3 人 = 每人 2 條連線 = 6 條連線
  → 4 人 = 每人 3 條連線 = 12 條連線
  → CPU/頻寬線性增長

5+ 人：Mesh 不可行
  → 需要 SFU (Selective Forwarding Unit)
     Client 只上傳一份 stream 到 SFU
     SFU 選擇性轉發到其他 participant（不 transcode）
  → 或 MCU (Multipoint Control Unit)
     Server 接收所有 stream → 混合成一個 → 推給每個人
     CPU 密集，延遲較高

                  SFU
               /  |  \
          Peer A  Peer B  Peer C
          (上傳 1 份，下載 N-1 份)
```

| Topology | 人數 | Server 成本 | 延遲 | 複雜度 |
|----------|------|------------|------|--------|
| **Mesh (P2P)** | 2-4 | **零** | **最低** | 低 |
| **SFU** | 5-50 | 中（轉發，不 transcode） | 低 | 中 |
| **MCU** | 50+ | **高**（transcode + mix） | 中 | 高 |

### Webhook

與前面五種不同，Webhook 是 **server-to-server** 的通知機制：

```
你的 Server                    第三方服務 (e.g., Stripe)
  │                               │
  │── 註冊 webhook URL ──────────→│
  │   {"url": "https://你的/callback", "events": ["payment.completed"]}
  │                               │
  │   ... (數天後，有人付款) ...   │
  │                               │
  │←── POST https://你的/callback ─│  ← Stripe 主動 POST
  │    {"event": "payment.completed", "data": {"amount": 99.00}}
  │── 200 OK ─────────────────────→│
```

**設計關鍵問題：**

| 問題 | 解法 |
|------|------|
| Server 掛了怎麼辦？ | 發送方 retry with exponential backoff |
| 怎麼確認是真的發的？ | **Signature verification** — HMAC-SHA256 簽名 |
| 重複收到同一個 event？ | Event ID 做 **idempotency check** |
| 處理太慢？ | Handler 立即回 200，實際處理丟到 message queue |
| 順序保證？ | **沒有。** 需要自己檢查 timestamp 或 sequence number |

---

## 3. WebSocket vs SSE vs WebRTC 決策表

| 場景 | 選擇 | 原因 |
|------|------|------|
| **即時聊天 (chat)** | WebSocket | 雙向低延遲通訊 |
| **多人協作編輯** | WebSocket | 雙向 + 高頻更新 + binary (OT/CRDT ops) |
| **即時通知 / feed 更新** | SSE | Server → client 單向推送，auto-reconnect |
| **股票行情 / dashboard** | SSE | Server push 即可；HTTP 相容好 |
| **串流 LLM 回應 (ChatGPT)** | SSE | Server 逐 token 推送；client 被動接收 |
| **1:1 視訊 / 語音通話** | **WebRTC** | P2P 直連，延遲最低，server 零負載 |
| **螢幕分享** | **WebRTC** | P2P + video stream |
| **多人視訊會議 (5+)** | **WebRTC + SFU** | P2P mesh 不可行，SFU 轉發 |
| **P2P 檔案傳輸** | **WebRTC Data Channel** | 不經 server，大檔案直傳 |
| **即時多人遊戲** | WebSocket 或 WebRTC Data Channel | WebSocket 較成熟；WebRTC 延遲更低但 NAT 穿越麻煩 |
| **線上遊戲 (大廳制)** | WebSocket | 需要 server authoritative state |
| **IoT 裝置推送** | SSE 或 Long Polling | 裝置可能不支援 WebSocket；HTTP 穿透性最好 |

**實務決策建議：**

```
需要傳 audio/video？
  ├── YES → WebRTC（沒有替代方案）
  └── NO → 需要 client → server 即時發送？
           ├── YES → WebSocket
           └── NO → SSE（更簡單、HTTP 原生、auto-reconnect）
```

---

## 4. Capacity Estimation: Connection 管理

| 協議 | 每連線記憶體 | 10 萬 connections | 適合的 scale 手段 |
|------|-------------|-------------------|------------------|
| Short Polling | ~0 (stateless) | 只看 QPS | 水平加 stateless server |
| Long Polling | ~5-10 KB | ~0.5-1 GB | 水平加 server + timeout 調短 |
| SSE | ~5-10 KB | ~0.5-1 GB | 水平加 server（HTTP LB 原生支援） |
| WebSocket | ~10-50 KB | ~1-5 GB | Sticky session + pub/sub layer |
| WebRTC | ~0 on server | **零**（P2P 後 server 不參與） | TURN server 只在 P2P 失敗時用 |

---

## 5. 常見面試陷阱

| 陷阱 | 正解 |
|------|------|
| 「即時 = WebSocket」 | 不一定。如果只需要 server → client push，SSE 更簡單且夠用 |
| 「WebRTC 是 WebSocket 的替代」 | 完全不同。WebRTC 是 P2P 用於 audio/video/data；WebSocket 是 client-server 用於任意雙向資料 |
| 「WebRTC 不需要 server」 | 建立連線需要 Signaling Server + STUN/TURN。只是建立後 data 不經 server |
| 「Long polling 過時了」 | Dropbox notification service 就是用 long polling。在中低頻場景 + HTTP 相容性需求下，它比 WebSocket 簡單很多 |
| 「SSE 不能做雙向」 | SSE 只有 server → client。但 client 可以用普通 HTTP request 發資料，搭配 SSE 接收 = 模擬雙向（不是真正 full-duplex） |
| 「WebSocket 連線是免費的」 | 每個 connection 消耗 memory + file descriptor。百萬連線需要專門的 connection management infra |
