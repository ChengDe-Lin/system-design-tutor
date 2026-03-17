# Load Balancer: L4 vs L7、演算法、與產品比較

## 1. L4 vs L7 Comparison Matrix

| Dimension | L4 Load Balancer | L7 Load Balancer |
|-----------|-----------------|-----------------|
| **OSI Layer** | Transport Layer (TCP/UDP) | Application Layer (HTTP/HTTPS/gRPC/WebSocket) |
| **Protocol Awareness** | 僅看到 IP + Port + TCP flags，不解析 payload | 完整解析 HTTP headers、URL path、cookies、request body |
| **Routing Decisions** | 基於 source/destination IP、port、TCP connection 狀態 | 基於 URL path (`/api/v2/*`)、Host header、HTTP method、cookie、header value、query parameter |
| **SSL Termination** | 通常做 **SSL passthrough**（不解密，直接轉發加密流量）；部分支援 TLS termination | **SSL termination** 是標準做法；可檢查解密後的 HTTP 內容再路由 |
| **WebSocket Support** | 天然支援（只是 TCP connection，LB 不需要理解協議） | 需要明確支援 HTTP Upgrade mechanism；大多數現代 L7 LB 已支援，但需正確配置 `Connection: Upgrade` header forwarding |
| **Performance** | **極高**——不解析 payload，kernel-space 處理（IPVS 可達 **~10M concurrent connections**）；延遲增加 < 50μs | 較低——需要在 user-space 解析 HTTP，每個 request 都需 header parsing；延遲增加 ~0.5-2ms |
| **Flexibility** | 低——無法基於內容做路由決策 | **極高**——可實現 canary deployment、A/B testing、rate limiting per endpoint、request rewriting |
| **Connection Multiplexing** | 不支援——1 client connection = 1 backend connection | 支援 **HTTP/2 multiplexing** + **connection pooling**（1000 client connections 可共用 10 backend connections） |
| **Use Cases** | 高吞吐 TCP 服務（database proxy、game server、MQTT broker）、non-HTTP 協議、前置 L7 LB 的入口層 | Web application、API Gateway、microservice routing、gRPC load balancing |

### 核心差異的本質

L4 和 L7 的根本區別不在於「功能多寡」，而在於 **LB 是否打開信封讀信**。L4 LB 像郵局分揀員——只看信封上的地址（IP + Port）決定送去哪裡，速度極快但不知道信的內容。L7 LB 像一位秘書——拆開信封、讀懂內容、根據內容分派給不同部門，處理速度較慢但決策精準。

這個差異導致一個重要的架構推論：**在超大規模系統中，通常 L4 + L7 分層部署**。L4 在前端承接海量 TCP 連線並分散到多台 L7 LB，L7 LB 再根據 HTTP 內容做精細路由。Google 的架構就是 Maglev (L4) → Envoy (L7)。

---

## 2. Load Balancing Algorithms

### Round Robin

**機制：** 依序將請求分配給 Server 1 → Server 2 → Server 3 → Server 1 → ...，以簡單的計數器 `next = (current + 1) % N` 實作。

| Pros | Cons |
|------|------|
| 實作極其簡單，O(1) 時間 | 假設所有 server 能力相同，無法處理異質硬體 |
| 無需維護任何狀態 | 不考慮 server 目前負載，可能將 request 送到已過載的 server |
| 公平分配——長期而言每台 server 收到相同數量的請求 | 若 request 處理時間差異大（有些 10ms、有些 2s），會造成負載不均 |

**適用場景：** Stateless service，且所有 server 規格相同、request 處理時間差異小（例如 CDN edge node serving static assets）。

---

### Weighted Round Robin

**機制：** 每台 server 賦予一個 weight 值（例如 Server A: 5, Server B: 3, Server C: 2），表示分配比例。在 10 個 request 的週期內，A 收到 5 個、B 收到 3 個、C 收到 2 個。進階實作使用 **Smooth Weighted Round Robin**（Nginx 使用此變體），避免突發性地連續把請求全送到高 weight server。

| Pros | Cons |
|------|------|
| 可處理異質硬體（8-core vs 4-core server） | Weight 需要手動設定或透過外部系統動態調整 |
| 仍然簡單且高效 | 不反映即時負載——weight 是靜態的 |
| Nginx 的 Smooth WRR 分散效果極佳 | 若 server 效能因 GC、noisy neighbor 等因素波動，weight 無法自動適應 |

**適用場景：** 混合規格的 server fleet，或 canary deployment 時給新版本較低 weight（例如 weight=1 vs 舊版 weight=99）。

---

### Least Connections

**機制：** 追蹤每台 backend server 的 **active connection 數量**，新請求送到當前 active connections 最少的 server。實作上用 min-heap 或簡單遍歷（server 數量通常 < 100，線性掃描即可）。

