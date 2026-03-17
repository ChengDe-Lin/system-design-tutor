# Rate Limiter: 演算法深度比較與架構設計

Rate limiting 是保護系統免受過載、濫用與 DDoS 攻擊的核心防線。本文件深入比較五種主流演算法，並探討分散式環境下的實作策略與架構決策。

---

## 1. 綜合比較矩陣

| 維度 | Token Bucket | Leaky Bucket | Fixed Window Counter | Sliding Window Log | Sliding Window Counter |
|---|---|---|---|---|---|
| **Accuracy** | 中高 — 允許短暫 burst，長期精確 | 高 — 輸出速率恆定 | 低 — 視窗邊界有 2x burst 問題 | 最高 — 精確追蹤每筆 request | 高 — 加權近似，誤差 < 1% |
| **Memory Usage** | O(1) per key — 只存 token 數 + 上次補充時間 | O(bucket size) — 需維護 queue | O(1) per key — 只存 counter + 視窗起始 | O(n) per key — 儲存每筆 request timestamp | O(1) per key — 存兩個 counter + 時間戳 |
| **Burst Handling** | 允許 burst（最多 bucket 容量） | 完全抑制 burst — 平滑輸出 | 允許 burst（邊界處最多 2x） | 嚴格限制 — 無 burst | 輕微 burst — 加權平均平滑化 |
| **Implementation Complexity** | 低 | 中（需 queue 管理） | 最低 | 中高（timestamp 排序與清理） | 低中 |
| **Distributed-Friendly** | 高 — 原子操作簡單 | 低 — queue 難以跨節點同步 | 高 — Redis INCR 即可 | 中 — sorted set 可行但較重 | 高 — 兩個 counter 易於原子更新 |
| **Common Use Cases** | API Gateway、公有雲 API | 流量整形（traffic shaping）、Nginx | 簡易 API 限流、prototype | 需要最高精確度的計費系統 | 生產級 API 限流的最佳平衡選擇 |

**選型速覽：** 若你只能記住一個 — 大多數生產環境選 **Sliding Window Counter**，它在精確度與記憶體之間取得最佳平衡。若需要允許合理 burst（例如 API Gateway），選 **Token Bucket**。

---

## 2. 演算法深度解析

---

### 2.1 Token Bucket

#### 運作原理

Token Bucket 維護一個「令牌桶」，系統以固定速率往桶內補充 token。每個 request 消耗一個（或多個）token；若桶內 token 不足，request 被拒絕。桶有容量上限（burst capacity），允許短暫的流量爆發。

```
         Token Bucket 運作示意
         =======================

  Token 以固定速率補充 (refill rate = r)
         |
         v
    +----------+      capacity = B (最大 token 數)
    |  oooooo  |  <-- bucket 目前有 6 個 tokens
    |  oooooo  |
    |  oooo    |
    +----||----+
         ||
         vv
    每個 request 取走 1 個 token
    - 有 token → 放行 (200 OK)
    - 沒 token → 拒絕 (429 Too Many Requests)

  Timeline 示意 (capacity=5, refill=1/sec):
  ─────────────────────────────────────────────
  t=0s  tokens=5  req → 允許 (tokens=4)
  t=0s  tokens=4  req → 允許 (tokens=3)
  t=0s  tokens=3  req → 允許 (tokens=2)
  t=0s  tokens=2  req → 允許 (tokens=1)
  t=0s  tokens=1  req → 允許 (tokens=0)
  t=0s  tokens=0  req → 拒絕 ✗
  t=1s  tokens=1  (補充 1 個)
  t=1s  tokens=1  req → 允許 (tokens=0)
  t=2s  tokens=1  req → 允許 (tokens=0)
  ...
  t=5s  tokens=5  (桶滿，不再補充)
```

#### 具體演練：limit 5 requests/minute

- **Bucket capacity (B):** 5
- **Refill rate (r):** 5 tokens / 60 seconds = 1 token every 12 seconds

| 時間 | 事件 | Bucket Tokens | 結果 |
|---|---|---|---|
| 00:00 | 桶初始滿 | 5 | — |
| 00:01 | 3 requests 同時到達 | 5 → 2 | 全部放行 |
| 00:05 | 1 request | 2 → 1 | 放行 |
| 00:10 | 1 request | 1 → 0 | 放行 |
| 00:11 | 1 request | 0 | **拒絕 429** |
| 00:12 | 補充 1 token | 1 | — |
| 00:13 | 1 request | 1 → 0 | 放行 |
| 00:24 | 補充 1 token | 1 | — |
| 00:36 | 補充 1 token | 2 | — |

關鍵觀察：使用者可以在開始時一次用完 5 個 token（burst），之後每 12 秒只能發一個 request。長期平均速率仍為 5 req/min。

#### Pros & Cons

**Pros:**
- 記憶體極低 — 每個 key 只需兩個數值（token count + last refill timestamp）
- 自然支援 burst — 使用者體驗好，短暫尖峰不會被拒
- 分散式實作簡單 — Redis 單一 key 的 atomic 操作即可
- 業界廣泛採用 — AWS API Gateway、Stripe、Google Cloud Endpoints 皆使用

**Cons:**
- Burst 可能導致下游瞬間過載 — 若 bucket capacity 設太大，burst 可能超過後端承受能力
- 參數調校需要經驗 — capacity 與 refill rate 兩個旋鈕需要根據業務需求平衡
- 不適合需要嚴格平滑輸出的場景

