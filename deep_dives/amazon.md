# E-commerce System (Amazon-scale) — 大規模電商平台架構

## 1. 核心挑戰

Amazon-scale 電商的核心困難是 **庫存一致性 (Inventory Consistency)** 與 **高並發結帳流程 (Checkout Orchestration)**：

```
規模：
  DAU: ~300M
  產品總數 (Product Catalog): ~350M SKUs
  瀏覽量 (Browse): ~5B page views/day → ~58K reads/sec
  搜尋 (Search): ~1B queries/day → ~12K queries/sec
  加入購物車: ~500M/day → ~6K writes/sec
  下單 (Orders): ~30M/day → ~350 orders/sec (peak ~5K/sec)
  GMV: ~$1.5B/day

Read:Write ratio ≈ 100:1（瀏覽 >> 購買）

核心矛盾：
  - 產品頁要極快（< 200ms），但庫存數字要即時準確
  - 結帳涉及 5+ 個服務的分散式交易，任一步失敗都要補償
  - Flash Sale 瞬間：庫存 1000 件，10 萬人同時搶 → 不能超賣
  - 購物車是有狀態的，但要跨裝置同步、Guest → User 遷移
```

---

## 2. 整體架構

```
┌──────────┐
│  Client  │
│(Web/App) │
└────┬─────┘
     │
     ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│   API GW /   │───▶│  Product Catalog │───▶│  Elasticsearch   │
│   CDN / LB   │    │    Service       │    │  (Search/Facets)  │
│              │    └────────┬────────┘    └──────────────────┘
│              │             │ cache
│              │             ▼
│              │    ┌─────────────────┐
│              │    │   Redis / CDN    │  ← product page cache
│              │    └─────────────────┘
│              │
│              │───▶┌─────────────────┐    ┌──────────────────┐
│              │    │  Shopping Cart   │───▶│  Redis / DynamoDB │
│              │    │    Service       │    │  (Cart Store)     │
│              │    └─────────────────┘    └──────────────────┘
│              │
│              │───▶┌─────────────────┐    ┌──────────────────┐
│              │    │  Checkout        │───▶│  Order DB         │
│              │    │  Orchestrator    │    │  (MySQL sharded)  │
│              │    │  (Saga)          │    └──────────────────┘
│              │    └───┬──┬──┬──┬────┘
│              │        │  │  │  │
│              │        │  │  │  └──▶ Payment Service (Stripe/內部)
│              │        │  │  └─────▶ Pricing Service (coupon/promo)
│              │        │  └────────▶ Shipping Service (rates/carriers)
│              │        └───────────▶ Inventory Service
│              │                          │
│              │                    ┌─────┴──────────┐
│              │                    │  Inventory DB   │
│              │                    │  (MySQL + Redis) │
│              │                    └────────────────┘
│              │
└──────────────┘
       │
       │  events (async)
       ▼
┌──────────────┐    ┌──────────────────┐
│    Kafka     │───▶│  Notification    │
│  Event Bus   │───▶│  Analytics       │
│              │───▶│  Warehouse Mgmt  │
└──────────────┘    └──────────────────┘
```

核心原則：**Database per Service**。Product DB、Order DB、Inventory DB、Cart Store 各自獨立，服務間透過 API 或 Event Bus 通訊，不共享 DB。

---

## 3. Product Catalog Service

### 資料模型

```sql
products:
  product_id    BIGINT PRIMARY KEY    -- 商品（如 "iPhone 15"）
  title         VARCHAR(500)
  description   TEXT
  brand_id      BIGINT
  category_id   BIGINT
  base_price    DECIMAL(10,2)
  attributes    JSON                  -- {"color": ["Black","White"], "storage": ["128GB","256GB"]}
  images        JSON                  -- ["https://cdn.../img1.jpg", ...]
  rating_avg    DECIMAL(2,1)
  review_count  INT
  status        ENUM('ACTIVE','INACTIVE','DRAFT')
  created_at    TIMESTAMP

skus:
  sku_id        BIGINT PRIMARY KEY    -- 最小可購買單位（如 "iPhone 15 Black 128GB"）
  product_id    BIGINT
  variant_attrs JSON                  -- {"color": "Black", "storage": "128GB"}
  price         DECIMAL(10,2)         -- 可覆寫 base_price
  weight_grams  INT
  status        ENUM('ACTIVE','INACTIVE')

categories:
  category_id   BIGINT PRIMARY KEY
  parent_id     BIGINT                -- 樹狀結構：Electronics > Phones > Smartphones
  name          VARCHAR(200)
  path          VARCHAR(1000)         -- "electronics/phones/smartphones" (materialized path)
```

