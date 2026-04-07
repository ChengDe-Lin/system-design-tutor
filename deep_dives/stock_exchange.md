# Stock Exchange / Matching Engine — 證券交易所撮合引擎架構

## 1. 核心挑戰

這個系統設計的獨特之處：**它拒絕了幾乎所有典型的分散式系統模式。** 沒有微服務、沒有 Kafka 在關鍵路徑上、沒有水平擴展。取而代之的是單執行緒 (Single-threaded)、垂直擴展 (Vertical Scaling)、嚴格排序 (Strict Ordering)。

```
規模（以 NYSE 為參考）：
  每日成交量: ~2-3B 股 → 高峰期 ~300K orders/sec
  撮合延遲: < 10μs（微秒級，不是毫秒級）
  上市股票數: ~8,000 symbols
  市場參與者: ~5,000 機構 + 數百萬散戶

核心矛盾：
  - 公平性要求全局嚴格排序 → 單執行緒處理
  - 單執行緒吞吐量上限 ~6M orders/sec（LMAX benchmark）
  - 延遲預算 < 10μs → 不能有任何 I/O、鎖、GC 在關鍵路徑上
  - 每一次記憶體分配、每一次 cache miss 都可能超出延遲預算

vs 典型分散式系統：
  Twitter: 350K reads/sec, < 200ms latency → 水平擴展 + 非同步
  交易所: 300K orders/sec, < 10μs latency → 單機 + 同步 + 零分配
  差距: 延遲要求嚴格 20,000 倍
```

---

## 2. 整體架構

```
                         ┌────────────────────────────────────────────────┐
                         │           Exchange Core (Co-located)           │
                         │                                                │
  Institutional ─────┐   │  ┌──────────┐   ┌──────────┐   ┌───────────┐  │
  (FIX Protocol)     │   │  │ Gateway  │   │  Risk    │   │ Matching  │  │
                     ├──▶│  │ (format  │──▶│ Engine   │──▶│ Engine    │  │
  Retail ────────────┤   │  │  + auth) │   │ (pre-    │   │ (order    │  │
  (REST/WebSocket)   │   │  └──────────┘   │  trade)  │   │  book +   │  │
                     │   │                 └──────────┘   │  matching) │  │
  Market Makers ─────┘   │                                └─────┬─────┘  │
                         │                                      │        │
                         │              ┌───────────────────────┘        │
                         │              │                                │
                         │              ▼                                │
                         │  ┌───────────────────┐  ┌────────────────┐   │
                         │  │   Sequencer       │  │  Journal       │   │
                         │  │  (Ring Buffer /   │  │  (WAL, append  │   │
                         │  │   LMAX Disruptor) │  │   only log)    │   │
                         │  └────────┬──────────┘  └────────────────┘   │
                         │           │                                   │
                         └───────────┼───────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                 │
                    ▼                ▼                 ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
          │ Market Data  │  │ Clearing &   │  │ Drop Copy /      │
          │ (UDP multi-  │  │ Settlement   │  │ Reporting        │
          │  cast + WS)  │  │ (T+1/T+2)   │  │ (Compliance)     │
          └──────────────┘  └──────────────┘  └──────────────────┘

關鍵路徑（Critical Path）：
  Gateway → Risk Engine → Sequencer → Matching Engine → Journal
  全程 in-process，無網路跳躍，無磁碟 I/O（Journal 是非同步寫入）
  端到端延遲目標: < 10μs
```

---

## 3. 訂單簿資料結構 (Order Book)

訂單簿是撮合引擎的心臟。每個股票 (Symbol) 有獨立的訂單簿。

### 邏輯結構

```
Order Book for AAPL:

  Buy Side (Bids)              Sell Side (Asks)
  ─────────────────            ─────────────────
  Price   | Orders             Price   | Orders
  ─────────────────            ─────────────────
  150.05  | [B1→B2→B3]        150.06  | [A1→A2]        ← Best Ask
  150.04  | [B4]               150.07  | [A3→A4→A5]
  150.03  | [B5→B6]            150.10  | [A6]
  ↑ Best Bid                   ...

  Spread = Best Ask - Best Bid = 150.06 - 150.05 = $0.01

  每個 Price Level 內部：FIFO 雙向鏈結串列 (Doubly-linked List)
  買方：Max-Heap by Price（最高價優先）
  賣方：Min-Heap by Price（最低價優先）
```