| Pros | Cons |
|------|------|
| 自動適應 request 處理時間差異——慢 request 的 server connection 累積，LB 自然避開 | 不考慮 server 的絕對能力（8-core 和 2-core server 可能有相同 connection 數） |
| 適合 long-lived connections（WebSocket、gRPC streaming） | 對突發建立的短連線反應較慢（connection 尚未反映真實負載） |
| 比 Round Robin 更能避免 hotspot | 需要 LB 維護每台 server 的 connection 狀態 |

**適用場景：** 處理時間差異大的 API（例如搜尋服務，simple query 10ms、complex aggregation 5s）、WebSocket server。

**變體：Weighted Least Connections** —— 計算 `active_connections / weight`，結合了硬體差異與即時負載。HAProxy 的 `leastconn` 就是此種實作。

---

### Least Response Time

**機制：** 追蹤每台 server 的 **平均 response time**（通常用 exponential moving average 平滑），新請求送到 response time 最低的 server。有些實作結合 active connections：`score = response_time * active_connections`。

| Pros | Cons |
|------|------|
| 最能反映 server 的真實健康狀態與效能 | 需要持續監測與計算 response time，增加 LB 複雜度 |
| 自動適應 GC pause、CPU throttling、disk I/O 瓶頸 | 歷史 response time 不一定預測未來（例如 server 剛完成 GC，response time 暫時降低） |
| 能偵測到 Least Connections 無法發現的問題（server connection 少但每個都很慢） | 冷啟動問題——新加入的 server 沒有 response time 數據，需要 warmup 機制 |

**適用場景：** 對 latency 敏感的即時服務，backend server 效能不一致或有波動（例如 shared cluster 上的 microservice）。

---

### IP Hash

**機制：** 取 client IP 做 hash，`server = hash(client_ip) % N`。同一個 client IP 的所有請求永遠路由到同一台 server，實現 **session affinity（sticky sessions）**。

| Pros | Cons |
|------|------|
| 無需外部 session storage（Redis / DB）即可實現 session persistence | Server 增減時，hash 值大量重分配（N→N+1 時約 `N/(N+1)` 的映射改變） |
| 實作簡單，O(1) routing | NAT 後面的大量使用者共用同一 IP，造成 hotspot |
| 對 stateful 應用（如購物車存在 server memory）有效 | 破壞 horizontal scaling 的核心假設——server 不再是 interchangeable |

**適用場景：** 遺留系統需要 session stickiness 且無法引入 centralized session store；特定 caching 場景（同一 client 的 request 打同一台 cache server）。

**警告：** 在現代架構中，IP Hash sticky session 通常是一個 anti-pattern。應優先使用 **stateless design + external session store**（Redis / DynamoDB）。

---

### Consistent Hashing

**機制：** 將 hash space 組成一個環（通常 0 ~ 2^32-1），server 和 request key 都映射到環上的位置。每個 request 從其 hash 位置沿順時針方向找到第一台 server，即為目標 server。

**關鍵創新——Virtual Nodes：** 每台實體 server 在環上放置多個 virtual node（通常 100~200 個），解決兩個問題：(1) server 少時分佈不均；(2) server 增減時負載重分配更平滑。

```
                        Consistent Hashing Ring (0 ~ 2^32 - 1)

                              0 / 2^32
                               │
                          ─────●─────
                       ╱       │       ╲
                    ╱          │          ╲
                 ╱             │             ╲
              S1-v2 ●          │              ● S3-v1
              ╱                │                ╲
           ╱                   │                   ╲
         ╱                     │                     ╲
        │                      │                      │
        │        Key "user:42" │                      │
        │              ○─ ─ ─ ─┘                      │
        │              │ (hash lands here,            │
   S2-v1 ●             │  walks clockwise             ● S1-v1
        │              │  → routes to S3-v1)          │
        │              │                              │
         ╲             ▼                             ╱
          ╲            ● S3-v2                      ╱
            ╲                                     ╱
              ╲                                 ╱
                ╲           ● S2-v2           ╱
                  ╲         │              ╱
                    ╲       │           ╱
                       ╲    │       ╱
                          ──●─────
                          S1-v3

    S1, S2, S3 = 3 台實體 server
    S1-v1, S1-v2, S1-v3 = Server 1 的 3 個 virtual nodes (實務上用 100~200 個)
    ○ = Request key hash position
    → = 沿順時針找到第一個 virtual node，即為路由目標

    當 S2 被移除時：
    - 只有原本映射到 S2-v1, S2-v2 的 key 需要重新分配
    - 這些 key 順時針找到下一台 server（S3 或 S1）
    - 其餘 key 的映射完全不受影響
    - 理論上只有 K/N 的 key 需要移動（K=總 key 數, N=server 數）
```

| Pros | Cons |
|------|------|
| Server 增減時只有 **K/N** 的 key 需要重新映射（K=key 數, N=server 數） | 實作比簡單 hash 複雜，需維護 sorted ring（通常用 balanced BST 或 sorted array + binary search） |
| Virtual nodes 確保負載均勻分佈 | Virtual node 數量需調參——太少分佈不均，太多佔記憶體且查找變慢 |
| 非常適合 distributed cache（增減節點時 cache hit rate 下降最小） | 仍然不考慮 server 的即時負載，僅保證映射穩定性 |
| 業界廣泛使用：Amazon DynamoDB、Apache Cassandra、Memcached client | Hotspot key 問題仍存在（某些 key 的訪問頻率極高） |