Product vs SKU 的區分至關重要：一個 Product 可以有數十個 SKU（顏色 × 尺寸 × 規格的排列組合），庫存管理 (Inventory) 的粒度是 SKU，不是 Product。

### 讀取路徑與快取策略

```
Product Page 讀取路徑（read-heavy，~58K/sec）：

  Client → CDN (edge cache, TTL 5 min) → API Gateway → Product Service → Redis → MySQL

  Cache 分層：
  L1: CDN — 靜態部分（圖片、描述），TTL 5-15 min
  L2: Redis — API response cache，TTL 1-5 min
  L3: MySQL — source of truth

  為什麼 CDN TTL 可以到 5 min？
    → 商品資訊極少變動（標題、圖片、描述幾天才改一次）
    → 價格可能變動 → 但顯示價格允許 5 min 延遲
    → 庫存狀態另外一個 API 拿（不在 product page cache 裡）
    → 結帳時會再次驗證最新價格和庫存（不依賴 cache）

  Cache hit rate 預估：
    350M SKU，但 80/20 法則 → 20% 熱門商品佔 80% 流量
    → 70M 熱門 SKU × 2KB avg = ~140GB Redis → 合理（幾十個 Redis node）
    → Cache hit rate 預估 > 95%
```

### CQRS（Command Query Responsibility Segregation）

```
Write Model（正規化）：                Read Model（反正規化）：
  products table                        product_read_views table
  skus table            ──event──▶        product_id
  categories table      (Kafka)           title, description, brand_name
  brands table                            category_path
                                          all_skus_json
                                          price_range
                                          rating_avg, review_count
                                          main_image_url

  商品更新 → 寫 Write Model → 發 event → Consumer 重建 Read Model
  Product Page 讀取 → 直接讀 Read Model → 一次查詢，不需 JOIN
```

CQRS 的好處：Write Model 維持正規化保證資料一致性；Read Model 為前端查詢優化，單次查詢取得完整產品頁所需資料。延遲約 100-500ms（event propagation），對瀏覽體驗無影響。

---

## 4. Search and Discovery（搜尋與探索）

### Elasticsearch 架構

```
資料同步：
  Product Service → Kafka → ES Indexer → Elasticsearch Cluster

Index 設計：
  products index:
    - title (text, analyzed)
    - description (text, analyzed)
    - brand (keyword, for facet filter)
    - category_path (keyword, hierarchical facet)
    - price (float, for range filter)
    - rating_avg (float, for range filter)
    - attributes.color (keyword)
    - attributes.size (keyword)
    - in_stock (boolean)
    - sales_count (long, for popularity ranking)

查詢範例 — Faceted Search（分面搜尋）：
  POST /products/_search
  {
    "query": { "bool": {
      "must": [{ "multi_match": { "query": "wireless headphones", "fields": ["title^3", "description"] }}],
      "filter": [
        { "term": { "brand": "Sony" }},
        { "range": { "price": { "gte": 50, "lte": 200 }}},
        { "term": { "in_stock": true }}
      ]
    }},
    "aggs": {
      "brands": { "terms": { "field": "brand", "size": 20 }},
      "price_ranges": { "histogram": { "field": "price", "interval": 50 }},
      "ratings": { "terms": { "field": "rating_bucket" }}
    },
    "sort": [{ "_score": "desc" }, { "sales_count": "desc" }]
  }
```

### Typeahead / Autocomplete

