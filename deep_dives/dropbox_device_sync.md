# Dropbox — 跨裝置同步架構全解

## 1. 核心設計模式：通知與資料分離

Sync 系統的第一個設計決策：**把「通知 client 有變更」和「傳送變更內容」拆成兩條獨立的路徑。**

```
┌─────────────────────────────────────────────────────┐
│  Notification Channel（鬧鐘）                        │
│  ‧ 職責：告訴 client「有東西變了」                      │
│  ‧ Payload：幾 bytes（甚至只是 HTTP 200 OK）           │
│  ‧ 協議：Long Polling                                │
│  ‧ 瓶頸：concurrent idle connections（I/O bound）     │
│  ‧ Scale：水平加機器 hold 更多 connections              │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Data Channel（早餐）                                │
│  ‧ 職責：回傳「具體改了什麼」                           │
│  ‧ Payload：完整 diff（file list, metadata, chunks）  │
│  ‧ 協議：普通 HTTP GET /delta?cursor=xxx              │
│  ‧ 瓶頸：DB query + payload 組裝（CPU/DB bound）      │
│  ‧ Scale：read replicas + cache                      │
└─────────────────────────────────────────────────────┘
```

### 為什麼不合在一起？

如果 Notification 直接推送完整 diff：

| 問題 | 說明 |
|------|------|
| Notification Service 變重 | 需要查 DB、組裝 diff、回傳大 payload，從「鬧鐘」變成「鬧鐘 + 做早餐」 |
| 無法 Batching | 1 秒內改 10 個檔案，要推 10 次？還是等一下？這不該是 Notification 的邏輯 |
| Retry 成本高 | 推 500KB diff 失敗要重傳整包；推幾 bytes signal 失敗重傳毫無成本 |
| 無法獨立 Scale | Notification 是 I/O bound（hold connections），Data 是 CPU/DB bound（組裝 payload），混在一起無法獨立調優 |

---

## 2. 通知協議選型：Long Polling 是甜蜜點

| 方案 | 即時性 | 複雜度 | 適用場景 |
|------|--------|--------|---------|
| Periodic Polling | 低（取決於 interval） | 最低 | 變更極少、對延遲不敏感 |
| **Long Polling** | **高（變更後立即回應）** | **低（普通 HTTP）** | **Dropbox 等檔案同步（變更頻率中低）** |
| WebSocket / SSE | 最高 | 高（persistent conn, heartbeat, reconnect） | 聊天室、即時協作等高頻雙向場景 |

Long Polling 對 Dropbox 是最佳選擇，因為：
- 檔案變更頻率不高（不是聊天室），大部分時間 connection 是 idle
- 用普通 HTTP，不需要 sticky session、connection manager 等 WebSocket infra
- 比 periodic polling 即時且省資源（不會發大量空請求）

---

## 3. 完整 Sync Flow

```
1. 手機 upload 完檔案 → Sync Service 寫入 Metadata DB

2. Sync Service 發 event：
   PUBLISH "file_changes:7" → { user_id: 123 }
   （channel = "file_changes:" + user_id % 16）

3. Redis Pub/Sub 廣播到所有 Notification Pod

4. 每台 Pod 查自己的 in-memory HashMap：
   - 有 user_123 的 connection → 釋放 long poll（HTTP 200）
   - 沒有 → 丟掉（< 1μs）

5. 筆電收到 200 → 主動打 GET /delta?cursor=last_sync_token
   → Sync Service 回傳：
   {
     entries: [{ path: "/doc.txt", rev: "abc123", modified: "..." }],
     cursor: "new_cursor",
     has_more: false
   }

6. 筆電根據 delta 下載實際檔案內容

7. 筆電立刻發起下一輪 long poll，繼續等
```

---

## 4. Notification Service 的 Scaling 架構

### 核心決策：Stateless Pod + 全量廣播（Broadcast）

**不用 sticky routing（把同 user 的裝置導到同一 pod）。** 任何裝置連到任何 pod，靠 broadcast + local HashMap lookup 解決。

```
            Load Balancer（Round Robin，無狀態）
           /          |           \
       Pod-A        Pod-B        Pod-C
      holds:       holds:       holds:
   user123-手機  user123-筆電  user456-iPad
   user789-PC   user456-手機  user123-平板

每台 Pod 在記憶體中維護：
  connections_map = {
    user_123: [conn_1, conn_3],
    user_789: [conn_2],
  }
```

### 為什麼不用 Sticky Routing？

| Sticky Routing | Round Robin + Broadcast |
|----------------|------------------------|
| LB 需維護 user → pod 映射（有狀態） | LB 無狀態，隨便分 |
| Pod 掛了 → 該批 user 全斷，需 re-route | Pod 掛了 → 只丟那些 connection，重連自動散到其他 pod |
| 熱點 user（多裝置）壓垮單一 pod | 天然均勻分佈 |
| Deploy 時需 drain connections | 直接滾動更新 |

