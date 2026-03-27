# Uber — 即時叫車系統架構

## 1. 核心挑戰

Uber 的難度集中在 **高頻位置更新 + 即時配對**：

```
全球活躍司機：  ~5M
位置更新頻率：  每 3-5 秒一次
Write QPS：    ~1-1.5M location updates/sec（全球）
Read QPS：     乘客叫車時查附近司機 ~100K queries/sec
延遲要求：     配對完成 < 數秒
```

兩個本質上衝突的需求：
- **寫入量極大**（百萬級/秒的位置更新）
- **讀取要即時**（叫車時要能查到「現在」附近有誰）

---

## 2. 整體架構

```
┌──────────┐    location update    ┌────────────────────┐
│ Driver   │ ──────────────────▶   │ Location Service    │
│ App      │    (every 3-5s)       │                    │
└──────────┘                       │  寫入 Redis Geo     │
                                   │  (per-city shard)  │
┌──────────┐    ride request       └────────┬───────────┘
│ Rider    │ ──────────────────▶            │
│ App      │                      ┌────────┴───────────┐
└──────────┘                      │ Matching Service    │
      ▲                           │                    │
      │                           │ 1. 查 Redis 附近司機 │
      │     push notification     │ 2. 排序 + 選最佳    │
      │     (match result)        │ 3. 通知司機         │
      └───────────────────────────┴────────────────────┘
                                           │
                                  ┌────────┴───────────┐
                                  │ Trip Service        │
                                  │ (行程管理、計費)      │
                                  │ → PostgreSQL        │
                                  └────────────────────┘
```

---

## 3. Geospatial Index 選型（核心設計決策）

### 為什麼不能用 PostgreSQL GiST？

```
Write QPS = ~1.5M/sec（全球）

PostgreSQL 單節點：
  GiST index update = disk I/O + WAL write + index rebalance
  最多 ~5K-10K writes/sec（with index）
  → 需要 150-300 個 PostgreSQL 節點？不合理

而且每筆 location update 3 秒後就過時了，
用持久化的 RDBMS 存 ephemeral data 是浪費。
```

### QuadTree 的問題

```
QuadTree 是 in-memory spatial index，查詢很快。
但 update = delete old position + insert new position：

  1. 找到舊位置所在的 leaf node → O(log N)
  2. 從 leaf 移除 → 可能觸發 node merge
  3. 在新位置插入 → 可能觸發 node split
  4. Split/merge 需要 lock → 高併發下 lock contention 嚴重

適合：read-heavy + 低頻更新（餐廳、商店、POI）
不適合：百萬級/秒的位置更新
```

### Redis GEOADD — 最佳選擇

```
Redis Geo 底層 = Sorted Set + GeoHash

GEOADD drivers:singapore 103.851 1.290 "driver_456"
  → 把 (lng, lat) 編碼成 GeoHash → 存入 Sorted Set
  → O(log N) 寫入，in-memory，無 lock

GEORADIUS drivers:singapore 103.851 1.290 3 km COUNT 20
  → 查詢半徑 3km 內最近的 20 個司機
  → O(N) where N = range 內的 member 數

GEOADD 覆蓋舊值：
  同一個 driver_id 再次 GEOADD → 自動更新位置（覆蓋 Sorted Set 的 score）
  不需要 delete + insert → 沒有 QuadTree 的 lock 問題
```

### 效能數字（重要：per-node vs aggregate）

| 指標 | 數字 | 說明 |
|------|------|------|
| Redis GEOADD per node | 50K-100K ops/sec | 單節點極限 |
| 全球 write QPS | ~1.5M/sec | 所有城市加總 |
| 需要的 Redis 節點 | **15-30 個** | 按城市 shard，每個城市 1-3 個節點 |
| GEORADIUS per query | < 1ms | in-memory，非常快 |

**面試時提到 QPS 數字，永遠標明是 per-node 還是 aggregate。**

---

## 4. Location Service — 位置更新管線

### Sharding 策略：按城市

