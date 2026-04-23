# Geospatial Index：QuadTree vs GeoHash vs S2 vs H3 vs R-tree

> 空間索引的核心問題：「給定一個座標，怎麼快速找到附近的東西？」
> 不同演算法用不同策略解決，選型取決於**資料型態（點 vs 線段）**和**讀寫比例**。

---

## 1. 兩大家族

空間索引分成兩個根本不同的思路：

| | **家族 1：切空間 (Space Partitioning)** | **家族 2：包物件 (Object Grouping)** |
|---|---|---|
| 核心思路 | 把空間**遞迴切割**成小區塊，物件歸屬到所在區塊 | 把空間中的**物件**用 bounding box 分組 |
| 類比 | 切棋盤格，每格有座標 | 用橡皮筋圈住一堆東西 |
| 代表 | QuadTree, GeoHash, S2, H3 | R-tree, R*-tree |
| 空區域 | 也會被切（浪費空間） | 不會（只包有物件的區域） |
| 適合 | **點資料**（司機、商店、POI） | **非點物件**（道路線段、建築多邊形） |
| DB 使用 | Redis GEOADD (GeoHash), 自建 index | PostGIS GiST index (R-tree) |

---

## 2. 家族 1：Space Partitioning（切空間）

### 2.1 QuadTree

```
原理：
  從整個空間開始，遞迴將每個區域切成 4 等分
  當一個區塊內的物件數超過閾值 → 分裂成 4 個子區塊
  
  ┌───────┬───────┐
  │       │ •   • │
  │       ├───┬───┤    • = 物件
  │       │ • │   │    密集區域切得更細
  ├───────┼───┴───┤    稀疏區域保持大格
  │   •   │       │
  │       │       │
  └───────┴───────┘

結構：
  樹的每個 internal node 有 4 個 children (NW, NE, SW, SE)
  Leaf node 存實際的物件
  樹的深度由物件密度決定（adaptive）

查詢 (find nearest within radius R)：
  1. 從 root 往下走到目標座標所在的 leaf → O(log N)
  2. 檢查 leaf 內的物件
  3. 如果 radius 跨越 cell 邊界 → 也要查鄰居 cell
  → 平均 O(log N)，最差 O(N)

更新 (物件移動位置)：
  1. 找到舊位置所在的 leaf → O(log N)
  2. 從 leaf 移除 → 可能觸發 node merge
  3. 在新位置插入 → 可能觸發 node split
  4. merge/split 需要修改樹結構 → lock contention
  → 高頻更新場景（Uber 司機每 3 秒更新）會出問題

適用：
  ✓ 靜態或低頻更新的點資料（餐廳、商店、POI）
  ✓ In-memory，查詢很快
  ✗ 高頻更新（update = delete + re-insert + 可能 rebalance）
  ✗ 不適合磁碟存儲（樹結構不像 B-tree 那樣 disk-friendly）
```

### 2.2 GeoHash（2D → 1D 字串）

```
原理：
  把 2D 座標 (lat, lng) 遞迴二分，交替切緯度和經度
  每次二分的結果編碼成 bit → 最終用 Base32 編碼成字串
  底層使用 Z-curve (Morton curve) 做空間填充

  (1.290, 103.851) → "w21z3q"

  精度由字串長度決定：
    4 chars → ~39km × 20km cell
    6 chars → ~610m × 610m cell（常用）
    8 chars → ~38m × 19m cell

  相近的座標有相同的 prefix → prefix 查詢 = 範圍查詢
  WHERE geohash LIKE 'w21z3%'  → 查出這個區塊內的所有物件

查詢：
  1. 算出目標座標的 geohash
  2. 查目標 cell + 周圍 8 個鄰居 cell（解決邊界問題）
  3. 過濾出實際在半徑內的結果
  → Redis GEORADIUS 內部就是這樣做的

問題 1：Cell 大小不均勻
  GeoHash 直接切 lat/lng 的「度數」，不考慮地球是球體
  1° 經度在不同緯度代表的實際距離不同（經線在兩極收斂）
    赤道：1° 經度 ≈ 111 km → cell ≈ 610m × 610m（正方形）
    北緯 60°：1° 經度 ≈ 55.8 km → cell ≈ 610m × 305m（扁了一半）
  → 同一 precision 在不同緯度搜尋範圍不同

問題 2：Z-curve locality 差
  Z-curve 的走法（Z 字形）：
    1 → 2
    ↓   ↓
    3 → 4 → 5 → 6
              ↓   ↓
              8 ← 7
  
  1D 上相鄰的 cell 在 2D 上可能跳很遠（Z 字形轉折處）
  → 範圍查詢需要覆蓋較多 cell → 查詢效率不穩定

適用：
  ✓ 簡單好實作，Redis GEOADD 直接內建
  ✓ 低緯度地區 cell 夠均勻
  ✓ 字串 prefix 查詢直覺好懂
  ✗ 高緯度 cell 變形嚴重
  ✗ Z-curve locality 不如 Hilbert curve
```