**適用場景：** Distributed cache (Memcached, Redis cluster)、distributed storage (DynamoDB, Cassandra)、任何需要在節點變動時最小化資料搬移的場景。

**數字感：** 使用 150 virtual nodes per server 時，10 台 server 的環上有 1500 個 virtual node，load standard deviation 約 ~10%。增加到 500 virtual nodes 可降至 ~5%，但記憶體佔用從 ~60KB 增加到 ~200KB（通常不是瓶頸）。

---

### Random with Two Choices (Power of Two)

**機制：** 隨機選擇 **2 台** server，比較兩者的當前負載（active connections 或 queue depth），將請求送到負載較低的那台。

**為什麼這驚人地有效？**

這背後是 Michael Mitzenmacher 在 1996 年證明的 **"The Power of Two Choices"** 理論。關鍵洞察：

- **純隨機選擇 1 台 server：** 最繁忙 server 的負載為 `O(log N / log log N)`（N = server 數量）。當 N = 100 時，最大負載可能是平均值的 ~4-5 倍。
- **隨機選 2 台，挑負載低的：** 最繁忙 server 的負載降為 `O(log log N)`——**指數級改善**。N = 100 時，最大負載僅為平均值的 ~1.5 倍。

直覺解釋：純隨機只知道「平均而言」分佈均勻，但不知道此刻哪台 server 已過載。隨機選 2 台後比較，等於用極低成本獲得了「局部負載資訊」，這足以避免最差情況。而且——選 3 台、4 台的邊際改善遠小於從 1 台到 2 台的飛躍。

| Pros | Cons |
|------|------|
| 實作極簡（2 次隨機 + 1 次比較），接近 O(1) | 比 Least Connections 略差（Least Connections 有全局資訊） |
| 不需要全局狀態（不需知道所有 server 的負載，只需查詢 2 台） | 需要能快速查詢 server 的當前負載 |
| **在分散式場景下優於 Least Connections**——多個 LB 各自做 Least Connections 會造成 herd effect（全部衝向同一台最空的 server），Power of Two 的隨機性避免了這個問題 | 理論最優性依賴於 request 到達率和服務時間的假設 |
| Envoy 預設使用此演算法（稱為 `LEAST_REQUEST` with `choice_count=2`） | 對只有 2-3 台 server 的場景退化為 Least Connections |

**適用場景：** 大規模 microservice mesh（數十台以上 backend instances）、多層 LB 架構（避免 herd effect）。Envoy proxy 在 service mesh 中的預設選擇就是此演算法。

---

## 3. Product Comparison