```
方案：ES Completion Suggester + Redis 前綴快取

  User 輸入 "wire" →
    1. Redis 查 autocomplete:wire → ["wireless headphones", "wireless charger", "wireless mouse"]
       → 命中即回傳（< 5ms）
    2. Cache miss → ES Completion Suggester → 結果寫回 Redis（TTL 1hr）

  資料來源：熱門搜尋詞、商品標題、品牌名
  更新頻率：每小時從搜尋日誌重建熱門前綴

  個性化排序：
    基本 relevance score × popularity_boost × personalization_boost
    personalization_boost = f(user 過去購買品類、瀏覽歷史)
    → 用 Kafka 收集 user behavior events → 離線計算 user profile → 線上查詢時融合
```

---

## 5. Shopping Cart Service

### 設計原則

購物車 (Shopping Cart) 是 **有狀態但需要高可用** 的服務。設計為 **stateless service + 外部 state store**。

### 資料模型

```
Redis Hash 結構（主方案）：

  Key:   cart:{user_id}  或  cart:{guest_id}
  Field: sku_id
  Value: JSON { "quantity": 2, "price_snapshot": 29.99, "added_at": 1700000000 }

  HSET cart:user_123 sku_456 '{"quantity":2,"price_snapshot":29.99,"added_at":1700000000}'
  HGETALL cart:user_123  → 取得整個購物車

  TTL: 30 天（EXPIRE cart:user_123 2592000）
  → 30 天未修改自動過期，避免無限堆積

替代方案比較：
  Redis Hash:  低延遲（< 1ms），但重啟可能丟失 → 需 RDB/AOF 持久化
  DynamoDB:    持久化保證，單位數 ms 延遲，但成本較高
  Amazon 實際: DynamoDB（Dynamo 論文最初就是為購物車設計的）
```

### Guest Cart → User Cart 合併

```
Guest 瀏覽加入購物車 → cart:guest_abc123
User 登入 → 需要合併 guest cart 到 user cart

合併策略：
  1. 讀取 cart:guest_abc123 所有 items
  2. 讀取 cart:user_123 所有 items
  3. 合併邏輯：
     - 相同 SKU → 取較大的 quantity（或相加，看商業需求）
     - 不同 SKU → 直接加入
     - 更新 price_snapshot 為最新價格
  4. 寫入 cart:user_123
  5. 刪除 cart:guest_abc123

  注意：合併操作需要原子性
    → Redis: 用 Lua script 保證原子
    → DynamoDB: 用 TransactWriteItems

  Lua script 範例（Redis）：
    local guest_cart = redis.call('HGETALL', KEYS[1])
    local user_cart = redis.call('HGETALL', KEYS[2])
    -- merge logic...
    redis.call('DEL', KEYS[1])
    return 'OK'
```

---

## 6. Inventory Management（庫存管理 — 核心難題）

這是整個電商系統 **最關鍵的設計決策**。核心問題：如何在高並發下防止超賣 (Oversell)。

### 庫存狀態模型

```
inventory:
  sku_id        BIGINT PRIMARY KEY
  warehouse_id  BIGINT
  available     INT          -- 可售數量
  reserved      INT          -- 已預留（等待付款確認）
  sold          INT          -- 已售出
  total         INT          -- available + reserved + sold = total（永遠守恆）

  CHECK (available >= 0)
  CHECK (reserved >= 0)
  UNIQUE (sku_id, warehouse_id)  -- 每個倉庫獨立管理庫存
```

### Two-Phase Inventory Reservation（兩階段庫存預留）

```
Phase 1: Soft Reserve（結帳時預留）
  UPDATE inventory
  SET available = available - :qty,
      reserved = reserved + :qty
  WHERE sku_id = :sku_id
    AND warehouse_id = :wh_id
    AND available >= :qty;          ← 關鍵：WHERE available >= qty 防止超賣
  -- affected_rows == 0 → 庫存不足，拒絕

Phase 2a: Hard Commit（付款成功）
  UPDATE inventory
  SET reserved = reserved - :qty,
      sold = sold + :qty
  WHERE sku_id = :sku_id AND warehouse_id = :wh_id;

Phase 2b: Release（付款失敗 / 超時 / 取消）
  UPDATE inventory
  SET reserved = reserved - :qty,
      available = available + :qty
  WHERE sku_id = :sku_id AND warehouse_id = :wh_id;

  超時釋放機制：
    - 預留時記錄 reservation_expires_at = NOW() + 15 min
    - 背景 Worker 每分鐘掃描過期預留 → 執行 Release
    - 或用 Delayed Queue（RabbitMQ TTL / SQS delay）15 min 後觸發 Release
```

