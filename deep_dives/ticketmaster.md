# Ticketmaster — 票務系統架構

## 1. 核心挑戰

票務系統的難度集中在 **開賣瞬間的流量 spike**：

```
平時：   ~1K QPS（瀏覽活動頁、查詢票價）
開賣瞬間：~100K+ QPS（大量用戶同時搶票）
持續時間：  幾分鐘內票就賣完

特性：
- 極端的 read-heavy（100:1 read/write）
- 極短時間的 write spike（搶票 = 高併發寫入）
- 每張票是唯一資源（不能超賣）
- 強一致性需求（同一張票不能賣給兩個人）
```

---

## 2. 整體架構

```
                        CDN（event 頁面、靜態資源）
                         │
                     ┌───┴────┐
User ──▶ LB ──▶     │ API GW │ ──▶ Rate Limiter / Waiting Room
                     └───┬────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    Event Service   Booking Service  Payment Service
    (read-heavy)    (write-heavy)    (external gateway)
          │              │              │
          ▼              ▼              ▼
    Event DB        Redis (seat lock) Ledger DB
    (read replicas) + Inventory DB    (transaction log)
                         │
                         ▼
                    Notification
                    (SSE → client)
```

---

## 3. 流量管控：CDN + Waiting Room

### CDN 擋住 90%+ 的讀取流量

開賣瞬間大部分請求是 **讀取 event 資訊**（場地圖、票價、剩餘座位概況），不是真的在買票。

```
Event 頁面（演出資訊、場地圖、票價階層）：
  → CDN cache + 短 TTL（30s）或 Stale-While-Revalidate
  → 100K 人同時看頁面，只有 1 個 request 打到 origin

座位可用概況（section-level，非 exact seat）：
  → CDN cache + 5-10s TTL（允許短暫不精確）
  → 精確的座位鎖定狀態走 API，不經 CDN
```

**設計原則：把「讀瀏覽資訊」和「寫搶票」的流量分開處理。CDN 解決前者，後端只需要扛後者。**

### Waiting Room（虛擬排隊）

CDN 擋不住的是「點擊購買」的寫入請求。用 Waiting Room 削峰：

```
1. 開賣前 5 分鐘，使用者進入 Waiting Room（排隊頁面）
2. 系統發放 queue token，隨機排序（不是先到先得，防 bot）
3. 每次放行 N 人進入選位頁面（N = Booking Service 可承受的 QPS）
4. 進入選位頁面後有 15 分鐘時限（見下方 Redis TTL）

效果：
  100K 人同時搶票 → Waiting Room 控制為 ~1K 人同時在選位
  Booking Service 只需承受 1K 併發，而非 100K
```

---

## 4. 座位鎖定：Redis TTL

### 問題

使用者選了座位但還沒付款 → 這段時間座位要被「鎖住」，不能讓別人選。但如果使用者放棄了（關閉頁面、付款超時），座位要自動釋放。

### Redis TTL 解法

```
使用者選座位 A3：
  SETEX seat:event_789:A3 900 "{user_id: 123, locked_at: ...}"
  （TTL = 900 秒 = 15 分鐘）

其他人嘗試選 A3：
  SETNX seat:event_789:A3 → 失敗（key 已存在）→ 告知「座位已被選」

15 分鐘後未付款：
  Redis 自動刪除 key → 座位自動釋放
  不需要 cron job、timer、或 cleanup service

付款成功：
  DEL seat:event_789:A3（移除鎖定）
  寫入 Inventory DB：seat A3 → sold to user_123
```

### 為什麼用 Redis 而非 DB Lock？

| | Redis SETNX + TTL | DB Row Lock |
|---|---|---|
| 延遲 | < 1ms | 5-20ms |
| TTL 管理 | 內建自動過期 | 需要額外 scheduler 檢查逾時 |
| 併發能力 | 100K+ ops/sec per node | 受限於 DB connection pool |
| 適合 | 短暫鎖定（分鐘級） | 長期狀態持久化 |

**Redis 管鎖定（temporary state），DB 管最終狀態（permanent state）。**

---

## 5. 購票流程：防止超賣

### 完整 Flow

```
1. 使用者選座位 → Redis SETNX（鎖定 15 min）
   ├── 成功 → 進入付款流程
   └── 失敗 → 「座位已被選」

2. 使用者付款 → Payment Service 呼叫 payment gateway
   ├── 付款成功：
   │     ① 寫入 Inventory DB（seat → sold, idempotency_key 防重複）
   │     ② DEL Redis lock
   │     ③ 發送確認 email / push notification
   └── 付款失敗：
         ① DEL Redis lock（立即釋放，不用等 TTL）
         ② 通知使用者重試或選其他座位

3. TTL 到期（使用者放棄）：
   Redis 自動刪除 → 座位回到可選狀態
```

