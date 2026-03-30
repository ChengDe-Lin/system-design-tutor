# Google Maps — 地圖導航與路徑規劃系統架構

## 1. 核心挑戰

Google Maps 的設計核心是 **地圖呈現 + 即時路徑規劃**：

```
規模：
  MAU: ~1B（全球最大地圖服務）
  DAU: ~150M
  Navigation queries/day: ~1B → ~12K route queries/sec
  Tile requests/day: ~200B → ~2.3M tile reads/sec
  GPS traces ingested/sec: ~50K（來自 Android 裝置）

核心矛盾：
  - 地圖涵蓋全球：~510M km² 地表面積，道路總長 ~64M km
  - 路徑規劃要在 < 200ms 內完成，但全球路網有 ~10 億個節點
  - Dijkstra 在這種規模上需要數秒 → 不可接受
  - 即時交通讓 edge weight 持續變化 → 預處理結果需動態更新
  - 地圖圖磚 (Map Tile) 數量可達數百億，但大部分是海洋/荒地
```

---

## 2. 整體架構

```
┌──────────┐                                    ┌──────────────────────┐
│ Client   │──tile request──▶ CDN ──miss──▶     │ Tile Service         │
│ (App/Web)│              (edge cache)          │ (pre-rendered tiles) │
│          │                                    └──────────────────────┘
│          │
│          │──route query──▶ API Gateway ──▶ Routing Service
│          │                                    │
│          │                    ┌────────────────┼────────────────┐
│          │                    ▼                ▼                ▼
│          │              Graph Store    Traffic Service    ETA Predictor
│          │           (Contraction     (live speed per    (ML model)
│          │            Hierarchies)     road segment)
│          │
│          │──search "餐廳"──▶ Geocoding / POI Service
│          │                    │
│          │                    ├──▶ Address Trie (autocomplete)
│          │                    └──▶ Geospatial Index (POI lookup)
│          │
│          │──navigation──▶ Navigation Service
│          │                    │
│          │                    ├──▶ Routing Service (re-route)
│          │                    ├──▶ Map Matching (GPS → road snap)
│          │                    └──▶ Traffic Service (live updates)
│          │
│  GPS ──────────────────▶ Telemetry Ingestion (Kafka)
│ traces   │                    │
└──────────┘                    ▼
                         Traffic Aggregation Pipeline
                         (Flink / streaming)
                                │
                                ▼
                         Traffic Store (segment → speed)
```

---

## 3. 核心設計決策：地圖圖磚 (Map Tile) 服務

### 圖磚座標系統

```
Zoom Level 0: 全世界 = 1 張 256×256px 的圖
Zoom Level 1: 2×2 = 4 張圖磚
Zoom Level 2: 4×4 = 16 張圖磚
...
Zoom Level z: 2^z × 2^z 張圖磚

每張圖磚由 (zoom, x, y) 唯一標識：
  zoom: 0-21
  x: 0 ~ 2^zoom - 1
  y: 0 ~ 2^zoom - 1

Zoom 18（街道級）: 2^18 × 2^18 = 68,719,476,736 ≈ 690 億張圖磚
  → 但只有 ~30% 有陸地 → ~200 億張有效圖磚
  → 其中只有 ~5% 是密集市區需要 zoom 18+ → 實際儲存量大幅降低
```

### 向量圖磚 (Vector Tile) vs 光柵圖磚 (Raster Tile)

| 維度 | Raster Tile（PNG/WebP） | Vector Tile（PBF/MVT） |
|------|-------------------------|------------------------|
| 大小 | ~20-30 KB/tile | ~5-15 KB/tile（**小 2-4 倍**） |
| 渲染 | 伺服器預渲染，Client 直接顯示 | Client 端 GPU 渲染 |
| 樣式變更 | 需要重新渲染所有圖磚 | Client 換 style sheet 即可 |
| 旋轉/傾斜 | 像素化 | 平滑（向量本質） |
| Client CPU/GPU | 低 | 高（需要 GPU 加速） |
| 離線支援 | 佔空間大 | 佔空間小（適合離線地圖） |
| CDN 效率 | 每種 style 各存一份 | 一份 data + 多種 style |