### 為什麼 `WHERE available >= qty` 就夠了？

```
MySQL InnoDB 的 Row-Level Lock：
  UPDATE ... WHERE sku_id = X → 對這行加 X lock（排他鎖）
  → 並發 UPDATE 同一 sku_id 會序列化執行
  → available >= qty 的檢查在鎖內，不會有 race condition

  10 個並發請求同時要買最後 1 件：
    Request 1: 獲得 row lock → available=1 >= 1 → 扣減成功 → available=0 → 釋放鎖
    Request 2-10: 獲得 row lock → available=0 >= 1 → false → affected_rows=0 → 庫存不足

  效能：每個 sku 的 UPDATE 序列化，但不同 sku 完全並行
    → 一般情境完全夠用
    → 問題場景：Flash Sale，同一個 sku 瞬間萬級並發
```

### Flash Sale 高併發策略

```
問題：MySQL row lock 下，10 萬人搶同一個 SKU → 序列化排隊 → 延遲飆升

方案：Redis Lua Script 前置扣減

  -- 預先載入庫存到 Redis
  SET inventory:sku_789 1000   -- Flash sale 開始前

  -- Lua Script（原子操作）：
  local stock = tonumber(redis.call('GET', KEYS[1]))
  if stock >= tonumber(ARGV[1]) then
    redis.call('DECRBY', KEYS[1], ARGV[1])
    return 1   -- 預留成功
  else
    return 0   -- 庫存不足
  end

  效能：
    Redis 單線程執行 Lua → 天然序列化，無鎖競爭
    Redis DECRBY 性能：~100K ops/sec（單 key）
    → 10 萬人搶購 → 1 秒內全部處理完

  Redis 扣減成功後：
    → 非同步寫入 MySQL（最終一致性）
    → 如果 MySQL 寫入失敗 → Redis 回補 INCRBY
    → 引入 Kafka 保證可靠性：Redis 扣減 → Kafka event → Consumer 寫 MySQL

  風險與補償：
    Redis 宕機 → 庫存數字丟失
    → 解法：Redis 持久化 + 定期從 MySQL 校準
    → Flash Sale 結束後強制對帳（reconciliation）
```

### Multi-Warehouse 庫存分配

```
用戶下單時，如何選擇從哪個倉庫出貨？

Proximity-Based Allocation（就近分配）：
  1. 根據用戶配送地址 → 計算距離最近的倉庫
  2. 最近倉庫有庫存 → 從該倉庫預留
  3. 最近倉庫無庫存 → 第二近 → 依此類推
  4. 所有倉庫都無庫存 → 缺貨

  SELECT warehouse_id, available
  FROM inventory
  WHERE sku_id = :sku_id AND available >= :qty
  ORDER BY distance(warehouse_lat_lng, :user_lat_lng)
  LIMIT 1;

  進階：一張訂單多個 SKU → 盡量從同一個倉庫出（減少分拆包裹的運費）
    → NP-hard 的倉庫分配問題，實務上用貪心演算法 + 啟發式
```

---

## 7. Order Service（訂單服務）

### Order 狀態機 (State Machine)

```
CREATED → PAYMENT_PENDING → PAID → PICKING → SHIPPED → DELIVERED
                 │                    │          │
                 ▼                    ▼          ▼
            CANCELLED            CANCELLED   RETURNED
            (付款超時/            (退款)      (退貨退款)
             用戶取消)

狀態轉移規則（嚴格定義，不允許跳躍）：
  CREATED → PAYMENT_PENDING   : checkout 開始
  PAYMENT_PENDING → PAID      : payment gateway 確認
  PAYMENT_PENDING → CANCELLED : 15 min 未付款自動取消
  PAID → PICKING              : 倉庫開始揀貨
  PAID → CANCELLED            : 用戶退款（揀貨前）
  PICKING → SHIPPED           : 交給物流
  SHIPPED → DELIVERED         : 物流確認送達
  DELIVERED → RETURNED        : 用戶退貨（7 天內）
```