| Dimension | **Nginx** | **HAProxy** | **AWS ALB** | **AWS NLB** | **Envoy** |
|-----------|-----------|-------------|-------------|-------------|-----------|
| **L4 / L7** | 主要 L7；`stream` module 支援 L4 | **L4 + L7 均強** | 純 L7 | 純 L4 | **L4 + L7 均強** |
| **Throughput** | ~50K concurrent connections per worker；多 worker 可達 ~500K+ | **單 process 可達 ~300K concurrent connections**（event-driven, zero-copy splice）；企業級部署可達 2M+ | AWS managed，自動擴展至數百萬 RPS（背後是多台 EC2） | **數百萬 PPS**（packets per second），基於 AWS Hyperplane，kernel-bypass | ~50K concurrent connections per worker；設計重點是 sidecar 場景（每 pod 一個） |
| **Config Model** | **靜態設定檔** (`nginx.conf`)，修改後需 `nginx -s reload`（graceful reload，不中斷連線） | **靜態設定檔** (`haproxy.cfg`)，支援 hitless reload（HAProxy 2.0+ 的 seamless reload）；Runtime API 可動態調整 server weight | AWS Console / CloudFormation / Terraform；**Target Group** + **Listener Rules** 模型 | AWS Console / CloudFormation / Terraform；**Target Group** 模型，routing 選項較少 | **動態配置**——xDS API（從 control plane 如 Istio 取得配置），支援 hot restart 不中斷流量 |
| **Health Checks** | 被動（偵測 upstream 失敗後標記 down）；主動需 Nginx Plus 或第三方 module | **主動 + 被動**均內建；支援 TCP、HTTP、SSL health check；可設定 `inter`（間隔）、`fall`（連續失敗閾值）、`rise`（恢復閾值） | **主動** health check 內建；支援 HTTP path、status code match、gRPC health check | **主動** health check；支援 TCP、HTTP、HTTPS | **主動 + 被動**均內建；支援 Outlier Detection（自動 eject 異常 host），EDS health status |
| **Service Discovery** | 靜態配置 upstream server 列表；動態需 Consul Template 或 Nginx Plus API | 靜態配置；可搭配 Consul Template、DNS SRV record | **自動整合** ECS、EC2 Auto Scaling Group、EKS（透過 Target Group binding） | **自動整合** ECS、EC2 ASG、EKS | **原生支援**——EDS (Endpoint Discovery Service) 透過 xDS API 動態更新 backend 列表 |
| **Observability** | Access log + stub_status module；進階需 Nginx Plus 或 Prometheus exporter（第三方） | **內建強大 stats page**（CSV/JSON）；Prometheus exporter 成熟；可看到每個 backend server 的 connection、response time、error rate | **CloudWatch metrics**（RequestCount、TargetResponseTime、5xxCount）；Access Log 到 S3；ALB 整合 X-Ray tracing | **CloudWatch metrics**（FlowCount、ProcessedBytes）；VPC Flow Logs | **業界最強**——內建 Prometheus-compatible stats、distributed tracing（Jaeger/Zipkin/OpenTelemetry）、access logging、per-route metrics |
| **gRPC Support** | Nginx 1.13.10+ 支援 gRPC proxy（`grpc_pass`） | HAProxy 2.0+ 支援 gRPC（透過 HTTP/2 backend） | **原生支援** gRPC routing + health check | 不理解 gRPC（L4 只看 TCP，可透傳但無法做 per-RPC balancing） | **原生 first-class** gRPC 支援，per-RPC load balancing |
| **mTLS** | 支援（需手動配置 client certificate 驗證） | 支援（HAProxy 2.x） | 支援 mTLS with ACM（有限） | TLS passthrough | **原生支援**，Istio service mesh 中自動管理 certificate rotation |
| **Cost** | **免費** (OSS) / Nginx Plus ~$3,500/yr per instance | **免費** (Community) / Enterprise ~$4,995/yr per instance | **~$0.0225/hr** + $0.008/LCU（LCU = Load Balancer Capacity Unit，結合 new connections、active connections、processed bytes、rule evaluations） | **~$0.0225/hr** + $0.006/NLCU | **免費** (OSS)；作為 Istio sidecar 時每 pod ~50-100MB RAM overhead |
| **典型角色** | Web server + reverse proxy + L7 LB | 專業高效能 LB / TCP proxy | AWS 雲端 L7 LB 首選 | AWS 雲端 L4 LB / 極高吞吐場景 | Service mesh sidecar / edge proxy / API gateway |

### 選型速查

| 場景 | 推薦產品 | 理由 |
|------|---------|------|
| 傳統 Web 應用，需要 reverse proxy + static file serving + LB | **Nginx** | 同時是 web server 和 LB，一舉兩得 |
| 需要極致 TCP 效能（database proxy、MQTT） | **HAProxy** | L4 效能業界頂尖，zero-copy splice 在 Linux kernel 直接搬資料 |
| AWS 上的 HTTP/HTTPS 微服務 | **AWS ALB** | 與 ECS/EKS 深度整合，自動擴展，免運維 |
| AWS 上需要 millions of PPS 或 non-HTTP 協議 | **AWS NLB** | L4 kernel-bypass 架構，延遲 ~100μs，支援 static IP / Elastic IP |
| Kubernetes service mesh (Istio/Envoy) | **Envoy** | 專為 cloud-native 設計，xDS API 動態配置，觀測性最強 |
| 需要 WAF + rate limiting + L7 LB 全功能 | **Nginx Plus** 或 **AWS ALB + WAF** | Nginx Plus 提供完整 application delivery；ALB 可整合 AWS WAF |

---

## 4. Underlying Implementation

### L4 Load Balancer 內部運作

L4 LB 有三種主要轉發模式，效能差異巨大：

#### (a) NAT Mode（Network Address Translation）

```
Client (1.1.1.1:5000)                LB (VIP: 2.2.2.2:80)              Backend (10.0.0.1:8080)
      │                                      │                                │
      │──── SYN to 2.2.2.2:80 ──────────────>│                                │
      │                                      │── Rewrite dst: 10.0.0.1:8080 ─>│
      │                                      │   Rewrite src: 2.2.2.2:xxxx    │
      │                                      │                                │
      │                                      │<─── SYN-ACK ──────────────────│
      │<──── Rewrite src back to 2.2.2.2:80 ─│                                │
      │                                      │                                │
      │  (ALL traffic flows through LB in both directions)                    │
```

**機制：** LB 修改封包的 source/destination IP 和 port。Client 以為在跟 VIP 溝通，backend 以為在跟 LB 溝通。**所有流量（request + response）都經過 LB**。

**效能瓶頸：** LB 成為 bandwidth bottleneck——尤其 response 通常遠大於 request（例如下載檔案）。一台 LB 的 NIC 限制了整體吞吐。

**數字：** 10Gbps NIC 的 LB，扣除協議開銷，實際可用 ~8Gbps，若平均 response 1KB，理論上限 ~1M responses/sec。

