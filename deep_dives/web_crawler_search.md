# Web Crawler + Search Engine — 網頁爬蟲與搜尋引擎架構

## 1. 核心挑戰

Web Crawler 與 Search Engine 是兩個高度耦合的子系統：Crawler 負責「發現與擷取」整個網路的內容，Search Engine 負責「索引與檢索」讓使用者在毫秒內找到答案。

```
規模（以 Google 等級為參考）：
  已知網頁數量: ~50B+ pages
  每日爬取目標: ~5B pages/day → ~58K pages/sec
  平均網頁大小: ~2MB（含 HTML + 資源）→ 但爬蟲只存 HTML ~100KB
  每日原始下載量: 5B × 100KB = ~500TB/day（僅 HTML）
  搜尋 QPS: ~100K queries/sec（Google 每天 ~8.5B 次搜尋）
  索引大小: ~100PB+（壓縮後的 inverted index）

核心矛盾：
  - 網路是無限的，但爬取資源有限 → 必須優先爬高價值頁面
  - 網頁持續變動，但不可能全部重新爬取 → 必須聰明地決定重爬頻率
  - 搜尋必須 < 200ms 回應，但索引橫跨數十億文件 → 分層索引 + 極致快取
  - 必須尊重網站擁有者的意願（robots.txt）+ 不能打爆別人的伺服器
```

---

## 2. 整體架構

```
                         ┌─────────── Crawler 子系統 ───────────┐
                         │                                      │
  Seed URLs ──▶ URL Frontier ──▶ DNS Resolver ──▶ Fetcher      │
                  ▲  (Priority +     (Local       (HTTP GET)    │
                  │   Politeness)      Cache)         │         │
                  │                                   ▼         │
                  │                            Content Parser   │
                  │                            (HTML → text)    │
                  │                                   │         │
                  │         ┌─────────────────────────┤         │
                  │         ▼                         ▼         │
                  │   URL Extractor            Content Store    │
                  │         │                  (S3 / HDFS)      │
                  │         ▼                         │         │
                  │   URL Dedup ──(new URLs)──▶ back  │         │
                  │   (Bloom Filter)          to top  │         │
                  │                                   │         │
                  └───────────────────────────────────┘         │
                                                      │
                         ┌──────── Search 子系統 ──────┤
                         │                             │
                         │    Indexer ◀────────────────┘
                         │      │
                         │      ▼
                         │  Inverted Index Store
                         │  (term → posting list)
                         │      │
                         │      ▼
  User ──query──▶ Query Parser ──▶ Index Searcher ──▶ Ranker ──▶ Results
                                      │
                                   PageRank
                                   Scores DB
```

---

## 3. URL Frontier：爬蟲的「大腦」

URL Frontier 決定「下一個該爬哪個 URL」，是整個 Crawler 最關鍵的元件。它同時解決兩個問題：**優先級**（先爬重要的）和**禮貌性**（不打爆同一台伺服器）。

### 雙層佇列設計

```
                    ┌──────────────────────────────────┐
                    │        Front Queues (Priority)    │
                    │                                   │
                    │  Q_high   [nytimes.com/breaking]  │
                    │  Q_medium [blog.example.com/new]  │
                    │  Q_low    [archive.old-site.com]  │
                    │                                   │
                    └──────────┬───────────────────────┘
                               │ prioritizer 從高優先
                               │ 佇列取出 URL
                               ▼
                    ┌──────────────────────────────────┐
                    │        Back Queues (Politeness)   │
                    │                                   │
                    │  host_A: [url1, url2, url3]       │
                    │  host_B: [url4, url5]             │
                    │  host_C: [url6]                   │
                    │                                   │
                    │  每個 host 維護一個 FIFO queue      │
                    │  + last_access_time               │
                    │  + min_delay（預設 1 秒）           │
                    └──────────────────────────────────┘

取 URL 的流程：
  1. 從 Back Queue 中選一個「冷卻時間已過」的 host queue
  2. 從該 queue 的頭部取出一個 URL
  3. 更新該 host 的 last_access_time
  4. 如果該 host queue 空了，從 Front Queue 補充新 URL 到對應 host queue
```

### 優先級計算

```
priority(url) = w1 × PageRank(domain)
              + w2 × freshness_score(url)
              + w3 × update_frequency(url)
              + w4 × depth_penalty(url)

其中：
  PageRank(domain)     : 該域名的權威度（0~1）
  freshness_score      : 距離上次爬取的時間越久，分數越高
  update_frequency     : 歷史觀察到的更新頻率越高，分數越高
  depth_penalty        : 從 seed URL 到當前 URL 的跳轉次數，越深越低優先
```

