# Typeahead / Autocomplete — 搜尋自動補全系統架構

## 1. 核心挑戰

Typeahead 的設計核心是 **在使用者每次按鍵後極低延遲內回傳相關搜尋建議**：

```
規模（以 Google Search 等級為參考）：
  DAU: ~1B
  搜尋次數/day: ~8.5B → ~100K queries/sec
  每次搜尋平均按鍵次數: ~6 次（含修正）
  Typeahead QPS: 100K × 6 = ~600K requests/sec
  不重複搜尋詞彙量: ~5B unique queries（含長尾）
  Top 常用 prefix: ~50M 個（覆蓋 99% 查詢）

延遲目標：
  - 每次按鍵到顯示建議 < 50ms（使用者對 > 100ms 有明顯感知）
  - 包含網路 RTT（intra-DC ~0.5ms）+ 服務處理（< 5ms）+ 客戶端渲染（< 10ms）
  - 實際留給伺服器的時間 < 30ms

核心矛盾：
  - 讀取必須極快（每次按鍵都觸發查詢，600K QPS）
  - 但排名要即時反映趨勢（5 分鐘前的熱搜現在就要出現）
  - 資料量龐大（5B unique queries）但服務必須全部放記憶體
```

---

## 2. 整體架構

```
┌──────────────┐
│   Client     │
│  (Browser /  │──── 每次按鍵（debounce 150ms）────┐
│   Mobile)    │                                    │
│              │◀── top-K suggestions ──────────────┤
│  [本地 cache] │                                    │
└──────────────┘                                    │
                                                    ▼
                                            ┌──────────────┐
                                            │  API Gateway  │
                                            │  / CDN Edge   │
                                            └──────┬───────┘
                                                   │
                              ┌─────────────────────┼──────────────────────┐
                              │                     │                      │
                              ▼                     ▼                      ▼
                     ┌──────────────┐     ┌──────────────┐      ┌──────────────┐
                     │ Trie Shard 1 │     │ Trie Shard 2 │      │ Trie Shard N │
                     │   (a - g)    │     │   (h - n)    │      │   (o - z)    │
                     │  [in-memory] │     │  [in-memory] │      │  [in-memory] │
                     └──────────────┘     └──────────────┘      └──────────────┘
                              ▲                     ▲                      ▲
                              │         定期 atomic swap（每 15 分鐘）       │
                              │                     │                      │
                     ┌────────┴─────────────────────┴──────────────────────┘
                     │
              ┌──────┴───────┐
              │ Trie Builder │ ◀── 聚合後的 frequency map
              │  (offline)   │
              └──────┬───────┘
                     │
              ┌──────┴───────┐
              │  Aggregator  │ ◀── 滑動窗口統計（每 prefix 的搜尋頻率）
              │ (Flink/Spark)│
              └──────┬───────┘
                     │
              ┌──────┴───────┐
              │    Kafka     │ ◀── 搜尋日誌（user_id, query, timestamp）
              │  (search log)│
              └──────┬───────┘
                     │
              ┌──────┴───────┐
              │Search Service│ ── 使用者每次完成搜尋時記錄
              └──────────────┘
```

---

## 3. 核心資料結構：Trie（前綴樹）

### 基本 Trie 結構

Trie（又稱 Prefix Tree）是 Typeahead 的核心。每個節點代表一個字元，從 root 到某節點的路徑代表一個 prefix：

```
範例：儲存 "tree", "try", "true", "system", "sys"

         (root)
        /      \
       t        s
       |        |
       r        y
      / \       |
     e   u      s ← "sys" (freq: 800)
     |   |      |
     e   e      t
     ↑   ↑      |
"tree" "true"   e
(500)  (300)    |
                m ← "system" (freq: 1200)
```

### 每個節點儲存什麼？

```python
class TrieNode:
    children: Dict[char, TrieNode]   # 子節點映射
    is_end: bool                      # 是否為完整查詢詞
    frequency: int                    # 該查詢的搜尋頻率（僅 is_end=True）
    top_k: List[(str, int)]          # ★ 預計算的 top-K suggestions
                                      #   從這個 prefix 往下所有完整詞中，
                                      #   頻率最高的 K 個
```