### 2.3 S2 Geometry（Google）（2D → 1D 64-bit integer）

```
S2 用兩個改良解決 GeoHash 的兩個問題：

改良 1：投影方式（解決 cell 不均勻）
  
  GeoHash：直接切 lat/lng 度數 → 忽略球面 → 高緯度嚴重變形
  S2：先把球面投影到立方體的 6 個面 → 每個面是正方形 → 再遞迴 4 分

  ┌──────┐
  │ Face │ ← 地球投影到立方體 = 6 個 face
  │  0   │    每個 face 再做 QuadTree 式 4 分裂
  │      │    cell 面積差異控制在 ~1.5x 以內
  └──────┘    （GeoHash 在極地 vs 赤道差 2x+）

改良 2：Hilbert curve（解決 locality 問題）

  Z-curve（GeoHash 用的）：      Hilbert curve（S2 用的）：
    1 → 2                          1 → 2
    ↓   ↓                          ↑   ↓
    4 ← 3                          4 → 3
  
  Z-curve 轉折處跳很遠             Hilbert curve 每步只移動 1 格
  locality 差                      locality 好：1D 近 ≈ 2D 近

  實際差別：
    半徑 1km 的圓形查詢：
      GeoHash：需要查 ~9-25 個 cell（覆蓋範圍粗糙）
      S2：需要查 ~4-8 個 cell（覆蓋更精準）
      → S2 的 I/O 更少

Cell 階層結構：
  Level 0:  整個 face（~85,000 km²）
  Level 12: ~3.3 km²（城市級查詢）
  Level 14: ~210,000 m²（街區級）
  Level 16: ~13,000 m²（建築物級）
  Level 30: ~1 cm²（理論最小）

  每個 cell 有唯一的 64-bit integer ID
  → Cell ID 的 prefix 對應到更大的 parent cell
  → range query：WHERE cell_id BETWEEN ? AND ?（integer 比較，比 string prefix 快）

適用：
  ✓ 全球尺度的 geospatial 系統（Google Maps, Uber 早期, FourSquare）
  ✓ Cell 均勻，查詢效率穩定
  ✓ 64-bit integer ID，DB 和 cache 都高效
  ✓ 支援任意形狀的 region covering（不限圓形）
  ✗ 實作比 GeoHash 複雜（需要 S2 library）
  ✗ 不是完全等面積（~1.5x 變異），但比 GeoHash 好很多
```

### 2.4 H3（Uber 自研）（六角形網格）

```
H3 用完全不同的數學：不是 QuadTree 4 分裂，是六角形網格

原理：
  1. 把地球投影到正二十面體 (icosahedron, 20 個三角面)
  2. 每個三角面鋪上六角形網格
  3. 遞迴細分成更小的六角形（每層 ~7 個子六角形）

  六角形 vs 正方形的優勢：
    正方形：4 個邊鄰居 + 4 個角鄰居
            邊鄰居距離 d，角鄰居距離 √2 × d ≈ 1.41d
            → 鄰居距離不一致

    六角形：6 個鄰居，全部等距
            → 鄰居距離一致 → 「半徑 R 內」的查詢更自然
            → k-ring 查詢（查周圍 k 層鄰居）結果更均勻

  Resolution levels：
    Res 0:  ~4,250 km²
    Res 7:  ~5.16 km²（城市級）
    Res 9:  ~0.105 km²（街區級）
    Res 15: ~0.9 m²

H3 vs S2：
  | | S2 | H3 |
  |---|---|---|
  | Cell 形狀 | 正方形（cube face 4 分裂） | 六角形（icosahedron） |
  | 鄰居等距 | ✗（對角 vs 邊鄰居） | ✓（6 個鄰居全等距） |
  | 面積均勻 | ~1.5x 變異 | **更均勻**（但邊角有少量五角形） |
  | 遞迴完美性 | ✓ 完美 4 分裂 | ✗ 六角形無法完美分裂，需混入五角形 |
  | 1D 編碼 | 64-bit Hilbert curve ID | 64-bit H3 index |
  | 開源 | Google S2 library | Uber H3 library |
  | 誰在用 | Google Maps, FourSquare | Uber, Snap, Datadog |

適用：
  ✓ 需要等距鄰居的場景（ride-hailing, surge pricing, 熱力圖）
  ✓ 面積均勻度最好
  ✗ 六角形無法完美遞迴（每層有 12 個五角形 cell）
  ✗ 數學原理跟 S2 完全不同，不是 S2 的改良版
```