#### Pseudocode

```
class TokenBucket:
    capacity: int          # 桶容量（最大 burst）
    refill_rate: float     # tokens per second
    tokens: float          # 目前 token 數
    last_refill: timestamp # 上次補充時間

    function allow_request(cost=1):
        now = current_time()
        # 計算自上次以來應補充的 token 數
        elapsed = now - last_refill
        tokens = min(capacity, tokens + elapsed * refill_rate)
        last_refill = now

        if tokens >= cost:
            tokens -= cost
            return ALLOW
        else:
            return REJECT
```

**使用此演算法的知名系統：** AWS API Gateway、Stripe API、Google Cloud Endpoints、Shopify API

---

### 2.2 Leaky Bucket (as Queue)

#### 運作原理

Leaky Bucket 將 request 放入一個固定容量的 queue（桶），系統以恆定速率從桶底「漏出」並處理 request。若桶滿了，新的 request 直接被丟棄。與 Token Bucket 最大的差異：**輸出永遠是平滑的**，不會有 burst。

```
         Leaky Bucket 運作示意
         =======================

    Incoming requests（速率不固定）
    ↓ ↓↓ ↓  ↓↓↓↓  ↓ ↓
    +------------+
    | [req][req] |  ← queue (capacity = B)
    | [req][req] |     滿了就 DROP
    | [req]      |
    +-----||-----+
          ||
          \/         ← 固定速率漏出 (leak rate = r)
     Process 1 req every (1/r) seconds

  Timeline 示意 (capacity=5, leak_rate=1/sec):
  ─────────────────────────────────────────────
  t=0.0s  queue=0  3 reqs arrive → queue=3   (全部入隊)
  t=0.0s           1 req leaks   → queue=2   (處理 1 個)
  t=1.0s           1 req leaks   → queue=1
  t=1.0s  2 reqs arrive          → queue=3
  t=2.0s           1 req leaks   → queue=2
  t=3.0s           1 req leaks   → queue=1
  t=3.5s  5 reqs arrive → queue 只能再放 4 個
                          → 1 req DROPPED ✗
```

#### 具體演練：limit 5 requests/minute

- **Bucket capacity (B):** 5（queue 最多暫存 5 個 request）
- **Leak rate (r):** 1 request every 12 seconds（= 5/min 的平滑輸出）

| 時間 | 事件 | Queue Size | 結果 |
|---|---|---|---|
| 00:00 | 3 requests 同時到達 | 0 → 3 | 全部入隊 |
| 00:00 | 第 1 個 leak | 3 → 2 | 處理第 1 個 request |
| 00:12 | 第 2 個 leak | 2 → 1 | 處理第 2 個 request |
| 00:15 | 4 requests 到達 | 1 → 5 | 全部入隊（剛好滿） |
| 00:16 | 1 request 到達 | 5 | **丟棄 — queue 已滿** |
| 00:24 | 第 3 個 leak | 5 → 4 | 處理第 3 個 request |
| 00:36 | 第 4 個 leak | 4 → 3 | 處理第 4 個 request |

關鍵觀察：即使一次湧入大量 request，輸出端始終維持每 12 秒 1 個的恆定速率。適合保護對速率敏感的下游服務。

#### Pros & Cons

**Pros:**
- 輸出速率完全平滑 — 下游不會遭受 burst 衝擊
- 概念直觀 — 就像一個真正的漏水桶
- 適合 traffic shaping — 網路設備與 Nginx 大量使用

**Cons:**
- 需要維護 queue — 記憶體成本 O(bucket size)，且需要 timer/worker 來 drain
- Burst 被完全壓制 — 即使系統有餘裕，使用者也無法短暫加速
- 分散式實作困難 — queue 狀態難以跨節點共享
- Request 延遲增加 — 入隊的 request 需要等待被處理

#### Pseudocode

```
class LeakyBucket:
    capacity: int           # queue 最大長度
    leak_rate: float        # requests processed per second
    queue: Queue<Request>   # FIFO queue
    last_leak: timestamp

    function allow_request(request):
        leak_pending()  # 先清空已到期的

        if queue.size() < capacity:
            queue.enqueue(request)
            return QUEUED
        else:
            return REJECTED  # queue 滿了，直接丟棄

    function leak_pending():
        now = current_time()
        elapsed = now - last_leak
        leaks = floor(elapsed * leak_rate)
        for i in range(min(leaks, queue.size())):
            request = queue.dequeue()
            process(request)  # 送往下游處理
        if leaks > 0:
            last_leak = now
```

**使用此演算法的知名系統：** Nginx `limit_req`（搭配 `burst` 參數）、Linux TC（Traffic Control）、Envoy proxy

---

### 2.3 Fixed Window Counter

#### 運作原理

最直覺的做法：將時間切割成固定大小的視窗（例如每分鐘一個視窗），每個視窗維護一個 counter。Request 進來時 counter +1，若超過 threshold 就拒絕。視窗結束時 counter 歸零。

```
         Fixed Window Counter 運作示意
         ==============================

  時間軸被切成固定長度的 window：
  |--- Window 1 ---|--- Window 2 ---|--- Window 3 ---|
  00:00       01:00  01:00       02:00  02:00       03:00

  Window 1: counter = 3  (limit=5 → 允許)
  Window 2: counter = 5  (limit=5 → 剛好到上限)
  Window 3: counter = 2  (limit=5 → 允許)

  每個 window 開始時 counter 重置為 0。
```

