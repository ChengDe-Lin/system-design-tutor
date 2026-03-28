# URL Shortener (bit.ly) — 短網址系統架構

## 1. 核心特性

```
Read:Write ratio = 100:1 ~ 1000:1（大量點擊，少量建立）
資料一旦建立幾乎不變 → 極度適合 cache
查詢模式極簡單：GET(short_key) → long_url（純 key-value lookup）
```

---

## 2. 整體架構

```
                         CDN（cache redirect response）
                          │
                     ┌────┴─────┐
User ──▶ LB ──▶     │  API GW   │
                     └────┬──────┘
                          │
            ┌─────────────┼──────────────┐
            ▼                            ▼
  URL Create Service              URL Redirect Service
  (Write path, 少量 pods)         (Read path, 大量 pods)
       │                              │
       ▼                              ▼
  Primary DB ◀── replication ──▶ Read Replicas + Cache
       │
       ▼
  KGS (Key Generation Service)
  or DB counter
```

### 為什麼 Read/Write 拆成獨立 Service？

Read:Write ratio > 100:1 → **分開 scale 避免浪費資源**：

| | URL Create Service (Write) | URL Redirect Service (Read) |
|---|---|---|
| QPS | ~1K | ~100K |
| Pod 數量 | 5 個 | 50 個 |
| DB 連線 | Primary DB only | Read Replicas + Cache |
| 依賴 | KGS / hash 生成、collision 處理 | Redis/Memcached、CDN origin |

好處：
- **Primary DB connection pool 不被 read 佔滿** — primary 只服務 5 個 write pods = ~50 connections，而非 55 個 pods = ~550 connections
- **獨立 scale** — read 流量暴增時只加 read pods，不連帶 scale write 的資源
- **Failure isolation** — read service 掛了不影響建立短網址，反之亦然

---

## 3. CDN 加速（Read-Heavy 系統第一步）

短網址一旦建立幾乎不會改 → 非常適合 CDN cache。

```
Without CDN：
  Client → LB → Read Service → DB/Cache → 302 redirect
  延遲：50-100ms

With CDN：
  Client → CDN edge（cache hit）→ 302 redirect
  延遲：< 5ms，origin 完全不被打到
```

### CDN + Analytics 不衝突

```
方案 1（主流）：CDN cache + edge log 回傳
  CDN cache 了 302 redirect，直接回給 client
  同時寫 access log → 批次回傳 analytics pipeline（Kinesis / Kafka）
  → 你照樣有完整的點擊數據（延遲秒~分鐘級）

方案 2：CDN 只做 edge routing，不 cache
  每次請求都回 origin → origin 即時記錄 analytics
  CDN 價值 = 就近接入（用戶連到附近 edge node，降低跨區延遲）
  → TCP/TLS 握手在 edge 完成，CDN 用骨幹專線連 origin，比公網快

面試推薦講方案 1 — 效果最大。
```

---

## 4. Redirect Status Code：301 vs 302

| Code | 名稱 | 語意 | 瀏覽器行為 |
|------|------|------|-----------|
| **301** | Moved Permanently | 永久搬走 | **瀏覽器 cache**，下次直接跳，不再問 server |
| **302** | Found (Moved Temporarily) | 這次先去這裡 | **不 cache**，每次都打 server |

### URL Shortener 選哪個？

```
要做點擊 analytics？ → 302（每次經過 server，記錄點擊）
不需要 analytics，只要快？ → 301（瀏覽器 cache 後不再打你）

bit.ly 商業模式 = 賣 analytics → 用 302
```

**面試時兩個都講，說明 trade-off。**

---

## 5. 短網址生成策略（核心設計決策）

### 方案 1：Hash 取前 N 位

```
hash("https://example.com/very/long/url")
  → MD5 = "d41d8cd98f00b204e9800998ecf8427e"
  → 取前 7 位 → base62 encode → "kF3x9aB"

✗ 有 collision（不同 URL 前 7 位可能一樣）
✗ Collision 處理：append salt 重新 hash → write latency 不穩定
✓ 相同 URL 會得到相同短網址（天然去重）
```