#### (b) DSR（Direct Server Return）

```
Client (1.1.1.1:5000)                LB (VIP: 2.2.2.2:80)              Backend (10.0.0.1:8080)
      │                                      │                                │
      │──── SYN to 2.2.2.2:80 ──────────────>│                                │
      │                                      │── Forward (rewrite L2 MAC) ───>│
      │                                      │   (backend configured with     │
      │                                      │    VIP on loopback interface)  │
      │                                      │                                │
      │<════════════ Response directly from backend ══════════════════════════│
      │              (src IP = 2.2.2.2, the VIP)                              │
      │                                      │                                │
      │  (Only INBOUND traffic flows through LB; RESPONSE bypasses LB)       │
```

**機制：** LB 只修改 Layer 2 的 MAC address（改為目標 backend 的 MAC），不改 IP。Backend 的 loopback interface 配置 VIP，所以 backend 可以用 VIP 作為 source IP 直接回覆 client。**Response 不經過 LB**。

**效能優勢：** LB 只處理 inbound 流量（通常是 request，體積小），response 直接從 backend 到 client。吞吐提升 **5-10 倍**以上。

**限制：** LB 和 backend 必須在同一個 L2 network（同一 VLAN/子網），因為是透過 MAC rewrite 轉發。不適用於跨資料中心。

**業界使用：** Linux IPVS（LVS）的 DR mode、Google Maglev 的早期版本。

#### (c) IP Tunneling (IP-in-IP / GRE)

```
Client (1.1.1.1:5000)                LB (VIP: 2.2.2.2:80)              Backend (10.0.0.1:8080)
      │                                      │                                │
      │──── SYN to 2.2.2.2:80 ──────────────>│                                │
      │                                      │── Encapsulate in IP tunnel ───>│
      │                                      │   (outer dst: 10.0.0.1)       │
      │                                      │   (inner pkt: original pkt)   │
      │                                      │                                │
      │<════════════ Response directly from backend ══════════════════════════│
      │              (decapsulate, reply with src = VIP)                       │
      │                                      │                                │
      │  (Like DSR but works across L3 networks / data centers)              │
```

**機制：** 結合 DSR 的優點（response 不經過 LB）+ 可跨 L3 網路。LB 把原始封包用 IP-in-IP tunnel 封裝，backend 解封裝後直接回覆 client。

**業界使用：** Google Maglev、Facebook Katran（基於 eBPF + XDP，單機可處理 **>10M packets/sec**）。

#### Linux Kernel 加速技術

| 技術 | 說明 | 效能 |
|------|------|------|
| **IPVS (LVS)** | Linux kernel 內建的 L4 LB，支援 NAT/DR/TUN 三種模式 | ~1M concurrent connections |
| **eBPF + XDP** | 在 NIC driver 層攔截封包，跳過整個 kernel networking stack | ~10M+ PPS，延遲 < 10μs |
| **DPDK** | 完全 bypass kernel，user-space 直接操作 NIC | ~20M+ PPS，需要專用 CPU core |

---

### L7 Load Balancer 內部運作

#### HTTP Request 的處理流程

```
Client                           L7 LB                              Backend
  │                                │                                   │
  │──── TCP 3-way handshake ──────>│                                   │
  │──── TLS handshake (1-2 RTT) ──>│                                   │
  │──── HTTP Request ─────────────>│                                   │
  │                                │── Parse HTTP headers              │
  │                                │── Match routing rules             │
  │                                │── Select backend (algorithm)      │
  │                                │                                   │
  │                                │── Reuse pooled connection ───────>│
  │                                │   (or establish new TCP conn)     │
  │                                │── Forward HTTP request ──────────>│
  │                                │   (may modify headers:            │
  │                                │    add X-Forwarded-For,           │
  │                                │    X-Request-Id, etc.)            │
  │                                │                                   │
  │                                │<─── HTTP Response ───────────────│
  │<──── HTTP Response ───────────│                                   │
  │                                │                                   │
```

#### Connection Pooling 的價值

L7 LB 維護一個到 backend server 的 **connection pool**。這解決了一個關鍵效能問題：

- **無 connection pool：** 每個 client request 都需要對 backend 建立新的 TCP connection（3-way handshake = 1 RTT ≈ 0.5ms intra-DC），若加上 TLS 則是 2-3 RTT。高 QPS 下，backend 的 `TIME_WAIT` socket 爆滿。
- **有 connection pool：** LB 維護例如 100 條到每台 backend 的 persistent connections，所有 client request 複用這些 connections。Backend 只看到 100 條穩定連線，而非數萬條短連線。

**數字：** 假設 10K client connections，每個 request 需要 backend 建立新 TCP connection，backend 每秒收到 10K 新連線。使用 connection pool (pool size = 50 per backend, 10 backends = 500 total connections)，backend 收到的是穩定的 500 條連線上的 multiplexed requests。TCP connection 建立成本從 ~0.5ms/request 降為 ~0（復用已有連線）。

#### Header-Based Routing 實作