### 為什麼要預計算 Top-K？

```
不預計算：
  查詢 "sys" → 走到 s→y→s 節點 → 需要 DFS 遍歷該子樹所有 leaf
  → 子樹可能有上萬個詞 → 遍歷 + 排序 = O(子樹大小)
  → "s" 的子樹可能佔 Trie 的 10%，延遲飆到幾百毫秒

預計算：
  每個節點存 top_k = [("system design", 5000), ("system", 1200), ("sys admin", 800)]
  → 查詢 "sys" → 直接回傳 top_k → O(1)
  → 延遲 < 1ms（純記憶體存取）

代價：
  每個節點多存 K 個 (string, frequency) → 記憶體增加
  K=10, 平均 query 長度 20 chars → 每個節點多 ~200 bytes
  但只在 build time 計算，不影響 query time
```

### 壓縮 Trie（Compressed Trie / Radix Tree）

標準 Trie 中，單鏈節點（只有一個 child）浪費空間：

```
壓縮前：
  s → y → s → t → e → m       （6 個節點表示 "system"）

壓縮後（合併單鏈）：
  "sys" → "tem"                 （2 個節點）

節省多少？
  假設 5M unique prefixes，平均 prefix 長度 8 chars
  未壓縮：每個 char 一個節點 → ~40M 節點
  壓縮後：合併單鏈 → ~8M 節點（節省約 80%）

  每節點 overhead（指標 + metadata）≈ 64 bytes
  節省：32M × 64B = ~2GB
```

---

## 4. 查詢流程（Query Path）

### 完整 flow：使用者輸入 "sys"

```
1. Client 端（瀏覽器）：
   使用者按 "s" → "y" → "s"
   Debounce timer: 等 150ms 無新按鍵後才發請求
   → 檢查本地 cache: "sys" 有沒有快取結果？
   → 沒有 → 發 HTTP GET /autocomplete?q=sys

2. API Gateway / Edge：
   → 根據 prefix 首字母路由到對應 shard
   → "sys" → 首字母 "s" → Shard 3 (o-z)

3. Trie Shard 服務（in-memory）：
   → 沿 Trie 走 s → y → s
   → 到達 "sys" 節點 → 讀取 top_k 欄位
   → 回傳 [("system design", 5000), ("system", 1200), ...]

4. 回到 Client：
   → 渲染下拉選單
   → 將 "sys" → results 存入本地 cache
```

### Prefix 重用（Client-side Optimization）

```
使用者繼續輸入 "syst"：
  → 本地 cache 有 "sys" 的結果（10 條建議）
  → "syst" 的結果一定是 "sys" 結果的子集
  → Client 端直接在 10 條中 filter 以 "syst" 開頭的 → 不需要發請求！

什麼時候必須重新請求？
  → 本地 filter 後結果 < K 條 → 可能有更好的結果在 server
  → 或使用者刪除字元（"syst" → "sy"）→ 擴大了 prefix → 需要新結果
```

### 延遲分析

```
目標：每次按鍵到顯示 < 100ms（使用者感知閾值）

分解：
  Debounce wait:           ~150ms（刻意延遲，但不影響感知——使用者還在打字）
  Network RTT (intra-DC):  ~0.5ms
  Shard 路由:              ~0.1ms
  Trie lookup:             ~0.01ms（in-memory hash map traversal）
  Serialization + response: ~0.5ms
  Network RTT (return):    ~0.5ms
  Client 渲染:             ~5ms
  ─────────────────────────
  總計（不含 debounce）:    ~7ms ← 遠低於 50ms 目標

真正的 bottleneck 是 Client-to-DC 的 RTT：
  同城 DC: ~10ms → 總計 ~20ms（去 + 回）→ OK
  跨區域: ~100ms → 總計 ~200ms → 太慢！
  → 解法：CDN Edge 部署 Trie 副本，或把 Trie 服務部署到多個 Region
```

---

## 5. 排名系統（Ranking）

### 多維度排名公式