Sticky routing 省掉的是每個 event 多幾次 **μs 級的 HashMap lookup**；付出的是整套有狀態的 routing + failover + rebalancing 機制。**不值得。**

### 數字驗證：廣播的成本可以忽略

| 指標 | 數字 |
|------|------|
| 全局檔案變更頻率 | ~10K changes/sec |
| Notification Pod 數量 | ~500 台（100M 裝置 ÷ 200K connections/server） |
| 每台 pod 收到的 msg/sec | 10K（每個幾十 bytes） |
| 每台 pod 的工作 | 10K 次 in-memory HashMap lookup/sec |
| CPU 成本 | **可忽略** |

### Redis Pub/Sub 的 Scale

不需要按地區或 user 分片，用 **channel hash** 分散 publish 負載：

```
channel = "file_changes:" + (user_id % 16)

Redis Cluster（4 nodes）：
  Node-1: channels 0-3    ← ~2.5K publishes/sec
  Node-2: channels 4-7    ← ~2.5K publishes/sec
  Node-3: channels 8-11
  Node-4: channels 12-15

每台 Notification Pod 連到全部 4 個 Redis nodes，訂閱全部 16 channels
```

---

## 5. 關鍵 Takeaway

| 設計原則 | 應用 |
|---------|------|
| **通知與資料分離** | Notification Channel（lightweight signal）+ Data Channel（heavy payload）獨立 scale |
| **Long Polling > WebSocket**（for 中低頻場景） | 檔案同步、email、低頻更新 — 不需要 persistent connection 的複雜度 |
| **Broadcast > Sticky Routing** | 廣播到所有 pod + local HashMap lookup 的成本遠低於維護有狀態 routing 的運維成本 |
| **Channel Hash 分散 Redis 負載** | user_id % N 個 channel，每台 pod 訂閱全部 channel，Redis 節點各自處理一部分 |

### 這個 Pattern 出現在哪些系統？

- **Dropbox / Google Drive** — 檔案同步通知
- **Slack** — channel 更新通知（搭配 WebSocket）
- **Git webhook** — 通知 CI/CD 有 push → CI 自己去 fetch
- **Email client** — IMAP IDLE（本質就是 long polling）

---

## 6. File Chunking + Deduplication（Dropbox 的核心差異化）

### 上傳流程：先問再傳

```
Client:
  1. 把檔案切成 chunks（~4MB，content-defined）
  2. 每個 chunk 算 SHA-256 → 得到 hash list
  3. POST /check_hashes → [hash_A, hash_B, hash_C, hash_D]
  4. Server 回：「hash_A 和 hash_C 我已經有了，只要 B 和 D」
  5. Client 只上傳 chunk_B 和 chunk_D
```

Block Store 的結構是 **hash → bytes**（純 key-value，不關心 chunk 屬於誰）：

```
Metadata Store:
  user_123/photo.jpg → [hash_A, hash_B, hash_C, hash_D]
  user_456/photo.jpg → [hash_A, hash_B, hash_C, hash_D]  ← 指向同一組 chunks

Block Store（實際只存一份 bytes）:
  hash_A → [4MB bytes]
  hash_B → [4MB bytes]
  hash_C → [4MB bytes]
  hash_D → [4MB bytes]
```

### 兩種層級的 Dedup

| 層級 | 場景 | 效果 |
|------|------|------|
| Same-user dedup | 你把 report.pdf 從 /work 複製到 /backup | 0 bytes 上傳（所有 hash 已存在） |
| Cross-user dedup | 10 萬人都裝了 macOS Sonoma，系統檔案的 chunks 只存一份 | 節省量極驚人 |

### Chunk Size 的 Trade-off

| Chunk Size | Dedup 效果 | Metadata 量 | Delta Sync 效率 |
|------------|-----------|-------------|----------------|
| 1 MB | 高（小 chunk → 更多命中機會） | 大（1GB 檔 = 1000 條 metadata） | 好（改一點只傳 1MB） |
| **4 MB（Dropbox 選的）** | **平衡** | **平衡** | **平衡** |
| 16 MB | 低（大 chunk → 命中機會少） | 小 | 差（改一點要傳 16MB） |

### Content-Defined Chunking vs Fixed-Size Chunking

Fixed-size chunking 在檔案中間插入內容時會導致 **所有後續 chunk 偏移，hash 全變，dedup 失效**：

```
原始檔案：  [AAAA][BBBB][CCCC][DDDD]   ← 4 chunks
在開頭插入 1 byte：
Fixed-size: [xAAA][ABBB][BCCC][CDDD][D...]  ← 所有 chunk hash 都變了！

Content-defined（Rabin fingerprint）：
  用 rolling hash 找「天然斷點」（例如某段 bytes 的 hash 符合特定 pattern）
  插入 1 byte 後只影響第一個 chunk 的邊界，後面的斷點不變
  → 大部分 chunk hash 不變，dedup 保住
```