**Google Maps 的做法：Vector Tile 為主**
- 行動端：Vector Tile → 省頻寬（行動網路昂貴）、支援平滑旋轉
- 網頁端：WebGL 渲染 Vector Tile
- 衛星圖：仍然是 Raster Tile（照片無法向量化）

### CDN 快取策略

```
圖磚是靜態資源 → CDN 快取的理想場景：

Cache 分層：
  L1: Client 本地快取（LRU，手機 ~500MB / 瀏覽器 Cache API）
  L2: CDN Edge（200+ PoP 節點，命中率 ~95%）
  L3: Origin Shield（區域聚合層，減少 Origin 壓力）
  L4: Tile Server（Object Storage 讀取 or 即時渲染）

Cache Key: tile/{zoom}/{x}/{y}.pbf?v={version}
  → version 隨地圖更新遞增（每月數次）
  → 舊版本圖磚 TTL 過期後自然失效

每日 200B tile requests：
  CDN hit rate 95% → Origin 只需處理 10B / day = ~115K req/sec
  → 合理的 Origin 規模
```

### 儲存估算

```
有效圖磚數量（all zoom levels）：
  Zoom 0-10: 較少（~4M 張）
  Zoom 11-15: 城市級（~10B 張有效）
  Zoom 16-18: 街道級（~200B 張，但大部分為空地/海洋，實際 ~15B）
  Zoom 19-21: 僅密集市區（~2B 張）

Vector Tile 平均 ~10 KB：
  ~30B 有效圖磚 × 10 KB = ~300 TB（未壓縮）
  壓縮後 ~50-100 TB → 可用 Object Storage（S3/GCS）儲存

衛星 Raster Tile（zoom 0-20）：
  ~10B 有效圖磚 × 25 KB = ~250 TB
  加上多年歷史影像 → 總計 ~PB 級
```

---

## 4. 地理編碼 (Geocoding) 與地點搜尋

### 正向地理編碼（地址 → 座標）

```
Input:  "台北市信義區松仁路 100 號"
Output: (25.0330, 121.5654)

Pipeline:
  1. 地址解析 (Address Parsing)：拆分成結構化欄位
     → 城市=台北市, 區=信義區, 路=松仁路, 號=100
  2. 階層查詢：城市 → 區 → 路 → 門牌範圍插值 (interpolation)
  3. 回傳座標 + confidence score
```

### 地址自動完成 (Autocomplete)

```
資料結構：Trie (前綴樹) + 倒排索引 (Inverted Index)

使用者輸入 "Sta" →
  Trie 走到 S → T → A → 取出所有 prefix match：
    "Starbucks" (POI, weight=9.8)
    "Stanford University" (POI, weight=8.5)
    "State Street" (road, weight=7.2)

排序因素：
  - 全域熱度 (global popularity)
  - 使用者位置距離 (proximity)
  - 個人搜尋歷史 (personalization)
  - 語言/地區偏好

效能要求：
  p99 < 50ms（使用者每打一個字就要回應）
  → Trie in memory + 結果 cache（LRU by prefix）
  → 分區域部署：台灣的 autocomplete server 存台灣地址
```

### 反向地理編碼（座標 → 地址）

```
Input:  (25.0330, 121.5654)
Output: "台北市信義區松仁路 100 號"

方法：
  1. 用 Geospatial Index 找到最近的道路線段
  2. 將座標投影到路段上 → 算出門牌號插值
  3. 查對應的行政區層級

Geospatial Index 選型：
  - R-tree：每個矩形區域包含其中的道路/地點
  - Geohash：將 2D 座標映射到 1D 字串，prefix = 區域
  - S2 Geometry（Google 實際使用）：球面幾何切割成階層 cell
    → 每個 cell 有唯一 ID → 可做 range query
```

