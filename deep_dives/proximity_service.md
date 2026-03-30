# Proximity Service — 附近搜尋系統架構（Yelp / Google Maps）

## 1. 核心挑戰

Proximity Service 和 Uber 表面上都做地理查詢，但本質完全不同：

```
全球商家數量：  ~200M（Google Maps 量級）
單一城市商家：  ~500K（紐約）
Read QPS：     ~100K queries/sec（全球），尖峰 ~300K
Write QPS：    ~500/sec（商家新增/更新，極低）
查詢延遲要求：  < 200ms（含排序）
資料特性：      靜態（商家地址幾乎不變）
```

關鍵差異（對比 Uber）：

| 維度 | Uber | Proximity Service |
|------|------|------------------|
| 資料類型 | 司機位置（ephemeral） | 商家資訊（persistent） |
| 更新頻率 | 每 3-5 秒 | 每天數百次（全球） |
| Read:Write 比 | ~1:12 | ~200,000:1 |
| Index 選型壓力 | 寫入效能 | 讀取效能 + 分布適應性 |
| Storage | Redis（丟了沒差） | MySQL/PostgreSQL（丟了是災難） |

**這個 read:write 比例改變了一切。** Uber 不能用 QuadTree 因為 lock contention；Proximity Service 幾乎不更新，什麼 index 都能用，選型重點變成**查詢效能、實作複雜度、和現有基礎設施整合度**。

---

## 2. 整體架構

```
┌───────────┐                          ┌──────────────────────┐
│  Client   │  GET /nearby?lat=..&     │  Load Balancer       │
│  (App/Web)│  lng=..&radius=..&       │                      │
│           │  category=restaurant     │                      │
└─────┬─────┘                          └──────────┬───────────┘
      │                                           │
      │          ┌────────────────────────────────┴──────────────┐
      │          │                                               │
      │   ┌──────▼──────────┐                      ┌────────────▼─────────┐
      │   │ Location Service │ (Read Path)          │ Business Service     │
      │   │                  │                      │ (Write Path)         │
      │   │ 1. lat/lng→geohash                     │                      │
      │   │ 2. 查 geohash cells                     │ CRUD 商家資訊          │
      │   │ 3. 距離過濾+排序                          │ → MySQL Primary       │
      │   └───────┬──────────┘                      └────────┬─────────────┘
      │           │                                          │
      │    ┌──────▼───────┐                           ┌──────▼───────┐
      │    │ Redis Cache   │                           │ MySQL Primary│
      │    │ (by geohash)  │◄─── cache miss ──────────│              │
      │    └──────┬────────┘                           └──────┬───────┘
      │           │                                          │ binlog
      │    ┌──────▼───────────────┐                   ┌──────▼───────┐
      │    │ MySQL Read Replicas  │                    │ MySQL Read   │
      │    │ (Geospatial queries) │                    │ Replicas     │
      │    └──────────────────────┘                    └──────────────┘
      │
      │   ┌───────────────────┐
      └──▶│ Ranking Service   │ (composite score)
          │ distance × rating │
          │ × relevance × ... │
          └───────────────────┘
```

核心思路：**讀寫分離**。Business Service 處理低頻寫入，Location Service 處理高頻讀取，透過 Read Replica 和 Cache 分散讀取壓力。

---

## 3. Geospatial Index 深度比較（核心設計決策）

這是面試中必須深入展開的段落。四種主要方案：

### 3.1 Geohash（地理雜湊）

```
原理：將 2D 座標 (lat, lng) 交替 bit-interleave，再 base-32 編碼成字串。

(40.7128, -74.0060) → "dr5ru7"

精度由字串長度決定：
  4 chars → ~39km × 20km     ← 城市級
  5 chars → ~4.9km × 4.9km   ← 區域級
  6 chars → ~1.2km × 610m    ← 街區級
  7 chars → ~153m × 153m     ← 街道級

核心特性：prefix 相同 = 在同一個 cell
  "dr5ru7" 和 "dr5ru6" 是鄰居
  "dr5ru" 的所有子 cell（dr5ru0 ~ dr5ruz）都在 ~5km 範圍內
```

