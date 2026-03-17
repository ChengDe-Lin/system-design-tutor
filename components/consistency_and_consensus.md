# Consistency Models, Consensus Algorithms 與分散式系統基礎

---

## 1. Consistency Models Spectrum（一致性模型光譜）

在分散式系統中，一致性模型定義了「當多個節點持有相同資料的副本時，客戶端能觀察到什麼樣的行為保證」。這不是一個非黑即白的選擇，而是一道光譜——從最強的 linearizability 到最弱的 eventual consistency，每個模型都在 **正確性** 與 **效能/可用性** 之間做出不同的取捨。

### 模型總覽表

| 模型 | 保證強度 | 核心保證 | 延遲代價 | 可用性 | 典型應用 |
|------|---------|---------|---------|--------|---------|
| **Linearizability** | 最強 | 每次讀取都回傳最近一次寫入的值，且操作順序符合真實時間順序 | 高 | 低（需要同步協調） | 分散式鎖、leader election |
| **Sequential Consistency** | 強 | 所有節點看到相同的操作順序，但該順序不必與真實時間一致 | 中高 | 中低 | 多處理器記憶體模型 |
| **Causal Consistency** | 中 | 有因果關係的操作保證順序；並行操作可以以任意順序出現 | 中 | 中 | 協作編輯、社群媒體動態 |
| **Eventual Consistency** | 弱 | 如果停止寫入，所有副本最終會收斂到相同狀態 | 低 | 高 | DNS、CDN 快取 |
| **Read-your-writes** | Session 級 | 客戶端一定能看到自己之前的寫入 | 低 | 高 | 使用者個人資料更新 |
| **Monotonic Reads** | Session 級 | 客戶端一旦看到某個值，就不會再看到更舊的值 | 低 | 高 | 時間線瀏覽 |

### 各模型深入解析

#### Linearizability（線性一致性 / Strong Consistency）

Linearizability 是分散式系統中最強的一致性保證。它的精確定義是：**每個操作都看起來像是在其調用（invocation）與回應（response）之間的某個瞬間原子地生效**。換言之，即使資料分散在多個節點上，整個系統表現得就像只有一個副本，且所有操作都按照真實時間順序排列。

這意味著：
- 如果寫入 W 在讀取 R 開始之前完成，R **必須** 看到 W 的結果（或更新的值）。
- 不會出現「時光倒流」——一旦任何客戶端讀到某個值，所有後續的讀取都不會回傳更舊的值。
- 任何並行操作都可以被排列成某個合法的全序（total order），且該全序與真實時間相容。

**代價極高**：要實現 linearizability，通常需要在每次寫入時讓多數節點達成共識（consensus），這意味著至少一個 round-trip 的網路延遲。在跨地理區域的部署中，這可能意味著數百毫秒的延遲。更嚴重的是，在網路分區期間，linearizable 系統必須選擇拒絕請求（犧牲可用性）來維持正確性。

**使用場景**：分散式鎖（distributed lock）、leader election、需要嚴格順序的金融交易。

#### Sequential Consistency（順序一致性）

Sequential consistency 比 linearizability 稍弱。它保證：**所有節點看到的操作順序相同，而且每個單獨程序（process）的操作在該全局順序中保持其程式順序（program order）**。

與 linearizability 的關鍵差異在於：sequential consistency **不要求** 操作的全局順序與真實的掛鐘時間一致。考慮以下場景：

```
真實時間軸：
Client A:  write(x=1) ----完成
Client B:                       write(x=2) ----完成
Client C:                                         read(x) → ?
```

在 linearizability 下，Client C **必須** 讀到 `x=2`（最近的寫入）。但在 sequential consistency 下，Client C 可以讀到 `x=1`，只要系統中的所有節點都同意一個包含這些操作的全局順序——例如，將 B 的寫入排在 A 之前也是合法的（即使真實時間上 A 先完成）。

**重要性**：Leslie Lamport 在 1979 年提出此模型，最初是為了描述多處理器系統的記憶體行為。現代處理器為了效能，通常連 sequential consistency 都不提供（使用更弱的記憶體模型），需要 memory barrier 來恢復順序保證。

#### Causal Consistency（因果一致性）

Causal consistency 引入了「因果關係」的概念：如果操作 A **可能影響** 操作 B（例如 A 寫入了一個值，B 讀取了該值後又做了一次寫入），則所有節點必須以 A 在 B 之前的順序看到它們。但如果兩個操作是「並行的」（concurrent）——即彼此之間沒有因果關係——則不同節點可以以不同順序看到它們。

追蹤因果關係通常使用 **vector clock** 或 **version vector**：

```
Vector Clock 範例（3 個節點 A, B, C）：

Node A 寫入 x=1:  A 的 clock = [1, 0, 0]
Node B 讀到 x=1 後寫入 y=2:  B 的 clock = [1, 1, 0]
    （B 看到了 A 的 [1,0,0]，所以 B 的操作因果依賴於 A）
Node C 獨立寫入 z=3:  C 的 clock = [0, 0, 1]
    （C 與 A、B 的操作並行，無因果關係）
```

**優勢**：causal consistency 在不需要全局同步的情況下，提供了合理的順序保證，效能代價遠低於 linearizability。這使得它在地理分散的系統中特別有吸引力。

**使用場景**：社群媒體（回覆一定要出現在原始貼文之後）、協作文件編輯。

#### Eventual Consistency（最終一致性）

Eventual consistency 是最弱的有用保證：**如果不再有新的寫入，所有副本最終會收斂到相同的狀態**。在收斂過程中，不同客戶端可能讀到不同的值，沒有任何順序保證。

「最終」的時間長度是不確定的。在正常情況下可能是毫秒級，但在高負載或網路問題時，收斂時間可能是秒級甚至分鐘級。這是一個經常被低估的問題（見第 7 節「常見陷阱」）。

**使用場景**：DNS 傳播、CDN 快取更新、購物車（Amazon Dynamo 的經典案例）。

#### Read-your-writes Consistency