---

## 5. 路徑規劃 (Routing) — 最短路徑

### 路網圖模型

```
Node（節點）= 道路交叉口或道路屬性變化點
  全球 ~10 億節點

Edge（邊）= 兩節點間的道路段
  全球 ~20 億條邊
  每條邊的屬性：
    - 距離（meters）
    - 速度限制（km/h）
    - 道路等級（高速公路 / 省道 / 巷弄）
    - 是否單行道（directed edge）
    - 轉彎限制（left turn prohibited 等）
    - 通行費（toll）
    - 即時交通速度（dynamic weight）

Storage per edge: ~50 bytes（IDs + weights + flags）
全圖大小: 20 億 × 50 bytes = ~100 GB → 可放入單台機器記憶體
```

### 為什麼 Dijkstra 不夠用？

```
Dijkstra: O((V + E) log V)
  V = 10 億, E = 20 億
  → 即使用 priority queue，最壞情況需要探索上億個節點
  → 單次查詢 ~數秒 → 不可接受（目標 < 200ms）

A* with Euclidean heuristic：
  → 比 Dijkstra 好，但在高速公路繞路場景（先走遠再繞回來）
     heuristic 不準確 → 退化成接近 Dijkstra
  → 單次查詢 ~數百毫秒到秒級 → 仍然不夠快

問題本質：
  台北到高雄 ~350 km，中間路網有上百萬節點
  但最短路徑只經過 ~50 個交流道
  → 大量中間節點是多餘的 → 需要預處理壓縮
```

### 收縮層級 (Contraction Hierarchies, CH)

這是 Google Maps 路徑規劃的核心演算法。

```
核心觀察：
  道路有自然的重要性層級：
    高速公路 > 省道 > 市區道路 > 巷弄
  長途路徑幾乎一定會經過高速公路
  → 如果能預先計算「跳過不重要節點的捷徑邊」，查詢時就不需要探索它們

預處理 (Offline, 數小時)：
  1. 為每個節點分配「重要性排名」(node ordering)
     → 高速公路交叉口 rank 高，巷弄 rank 低
  2. 從最不重要的節點開始「收縮」(contract)：
     → 移除節點 v
     → 如果 u → v → w 的最短路徑需要經過 v，
        添加 shortcut edge: u → w (weight = w(u,v) + w(v,w))
     → 重複直到所有節點都被收縮
  3. 結果：原圖 + 大量 shortcut edges，形成層級結構

查詢 (Online, 毫秒級)：
  Bidirectional search：
    - 從起點向上（只走 rank 遞增的邊）
    - 從終點向上（只走 rank 遞增的邊）
    - 兩個搜尋在高層（高速公路層級）相遇
    - 探索節點數：~500-2000（vs Dijkstra 的數百萬）

效能：
  預處理時間: 數小時（全球路網）
  預處理空間: 原圖 2-3 倍（shortcut edges）
  查詢時間: ~1-5 ms（大陸級路網）
  查詢探索節點數: ~500-2000 個
```

```
範例：台北 → 高雄

Dijkstra：探索所有可能路徑，包含每條小巷弄
  → 探索 ~2M 節點 → ~3 秒

CH：
  從台北向上搜尋 → 很快到達「國道一號入口」（高 rank 節點）
  從高雄向上搜尋 → 很快到達「國道一號出口」（高 rank 節點）
  高速公路層級只有 ~100 個節點 → 瞬間相遇
  → 探索 ~800 節點 → ~2 ms
```

### CH 的 Trade-off

| 維度 | 值 |
|------|-----|
| 預處理時間 | 2-6 小時（全球路網） |
| 額外儲存 | 原圖 2-3 倍（~200-300 GB shortcut edges） |
| 查詢 latency | **1-5 ms** |
| 即時交通整合 | **困難**（edge weight 變了 → shortcut 要重算） |
| 更新頻率 | 每 5-15 分鐘局部更新 or 每日全量重建 |