```
score(query, user, time) = α × global_freq(query)
                         + β × recency_decay(query, time)
                         + γ × personal_freq(query, user)
                         + δ × trending_boost(query)

其中：
  α, β, γ, δ = 權重（可調參數）
  global_freq = 全域搜尋頻率（所有人搜了多少次）
  recency_decay = 時間衰減（越新的搜尋權重越高）
  personal_freq = 該使用者個人歷史搜尋頻率
  trending_boost = 當前趨勢加成（突然飆升的搜尋詞）
```

### 頻率時間衰減（Exponential Time Decay）

```
不做衰減的問題：
  "COVID vaccine" 在 2021 年搜尋量巨大 → 永遠排第一
  但 2025 年已經不相關了

Exponential decay:
  decayed_freq = freq × e^(-λ × Δt)
  λ = decay constant（控制衰減速度）
  Δt = 距離現在的時間（小時）

  範例（λ = 0.01/hour）：
    1 小時前的搜尋：freq × 0.99（幾乎沒衰減）
    24 小時前：freq × 0.79
    1 週前：freq × 0.19
    1 個月前：freq × 0.001（幾乎歸零）

實作方式：
  不需要對每個 query 即時計算——在 batch aggregation 時一次算好
  每 15 分鐘重新 build Trie 時，用 decayed frequency 作為 score
```

### 個人化（Personalization）

```
架構：
  Global Trie: 所有人共用，存全域 top-K
  Personal layer: 每個使用者一個小 cache（最近 100 次搜尋）

查詢時：
  1. 查 Global Trie → 拿到 global top-10
  2. 查使用者的 personal history → filter 出匹配 prefix 的
  3. Merge: personal results 排前面（權重加成），global 補齊到 10 條
  4. 去重

為什麼不為每個使用者建一棵 Trie？
  1B users × 100 queries × 200 bytes = 20TB → 放不進記憶體
  → 只用小 cache（Redis hash map），不用 Trie
  → Key: user:{user_id}:recent → [(query, timestamp), ...]
```

---

## 6. 資料收集與 Trie 更新管道

### 為什麼不即時更新 Trie？

```
每次搜尋都更新 Trie：
  600K QPS → 每秒 600K 次 Trie write
  Trie write = 找到節點 → 更新 frequency → 重新計算該路徑上所有 top-K
  → 重新計算 top-K 需要 lock（concurrent read/write conflict）
  → Lock contention 在 600K QPS 下 → Trie 服務直接掛掉

正確做法：批次更新 + 原子切換
  → 讀寫分離：serving Trie 只讀，另一份在背景 build
```

### 完整 Pipeline

```
Step 1: 日誌收集
  使用者完成搜尋（按 Enter 或點擊 suggestion）→ 記錄到 Kafka
  注意：不是每次按鍵都記錄！只記最終提交的搜尋詞
  → 減少 log 量：600K/sec（按鍵）→ 100K/sec（完成搜尋）

Step 2: 聚合（Aggregator — Flink / Spark Streaming）
  Kafka consumer → 滑動窗口統計
  每 15 分鐘輸出一份 frequency map:
    {"system design": 5000, "system": 1200, "spotify": 900, ...}

  使用 exponential decay 計算 weighted frequency

Step 3: Trie Builder（離線任務）
  讀取 frequency map → 建新 Trie
  對每個節點計算 top-K（bottom-up traversal）
  序列化成 binary format → 存到 distributed storage (S3 / HDFS)

Step 4: 部署（Blue-Green Swap）
  新 Trie 建好後 → 推送到 Trie Serving 節點
  每個節點：載入新 Trie 到記憶體 → 原子切換指標 → 釋放舊 Trie

  → 切換過程中無 downtime（舊 Trie 繼續服務到切換完成）
  → 類似 Blue-Green Deployment
```

### Build 時間估算

```
50M unique prefixes → 建 Trie:
  插入 50M 個 string（平均長度 20 chars）
  每次插入 = 走 20 個節點 → O(20) per insert
  50M × 20 = 1B 操作 → 單機約 30-60 秒

計算 top-K（bottom-up DFS）:
  每個節點 merge children 的 top-K → 保留自己的 top-K
  ~8M 壓縮節點 × 每節點 merge K=10 → ~80M 操作 → 約 10 秒

序列化 + 傳輸:
  Trie size ~1-2GB → 寫到 S3 約 5-10 秒
  傳輸到 serving 節點 → 30-60 秒

總計：~2-3 分鐘 build cycle
→ 每 15 分鐘更新一次，2-3 分鐘的 build 延遲完全可接受
```