這是一種 session 級別的保證：**一個客戶端一定能看到自己之前寫入的值**。這對使用者體驗至關重要——想像一個使用者更新了個人頭像，但重新整理頁面後看到的還是舊頭像，這會讓使用者困惑不已。

實現方式通常是：
- 將客戶端的讀取請求路由到它之前寫入的那個節點（sticky session）。
- 或者讓客戶端帶上一個「最後寫入的時間戳」，讀取時確保節點的狀態至少追上了該時間戳。

#### Monotonic Reads（單調讀取一致性）

保證：**如果一個客戶端讀到了某個值 v，則後續的讀取不會回傳比 v 更舊的值**。

沒有 monotonic reads 時，可能發生這種情況：客戶端先從 Replica A 讀到 `x=5`，然後下一次請求被路由到還沒追上進度的 Replica B，讀到 `x=3`。對使用者來說，數據好像「回到過去了」。

Monotonic reads 可以與 eventual consistency 組合使用，提供更好的使用者體驗而不需要強一致性的代價。

---

## 2. CAP Theorem — 精確理解

### 定理的精確陳述

CAP 定理（由 Eric Brewer 在 2000 年提出猜想，Gilbert 和 Lynch 在 2002 年正式證明）的精確陳述是：

> 在一個非同步網路模型中，不可能同時滿足以下三個屬性：
> - **Consistency（一致性）**：等同於 linearizability——所有節點在同一時間看到相同的資料。
> - **Availability（可用性）**：每個發送到未故障節點的請求都能收到回應（不保證是最新資料）。
> - **Partition Tolerance（分區容忍性）**：系統在任意數量的網路訊息遺失或延遲時仍能繼續運作。

### 常見的錯誤理解

**最大的誤解是「三選二」**。許多人把 CAP 理解為可以自由地從 C、A、P 三者中選擇兩個，好像在餐廳點菜一樣。這是根本性的錯誤。

正確的理解是：**在分散式系統中，網路分區（P）是不可避免的現實**——網線會斷、交換器會故障、跨機房的網路會抖動。你無法「不選」P。因此，真正的選擇是：**當網路分區發生時，你選擇 Consistency 還是 Availability？**

```
CAP 定理的真正含義：

                    正常情況（無分區）
                   /                  \
          可以同時有 C 和 A         （大多數系統在這裡運作良好）
                   \                  /
                    網路分區發生！
                   /                  \
          選擇 C（CP）              選擇 A（AP）
          拒絕可能不一致的          繼續服務，但可能
          請求，犧牲可用性          回傳過時的資料
```

### CP 系統：分區時的行為

當 CP 系統偵測到網路分區時，它會選擇**拒絕**可能導致不一致的請求，而不是冒著回傳錯誤資料的風險。

具體行為包括：
- **拒絕寫入**：少數派分區（minority partition）中的節點無法確認是否與多數派一致，因此拒絕寫入請求。
- **阻塞讀取**：如果無法確認資料是最新的，則讓讀取請求等待（可能超時）。
- **Leader 讓步**：如果 leader 發現自己在少數派分區中，它會放棄 leader 身份。

**實例**：
- **etcd / ZooKeeper**：在分區期間，少數派分區中的節點無法處理寫入請求，讀取也可能被阻塞（取決於一致性設定）。
- **HBase**：如果 RegionServer 無法連接到 ZooKeeper（用於協調），它會停止服務。

### AP 系統：分區時的行為

當 AP 系統偵測到網路分區時，它會選擇**繼續服務**所有請求，即使這意味著不同分區中的節點可能回傳不同的資料。

具體行為包括：
- **接受寫入到任何可達的節點**：即使該節點可能與其他節點斷開連接。
- **回傳可能過時的資料**：客戶端可能讀到舊值。
- **分區恢復後的衝突解決**：這是 AP 系統設計中最困難的部分。常見策略包括 last-write-wins（LWW）、向量時鐘合併、CRDTs、或交由應用層處理。

**實例**：
- **Cassandra**：在分區期間繼續接受讀寫，分區恢復後透過 read repair 和 anti-entropy 機制同步。
- **DynamoDB**：Amazon 的設計哲學——購物車「加入商品」永遠不應該失敗，即使這意味著兩個分區中的購物車可能不同步。

### PACELC：CAP 的延伸

CAP 定理只描述了分區**期間**的取捨，但現實中大部分時間網路是正常的。Daniel Abadi 在 2012 年提出了 PACELC 模型來補充這個盲點：

> **PAC**：如果有 Partition，選擇 Availability 或 Consistency？
> **ELC**：否則（Else），在正常運作時，選擇 Latency 或 Consistency？

這更好地描述了真實系統的行為：

| 系統 | P 時選擇 | E 時選擇 | PACELC 分類 |
|------|---------|---------|------------|
| **Cassandra** | A | L | PA/EL |
| **DynamoDB** | A | L | PA/EL |
| **MongoDB** | C | C | PC/EC |
| **HBase** | C | C | PC/EC |
| **PNUTS (Yahoo)** | C | L | PC/EL |
| **Cosmos DB** | 可調 | 可調 | 可調 |

**PA/EL** 系統（如 Cassandra）在分區時優先可用性，平時也為了低延遲犧牲一致性。這些是典型的「為效能優化」的系統。

**PC/EC** 系統（如 MongoDB 搭配預設設定）無論分區與否都堅持一致性，代價是更高的延遲。

最有趣的是 **PC/EL** 系統：分區時堅持一致性（安全第一），但平時為了效能願意降低一致性要求。這反映了一個務實的工程哲學。

---

## 3. Consensus Algorithms（共識演算法）

共識演算法是分散式系統的核心基礎設施。它們解決的問題是：**如何讓一組可能故障的節點就某個值達成一致的決定？** 這個問題看似簡單，但在節點可能崩潰、網路可能延遲或丟失訊息的環境中，它是極其困難的。事實上，FLP impossibility 定理（1985）證明了在完全非同步的系統中，即使只有一個節點可能崩潰，也不可能保證共識一定能達成。