### 為什麼需要 Back Queue 做 Politeness？

```
如果只有 Priority Queue（沒有 per-host 限制）：
  假設 nytimes.com 有 100 萬個高權重頁面
  → 系統會連續不斷地爬 nytimes.com
  → 每秒打 1000+ 請求到同一台伺服器 → 被封 IP / 打垮對方

有 Back Queue 後：
  nytimes.com 的所有 URL 進入同一個 FIFO queue
  每次取出一個 URL 後，強制等待 min_delay（1~10 秒）才能再取
  → 實際對 nytimes.com 的 QPS ≤ 1 req/sec
  → 同時可以爬其他上千個 host（並行度來自 host 數量，不是單 host QPS）
```

---

## 4. DNS 解析瓶頸與解法

DNS 查詢 (DNS Lookup) 是爬蟲的隱藏瓶頸。每個新 hostname 都需要 DNS 解析，而標準 DNS 查詢延遲約 10-100ms。

```
問題量化：
  爬取速度目標: 58K pages/sec
  假設 10% 的 URL 是新 hostname → 5.8K DNS lookups/sec
  每次 DNS lookup: ~10ms（最佳情況）
  → 如果同步做 DNS: 需要 5800 × 10ms = 58 秒的 DNS 等待 / 每秒
  → 必須 58 個並發 DNS worker 才能 keep up（同步模式）

解法（三管齊下）：
  1. Local DNS Cache（最有效）：
     → 快取 hostname → IP 的映射，TTL 通常 1 小時
     → 50B 頁面但獨立 hostname ~200M → cache 完全放得進記憶體
     → 200M × (hostname avg 30 bytes + IP 4 bytes + metadata 16 bytes) ≈ 10GB
     → cache hit rate > 95%（因為同一 host 有很多 URL）

  2. Async DNS Resolution：
     → 使用 c-ares 或 libuv 等異步 DNS library
     → Fetcher 不需要 block 等待 DNS 結果
     → 可以同時發出數千個 DNS 查詢

  3. DNS Prefetching：
     → URL Extractor 發現新 hostname 時，立即觸發 DNS prefetch
     → 等 URL 輪到被爬時，DNS 結果已在 cache 中
```

---

## 5. Fetcher：高吞吐下載引擎

### 架構

```
Fetcher Worker Pool（數百到數千個 worker）：
  每個 worker：
    1. 從 URL Frontier 取一個 URL
    2. 查 DNS cache → 取得 IP
    3. 檢查 robots.txt cache → 是否允許爬取
    4. 發送 HTTP GET（帶 If-Modified-Since header 做條件請求）
    5. 處理回應：
       - 200 OK → 傳給 Content Parser
       - 301/302 → 跟隨 redirect（最多 5 次）
       - 304 Not Modified → 跳過，內容沒變
       - 404/5xx → 標記失敗，稍後重試（exponential backoff）
       - robots.txt 禁止 → 跳過
    6. 更新 URL metadata（last_crawl_time, HTTP status, content_hash）
```

### robots.txt 解析

```
robots.txt 範例：
  User-agent: *
  Disallow: /admin/
  Disallow: /private/
  Crawl-delay: 2          ← 每次請求間隔至少 2 秒

  User-agent: Googlebot
  Allow: /admin/public/
  Disallow: /admin/

實作：
  → 每個 domain 的 robots.txt 額外快取（TTL ~24 小時）
  → 爬取任何 URL 前，先查 robots.txt cache
  → 200M domains × ~1KB avg robots.txt = ~200GB → 放 SSD
  → 如果 robots.txt 規定 Crawl-delay: 5 → 覆寫 Back Queue 的 min_delay 為 5 秒

robots.txt 不在 cache 中？
  → 先爬 robots.txt → parse → cache → 再決定是否爬目標 URL
  → 如果 robots.txt 取得失敗（404）→ 假設全部允許（業界慣例）
```

---

## 6. Content Parser 與 URL Extractor

```
Content Parser 流程：
  1. 偵測 Content-Type 和字元編碼（UTF-8, Big5, GB2312 等）
  2. 解析 HTML → 提取純文字（去除 script, style, nav 等非內容區塊）
  3. 提取 metadata：title, meta description, og:tags, canonical URL
  4. 傳給兩個下游：
     a. Content Store：儲存原始 HTML + 提取的純文字 → 供 Indexer 使用
     b. URL Extractor：提取所有超連結

URL Extractor：
  1. 從 HTML 提取所有 <a href="..."> 連結
  2. 正規化 (Canonicalize)：
     - 相對路徑 → 絕對路徑
     - 移除 fragment（#section）
     - 移除追蹤參數（utm_source, sessionid 等）
     - 統一 scheme（http → https）
     - 統一 trailing slash
     - URL decode → re-encode（正規化編碼）
  3. 過濾：
     - 去除非 HTTP/HTTPS 的 URL（mailto:, javascript: 等）
     - 去除明顯的 trap pattern（見 Section 8）
  4. 新 URL 送入 URL Dedup 檢查
```