**SQL-friendly（最大優勢）：**

```sql
-- 查詢 geohash prefix 為 "dr5ru" 的所有商家（~5km 精度）
SELECT * FROM businesses
WHERE geohash LIKE 'dr5ru%'
  AND category = 'restaurant';

-- 或用 >= / < 範圍查詢（更高效，能用 B-tree index）
SELECT * FROM businesses
WHERE geohash >= 'dr5ru' AND geohash < 'dr5rv'
  AND category = 'restaurant';
```

**邊界問題（Edge Problem）：**

```
兩個商家 A 和 B 相距 50m，但跨越 geohash cell 邊界：
  A: geohash = "dr5ruk"
  B: geohash = "dr5run"  ← 不同 cell！

解法：查詢目標 cell + 8 個鄰居 cell（九宮格）
  ┌─────┬─────┬─────┐
  │  NW │  N  │  NE │
  ├─────┼─────┼─────┤
  │  W  │ 目標 │  E  │
  ├─────┼─────┼─────┤
  │  SW │  S  │  SE │
  └─────┴─────┴─────┘

計算鄰居 geohash 的 library：
  Python: python-geohash
  Java: spatial4j

查詢變成 9 個 prefix query → 仍然很快（B-tree index）
```

### 3.2 QuadTree（四叉樹）

```
原理：遞迴分割空間。每個節點要嘛是 leaf（包含 ≤ threshold 個 POI），
     要嘛分裂成 4 個子節點（NW, NE, SW, SE）。

threshold 一般設為 100-500 個商家。

效果：
  曼哈頓（密集）→ 分裂到很深，cell 很小（~100m × 100m）
  內華達沙漠（稀疏）→ 頂層就是 leaf，cell 很大（~100km × 100km）

查詢：從 root 往下 traverse，找到包含 target 的 leaf
  → O(log N) where N = total POIs（樹高）
  → 通常 ~12 levels for 200M POIs

更新：找到舊 leaf → 移除 → 插入新 leaf → 可能觸發 split/merge
  → 需要 write lock → 但 Proximity Service 更新極少，不是問題
```

**記憶體估算：**

```
200M 商家，每個 POI 存 (id, lat, lng) ≈ 24B
QuadTree 內部節點 overhead ≈ 32B × ~70M 個內部節點

總計：200M × 24B + 70M × 32B ≈ 4.8GB + 2.2GB ≈ 7GB
→ 全球資料一台機器放得下（64GB RAM 的 server）
→ 但如果要多副本 + 冗餘，需要好幾台
```

### 3.3 S2 Geometry（Google）

```
原理：把地球表面投影到外接正方體的 6 個面，
     每個面用 Hilbert Curve（希爾伯特曲線）映射到 1D。

S2 Cell ID = 64-bit integer
  level 0 = 地球表面 1/6
  level 12 ≈ 3.3km²
  level 14 ≈ 0.2km²（街區級）
  level 30 = ~1cm²（最高精度）

優勢：
  1. 等面積 cell（不像 Geohash 在高緯度變形）
  2. Region covering：給定任意形狀，S2 能找到最少的 cell 來覆蓋
  3. 64-bit integer → 適合做 index key

Google Maps、Google Earth、Pokémon Go 都用 S2
```

### 3.4 R-Tree（用於 PostGIS）

```
原理：Balanced tree，每個節點存一個 MBR（Minimum Bounding Rectangle）。
     子節點的 MBR 被父節點的 MBR 包含。

查詢：從 root 開始，只搜尋與 query rectangle 相交的子節點
  → 剪枝效果好，典型查詢 O(log N)

PostGIS 的 GiST index 底層就是 R-Tree 變體。

優勢：支援複雜幾何查詢（polygon intersection, contains, etc.）
劣勢：update 需 rebalance → write 成本較高（但 Proximity Service 不在乎）
```

