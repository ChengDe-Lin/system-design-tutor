# Redis Autocomplete — 機制、實做與 Trade-off

> **核心釐清**：Redis 沒有內建 `AUTOCOMPLETE` 指令，也**不用 trie**。所謂「Redis 做 autocomplete」是一個 design pattern，主要靠 **Sorted Set + ZRANGEBYLEX** 的字典序範圍掃描。真正的 trie 在 RedisSearch module 的 FT.SUGGEST 才有。

## TL;DR

| 方案 | 底層資料結構 | 記憶體 | 延遲 | 適用 |
|------|-------------|--------|------|------|
| **ZRANGEBYLEX (Antirez recommended)** | Sorted Set (Skiplist) | 中（每 prefix 存一次） | O(log N + M) ~亞毫秒 | 100 萬 term 內，標準 Redis |
| **Sorted Set per Prefix** | 多個 Sorted Set | 高（每 term × prefix length 倍） | O(log N + 10) | 簡單但記憶體浪費 |
| **FT.SUGGEST (RedisSearch module)** | **Compact Trie (Radix Tree)** | 低（trie 共享 prefix） | O(L) | 有 module 環境，需 fuzzy 支援 |
| **Elasticsearch Completion Suggester** | **FST (Finite State Transducer)** | 最低 | sub-ms | 億級 term，需 fuzzy / 多 index |

→ 標準 Redis 預設用方案 1。**「prefix match 用 trie」是 ES / RedisSearch / 自建系統，不是 Redis core**。

## 方案 1：ZRANGEBYLEX (字典序範圍掃描)

### 原理

關鍵 insight：**「以 X 為 prefix 的所有字串」在字典序上是連續的一段 range**。
```
字典序排列：
  hef
  hel        ← prefix "hel" 的起點
  hell
  hello
  helmet
  help
  hen        ← 'n' > 'l'，超出 prefix "hel" 範圍
```
→ Prefix match = 找一段連續區間 → Sorted Set 的 skiplist 用 binary search O(log N)。

### 資料結構

把每個 term 的**所有 prefix** 都當 member 寫進同一個 sorted set，**score = 0**：

```
ZADD autocomplete 0 "h*"
ZADD autocomplete 0 "he*"
ZADD autocomplete 0 "hel*"
ZADD autocomplete 0 "hell*"
ZADD autocomplete 0 "hello"        ← 沒有 * = 完整 term
ZADD autocomplete 0 "hello world"
ZADD autocomplete 0 "help"
ZADD autocomplete 0 "helmet"
```

`*` 是慣例約定的 prefix marker（用來區分「這只是 prefix」和「這是完整 term」），沒有 Redis 語法意義。

### 查詢

User 打 `"hel"`：

```
ZRANGEBYLEX autocomplete "[hel" "[hel\xff" LIMIT 0 50
```

- `[hel` = inclusive 起點 `"hel"`
- `[hel\xff` = inclusive 終點 `"hel" + 0xFF`（最大字元，保證涵蓋所有 hel-開頭）
- LIMIT 50 = 最多回 50 候選

→ 結果含 `hel*, hell*, hello, hello world, help, helmet`，filter 掉帶 `*` 的就是完整 term。

### 加上熱度排序（業界實做）

ZRANGEBYLEX 依賴 score=0，沒辦法直接做熱度 ranking。標準解法是**雙 sorted set**：

```
# Set 1: prefix index (score=0)
ZADD ac:terms 0 "h*" 0 "he*" 0 "hel*" 0 "hello" 0 "help" 0 "helmet"

# Set 2: popularity (score = 搜尋次數)
ZADD ac:pop 1500 "hello" 800 "help" 50 "helmet"
```