---

## 7. Serving Layer 設計

### Trie Sharding 策略

```
方案 A：按首字母分片
  Shard 1: a-g（7 個字母）
  Shard 2: h-n（7 個字母）
  Shard 3: o-u（7 個字母）
  Shard 4: v-z + 數字 + 特殊字元

  問題：字母分佈不均
    "s" 開頭的 queries 可能佔 12%
    "x" 開頭的只佔 0.5%
    → hot shard 問題

方案 B：按 prefix range 分片 ← 推薦
  基於實際 query 分佈做均勻切分
  Shard 1: "a" - "de"
  Shard 2: "de" - "in"
  Shard 3: "in" - "pr"
  ...
  → 每個 shard 負責大致相同數量的 queries
  → 定期根據流量重新 balance

每個 shard 的記憶體估算：
  50M unique prefixes / 4 shards ≈ 12.5M prefixes per shard
  每個 prefix 節點：key(20B) + top-K(200B) + overhead(64B) ≈ 284B
  12.5M × 284B ≈ 3.4GB per shard → 輕鬆放進單機記憶體
```

### 高可用

```
每個 shard：
  1 primary + 2 replicas = 3 個 instances
  所有 instances 都載入相同的 Trie snapshot → 都能處理 read

Load balancing:
  request 根據 prefix → 確定 shard → round-robin 到該 shard 的 3 個 instances

Failover:
  一個 instance 掛掉 → 流量自動導到剩餘 2 個
  Trie 是 stateless 的（從 snapshot 載入）→ 新 instance 啟動只需載入 Trie（30 秒）
  → 比有狀態服務的 failover 簡單得多
```

---

## 8. Client-side 優化

### Debounce（防抖）

```
不做 debounce：
  使用者打 "system"（6 個字母）→ 6 個請求在 1 秒內發出
  600K base QPS × 6 = 3.6M QPS → 伺服器壓力大

做 debounce（等待 150ms idle）：
  使用者快速打 "system" → 只在最後 "m" 後 150ms 發 1 個請求
  如果使用者打字速度 > 150ms/char（慢打）→ 每個字母各發一次
  平均減少 50-70% 的請求量

為什麼是 150ms？
  < 100ms：太激進，使用者打兩個字中間的間隔可能 < 100ms → 還是發太多
  > 300ms：太保守，使用者覺得反應遲鈍
  150ms 是業界常見的平衡點
```

### 本地快取

```javascript
// Browser-side cache（LRU cache, 容量限制 1000 entries）
const cache = new LRUCache(1000);

async function getSuggestions(prefix) {
  // 1. 檢查完全匹配的 cache
  if (cache.has(prefix)) {
    return cache.get(prefix);
  }

  // 2. Prefix 重用：找最長的已快取 prefix
  //    "syst" 的結果是 "sys" 結果的子集
  for (let i = prefix.length - 1; i >= 1; i--) {
    const shorter = prefix.substring(0, i);
    if (cache.has(shorter)) {
      const cached = cache.get(shorter);
      const filtered = cached.filter(s => s.startsWith(prefix));
      if (filtered.length >= K) {
        cache.set(prefix, filtered);  // cache 衍生結果
        return filtered;
      }
      break;  // 找到了但數量不夠 → 還是要請求 server
    }
  }

  // 3. Cache miss → 呼叫 server
  const results = await fetch(`/autocomplete?q=${prefix}`);
  cache.set(prefix, results);
  return results;
}
```

### 效果估算

```
Debounce: 減少 ~60% 請求
Prefix 重用: 再減少 ~30% 的剩餘請求
Local cache hit: 再減少 ~20% 的剩餘請求

綜合：
  原始 QPS: 600K
  經 debounce: 240K
  經 prefix 重用: 168K
  經 cache hit: 134K
  → 最終到達 server 的 QPS ≈ 130-150K（減少約 75%）
```

---

## 9. 趨勢偵測（Trending Queries）

### Sliding Window 頻率計數