### 防超賣的關鍵

```
Inventory DB 寫入用 optimistic lock：

UPDATE seats
SET status = 'sold', buyer_id = 123
WHERE event_id = 789 AND seat_id = 'A3' AND status = 'available';

affected_rows == 1 → 成功
affected_rows == 0 → 座位已被賣（race condition 極端情況）→ 退款
```

Redis lock 是第一道防線（soft lock），DB 是最終防線（hard lock）。即使 Redis 出問題，DB 的 optimistic lock 保證不會超賣。

---

## 6. 即時狀態推送：SSE

### 為什麼需要？

```
場景 1：你在選位頁面，別人剛買走了旁邊的座位
  → 你的座位圖需要即時更新

場景 2：你鎖了座位正在付款，倒計時剩 2 分鐘
  → 你需要看到倒計時（server-side timer 為準）

場景 3：大量座位在幾分鐘內被搶光
  → 前端需要即時反映剩餘數量
```

### SSE vs WebSocket

| | SSE | WebSocket |
|---|---|---|
| 方向 | Server → Client（單向） | 雙向 |
| 協議 | HTTP（穿越防火牆容易） | 獨立協議（需要 upgrade） |
| 重連 | 瀏覽器內建自動重連 | 需要自己實作 |
| 適合 | **座位狀態更新（server push）** | 聊天、協作編輯 |

票務場景是典型的 server → client 單向推送，SSE 就夠了。

### 推送架構

```
Booking Service（seat sold / released）
  │
  │  publish event
  ▼
Message Queue（Kafka / Redis Pub/Sub）
  │
  │  consume
  ▼
SSE Gateway（per-event subscription）
  │
  │  push to connected clients
  ▼
Client（更新座位圖、倒計時）
```

---

## 7. 資料模型

```sql
-- Events（活動）
events:
  event_id, name, venue_id, date, status, total_seats, available_seats

-- Venues（場地）
venues:
  venue_id, name, layout_json (座位圖)

-- Seats（座位 — 核心 inventory）
seats:
  seat_id, event_id, section, row, number, price_tier,
  status (available / locked / sold),
  buyer_id, locked_at, sold_at

-- Bookings（訂單）
bookings:
  booking_id, user_id, event_id, seat_ids[],
  status (pending / confirmed / cancelled),
  payment_id, idempotency_key, created_at

-- Payments（付款紀錄）
payments:
  payment_id, booking_id, amount, gateway_ref,
  status (pending / success / failed / refunded)
```

---

## 8. 容量估算

假設一場 50,000 座位的熱門演唱會：

| 指標 | 估算 |
|------|------|
| 同時在線人數 | ~500K（競爭率 10:1） |
| Event 頁面 QPS | ~100K → CDN 擋掉 95%+ → Origin ~5K QPS |
| Waiting Room 放行速率 | ~1K 人/批 |
| Booking Service QPS | ~1K（被 Waiting Room 控制） |
| Redis 座位鎖定 QPS | ~2K（SETNX + 查詢 + DEL） |
| SSE 連線數 | ~50K（進入選位頁面的人） |
| 售完時間 | ~5-15 分鐘 |
| 資料量 | 50K seats × 200 bytes = 10MB（非常小） |

---

## 9. 你的盲區紀錄（from confusion ledger）

| 盲區 | 核心修正 |
|------|---------|
| 沒想到 Redis TTL 管理座位鎖定 | 「N 分鐘後自動失效」的需求 → 第一反應 Redis TTL |
| 沒想到 CDN cache event 頁面 | Read-heavy 系統先問「哪些資料可以 CDN cache？」 |
| 沒想到 SSE 即時推送座位狀態 | 「使用者需要看到即時狀態變更」→ SSE（單向推送）或 WebSocket（雙向） |

---

## 10. 面試策略：講述順序建議

1. **需求釐清 + 容量估算**（1 分鐘）— 多少人搶、多少座位、幾分鐘內賣完
2. **CDN + Waiting Room 削峰**（2 分鐘）— 先解決流量問題，否則後面都沒意義
3. **座位鎖定 Redis TTL + 防超賣**（3 分鐘）— 核心 write path，SETNX + DB optimistic lock 雙層防線
4. **購票流程 + 付款**（2 分鐘）— happy path + 失敗處理 + idempotency
5. **SSE 即時狀態**（1 分鐘）— 座位圖更新、倒計時
6. **Scale / 可靠性**（1 分鐘）— Redis cluster、DB read replicas、Kafka decouple