---

## 7. Deduplication：URL 去重與內容去重

爬蟲面對兩種重複：**URL 重複**（同一 URL 被發現多次）和**內容重複**（不同 URL 指向相同或相似內容）。

### URL 去重：Bloom Filter vs HashSet

| 維度 | Bloom Filter | HashSet (Redis/RocksDB) |
|------|-------------|------------------------|
| 空間 | 極省：50B URLs × 10 bits/element ≈ **60GB** | 50B × 64-byte hash = **3.2TB** |
| 準確度 | 有 False Positive（~1% at 10 bits/element） | **精確**，零誤判 |
| False Positive 後果 | 漏爬一些新 URL → 可接受 | 無此問題 |
| False Negative | **不可能**（已爬過的 URL 一定被識別） | 不可能 |
| 寫入 | O(k) hash 計算，~100ns | O(1) amortized，但涉及網路 I/O |
| 可刪除？ | 標準 Bloom Filter 不可刪除 | 可刪除 |
| 分散式擴展 | 每個 worker 各持有完整副本（60GB 可裝進 RAM） | 需要中心化 Redis cluster 或分片 |

**決策**：URL 去重用 Bloom Filter。False positive 只是偶爾漏爬一個 URL，對 50B 量級的爬蟲可接受。60GB 放記憶體對現代伺服器不是問題。若需要可刪除性，改用 Counting Bloom Filter（Counting Bloom Filter）或 Cuckoo Filter（Cuckoo Filter），空間約增加 3-4 倍。

### 內容去重：精確 vs 近似

```
場景：
  同一篇新聞被 100 個網站轉載，URL 完全不同
  同一商品頁面有 ?color=red 和 ?color=blue 但主體內容 90% 相同
  → URL 去重抓不到這些，必須靠內容去重

三層去重策略：

1. 精確重複 — Content Hash（MD5 / SHA-256）
   → 對提取的純文字做 hash
   → hash 相同 = 完全相同的內容
   → 儲存：50B pages × 32 bytes (SHA-256) = ~1.6TB → 放 RocksDB 或分散式 KV
   → 查詢延遲：< 1ms（SSD random read ~150μs）

2. 近似重複 — SimHash（Simhash）
   → 把文件轉成 64-bit fingerprint
   → 兩個文件的 SimHash Hamming distance ≤ 3 → 視為近似重複
   → 原理：
     a. 對文件中每個 token 做 hash → 64-bit vector
     b. 每個 bit 位：token hash 該位為 1 → +1，為 0 → -1
     c. 累加所有 token 的 vector → 每個維度 > 0 則該 bit = 1，否則 = 0
     d. 最終得到 64-bit fingerprint
   → 近似查詢：用多個排列 (permutation) + 分桶，O(1) 找到 Hamming distance ≤ k 的候選

3. 近似重複 — MinHash + LSH（Locality-Sensitive Hashing）
   → 把文件轉成 shingle set（連續 k 個 word 的集合）
   → 對每個 shingle set 做 N 個 hash function → 取每個 function 的最小值 → 得到 signature
   → 兩個文件的 signature 中相同比例 ≈ Jaccard Similarity
   → 用 LSH band 技術快速找到高相似度候選
   → 適合更細粒度的相似度計算，但計算量比 SimHash 大

實務選擇：
  → 精確重複：MD5/SHA-256（必做，成本低）
  → 近似重複：SimHash（大規模首選，64-bit 節省空間）
  → 需要更精確的相似度時才上 MinHash + LSH
```

---

## 8. Trap 偵測：無限迴圈防護

爬蟲可能掉入「無限 URL 空間」的陷阱：