現實中的共識演算法（如 Raft 和 Paxos）透過引入超時機制和隨機化來繞過 FLP 限制——它們保證安全性（safety），但活性（liveness）依賴於最終有一個足夠長的穩定期間。

### Raft

Raft 由 Diego Ongaro 和 John Ousterhout 在 2014 年提出，明確的設計目標是**可理解性**。它將共識問題分解為三個相對獨立的子問題：Leader Election、Log Replication、Safety。

#### 核心概念

Raft 叢集中的每個節點在任何時刻都處於以下三種狀態之一：
- **Leader**：處理所有客戶端請求，將日誌條目複製到其他節點。整個叢集在同一 term 中最多只有一個 leader。
- **Follower**：被動地回應 leader 和 candidate 的請求。如果長時間沒有收到 leader 的心跳，則轉為 candidate。
- **Candidate**：正在嘗試成為新的 leader。

時間被切分成 **term**（任期），每個 term 以一次選舉開始。Term 是一個單調遞增的整數，作為邏輯時鐘使用。

#### Leader Election（領導者選舉）

1. Follower 在 **election timeout**（通常 150-300ms，隨機化以避免活鎖）內未收到 leader 的心跳。
2. 該 follower 轉變為 candidate，增加自己的 term 號，投票給自己，並向所有其他節點發送 `RequestVote` RPC。
3. 每個節點在同一個 term 中最多投一票（first-come-first-served），且只會投給日誌**至少和自己一樣新**的 candidate（這是 safety 的關鍵保證）。
4. 如果 candidate 收到多數票（majority），它成為 leader，立即向所有節點發送心跳以建立權威。
5. 如果 candidate 在超時前未獲得多數票（例如因為票被分散），它增加 term 號並開始新的選舉。隨機化的 election timeout 確保連續的 split vote 不太可能發生。

#### Log Replication（日誌複製）

一旦 leader 被選出，它開始處理客戶端請求：

```
Raft Log Replication 步驟圖：

Client             Leader             Follower A         Follower B
  |                  |                    |                   |
  |--- write(x=5) ->|                    |                   |
  |                  |                    |                   |
  |            [1] 寫入本地 log           |                   |
  |            (entry: term=3,            |                   |
  |             index=7, x=5)             |                   |
  |                  |                    |                   |
  |                  |-- AppendEntries -->|                   |
  |                  |-- AppendEntries -------------------- ->|
  |                  |                    |                   |
  |                  |<---- ACK ---------|                   |
  |                  |<---- ACK ------------------------------|
  |                  |                    |                   |
  |            [2] 收到多數 ACK           |                   |
  |            (自己 + A + B = 3/3)       |                   |
  |            commit entry              |                   |
  |            apply to state machine     |                   |
  |                  |                    |                   |
  |<-- OK (x=5) ----|                    |                   |
  |                  |                    |                   |
  |                  |-- AppendEntries -->|                   |
  |                  |   (commitIndex=7)  |                   |
  |                  |-- AppendEntries -------------------- ->|
  |                  |                    |                   |
  |                  |              [3] Followers 得知        |
  |                  |              entry 已 committed,       |
  |                  |              apply to state machine     |
```

**詳細步驟說明**：

**Step 1 — Leader 接收請求並寫入本地 log**：Leader 將客戶端的寫入操作包裝成一個 log entry，其中包含 term 號、log index 和操作內容。此時 entry 狀態為 uncommitted。

**Step 2 — 並行複製到 followers**：Leader 透過 `AppendEntries` RPC 將該 entry 發送到所有 followers。這個 RPC 同時也攜帶 leader 已知的 `commitIndex`，讓 followers 知道哪些 entry 已經被 committed。

**Step 3 — Follower 接收並回應**：每個 follower 收到 `AppendEntries` 後，先檢查一致性（previous log entry 的 term 和 index 是否匹配）。如果一致，將 entry 寫入自己的 log 並回傳 ACK。如果不一致，回傳拒絕，leader 會回退並重新發送更早的 entries。

**Step 4 — Leader commit 並回應客戶端**：當 leader 收到多數節點的 ACK 後（包括自己），它將該 entry 標記為 committed，apply 到 state machine，然後回應客戶端。

**Step 5 — Followers apply**：在下一次 `AppendEntries`（可能是心跳）中，leader 會將更新後的 `commitIndex` 傳播給 followers，followers 隨後也 apply committed entries 到自己的 state machine。

#### Leader 故障時的處理

當 leader 崩潰時，followers 在 election timeout 後會偵測到心跳消失：

1. 一個或多個 followers 超時，轉為 candidate 並發起選舉。
2. 新的 leader 被選出。Raft 的 safety 屬性保證新 leader 的 log 中包含所有已 committed 的 entries（因為投票規則要求 candidate 的 log 至少和投票者一樣新）。
3. 新 leader 開始向 followers 發送 `AppendEntries`，如果發現 follower 的 log 與自己不一致（可能因為舊 leader 崩潰前有些 entry 只複製到了部分節點），新 leader 會強制 followers 的 log 與自己一致（刪除衝突的 uncommitted entries）。
4. 那些舊 leader 只複製到少數節點的 uncommitted entries 會被丟棄——因為它們從未被 committed（未獲得多數確認），所以不會違反任何對客戶端的承諾。

**關鍵安全保證**：已經 committed 的 entry 永遠不會遺失。這是透過以下機制確保的：
- Committed 意味著已複製到多數節點。
- 新 leader 必須獲得多數票。
- 這兩個多數集合必然有交集——至少有一個節點同時持有所有 committed entries 並參與了投票。
- 投票規則確保只有 log 足夠新的 candidate 才能獲勝。

#### Raft 的實際應用

- **etcd**：Kubernetes 的核心儲存元件，使用 Raft 確保叢集配置資料的一致性。
- **CockroachDB**：分散式 SQL 資料庫，每個 range（資料分片）使用一個獨立的 Raft group。
- **TiKV**：PingCAP 開發的分散式 key-value 儲存，也採用 Multi-Raft 架構。
- **Consul**：HashiCorp 的服務發現和配置管理工具。

### Paxos