#### 邊界問題（The Boundary Problem）

Fixed Window 最大的缺陷是視窗邊界處的 burst。若 limit = 5 req/min，使用者可以在視窗末尾發 5 個、在下個視窗開頭又發 5 個，等於在 **短短幾秒內發了 10 個 request** — 是限制的 2 倍。

```
  !! Fixed Window 邊界問題 !!

  Limit: 5 requests per minute

  Window 1 (00:00-00:59)     Window 2 (01:00-01:59)
  |                     |     |                     |
  |              ●●●●●  |     | ●●●●●               |
  |              ^^^^^  |     | ^^^^^               |
  |         00:55-00:59 |     | 01:00-01:04         |
  |         5 requests  |     | 5 requests          |
  |    counter=5 (OK)   |     | counter=5 (OK)      |

  但實際上在 00:55 ~ 01:04 這 10 秒內
  共有 10 個 requests 被放行！
  ─────────────────────────────────────
  這段 10 秒窗口中的實際速率 = 10 req / 10 sec
                                = 60 req/min (是限制的 12 倍！)

  雖然每個 window 各自都合規，
  但跨 window 的 burst 違反了設計意圖。
```

#### 具體演練：limit 5 requests/minute

| 時間 | Window | Counter | 結果 |
|---|---|---|---|
| 00:10 | W1 (00:00-00:59) | 0 → 1 | 放行 |
| 00:20 | W1 | 1 → 2 | 放行 |
| 00:30 | W1 | 2 → 3 | 放行 |
| 00:55 | W1 | 3 → 4 | 放行 |
| 00:58 | W1 | 4 → 5 | 放行 |
| 00:59 | W1 | 5 | **拒絕 429** |
| 01:00 | W2 (01:00-01:59) | 0 → 1 | 放行（counter 重置！） |
| 01:01 | W2 | 1 → 2 | 放行 |
| 01:02 | W2 | 2 → 3 | 放行 |

#### Pros & Cons

**Pros:**
- 實作極其簡單 — 一個 counter + 一個 timestamp
- 記憶體最低 — O(1) per key
- 分散式友善 — Redis `INCR` + `EXPIRE` 兩行搞定
- 容易理解與除錯

**Cons:**
- 邊界 burst 問題 — 最多可達 2x 限制速率
- 精確度低 — 不適合需要嚴格限流的場景
- 視窗大小選擇困難 — 太小浪費記憶體，太大則精確度更差

#### Pseudocode

```
class FixedWindowCounter:
    limit: int               # 每個 window 的最大 request 數
    window_size: duration    # window 長度（例如 60 seconds）

    function allow_request(key):
        window_key = key + ":" + floor(current_time() / window_size)
        count = store.increment(window_key)

        if count == 1:
            store.set_expiry(window_key, window_size)

        if count <= limit:
            return ALLOW
        else:
            return REJECT
```

**使用此演算法的知名系統：** 許多早期 API 限流實作、簡易 prototype、GitHub API（早期版本）

---

### 2.4 Sliding Window Log

#### 運作原理

為每個使用者維護一份完整的 request timestamp log。每次新 request 進來時，先清除超出 window 範圍的舊 timestamp，再計算 window 內剩餘的 request 數量。若未超限就放行並記錄新 timestamp。

```
         Sliding Window Log 運作示意
         ============================

  持續滑動的窗口（永遠看「最近 60 秒」）：

  時間軸：
  ──●─────●──●────────●───●──●──────●──→
    T1    T2 T3       T4  T5 T6     T7 (now)
                                    ^
                              |←── 60s ──→|
                              window 起點   window 終點

  Log for user_123:
  [T4=00:32, T5=00:41, T6=00:48, T7=00:55]
  (T1, T2, T3 已超出 window，被移除)

  count = 4，limit = 5 → 允許 T7

  新 request 在 T8=00:58:
  Log: [T4=00:32, T5=00:41, T6=00:48, T7=00:55, T8=00:58]
  count = 5 → 剛好到上限

  新 request 在 T9=00:59:
  先清理：T4=00:32 已超出 (00:59-60s=23:59)... 不對，
  00:59 - 60s = 23:59? 不，是 00:59 - 60 = -00:01。
  修正：window = [now-60s, now] = [-0:01, 00:59]
  所有 T4~T8 都在 window 內，count = 5
  → 拒絕 T9 ✗
```

#### 具體演練：limit 5 requests/minute

| 時間 | Log 內容 | Window 範圍 | Count | 結果 |
|---|---|---|---|---|
| 00:05 | [00:05] | [-00:55, 00:05] | 1 | 放行 |
| 00:15 | [00:05, 00:15] | [-00:45, 00:15] | 2 | 放行 |
| 00:25 | [00:05, 00:15, 00:25] | [-00:35, 00:25] | 3 | 放行 |
| 00:50 | [00:05, 00:15, 00:25, 00:50] | [-00:10, 00:50] | 4 | 放行 |
| 00:55 | [00:05, 00:15, 00:25, 00:50, 00:55] | [-00:05, 00:55] | 5 | 放行 |
| 01:02 | [00:05, 00:15, 00:25, 00:50, 00:55] | [00:02, 01:02] | 5 | **拒絕 429** |
| 01:06 | [00:15, 00:25, 00:50, 00:55] (清除 00:05) | [00:06, 01:06] | 4 → 放行並加入 | 放行 |

