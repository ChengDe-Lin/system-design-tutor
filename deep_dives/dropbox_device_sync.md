# Dropbox — 跨裝置同步的通知架構

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