L7 LB 在解析 HTTP request 後，根據規則匹配路由：

```
# Nginx 風格的路由規則示意
location /api/v2/users {
    proxy_pass http://user-service-v2;        # 路由到 user service v2
}

location /api/v1/ {
    proxy_pass http://legacy-api;             # 舊版 API
}

# Header-based: canary deployment
if ($http_x_canary = "true") {
    proxy_pass http://canary-backend;
}

# Cookie-based: A/B testing
if ($cookie_ab_group = "experiment") {
    proxy_pass http://experiment-backend;
}
```

AWS ALB 的 Listener Rule 支援基於 path、host header、HTTP method、query string、source IP 的路由，最多 100 條規則，按優先順序評估。

---

### Connection Draining 與 Graceful Shutdown

當 backend server 需要下線（deployment、scaling down、故障移除）時，**abrupt termination 會導致 in-flight requests 失敗**。Connection draining 的機制：

```
Timeline:
t=0    Server marked as "draining" (stop receiving NEW requests)
       │
       │  Existing in-flight requests continue processing
       │  LB routes all NEW requests to other healthy servers
       │
t=30s  Draining timeout reached
       │
       │  If still active connections:
       │  - Graceful: Send TCP FIN, wait for response
       │  - Force: Send TCP RST after additional timeout
       │
t=60s  Server fully removed from pool
```

**各產品的 draining 配置：**

| Product | Config | Default Timeout |
|---------|--------|-----------------|
| Nginx | `server backend1 down;` + reload | 依 `proxy_read_timeout`（預設 60s） |
| HAProxy | `set server backend/server1 state drain`（Runtime API） | `timeout server`（預設 50s） |
| AWS ALB/NLB | Target Group deregistration delay | **300 秒**（可設 0-3600s） |
| Envoy | Outlier Detection ejection 或 EDS health status `DRAINING` | `drain_timeout`（預設 600s） |

**最佳實踐：** Draining timeout 應設為 **p99 request processing time 的 2-3 倍**。若 p99 = 5s，draining timeout 設 15s。設太短會 kill in-flight requests，設太長會延遲 deployment。

---

### Health Check 機制：Active vs Passive

#### Active Health Check

LB **主動定期發送探測請求**到每台 backend server。

```
LB ──── GET /health ──────> Backend Server
   <─── 200 OK ────────────
   (每 5 秒探測一次)

   連續 3 次失敗 → 標記為 unhealthy
   連續 2 次成功 → 標記為 healthy
```

**配置重點（以 HAProxy 為例）：**
```
server web1 10.0.0.1:8080 check inter 5000 fall 3 rise 2
# inter 5000 = 每 5 秒探測一次
# fall 3     = 連續 3 次失敗後標記 down
# rise 2     = 連續 2 次成功後恢復
```

**偵測延遲：** worst case = `inter × fall` = 5s × 3 = **15 秒**才能偵測到故障。這意味著在這 15 秒內，real user requests 仍被送到故障 server。

#### Passive Health Check（又稱 Circuit Breaking / Outlier Detection）

LB **觀察 real traffic 的結果**來判斷 server 健康狀態。

```
LB 觀察到 Backend Server 的 real traffic：
   - 最近 10 個 request 有 7 個 5xx → 標記為 unhealthy
   - 或：response time > 5s 超過 3 次 → 標記為 unhealthy

Envoy Outlier Detection 配置範例：
   consecutive_5xx: 5              # 連續 5 個 5xx → eject
   interval: 10s                   # 每 10 秒評估一次
   base_ejection_time: 30s         # 首次 eject 30 秒
   max_ejection_percent: 50        # 最多 eject 50% 的 hosts
```

**優勢：** 比 active health check 更快偵測到問題（基於真實流量，不是人為探測），且能偵測到「server 活著但功能異常」的情況（例如 /health 返回 200 但 /api/orders 持續 500）。

**最佳實踐：** **同時使用 Active + Passive**。Active 偵測 server 完全離線（process crash、network 斷開），Passive 偵測 server 部分異常（application bug、dependency failure）。

---

## 5. Architect's Decision Tree

### L4 vs L7 選擇

```
START: "我需要一個 Load Balancer"
│
├── Q1: 你的流量是 HTTP/HTTPS/gRPC 嗎？
│   ├── NO (TCP/UDP, database, game server, MQTT, custom protocol)
│   │   └──> L4 LB
│   │        推薦: HAProxy (self-hosted) 或 AWS NLB (cloud)
│   └── YES --> continue
│
├── Q2: 你需要基於 URL path / header / cookie 做路由嗎？
│   │   (canary deployment, A/B testing, microservice routing)
│   ├── YES --> L7 LB
│   │          推薦: Nginx / ALB / Envoy
│   └── NO --> continue
│
├── Q3: 你需要 SSL termination + HTTP 層級的觀測性嗎？
│   ├── YES --> L7 LB
│   └── NO --> continue
│
├── Q4: 吞吐量需求 > 1M PPS 或 > 10 Gbps？
│   ├── YES --> L4 LB (前端) + L7 LB (後端) 分層架構
│   │          L4: AWS NLB / IPVS+eBPF / Maglev-like
│   │          L7: Nginx / Envoy cluster
│   └── NO --> L7 LB (功能更豐富，效能對中等規模足夠)
│
└── Default: 選 L7 LB (Nginx 或 ALB)
             除非有明確理由需要 L4
```