注意 01:06 時 00:05 已滑出 window，所以 count 降為 4。這就是 sliding window 的精髓 — **沒有邊界問題**。

#### Pros & Cons

**Pros:**
- 精確度最高 — 完美追蹤每筆 request 的精確時間
- 無邊界 burst 問題 — window 是真正滑動的
- 行為可預測 — 每個 request 的 timestamp 都有紀錄，方便 audit

**Cons:**
- 記憶體消耗大 — 每個使用者需儲存所有在 window 內的 request timestamp，O(n) per user
- 若 limit 是 10,000 req/min，每個使用者最多存 10,000 個 timestamp（約 80KB）
- 計算成本 — 每次需要清理舊 timestamp，Redis ZREMRANGEBYSCORE 的成本
- 不適合高流量場景 — 百萬使用者 x 大量 timestamp = 巨大記憶體壓力

#### Pseudocode

```
class SlidingWindowLog:
    limit: int
    window_size: duration

    function allow_request(key):
        now = current_time()
        window_start = now - window_size

        # 移除過期的 timestamps
        store.remove_range(key, from=-inf, to=window_start)

        # 計算 window 內的 request 數
        count = store.count(key)

        if count < limit:
            store.add(key, timestamp=now, score=now)
            return ALLOW
        else:
            return REJECT
```

在 Redis 中，通常使用 Sorted Set 實作：score 為 timestamp，member 為 unique request ID。

**使用此演算法的知名系統：** 需要精確計費的系統、合規審計系統、低流量但高精確度需求的內部 API

---

### 2.5 Sliding Window Counter

#### 運作原理

結合 Fixed Window Counter 的低記憶體與 Sliding Window Log 的高精確度。做法：維護當前 window 與前一個 window 的 counter，根據時間在當前 window 中的位置做**加權平均**。

```
         Sliding Window Counter 運作示意
         =================================

  Previous Window          Current Window
  |─────────────────|──────────●────────|
  00:00         01:00  01:00       01:40  01:59
                              now = 01:40
                              ↑

  Previous window counter: Cp = 8
  Current window counter:  Cc = 3
  Window size: 60 seconds
  Position in current window: 40 seconds (= 01:40 - 01:00)

  加權公式:
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  weighted_count = Cc + Cp × overlap_ratio        │
  │                                                  │
  │  overlap_ratio = (window_size - elapsed)         │
  │                   ─────────────────────          │
  │                       window_size                │
  │                                                  │
  │  = (60 - 40) / 60                                │
  │  = 20 / 60                                       │
  │  = 0.333                                         │
  │                                                  │
  │  weighted_count = 3 + 8 × 0.333                  │
  │                 = 3 + 2.667                       │
  │                 = 5.667                           │
  │                                                  │
  │  若 limit = 5 → 5.667 > 5 → 拒絕 ✗              │
  │  若 limit = 6 → 5.667 < 6 → 放行 ✓              │
  │                                                  │
  └──────────────────────────────────────────────────┘

  直覺理解：
  我們估算「如果把 window 往回推 60 秒，
  大約有多少 request 落在這個滑動視窗中？」
  用前一個 window 的 counter 乘以「overlap 比例」來近似。
```

#### 具體演練：limit 5 requests/minute

| 時間 | Prev Counter (Cp) | Curr Counter (Cc) | Overlap Ratio | Weighted Count | 結果 |
|---|---|---|---|---|---|
| 01:00 | 4 (from W0) | 0 | 1.0 | 0 + 4 x 1.0 = 4.0 | — (window 剛開始) |
| 01:10 | 4 | 1 | (60-10)/60 = 0.833 | 1 + 4 x 0.833 = 4.33 | 放行 |
| 01:20 | 4 | 2 | (60-20)/60 = 0.667 | 2 + 4 x 0.667 = 4.67 | 放行 |
| 01:30 | 4 | 3 | (60-30)/60 = 0.5 | 3 + 4 x 0.5 = 5.0 | 放行（剛好等於 limit） |
| 01:35 | 4 | 4 (若放行) | (60-35)/60 = 0.417 | 4 + 4 x 0.417 = 5.67 | **拒絕 429** |
| 01:50 | 4 | 3 | (60-50)/60 = 0.167 | 3 + 4 x 0.167 = 3.67 | 放行 |
| 01:55 | 4 | 4 | (60-55)/60 = 0.083 | 4 + 4 x 0.083 = 4.33 | 放行 |

觀察：隨著時間推移，前一個 window 的權重持續下降。到 01:55 時 overlap ratio 只剩 0.083，前一個 window 幾乎不影響決策。

#### Pros & Cons

**Pros:**
- 記憶體極低 — O(1) per key，只需兩個 counter + 時間戳
- 精確度高 — Cloudflare 工程團隊實測誤差 < 0.003%（在均勻分佈下）
- 無嚴重邊界問題 — 加權機制平滑了 Fixed Window 的邊界 burst
- 分散式友善 — 兩個 Redis counter 的原子更新非常簡單