### 資料結構選擇

```
方案一：Red-Black Tree（std::map）
  - 價格層級用平衡二元搜尋樹
  - 每個節點 = 一個 Price Level → 內含 Doubly-linked List of Orders
  - Insert/Delete Price Level: O(log P), P = 活躍價格數
  - Best Bid/Ask: O(1)（cache tree min/max）
  - Cancel Order: O(1)（Order 有指向 linked list node 的指標）

方案二：Array-based（固定小數點價格）
  - 價格轉整數 index: $150.05 → index 15005（以 cent 為單位，即 $1 = 100）
  - 用陣列直接映射 price → order list
  - Lookup: O(1)
  - 但: 稀疏陣列浪費空間、不適合價格範圍極大的商品

實務選擇：
  股票（價格範圍有限）→ Array-based，O(1) lookup，cache 友好
  期貨/加密貨幣（價格範圍大）→ Red-Black Tree
```

### Order 資料結構

```c
struct Order {
    uint64_t order_id;       // 全局唯一 ID
    uint32_t symbol_id;      // 股票代碼
    uint8_t  side;           // BUY=0, SELL=1
    uint8_t  type;           // LIMIT=0, MARKET=1, STOP=2
    int64_t  price;          // 定點數, e.g. $150.05 → 15005 (cents)
    uint32_t quantity;       // 股數
    uint32_t filled_qty;     // 已成交股數
    uint64_t timestamp;      // 納秒級時間戳
    // Doubly-linked list pointers for O(1) cancel
    Order*   prev;
    Order*   next;
};
// sizeof(Order) ≈ 56 bytes（< 64 bytes，fits within 一個 CPU cache line）
```

---

## 4. 撮合演算法 (Price-Time Priority Matching)

### 訂單類型

| 訂單類型 | 行為 | 典型使用場景 |
|---------|------|------------|
| 限價單 (Limit Order) | 指定價格，不成交則掛在簿上等待 | 散戶指定價位買賣 |
| 市價單 (Market Order) | 不指定價格，以當前最佳價成交 | 立刻成交，不在乎價格 |
| 停損單 (Stop Order) | 價格觸及門檻時，轉為市價單 | 風險控制 |
| 取消單 (Cancel Order) | 從簿上移除已掛的限價單 | 撤單 |

### 撮合邏輯 Pseudocode

```python
def match_order(new_order, order_book):
    """Price-Time Priority Matching"""

    if new_order.type == CANCEL:
        return cancel_order(new_order.target_order_id, order_book)

    if new_order.type == STOP:
        # 先存入 stop book，觸發時轉為 market order
        order_book.stop_orders.add(new_order)
        return

    # 決定要匹配哪一側
    if new_order.side == BUY:
        opposite_side = order_book.asks   # 跟賣方匹配
        can_match = lambda ask_price: new_order.price >= ask_price  # Limit
    else:
        opposite_side = order_book.bids   # 跟買方匹配
        can_match = lambda bid_price: new_order.price <= bid_price  # Limit

    if new_order.type == MARKET:
        can_match = lambda price: True    # 市價單接受任何價格

    remaining_qty = new_order.quantity

    while remaining_qty > 0 and not opposite_side.is_empty():
        best_price_level = opposite_side.best()   # O(1)

        if not can_match(best_price_level.price):
            break   # 價格不匹配，停止

        # 在同一價格層級內，按時間順序 (FIFO) 撮合
        for resting_order in best_price_level.orders:  # 從最早的開始
            fill_qty = min(remaining_qty, resting_order.remaining())
            remaining_qty -= fill_qty
            resting_order.filled_qty += fill_qty

            # 產生成交事件
            emit(TradeEvent(
                price=best_price_level.price,  # 以掛單方的價格成交
                quantity=fill_qty,
                buyer=..., seller=...,
                timestamp=now_nanos()
            ))

            if resting_order.is_fully_filled():
                best_price_level.remove(resting_order)  # O(1) 鏈結串列移除

            if remaining_qty == 0:
                break

        if best_price_level.is_empty():
            opposite_side.remove_price_level(best_price_level)  # O(log P) 或 O(1)

    # 如果還有剩餘數量（限價單），掛到自己這一側
    if remaining_qty > 0 and new_order.type == LIMIT:
        new_order.quantity = remaining_qty
        order_book.add_to_book(new_order.side, new_order)  # 掛單

    # 如果是市價單且未完全成交 → 剩餘部分取消（不掛簿）
```