Paxos 由 Leslie Lamport 在 1989 年提出（1998 年正式發表），是分散式共識的理論基石。它的正確性經過了嚴格的數學證明，但其描述方式和實現複雜度讓它成為了分散式系統中最令人頭疼的演算法之一。

#### 角色定義

- **Proposer（提議者）**：提出一個值，希望系統就該值達成共識。
- **Acceptor（接受者）**：投票決定是否接受某個提議。共識需要多數 acceptor 接受同一個提議。
- **Learner（學習者）**：學習最終被選定的值。在實際系統中，learner 通常就是需要 apply 該決定的節點。

在實際部署中，同一個節點通常同時扮演多個角色。

#### Basic Paxos 的兩階段協議

**Phase 1：Prepare（準備階段）**

1. Proposer 選擇一個全局唯一的提議號 `n`（通常是遞增的），向所有 acceptor 發送 `Prepare(n)` 請求。
2. 每個 acceptor 收到 `Prepare(n)` 後：
   - 如果 `n` 大於它之前回應過的所有 prepare 請求的提議號，它**承諾**不再接受任何編號小於 `n` 的提議，並回傳它之前已經接受過的最高編號提議（如果有的話）。
   - 如果 `n` 不大於已回應過的最高提議號，拒絕（或忽略）。

**Phase 2：Accept（接受階段）**

3. 如果 proposer 收到多數 acceptor 的回應：
   - 如果所有回應都沒有附帶之前接受過的提議，proposer 可以自由選擇要提議的值 `v`。
   - 如果有回應附帶了之前接受的提議，proposer **必須** 使用其中編號最高的那個提議的值作為 `v`（這是 Paxos 正確性的關鍵）。
   - Proposer 向所有 acceptor 發送 `Accept(n, v)` 請求。
4. 每個 acceptor 收到 `Accept(n, v)` 後：
   - 如果它沒有承諾過編號大於 `n` 的 prepare 請求，它**接受**該提議。
   - 否則拒絕。
5. 當多數 acceptor 接受了同一個 `(n, v)` 提議，共識就達成了。Learners 被通知最終的值。

#### 為什麼 Paxos 難以理解和實現

Basic Paxos 只解決了「對一個值達成共識」的問題。但現實中的系統需要對**一系列**的值達成共識（即 replicated log）。這引出了 **Multi-Paxos**，而 Lamport 的原始論文對 Multi-Paxos 的描述極為簡略，導致每個實現團隊都需要自己填補大量空白。

具體的困難包括：

1. **Leader 優化**：Basic Paxos 每次提議都需要兩個 round-trip。在 Multi-Paxos 中，可以選出一個穩定的 leader 來跳過 Phase 1（因為 leader 可以預先完成 prepare），將延遲降到一個 round-trip。但如何選 leader、如何處理 leader 變更，原始論文沒有明確說明。

2. **Log 空洞**：Multi-Paxos 允許不同的 log slot 獨立地達成共識，這可能導致 log 中出現空洞（某些 slot 已決定，但之前的 slot 尚未決定）。如何處理這些空洞是一個實現難題。

3. **成員變更**：如何安全地增加或移除叢集成員，Paxos 沒有提供標準方案。

4. **快照和日誌壓縮**：隨著 log 增長，如何進行快照也是留給實現者的問題。

正因如此，Google 在其 Paxos Made Live 論文（2007）中寫道：「Paxos 演算法的描述與真實系統的需求之間存在巨大的鴻溝……最終的系統建立在一個未被證明的協議之上。」

#### Paxos 的實際應用

- **Google Chubby**：Google 的分散式鎖服務，內部使用 Multi-Paxos。
- **Google Spanner**：全球分散式資料庫，使用 Paxos 進行跨資料中心的資料複製。
- **Apache ZooKeeper**：使用 ZAB（Zookeeper Atomic Broadcast）協議，本質上是 Paxos 的變體。
- **Microsoft Azure Storage**：使用 Paxos 的變體來確保資料持久性。

### Raft vs Paxos 比較

| 維度 | Raft | Paxos |
|------|------|-------|
| **可理解性** | 高——明確的 leader 概念、清晰的子問題分解。論文包含了實現所需的所有細節。 | 低——Basic Paxos 的證明優美但抽象。Multi-Paxos 缺乏規範性描述，每個實現都是「方言」。 |
| **Leader 機制** | 強制 leader——所有操作必須透過 leader。簡化了推理，但 leader 是效能瓶頸。 | 可選 leader——Basic Paxos 不需要 leader，Multi-Paxos 通常使用 leader 作為優化。 |
| **日誌完整性** | 嚴格——log 不允許有空洞，leader 保證連續複製。 | 寬鬆——不同 slot 可以獨立決定，可能出現空洞。 |
| **成員變更** | 有明確的 joint consensus 方案（原始論文定義）。 | 無標準方案，各實現自行處理。 |
| **效能** | 正常情況下一個 round-trip（leader 直接發 AppendEntries）。leader 變更期間有短暫中斷。 | Multi-Paxos 搭配穩定 leader 也是一個 round-trip。理論上 leaderless Paxos 可以有更好的可用性但更高的延遲。 |
| **理論基礎** | 等同於 Multi-Paxos（已證明）。安全性保證相同。 | 數十年的理論研究和形式化驗證。 |
| **實際採用** | 近年新系統的首選（etcd, CockroachDB, TiKV, Consul）。 | 傳統大型系統（Google Chubby/Spanner, ZooKeeper/ZAB）。 |
| **實現複雜度** | 中等——論文即規範，但仍需處理快照、client interaction 等。 | 高——需要從 Basic Paxos 自行推導出完整的 Multi-Paxos 實現。 |

**總結**：就理論而言，Raft 和 Multi-Paxos 的本質能力是等價的（都提供相同的 safety 和 liveness 保證）。Raft 的優勢在於它是一個**完整的、可直接實現的規範**，而 Paxos 更像是一個**理論框架**，需要大量工程決策才能轉化為實際系統。對於新的系統設計，Raft 通常是更務實的選擇。

---

## 4. Replication Strategies（複製策略）

### Single-Leader Replication（單主複製）