**Cons:**
- 是一個近似值 — 假設前一個 window 的 request 是均勻分佈的（實際上可能不是）
- 在極端不均勻分佈下可能有微小誤差 — 但實務上幾乎可忽略
- 需要同時維護兩個 window 的 counter

#### Pseudocode

```
class SlidingWindowCounter:
    limit: int
    window_size: duration

    function allow_request(key):
        now = current_time()
        current_window = floor(now / window_size)
        previous_window = current_window - 1
        elapsed = now - (current_window * window_size)
        overlap_ratio = (window_size - elapsed) / window_size

        prev_count = store.get(key + ":" + previous_window) or 0
        curr_count = store.get(key + ":" + current_window) or 0

        weighted_count = curr_count + prev_count * overlap_ratio

        if weighted_count < limit:
            store.increment(key + ":" + current_window)
            store.set_expiry(key + ":" + current_window, window_size * 2)
            return ALLOW
        else:
            return REJECT
```

**使用此演算法的知名系統：** Cloudflare Rate Limiting、許多生產級 API Gateway 的預設實作

---

## 3. 分散式 Rate Limiting

在單機環境中，rate limiter 只需要 in-memory 資料結構。但在微服務架構中，同一個 API 通常由多台伺服器提供服務，rate limiting 狀態必須跨節點共享。

### 核心挑戰

```
  分散式 Rate Limiting 的難題
  ============================

  User (limit: 10 req/min)
       │
       ├──→ Server A  (local count: 4)
       ├──→ Server B  (local count: 3)
       └──→ Server C  (local count: 5)

  每台 server 都認為 user 還沒超限，
  但實際上 user 已經發了 4+3+5 = 12 requests！

  解法：必須有一個共享的 truth source。
```

### 方案一：Centralized Store（Redis）

這是最常見的生產方案。所有 server 都向同一個 Redis cluster 查詢與更新 rate limit counter。

#### 基本實作：Redis INCR + EXPIRE

```
-- Fixed Window Counter (最簡單的版本)
-- Redis commands:

-- 方法 1: INCR + EXPIRE (有 race condition!)
INCR   rate_limit:{user_id}:{window}
EXPIRE rate_limit:{user_id}:{window} 60

-- 問題：如果 INCR 成功但 EXPIRE 失敗（例如 crash），
-- 這個 key 永遠不會過期，user 被永久封鎖！
```

#### Race Condition 問題與 Lua Script 解法

```
-- 問題情境：兩個 server 同時檢查同一個 user
-- Server A: GET counter → 4 (< limit 5)
-- Server B: GET counter → 4 (< limit 5)
-- Server A: INCR counter → 5
-- Server B: INCR counter → 6  ← 超限了但沒被擋！

-- 解法：使用 Lua Script 確保原子性

-- ===== Fixed Window Counter Lua Script =====
-- KEYS[1] = rate_limit:{user_id}:{window}
-- ARGV[1] = limit
-- ARGV[2] = window_size_seconds

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key) or '0')

if current >= limit then
    return 0  -- REJECTED
end

current = redis.call('INCR', key)

if current == 1 then
    redis.call('EXPIRE', key, window)
end

if current > limit then
    return 0  -- REJECTED (另一個 concurrent request 先 INCR 了)
end

return 1  -- ALLOWED
```

#### Token Bucket with Redis

```
-- ===== Token Bucket Lua Script =====
-- KEYS[1] = bucket:{user_id}
-- ARGV[1] = capacity
-- ARGV[2] = refill_rate (tokens per second)
-- ARGV[3] = now (unix timestamp with milliseconds)
-- ARGV[4] = cost (tokens to consume, usually 1)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1]) or capacity
local last_refill = tonumber(bucket[2]) or now

-- 計算應補充的 token
local elapsed = math.max(0, now - last_refill)
tokens = math.min(capacity, tokens + elapsed * refill_rate)

local allowed = 0
if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
end

-- 更新 bucket 狀態
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)

return allowed
```

#### Sliding Window Counter with Redis

```
-- ===== Sliding Window Counter Lua Script =====
-- KEYS[1] = prefix:{user_id}
-- ARGV[1] = limit
-- ARGV[2] = window_size (seconds)
-- ARGV[3] = now (unix timestamp)

local prefix = KEYS[1]
local limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local current_window = math.floor(now / window_size)
local previous_window = current_window - 1
local elapsed = now - (current_window * window_size)
local overlap_ratio = (window_size - elapsed) / window_size

local curr_key = prefix .. ':' .. current_window
local prev_key = prefix .. ':' .. previous_window

local prev_count = tonumber(redis.call('GET', prev_key) or '0')
local curr_count = tonumber(redis.call('GET', curr_key) or '0')

local weighted = curr_count + prev_count * overlap_ratio

if weighted >= limit then
    return 0  -- REJECTED
end

redis.call('INCR', curr_key)
redis.call('EXPIRE', curr_key, window_size * 2)

return 1  -- ALLOWED
```

#### Sliding Window Log with Redis Sorted Set