```
問題：
  某事件爆發（例如地震）→ "earthquake" 搜尋量在 5 分鐘內從 10/min → 10K/min
  需要即時反映在 suggestions 中

但我們的 Trie 每 15 分鐘才更新一次！

解法：雙層架構
  Layer 1: Global Trie（每 15 分鐘更新，覆蓋 99% 場景）
  Layer 2: Trending Override（每 1-2 分鐘更新，只存突發趨勢）

Trending 偵測 pipeline：
  Kafka → Flink streaming job → 滑動窗口（5 min）
  每個 query 計算：
    current_rate = 過去 5 分鐘的搜尋次數 / 5
    baseline_rate = 過去 7 天同時段的平均值
    spike_ratio = current_rate / baseline_rate

    if spike_ratio > 10:  # 10 倍暴增
      → 加入 trending list

查詢時：
  results = trie.lookup(prefix)          # from global Trie
  trending = trending_cache.lookup(prefix)  # from Redis/local cache
  final = merge_and_rerank(results, trending)  # trending 加權
```

---

## 10. 多語言支援（Multi-language）

### CJK 挑戰（中文/日文/韓文）

```
英文 Typeahead：
  "system" → 一個字母一個字母輸入 → 每個 prefix ("s", "sy", "sys"...) 都有意義

中文 Typeahead：
  "系統設計" → 使用者用注音/拼音輸入
  注音：ㄒㄧˋ → 系
  拼音：xi → 系

  問題 1：使用者輸入的是拼音 "xi"，但要匹配中文 "系統設計"
  → 需要拼音 → 漢字的映射層

  問題 2：一個拼音對應多個字（"xi" → 系/西/洗/喜/...）
  → Trie 需要同時索引拼音和漢字

解法：
  建立兩棵 Trie（或一棵 Trie 的兩個 index）：
    1. 原文 Trie：直接用中文字元建 → "系" → "統" → "設" → "計"
    2. 拼音 Trie：用拼音建 → "xi" → "tong" → "she" → "ji"
       每個拼音 leaf 指向原文結果

  查詢時：
    輸入 "xit" → 在拼音 Trie 中查 → 匹配 "xitong*" → 回傳 "系統設計"
```

### Unicode 處理

```
儲存：所有 query 統一 UTF-8 編碼
Trie 節點的 children map：
  英文：char → TrieNode（26 個可能的 children）
  Unicode：需要支援數千個字元 → 用 HashMap 而非 Array

記憶體影響：
  Array-based (26 chars): 每個節點 26 × 8B pointer = 208B
  HashMap-based: 每個 entry ~48B，但只存實際 children
  → CJK Trie 必須用 HashMap，否則每個節點存幾千個空指標
```

---

## 11. 內容過濾（Offensive Content Filtering）

```
問題：
  使用者輸入 "how to" → 不能建議暴力/色情/非法內容
  即使這些內容有很高的搜尋頻率

多層過濾：

Layer 1: Build-time 過濾
  Trie Builder 階段：
    blocklist = load("offensive_terms.txt")  # 數萬個已知敏感詞
    在建 Trie 時，任何匹配 blocklist 的 query 直接跳過不加入
  → 最有效，從源頭阻止

Layer 2: Serving-time 過濾
  即使 build-time 漏掉了某些詞，serving 層再過一次：
    results = trie.lookup(prefix)
    filtered = [r for r in results if not is_offensive(r)]
  → is_offensive 用 Bloom Filter 做快速判斷（O(1), false positive OK）
  → Bloom Filter size: 100K 敏感詞 × 10 bits = ~125KB → 放記憶體零成本

Layer 3: 人工審核回饋
  使用者回報不當建議 → 加入 blocklist → 下次 Trie rebuild 生效
  緊急情況 → 即時更新 serving-time blocklist（推送到所有節點）
```

---

## 12. 技術選型比較：Trie vs Elasticsearch vs Redis Sorted Set