### 3.5 比較總結

| 維度 | Geohash | QuadTree | S2 Geometry | R-Tree (PostGIS) |
|------|---------|----------|-------------|-------------------|
| 查詢效能 | O(1) prefix lookup × 9 cells | O(log N) traverse | O(1) cell lookup × K cells | O(log N) tree search |
| 更新成本 | O(1) UPDATE row | O(log N) + 可能 split | O(1) UPDATE row | O(log N) + rebalance |
| 記憶體 | 不需額外記憶體（存 DB） | ~7GB for 200M POIs | 不需額外記憶體（存 DB） | DB 管理（GiST index） |
| 密度適應性 | 固定 cell 大小 ❌ | 自適應密度 ✅ | 可用多級 cell 覆蓋 ✅ | MBR 自適應 ✅ |
| 實作複雜度 | ⭐ 最簡單 | ⭐⭐⭐ 需自己管理 | ⭐⭐ 需 S2 library | ⭐⭐ 需 PostGIS |
| SQL 友好度 | ✅ B-tree + LIKE | ❌ In-memory only | ✅ Integer index | ✅ GiST index |
| Sharding | ✅ Prefix 天然 shard key | ❌ 需額外設計 | ✅ Cell ID 可 shard | ❌ 需額外設計 |

### 3.6 為什麼 Geohash 在此場景勝出？

```
Decision Tree:

1. 資料幾乎不更新？ → ✅ 所有方案的 update 成本都不重要
2. 需要和現有 MySQL/PostgreSQL 整合？ → ✅ Geohash 直接存 VARCHAR + B-tree index
3. 需要簡單 sharding？ → ✅ Geohash prefix 天然是 shard key
4. 資料分布極度不均勻？ → 是的，但 Geohash + 動態精度可以緩解
5. 需要複雜幾何查詢（polygon）？ → 不需要，radius search 夠了

結論：Geohash 以最低實作成本達到足夠好的效能。
     QuadTree 在密度適應性上更優，但需要自己維護 in-memory index。
     實際上 Yelp 用 Lucene spatial（Geohash-based），Google Maps 用 S2。
```

---

## 4. Database Schema 與 Index 設計

### 商家表

```sql
CREATE TABLE businesses (
    business_id   BIGINT PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    category      VARCHAR(64) NOT NULL,      -- 'restaurant', 'gas_station', etc.
    latitude      DECIMAL(10, 7) NOT NULL,
    longitude     DECIMAL(10, 7) NOT NULL,
    geohash       VARCHAR(12) NOT NULL,       -- 預計算好的 geohash
    rating        DECIMAL(2, 1) DEFAULT 0,    -- 1.0 ~ 5.0
    review_count  INT DEFAULT 0,
    price_range   TINYINT,                    -- 1, 2, 3, 4 ($, $$, $$$, $$$$)
    is_open       BOOLEAN DEFAULT TRUE,
    address       VARCHAR(512),
    phone         VARCHAR(20),
    photos_url    VARCHAR(512),               -- CDN URL
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);

-- 核心 index：geohash prefix + category 的 composite index
CREATE INDEX idx_geohash_category ON businesses (geohash, category);

-- 支援多種查詢模式
CREATE INDEX idx_geohash ON businesses (geohash);
CREATE INDEX idx_category ON businesses (category);
```

### 查詢範例

```sql
-- 查找附近 1km 的餐廳（geohash 精度 6 ≈ 1.2km）
-- Step 1: 計算目標 geohash 和 8 個鄰居
--   target = "dr5ruk", neighbors = ["dr5ruh", "dr5ruj", "dr5rum", ...]

-- Step 2: 查詢 9 個 cell
SELECT business_id, name, latitude, longitude, rating,
       ST_Distance_Sphere(
           POINT(longitude, latitude),
           POINT(-74.0060, 40.7128)
       ) AS distance_meters
FROM businesses
WHERE geohash IN ('dr5ruk', 'dr5ruh', 'dr5ruj', 'dr5rum',
                   'dr5run', 'dr5rus', 'dr5rut', 'dr5ruv', 'dr5ruw')
  AND category = 'restaurant'
HAVING distance_meters <= 1000
ORDER BY distance_meters
LIMIT 20;
```