```
-- ===== Sliding Window Log with Redis =====

-- 使用 Sorted Set：score = timestamp, member = unique request ID

-- Step 1: 移除過期 entries
ZREMRANGEBYSCORE rate_limit:{user_id} 0 {now - window_size}

-- Step 2: 計算目前 window 內數量
ZCARD rate_limit:{user_id}

-- Step 3: 若未超限，加入新 entry
ZADD rate_limit:{user_id} {now} {unique_request_id}

-- Step 4: 設定 TTL 避免殭屍 key
EXPIRE rate_limit:{user_id} {window_size}

-- 注意：以上 4 個命令應包在 Lua script 或 MULTI/EXEC 中
-- 確保原子性！
```

### 方案二：Local Counter + Periodic Sync

每個 instance 維護自己的 local counter，定期與中央 store 同步。

```
  Local + Sync 架構
  =================

  Server A                  Server B
  ┌───────────┐            ┌───────────┐
  │ local: 3  │            │ local: 2  │
  │ budget: 3 │            │ budget: 3 │
  └─────┬─────┘            └─────┬─────┘
        │    sync every 5s       │
        └──────────┬─────────────┘
                   │
              ┌────▼────┐
              │  Redis   │
              │ global:5 │
              └──────────┘

  做法：
  - 將全域 limit 平均分配給每個 instance（budget = limit / N）
  - 每個 instance 在 local budget 內可以不經 Redis 直接決策
  - 定期 sync：回報消耗量，取得新的 budget

  優點：減少 Redis 壓力（10 instance × 1000 QPS = 只需 ~200 Redis ops/s 而非 10,000）
  缺點：精確度降低，短期內可能超限
```

適用場景：超高 QPS（> 100K req/s）、可容忍短暫超限的系統。

### 方案三：Sticky Sessions

透過 load balancer 將同一個 client 的所有 request 路由到同一台 server，如此每台 server 只需維護 local state。

```
  Sticky Session 架構
  ====================

  User A ──→ ┌──────────┐ ──always──→ Server 1 (只有 A 的 state)
              │   Load   │
  User B ──→ │ Balancer │ ──always──→ Server 2 (只有 B 的 state)
              │ (sticky) │
  User C ──→ └──────────┘ ──always──→ Server 1 (A + C 的 state)

  路由方式：
  - IP hash: hash(client_ip) % server_count
  - Cookie-based: 在 response 中設定 __sticky=server1
  - Consistent hashing: 更穩定的分配
```

**優點：** 零額外基礎設施、延遲最低、實作最簡單。
**缺點：** Server 掉線時 state 遺失（短暫超限）、負載不均、不適合有大量 NAT 的場景（大量使用者共享同一 IP）。

### 方案比較

| 維度 | Centralized Redis | Local + Sync | Sticky Sessions |
|---|---|---|---|
| 精確度 | 最高 | 中（受 sync 間隔影響） | 高（單機內精確） |
| 延遲 | +0.5~2ms（Redis RTT） | 幾乎零（local 決策） | 幾乎零 |
| Ops 負擔 | 需維護 Redis cluster | 中等 | 最低 |
| 容錯 | Redis 掛了 → 全部失效或 fail-open | Instance 掛了 → 只遺失該 instance 的 state | Server 掛了 → client re-route，state 遺失 |
| 適用規模 | < 100K req/s | 100K ~ 1M req/s | < 50K req/s |

---

## 4. 架構：Rate Limiter 放在哪裡

### 層級一：API Gateway Level

```
  Client → [API Gateway + Rate Limiter] → Upstream Services
           (AWS API Gateway / Kong / Envoy / Nginx)
```

- 在流量進入系統之前就攔截，保護所有下游服務
- AWS API Gateway 內建 Token Bucket（可設定 rate + burst）
- Kong 提供 `rate-limiting` plugin（支援 Redis backend）
- Envoy 的 `envoy.filters.http.ratelimit` 搭配外部 rate limit service

**適用場景：** 全域流量控制、防止 DDoS、API 計費。

### 層級二：Application Middleware Level

```
  Client → API Gateway → [App Server + Rate Limit Middleware] → DB
                          (Express middleware / Django decorator / Spring filter)
```

- 在 application code 中實作，能根據業務邏輯做更細緻的限流
- 例如：同一使用者對 `/api/search` 限 10 req/min，但 `/api/profile` 限 100 req/min
- 可以根據 user tier（free / pro / enterprise）動態調整 limit

**適用場景：** Per-endpoint 限流、business-logic-aware 限流。

### 層級三：Client-Side Rate Limiting

```
  [Client + Rate Limiter] → API Gateway → Services
  (SDK / retry logic / exponential backoff)
```

- Client SDK 內建限流，避免無意義的 retry storm
- 實作 exponential backoff with jitter：`delay = min(base * 2^attempt + random_jitter, max_delay)`
- Client 讀取 response header 中的 rate limit 資訊來調整行為

**適用場景：** SDK 設計、避免 thundering herd、好公民原則。

### 層級四：Multi-Tier Rate Limiting

生產環境通常需要多層限流，每層解決不同問題：