### 資料模型

```sql
orders:
  order_id        BIGINT PRIMARY KEY    -- Snowflake ID（含時間戳，方便 shard）
  user_id         BIGINT
  status          ENUM(...)
  subtotal        DECIMAL(12,2)
  shipping_fee    DECIMAL(8,2)
  tax             DECIMAL(8,2)
  discount        DECIMAL(8,2)          -- coupon / promo
  total           DECIMAL(12,2)
  shipping_addr   JSON
  created_at      TIMESTAMP
  updated_at      TIMESTAMP

order_items:
  order_item_id   BIGINT PRIMARY KEY
  order_id        BIGINT
  sku_id          BIGINT
  quantity        INT
  unit_price      DECIMAL(10,2)         -- 下單時的價格快照（不隨後續價格變動）
  warehouse_id    BIGINT                -- 分配的出貨倉庫

order_events:                           -- Event Sourcing：所有變更記錄
  event_id        BIGINT PRIMARY KEY
  order_id        BIGINT
  event_type      VARCHAR(50)           -- 'CREATED','PAYMENT_CONFIRMED','SHIPPED',...
  payload         JSON
  created_at      TIMESTAMP

INDEX idx_user_orders (user_id, created_at DESC)  -- 「我的訂單」查詢
```

Order 是 **不可變記錄 (Immutable Record)**——狀態變更不是 UPDATE orders SET status，而是插入一筆新的 order_event。orders.status 是從 order_events 衍生的 materialized view，方便查詢。

### Order ID 設計 — Snowflake-like

```
64 bits:
  [1 bit unused][41 bits timestamp][5 bits datacenter][5 bits machine][12 bits sequence]

  41 bits timestamp → ~69 年
  12 bits sequence → 每 ms 4096 個 ID → 每秒 ~400 萬

好處：
  1. 全局唯一，無需中央協調
  2. 包含時間 → 天然按時間排序
  3. 包含時間 → 可以按月/年 range shard（ORDER BY created_at 只打一個 shard）
  4. 不是直接自增（含 timestamp + machine ID + sequence），但仍可被推算出大致時間和速率。如需隱藏業務量，考慮 UUIDv4 或加密後的 ID
```

---

## 8. Checkout Orchestration — Saga Pattern

結帳 (Checkout) 跨越 5+ 個服務，不能用傳統 2PC (Two-Phase Commit)——延遲太高、可用性太低。用 **Saga 模式 (Saga Pattern)**，每步有對應的補償操作 (Compensating Transaction)。

### 為什麼用 Orchestrator 而非 Choreography？

```
Choreography（事件驅動）：
  每個服務聽 event → 做自己的事 → 發 event 通知下一個
  問題：結帳流程有嚴格順序性 + 複雜的分支邏輯
    → 哪個 coupon 失敗要跳過？部分庫存不足要降級？
    → Choreography 難以追蹤全局狀態，debug 困難

Orchestrator（中央協調）：
  Checkout Orchestrator 是唯一知道全局流程的服務
  → 依序呼叫各服務，根據結果決定下一步
  → 任一步失敗，Orchestrator 負責調用前面所有步驟的補償
  → 全局狀態集中，容易監控和 debug
```

### 完整流程與補償