### 撮合範例

```
訂單簿初始狀態：
  Asks: 150.06 [Sell 100@A1, Sell 200@A2], 150.07 [Sell 300@A3]
  Bids: 150.05 [Buy 100@B1], 150.04 [Buy 200@B2]

新訂單：Buy Limit 350 shares @ 150.07

撮合過程：
  1. 對手方最佳價: Ask $150.06 ≤ 買入限價 $150.07 ✓
     - Match A1: fill 100 @ $150.06 → A1 完全成交, remaining = 250
     - Match A2: fill 200 @ $150.06 → A2 完全成交, remaining = 50
     - Price level $150.06 清空，移除

  2. 對手方次佳價: Ask $150.07 ≤ 買入限價 $150.07 ✓
     - Match A3: fill 50 @ $150.07 → A3 部分成交 (300→250), remaining = 0

結果：
  3 筆成交: (100@150.06, 200@150.06, 50@150.07)
  Asks: 150.07 [Sell 250@A3(部分)]
  Bids: 150.05 [Buy 100@B1], 150.04 [Buy 200@B2]
```

---

## 5. 定序器 (Sequencer) 與 LMAX Disruptor 模式

這是整個系統最反直覺的部分：**核心是單執行緒的。**

### 為什麼必須單執行緒？

```
價格-時間優先 (Price-Time Priority) 要求：
  1. 所有訂單有全局嚴格順序
  2. 先到的訂單優先成交
  3. 如果用多執行緒 + 鎖 → 順序不確定（哪個 thread 先搶到鎖？）
  4. 如果用分散式共識 → 延遲至少幾 ms（Raft/Paxos round trip）

公平性是監管要求（SEC / MAS / 金管會）：
  → 如果你的訂單先到但因為 race condition 後處理 = 違規
  → 單執行緒 = 物理上保證 FIFO，零爭議

反直覺：單執行緒夠快嗎？
  LMAX Disruptor benchmark: 6M events/sec on single thread
  NYSE 高峰: ~300K orders/sec
  → 單執行緒的頭部空間還有 20 倍
```

### LMAX Disruptor 模式

```
核心思想：Ring Buffer（環形緩衝區）+ Mechanical Sympathy（機械共鳴）

                    ┌───────────────────────────────┐
                    │        Ring Buffer            │
                    │   ┌───┬───┬───┬───┬───┬───┐   │
                    │   │ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │   │
                    │   └───┴───┴───┴───┴─▲─┴───┘   │
                    │         ▲           │         │
                    │         │           │         │
                    │      Writer      Reader(s)   │
                    │    (Sequencer)   (多個消費者)  │
                    └───────────────────────────────┘

設計原則：
  1. 預分配固定大小 Ring Buffer（通常 2^N 大小，如 2^20 = 1M slots）
  2. 單一 Writer（Sequencer）寫入 → 無鎖
  3. 多個 Reader 各自追蹤自己的位置 → 無鎖
  4. 每個 slot 大小 = CPU cache line (64 bytes) → 消除 false sharing
  5. 順序存取 → CPU prefetcher 友好，L1 cache hit rate > 99%

為什麼比 Queue + Lock 快？
  ConcurrentLinkedQueue:
    - 每次 enqueue/dequeue 可能觸發 CAS retry
    - 每個 node 是獨立物件 → GC pressure + cache miss
    - Latency: ~100-200ns per operation

  Ring Buffer (Disruptor):
    - 無 CAS、無鎖、無記憶體分配
    - 連續記憶體 → sequential access → cache line prefetch
    - Latency: ~10-50ns per operation（快 5-10 倍）
```