### Algorithm 選擇

```
START: "我該用哪種 Load Balancing 演算法？"
│
├── Q1: 你的 backend 是 distributed cache (Redis/Memcached)
│       或 stateful sharding?
│   ├── YES --> Consistent Hashing
│   │          (最小化節點變動時的 cache invalidation)
│   └── NO --> continue
│
├── Q2: 你有多層 LB 或多個獨立的 LB instances？
│   ├── YES --> Random with Two Choices (Power of Two)
│   │          (避免 herd effect; Envoy 預設使用)
│   └── NO --> continue
│
├── Q3: Request 處理時間差異大嗎？ (有些 10ms, 有些 5s)
│   ├── YES --> Least Connections 或 Least Response Time
│   │          (自動適應不均勻的處理時間)
│   └── NO --> continue
│
├── Q4: Backend servers 規格不同嗎？ (8-core vs 2-core)
│   ├── YES --> Weighted Round Robin 或 Weighted Least Connections
│   └── NO --> continue
│
├── Q5: 你需要 session affinity 且無法用 external session store?
│   ├── YES --> IP Hash (不推薦, 但有時是唯一選項)
│   │          更好的方案: cookie-based sticky (L7 LB feature)
│   └── NO --> continue
│
└── Default: Round Robin
             (最簡單，在 stateless + homogeneous server 場景下表現良好)
```

### Product 選擇

```
START: "我該用哪個 Load Balancer 產品？"
│
├── Q1: 你在 AWS 上嗎？
│   ├── YES
│   │   ├── HTTP/HTTPS traffic? --> AWS ALB
│   │   │   (+ WAF 整合, + ECS/EKS 自動 target registration)
│   │   ├── Non-HTTP 或需要極高 PPS? --> AWS NLB
│   │   │   (static IP, <100μs 延遲, millions PPS)
│   │   └── 兩者都需要? --> NLB --> ALB chain
│   │       (NLB 提供 static IP + L4 效能, ALB 提供 L7 routing)
│   └── NO --> continue
│
├── Q2: 你在 Kubernetes + service mesh 環境？
│   ├── YES --> Envoy (通常由 Istio/Linkerd 管理)
│   │          (xDS 動態配置, 觀測性最強, per-pod sidecar)
│   └── NO --> continue
│
├── Q3: 你需要極致 TCP/L4 效能？(database proxy, gaming)
│   ├── YES --> HAProxy
│   │          (L4 效能業界頂尖, Runtime API 動態管理)
│   └── NO --> continue
│
├── Q4: 你同時需要 web server + reverse proxy + LB？
│   ├── YES --> Nginx
│   │          (static file serving + LB + SSL termination 一站式)
│   └── NO --> continue
│
└── Default: Nginx (最廣泛使用, 社區資源豐富, 學習曲線低)
```

---

## 6. Common Pitfalls

### Pitfall 1: 沒有考慮 Keep-Alive Connections 的影響

**問題描述：** 使用 Least Connections 演算法，但 backend server 配置了 HTTP keep-alive（`Connection: keep-alive`），導致 connections 長期不釋放。新啟動的 server 很久都收不到流量，因為現有 server 的 persistent connections 已佔滿了 LB 的 connection tracking。

**真實場景：** 啟動第 5 台 server 做 horizontal scaling，但前 4 台各有 1000 條 keep-alive connections，Least Connections 演算法認為第 5 台（0 connections）應該接收所有新請求。短暫時間內第 5 台被 overwhelm，然後趨於穩定——但如果第 5 台比其他 server 慢（cold cache），它在 warmup 期間就可能被壓垮。

**解決方案：**
- 設定合理的 `keepalive_timeout`（Nginx 預設 75s，建議根據 traffic pattern 調整）
- 使用 **slow start**：HAProxy 和 AWS ALB 支援 slow start period（新 server 加入時在 N 秒內逐漸增加流量）。HAProxy 配置：`server web5 10.0.0.5:8080 weight 100 slowstart 60s`
- 使用 Weighted Least Connections，給新 server 較低初始 weight

---

### Pitfall 2: 忽略 Connection Limits

**問題描述：** 沒有設定 backend server 的 max connections limit，導致 LB 在 traffic spike 時把所有 requests 都轉發到 backend，超過 backend 的處理能力（file descriptor limit、thread pool、memory）。backend 開始 timeout、OOM kill、或 kernel panic（`Too many open files`）。