---

## 3. 家族 2：Object Grouping（包物件）

### 3.1 R-tree

```
原理：
  像 B-tree 但用於空間資料
  每個 node 包含一個 MBR (Minimum Bounding Rectangle, 最小外接矩形)
  MBR 包住所有 children 的 MBR → 階層套疊

  ┌──────────────────────┐
  │ R1                   │
  │  ┌────┐    ┌─────┐  │
  │  │ •  │    │ ••  │  │   R1 的 MBR 包住 R2, R3
  │  │  • │    │  •  │  │   R2 的 MBR 包住 3 個物件
  │  │ R2 │    │ R3  │  │   R3 的 MBR 包住 3 個物件
  │  └────┘    └─────┘  │
  └──────────────────────┘

  結構：
    - 平衡樹（所有 leaf 同一層）
    - 每個 node 有 min/max children（像 B-tree）
    - Internal node 存 MBR + pointer to children
    - Leaf node 存 MBR + 實際物件 reference

查詢 (find objects within region Q)：
  1. 從 root 開始，檢查哪些 children 的 MBR 跟 Q 重疊
  2. 遞迴進入重疊的 children
  3. 到 leaf 時返回實際命中的物件
  → 好的 R-tree：大部分 MBR 不跟 Q 重疊 → 剪枝效率高

為什麼適合道路和多邊形：
  一條路橫跨一整個區域：
    QuadTree：路跨 4 個 cell → 存 4 份 → 浪費 + 查詢要 merge
    R-tree：用 MBR 包住整條路 → 存 1 份 → 查詢直接找到

  PostGIS 的 GiST index 底層就是 R-tree / R*-tree：
    CREATE INDEX idx_roads_geom ON roads USING GIST (geom);
    → 適合 Google Maps 的道路網路、建築物、行政區邊界等

R*-tree：R-tree 改良版
  插入時不只考慮 MBR 面積最小化，還考慮 MBR 之間的 overlap 最小化
  → 查詢時剪枝效率更高
  → PostGIS 預設使用

適用：
  ✓ 非點物件：道路線段、建築多邊形、行政區邊界
  ✓ Disk-friendly（跟 B-tree 一樣，一個 node = 一個 page）
  ✓ 成熟穩定（PostGIS, SpatiaLite 都用）
  ✗ 不適合高頻更新（insert/delete 可能觸發 rebalance）
  ✗ 不做 2D → 1D 轉換，無法直接用 integer range query
```

---

## 4. Comparison Matrix

| | QuadTree | GeoHash | S2 | H3 | R-tree |
|---|---|---|---|---|---|
| **家族** | 切空間 | 切空間 | 切空間 | 切空間 | 包物件 |
| **Cell 形狀** | 正方形 | 矩形 | 正方形 | 六角形 | MBR (矩形) |
| **2D→1D 編碼** | 無 | Z-curve → 字串 | Hilbert curve → 64-bit int | H3 index → 64-bit int | 無 |
| **Cell 均勻度** | 依密度 adaptive | ✗ 高緯度變形 | ~1.5x | **最佳** | N/A |
| **Locality** | N/A (樹走訪) | ✗ Z-curve 差 | ✓ Hilbert 好 | ✓ 等距鄰居 | N/A (MBR 剪枝) |
| **非點物件** | ✗ | ✗ | ✗ | ✗ | **✓ 最適合** |
| **高頻更新** | ✗ lock contention | ✓ 覆蓋寫入 | ✓ | ✓ | ✗ rebalance |
| **Disk-friendly** | ✗ | ✓ (字串 index) | ✓ (integer index) | ✓ (integer index) | **✓ (像 B-tree)** |
| **實作複雜度** | 低 | 低 | 中 | 中 | 低 (DB 內建) |
| **常見使用** | In-memory index | Redis GEOADD | Google Maps | Uber (surge/analytics) | PostGIS |