在 single-leader 架構中，一個節點被指定為 **leader**（也稱為 primary 或 master），所有寫入操作必須經過 leader。其他節點（followers / replicas / secondaries）從 leader 複製資料，通常可以處理讀取請求。

**寫入流程**：
1. 客戶端將寫入請求發送到 leader。
2. Leader 將變更寫入自己的 log/storage。
3. Leader 將變更複製到所有 followers。
4. 根據同步策略，leader 在不同時機回應客戶端：
   - **同步複製**（synchronous）：等待所有（或多數）followers 確認後才回應。強一致性，高延遲。
   - **非同步複製**（asynchronous）：leader 寫入本地後立即回應。低延遲，但 leader 故障時可能遺失尚未複製的資料。
   - **半同步複製**（semi-synchronous）：等待至少一個 follower 確認。在延遲和持久性之間折衷。

**優點**：
- 一致性推理簡單——所有寫入都經過單一節點，自然形成全序。
- 不會有寫入衝突。
- 讀取可以從 followers 擴展（read scaling）。

**缺點**：
- **寫入瓶頸**：所有寫入流量集中在單一節點。
- **Failover 複雜性**：leader 故障時的切換（failover）是一個充滿陷阱的過程——如何偵測 leader 故障？如何選擇新 leader？如果舊 leader 復活了怎麼辦（split-brain）？如果新 leader 缺少某些最新資料怎麼辦？
- **跨地理區域延遲**：如果 leader 在美國，亞洲的客戶端每次寫入都要跨越太平洋。

**典型系統**：MySQL（主從複製）、PostgreSQL（streaming replication）、MongoDB（replica set）、Redis Sentinel。

### Multi-Leader Replication（多主複製）

Multi-leader（也稱 master-master）允許多個節點接受寫入操作。這解決了 single-leader 的寫入瓶頸和跨地理延遲問題，但引入了一個根本性的新挑戰：**寫入衝突**。

**使用場景**：
- **多資料中心部署**：每個資料中心有一個 leader，使用者連接到最近的 leader。
- **離線操作**：如行動裝置上的應用程式——裝置在離線時充當自己的「leader」，上線後與伺服器同步。
- **協作編輯**：多個使用者同時編輯同一份文件。

**衝突解決策略**：

1. **Last-Write-Wins（LWW）**：每個寫入帶有時間戳，衝突時保留時間戳較大的。簡單但危險——可能悄悄丟失資料。而且依賴時鐘同步，在分散式環境中時鐘不一定可靠。Cassandra 預設使用此策略。

2. **CRDTs（Conflict-free Replicated Data Types）**：一類特殊的資料結構，設計上保證並行的修改可以自動合併而不會衝突。例如 G-Counter（只增計數器）、OR-Set（可觀察移除集合）。數學上優美，但只適用於特定的資料操作模式。

3. **Application-level 解決**：將衝突呈現給應用層（甚至使用者），由應用邏輯決定如何處理。這是最靈活但也最複雜的方式。例如 Google Docs 使用 OT（Operational Transformation）或 CRDT 來處理並行編輯。

4. **Custom merge function**：由開發者定義一個合併函數，系統在偵測到衝突時自動調用。例如購物車可以用集合聯集（union）來合併。

**典型系統**：CouchDB、Riak、MySQL Group Replication（multi-primary mode）。

### Leaderless Replication（無主複製 / Dynamo-style）

Leaderless 架構徹底取消了「leader」的概念——客戶端直接向多個節點發送讀寫請求（或透過 coordinator 節點，但 coordinator 不扮演 leader 角色）。

這種架構的核心機制是 **Quorum（法定人數）**。

#### Quorum 讀寫

假設叢集有 **N** 個副本。客戶端的每次寫入發送到 **W** 個節點，每次讀取從 **R** 個節點獲取。

**核心公式**：

```
如果 R + W > N，則讀取和寫入的節點集合必然有交集，
因此讀取一定能看到最近的寫入（至少從一個節點）。
```

```
Quorum 讀寫示意圖（N=5, W=3, R=3）：

寫入操作 write(x=42)：
+-------+  +-------+  +-------+  +-------+  +-------+
|Node 1 |  |Node 2 |  |Node 3 |  |Node 4 |  |Node 5 |
| x=42  |  | x=42  |  | x=42  |  | x=OLD |  | x=OLD |
|  [W]  |  |  [W]  |  |  [W]  |  |       |  |       |
+-------+  +-------+  +-------+  +-------+  +-------+
    ^          ^          ^
    |__________|__________|
    寫入到 W=3 個節點

讀取操作 read(x)：
+-------+  +-------+  +-------+  +-------+  +-------+
|Node 1 |  |Node 2 |  |Node 3 |  |Node 4 |  |Node 5 |
| x=42  |  | x=42  |  | x=42  |  | x=OLD |  | x=OLD |
|       |  |  [R]  |  |  [R]  |  |  [R]  |  |       |
+-------+  +-------+  +-------+  +-------+  +-------+
               ^          ^          ^
               |__________|__________|
               從 R=3 個節點讀取
               Node 2 和 3 回傳 x=42
               Node 4 回傳 x=OLD
               客戶端取版本最新的 → x=42  ✓

R(3) + W(3) = 6 > N(5) → 保證有交集（至少 1 個節點同時參與了讀和寫）
```

**當 R + W <= N 時**：讀取和寫入的節點集合**可能沒有交集**，意味著讀取可能完全錯過最近的寫入。這本質上是 eventual consistency。

```
危險情況：N=5, W=2, R=2 → R+W=4, 不大於 N=5（應為 4 <= 5）

寫入到 Node 1, 2：
+-------+  +-------+  +-------+  +-------+  +-------+
|Node 1 |  |Node 2 |  |Node 3 |  |Node 4 |  |Node 5 |
| x=42  |  | x=42  |  | x=OLD |  | x=OLD |  | x=OLD |
|  [W]  |  |  [W]  |  |       |  |       |  |       |
+-------+  +-------+  +-------+  +-------+  +-------+

讀取從 Node 4, 5：
+-------+  +-------+  +-------+  +-------+  +-------+
|Node 1 |  |Node 2 |  |Node 3 |  |Node 4 |  |Node 5 |
| x=42  |  | x=42  |  | x=OLD |  | x=OLD |  | x=OLD |
|       |  |       |  |       |  |  [R]  |  |  [R]  |
+-------+  +-------+  +-------+  +-------+  +-------+

讀寫節點集合完全不重疊 → 讀到 x=OLD（過時資料！）✗
```

