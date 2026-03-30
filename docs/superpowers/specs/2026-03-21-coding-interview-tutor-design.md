# Coding Interview Tutor — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Author:** Claude + User

---

## 1. Problem Statement

使用者正在準備 Senior SWE 面試（主要目標：Google, Apple, Nvidia, Microsoft, Netflix 等 Tier 1 公司），LeetCode rating ~2000，能穩定解 medium 但 hard 不穩定。

LeetCode 提供了優秀的題庫和練習環境，但缺乏：
- **個人盲區追蹤**：你反覆卡在哪些 pattern、為什麼卡住
- **知識策展**：用你自己能記住的方式組織 pattern 和觀念
- **Roadmap 進度追蹤**：需要熟悉哪些 pattern、目前到哪了
- **面試前速查**：面試前 30 分鐘能快速掃一遍的個人化 cheat sheet

本專案建立一個 AI-assisted 的學習系統，補齊這個「元認知層」。

## 2. Goals & Non-Goals

### Goals
- 建立結構化的 pattern roadmap，以 Google 面試難度為基準
- 每個 pattern 有固定結構的筆記（觀念 → 識別信號 → 模板 → 陷阱 → 經典題）
- 自動追蹤使用者的盲區和錯誤認知（confusion ledger）
- 從個人踩坑紀錄萃取面試前 cheat sheet
- 部署 GitHub Pages 複習網站，支援進度追蹤和複習推薦
- 支援四種互動模式：主題學習、刷題覆盤、即時卡關、複習測驗

### Non-Goals
- 不取代 LeetCode（不提供 OJ 環境或自動判題）
- 不做 AI/ML 特化面試準備（降級為加分項）
- 不做 system design 內容（已有獨立 repo）

## 3. Interaction Model

### 模式 1：主題學習 —「我們今天來討論 [pattern]」
- 評估使用者對該 pattern 的理解程度
- 用 2-3 道經典題由淺到深建立直覺
- 記錄卡住的點
- 結束後更新：pattern 筆記 → confusion ledger → cheat sheet → roadmap 狀態

### 模式 2：刷題覆盤 —「我剛做了 LC XXX，卡在 [某個點]」
- 釐清卡住原因（觀念不清？邊界條件？沒想到 pattern？）
- 歸類到對應 pattern
- 更新 confusion ledger + cheat sheet

### 模式 3：即時卡關 —「我卡在這題，想不出來」
- 先用提示引導（不直接給答案）
- 提示兩輪仍卡住才給完整思路
- 記錄卡住原因

### 模式 4：複習測驗 —「幫我複習」/「review」
- 列出 confusion ledger 中「需複習」項目
- 挑 2-3 個問targeted questions 測試修正程度
- 通過 → 標記「已修正」；未通過 → 保留

### 自動行為（不需使用者觸發）

| 觸發條件 | 自動動作 |
|----------|---------|
| 討論中發現盲區 | 更新 confusion ledger |
| 討論完一個 pattern | 更新 pattern 筆記 + cheat sheet + roadmap 狀態 |
| 使用者說「幫我整理」 | 整理到 deep_dives/ |
| 討論涉及資料結構細節 | 更新 data_structures/ 對應筆記 |

## 4. Repo Structure

```
coding-interview-tutor/
├── CLAUDE.md                          # AI tutor 指令（coding interview 專用）
├── README.md
├── roadmap.md                         # Pattern roadmap + 進度 + Tier 分級
├── patterns/                          # 每個 pattern 一個 md
│   ├── sliding_window.md
│   ├── two_pointers.md
│   ├── monotonic_stack.md
│   └── ...
├── data_structures/                   # 資料結構深入筆記
│   ├── heap.md
│   ├── trie.md
│   ├── union_find.md
│   └── ...
├── cheatsheets/
│   └── master.md                      # 面試前速查總表
├── assessments/
│   └── confusion_ledger.md            # 盲區追蹤
├── deep_dives/                        # 每次討論整理
└── web/                               # 複習網站 (Vite + React + Tailwind)
    └── ...                            # GitHub Pages 部署
```

## 5. Content Formats

### 5.1 Pattern File（`patterns/*.md`）

```markdown
---
last_updated: 2026-03-21
status: 學習中
tier: 1
---

# [Pattern Name]

## 核心觀念
一句話說明這個 pattern 在做什麼、為什麼有效。

## 識別信號
什麼時候該想到用這個 pattern？2-3 個明確的題目特徵。

## 程式模板
Python generalized template，附上每一行的作用。

## 複雜度
Time / Space，以及為什麼。

## 常見陷阱
最容易犯的錯，特別標注個人踩過的坑。

## 變體
常見變形（例如 fixed window vs. dynamic window）。

## 經典題
| 題目 | 難度 | 關鍵考點 | 我的狀態 |
|------|------|---------|---------|
| LC 76 Minimum Window Substring | Hard | 收縮條件 | 需複習 |
```

### 5.2 Roadmap（`roadmap.md`）

以 Google L4/L5 面試為基準，分三個 tier。使用 YAML frontmatter 儲存結構化資料，方便網站 parse：