---

## 5. 決策樹

```
你要索引什麼類型的資料？
│
├── 點資料（司機、商店、POI）
│     │
│     ├── 寫入頻率？
│     │     │
│     │     ├── 高頻更新（>10K writes/sec，如 Uber 司機位置）
│     │     │     └── Redis GEOADD (GeoHash) — 最簡單，覆蓋寫入無 lock
│     │     │         如果在低緯度地區夠用；全球系統考慮 S2
│     │     │
│     │     └── 低頻更新（商店、POI，偶爾新增/修改）
│     │           │
│     │           ├── 需要全球均勻 cell？
│     │           │     ├── YES → S2（Google Maps style）
│     │           │     └── NO → GeoHash 或 QuadTree 就夠
│     │           │
│     │           └── 需要等距鄰居（熱力圖、surge pricing）？
│     │                 └── YES → H3
│     │
│     └── 規模？
│           ├── 單城市 → 單節點 Redis + GeoHash
│           └── 全球 → 按城市 shard + S2 或 H3
│
└── 非點資料（道路、多邊形、建築物）
      └── R-tree（PostGIS GiST index）
          → 唯一合理選擇，其他方案都要把線段切成多份存

混合場景（Google Maps = 道路 + POI + 司機）：
  道路網路 → R-tree (PostGIS)
  POI 搜尋 → S2 + 倒排索引
  即時位置 → Redis GEOADD (GeoHash) 或 S2 in-memory
```

---

## 6. 各 Deep Dive 的選型對照

| 系統 | 選型 | 為什麼 |
|------|------|--------|
| **Uber 即時位置** | Redis GEOADD (GeoHash) | 1.5M writes/sec 高頻更新；覆蓋寫入無 lock；按城市 shard |
| **Uber Surge Pricing / Analytics** | H3 | 需要均勻六角形做熱力圖和 surge 區域劃分 |
| **Google Maps 道路** | R-tree (PostGIS) | 道路是線段，R-tree 用 MBR 包住，不用切成多份 |
| **Google Maps POI** | S2 + 倒排索引 | 全球尺度、cell 均勻、64-bit ID 高效 range query |
| **Yelp / 附近餐廳** | GeoHash 或 QuadTree | 低頻更新、read-heavy、GeoHash 夠簡單 |
| **Proximity Service (通用)** | GeoHash (簡單) 或 S2 (精準) | 看規模和精度需求 |

---

## 7. 常見誤區

| 誤區 | 正解 |
|------|------|
| R-tree 是 QuadTree 的變形 | ❌ 不同家族。QuadTree 切空間，R-tree 包物件。R-tree 更像 B-tree 的空間版 |
| S2 是 GeoHash 的改良版 | ❌ 數學原理完全不同（cube 投影 + Hilbert curve vs 直切 lat/lng + Z-curve）。解決同一問題但用不同方法 |
| H3 是 S2 的改良版 | ❌ 完全不同的數學（icosahedron + 六角形 vs cube + 正方形）。各有優劣 |
| GeoHash cell 是等面積的 | ❌ 高緯度經度方向縮短，cell 變扁。赤道 610m×610m，北緯 60° 變成 610m×305m |
| QuadTree 適合高頻更新 | ❌ Update = delete + re-insert，可能觸發 merge/split，有 lock contention |
| 所有空間索引都一樣 | ❌ 點資料 vs 非點資料是第一個分叉點，選錯家族整個設計都錯 |

---

## 8. Capacity Planning 數字

| 操作 | Redis GEOADD | PostGIS (R-tree) | In-memory QuadTree |
|------|-------------|-----------------|-------------------|
| Point insert | 50-100K ops/sec/node | 1-5K inserts/sec | 100K+ (但有 lock) |
| Point update | 50-100K ops/sec (覆蓋) | 500-2K updates/sec (rebalance) | 10-50K (delete+insert+lock) |
| Radius query | 10-50K queries/sec | 1-10K queries/sec | 50-100K queries/sec |
| 適合 write QPS | **>10K** | <5K | <10K (受 lock 限制) |
| 適合 read QPS | >50K | <10K (disk-bound) | >50K (memory) |
| 儲存 | In-memory (RAM) | Disk (PostgreSQL) | In-memory (RAM) |

**規則：write QPS > 10K → 排除 PostGIS 和 QuadTree；考慮 Redis GEOADD 或 S2 in-memory。**