**為什麼用 `IN` 而不是 `LIKE`？**

```
LIKE 'dr5ru%' → range scan，可能掃到不需要的 cell
IN (...) → 精確命中 9 個 cell，更高效

但如果 geohash 精度粗（4 chars），cell 太大，每個 cell 內商家太多：
  4 chars cell ~39km → 紐約一個 cell 可能有 50,000 家餐廳
  → IN 查詢返回太多結果，後續距離計算開銷大

解法：用更細的 geohash（6-7 chars），每個 cell 內商家數量可控
  6 chars cell ~1.2km → 紐約一個 cell 約 200-500 家
  7 chars cell ~150m → 約 10-50 家
```

---

## 5. 動態搜尋半徑（Adaptive Radius）

使用者搜尋 "附近的加油站"，但半徑內沒有結果怎麼辦？

```
策略：漸進擴大搜尋範圍

def search_nearby(lat, lng, category, initial_radius=1000):
    """
    initial_radius: 起始搜尋半徑（meters）
    """
    geohash_precision = radius_to_precision(initial_radius)
    # 1000m → precision 6 (~1.2km cell)

    for attempt in range(3):  # 最多擴大 3 次
        cells = get_cell_and_neighbors(lat, lng, geohash_precision)
        results = query_db(cells, category)
        results = filter_by_distance(results, lat, lng, initial_radius)

        if len(results) >= MIN_RESULTS:  # MIN_RESULTS = 10
            return rank(results)

        # 結果不足 → 降低精度（擴大 cell）
        geohash_precision -= 1
        initial_radius *= 4  # 精度降 1 level ≈ 面積擴大 ~16 倍

    return results  # 返回能找到的結果

精度 vs 半徑 mapping:
  precision 7 → ~150m   → 鬧區搜尋
  precision 6 → ~1.2km  → 一般搜尋
  precision 5 → ~5km    → 郊區搜尋
  precision 4 → ~40km   → 荒野找加油站
```

---

## 6. Ranking — 排序不只看距離

### Two-Phase Approach（兩階段）

```
Phase 1: Geo-filter（粗篩）
  → 用 geohash 取出附近所有候選商家（可能 200-500 家）
  → 只用 index，速度極快

Phase 2: Rank（精排）
  → 對候選商家計算 composite score
  → 排序後取 top-K 返回

為什麼不在 DB 層做精排？
  → Ranking 邏輯會頻繁調整（A/B test）
  → 可能需要外部資料（用戶偏好、即時營業狀態）
  → 在 application layer 做更靈活
```

### Composite Score 計算

```python
def compute_score(business, user_lat, user_lng):
    # 距離分數：距離越近分數越高，指數衰減
    distance = haversine(user_lat, user_lng, business.lat, business.lng)
    distance_score = 1.0 / (1.0 + distance / 1000)  # 1km 外衰減明顯

    # 評分分數：正規化到 0-1
    rating_score = business.rating / 5.0

    # 熱門度分數：log scale 避免被大量評論的老店壟斷
    popularity_score = math.log(1 + business.review_count) / math.log(1 + MAX_REVIEWS)

    # 商業推廣加權（付費商家）
    business_boost = 1.5 if business.is_promoted else 1.0

    # 加權組合
    score = (0.4 * distance_score +
             0.3 * rating_score +
             0.2 * popularity_score +
             0.1 * freshness_score(business.updated_at)) * business_boost

    return score
```

**面試時要主動提：** 權重可以用 ML model（Learning to Rank）替代手寫公式，但面試用手寫公式展示 intuition 即可。

---

## 7. Caching 策略