### Event Processing Pipeline

```
                Single Writer
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │              Ring Buffer (Journal)              │
  │  [Order1] [Order2] [Order3] [Order4] ...        │
  └──────┬──────────┬──────────┬──────────┬─────────┘
         │          │          │          │
         ▼          ▼          ▼          ▼
    Matching    Market Data  Risk       Journal
    Engine      Publisher    Reporter   Writer
    (Reader 1)  (Reader 2)  (Reader 3) (Reader 4)

每個 Reader 獨立消費，互不阻塞：
  - Matching Engine: 執行撮合邏輯
  - Market Data Publisher: 產生行情更新
  - Risk Reporter: 更新持倉風險
  - Journal Writer: 非同步持久化到磁碟
```

---

## 6. 風險管理引擎 (Pre-trade Risk Check)

風險檢查必須在撮合之前完成，但它在關鍵路徑上，延遲預算只有 **< 5μs**。

### 檢查項目

| 檢查類型 | 說明 | 實作方式 |
|---------|------|---------|
| 持倉限額 (Position Limit) | 單一帳戶不能持有超過 X 股 | In-memory HashMap: account → position |
| 信用額度 (Credit Limit) | 買入金額不超過帳戶額度 | In-memory: account → available_credit |
| 價格帶 (Price Band) | 訂單價格不能偏離參考價 ±N% | 比較當前 mid-price |
| 熔斷機制 (Circuit Breaker) | 價格劇烈波動時暫停交易 | 追蹤最近 5 分鐘的價格變化幅度 |
| 訊息速率 (Message Rate) | 防止一個客戶打爆系統 | Token bucket per client |

### 為什麼不能用外部服務做風控？

```
如果風控是獨立微服務：
  Matching Engine → gRPC call → Risk Service → response
  Network RTT (同機房): ~500μs
  序列化/反序列化: ~10μs
  → 光一個 round trip 就是 510μs，已超出 10μs 總延遲預算 50 倍

解決方案：Risk Engine 跟 Matching Engine 在同一個 process
  → 函數呼叫: ~10-50ns
  → 所有風控資料都在 L1/L2 cache 中
  → 用 pre-computed 的方式：每次成交後立刻更新 position/credit
     → 不需要每次都重新計算
```

---

## 7. 行情分發 (Market Data Distribution)

每一筆撮合產生三種資料：成交事件 (Trade)、訂單簿更新 (Book Update)、最佳買賣價更新 (BBO Update)。

### Fan-out 架構

```
Matching Engine 產生事件
         │
         ├──────────────────────────────────────┐
         │                                      │
         ▼                                      ▼
┌─────────────────────┐              ┌─────────────────────┐
│  UDP Multicast      │              │  WebSocket Gateway  │
│  (Co-located HFT)   │              │  (Retail / Web)     │
│                     │              │                     │
│  延遲: < 1μs        │              │  延遲: 1-10ms       │
│  協定: Binary        │              │  協定: JSON / Proto  │
│  接收者: ~100 firms  │              │  接收者: 數百萬用戶   │
│  可靠性: Best effort │              │  可靠性: TCP 保證    │
└─────────────────────┘              └─────────────────────┘
```

### 為什麼高頻交易 (HFT) 用 UDP Multicast？

```
TCP vs UDP for Market Data:

TCP:
  - 每個連線獨立 → 100 個訂閱者 = 發 100 次
  - Three-way handshake + ACK → 額外延遲
  - 壅塞控制可能降速
  - 但保證送達

UDP Multicast:
  - 一次發送 → 交換機複製到所有訂閱者
  - 無握手、無 ACK → 最低延遲
  - 不保證送達 → 但 HFT 有 sequence number + gap detection 自己重傳
  - 延遲: < 1μs (同機房 switch hop)

為什麼散戶用 WebSocket？
  - 散戶不在乎 1ms vs 1μs（人類反應時間 ~200ms）
  - WebSocket 走 TCP，穿越防火牆 / NAT
  - 可以做 throttle（每 100ms 推一次最新狀態，而非每筆成交都推）
```