查詢流程：
```python
def autocomplete(prefix):
    # 1. ZRANGEBYLEX 找候選 (字典序)
    candidates = redis.zrangebylex(
        'ac:terms', f'[{prefix}', f'[{prefix}\xff', start=0, num=50
    )
    candidates = [c for c in candidates if not c.endswith('*')]

    # 2. 對每個候選查熱度
    scores = redis.zmscore('ac:pop', candidates)

    # 3. 排序回 top 10
    ranked = sorted(zip(candidates, scores), key=lambda x: -x[1])
    return [term for term, _ in ranked[:10]]
```

延遲分析（10M term）：
- ZRANGEBYLEX: log₂(10M) ≈ 23 次比較 + 50 個 entry 掃描 ≈ ~100 µs
- 50 次 ZMSCORE: ~500 µs（pipeline 可降到 ~50 µs）
- **總 ~150 µs，亞毫秒**

### 記憶體成本

每個 term 寫入 (term 平均長度) 個 prefix entry。例如平均 8 字 → 100 萬 term 寫 800 萬 entry。
- Sorted set entry ≈ 100 bytes（含 skiplist 指標）
- 800 萬 entry × 100 bytes = 800 MB
- 加 popularity set 1 億 bytes
- → 100 萬 term 大約 **1 GB RAM**

→ Redis 單節點 RAM 上限 ~64 GB → 約能裝 6000 萬 term。再多就需要 sharding by prefix（前 2 字 hash）或換 ES。

## 方案 2：Sorted Set per Prefix

每個 prefix 當獨立 key，存「該 prefix 開頭的所有完整 term + 熱度」：

```
ZADD ac:h    1500 "hello"  800 "help"  50 "helmet"  ...
ZADD ac:he   1500 "hello"  800 "help"  50 "helmet"
ZADD ac:hel  1500 "hello"  800 "help"  50 "helmet"
ZADD ac:hell 1500 "hello"
ZADD ac:help 800  "help"
```

查詢直接 `ZREVRANGE ac:hel 0 9 WITHSCORES` → 一發拿 top 10 by 熱度，O(log N + 10)。

**優點**：實作極簡單，查詢快。
**缺點**：每個 term 被複製進它的所有 prefix。`"hello"` (5 字) 進 5 個 set，記憶體 ~5x。100 萬 term 平均 8 字 → ~5-8 GB。

→ 中小型應用 (10 萬 term 內) 用這個最簡單；大規模就改方案 1 或 ES。

## 方案 3：RedisSearch FT.SUGGEST