### 方案 2：Auto-increment ID + Base62

```
DB auto-increment ID = 1000000
  → base62(1000000) = "4c92"

62 字元 = [0-9][a-z][A-Z]
7 位 base62 = 62^7 = 3.5 兆個 URL

✓ 保證不 collision
✓ 生成快
✗ ID 可預測（知道 4c92 可猜 4c93）→ 如果在意可用 Snowflake-like ID
✗ 分散式環境下 auto-increment 需要協調
```

### 方案 3：預分配號碼段（KGS）← 推薦

```
KGS (Key Generation Service) + DB counter：
  DB 存一個 counter（persistent，不用 Redis）
  KGS 分配號碼段給 write service pods

Flow：
  1. Write Pod 啟動 → 向 KGS 要 10K 個號碼
     KGS: UPDATE counter SET next = next + 10000 RETURNING next - 10000 AS start
     → 回傳 { start: 10001, end: 20000 }

  2. Pod 把 10001-20000 存在 local memory buffer

  3. 處理請求時從 buffer 取號碼 → base62 encode → 寫入 URL DB

  4. 用到 50%（5000 個）時 → 背景 prefetch 下一段 20001-30000
     → 永遠手上有至少 5000 個號碼可用

✓ Zero collision（號碼段不重疊）
✓ Write path 極快（local memory 取號碼，不打 DB）
✓ KGS 的 QPS 極低（100 個 pods × 每小時 1 次 = 100 req/hour）
```

### 為什麼 KGS 用 DB 而非 Redis？

```
Redis counter：
  ✗ 重啟可能丟資料 → 發出重複號碼段 → 短網址 collision
  ✗ AOF everysec 有 1 秒 gap，collision 後果嚴重（兩個 URL 同一個 key）

DB counter（PostgreSQL / MySQL）：
  ✓ 持久化保證 — 不會發重複號碼
  ✓ 一次 UPDATE ... RETURNING 就是 atomic operation
  ✓ QPS 極低（每小時 ~100 次），DB 完全無壓力

原則：counter 的正確性 >> counter 的速度。
      而這個 counter 的 QPS 本來就極低，用 DB 沒有效能問題。
```

### Pod 死掉浪費號碼？

```
Pod 拿了 10001-20000，用到 15000 就死了
  → 15001-20000 這 5000 個號碼浪費了

嚴重嗎？
  7 位 base62 = 3.5 兆個號碼
  每次死掉浪費 5000 個
  每天死 100 次 = 浪費 50 萬/天
  → 19,000 年才會用完

完全不需要回收。浪費掉就浪費掉。
```

---

## 6. DB 選型

```
查詢模式：
  Write: PUT(short_key, long_url, created_at, expires_at, user_id)
  Read:  GET(short_key) → long_url

純 key-value lookup → 不需要 JOIN、aggregation
```

| DB | 適合度 | 原因 |
|-----|--------|------|
| **DynamoDB** | **最適合** | 天然 key-value、auto-scale、managed、single-digit ms latency |
| Cassandra | 適合 | Key-value、write-heavy 也行、可自建 |
| Redis + persistence | 小規模可以 | 全量放記憶體，資料量大時成本高 |
| PostgreSQL / MySQL | 可以但 overkill | 付了 relational DB 的代價，沒用到 JOIN/transaction |

---

## 7. Hot URL 處理（病毒式傳播）

```
某個短網址突然爆紅 → 單一 key 被打 100K+ QPS

即使有 read replicas，同一個 key 的查詢全部落在同一個 shard → hot partition

解法（多層 cache）：
  Layer 1: CDN — 同一個 URL = 同一個 cache key，CDN 直接擋
  Layer 2: Local cache — 每個 read pod 記憶體內 cache（LRU, 幾百 MB）
  Layer 3: Redis / Memcached — distributed cache
  Layer 4: DB（幾乎不會被打到）

CDN + local cache 已經能擋住 99.9% 的 hot URL 流量。
```