```
常見 Trap：
  1. 日曆頁面：/calendar?date=2025-01-01 → /calendar?date=2025-01-02 → ...
     → 無限多個合法 URL，但內容無實質價值

  2. Session ID in URL：/page?sessionid=abc123 → 每次訪問產生新 session → 無限 URL
     → URL 正規化時應移除已知 session 參數

  3. 動態查詢組合：/search?q=a&sort=1&page=1 → /search?q=a&sort=2&page=1 → ...
     → 參數排列組合爆炸

  4. Soft 404：回傳 200 但內容是「Page Not Found」→ 爬蟲不知道是 404

防護機制：
  1. Max Depth Limit：從 seed URL 算起，超過 N 層（例如 15 層）就停止
     → 正常有價值的頁面很少超過 10 層

  2. Max Pages per Host：對單一 host 設爬取上限（例如 100K 頁面）
     → 防止單一網站吃掉所有爬取配額

  3. URL Pattern Detection：
     → 如果同一 host 的 URL path 結構高度重複（只有參數不同）→ 降低優先級
     → 用正則或 token 分析檢測：/a/1, /a/2, /a/3, ... → pattern /a/{N}

  4. Content Similarity：
     → 同一 host 連續多個頁面 SimHash 幾乎相同 → 判定為 trap → 停止爬該 pattern

  5. URL Length Limit：超過 2048 字元的 URL → 直接丟棄
```

---

## 9. 分散式爬取架構

單機無法處理 58K pages/sec 的爬取量。需要數千台 worker 協作。

### Worker 分配策略

```
方式：Consistent Hashing by hostname

  URL → hash(hostname) → 分配到某個 worker
  → 同一 hostname 的所有 URL 由同一個 worker 負責
  → 好處：
    1. Politeness 天然保證（單 worker 控制對該 host 的請求速率）
    2. robots.txt cache 不需要跨 worker 共享
    3. DNS cache 的 locality 更好

  Consistent Hashing 用 virtual nodes：
    每個 physical worker 映射到 ~100 個 virtual nodes
    → hostname hash 到最近的 virtual node → 找到 physical worker
    → Worker 故障時，其 virtual nodes 自動分散到相鄰 worker

架構：
  ┌──────────────────────────────────────┐
  │           Coordinator                │
  │  - 維護 worker ring（Consistent Hash）│
  │  - 健康檢查（heartbeat）              │
  │  - Worker 故障時重新分配 URL range     │
  └──────────┬───────────────────────────┘
             │ assign URL ranges
    ┌────────┼────────┐
    ▼        ▼        ▼
  Worker_1  Worker_2  Worker_3 ...（數千台）
  hosts:    hosts:    hosts:
  a*.com    g*.com    m*.com
  b*.com    h*.com    n*.com
  ...       ...       ...

  每個 Worker 內部有自己的：
    - URL Frontier（只含自己負責的 hosts）
    - DNS Cache
    - robots.txt Cache
    - Bloom Filter Partition（或同步 global Bloom Filter）
```

### Worker 故障處理

```
Worker_2 故障：
  1. Coordinator 透過 heartbeat 偵測到（timeout ~30 秒）
  2. 從 Consistent Hash Ring 移除 Worker_2 的 virtual nodes
  3. Worker_2 負責的 hostname 自動分散到相鄰 workers
  4. 這些 worker 開始接收新 URL、重建該 host 的 Frontier queue

未完成的 URL 怎麼辦？
  → URL Frontier 定期 checkpoint 到持久化存儲（例如 Kafka 或 RocksDB）
  → Worker 故障後，新接手的 worker 從 checkpoint 恢復
  → 最壞情況：丟失一些 in-flight URL → 這些 URL 未來會被重新發現（網頁有反向連結）
```

---

## 10. 頁面新鮮度 (Freshness)：重爬策略

網頁內容會變。Crawler 必須決定什麼時候重爬、多頻繁重爬。

```
策略：基於歷史變更頻率的 Adaptive Re-crawl

  每次爬取頁面時：
    if content_hash != last_content_hash:
      mark as "changed"
      reduce re_crawl_interval（更頻繁地重爬）
    else:
      mark as "unchanged"
      increase re_crawl_interval（降低重爬頻率）

  Exponential Backoff：
    初始 re_crawl_interval = 1 天
    每次 unchanged → interval × 2（最高 30 天）
    每次 changed → interval ÷ 2（最低 1 小時）

範例：
  新聞首頁（nytimes.com）：每小時變 → re_crawl_interval 穩定在 ~1 小時
  個人部落格：每月更新一篇 → re_crawl_interval 逐步增長到 ~2 週
  政府法規頁面：幾乎不變 → re_crawl_interval 到 30 天上限

HTTP 條件請求優化：
  爬取時帶上 If-Modified-Since 或 If-None-Match header
  → 伺服器回 304 Not Modified → 不需傳輸 body → 省大量頻寬
  → 5B pages/day 中可能 60%+ 未變 → 節省 ~300TB/day 頻寬
```

---

## 11. Inverted Index 建置：從文件到可搜尋的索引

### Forward Index vs Inverted Index

