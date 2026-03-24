# Confusion Ledger - Blind Spot & Misconception Tracker

> This ledger is automatically updated after each deep-dive session.
> Review entries periodically to reinforce corrections and close knowledge gaps.

| 日期 | 主題 | 我的盲區/錯誤認知 | 核心正解 (一句話點醒) | 複習建議 |
|------|------|-------------------|----------------------|----------|
| 2026-03-17 | (範例) Message Queue | 以為 Kafka 是「推送」模型，適合低延遲即時通知 | Kafka 是 Pull-based append-only log，Consumer 主動拉取；低延遲推送場景應考慮 RabbitMQ 或專用 Pub/Sub | 重讀 `components/message_queue.md` 的底層實作差異段落，畫出 Kafka Consumer Group 的 polling 流程 |
| 2026-03-20 | Kafka Partition | 對 Broker、Topic、Partition 三者的關係不夠清晰；以為需要手動指定 partition 放在哪個 broker | Broker 是物理機器，Topic 是邏輯分類，Partition 是平行處理單位。Kafka 自動將 partition 分散到 broker，你只需設定 partition 數量和 replication factor | 重讀 `components/message_queue.md` Kafka 段落，畫出 3 broker × 3 partition × RF=3 的分佈圖 |
| 2026-03-20 | Kafka Partition Scaling | 想用 consistent hashing 解決 partition 動態擴展的問題 | Consistent hashing 解決的是「搬移少量資料」，但 Kafka 的核心問題是 append-only log 不搬移舊資料，加 partition 後同一 key 的 event 分散在兩個 partition，順序斷裂無法拼回。正解是一開始就開足夠多的 partition（預期 consumer 數的 2-3 倍） | 思考：如果必須加 partition，什麼情境可以直接加（不依賴 key ordering）、什麼情境需要 topic migration |
| 2026-03-25 | Ticketmaster — Redis TTL | 沒想到用 Redis TTL 管理時效性狀態（如座位鎖定 15 分鐘過期自動釋放） | Redis TTL 是管理 temporary state 的基本手段：設定 key 時附帶 TTL，過期自動刪除，不需要額外的 cron job 或 timer。座位鎖定、購物車保留、OTP 驗證碼等「有時效性的狀態」都適用 | 遇到「某狀態需要在 N 分鐘後自動失效」的需求時，第一反應應該是 Redis TTL |
| 2026-03-25 | Ticketmaster — CDN 加速 | 沒想到對 event/票務資訊掛 CDN cache | 票務系統的 event 頁面（演出資訊、場地圖、票價階層）是 read-heavy 且更新頻率低的內容，非常適合 CDN cache + 短 TTL 或 SWR。開賣瞬間的流量 spike 大部分是讀取 event 資訊，CDN 可以擋掉 90%+ 的 origin 請求 | 設計 read-heavy 系統時，先問「哪些資料可以 CDN cache？」——靜態資訊（商品頁、活動頁）幾乎都可以 |
| 2026-03-25 | Ticketmaster — 即時狀態推送 | 沒想到需要用 WebSocket/SSE 即時更新 client 的票務狀態 | 使用者選位後等待付款、其他人搶同一區的座位——這些狀態變更需要即時推送到 client。不用 bidirectional connection 的話，client 只能 polling，體驗差且浪費資源。SSE 適合這種 server → client 單向推送場景 | 遇到「使用者需要看到即時狀態變更」的需求時，主動考慮 WebSocket（雙向）或 SSE（單向推送） |