```
Step  Forward Action              Compensating Action           Timeout
───── ──────────────────────────── ──────────────────────────── ───────
  1   Validate Cart               (無需補償)                    2s
      → 檢查所有 SKU 存在且 active
      → 重新計算價格（不信任 client 端價格）

  2   Reserve Inventory           Release Inventory            5s
      → 對每個 SKU 執行 soft reserve
      → 部分 SKU 缺貨 → 通知用戶，中止

  3   Apply Coupon / Promo        Reverse Coupon Usage         3s
      → 驗證 coupon 有效性
      → 扣減 coupon 使用次數

  4   Calculate Shipping           (無需補償)                    3s
      → 根據地址、重量、倉庫 → 選 carrier → 計算運費

  5   Process Payment             Refund Payment               30s
      → 呼叫 Payment Gateway（Stripe/自建）
      → 等待確認（可能需要 3D Secure 等額外驗證）

  6   Confirm Order               Cancel Order                 2s
      → 創建 Order record
      → 發 OrderConfirmed event → Kafka

失敗場景範例：
  Step 5 Payment 失敗 →
    Orchestrator 執行 compensating actions：
    Step 3 comp: 回補 coupon 使用次數
    Step 2 comp: 釋放已預留庫存
    → 通知用戶付款失敗

  Orchestrator 狀態持久化到 DB：
    saga_instances:
      saga_id, order_id, current_step, status, payload, created_at
    → 如果 Orchestrator crash → 重啟後讀取未完成的 saga → 繼續或補償
    → 每一步都要冪等 (Idempotent)：重試不會重複扣款/重複預留
```

### 冪等性保證（Idempotency）

```
每個 checkout 請求帶唯一的 idempotency_key（client 生成的 UUID）

Payment Service：
  1. 收到 payment request with idempotency_key
  2. 查 DB: SELECT * FROM payments WHERE idempotency_key = :key
  3. 已存在 → 直接回傳之前的結果（不重複扣款）
  4. 不存在 → 處理付款 → 記錄 idempotency_key + 結果

Inventory Service 同理：
  reservation_id 作為冪等 key → 重試 reserve 不會重複扣減
```

---

## 9. Pricing Service（定價服務）

### 價格計算邏輯

```
最終價格 = Base Price
           - Promotion Discount（滿減、折扣、買一送一）
           - Coupon Discount（優惠券）
           + Shipping Fee（運費）
           + Tax（稅金）

計算順序很重要：
  Promotion 先算 → 再疊 Coupon → 最後算稅
  （稅金基於折後價，不是原價）

價格一致性問題：
  商品頁顯示價格 vs 結帳時價格可能不同（promotions 可能在中間變動）

方案：Price Lock at Checkout
  1. 用戶進入結帳頁 → Pricing Service 計算最終價格 → 生成 price_quote_id
  2. price_quote: { quote_id, items, prices, discounts, total, expires_at: NOW()+15min }
  3. 付款時驗證 price_quote_id → 未過期就用快照價格
  4. 過期 → 重新計算 → 價格變了通知用戶確認

  快照存 Redis，TTL 15 min：
    SET price_quote:{quote_id} '{...}' EX 900
```

---

## 10. Shipping and Logistics（物流與配送）

```
結帳時計算運費：
  Input:  配送地址、SKU 列表（重量、尺寸）、出貨倉庫
  Output: [{carrier: "FedEx", method: "Ground", price: 5.99, eta: "3-5 days"},
           {carrier: "UPS",   method: "Express", price: 12.99, eta: "1-2 days"}]

Carrier Selection API：
  → 聚合多家物流商的 API（FedEx, UPS, USPS, DHL）
  → 根據目的地、重量、時效 → 選最佳組合
  → Cache 費率表（每日更新），避免每次呼叫外部 API

訂單出貨後 — Tracking Integration：
  → 每個 carrier 有 tracking API
  → 背景 poller 每小時查一次各 carrier 的 tracking status
  → 狀態更新 → Kafka event → Notification Service → 推播通知用戶
  → 或用 carrier webhook（FedEx/UPS 支援 push notification）
```

---

## 11. Event-Driven 架構（Kafka）

