# Confusion Ledger - Blind Spot & Misconception Tracker

> This ledger is automatically updated after each deep-dive session.
> Review entries periodically to reinforce corrections and close knowledge gaps.

| 日期 | 主題 | 我的盲區/錯誤認知 | 核心正解 (一句話點醒) | 複習建議 |
|------|------|-------------------|----------------------|----------|
| 2026-03-17 | (範例) Message Queue | 以為 Kafka 是「推送」模型，適合低延遲即時通知 | Kafka 是 Pull-based append-only log，Consumer 主動拉取；低延遲推送場景應考慮 RabbitMQ 或專用 Pub/Sub | 重讀 `components/message_queue.md` 的底層實作差異段落，畫出 Kafka Consumer Group 的 polling 流程 |