```
  Multi-Tier Rate Limiting 架構
  ==============================

  ┌─────────────────────────────────────────────┐
  │ Tier 1: Global Rate Limit (API Gateway)     │
  │ - 全系統 100K req/s 上限                      │
  │ - 防 DDoS、防系統過載                          │
  ├─────────────────────────────────────────────┤
  │ Tier 2: Per-User Rate Limit (Middleware)     │
  │ - Free: 100 req/min                         │
  │ - Pro: 1000 req/min                         │
  │ - Enterprise: 10000 req/min                 │
  ├─────────────────────────────────────────────┤
  │ Tier 3: Per-Endpoint Rate Limit             │
  │ - POST /api/upload: 5 req/min               │
  │ - GET /api/search: 30 req/min               │
  │ - GET /api/status: 300 req/min              │
  ├─────────────────────────────────────────────┤
  │ Tier 4: Per-Resource Rate Limit             │
  │ - 單一 DB connection pool: 500 concurrent   │
  │ - 外部 API call: 50 req/s                   │
  └─────────────────────────────────────────────┘

  Request 必須通過所有層級的檢查才能被處理。
  任何一層拒絕都會立即返回 429。
```

### 架構選擇指南

| 需求 | 建議方案 |
|---|---|
| 只需基本保護 | API Gateway 內建限流 |
| Per-user 差異化限流 | Application middleware + Redis |
| 超高流量（> 100K QPS） | Local counter + periodic sync |
| 計費/合規需求 | Sliding Window Log + audit trail |
| 微服務間互相限流 | Service mesh sidecar（Envoy/Istio） |

---

## 5. 架構師決策樹

根據你的具體需求，選擇最適合的演算法：

```
                        需要 Rate Limiting
                              │
                    ┌─────────┴─────────┐
                    │                   │
              是否需要允許             不需要 burst
              合理的 burst?            (嚴格平滑輸出)
                    │                   │
                    ▼                   ▼
              Token Bucket         Leaky Bucket
              (AWS, Stripe)        (Nginx, 流量整形)
                    │
                    │ 如果不需要 burst，
                    │ 但需要更高精確度？
                    │
          ┌─────────┴───────────────┐
          │                         │
     是否分散式部署?            單機部署?
          │                         │
          ▼                         ▼
    需要多高精確度?            任何演算法都可
          │                    (Token Bucket 最通用)
    ┌─────┴─────┐
    │           │
  可容忍近似   需要 100% 精確
    │           │
    ▼           ▼
  Sliding    Sliding
  Window     Window Log
  Counter    (記憶體昂貴，
  (推薦!)     僅限低流量)
    │
    │ 若 QPS 極高 (>100K)?
    ▼
  Fixed Window Counter
  (最快最省，接受邊界問題)

  ═══════════════════════════════════════
  快速指南：
  - 不確定選什麼？→ Sliding Window Counter
  - 需要 burst？   → Token Bucket
  - Nginx 限流？   → Leaky Bucket (已內建)
  - 記憶體極有限？ → Fixed Window Counter
  - 合規/計費？    → Sliding Window Log
  ═══════════════════════════════════════
```

### 依據營運條件的進階決策

| 條件 | 演算法 | 分散式方案 | 備註 |
|---|---|---|---|
| QPS < 1K、精確度優先 | Sliding Window Log | Centralized Redis (Sorted Set) | 記憶體可控 |
| QPS 1K~50K、平衡需求 | Sliding Window Counter | Centralized Redis (Lua Script) | **大多數場景的最佳選擇** |
| QPS 50K~500K、需要 burst | Token Bucket | Centralized Redis (HMSET) | 注意 Redis 頻寬 |
| QPS > 500K | Fixed Window / Token Bucket | Local + Periodic Sync | 犧牲精確度換取吞吐量 |
| 流量整形、恆定輸出 | Leaky Bucket | Sticky Sessions | 避免分散式 queue 的複雜度 |

---

## 6. 常見陷阱

### 陷阱一：分散式 Counter 的 Race Condition

```
  !! 經典 race condition !!

  Thread A: count = GET key        → 4
  Thread B: count = GET key        → 4
  Thread A: if count < 5 → SET key 5  (允許)
  Thread B: if count < 5 → SET key 5  (也允許！)

  結果：limit 5 但放了 6 個 request。

  修正方式：
  1. Redis Lua Script（原子操作）— 最佳方案
  2. Redis MULTI/EXEC（樂觀鎖）— WATCH key 後 pipeline
  3. Redis INCR 先增後查 — INCR 是原子的，若結果 > limit 則拒絕
     （但需要在拒絕後 DECR 回去，或接受微小的計數誤差）
```

**推薦做法：** 永遠使用 Lua Script。Redis 保證 Lua Script 在執行期間不會被其他命令打斷，天然解決 race condition。

### 陷阱二：未正確回傳 Rate Limit Headers

當 request 被限流時，必須提供足夠的資訊讓 client 知道該怎麼做：

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 12
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1710000060

{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded. Try again in 12 seconds.",
  "retry_after": 12
}
```

**必要的 header：**
- `Retry-After`：client 應等待的秒數（RFC 7231 標準）
- `X-RateLimit-Limit`：視窗內的總 quota
- `X-RateLimit-Remaining`：剩餘可用次數
- `X-RateLimit-Reset`：視窗重置的 Unix timestamp

IETF 正在標準化為 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`（draft-ietf-httpapi-ratelimit-headers）。新系統建議同時支援兩種命名。

**常見錯誤：** 只回 429 但沒有 `Retry-After`，導致 client 盲目重試（retry storm），反而加重系統負擔。

### 陷阱三：分散式系統中的 Clock Skew