### 圖分割 (Graph Partitioning)

```
互補策略：將全球路網分割成數千個區域 (partition)

預處理：
  1. 把路網切成 ~5000 個 partition（每個 ~20 萬節點）
  2. 預計算所有「邊界節點」(boundary node) 之間的最短路徑
     → 邊界節點：連接兩個 partition 的交叉口
     → 每個 partition 邊界 ~100 個節點 → 100×100 = 10K 條預計算路徑

查詢：
  1. 起點所在 partition 內：用局部 Dijkstra 算到邊界
  2. 跨 partition：查預計算的邊界-邊界最短路徑表
  3. 終點所在 partition 內：用局部 Dijkstra 算從邊界到終點

好處：
  - partition 內節點少 → Dijkstra 夠快
  - 跨 partition 直接查表 → O(1)
  - 交通更新只需重算受影響的 partition → 比 CH 更容易局部更新
```

---

## 6. 即時交通 (Real-time Traffic)

### 資料來源

```
1. GPS 軌跡（主要來源）：
   Android 手機 + Google Maps 使用者 → 每秒回傳位置
   全球 ~50K GPS updates/sec → Kafka → 串流處理
   匿名化：只保留速度 + 路段 ID，不保留個人資訊

2. 道路感測器：
   交通攝影機、地磁感測器（密集城市區域）
   透過政府開放資料 API 取得

3. 歷史模式：
   「週一早上 8 點，國道一號五股到林口平均速度 = 40 km/h」
   當即時資料不足時 fallback 到歷史模式
```

### 交通聚合管線

```
GPS trace: (device_id, lat, lng, speed, timestamp)
  │
  ▼
Map Matching：GPS 座標 → 對應到哪條路段 (edge_id)
  (Hidden Markov Model：考慮 GPS 誤差 + 道路拓撲)
  │
  ▼
Speed Aggregation（per edge, per time window）：
  edge_12345 在 08:00-08:05 的速度樣本：[35, 38, 42, 40, 37] km/h
  → 中位數 = 38 km/h（用中位數而非平均，抵抗異常值）
  │
  ▼
Traffic Store：
  Key: (edge_id, time_bucket)
  Value: { speed: 38, confidence: 0.92, sample_count: 47 }
  → Redis / Bigtable，按時間視窗聚合
  → 保留 5 分鐘粒度的即時資料 + 歷史資料

Traffic Tile：
  → 將交通速度渲染成顏色疊加到地圖圖磚上
  → 綠色（暢通）/ 黃色（緩慢）/ 紅色（壅塞）
  → 每 1-2 分鐘更新一次 → CDN TTL = 60 秒
```

### 交通感知路徑規劃

```
Route Query with live traffic：

1. 用 CH 算出「靜態最短路徑」（基於速限的理想時間）
2. 對路徑上的每條 edge，查 Traffic Store 取得即時速度
3. 計算即時 ETA = Σ (edge_length / live_speed)
4. 如果即時 ETA 比靜態 ETA 差 > 20%，嘗試備選路徑

備選路徑 (Alternative Routes)：
  - 用 CH + penalty 方法：把主路徑的邊加高權重 → 重算 → 得到繞路方案
  - 通常提供 2-3 條備選路徑
  - 各路徑附上即時 ETA 讓使用者選擇

挑戰：CH 的 shortcut edges 假設 weight 固定
  → 即時交通讓 weight 變動 → shortcut 可能不正確
  → 解法：
    a) Customizable CH：預處理時記錄 shortcut 的原始邊列表
       → 查詢時用即時權重重新計算 shortcut weight
    b) 定期局部重建：每 5-15 分鐘對交通變化大的區域重建 CH
    c) Hybrid：CH 給粗略路徑 → 局部 Dijkstra 用即時權重微調
```

---

## 7. ETA 預估 (Estimated Time of Arrival)

### 為什麼不能只用 Σ(distance / speed)？