### 為什麼 Cache 對 Proximity Service 特別有效？

```
Uber 的 cache 效果差：
  資料每 3 秒更新 → cache 馬上過時 → TTL 極短 → hit rate 低

Proximity Service 的 cache 效果極好：
  商家資料幾乎不變 → TTL 可以設數小時 → hit rate 極高
  相同地點的查詢模式重複性高（遊客都搜 "Times Square 附近餐廳"）
```

### Cache by Geohash Cell

```
Cache key 設計：
  nearby:{geohash_prefix}:{category} → List<Business>

範例：
  nearby:dr5ru:restaurant → [{ id: 1, name: "Joe's Pizza", ... }, ...]
  nearby:dr5ru:gas_station → [{ id: 5, name: "Shell", ... }, ...]
  nearby:dr5ru:all → [所有類別的商家]

TTL = 1-4 hours（商家資料幾乎不變）

Cache miss flow:
  1. Client 查 nearby:dr5ru:restaurant → miss
  2. 查 MySQL Read Replica
  3. 結果寫入 Redis cache，TTL = 2h
  4. 返回結果
```

### Cache Invalidation

```
商家更新觸發 cache 清除：

Business Service 更新商家 →
  1. 寫入 MySQL Primary
  2. 計算該商家的 geohash prefix
  3. DEL nearby:{geohash}:*  ← 清除該 cell 的所有 cache

因為商家更新極少（~500/sec 全球），cache invalidation 的成本微乎其微。
```

### Pre-warm 熱門區域

```
全球前 1000 個熱門 geohash cell（曼哈頓、澀谷、信義區...）：
  → 啟動時 / TTL 過期前主動預載入 cache
  → 避免 cache stampede（大量 cache 同時過期，瞬間 DB 壓力暴增）

實作：
  Background job 每 1 小時重新載入 hot cells
  hot cells 列表來自 access log 統計
```

### 容量估算（Cache）

```
假設 cache 覆蓋最熱門的 20% geohash cells：

全球 geohash-6 cells ≈ 32^6 = ~1B 個，但有商家的約 10M 個
20% = 2M 個 cell × 3 個主要類別 = 6M 個 cache entry
每個 entry 平均存 100 個商家摘要 × 200B = 20KB
總計：6M × 20KB = 120GB

→ 需要 3-4 台 Redis 節點（每台 32-64GB）
→ Cache hit rate 預估 > 90%（Pareto 分布：20% cell 承載 80%+ 流量）
```

---

## 8. 系統分層與 Scaling

### Read Path 優化

```
100K read QPS（全球）如何分散？

Layer 1: CDN
  商家照片、靜態資訊 → CDN（CloudFront / Akamai）
  減少 ~40% 的請求

Layer 2: Redis Cache
  Geohash cell 快取 → 命中率 >90%
  殘餘 QPS: 100K × 10% = 10K cache miss QPS

Layer 3: MySQL Read Replicas
  10K QPS 分散到 read replicas
  每個 replica 處理 ~2K-3K QPS（帶 geohash B-tree index）
  → 需要 3-5 個 read replicas

Layer 4: MySQL Primary
  只處理寫入（~500/sec）→ 單節點綽綽有餘
```

### Write Path

```
商家更新 flow:
  Business Owner → Business Service → MySQL Primary → binlog → Read Replicas
                                                            → Cache Invalidation

Replication lag: ~100-500ms
  → 使用者更新商家資訊後，可能需要 0.5 秒才能在搜尋結果中反映
  → 對此場景完全可接受（不像 Uber 那樣需要即時一致性）
```

### Regional Deployment