```
核心 Events 及其 Consumer：

OrderConfirmed event:
  → Inventory Service:  Hard commit（reserved → sold）
  → Notification Service: 發送訂單確認 email/push
  → Analytics Service: 記錄轉換率、GMV
  → Warehouse Service: 觸發揀貨排程

PaymentFailed event:
  → Inventory Service:  Release reserved inventory
  → Notification Service: 通知用戶付款失敗

OrderShipped event:
  → Notification Service: 發送出貨通知 + tracking link
  → Analytics Service: 記錄出貨時效

ProductUpdated event:
  → Search Indexer: 更新 ES index
  → CDN: Invalidate cache
  → Read Model Builder: 更新 CQRS read model

Kafka Topic 設計：
  orders.created        (partitioned by order_id)
  orders.status-changed (partitioned by order_id → 保證同一訂單的事件順序)
  inventory.reserved    (partitioned by sku_id)
  inventory.released    (partitioned by sku_id)
  products.updated      (partitioned by product_id)
  payments.completed    (partitioned by order_id)

  Partition key 選擇：
    → 同一 entity 的 events 必須在同一 partition → 保證 ordering
    → order events by order_id → 同一訂單的狀態變更不會亂序
```

---

## 12. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 300M |
| Product Catalog 總量 | 350M SKUs |
| Page views/day | 5B → **~58K reads/sec** |
| Search queries/day | 1B → **~12K queries/sec** |
| Add-to-cart/day | 500M → **~6K writes/sec** |
| Orders/day | 30M → **~350 orders/sec** (peak 5K/sec) |
| Product data (MySQL) | 350M × 5KB avg = **~1.75TB** |
| Product read cache (Redis) | 70M hot SKUs × 2KB = **~140GB** → 5-10 Redis nodes |
| Cart store (Redis/DynamoDB) | 100M active carts × 1KB = **~100GB** |
| Order DB/year | 30M/day × 365 × 2KB = **~22TB/year** |
| Inventory DB | 350M SKUs × 10 warehouses avg × 50B = **~175GB** |
| ES cluster (product search) | 350M docs × 3KB = ~1TB × 3 replicas = **~3TB** |
| Kafka throughput | ~50K events/sec (all topics combined) |
| Image storage (S3) | 350M products × 10 images × 500KB = **~1.75PB** |

### Flash Sale 峰值估算

```
情境：iPhone 新品搶購，庫存 10,000 件，100 萬人同時搶

  Peak checkout attempts: ~100K/sec（前 10 秒集中）
  Inventory writes on Redis: 100K Lua script exec/sec → Redis 扛得住
  MySQL inventory writes: Redis 過濾後只有 10K 成功 → 非同步寫 MySQL → 輕鬆

  關鍵瓶頸：Payment Gateway
    → 10K 筆同時付款 → Stripe rate limit 通常 ~10K/sec → 剛好能撐
    → 超過 → 排隊（queuing），用戶等待 → 需要前端顯示「排隊中」UX

  CDN/Static assets: 100 萬人同時看 product page
    → CDN 處理，Origin 不受影響
```

---

## 13. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Inventory 一致性 | **MySQL row lock + Redis Lua 前置** | 一般場景 MySQL 夠用；Flash Sale 用 Redis 預扣提升吞吐，非同步回寫 MySQL |
| Cart 儲存 | **Redis (Hash) + TTL 30 天** | 低延遲、結構簡單；DynamoDB 更持久但成本高。兩者皆可，看需求 |
| 結帳事務 | **Saga Orchestrator** | 跨 5+ 服務，不適合 2PC；Orchestrator 比 Choreography 更容易追蹤和 debug |
| 訂單紀錄 | **Event Sourcing（不可變 events）** | 完整稽核軌跡、支援狀態回放、避免 UPDATE 引發的資料丟失 |
| 讀寫分離 | **CQRS（Write normalized / Read denormalized）** | 產品頁讀取 100:1 壓倒性多數，denormalized read model 消除 JOIN |
| 服務間通訊 | **Kafka event bus** | 解耦、可重放、保證 ordering（同 partition）、高吞吐 |
| 搜尋引擎 | **Elasticsearch** | 全文搜尋 + faceted filtering + aggregation，MySQL 做不到 |
| 價格一致性 | **Checkout 時 price lock（15 min TTL）** | 顯示價格允許略微延遲，但結帳價格必須鎖定 |
| Order ID | **Snowflake** | 全局唯一 + 時間排序 + 可按時間 range shard |
| DB per service | **Product/Order/Inventory 各自獨立 DB** | 獨立 scale、獨立 schema 演進、避免跨服務 join 的耦合 |