#### 常見的 Quorum 配置

| 配置 | 特性 | 使用場景 |
|------|------|---------|
| W=N, R=1 | 寫入慢（等所有節點）、讀取快。寫入可用性低（任何節點故障就無法寫入）。 | 讀取遠多於寫入的場景 |
| W=1, R=N | 寫入快、讀取慢。讀取可用性低。寫入可能遺失（寫入的節點崩潰後）。 | 寫入遠多於讀取的場景 |
| W=⌈(N+1)/2⌉, R=⌈(N+1)/2⌉ | 多數讀多數寫。最常見的平衡配置。 | 一般用途 |

#### Sloppy Quorum 與 Hinted Handoff

嚴格的 quorum 要求讀寫都必須從指定的 N 個節點中選擇。但在網路分區或節點故障期間，可能無法聯繫到足夠的指定節點。

**Sloppy quorum** 是一個務實的折衷：當指定的節點不可用時，允許使用**其他不在該 key 的 N 個指定節點清單中的節點**來滿足 quorum 要求。這提高了寫入可用性，但削弱了一致性保證——因為那些「臨時替代」的節點不在讀取的 quorum 中。

**Hinted handoff**：當某個操作被寫入到了「臨時替代」節點時，該節點會保存一個提示（hint），表示「這份資料應該屬於節點 X」。當節點 X 恢復後，臨時節點將資料轉交給 X。

#### Read Repair 與 Anti-Entropy

即使使用了 quorum，副本之間仍可能因為各種原因（節點暫時不可用、網路問題）而不同步。Leaderless 系統使用以下機制來修復不一致：

**Read repair**：當客戶端從 R 個節點讀取時，如果發現某些節點的資料比較舊，客戶端（或 coordinator）會將最新的值寫回那些過時的節點。這是一種被動修復——只在讀取時觸發，很少被讀取的資料可能長時間不一致。

**Anti-entropy（反熵）**：一個持續運行的背景程序，在節點之間比較資料（通常使用 Merkle tree 來高效地找出差異），並修復不一致。這是主動修復，可以覆蓋 read repair 遺漏的冷資料。

**典型系統**：Amazon DynamoDB、Apache Cassandra、Riak、Voldemort。

---

## 5. Distributed Transactions（分散式交易）

分散式交易解決的問題是：**如何在多個獨立的節點（或服務）上執行一組操作，使其具有原子性——要麼全部成功，要麼全部失敗？**

### 2PC（Two-Phase Commit，兩階段提交）

2PC 是分散式交易最經典的協議。

**角色**：
- **Coordinator（協調者）**：管理交易的提交或回滾決策。
- **Participants（參與者）**：執行交易操作的各個節點。

**流程**：

```
2PC 流程：

Coordinator          Participant A        Participant B
    |                     |                     |
    |---- Prepare ------->|                     |
    |---- Prepare ------------------------------>|
    |                     |                     |
    |   [各 participant 執行操作，寫入 redo/undo log]
    |   [但不提交，進入 "prepared" 狀態]          |
    |                     |                     |
    |<--- Vote YES -------|                     |
    |<--- Vote YES -----------------------------|
    |                     |                     |
    | [收到所有 YES → 決定 COMMIT]               |
    | [如果任何一個 NO → 決定 ABORT]             |
    |                     |                     |
    |---- Commit -------->|                     |
    |---- Commit ------------------------------>|
    |                     |                     |
    |   [各 participant 正式提交]                |
    |                     |                     |
    |<--- ACK ------------|                     |
    |<--- ACK ----------------------------------|
```

**Phase 1（Prepare / Voting）**：
1. Coordinator 向所有 participants 發送 `Prepare` 請求。
2. 每個 participant 執行交易操作（寫入資料但不提交），寫入必要的 log 以便稍後提交或回滾。
3. 如果 participant 可以承諾提交，回傳 `Vote YES`；如果出現任何問題，回傳 `Vote NO`。
4. **一旦 participant 投了 YES，它就進入了一個「不確定狀態」——它已經承諾可以提交，但必須等待 coordinator 的最終決定。** 這是 2PC 的核心弱點。

**Phase 2（Commit / Abort）**：
1. 如果 coordinator 收到了所有 participants 的 YES，它決定 `COMMIT`，將此決定寫入自己的 log（持久化），然後通知所有 participants 提交。
2. 如果任何 participant 回傳了 NO（或超時），coordinator 決定 `ABORT`，通知所有 participants 回滾。

**Blocking Problem（阻塞問題）**：

2PC 的致命缺陷是 **coordinator 故障會導致整個交易阻塞**。考慮以下場景：

1. Participant A 和 B 都投了 YES。
2. Coordinator 在寫入 COMMIT 決定之後、發送給 participants 之前崩潰了。
3. Participant A 和 B 都處於「不確定狀態」——它們已經承諾可以提交，但不知道 coordinator 最終決定了什麼。它們不能自行提交（因為 coordinator 可能決定了 ABORT），也不能自行回滾（因為 coordinator 可能決定了 COMMIT）。
4. 它們只能**等待** coordinator 恢復。在等待期間，它們持有的鎖不能釋放，相關資源被凍結。

這使得 2PC 在需要高可用性的系統中極為不適合。

### 3PC（Three-Phase Commit，三階段提交）

3PC 嘗試解決 2PC 的阻塞問題，在 Prepare 和 Commit 之間增加了一個 **Pre-Commit** 階段。