**數字感：**
- Linux 預設 `ulimit -n` = 1024 file descriptors（每個 TCP connection 佔一個 fd）
- 生產環境通常調到 65535 或更高
- 但 application 層面也有限制：Tomcat 預設 maxConnections = 8192、Node.js 受限於 event loop 和 memory
- **一台 4-core 8GB 的 backend server 合理的 concurrent connection 上限約 2000-5000**（取決於 application 的 memory footprint per connection）

**解決方案：**
- 在 LB 設定 `max_connections per backend server`：
  - HAProxy: `server web1 10.0.0.1:8080 maxconn 2000`
  - Nginx: `upstream backend { server 10.0.0.1:8080 max_conns=2000; }`
- 超過限制時 LB 應 queue 請求（HAProxy 的 `queue timeout`）或返回 **503 Service Unavailable**
- 搭配 **circuit breaker** pattern：Envoy 的 circuit breaker 在 pending requests 超過閾值時直接拒絕，保護 backend

---

### Pitfall 3: SSL Termination 放置位置錯誤

**問題描述：** 將 SSL termination 放在錯誤的位置，導致效能問題或安全漏洞。

**常見錯誤：**

**(a) 在每台 backend server 上做 SSL termination：**
- 每台 server 都需要管理 certificate（renewal、rotation）
- TLS handshake 消耗 CPU——RSA 2048-bit handshake ~1ms per handshake，ECDSA P-256 ~0.2ms
- 10 台 server × 每秒 1000 new TLS connections = 10,000 TLS handshakes/sec，浪費了可以用來處理 business logic 的 CPU
- LB 無法看到 HTTP 內容，等於降級為 L4 LB

**(b) 只在 LB 做 SSL termination，LB 到 backend 用 plain HTTP：**
- 若 LB 和 backend 在同一個 trusted network（VPC/data center）且有 network-level encryption (e.g., VPC encryption in transit)，**這通常是可接受的**
- 若跨網路，中間可能被攔截——需要 **re-encryption**（LB 解密後用另一個 cert 重新加密到 backend）

**最佳實踐：**
- **LB 做 SSL termination**（集中管理 certificate，LB 可解析 HTTP 做 L7 routing）
- LB 到 backend 使用 **plain HTTP over private network**（VPC 內），或 **mTLS**（跨網路 / zero-trust 環境）
- 使用 **TLS session resumption** 減少 handshake 成本（Nginx: `ssl_session_cache shared:SSL:10m;` 可 cache ~40,000 sessions）

---

### Pitfall 4: Sticky Sessions 破壞 Horizontal Scaling

**問題描述：** 使用 cookie-based 或 IP hash sticky session，導致：
1. **負載不均：** 「大客戶」（high-traffic user）被 sticky 到一台 server，該 server 負載遠高於其他 server
2. **無法縮容：** 移除 server 時，所有 sticky 到該 server 的 session 中斷
3. **灰度發布困難：** 新版 server 加入後，只有新 session 才會路由過去，舊 session 永遠留在舊版
4. **Auto-scaling 反應遲鈍：** 新增的 server 因為沒有 sticky session 指向它，得等舊 session 過期才能分到流量

**量化影響：** 假設 10 台 server，1 個大客戶產生 20% 的流量且被 sticky 到 Server 1。Server 1 承受 ~28% 的總負載（20% 來自大客戶 + 8% 來自均分的其他流量），而其他 server 各 ~8%。Server 1 的負載是其他 server 的 **3.5 倍**。

**解決方案：**
- **根本解法：Stateless design + External session store**（Redis with TTL / DynamoDB）。所有 server 都能處理任何 session，LB 可自由路由。
- 若必須使用 sticky session（遺留系統）：
  - 用 **cookie-based stickiness**（而非 IP hash），至少可以精確到 browser session 而非 IP
  - 設定 **合理的 session TTL**（例如 30 分鐘），讓 session 自然過期後重新分配
  - ALB: `stickiness.enabled=true, stickiness.lb_cookie.duration_seconds=1800`
  - 搭配 connection draining，確保 session 遷移時不中斷 in-flight requests

---

### Pitfall 5: 單點故障——LB 自身的高可用

**問題描述：** 花大量精力確保 backend server 的高可用，卻忘了 LB 本身是一個 **Single Point of Failure**。

**解決方案：**
- **AWS ALB/NLB：** AWS 自動處理 HA，跨多個 AZ 部署，不需擔心
- **Self-hosted（Nginx/HAProxy）：** 必須部署 **Active-Passive 或 Active-Active pair**
  - 使用 **VRRP（Virtual Router Redundancy Protocol）** / **Keepalived** 做 floating VIP failover
  - Active LB 故障時，Passive LB 在 ~1-3 秒內接管 VIP
  - DNS-based HA：多個 A record 指向多台 LB，但 DNS TTL 導致 failover 較慢（~30-300 秒取決於 TTL 和 client caching）
- **Anycast + BGP：** 在多個 PoP 宣告相同 VIP，BGP routing 自動導向最近的健康 LB。Cloudflare 和 Google 使用此方式。