---

## 14. 面試常見 Follow-up

### Q: 如何處理商品頁顯示「剩餘 3 件」但結帳時已賣完？

```
這是 eventual consistency 的典型問題。

商品頁的庫存數字來自 cache（Redis/CDN，延遲 1-5 min）
結帳時才去 Inventory Service 做 real-time check

方案：
  1. 商品頁顯示「庫存充足」/「庫存緊張」/「售罄」三級（不顯示精確數字）
     → 降低用戶對精確度的期待
  2. 結帳時庫存不足 → 友善提示「該商品剛被搶完」，推薦替代品
  3. 對庫存 < 10 的商品，跳過 cache 直接查 DB（低庫存 = 高準確度需求）
```

### Q: 如果支付成功但訂單創建失敗怎麼辦？

```
Saga Step 5 (Payment) 成功 → Step 6 (Create Order) 失敗

Orchestrator 的職責：
  1. 重試 Step 6（Create Order 應該是冪等的）
  2. 重試 N 次都失敗 → 執行 Step 5 的補償：Refund Payment
  3. 記錄異常事件 → 人工介入佇列

  關鍵：Payment Service 必須支援冪等 refund
    → refund request 帶 idempotency_key
    → 重複呼叫不會多退

  最壞情況：refund 也失敗（Payment Gateway 斷線）
    → 記錄到 dead letter queue → 運維人工處理
    → 有完整 saga log 可以追蹤哪一步出問題
```

### Q: 如何支援跨國電商（multi-region）？

```
挑戰：用戶遍布全球，延遲 + 資料法規

  1. Product Catalog: read replica per region
     → 東京、法蘭克福、維吉尼亞各一組 read replica
     → Write 回到 primary region → async replication（200-300ms lag OK）

  2. Inventory: 按倉庫 region 分區
     → 美國倉庫的庫存 → 美國 region DB 管理
     → 歐洲訂單查不到美國庫存 → 如果要跨 region 調貨 → 顯示較長配送時間

  3. Order: 按用戶 region shard
     → GDPR 要求歐洲用戶資料留在歐洲 → Order DB EU region

  4. CDN: 全球 edge cache（CloudFront / Akamai）
     → 靜態資源（圖片、CSS）→ edge hit rate > 99%
```

### Q: 如何做推薦系統？

```
"Customers who bought this also bought..."

  離線 Pipeline：
    Purchase history → Collaborative Filtering → Item-Item similarity matrix
    → 每天更新，存入推薦 DB（Redis sorted set）

  線上查詢：
    GET recommendations:{sku_id} → top 20 similar items
    → 過濾掉缺貨、下架的 → 回傳 top 10

  個人化：
    User browsing/purchase history → User embedding
    → 線上用 ANN (Approximate Nearest Neighbor) 找相似 items
    → 用 Kafka 收集 real-time signals（剛看過什麼）→ 融合推薦結果
```

---

## 15. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU、page view QPS、order QPS、SKU 數量。問面試官要聚焦哪個部分（通常是 Checkout + Inventory）。

2. **High-Level 架構 + Service 劃分**（2 分鐘）— 畫出核心服務（Product, Cart, Inventory, Order, Payment, Search），強調 Database per Service 原則。

3. **Inventory Management（核心）**（4 分鐘）— Two-phase reservation、`WHERE available >= qty` 防超賣、Flash Sale 的 Redis Lua 方案。這是最能展示深度的地方。

4. **Checkout Saga**（3 分鐘）— 6 步流程、每步的補償操作、冪等性保證。畫出 happy path 和 failure path。

5. **Product Catalog + Search**（1 分鐘）— CQRS、ES faceted search、CDN 分層快取。

6. **Deep Dive（面試官選）**（2 分鐘）— Shopping Cart（Guest merge）、Pricing（price lock）、Multi-warehouse allocation、或 Event-driven 架構。