```
簡單加總的問題：
  1. 不考慮紅綠燈等待時間（城市內每個路口 ~30 秒）
  2. 不考慮左轉/右轉延遲（左轉平均比直行多 15-30 秒）
  3. 不考慮未來交通變化（30 分鐘後的塞車程度可能不同）
  4. 不考慮路段銜接（高速公路 → 平面道路的匝道減速）

Google 的 ETA 準確度：
  平均誤差 < 5%（短程城市內）
  平均誤差 < 10%（長途跨縣市）
  → 遠超簡單加總的 20-30% 誤差
```

### ML 模型架構

```
Features:
  - 路段特徵：道路等級、車道數、速限、路面類型
  - 時間特徵：星期幾、小時、是否假日
  - 即時交通：路段當前速度、上游/下游速度
  - 歷史交通：同一時段的歷史平均速度
  - 天氣（可選）：雨天平均速度下降 10-20%
  - 轉彎序列：連續左轉 vs 直行的額外延遲

Model：
  GNN (Graph Neural Network) 或 Transformer-based：
  → 將路徑視為 sequence of road segments
  → 每個 segment 有 feature vector
  → 預測整段路徑的 total travel time

  或 DeepETA（Google 論文）：
  → 把路徑拆成 super-segments
  → 用 historical + real-time features 預測每個 super-segment 時間
  → 求和得到總 ETA

訓練資料：
  過去的導航記錄（GPS 軌跡）→ 知道實際花了多久
  每天上億條記錄 → 非常充足的訓練集
```

---

## 8. 導航 (Turn-by-turn Navigation)

### 架構

```
導航開始後：

Server side:
  1. 計算完整路徑 + ETA → 回傳路徑 polyline + 每個轉彎指令
  2. 每 30-60 秒收到 Client GPS 更新 → 檢查是否偏離

Client side（主要邏輯在 Client）:
  1. GPS Tracking：每秒取得位置
  2. Map Matching（路徑吸附）：
     → GPS 精度 ±5-15m → 可能偏離道路
     → 把 GPS 座標投影到最近的路徑邊上
     → 考慮行進方向 + 前後座標的連續性
  3. 路徑偏離偵測：
     → 如果連續 3 個 GPS 點距離路徑 > 50m → 判定偏離
     → 觸發重新規劃路徑 (re-route)
  4. 指令播報：
     → 距離下一個轉彎 < 500m → "前方 500 公尺右轉"
     → 距離下一個轉彎 < 100m → "即將右轉"
```

### Re-routing

```
偏離路徑 → 需要即時重新規劃：

需求：
  - 必須在 < 500ms 內回傳新路徑（使用者正在開車）
  - 考慮即時交通
  - 新路徑要跟原本的目的地一致

做法：
  1. Client 偵測偏離 → 發送 re-route 請求（附帶當前位置 + 目的地）
  2. Server 用 CH 計算新路徑（~5ms）
  3. 疊加即時交通 → 回傳新路徑

頻率：
  平均每次導航 re-route 0.5-2 次
  1B navigations/day × 1 re-route = ~12K re-route queries/sec
  → 跟正常 route query 差不多，Routing Service 一起扛
```

### 離線地圖 (Offline Maps)

```
使用者下載某個區域（例如「台灣」）：

下載內容：
  1. Vector Tiles：該區域所有 zoom level 的圖磚
     → 台灣 ~36,000 km² → zoom 0-16 ≈ 2-3 GB
  2. Routing Graph：該區域的路網圖（含 CH 預處理結果）
     → 台灣路網 ~5M 節點 → ~500 MB
  3. POI 資料庫：餐廳、加油站等基本資訊
     → ~200 MB

Total: ~3-4 GB per 中型國家

離線導航限制：
  - 無即時交通 → 只能用速限計算 ETA
  - 無法 re-route 到下載區域外
  - POI 資訊可能過時
```

---

## 9. 附近搜尋 (Nearby Search)

### 地理空間索引 (Geospatial Index)