```
跨地域部署（降低延遲）：

Region: US-East
  MySQL Primary（寫入主節點）
  MySQL Read Replicas × 3
  Redis Cache × 2
  Location Service pods × 10

Region: US-West
  MySQL Read Replica × 2（跨區複製）
  Redis Cache × 1
  Location Service pods × 5

Region: Asia (Singapore)
  MySQL Read Replica × 2
  Redis Cache × 1
  Location Service pods × 5

跨區寫入：
  Asia 的商家更新 → 路由到 US-East Primary → binlog 複製回 Asia
  延遲 ~150-200ms → 商家更新不頻繁，可以接受

替代方案：每個 region 一個 Primary（multi-primary），但需要處理衝突
  → 對 500 writes/sec 來說 overkill
```

---

## 9. 帶篩選條件的搜尋

### 常見 Filters

```
/nearby?lat=40.71&lng=-74.00&radius=1000
        &category=restaurant
        &price_range=2
        &min_rating=4.0
        &open_now=true
```

### Index 設計策略

```
方案 A：單一 Composite Index（推薦）
  CREATE INDEX idx_geo_cat ON businesses (geohash, category);
  → WHERE geohash IN (...) AND category = 'restaurant'
  → 其他 filter 在 application layer 做 post-filtering

為什麼不把所有 filter 都放進 index？
  → Index (geohash, category, price_range, rating) 的 cardinality 太高
  → 每加一個維度，index 大小翻倍，update 成本增加
  → geohash + category 已經把結果集縮到 <500 筆，post-filter 很快

方案 B：Pre-computed Index Table（高流量 filter）
  geohash_businesses_by_category:
    (geohash, category) → PK
    business_ids → JSON array

  → 直接查 key 取得 business_id list → 再 batch GET 商家資訊
  → 適合查詢模式非常固定的場景

方案 C：Elasticsearch（需要複雜搜尋時）
  → 全文搜尋 + geo_distance query + 多維 filter
  → Yelp 實際用 Elasticsearch / Lucene
  → 但面試中除非面試官提起，先用 MySQL + Geohash 展示核心思路
```

### "open_now" 的特殊處理

```
open_now 不能放進 geohash index（因為它是時間相關的動態值）。

方案：
  DB 存 opening_hours JSON: {"mon": "09:00-22:00", "tue": "09:00-22:00", ...}
  Application layer: 取出候選商家 → 用 client 的 local time 過濾

這會稍微增加 application layer 的計算量，但：
  → geohash filter 已把候選集縮小到 <500 筆
  → 對 500 筆做 open_now 過濾 < 1ms
```

---

## 10. 容量估算

| 指標 | 估算 |
|------|------|
| 全球商家數 | ~200M |
| 每筆商家資料量 | ~1KB（含 metadata） |
| MySQL 儲存 | 200M × 1KB = **200GB**（單台可容納） |
| Geohash index 大小 | ~5GB（B-tree on VARCHAR(12)） |
| Read QPS（全球） | ~100K/sec |
| Cache hit rate | >90% |
| Cache miss → DB QPS | ~10K/sec |
| MySQL Read Replicas 需求 | 10K ÷ 3K per replica = **3-5 台** |
| Redis cache 記憶體 | ~120GB（3-4 台 Redis 節點） |
| Write QPS | ~500/sec（1 台 MySQL Primary 足夠） |
| 查詢延遲（cache hit） | **< 10ms** |
| 查詢延遲（cache miss） | **< 50ms**（含 DB query + ranking） |
| 商家照片 CDN | 200M × 5 photos × 500KB = **500TB**（CDN 處理） |

---

## 11. 關鍵 Trade-off 總結

| 決策點 | 選擇 | 為什麼 | 放棄了什麼 |
|--------|------|--------|-----------|
| Geo Index | Geohash | SQL 友好、易 shard、實作簡單 | 密度自適應性（QuadTree 更好） |
| Storage | MySQL + Read Replicas | 資料是 persistent、需要 ACID | Redis 的極致讀取速度 |
| Cache granularity | Per geohash cell | 命中率高、invalidation 簡單 | 精確到 query 的 cache（更高命中率但更複雜） |
| Ranking 位置 | Application layer | 靈活調整、支援 A/B test | DB 層排序（省一次 round trip） |
| Filter 策略 | Geo-first + post-filter | Index 簡單、維護成本低 | 多維 index（每個 filter 組合都建 index 不現實） |
| 動態精度 | 搜尋半徑映射 geohash precision | 自適應結果數量 | 固定精度（實作更簡單但用戶體驗差） |
| 一致性 | Eventual consistency | Read replica lag ~500ms 對商家搜尋可接受 | Strong consistency（需要用 Primary 讀，無法 scale） |