```
Forward Index（正向索引）：
  doc_1 → ["web", "crawler", "design", "system"]
  doc_2 → ["search", "engine", "design", "index"]
  doc_3 → ["web", "search", "crawler", "engine"]

  → 用途：知道一個文件包含哪些詞
  → 搜尋 "web" → 必須掃描所有文件 → O(N) → 數十億文件不可行

Inverted Index（倒排索引）：
  "web"     → [doc_1 (pos:0), doc_3 (pos:0)]
  "crawler" → [doc_1 (pos:1), doc_3 (pos:2)]
  "design"  → [doc_1 (pos:2), doc_2 (pos:2)]
  "search"  → [doc_2 (pos:0), doc_3 (pos:1)]
  "engine"  → [doc_2 (pos:1), doc_3 (pos:3)]
  "index"   → [doc_2 (pos:3)]

  每個 term 指向一個 Posting List（文件 ID + 出現位置列表）
  → 搜尋 "web" → 直接查 posting list → O(1) lookup + O(K) 遍歷匹配文件
  → K = 包含該 term 的文件數量（遠小於 N）
```

### Indexer 建置流程

```
Indexer Pipeline（MapReduce 或 Spark 批次處理）：

  1. Tokenize：將文件拆成 tokens
     - 分詞（中文用 jieba, 英文用 whitespace + stemming）
     - Lowercasing: "Web" → "web"
     - Stemming: "crawling" → "crawl"
     - Stop word removal: 去除 "the", "is", "a" 等

  2. 建立 Forward Index：
     doc_id → [(term, position), (term, position), ...]

  3. 倒轉（Invert）：
     Mapper: 輸出 (term, doc_id, position) tuples
     Reducer: 按 term group → 建立 posting list
       term → [(doc_1, [pos1, pos3]), (doc_5, [pos2, pos7]), ...]

  4. 壓縮 Posting List：
     - Doc ID 用 delta encoding：[1, 5, 12, 100] → [1, 4, 7, 88]
     - Delta 用 variable-byte encoding（VByte）或 PForDelta 壓縮
     - 壓縮率通常 3-5x → 100PB 未壓縮 → ~20-30PB 壓縮後

  5. 寫入 Index Shard：
     按 doc_id range 或 term range 分片 → 存到 SSTable / 自建格式
```

---

## 12. 搜尋排序：TF-IDF 與 BM25

### TF-IDF 基礎

```
TF (Term Frequency)：一個 term 在文件中出現的頻率
  TF(t, d) = count(t in d) / total_terms(d)

IDF (Inverse Document Frequency)：一個 term 在整個語料庫中的「稀有度」
  IDF(t) = log(N / df(t))
  N = 總文件數, df(t) = 包含 term t 的文件數

TF-IDF(t, d) = TF(t, d) × IDF(t)

直覺：
  "the" 出現在幾乎所有文件 → IDF ≈ 0 → TF-IDF ≈ 0（不重要）
  "kubernetes" 只出現在技術文件 → IDF 高 → TF-IDF 高（區分性強）

問題：
  TF 是線性的 → 一個詞出現 100 次 vs 10 次 → TF 差 10 倍
  → 但「出現 100 次」不代表相關度是「出現 10 次」的 10 倍
  → 需要 diminishing returns（飽和效應）
```

### BM25（Best Matching 25）

```
BM25 改進了 TF-IDF 的兩個問題：

  BM25(t, d) = IDF(t) × [TF(t,d) × (k1 + 1)] / [TF(t,d) + k1 × (1 - b + b × |d|/avgdl)]

  其中：
    k1 = 1.2~2.0（控制 TF 飽和速度）
    b  = 0.75（控制文件長度正規化程度）
    |d| = 文件長度（term 數量）
    avgdl = 語料庫平均文件長度

  兩個改進：
  1. TF 飽和（Saturation）：
     → 分母有 TF + k1 → 當 TF 很大時，分數趨近上限 (k1 + 1)
     → 出現 10 次 vs 100 次的差距被壓縮

  2. 文件長度正規化（Length Normalization）：
     → 長文件天然有更多 term 出現 → TF 偏高
     → b × |d|/avgdl 懲罰長文件、獎勵短文件

  BM25 在幾乎所有 benchmark 上優於 raw TF-IDF：
    → Elasticsearch / Lucene 預設使用 BM25
    → Google 的實際排序遠比 BM25 複雜（加入 PageRank、user signals 等數百個 feature）
```

---

## 13. PageRank：網頁權威度量化

PageRank（佩奇排名）是 Google 最早的核心創新，用連結結構量化網頁的重要性。