```
Query: "我附近 1 公里內的咖啡廳"
  → 需要找出 (user_lat, user_lng) 半徑 1 km 內，category = "café" 的 POI

資料規模：
  全球 POI 數量：~2 億（Google Maps Places API）
  每個 POI：id, name, category, lat, lng, rating, ...（~500 bytes）
  Total: ~100 GB

索引方案：

1. Geohash + 倒排索引：
   Geohash "wsqq" (精度 ~600m) 內的 café：
     geohash:wsqq:café → [poi_1, poi_7, poi_23, ...]
   查詢時展開相鄰的 9 個 geohash cell → merge → 按距離排序

2. S2 Geometry（Google 使用）：
   → 將地球表面切成階層 cell
   → 查詢：找出覆蓋搜尋圓的 S2 cells → 查每個 cell 內的 POI

3. 排序：
   score = f(distance, rating, popularity, relevance, open_now)
   → 不是純距離排序 → 1 km 外的 4.8 星餐廳可能排在 200m 內的 3.0 星前面
```

---

## 10. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 150M |
| Route queries/day | 1B → **~12K queries/sec** |
| Tile requests/day | 200B → **~2.3M req/sec**（CDN 吸收 95%） |
| GPS ingestion | ~50K updates/sec |
| Road graph nodes | ~10 億 |
| Road graph edges | ~20 億 |
| Graph storage (raw) | 20B edges × 50 bytes = **~100 GB** |
| Graph + CH shortcuts | ~300 GB（fits in memory） |
| Vector Tiles (all zooms) | **~100 TB**（Object Storage） |
| Satellite Raster Tiles | **~500 TB+** |
| POI database | ~2 億 POI × 500 bytes = **~100 GB** |
| Traffic data (real-time) | ~5 億 road segments × 20 bytes = **~10 GB** |
| Offline map (per country) | ~1-5 GB（視面積而定） |
| Routing Service nodes | ~50 台（每台 512 GB RAM，存 CH graph replica） |
| CDN Edge PoPs | 200+ 全球節點 |

---

## 11. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| Tile 格式 | **Vector Tile 為主** | 體積小 2-4 倍、Client 可任意旋轉/傾斜、style 可動態切換 |
| Routing 演算法 | **Contraction Hierarchies** | 預處理數小時換取查詢 ~2ms；Dijkstra 在 10 億節點上需要數秒 |
| 交通整合方式 | **CH + 即時權重疊加** | 純靜態 CH 不反映塞車；純 Dijkstra 太慢；混合方案兼顧速度與準確 |
| ETA 預估 | **ML model（非簡單加總）** | 簡單加總誤差 20-30%，ML 可降到 < 5%，考慮紅綠燈/轉彎/天氣等 |
| 地圖儲存 | **Object Storage + CDN** | 圖磚是靜態資源，CDN hit rate 95%+ → Origin 壓力低 |
| Graph 部署 | **全圖放入單台記憶體 (replica)** | ~300 GB graph + CH → 512 GB RAM 機器可裝下；避免分散式查詢的 latency |
| Geospatial Index | **S2 Geometry** | 球面幾何原生支援、階層 cell 結構適合不同精度的查詢 |
| 離線地圖 | **Vector Tile + 局部 CH graph** | 每國 ~3-5 GB，可接受；raster tile 會大 3-4 倍 |

---

## 12. 面試常見 Follow-up

### Q: 如果交通突然壅塞（車禍），如何快速反應？

```
1. GPS 軌跡異常偵測：
   某路段突然從 60 km/h 降到 5 km/h → 5 分鐘內聚合管線偵測到
   → 更新 Traffic Store

2. 正在導航的使用者：
   Server 端每 30-60 秒檢查路徑上的交通變化
   → 如果 ETA 增加 > 10 分鐘 → 主動推送備選路徑 (proactive re-route)
   → 推播通知：「偵測到前方壅塞，建議改走替代道路」

3. 新查詢的使用者：
   → Routing Service 查詢時自動讀取最新 Traffic Store
   → 自然避開壅塞路段

延遲：從車禍發生到系統反應 = 3-5 分鐘
  （GPS 資料傳輸 ~30 秒 + 聚合計算 ~2 分鐘 + Traffic Store 更新 ~1 分鐘）
```