```markdown
---
last_updated: 2026-03-21
---

# Coding Interview Roadmap

## Tier 1 — 必須精通
> 面試高頻，必須 15 分鐘內解完

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|
| Sliding Window | 學習中 | 2026-03-21 | 5 | [patterns/sliding_window.md](patterns/sliding_window.md) |
| Two Pointers | 未開始 | — | 0 | — |

## Tier 2 — 需要熟練
> 經常出現，需穩定解出

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|

## Tier 3 — 了解即可
> 偶爾出現，知道方向就好

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|
```

狀態值：`未開始` / `學習中` / `需複習` / `已掌握`

### 5.3 Master Cheat Sheet（`cheatsheets/master.md`）

面試前 30 分鐘掃一遍的濃縮版。每個條目一兩行，全部來自個人踩坑紀錄：

```markdown
## Sliding Window
- 收縮條件：window 滿足條件時才收縮，不是每次都收
- 更新 ans 的時機是在收縮 loop 裡面，不是外面

## Binary Search
- lo < hi vs lo <= hi：看你要找的是值還是邊界
- 我常犯：mid 算完忘記 +1/-1 導致無限迴圈
```

每條旁邊有 link 可跳到完整 pattern 筆記。

### 5.4 Data Structure File（`data_structures/*.md`）

```markdown
# [Data Structure Name]

## 核心概念
這個資料結構是什麼、解決什麼問題。

## 操作複雜度

| 操作 | 平均 | 最差 | 備註 |
|------|------|------|------|
| Insert | O(log n) | O(log n) | — |
| Delete | O(log n) | O(log n) | — |
| Search | O(1) | O(1) | peek only |

## 什麼時候用
2-3 個明確的使用場景和識別信號。

## 實作重點
語言內建支援（Python heapq, collections.deque 等）和需要注意的實作細節。

## 常見陷阱
個人踩過的坑。

## 相關 Patterns
這個資料結構最常搭配哪些 pattern 使用。
```

### 5.5 Confusion Ledger（`assessments/confusion_ledger.md`）

| 日期 | 主題 | 我的盲區/錯誤認知 | 核心正解 | 狀態 | 複習建議 |
|------|------|-------------------|---------|------|---------|

狀態：`需複習` / `已修正`

## 6. Website Design

技術棧：Vite + React + Tailwind CSS，部署到 GitHub Pages。

### 6.1 頁面結構

**Dashboard（首頁）**
- Roadmap progress bar / grid：一眼看到每個 pattern 狀態
- 「今天該複習什麼」推薦區（V1 演算法：列出 confusion ledger 中狀態為「需複習」的項目，按日期升序排列，最舊的優先。不做 spaced repetition 邏輯）
- 最近更新的筆記

**Roadmap 頁**
- 三個 Tier 分區，每個 pattern 一張卡片
- 卡片：pattern 名稱、狀態 badge、關聯題數、上次學習日期
- 點擊跳到 pattern 筆記

**Pattern 筆記頁**
- 渲染 `patterns/*.md`
- 語法高亮 code block（Python）
- 經典題表格可按難度/狀態篩選
- 側邊欄顯示同 tier 其他 pattern

**Data Structures 頁**
- 渲染 `data_structures/*.md`
- 偏向操作複雜度 + 使用時機

**Cheat Sheet 頁**
- 渲染 `cheatsheets/master.md`
- 高密度、可快速掃描的排版（reference card 風格，非文章式）
- 按 pattern 篩選
- 每條有 link 跳到完整筆記

**Confusion Ledger 頁**
- 表格渲染 `assessments/confusion_ledger.md`
- 按主題、日期、狀態篩選

**Deep Dives 頁**
- 討論整理筆記列表，按日期排序

### 6.2 與 system-design-tutor 網站的差異

| | system-design-tutor | coding-interview-tutor |
|---|---|---|
| 核心頁面 | Components 列表 | Roadmap + Progress |
| 內容單位 | 技術比較（trade-off matrix） | Pattern（模板 + 題目 + 陷阱） |
| 新增功能 | 無 | 進度追蹤、複習推薦、狀態篩選、Cheat Sheet |
| Code 需求 | 少，偏架構圖 | 大量，需語法高亮 |

## 7. Tech Stack

- **Content**: Markdown files in repo
- **Website**: Vite + React + Tailwind CSS
- **Markdown rendering**: remark / rehype (同 system-design-tutor)
- **Syntax highlighting**: rehype-highlight 或 shiki
- **Deployment**: GitHub Pages via GitHub Actions
- **AI Tutor**: Claude Code with CLAUDE.md

## 8. CLAUDE.md Design

CLAUDE.md 定義 AI tutor 的行為，核心要素：

- **Role**: Coding interview 導師，以 Google L4/L5 為標準
- **語言**: 繁體中文，技術名詞用英文
- **四種互動模式**（見 Section 3）
- **自動行為**（見 Section 3）
- **不直接給答案**（模式 3），先引導再揭示
- **每次討論結束自動更新**：pattern 筆記、confusion ledger、cheat sheet、roadmap 狀態