```
為什麼按城市而非 hash(driver_id)？
  → 叫車查詢是地理性的：「找新加坡附近的司機」
  → 如果按 driver_id hash，查詢要 scatter-gather 所有 shard → 慢
  → 按城市 shard，查詢只需打一個 shard → 快

Redis instances:
  drivers:singapore     → Redis node 1
  drivers:taipei        → Redis node 2
  drivers:tokyo         → Redis node 3, 4（大城市多個節點）
  drivers:new-york      → Redis node 5, 6
```

### 位置更新 Flow

```
Driver App
  │
  │  POST /location { driver_id, lat, lng, city, timestamp }
  │  （每 3-5 秒）
  ▼
Location Service (stateless, 多 pods)
  │
  │  1. 根據 city 路由到對應 Redis shard
  │  2. GEOADD drivers:{city} {lng} {lat} {driver_id}
  │  3. SET driver:{driver_id}:meta { status, vehicle_type, rating, heading }
  │     TTL = 30s（30 秒沒更新 = 離線）
  ▼
Redis (per-city)
```

**driver meta 也用 Redis TTL**：如果 30 秒沒收到 heartbeat（location update），meta key 過期 → 自動視為離線。不需要 cleanup job。

---

## 5. Redis 為什麼不能當 Primary DB？

位置資料用 Redis 完美合理，但 **行程紀錄、用戶資料、付款紀錄** 絕對不行：

| 原因 | 說明 |
|------|------|
| **Durability** | AOF everysec 仍可能丟 1 秒資料；RDB 丟更多。行程紀錄丟了 = 帳單出錯 |
| **成本** | RAM 比 SSD 貴 10-30 倍。行程歷史是 TB 級，全放 RAM 不可行 |
| **查詢能力** | 無法 JOIN、aggregation、複雜查詢。「上個月新加坡的平均車費」→ Redis 做不到 |

### 但位置資料反而完美適合 Redis

```
「這筆資料丟了會怎樣？」
  → 「沒差，3 秒後就會有新的 location update 覆蓋」
  → Ephemeral disposable state → Redis 是最佳選擇

Storage 選型決策樹：
  資料丟了不可接受？ → Disk-based DB（PostgreSQL, MySQL）
  資料丟了沒差，很快有新的？ → Redis / in-memory store
```

---

## 6. Matching Service — 配對演算法

### 基本 Flow

```
Rider 發起叫車 → Matching Service:

1. GEORADIUS drivers:{city} {rider_lng} {rider_lat} 3 km COUNT 50
   → 取得附近 50 個司機的 driver_id + 距離

2. 過濾：
   - GET driver:{id}:meta → 只要 status=available
   - 車型匹配（rider 選的 UberX / UberXL）
   - rating 門檻

3. 排序（scoring function）：
   score = w1 × (1/distance) + w2 × rating + w3 × (1/ETA)
   → 不只看距離，還看預估到達時間（ETA 考慮路況）

4. 選最佳 → 發 push notification 給該司機
   → 司機 15 秒內接受 / 拒絕
   → 拒絕 → 選下一個
```

### 為什麼不單純選最近的？

```
司機 A：直線距離 500m，但隔著一條河，實際車程 15 分鐘
司機 B：直線距離 1.2km，但在同一條路上，車程 3 分鐘

→ ETA（estimated time of arrival）比直線距離更有意義
→ 需要 routing engine（e.g. OSRM）算實際行車時間
```

---

## 7. GeoHash 的特性與限制

### GeoHash 如何運作

```
把 2D 座標（lat, lng）編碼成 1D 字串：

(1.290, 103.851) → "w21z3q"

精度由字串長度決定：
  4 chars → ~39km × 20km cell
  6 chars → ~610m × 610m cell
  8 chars → ~38m × 19m cell

相近的座標會有相同的 prefix → 可以用 prefix 做範圍查詢
```

### GeoHash 的問題

**1. 邊界問題（Edge Case）**

```
兩個點非常近，但跨了 GeoHash cell 的邊界：
  Point A: geohash = "w21z3q"
  Point B: geohash = "w21z3r"  ← 不同 cell，但其實只差 10 公尺

解法：查詢時不只查目標 cell，還要查周圍 8 個鄰居 cell
Redis GEORADIUS 內部已經處理了這個問題
```