### 行情資料層級

```
Level 1 (L1): Best Bid / Best Ask + Last Trade Price
  → 資料量最小，更新最頻繁
  → 所有人都需要

Level 2 (L2): Top 5-10 price levels 每一層的量
  → 專業交易者 / 造市商需要

Level 3 (L3): 完整訂單簿（每一筆掛單）
  → 只有交易所自己 / 監管者能看到
  → 資訊量巨大

頻寬估算（L1 for 8000 symbols, peak）:
  每個 BBO 更新 ~50 bytes
  高峰每 symbol ~100 updates/sec
  8000 × 100 × 50 = 40MB/sec → UDP multicast 完全扛得住
```

---

## 8. 持久化與災難復原 (Persistence & Recovery)

### Write-Ahead Log (Journal)

```
關鍵原則：Journal 是真理之源 (Source of Truth)，不是資料庫。

寫入流程：
  1. Sequencer 分配 sequence number
  2. Order + sequence number 寫入 Ring Buffer
  3. Matching Engine 從 Ring Buffer 讀取並撮合
  4. Journal Writer（非同步 Reader）將 Ring Buffer 內容 flush 到磁碟

  ┌────────────────────────────────────────────┐
  │ Journal (Append-only Sequential File)      │
  │ [seq=1, NewOrder, BUY AAPL 100@150.05]    │
  │ [seq=2, NewOrder, SELL AAPL 50@150.05]     │
  │ [seq=3, Trade, AAPL 50@150.05, B1↔A1]     │
  │ [seq=4, Cancel, OrderID=B1]                │
  │ ...                                        │
  └────────────────────────────────────────────┘

為什麼 Journal 不在關鍵路徑上？
  → 磁碟 fsync: ~1ms (SSD) → 比 10μs 慢 100 倍
  → 解法: 先撮合、再持久化（in-memory state 領先 disk 幾 ms）
  → 風險: 如果在 flush 前 crash → 丟失最近幾 ms 的交易
  → 接受: 用 replication 到 standby 來降低此風險
```

### Recovery 流程

```
Crash Recovery:
  1. 從 Journal 最新的 checkpoint 開始
  2. 逐條重放 (Replay) 每一筆 event
  3. 重建完整的 Order Book 狀態
  4. 重建 Risk Engine 的 position/credit 狀態
  5. 恢復到 crash 前的精確狀態（deterministic replay）

Recovery 時間估算:
  Journal size: ~500M events/day
  Replay speed: ~6M events/sec (single thread)
  → Full day replay: ~83 秒
  → 若有每小時 checkpoint → ~10 秒即可恢復
```

### Primary-Backup Replication

```
┌─────────────┐     Journal Stream     ┌─────────────┐
│   Primary   │ ───────────────────▶  │   Standby   │
│  (Active)   │    (TCP / RDMA)        │  (Passive)  │
│             │                        │             │
│ Matching    │                        │ Matching    │
│ Engine      │                        │ Engine      │
│ (processing)│                        │ (replaying) │
└─────────────┘                        └─────────────┘

Failover:
  - Standby 持續 replay Primary 的 journal stream
  - Primary crash → Standby promote to Primary（< 1 秒）
  - Standby 的 state 落後 Primary 僅幾 ms（journal streaming lag）

vs 傳統 DB replication:
  - 不用 Raft/Paxos（太慢）
  - 不用 async DB replication（state 不是在 DB 裡）
  - 直接 stream journal → replay → 精確複製
```

---

## 9. Gateway 層

### 協定分層