```
核心思想：隨機漫步模型 (Random Walk / Random Surfer Model)
  想像一個用戶在網頁間隨機點擊連結：
    - 在頁面 A 上，有 3 個外連結 → 各 1/3 機率跳轉
    - 偶爾（機率 1-d）隨機跳到任何頁面（避免死胡同）
    - d = damping factor（阻尼因子），通常取 0.85

公式：
  PR(A) = (1-d)/N + d × Σ [PR(T) / out_degree(T)]
                        T ∈ pages_linking_to_A

  N = 總頁面數
  out_degree(T) = 頁面 T 的外連結數量

迭代計算（Power Iteration）：
  初始：所有頁面 PR = 1/N
  每輪迭代：
    for each page A:
      PR_new(A) = (1-d)/N + d × Σ [PR_old(T) / out_degree(T)]
  收斂條件：|PR_new - PR_old| < epsilon（通常 50-100 輪收斂）

大規模計算（50B pages）：
  → 用 MapReduce / Spark 實作：
    Mapper: page → (outlink, PR/out_degree)
    Reducer: sum incoming contributions + add damping
  → 50B pages × 8 bytes (float64) = ~400GB PR vector → 放得進記憶體集群
  → 每輪 MapReduce 需要 shuffle 所有 edge → 耗時數小時
  → Google 大約每週或每月重算一次 PageRank
```

---

## 14. Query Processing：從查詢到結果

### 查詢處理流程

```
User query: "distributed web crawler design"
                    │
                    ▼
  ┌─── Query Parser ───┐
  │ 1. Tokenize         │
  │ 2. Stem/Lemmatize   │
  │ 3. Spell correction │
  │ 4. Synonym expansion│
  │ 5. Query rewriting  │
  └────────┬────────────┘
           │ tokens: ["distribut", "web", "crawler", "design"]
           ▼
  ┌─── Posting List Retrieval ──┐
  │ "distribut" → [d2, d15, d99, ...]  │
  │ "web"       → [d1, d2, d3, ...]    │
  │ "crawler"   → [d2, d5, d99, ...]   │
  │ "design"    → [d1, d2, d7, ...]    │
  └────────┬────────────────────┘
           │
           ▼
  ┌─── Intersection / Union ──┐
  │ AND query: 取交集           │
  │ d2 出現在所有 posting list  │
  │ → candidate set = [d2, ...] │
  │                             │
  │ 優化：先處理最短 posting list │
  │ → "crawler" list 最短 → 先讀 │
  │ → skip pointer 跳過不匹配的 │
  └────────┬────────────────────┘
           │ candidate documents
           ▼
  ┌─── Scorer / Ranker ──────┐
  │ score(d) = BM25_score     │
  │          + PageRank(d)    │
  │          + freshness(d)   │
  │          + click_rate(d)  │
  │          + proximity(d)   │
  │          + ...            │
  │                           │
  │ 用 Top-K heap 只保留前 K 個 │
  └────────┬──────────────────┘
           │ top K results
           ▼
        Response
```

### Posting List 交集的加速技巧

```
Skip Pointer（跳表指標）：
  Posting list: [3, 5, 12, 25, 37, 48, 62, 89, 103, ...]

  每隔 √n 個 element 放一個 skip pointer：
  [3, 5, 12, →25, 37, 48, →62, 89, 103, →...]

  交集時若當前目標 > 下一個 skip pointer 指向的值 → 直接跳過
  → 平均從 O(n) 降到 O(√n)

  Lucene 的實作更激進：多層 skip list → 接近 O(log n)
```

### 分層索引 (Tiered Index)

```
問題：100PB 的 index 不可能全放記憶體。
解法：分層存儲，按「使用頻率」分級。

Tier 0 (Hot) — Memory：
  → Top 10% 高頻查詢的 posting list（"facebook", "youtube", "weather"）
  → 加上高 PageRank 頁面的 posting → ~100TB → 分散在數千台機器的 RAM

Tier 1 (Warm) — SSD：
  → 中頻 term 的 posting list
  → SSD random read ~150μs → 可以在 10ms 內完成查詢
  → ~1-5PB

Tier 2 (Cold) — HDD：
  → 罕見 term 的 posting list
  → HDD random read ~10ms → 查詢延遲較高
  → 但這些查詢佔比 < 5%
  → 完整 index 在此層

查詢路由：
  1. 先查 Tier 0 cache → hit → 直接回應（< 5ms）
  2. Miss → 查 Tier 1 SSD index（< 50ms）
  3. 極罕見情況 → fall through 到 Tier 2（< 200ms）
```

---

## 15. Index Sharding 策略

### 按文件分片 (Document-based Sharding) vs 按詞彙分片 (Term-based Sharding)