**2. 不均勻 Cell 大小（Uneven Cell）**

```
GeoHash 用 Mercator 投影 → 赤道附近的 cell 比高緯度的大
  赤道：6-char cell ≈ 610m × 610m
  北緯 60°：6-char cell ≈ 610m × 305m

對 Uber 的影響：
  同樣 precision 的 GeoHash，在不同緯度搜尋範圍不同
  → 高緯度城市可能需要 adaptive precision

更好的替代：Google S2 (Hilbert curve)
  → 等面積 cell，不受緯度影響
  → Uber 實際在用 S2（H3 是 Uber 自研的 hexagonal grid，基於類似原理）
```

---

## 8. Trip Lifecycle（行程生命週期）

```
States:
  REQUESTED → MATCHED → DRIVER_EN_ROUTE → ARRIVED → IN_TRIP → COMPLETED
                                                              → CANCELLED

每個 state transition 寫入 Trip DB（PostgreSQL）：

trips:
  trip_id, rider_id, driver_id,
  status, pickup_location, dropoff_location,
  requested_at, matched_at, pickup_at, dropoff_at,
  estimated_fare, actual_fare,
  route_polyline, distance_meters, duration_seconds

永久儲存：用於帳單、爭議處理、數據分析
→ PostgreSQL（需要 JOIN、aggregation、transaction）
```

---

## 9. Surge Pricing（動態定價）

```
目的：supply-demand balancing
  某區域叫車需求高但司機少 → 漲價 → 吸引更多司機過來

實作：
  1. 把城市切成 hexagonal grid（H3）
  2. 每個 hex cell 計算：
     demand = 最近 5 分鐘的叫車數
     supply = 最近 5 分鐘在此 cell 的可用司機數
     surge_multiplier = f(demand / supply)
  3. 每 1-2 分鐘重新計算
  4. Rider 叫車時，根據 pickup location 所在的 cell 查 surge multiplier

Storage：
  短期狀態（當前 surge）→ Redis / in-memory cache
  歷史數據（分析用）→ 寫入 data warehouse（BigQuery / Hive）
```

---

## 10. 容量估算

| 指標 | 估算 |
|------|------|
| 全球活躍司機 | ~5M |
| Location update QPS | 5M ÷ 4s = **~1.25M writes/sec** |
| Redis 節點數（location） | 1.25M ÷ 80K per node = **~16 nodes**（按城市 shard） |
| 每筆 location 資料量 | driver_id(8B) + lat/lng(16B) + meta(100B) ≈ 128B |
| Redis 記憶體（location only） | 5M × 128B = **640MB**（非常小） |
| 叫車配對 QPS | ~100K/sec（全球） |
| GEORADIUS per query | < 1ms |
| Trip DB 寫入 | ~50K trips/sec |
| Trip DB 儲存（每日） | 50K × 86400s × 500B ≈ **2TB/day** |

---

## 11. 你的盲區紀錄（from confusion ledger）

| 盲區 | 核心修正 |
|------|---------|
| 直覺用 PostgreSQL GiST 做位置查詢 | 先估算 write QPS：>10K/sec → 排除傳統 DB geo index |
| Redis QPS 沒區分 per-node vs aggregate | 永遠標註 per-node 或 aggregate，反推需要多少節點 |
| 沒拆解 Redis 不適合當 Primary DB 的具體原因 | 三個原因：Durability、成本（RAM 貴 30 倍）、查詢能力。但 ephemeral data 反而最適合 Redis |

---

## 12. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— 5M 司機、1.25M writes/sec、叫車 QPS
2. **Location Service + Geo Index 選型**（3 分鐘）— 為什麼不用 PostGIS / QuadTree → Redis GEOADD + 按城市 shard
3. **Matching Service**（2 分鐘）— GEORADIUS → filter → scoring → push notification
4. **Trip Lifecycle + Storage 分層**（2 分鐘）— Redis（ephemeral location）vs PostgreSQL（permanent trip records）
5. **Deep Dive（面試官選）**（2 分鐘）— Surge pricing / ETA / GeoHash vs S2 / 大城市 hotspot