```
┌──────────────────────────────────────────────────────┐
│                    Gateway Layer                      │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ FIX Gateway  │  │ REST/WS     │  │ Binary     │  │
│  │ (機構客戶)    │  │ Gateway     │  │ Gateway    │  │
│  │              │  │ (散戶)       │  │ (HFT)      │  │
│  │ FIX 4.2/4.4 │  │ JSON/Proto  │  │ Custom     │  │
│  │ TCP          │  │ HTTP/WS     │  │ Protocol   │  │
│  └──────┬───────┘  └──────┬──────┘  └─────┬──────┘  │
│         │                 │               │          │
│         └────────────┬────┘───────────────┘          │
│                      │                               │
│                      ▼                               │
│              Internal Order Format                   │
│              (Normalized, Binary)                    │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
                 Risk Engine → Sequencer → Matching Engine

Gateway 職責（非關鍵路徑）：
  1. 協定轉換: FIX / JSON / Binary → 統一內部格式
  2. 身份驗證: API Key / Session Token
  3. 格式驗證: 欄位完整性、值域檢查
  4. 速率限制: Token bucket per client
  5. 連線管理: 心跳、斷線重連

為什麼 Gateway 在關鍵路徑之外？
  → Gateway 處理完後，把正規化的 order 丟進 Ring Buffer
  → Matching Engine 不等 Gateway，它只從 Ring Buffer 消費
  → Gateway 可以多節點水平擴展（它不需要嚴格排序）
```

### FIX Protocol (Financial Information eXchange)

```
FIX 是金融業的標準通訊協定（1992 年至今）：
  - 文字型 Key-Value 格式（Tag=Value）
  - 範例: 8=FIX.4.4|35=D|49=CLIENT1|55=AAPL|54=1|38=100|44=150.05|40=2|
    - Tag 35=D: New Order Single
    - Tag 55=AAPL: Symbol
    - Tag 54=1: Buy
    - Tag 38=100: Quantity
    - Tag 44=150.05: Price
    - Tag 40=2: Limit Order

  解析成本: ~1-5μs（文字解析較慢）
  HFT 替代方案: 自定義 Binary Protocol → < 100ns 解析
```

---

## 10. 按 Symbol 分片架構

### 自然分片

```
每個 Symbol 是獨立的 Order Book → 天然的分片邊界

                    ┌─────────────────────────┐
                    │     Order Router         │
                    │  (by Symbol Hash/Map)    │
                    └────┬──────┬──────┬───────┘
                         │      │      │
                    ┌────┘      │      └────┐
                    ▼           ▼           ▼
             ┌──────────┐ ┌──────────┐ ┌──────────┐
             │ Engine 1 │ │ Engine 2 │ │ Engine 3 │
             │ AAPL     │ │ TSLA     │ │ GOOG     │
             │ MSFT     │ │ NVDA     │ │ AMZN     │
             │ META     │ │ AMD      │ │ NFLX     │
             └──────────┘ └──────────┘ └──────────┘

每個 Engine:
  - 獨立的 single-threaded sequencer
  - 獨立的 Ring Buffer + Journal
  - 可以放在同一台機器的不同 CPU core（pinned thread）
  - 或放在不同機器上

分配策略:
  - 高交易量 symbol（AAPL, TSLA）→ 獨佔一個 core
  - 低交易量 symbol → 多個共享一個 core
  - 動態 rebalance（盤後調整，非交易時間）
```

### 跨 Symbol 訂單 (Cross-symbol)

```
套利/價差交易 (Spread Order): 同時買 AAPL + 賣 MSFT

挑戰: AAPL 和 MSFT 在不同的 Matching Engine

方案一: Coordinator（兩階段提交風格）
  - Coordinator 先鎖定兩邊 → 執行 → 確認/回滾
  - 延遲: 增加 ~10-50μs（兩次 round trip）
  - 用於期權/期貨的組合單

方案二: 事後調節 (Post-trade Reconciliation)
  - 兩邊各自獨立撮合
  - 事後檢查是否都成交 → 若只有一邊成交 → 取消另一邊
  - 延遲: 不影響關鍵路徑
  - 用於簡單的配對交易

實務中，>99% 的訂單是單一 symbol → 跨 symbol 是例外情況
```