| 維度 | Document-based | Term-based |
|------|---------------|------------|
| 分片方式 | 每個 shard 包含一部分文件的完整 index | 每個 shard 包含一部分 term 的完整 posting list |
| 查詢流程 | Scatter-gather：query 廣播到所有 shard → 每個 shard 回傳 local top-K → merge | Pipeline：query 只送到包含該 term 的 shard → 直接取 posting list |
| 延遲 | 受最慢 shard 影響（tail latency） | 單 term 查詢快，但 multi-term 查詢需跨 shard |
| 負載均衡 | 自然均衡（每個 shard 文件數相近） | 不均衡（"the" 的 posting list 比 "kubernetes" 大 1000 倍） |
| 索引更新 | 只需更新該文件所在的 shard | 一個文件包含 N 個 term → 需更新 N 個 shard |
| 容錯 | 一個 shard 掛了 → 只影響部分文件的結果 | 一個 shard 掛了 → 某些 term 完全搜不到 |

**業界選擇：Document-based Sharding**（Google, Elasticsearch, Solr 皆如此）
- 原因：Multi-term query 佔多數，document-based 讓每個 shard 可以獨立算出 local top-K
- Term-based 的 multi-term 查詢需要跨 shard 做 posting list intersection，網路開銷大
- Document-based 更好做 replication（每個 shard 獨立 replicate）

```
典型 Search Cluster：
  50B documents / 10000 shards = 5M docs per shard
  每個 shard: ~10GB index（壓縮後）
  每個 shard 配 3 個 replica → 30000 個 index 節點
  Query 進入 → 廣播到 10000 個 shard（或 shard 的任一 replica）
  → 每個 shard 回傳 top-10 → coordinator merge → 回傳最終 top-10
  → 延遲：~50-200ms（含網路 + 計算）
```

---

## 16. 容量估算

| 指標 | 估算 |
|------|------|
| 已知網頁總數 | ~50B pages |
| 每日爬取量 | 5B pages → **~58K pages/sec** |
| 平均 HTML 大小 | ~100KB |
| 每日下載量（HTML） | 5B × 100KB = **~500TB/day** |
| Content Store（累積） | 50B × 100KB = **~5PB**（壓縮後 ~1-2PB） |
| URL Dedup Bloom Filter | 50B URLs × 10 bits = **~60GB RAM** |
| Content Hash Store | 50B × 32B (SHA-256) = **~1.6TB** (SSD) |
| DNS Cache | 200M hostnames × 50B = **~10GB RAM** |
| robots.txt Cache | 200M × 1KB = **~200GB** (SSD) |
| Inverted Index（壓縮後） | **~20-30PB** |
| PageRank Vector | 50B × 8B = **~400GB** |
| Search QPS | **~100K queries/sec** |
| Crawler Worker 數量 | 58K pages/sec ÷ ~50 pages/sec/worker = **~1200 workers** |
| Index Shard 數量 | 50B docs / 5M per shard = **~10000 shards** |
| Index 節點（含 replica） | 10000 × 3 = **~30000 nodes** |

---

## 17. 關鍵 Trade-off 總結

| 設計決策 | 選擇 | 原因 |
|---------|------|------|
| URL 去重 | **Bloom Filter** | 50B URLs 只需 60GB；false positive 只是漏爬，可接受 |
| 內容去重 | **SHA-256 + SimHash 雙層** | 精確 hash 抓完全重複（成本低），SimHash 抓近似重複 |
| Frontier 架構 | **雙層佇列（Priority + Politeness）** | 單層無法同時滿足「爬重要的」和「不打爆伺服器」 |
| Worker 分配 | **Consistent Hashing by hostname** | 同 host URL 歸同一 worker → 天然 politeness + cache locality |
| 重爬策略 | **Adaptive（exponential backoff on unchanged）** | 新聞站 1hr 重爬、靜態站 30 天重爬，資源分配最優 |
| DNS 解析 | **Local cache + async + prefetch** | 消除 DNS 在 critical path 上的延遲瓶頸 |
| Index 分片 | **Document-based sharding** | Multi-term query 友好，每 shard 獨立計算 local top-K |
| 排序演算法 | **BM25 + PageRank + 多維 signal** | BM25 解決文字相關度，PageRank 解決頁面權威度 |
| Index 存儲 | **Tiered（Memory / SSD / HDD）** | 熱門 term 在 RAM（< 5ms），冷門 term 在 HDD（< 200ms） |
| Trap 防護 | **多層（depth limit + pattern detection + content similarity）** | 單一機制無法覆蓋所有 trap 類型 |

---

## 18. 面試常見 Follow-up

### Q: 如果要爬 JavaScript 渲染的 SPA 頁面怎麼辦？