---

## 12. 面試常見 Follow-up

### Q1: 如果要支援 "沿途搜尋"（Search Along Route）？

```
場景：開車從 A 到 B，想找沿途的加油站。

方案：
  1. 取得路線的 polyline（一系列座標點）
  2. 對路線上每隔 N km 取一個 sampling point
  3. 對每個 sampling point 做 radius search
  4. 合併結果，去重，按偏離路線的距離排序

優化：
  → 不需要每個 sampling point 都查 DB
  → 路線經過的 geohash cells 可以一次批量查詢
  → SELECT * FROM businesses WHERE geohash IN (路線經過的所有 cells)
```

### Q2: 如何處理超熱門區域（Hotspot）？

```
Times Square 的 geohash cell 可能承受 10x 平均流量。

方案：
  1. Cache pre-warm：熱門 cell 永遠在 cache 中
  2. Cache replication：熱門 cell 的 cache 存多份，client 隨機讀
  3. 如果 DB 層也是瓶頸 → 對熱門區域的資料做 dedicated read replica
```

### Q3: 如何支援即時搜尋（Type-ahead）？

```
使用者打 "Ital" → 即時顯示 "Italian Restaurant near you"

方案：
  Elasticsearch prefix query + geo_distance filter
  或 Redis sorted set（按搜尋頻率排序） + geohash prefix

延遲要求更高（< 50ms），需要更積極的 cache。
```

### Q4: Geohash 精度不夠怎麼辦？

```
城市 A（密集）用 precision 6 → 一個 cell 500 家商家（太多）
城市 B（稀疏）用 precision 6 → 一個 cell 0 家（太少）

方案：Adaptive Precision
  → 維護一張 geohash_config table
  → 根據該區域的商家密度，決定使用 precision 5 / 6 / 7
  → 或用 QuadTree 的思路：如果一個 cell 內商家 > 500，用更精細的 geohash
```

### Q5: 和 Uber 有什麼本質區別？

```
一句話總結：
  Uber = 動態 index on ephemeral data → Redis in-memory, write-optimized
  Proximity = 靜態 index on persistent data → MySQL + cache, read-optimized

這改變了：
  1. Index 選型（Redis Geo vs Geohash + B-tree）
  2. Storage（Redis vs MySQL）
  3. Cache 策略（Uber cache 無意義 vs Proximity cache 極有效）
  4. Consistency（Uber 需即時 vs Proximity 容忍秒級延遲）
```

---

## 13. 面試策略：講述順序建議

1. **需求釐清 + 規模估算**（2 分鐘）
   - 200M 商家、100K read QPS、500 write QPS
   - 強調 read:write = 200,000:1 → 這決定了所有後續選型

2. **Geospatial Index 選型**（3 分鐘）
   - 快速列出 4 種方案（Geohash / QuadTree / S2 / R-Tree）
   - 展示比較思路 → 選 Geohash，說明原因
   - **主動提 edge problem + 九宮格解法**（展示深度）

3. **Schema + Query 設計**（2 分鐘）
   - 商家表 + geohash composite index
   - 展示一個完整的 SQL query

4. **Two-Phase Ranking**（2 分鐘）
   - Geo-filter → Rank
   - Composite score 公式

5. **Caching + Scaling**（2 分鐘）
   - Cache by geohash cell、TTL 策略、pre-warm
   - Read replica 拓撲

6. **Deep Dive（面試官選）**（2 分鐘）
   - Adaptive radius / Hotspot / Filter 策略 / Search along route