---

## 11. 容量估算

| 指標 | 估算 |
|------|------|
| 每日訂單量 | ~500M orders |
| 高峰 QPS | ~300K orders/sec |
| 撮合延遲 (p99) | < 10μs |
| 上市 symbols | ~8,000 |
| 每個 Order 大小 | ~64 bytes (binary) |
| Journal 大小/天 | 500M × 64B = **~32GB/day** |
| Order Book 記憶體 (per symbol) | ~10K 活躍訂單 × 64B = **640KB** |
| Order Book 記憶體 (全部) | 8000 × 640KB = **~5GB** → L3 cache 放得下 |
| Market Data 頻寬 (L1, peak) | 8000 × 100 × 50B = **~40MB/sec** |
| Journal 寫入頻寬 | 300K × 64B = **~19MB/sec** → SSD 輕鬆 |
| Recovery 時間 (full day replay) | 500M / 6M per sec = **~83 秒** |
| Recovery 時間 (hourly checkpoint) | ~10 秒 |
| Risk Engine 記憶體 | ~100K accounts × 1KB = **~100MB** |

---

## 12. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 典型系統的做法 | 為什麼交易所不同 |
|---------|------|-------------|---------------|
| 執行緒模型 | **單執行緒 Sequencer** | 多執行緒 + 鎖 / Actor Model | 公平性要求全局嚴格排序，鎖的開銷 (~100ns) 已是延遲預算的 1% |
| 擴展方式 | **垂直擴展 + 按 Symbol 分片** | 水平擴展 (stateless + LB) | 單一 Order Book 無法跨機器分割（state 太 hot） |
| 資料一致性 | **單一寫入者 → 線性化** | 分散式共識 (Raft/Paxos) | Raft round trip ~1ms，比延遲預算慢 100 倍 |
| 持久化策略 | **非同步 Journal（寫後確認）** | 同步 fsync 再回應 | fsync ~1ms，無法接受；用 replication 補償 durability |
| 通訊方式 | **In-process 函數呼叫** | gRPC / REST / Message Queue | 任何 network hop ≥ 500μs，遠超延遲預算 |
| 記憶體管理 | **預分配 + 零 GC** | Dynamic allocation + GC | GC pause ~10ms（Java）= 延遲預算的 1000 倍 |
| 行情分發 | **UDP Multicast (HFT) + WebSocket (Retail)** | Kafka → Consumer Group | Kafka 延遲 ~1-5ms，HFT 需要 < 1μs |
| 風控 | **Co-located in-memory** | 獨立微服務 | 微服務 round trip ~500μs，超出預算 50 倍 |

### 一句話總結

> **交易所是 latency budget 驅動的設計。** 當你的延遲預算只有 10μs，所有分散式系統的經典模式（微服務、message queue、distributed consensus、horizontal scaling）都因為延遲成本而被排除。你被迫回歸最原始的架構：單機、單執行緒、in-process、預分配。這不是退步，而是物理極限下的最佳解。

---

## 13. 面試常見 Follow-up

### Q: 如果 Matching Engine crash 了怎麼辦？

```
1. Standby 在持續 replay Primary 的 journal stream
2. 偵測到 Primary 心跳消失 → Standby promote（< 1 秒）
3. Standby 的 Order Book state 與 Primary 幾乎一致（延遲僅幾 ms）
4. Gateway 重新連到新 Primary → 繼續處理

注意：crash 時 in-flight 的訂單（已進 Ring Buffer 但未 flush 到 journal 的）
  → 可能丟失 → 這就是「非同步 journal」的 trade-off
  → 緩解: Standby 也從 Ring Buffer 讀（而非從 journal），則 lag 更小
```

### Q: 怎麼處理 Flash Crash（閃崩）？