```
問題：現代網站（React, Vue, Angular）的內容靠 JavaScript 渲染
  → HTTP GET 只拿到空的 <div id="root"></div>
  → 沒有實際內容可以 index

解法：Headless Browser Rendering
  → 用 headless Chrome（Puppeteer / Playwright）執行 JavaScript
  → 等待 DOM 穩定 → 提取渲染後的 HTML

代價：
  → 標準 HTTP fetch: ~200ms, ~1MB memory per request
  → Headless Chrome render: ~2-5s, ~200MB memory per request
  → 資源消耗增加 ~100x

策略：
  → 只對「需要 JS 渲染」的網站使用 headless render
  → 判斷方法：先做標準 fetch → 如果 body < 5KB 且含 <script> → 改用 headless
  → Google 實際做法：第一波標準 fetch → 第二波 rendering queue 慢慢處理
```

### Q: 如何處理多語言內容？

```
挑戰：
  → 中文沒有空格分隔 → 需要分詞（jieba, ICU tokenizer）
  → 日文有三套字符（漢字、平假名、片假名）→ 分詞更複雜
  → 阿拉伯文從右到左、有連字形 → tokenizer 需要特殊處理

解法：
  → Language Detection：用 CLD2 或 fastText 偵測語言
  → Per-language Tokenizer：每種語言用專屬 tokenizer
  → Index 可以按語言分區（query 時只搜對應語言的 partition）
  → 跨語言搜尋：用 multilingual embedding（BERT-based）做語意匹配
```

### Q: 如何做 incremental indexing 而非全量重建？

```
全量重建（Batch Reindex）：
  → 每天跑一次 MapReduce → 從 Content Store 重建完整 index
  → 延遲：新內容要等 ~24 小時才能被搜到

增量索引（Incremental Indexing）：
  → Crawler 每爬到一個新/更新頁面 → 立即送到 Indexer
  → Indexer 更新 inverted index 的對應 posting list
  → Near Real-Time（NRT）：新內容 ~1-5 分鐘內可搜尋

實作（Lucene / Elasticsearch 的做法）：
  → 寫入先進 in-memory buffer → 每秒 flush 成新的 segment（小的 SSTable）
  → 小 segment 定期 merge 成大 segment（compaction）
  → 搜尋時同時查所有 segment → merge results
  → 這就是 LSM-Tree 的思想應用在 inverted index 上

Trade-off：
  → Batch: 索引品質高（全局最優壓縮），但延遲高
  → Incremental: 即時性好，但小 segment 多 → merge overhead + 查詢需掃多段
  → 現代系統（Google, Bing）：兩者結合
    → Real-time tier: 增量索引處理最新內容
    → Base tier: 定期全量重建最優化索引
    → Query 時合併兩層結果
```

### Q: 爬蟲如何避免被封 IP？

```
對方網站可能的防禦：
  → IP rate limiting
  → User-Agent 黑名單
  → CAPTCHA
  → Honeypot 頁面（人看不到但爬蟲會跟的隱藏連結）

爬蟲端的對策：
  1. 嚴格遵守 robots.txt 和 Crawl-delay
  2. 合理的 User-Agent string（標明爬蟲身份）
  3. IP rotation：使用大量出口 IP（Google 的爬蟲用大量 IP 段）
  4. 控制速率：per-host ≤ 1 req/sec（已在 Back Queue 實現）
  5. 不爬 honeypot：只爬 HTML 中可見的連結（避免 display:none 的 <a>）
```

---

## 19. 面試策略：講述順序建議

1. **需求釐清 + 規模估算**（2 分鐘）— 要爬多少頁、多快、搜尋 QPS、延遲要求
2. **Crawler 高層架構**（2 分鐘）— 畫出 Frontier → Fetcher → Parser → Dedup → back to Frontier 的迴圈，強調這是一個持續運作的 pipeline
3. **URL Frontier 雙層佇列（核心）**（3 分鐘）— 先講為什麼需要 Politeness，再講 Priority + Back Queue 的設計，這是 Crawler 最有區分度的元件
4. **去重策略**（2 分鐘）— URL 用 Bloom Filter（省空間）、Content 用 SHA-256 + SimHash（精確 + 近似）
5. **分散式架構**（2 分鐘）— Consistent Hashing by hostname、worker 故障處理
6. **Search Engine 索引**（3 分鐘）— Inverted Index 結構、BM25 排序、Document-based sharding
7. **PageRank 概念**（1 分鐘）— Random Surfer Model、damping factor、迭代計算
8. **Deep Dive（面試官選）**（2 分鐘）— Trap detection、freshness、JS rendering、incremental indexing