| 維度 | Trie (自建 in-memory) | Elasticsearch prefix query | Redis Sorted Set |
|------|----------------------|---------------------------|------------------|
| **查詢延遲** | **< 1ms**（直接記憶體 traverse） | 5-20ms（需查倒排索引 + scoring） | 2-5ms（ZRANGEBYLEX） |
| **QPS 能力** | **500K+/node**（純記憶體操作） | 10-50K/node（涉及磁碟 I/O） | 100-200K/node |
| **排名靈活度** | 預計算 top-K，更新需 rebuild | **最靈活**（BM25、custom scoring） | 只能按 score 排序 |
| **記憶體效率** | **最佳**（壓縮 Trie + 共享 prefix） | 最差（倒排索引膨脹） | 中等（每個 query 獨立存） |
| **更新速度** | 慢（batch rebuild ~2-3min） | **即時**（index 一筆 ~5ms） | **即時**（ZADD） |
| **運維複雜度** | 高（自建 serving layer） | **低**（managed service 可用） | 低 |
| **Multi-language** | 需自行處理 | **內建分詞器** | 需自行處理 |
| **適用場景** | 超高 QPS、延遲極致要求 | 中等 QPS、需要複雜排名 | 中小規模、快速原型 |

### 決策樹

```
QPS > 100K 且延遲要求 < 10ms？
  ├── Yes → Trie (in-memory)
  │         └── 願意投入維運自建服務？
  │             ├── Yes → 自建 Trie serving layer
  │             └── No → Redis Sorted Set（犧牲一些延遲）
  │
  └── No → QPS < 50K 且需要模糊匹配 / 複雜排名？
            ├── Yes → Elasticsearch（prefix + fuzzy query）
            └── No → Redis Sorted Set（最簡單）
```

---

## 13. 容量估算

| 指標 | 估算 |
|------|------|
| DAU | 1B |
| 搜尋次數/day | 8.5B → **~100K QPS** |
| 按鍵觸發 Typeahead QPS（raw） | ~600K/sec |
| Client 優化後到達 server 的 QPS | **~150K/sec** |
| 不重複搜尋詞彙量 | ~5B（含長尾） |
| 熱門 prefix 數量（覆蓋 99% 查詢） | ~50M |
| 壓縮 Trie 節點數 | ~8M |
| 每節點大小（含 top-10） | ~284 bytes |
| **Trie 總記憶體** | 8M × 284B ≈ **~2.3GB** |
| Shard 數量 | 4 shards × 3 replicas = **12 instances** |
| 每 shard 記憶體 | ~600MB（Trie）+ OS/app overhead → 配 8GB 機器即可 |
| Trie rebuild 頻率 | 每 **15 分鐘** |
| Trie build 時間 | **~2-3 分鐘** |
| Kafka search log throughput | 100K events/sec × 200B/event = **~20MB/sec** |
| Personal history storage（Redis） | 100M active users × 100 queries × 40B = **~400GB** |

---

## 14. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| 核心資料結構 | **Compressed Trie + 預計算 Top-K** | 查詢 O(prefix_len) + O(1) 回傳，延遲 < 1ms |
| Trie 更新策略 | **離線 batch rebuild + 原子切換** | 避免 600K QPS 下的寫入衝突，build 2-3 分鐘完全可接受 |
| 趨勢處理 | **雙層架構（Global Trie + Trending Override）** | Trie 15 分鐘更新 cover 常態；Trending 1-2 分鐘更新 cover 突發 |
| 排名策略 | **Global frequency × decay + personal blend** | 不為每人建 Trie（記憶體爆炸），小 cache 做個人化 merge |
| Sharding | **按 prefix range 均勻切分** | 避免字母分佈不均導致的 hot shard |
| Client 優化 | **Debounce 150ms + prefix 重用 + LRU cache** | 減少 ~75% 到達 server 的 QPS |
| 內容過濾 | **Build-time blocklist + Serving-time Bloom Filter** | 兩層防禦，Bloom Filter 只佔 125KB 零延遲 |
| 技術選型 | **Trie > Redis > ES**（高 QPS 場景） | 延遲 < 1ms 且 500K+ QPS/node，ES 無法達到 |

---

## 15. 面試常見 Follow-up

### Q: 如果要支援 typo correction（拼字糾正）？