```
多層防護：
  1. 價格帶 (Price Band): 訂單價格偏離參考價 > 5% → 拒絕
  2. 熔斷 (Circuit Breaker): 5 分鐘內跌 > 7% → 暫停交易 15 分鐘
  3. 波動性中斷 (Volatility Interrupt): 觸及漲跌停 → 進入集合競價
  4. Kill Switch: 監管者手動暫停整個市場

2010 Flash Crash 教訓：
  → Dow Jones 5 分鐘內跌 ~1000 點
  → 後來 SEC 要求所有交易所實作 "Limit Up / Limit Down" 機制
  → 這些都是 Risk Engine 的功能
```

### Q: 為什麼不用 Kafka 做 Event Sourcing？

```
Kafka 的延遲特性：
  - Producer → Broker → Consumer: ~1-5ms（best case）
  - 包含: 序列化、網路傳輸、磁碟寫入（Kafka 要 fsync）、反序列化
  - 1ms = 1000μs → 比 10μs 延遲預算慢 100 倍

Kafka 適合的場景：
  - 下游系統（結算、報告、分析）→ 不在關鍵路徑上
  - 交易所確實在下游使用 Kafka 分發事件
  - 但關鍵路徑上用的是自建的 Ring Buffer + Journal

類比：
  Ring Buffer = F1 賽車引擎（極致速度，犧牲通用性）
  Kafka = 貨運卡車引擎（大吞吐，犧牲延遲）
```

### Q: 如何保證不會超賣（Overselling）？

```
風控在撮合前：
  1. 新的 Sell Order 到達
  2. Risk Engine 檢查: 帳戶持有 AAPL 股數 ≥ 賣出數量？
  3. 若不足 → 拒絕訂單（不進入 Matching Engine）
  4. 若足夠 → 預扣 (Reserve) 持倉 → 進入撮合

關鍵: 因為是單執行緒 → 不會有兩個 thread 同時讀到相同的持倉數量
  → 天然避免了 race condition → 不需要分散式鎖
```

### Q: 為什麼用 C++ / Rust 而不是 Java？

```
Java 的致命問題: GC (Garbage Collection)
  - G1 GC pause: ~10-50ms（worst case）
  - 10ms = 10,000μs → 延遲預算的 1000 倍
  - 即使 Shenandoah/ZGC: ~1ms pause → 仍是 100 倍

LMAX 的 Java 方案（例外）：
  - 零分配 (Zero Allocation): 預分配所有物件，不在交易路徑上 new 任何東西
  - Ring Buffer 用 long[] 陣列而非 Object[]
  - 關閉 GC 或將 GC 推遲到收盤後
  → 證明 Java 也可以做到，但需要極端紀律

主流交易所選擇：
  - NYSE (Pillar): C++
  - CME (Globex): C++
  - LSE (Millennium): C++ / FPGA
  - LMAX: Java（with zero-allocation discipline）
  - 加密貨幣交易所: Rust / C++ / Go（延遲要求較低）
```

---

## 14. 面試策略：講述順序建議

1. **需求釐清 + 延遲約束**（2 分鐘）— 明確提出 < 10μs 的延遲要求，計算 QPS (~300K orders/sec)，點出這個延遲約束如何顛覆典型分散式架構
2. **整體架構 + 關鍵路徑**（2 分鐘）— 畫出 Gateway → Risk → Sequencer → Matching Engine → Journal 的關鍵路徑，強調全部 in-process、零網路跳躍
3. **Order Book 資料結構**（2 分鐘）— 解釋 Bid/Ask 雙邊、Price Level → Linked List、O(1) cancel，說明為什麼用 array-based 而非 tree
4. **撮合演算法 (Price-Time Priority)**（2 分鐘）— 用具體範例走一遍 matching 流程，展示 partial fill
5. **Sequencer + LMAX Disruptor**（2 分鐘）— 解釋為什麼必須單執行緒（公平性），Ring Buffer 如何達到 6M events/sec，mechanical sympathy
6. **與典型系統設計的對比**（1 分鐘）— 明確說出「沒有微服務、沒有 Kafka、沒有水平擴展」，解釋為什麼每一個都被排除
7. **Deep Dive（面試官選）**（2 分鐘）— Market Data (UDP multicast)、Recovery (journal replay)、Risk Engine、Symbol sharding