Redis 7 之後的 [RedisSearch module](https://redis.io/docs/latest/commands/ft.sugadd/) 提供原生 autocomplete，**內部用 Compact Trie (Patricia Trie / Radix Tree)**。

```
FT.SUGADD autocomplete "hello" 1500
FT.SUGADD autocomplete "help"  800
FT.SUGGET autocomplete "hel" FUZZY MAX 10 WITHSCORES
```

→ 支援 fuzzy match（Levenshtein distance ≤ 1），記憶體比方案 1 小 ~5x。

⚠️ **限制**：RedisSearch 是 module，不是 Redis core。AWS ElastiCache、雲端 managed Redis 不一定有；自建可裝。**面試說 Redis autocomplete 預設不要假設有 module**。

## 為什麼 Redis core 不用 trie？

1. **Redis 的 mental model 是 KV access**：所有 data structure 圍繞 `key → value` 取用，trie 的「沿著字元 traverse」不符合這個 pattern
2. **Trie 記憶體開銷大**：naive trie 每節點存指標 + char，比 sorted skiplist 多 3-5x；Patricia Trie 有改善但仍然複雜
3. **Skiplist 已經夠快**：`O(log N)` 對 100 萬 term 只要 20 次比較，跟 trie 的 `O(L)` 在實務上差距很小（L = prefix 長度通常 5-10）
4. **Skiplist 容易序列化**：AOF / RDB 寫入是線性掃描，trie 要 DFS
5. **Sorted set 是萬用**：同一個資料結構也能做 leaderboard、time-series、rate limiter

## 真正用 trie 的 autocomplete 系統

| 系統 | 底層 | 特性 |
|------|------|------|
| **RedisSearch FT.SUGGEST** | Compact Trie | Redis module |
| **Elasticsearch Completion Suggester** | **FST (Finite State Transducer)** | trie 的壓縮進化版，可表示無限語言 |
| **Apache Solr Suggester** | FST | 跟 ES 同源 |
| **PostgreSQL `pg_trgm`** | GiST/GIN index 的 trigram | 不是純 trie，但類似前綴 / fuzzy 加速 |
| **Google Search Autocomplete** | 自製分散式 trie + ML ranking | 個人化、多語言、real-time learning |

### FST 為什麼比 trie 強

```
Trie:           FST (= 共享 prefix + 共享 suffix):
                                                                     ┌─→ "ing"
  "running"     "running"  ─┐                                        │
  "runs"        "runs"     ─┤  prefix 共享 "run"  +  suffix 共享 "ing"
  "ringing"     "ringing"  ─┘
```

→ FST 可以做到 ~ N log L 的記憶體（N=term 數、L=平均長度），比 trie 小 5-10x。**ES 處理億級 term 就是靠這個**。

## 設計選型 Decision Tree

```
有多少 term？
├── < 10 萬 → Sorted Set per Prefix (方案 2，最簡單)
├── 10 萬 ~ 1000 萬 → ZRANGEBYLEX (方案 1，Antirez 推薦)
├── 1000 萬 ~ 1 億 → Redis Cluster shard by prefix prefix 前 2 字 hash
└── > 1 億 → Elasticsearch Completion Suggester

需要什麼功能？
├── 純 prefix match → 任何方案都行
├── 熱度排序 → 方案 1 雙 set / 方案 2 直接內建 / 方案 3 內建
├── Fuzzy match (typo tolerance) → 必須 ES 或 RedisSearch FT.SUGGEST
├── 個人化排序 → 後端取候選 → 上 ML model rerank
└── 多語言 / 中日韓分詞 → 必須 ES (含 ICU analyzer)
```

## 容量估算 anchor (per-node Redis)

| 工作量 | ZRANGEBYLEX 延遲 | 記憶體 |
|--------|-----------------|--------|
| 10 萬 term | ~50 µs | ~80 MB |
| 100 萬 term | ~100 µs | ~1 GB |
| 1000 萬 term | ~150 µs | ~10 GB |
| 1 億 term | 需要 sharding | ~100 GB（單機不夠） |

QPS 上限：單節點 Redis ~100K 簡單 ZRANGEBYLEX/sec（複合查詢含 ZMSCORE 降到 ~30K）。要更高用 read replica fan-out。

## 常見坑

1. **以為 Redis autocomplete 用 trie** → 是 Sorted Set 的 lexicographical scan，完全不同
2. **忘記寫所有 prefix** → 只寫完整 term，ZRANGEBYLEX 找不到 (ZRANGEBYLEX 是字串字典序 range，不是「以 X 開頭」的內建語法)
3. **用 score 排熱度但 ZRANGEBYLEX 假設 score=0** → 必須拆雙 set
4. **大小寫敏感** → 寫入前統一 lowercase，否則 "Hello" 和 "hello" 算兩個 entry
5. **Unicode / 中文 prefix** → ZRANGEBYLEX 是 byte-level lexicographical，UTF-8 中文字 byte 序就是字典序，可以直接用；但「分詞 autocomplete」(輸入「北京」找到「北京烤鴨」) 需要分詞器，Redis 做不到，要 ES
6. **熱門更新沒同步寫 popularity set** → 候選找對但排序不準

## 一句話總結

> **Redis 做 autocomplete 是用 Sorted Set 的 ZRANGEBYLEX 在字典序連續區間做 binary search，O(log N + M)，不是 trie。**
>
> Prefix match 在 Redis 的本質是「字典序 range scan」這個演算法觀察，不是資料結構創新。
>
> 真正用 trie / FST 的是 RedisSearch FT.SUGGEST、Elasticsearch Completion Suggester、自建系統。