### Dedup 的安全隱患

如果攻擊者知道某檔案的 SHA-256 hash，可以「上傳」它而不需要持有檔案 — 因為 server 只檢查 hash 存不存在。

防禦：Server 在特定情況下要求 **proof-of-ownership** — 隨機挑一個 chunk，要求 client 回傳該 chunk 的某段 bytes，證明 client 真正持有這個檔案。

---

## 7. Conflict Resolution

### 偵測機制：Compare-and-Swap（CAS）

每個檔案在 Metadata Store 有 version number：

```
Client → Server:
  PUT /files/7890
  {
    expected_version: 5,       ← 我是基於 v5 修改的
    new_chunks: [hash_A, hash_C]
  }

Server 檢查：
  current_version == 5?  → 接受，version 變 6
  current_version != 5?  → 衝突！（有人在你之前改了）
```

### 衝突處理策略

| 策略 | 做法 | Dropbox 用？ | 原因 |
|------|------|-------------|------|
| Last-write-wins | 直接覆蓋先到的版本 | 不用 | 會丟資料 |
| **Conflicted copy** | 保留兩個版本，讓 user 決定 | **是** | 安全，不丟資料 |
| Auto-merge | 嘗試合併兩版本的變更 | 不用 | Binary 檔無法 merge；text merge 可能語意錯誤 |

Dropbox 選擇 conflicted copy 而非 auto-merge，因為它定位是 **file sync 而非 real-time collaboration**。Auto-merge 是 Google Docs / Notion 的領域，需要 Operational Transform（OT）或 CRDT，那是另一個設計問題。

---

## 8. Delta Sync（Chunk 內部差異傳輸）

### 問題

Chunking 已經把傳輸單位從「整個檔案」縮小到「~4MB chunk」。但如果你在一個 4MB chunk 裡只改了 100 bytes，還是要傳 4MB？

### rsync-like Rolling Checksum 算法

```
舊 chunk（Server 已有）：[............XXXX............]
新 chunk（Client 要傳）：[............YYYY............]
                                     ^^^^ 只有這裡不同

1. Server 把舊 chunk 切成小塊（e.g. 512 bytes），算每塊的 checksum
2. Client 用 rolling window 掃描新 chunk，比對 checksum
3. 匹配的部分 → 不傳（reference 舊 chunk 的 offset）
4. 不匹配的部分 → 傳 raw bytes

實際傳輸量：~100 bytes + metadata，而不是 4MB
```

### Delta Sync 的適用範圍

| 檔案類型 | 效果 | 原因 |
|---------|------|------|
| Text / Code / CSV | **極好** | 改動局部，大部分 bytes 不變 |
| 未壓縮影像（BMP） | 好 | binary 但改動局部 |
| **壓縮檔（zip, gzip, .docx）** | **幾乎無效** | 改一點 → 壓縮後整個 byte stream 都變了 |
| **加密檔案** | **完全無效** | Avalanche effect — 改一點 → 密文全變 |

---

## 9. 整體架構圖

```
┌─────────┐         ┌──────────────────┐         ┌──────────────────┐
│ Client   │──upload─▶│  Sync Service     │──write─▶│  Metadata DB     │
│ (chunk + │         │  (API Gateway)    │         │  (MySQL)         │
│  hash)   │         │                  │         │  file→chunk list │
└─────────┘         └──────┬───────────┘         └──────────────────┘
     │                      │
     │                      │──store chunks──▶ Block Store (S3 / Magic Pocket)
     │                      │                  hash → bytes (deduped)
     │                      │
     │                      │──publish event──▶ Redis Pub/Sub
     │                      │                        │
     │    ┌─────────────────┘                        │ broadcast
     │    │                                          ▼
     │    │              ┌──────────────────────────────────┐
     │    │              │  Notification Pods (stateless)    │
     │    │              │  in-memory: user → [connections]  │
     │    │              │  long poll 或 adaptive polling     │
     │    │              └──────────────────────────────────┘
     │    │                          │
     │    │           signal: "有變更" │
     │    │                          ▼
     │    │                    ┌───────────┐
     │    └─── GET /delta ◀───│  Client    │
     │         (pull changes)  │  (其他裝置) │
     │                        └───────────┘
     │                              │
     │                    GET /chunks (下載實際檔案內容)
     ▼                              ▼
  Block Store ◀─────────────────────┘
```

---

## 10. 面試策略：講述順序建議

1. **Metadata vs Block 分離** — 先畫出雙 store 架構（1 分鐘）
2. **File Chunking + Dedup** — 上傳流程、check_hashes、content-defined chunking（3 分鐘）
3. **Sync Notification** — 通知與資料分離、long polling or adaptive polling（2 分鐘）
4. **Conflict Resolution** — CAS 偵測 + conflicted copy 處理（1 分鐘）
5. **Delta Sync** — rolling checksum、適用範圍限制（1 分鐘，加分項）