```
方案 1：查詢時 fuzzy matching
  使用者輸入 "sytem"（少了一個 s）
  → 在 Trie 中做 edit distance ≤ 1 的 BFS
  → 計算量大：每個節點要展開 26 個可能的替換 → 指數爆炸
  → 不適合即時 Typeahead（延遲會飆到 10-50ms）

方案 2：預計算常見 typo（推薦）
  Build Trie 時，對每個高頻 query 生成 edit distance = 1 的 variants
  "system" → "sytem", "systm", "ystem", "ssystem" ...
  把這些 variants 也加入 Trie，指向正確的 query
  → 查詢 "sytem" → Trie 中有 → 回傳 "system" 的 top-K
  → 代價：Trie size 增大 ~5-10 倍 → 但記憶體從 2GB → 10-20GB，仍可接受

方案 3：二次查詢
  Trie lookup "sytem" → 沒結果
  → 呼叫 spell correction 服務（Elasticsearch 的 fuzzy query、或 SymSpell 演算法）
  → 得到糾正的 "system" → 再查 Trie
  → 多一次 round trip，延遲 +5-10ms，但實作最簡單
```

### Q: 如果某個 prefix 突然暴增（例如名人名字）怎麼辦？

```
Trending layer 處理（見 Section 9）：
  Flink 的 sliding window 在 1-2 分鐘內偵測到 spike_ratio > 10
  → 加入 trending cache → 下次查詢就會出現

如果 QPS 也暴增（所有人同時搜同一個 prefix）：
  1. CDN/Edge cache：熱門 prefix 結果直接在 Edge 快取（TTL 30 秒）
     → 百萬人搜 "earthquake" → 只有第一次打到 Trie server，之後全部 cache hit
  2. 本機 cache：Trie serving node 上也有 LRU cache（top 10K 熱門 prefix）
     → 連 Trie traverse 都跳過
```

### Q: 怎麼避免 Trie rebuild 時的服務中斷？

```
Blue-Green Swap（零停機）：

1. Trie Builder 在背景建好新 Trie → 上傳到 S3
2. 每個 Serving node 收到通知 → 在背景下載並載入新 Trie（~30 秒）
3. 載入完成後：
   old_trie = current_trie
   current_trie = new_trie    ← 原子 pointer swap
   schedule_gc(old_trie)       ← 延遲幾秒後釋放舊 Trie

   期間所有 query 都不中斷：
     swap 前的 query → 用 old_trie 回答（完全正常）
     swap 後的 query → 用 new_trie 回答（完全正常）

4. 記憶體 peak：短暫同時持有兩份 Trie ≈ 2 × 600MB = 1.2GB per shard
   → 配 8GB 機器完全沒問題
```

### Q: 隱私考量？不想讓搜尋歷史出現在建議中？

```
兩個層面：

1. 全域建議（Global suggestions）：
   Trie 用的是聚合後的匿名頻率資料
   → 沒有個人身份資訊
   → 但如果某 query 只有一個人搜過且夠獨特 → 可能間接洩漏
   → 解法：低頻 query（< 某閾值）不加入 Trie

2. 個人化建議（Personal suggestions）：
   使用者可以選擇關閉（opt-out）
   提供「清除搜尋歷史」功能
   Personal history 儲存需遵守 GDPR/CCPA：
     → TTL 自動過期（例如 90 天）
     → 使用者刪除帳號時一併刪除
```

---

## 16. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（2 分鐘）— DAU、搜尋 QPS、Typeahead QPS（按鍵放大 6 倍）、延遲目標 < 50ms
2. **核心資料結構：Trie**（3 分鐘）— Compressed Trie、預計算 Top-K（為什麼不能 query time 才 DFS）、記憶體估算（~2GB）
3. **查詢流程**（2 分鐘）— Client debounce → API Gateway → Shard routing → Trie lookup → 回傳。用數字算延遲（< 10ms server side）
4. **資料更新管道**（3 分鐘）— 為什麼不能即時寫 → Kafka → Aggregator → Trie Builder → Blue-Green swap。畫 pipeline 圖
5. **排名與趨勢**（2 分鐘）— Frequency × decay + personal blend。Trending 雙層架構
6. **Client 優化**（1 分鐘）— Debounce + prefix 重用 + local cache → 減少 75% QPS
7. **Deep Dive（面試官選）**（2 分鐘）— Multi-language/CJK、Typo correction、Offensive filtering、Sharding 策略