**三個階段**：
1. **CanCommit**：coordinator 詢問 participants 是否能參與交易（輕量級檢查）。
2. **PreCommit**：如果所有人同意，coordinator 發送 pre-commit 請求。Participants 寫入 redo/undo log 但不提交。此階段引入了超時機制——如果 participant 在超時時間內未收到 coordinator 的下一步指令，它可以安全地 **abort**（因為它知道不是所有人都進入了 pre-commit 階段）。
3. **DoCommit**：coordinator 發送最終提交請求。

**改善**：3PC 是 **non-blocking** 的——在 coordinator 故障時，participants 可以根據自己所處的階段做出安全的決策（超時後 abort 或 commit）。

**仍然的問題**：3PC 在 **網路分區** 時仍然可能出現不一致。如果在 DoCommit 階段，部分 participants 收到了 commit 指令而另一部分被分區隔離並超時 abort，就會出現一些節點已提交、另一些已回滾的不一致狀態。因此，3PC 在實際系統中很少被使用。

### Saga Pattern（Saga 模式）

在微服務架構中，每個服務擁有自己的資料庫，傳統的分散式交易（2PC）既不實際（效能代價太高）也不可行（許多服務不支援 XA 協議）。Saga 提供了一種替代方案。

**核心思想**：將一個分散式交易拆解為一系列**本地交易（local transactions）**，每個本地交易都有一個對應的**補償交易（compensating transaction）**。如果某個步驟失敗，按照反向順序執行之前所有步驟的補償交易。

**範例——訂單流程**：

```
正常流程（所有步驟成功）：

T1: 建立訂單        → C1: 取消訂單
T2: 扣減庫存        → C2: 恢復庫存
T3: 信用卡扣款      → C3: 退款
T4: 發送確認郵件    → C4: 發送取消通知

執行順序：T1 → T2 → T3 → T4 ✓

失敗流程（T3 失敗——信用卡被拒）：

T1 → T2 → T3(失敗!) → C2(恢復庫存) → C1(取消訂單)

注意：不需要 C3（因為 T3 沒有成功），也不需要 C4（因為 T4 從未執行）。
```

#### Choreography vs Orchestration

**Choreography（編排式）**：
每個服務監聽事件並自行決定下一步操作。沒有中央協調者。

```
Choreography 模式：

OrderService ──(OrderCreated)──> InventoryService
                                      |
                                 (InventoryReserved)
                                      |
                                      v
                                PaymentService
                                      |
                                 (PaymentProcessed)
                                      |
                                      v
                              NotificationService
```

- **優點**：低耦合、每個服務自主、不存在單點故障。
- **缺點**：難以追蹤整個 saga 的狀態、難以偵錯、容易形成意外的循環依賴。隨著步驟增加，複雜度急劇上升。

**Orchestration（指揮式）**：
由一個中央的 **Saga Orchestrator** 負責告訴每個服務該做什麼、何時做。

```
Orchestration 模式：

                    Saga Orchestrator
                   /    |     |      \
                  v     v     v       v
            Order   Inventory  Payment  Notification
            Service  Service   Service   Service
```

- **優點**：流程清晰可見、容易追蹤和偵錯、新增步驟相對簡單。
- **缺點**：orchestrator 是單點故障（需要自己做高可用）、服務對 orchestrator 有依賴。

**Saga 的限制**：
- Saga 提供的是 **ACD**（Atomicity, Consistency, Durability）而非完整的 ACID——它**缺少 Isolation**。在 saga 執行過程中，中間狀態對外可見。例如在上述範例中，庫存已扣減但付款尚未完成的中間狀態可能被其他交易看到。
- 補償交易的設計需要非常小心——有些操作本質上不可逆（例如已發送的電子郵件）。這種情況需要使用「語義補償」（如發送一封更正郵件）而非技術回滾。

---

## 6. Architect's Decision Tree（架構師決策樹）

選擇一致性模型不是一個純技術決定——它需要深入理解業務需求、使用者期望和故障場景。以下是一個系統化的決策框架。

### 決策流程

```
你的應用需要什麼？
    |
    v
資料不一致是否會造成金錢損失或安全風險？
    |
    +-- YES → 考慮 Strong Consistency (Linearizability)
    |         使用 consensus algorithm (Raft/Paxos)
    |         接受更高的延遲和更低的可用性
    |         例：銀行轉帳、庫存扣減、分散式鎖
    |
    +-- NO → 使用者能否容忍短暫看到舊資料？
              |
              +-- NO → 考慮 Read-your-writes + Monotonic reads
              |         使用 session affinity 或 causal consistency
              |         例：使用者個人設定、社群媒體個人動態
              |
              +-- YES → 資料更新的頻率？
                        |
                        +-- 高頻 → Eventual Consistency + 衝突解決
                        |          考慮 CRDTs 或 LWW
                        |          例：按讚計數、瀏覽次數
                        |
                        +-- 低頻 → Eventual Consistency 通常足夠
                                   例：使用者偏好設定、CDN 快取
```

### 場景對照表

| 場景 | 推薦模型 | 複製策略 | 交易模式 | 理由 |
|------|---------|---------|---------|------|
| **銀行轉帳** | Linearizability | Single-leader + 同步複製 | 2PC 或分散式交易 | 金錢不能憑空產生或消失。帳戶餘額必須在所有副本上即時一致。 |
| **庫存管理** | Linearizability（核心操作）+ Eventual（查詢） | Single-leader | Saga（微服務）或 2PC（單體） | 扣減庫存需要嚴格一致以防超賣，但商品列表頁可以容忍短暫的舊資料。 |
| **社群媒體動態** | Causal Consistency | Multi-leader（多資料中心）| 無分散式交易 | 回覆必須出現在原始貼文之後（因果），但不同使用者看到貼文的順序可以不同。高可用性比強一致性重要。 |
| **電商購物車** | Eventual Consistency（偏向可用性） | Leaderless（Dynamo-style） | Saga | 購物車「加入商品」永遠不該失敗。衝突時可以用 union 合併（寧可多不可少）。 |
| **即時通訊** | Causal Consistency + Read-your-writes | Single-leader per 對話 | 無 | 訊息順序在同一對話中很重要，使用者必須看到自己發送的訊息。 |
| **DNS** | Eventual Consistency | 階層式 + 快取 | 無 | 全球規模、讀取極多、更新極少。TTL 控制收斂速度。 |
| **分散式設定管理** | Linearizability | Consensus-based（Raft） | 無 | 設定變更必須原子且全局一致，否則不同節點可能使用不同的設定。 |