### Q: 如何支援多種交通方式（開車/走路/大眾運輸/腳踏車）？

```
每種交通方式有獨立的路網圖：

開車 Graph：只包含可通車的道路，考慮單行道/轉彎限制
走路 Graph：包含人行道、地下道、公園步道（車道可能禁止行人）
腳踏車 Graph：包含自行車道，排除高速公路
大眾運輸 Graph：複合圖
  → 站點 = 節點，路線 = 邊
  → edge weight = 等車時間 + 乘車時間
  → 需要即時班次資料（GTFS-realtime）
  → 還要加上「步行到站」的轉乘邊

查詢時根據 mode 選擇對應的 graph
CH 針對每種 mode 各預處理一份
```

### Q: 地圖資料多久更新一次？如何更新？

```
資料來源：
  - 衛星影像 → 自動偵測新建道路/建築（ML pipeline）
  - 街景車 (Street View car) → 每 1-3 年重新拍攝
  - 使用者回報 → "這條路已封閉" → 人工審核後更新
  - 政府開放資料 → 新建道路/門牌

更新流程：
  1. 新資料進入 → Map Editing Pipeline（自動 + 人工審核）
  2. 路網圖更新 → 重新預處理 CH（全球 ~6 小時 / 局部 ~10 分鐘）
  3. 圖磚重新渲染 → 受影響的 tile 重新生成 + CDN invalidate
  4. POI 更新 → 即時寫入 POI database

頻率：
  - 路網更新：每週全量 + 每日增量
  - 圖磚更新：每月全量（新 version 號）
  - 交通資料：即時（每 1-5 分鐘）
  - POI：即時（有新增/修改就更新）
```

### Q: 怎麼處理高速公路上下交疊（3D 道路）？

```
同一個 (lat, lng) 可能對應兩條不同高度的道路：
  例如：高架橋 + 平面道路

解法：
  1. 路網圖中是不同的 edge（即使 2D 座標重疊）
  2. GPS Map Matching 用額外信號區分：
     → 氣壓計 (barometer)：手機內建，可偵測高度差 ~3m
     → 速度模式：高速公路 vs 平面道路速度明顯不同
     → 前後軌跡連續性：如果前 10 秒都在高速公路上，不太可能突然在平面
  3. 3D routing：edge 帶有高度資訊，不會把高架橋和平面道路混淆
```

---

## 13. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— 定義功能範圍（地圖顯示、路徑規劃、即時交通、導航），列出 QPS 和路網規模（10 億節點、200B tile requests/day）

2. **地圖圖磚服務**（2 分鐘）— 座標系統 (zoom, x, y)、Vector vs Raster trade-off、CDN 快取分層（hit rate 95%+）、儲存估算

3. **路徑規劃（核心）**（4 分鐘）— **先講 Dijkstra 為什麼不行**（10 億節點 → 數秒）→ **推導出 Contraction Hierarchies**（預處理壓縮 → 查詢 2ms）→ 講 trade-off（預處理時間 vs 查詢速度）→ 交通整合的挑戰

4. **即時交通**（2 分鐘）— GPS 資料來源 → Map Matching → Speed Aggregation → Traffic Store → 路徑疊加

5. **ETA 預估**（1 分鐘）— 為什麼簡單加總不準 → ML model 考慮紅綠燈/轉彎/時間

6. **導航 + 離線**（1 分鐘）— Client-side GPS tracking、Map Matching、偏離偵測 → re-route、離線下載內容

7. **Deep Dive（面試官選）**（2 分鐘）— Geocoding/Autocomplete、Graph Partitioning、多交通方式、地圖更新流程