```
  Clock Skew 問題
  ================

  Server A 的時鐘: 01:00:00
  Server B 的時鐘: 01:00:03  (快了 3 秒)

  使用 Fixed Window Counter，window = 01:00-01:59:
  - Server A 認為 request 在 Window N
  - Server B 認為 request 在 Window N（但實際上可能已經是 N+1）

  後果：
  - Sliding Window 演算法的加權計算出錯
  - Token Bucket 的 refill 計算偏差
  - 不同 server 對同一 request 做出不同決策
```

**解法：**
- 所有 server 使用 NTP 同步時鐘（正常偏差 < 10ms）
- 使用 centralized Redis 的 `TIME` 命令取得統一時間源
- 或者讓 Redis Lua Script 內部用 `redis.call('TIME')` 取得時間，不依賴 client 時鐘
- 設計上留 buffer：若 limit 是 100/min，內部實際設為 98/min，容忍少量偏差

### 陷阱四：Rate Limiting Key 的選擇

Rate limit 的 key（用什麼識別 client）選錯會導致嚴重問題：

| Key 類型 | 優點 | 缺點 |
|---|---|---|
| **IP Address** | 不需認證、適合匿名流量 | 共享 IP（NAT、VPN、公司網路）導致無辜使用者被連坐；攻擊者可換 IP 繞過 |
| **User ID** | 最精確、不受 IP 變化影響 | 需要認證；未登入的流量無法限制 |
| **API Key** | 適合 B2B API、計費友善 | Key 洩漏時需要 revoke；一個客戶可能有多個 key |
| **IP + User ID** | 兼顧匿名與認證流量 | 實作較複雜、需要兩套 limiter |

**最佳實踐：**
- 未認證流量：`IP address`（加上 `/24` subnet 聚合避免 NAT 問題）
- 已認證流量：`User ID` 或 `API Key`
- 關鍵 endpoint（如 login）：`IP + endpoint` 雙重限制

```
  錯誤示範：只用 IP 做 rate limit

  大型企業 NAT:
  10,000 名員工 ──→ [NAT Gateway] ──→ 單一公網 IP: 203.0.113.5
                                            │
                                       Rate Limiter:
                                       203.0.113.5 → 100 req/min
                                            │
                                       10,000 人共享 100 req/min
                                       每人平均只有 0.01 req/min！
```

### 陷阱五：Fail-Open vs Fail-Closed

當 rate limiter 本身故障（例如 Redis 掛了）時，系統該如何反應？

- **Fail-Open（放行所有 request）：** 系統可用性優先，但失去保護。適合大多數 API。
- **Fail-Closed（拒絕所有 request）：** 安全性優先，但會導致全站不可用。適合金融、安全敏感系統。

**建議：** 預設 Fail-Open，搭配監控告警。在 rate limiter 恢復前，可切換到降級模式（例如 local in-memory 限流，精確度低但聊勝於無）。

### 陷阱六：忽略 Retry Storm 與 Thundering Herd

```
  Retry Storm 場景
  ==================

  t=0s:  1000 clients 同時被 429
  t=1s:  1000 clients 同時 retry → 再次全部 429
  t=2s:  1000 clients 同時 retry → 再次全部 429
  ...
  系統永遠無法恢復！

  解法：Exponential Backoff with Jitter

  delay = min(base_delay * 2^attempt, max_delay) + random(0, jitter)

  Client A: retry in 1.3s
  Client B: retry in 1.7s
  Client C: retry in 0.9s
  → retry 被分散開，系統有喘息空間
```

**Server 端配合措施：**
- 在 429 response 中明確指定 `Retry-After`
- 對重複違規的 client 逐步延長 `Retry-After`（progressive penalty）
- 實作 circuit breaker，在系統過載時提前拒絕

---

## 附錄：快速參考

### Redis 命令速查表

| 演算法 | Redis 資料結構 | 核心命令 | 每次請求的 Redis ops |
|---|---|---|---|
| Fixed Window Counter | String | `INCR`, `EXPIRE` | 1-2 |
| Sliding Window Log | Sorted Set | `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD` | 3 |
| Sliding Window Counter | String (x2) | `GET` (x2), `INCR`, `EXPIRE` | 3-4 |
| Token Bucket | Hash | `HMGET`, `HMSET`, `EXPIRE` | 2-3 |

（所有操作建議封裝在 Lua Script 中執行，確保原子性。）

### HTTP Response 範本

```
# 正常回應（帶 rate limit 資訊）
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 67
X-RateLimit-Reset: 1710000060

# 被限流
HTTP/1.1 429 Too Many Requests
Retry-After: 23
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1710000060
Content-Type: application/json

{"error": "rate_limit_exceeded", "retry_after": 23}
```

### 容量估算範例

假設系統有 1M 活躍使用者，使用不同演算法的記憶體估算：

| 演算法 | Per-User 記憶體 | 1M Users 總記憶體 |
|---|---|---|
| Fixed Window Counter | ~20 bytes (key + counter + TTL) | ~20 MB |
| Sliding Window Counter | ~40 bytes (2 counters + timestamps) | ~40 MB |
| Token Bucket | ~32 bytes (tokens + last_refill) | ~32 MB |
| Sliding Window Log (100 req/min limit) | ~2 KB (100 timestamps) | **~2 GB** |
| Sliding Window Log (10K req/min limit) | ~160 KB (10K timestamps) | **~160 GB** |

這清楚顯示為何 Sliding Window Log 不適合高流量場景 — 記憶體成本隨 limit 線性增長。