### 進階考量

**混合模型（Hybrid Approach）**：大多數真實系統不會全面使用單一一致性模型。例如：
- 電商系統可能對庫存使用 strong consistency，對商品推薦使用 eventual consistency。
- 社群平台可能對使用者認證使用 linearizability，對動態牆使用 causal consistency。

**Tunable consistency**：許多現代資料庫（如 Cassandra、Cosmos DB）允許在每次操作時指定一致性等級。這提供了極大的靈活性，但也增加了開發者的認知負擔——每個 query 都需要思考「這裡需要什麼一致性？」

---

## 7. Common Pitfalls（常見陷阱）

### 陷阱一：假設 "Eventual" 等於 "很快"

Eventual consistency 的「最終」沒有時間上界保證。在正常情況下，副本通常在毫秒到秒級收斂。但在以下情況中，收斂時間可能大幅增加：

- **網路分區或擁塞**：跨地理區域的副本同步可能延遲數秒甚至數分鐘。
- **節點故障後恢復**：一個離線了數小時的節點需要追上所有遺漏的更新。
- **寫入突增（write spike）**：大量寫入可能使複製佇列積壓。
- **大型資料集的 anti-entropy**：Merkle tree 比對和同步大量差異需要時間。

**教訓**：在設計系統時，不要僅考慮「正常情況下」的收斂速度，還要規劃「最壞情況下」可接受的不一致窗口，並建立監控機制來偵測異常的長時間不一致。

### 陷阱二：混淆 CAP Consistency 與 ACID Consistency

這是兩個完全不同的概念，不幸地共用了同一個單字：

| | CAP 的 Consistency | ACID 的 Consistency |
|---|---|---|
| **含義** | 所有節點在同一時間看到相同的資料（linearizability） | 交易將資料庫從一個合法狀態轉移到另一個合法狀態（遵守所有約束和不變量） |
| **層次** | 分散式系統的副本一致性 | 單一資料庫的資料完整性 |
| **保證方** | 分散式系統的複製協議 | 應用程式邏輯 + 資料庫約束 |
| **例子** | 兩個節點對同一 key 回傳相同的值 | 轉帳後兩個帳戶的餘額總和不變 |

混淆這兩者會導致嚴重的設計錯誤。例如，一個 eventually consistent 的系統仍然可以在每個節點上保證 ACID consistency（每個本地交易都遵守約束），而一個 linearizable 的系統如果應用邏輯有 bug，也可能違反 ACID consistency。

### 陷阱三：忽略 Tunable Consistency 的存在

許多開發者將資料庫分為「強一致性」和「最終一致性」兩個陣營，但現代分散式資料庫通常提供**可調節的一致性**：

- **Cassandra**：每個 query 可以指定 consistency level（ONE, QUORUM, ALL, LOCAL_QUORUM 等）。
- **Azure Cosmos DB**：提供 5 個一致性等級（Strong, Bounded Staleness, Session, Consistent Prefix, Eventual）。
- **DynamoDB**：支援 eventually consistent reads（預設）和 strongly consistent reads。
- **CockroachDB**：預設 serializable isolation，但可以使用 follower reads 來降低讀取延遲（犧牲一些一致性）。

**教訓**：不要僅基於資料庫的「分類」來做決策。深入了解你選擇的資料庫提供哪些一致性選項，並根據每個操作的需求來選擇。

### 陷阱四：Multi-Leader 卻忽略衝突解決

設置 multi-leader replication 很容易（許多資料庫提供開箱即用的支援），但**設計正確的衝突解決策略**極其困難。常見的錯誤包括：

- **默認使用 LWW 而不考慮後果**：LWW 會悄悄丟棄衝突的寫入。對於計數器來說，這意味著丟失增量；對於集合來說，這意味著丟失元素。
- **假設衝突很少發生**：在高寫入量的系統中，衝突比想像中更頻繁。
- **沒有測試衝突場景**：開發時一切正常，上線後在網路抖動時突然出現大量資料不一致。

**教訓**：如果你選擇了 multi-leader，必須明確定義並充分測試每種資料類型的衝突解決策略。如果你無法為某類資料定義一個合理的自動衝突解決方案，那麼該資料可能不適合 multi-leader 架構。

### 陷阱五：忽略 Consensus 的效能開銷

Consensus 演算法（Raft, Paxos）提供了強大的一致性保證，但它們有明確的效能代價：

- **每次寫入至少需要一個 round-trip**（leader 到多數 followers）。在跨地理區域部署中，這可能意味著 100-300ms 的延遲。
- **吞吐量受限於 leader**：所有寫入必須經過 leader，leader 的網路頻寬和處理能力成為瓶頸。
- **成員變更需要特殊處理**：增減節點不是零開銷的操作。

**教訓**：不要對所有資料都使用 consensus。將需要強一致性的「hot path」（如鎖、配置、metadata）與可以容忍弱一致性的「data path」（如使用者活動記錄、快取）分開處理。

### 陷阱六：Split-Brain 的低估

在 single-leader 系統中，如果故障偵測機制誤判 leader 已死亡（實際上只是網路延遲），系統可能選出一個新 leader，而舊 leader 仍在運作。此時兩個節點都認為自己是 leader 並接受寫入——這就是 **split-brain**。

後果可能是災難性的：兩個 leader 可能接受了相互衝突的寫入，而且在 split-brain 被偵測到之前，這些衝突寫入可能已經被大量客戶端讀取和使用。

**防禦措施**：
- **Fencing token**：每個 leader 持有一個單調遞增的 token，storage layer 拒絕來自持有舊 token 的 leader 的寫入。
- **Lease 機制**：leader 的權威有時間限制，到期後必須續約。
- **多數派確認**：leader 在處理寫入前先確認自己仍被多數節點認可。