---

## 8. 過期與清理

```
免費用戶：短網址 1 年後過期
付費用戶：永不過期

方案 A（推薦）：DB 欄位 expires_at + lazy check
  → Read 時檢查 expires_at，過期就回 404
  → 背景 cleanup job 定期刪除過期 records、回收 key
  → 最簡單，read path 只多一個 timestamp 比較

方案 B：DynamoDB TTL
  → 設定 TTL attribute，DynamoDB 自動刪除過期 items
  → 零維運成本

方案 C：Redis TTL（如果用 Redis 當 cache）
  → cache 自動過期，miss 時查 DB 確認是否真的過期
```

---

## 9. 資料模型

```
URL Table (primary store):
  short_key    VARCHAR(7)   PRIMARY KEY   -- base62 encoded
  long_url     TEXT         NOT NULL
  user_id      BIGINT                     -- 建立者
  created_at   TIMESTAMP
  expires_at   TIMESTAMP                  -- NULL = 永不過期
  click_count  BIGINT       DEFAULT 0     -- 非即時，定期從 analytics 回寫

Analytics Table (append-only, 寫入 data warehouse):
  short_key    VARCHAR(7)
  clicked_at   TIMESTAMP
  ip           VARCHAR(45)
  user_agent   TEXT
  referer      TEXT
  country      VARCHAR(2)                 -- 從 IP 解析
```

---

## 10. 容量估算

假設規模類似 bit.ly：

| 指標 | 估算 |
|------|------|
| 每日新建短網址 | ~1M |
| Write QPS | 1M / 86400 ≈ **~12/sec**（很低） |
| Read:Write ratio | 100:1 |
| Read QPS | ~1200/sec（日常），spike 時 ~100K/sec |
| 每筆 URL 資料量 | ~500 bytes（key + URL + metadata） |
| 每日儲存增量 | 1M × 500B = **500MB/day** |
| 5 年儲存 | ~900GB（不大，單一 DB 可以扛） |
| 5 年 URL 總數 | ~1.8B → 7 位 base62（3.5T 容量）綽綽有餘 |

---

## 11. 整體架構圖

```
                              CDN
                          (cache 302 redirect)
                               │
┌──────────┐              ┌────┴─────┐              ┌──────────────┐
│ Client   │──create───▶  │  API GW   │──read────▶   │ URL Redirect │
│          │              │ + Rate    │              │ Service      │
│          │──click────▶  │  Limiter  │              │ (50 pods)    │
└──────────┘              └────┬─────┘              └──────┬───────┘
                               │                           │
                          ┌────┴──────┐              ┌─────┴────────┐
                          │URL Create │              │ Read Replicas│
                          │Service    │              │ + Redis Cache│
                          │(5 pods)   │              └──────────────┘
                          └────┬──────┘
                               │
                    ┌──────────┼───────────┐
                    ▼          ▼           ▼
              Primary DB   KGS/Counter  Analytics Pipeline
              (write)      (號碼段分配)   (Kafka → Data Warehouse)
```

---

## 12. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（1 分鐘）— read:write ratio、QPS、5 年儲存量
2. **短網址生成策略**（3 分鐘）— 比較 hash vs auto-increment vs KGS，推薦 KGS，解釋號碼段預分配 + 為什麼用 DB 不用 Redis
3. **Read/Write 拆 Service**（1 分鐘）— 根據 ratio 分開 scale，write → primary，read → replicas + cache
4. **CDN + Cache 多層加速**（2 分鐘）— CDN cache redirect、local cache、Redis、hot URL 處理
5. **301 vs 302 + Analytics**（1 分鐘）— trade-off 說明
6. **DB 選型 + 過期清理**（1 分鐘）— key-value store、TTL 或 lazy check
