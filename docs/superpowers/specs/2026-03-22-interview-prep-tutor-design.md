# Interview Prep Tutor — Design Spec

**Date:** 2026-03-22
**Status:** Approved
**Author:** Claude + User

---

## 1. Problem Statement

使用者已有 coding-interview-tutor 和 system-design-tutor 兩個結構化準備系統，但缺少面試準備的第三根支柱：Behavioral Interview & Career Presentation。

具體缺口：
- **Self-introduction / Pitch**：沒有結構化的英文自我介紹，需要從零開始與 tutor 共同撰寫並持續迭代
- **Story Bank**：過去的工作經驗沒有用 STAR 格式整理成可覆用的故事
- **BQ Practice**：沒有系統化的 behavioral question 練習和 feedback 機制
- **Company-Specific Prep**：沒有針對不同公司調整 pitch 和故事選擇的流程

本專案建立一個 AI 教練系統，透過對話式互動逐步萃取、打磨、練習這些內容。

## 2. Goals & Non-Goals

### Goals
- 透過漸進式對話從使用者的經歷中萃取英文 pitch（通用版 + 精簡版）
- 建立 STAR 格式的 story bank，每個故事標注適用的 BQ 類型
- 支援針對特定公司調整 pitch 和故事選擇
- 支援 mock interview 模式（tutor 扮演面試官，給 feedback）
- 部署輕量 GitHub Pages 網站作為「面試前速查頁面」，手機可看
- Repo 公開展示結構化準備（個人策略性內容 gitignore）

### Non-Goals
- 不做 coding interview 或 system design 內容（已有獨立 repo）
- 不做 progress tracking 或 confusion ledger（對 BQ prep 沒意義）
- 不做密碼保護或 access control（repo 和網站都公開）
- 不做 salary negotiation 工具（情境式，不需要系統化）

## 3. Interaction Model

### 模式 1：Pitch Crafting —「幫我寫 pitch」/「我們來寫自我介紹」

**第一次：**
1. 讀使用者的履歷（`resume/ChengDe_2026.pdf`）
2. 請使用者用中文隨意介紹自己
3. 追問 impressive 的點（「這個 75% 怎麼算的？」「專利的想法是誰提的？」）
4. 萃取成英文 pitch draft
5. 產出兩個版本：
   - `pitch/general.md`（2 分鐘完整版）
   - `pitch/short.md`（30 秒 elevator pitch）

**後續：**
- 讀現有 pitch，問有沒有新想法或經歷
- 持續迭代改進
- 每次修改記錄在 pitch 檔案的版本紀錄中

### 模式 2：Company-Specific —「我要面 [公司名]」

1. 搜尋這間公司的文化、values、技術棧、面試風格
2. 將搜尋結果整理到 `company_research/{company}.md`（事實性內容，公開）
3. 讀使用者現有的 general pitch 和 story bank
4. 建議哪些故事對這間公司最有效、pitch 怎麼調整
5. 產出 `pitch/companies/{company}.md`（包含策略性建議，gitignored）

### 模式 3：Story Mining —「我們來整理故事」

1. 讀使用者的履歷，針對每個 bullet point 追問細節
2. 用 STAR 格式整理成故事，存到 `stories/{story_name}.md`
3. 標注適用的 BQ 類型
4. 更新 `bq_categories.md` 索引表

### 模式 4：Mock Interview —「模擬面試」

1. 扮演面試官，問 BQ（可指定公司風格或隨機）
2. 使用者回答（可用中文，tutor 幫轉英文）
3. 給 feedback：
   - 太長/太短
   - 缺少 specific example
   - 沒有量化 result
   - 缺少 impact 或 learnings
   - STAR 結構是否完整
4. 記錄到 `mock_sessions/{date}_{company_or_topic}.md`（gitignored）

### 模式 5：Pre-Interview Review —「我明天要面 [公司]」

1. 拉出該公司的 pitch 版本（如果有）或 general pitch
2. 列出推薦故事（根據該公司常問的 BQ 類型）
3. 顯示 company research 重點
4. 問使用者要不要再練一次特定 BQ

### 自動行為（不需使用者觸發）

| 觸發條件 | 自動動作 |
|----------|---------|
| 討論中挖出新故事 | 存到 stories/ + 更新 bq_categories.md |
| Pitch 有修改 | 更新版本紀錄 |
| 提到新公司 | 提議建立 company research |
| 使用者說「幫我整理」 | 整理當前討論到對應檔案 |

## 4. Repo Structure

```
interview-prep-tutor/
├── .gitignore                         # pitch/companies/, mock_sessions/
├── CLAUDE.md                          # AI 教練指令
├── README.md                          # Project overview
├── resume/
│   ├── resume_notes.md                # 履歷分析 + 改進建議
│   └── ChengDe_2026.pdf              # 履歷原檔
├── pitch/
│   ├── general.md                     # 通用版 self-intro（2 分鐘）
│   ├── short.md                       # 精簡版（30 秒 elevator pitch）
│   └── companies/                     # [GITIGNORED] 公司特化版（含策略）
│       ├── google.md
│       └── ...
├── stories/
│   ├── _template.md                   # STAR 格式模板
│   └── ...                            # 每個故事一個檔案
├── bq_categories.md                   # BQ 類型 → 對應故事索引
├── company_research/                  # 公司研究（事實性，公開）
│   └── ...
├── mock_sessions/                     # [GITIGNORED] Mock interview 紀錄
│   └── ...
└── web/                               # 輕量面試前速查網站
```

### Gitignore 策略

| 目錄/檔案 | 公開？ | 理由 |
|----------|--------|------|
| `CLAUDE.md` | 公開 | 展示 AI 教練設計 |
| `pitch/general.md` | 公開 | 展示準備品質 |
| `pitch/short.md` | 公開 | 同上 |
| `pitch/companies/` | gitignore | 針對性策略，不公開 |
| `stories/` | 公開 | 展示結構化思維 |
| `resume/` | 公開 | 本來就在投的東西 |
| `company_research/` | 公開 | 事實性內容，展示有做功課 |
| `bq_categories.md` | 公開 | 展示結構化準備 |
| `mock_sessions/` | gitignore | 練習紀錄不公開 |

## 5. Content Formats

### 5.1 Pitch Files（`pitch/general.md`, `pitch/short.md`）

```markdown
# Self Introduction — General (2 min)

## English Version

[完整英文 pitch]

## 中文參考

[中文版本，方便自己理解和修改]

## Key Talking Points
- 強調的重點 1
- 強調的重點 2

## 版本紀錄

| 日期 | 修改內容 |
|------|---------|
| 2026-03-22 | 初版 |
```

### 5.2 Story Files（`stories/*.md`）

```markdown
# [Story Title]

## 適用 BQ 類型
- Leadership / Influence without authority
- Technical decision-making

## Situation
1-2 句交代背景。

## Task
你的具體責任是什麼。

## Action
你做了什麼（具體步驟）。

## Result
量化結果。

## Key Talking Points
- 面試時要強調的重點
- 如果面試官追問 X，怎麼答

## 版本紀錄

| 日期 | 修改內容 |
|------|---------|
```

### 5.3 BQ Categories（`bq_categories.md`）

```markdown
# BQ Categories → Story Index

> 每個 BQ 類型對應 2-3 個推薦故事，確保不同面試官問到同類問題時有不同故事可用。

| BQ 類型 | 常見問法 | 推薦故事 |
|---------|---------|---------|
| Leadership | "Tell me about a time you led a project..." | — |
| Conflict | "Describe a disagreement with a coworker..." | — |
| Failure | "Tell me about a time you failed..." | — |
| Impact | "What's your biggest technical achievement?" | — |
| Ambiguity | "How do you handle unclear requirements?" | — |
| Customer Focus | "How do you advocate for the user?" | — |
| Growth | "Tell me about something you learned recently..." | — |
| Trade-offs | "Describe a difficult technical decision..." | — |
```

### 5.4 Company Research（`company_research/*.md`）

```markdown
# [Company Name]

## Company Overview
- 主要產品/服務
- 技術棧
- 工程文化

## Core Values
- Value 1: 說明
- Value 2: 說明

## Recent News / Projects
- 最近的大動作、收購、產品發布

## Interview Style
- 面試流程（幾輪、什麼類型）
- BQ 常問什麼類型

## 最後更新
YYYY-MM-DD
```

### 5.5 Company Pitch（`pitch/companies/*.md`）[GITIGNORED]

```markdown
# Pitch — [Company Name]

## 調整策略
- 這間公司在意什麼 → 我的 pitch 要強調什麼

## Adjusted Pitch

[針對這間公司修改的英文版本]

## 推薦故事

| BQ 類型 | 推薦故事 | 為什麼適合這間公司 |
|---------|---------|-----------------|
```

### 5.6 Mock Session（`mock_sessions/*.md`）[GITIGNORED]

```markdown
# Mock Interview — [Company/Topic] — [Date]

## Questions & Responses

### Q1: [BQ Question]
**我的回答：**
...
**Feedback：**
- 優點：...
- 改進：...

### Q2: ...

## Overall Assessment
- 表現好的地方
- 需要加強的地方
- 下次練習建議
```

## 6. Website Design

技術棧：Vite + React + TypeScript，部署到 GitHub Pages。

### 設計原則
- **極簡**：只有面試前 10 分鐘需要看的東西
- **手機友好**：主要使用場景是面試前在手機上快速掃一遍
- **不做 Dashboard 或 progress tracking**

### 頁面結構

**Quick Review（首頁）**
- **Elevator Pitch（30 秒版）** — 最上面，一眼掃完
- **Full Pitch（2 分鐘版）** — 完整自我介紹
- **Story Bank 總覽** — 每個故事的標題 + 適用 BQ 類型，點進去看完整 STAR
- **面試前提醒** — 幾條 key reminders（硬編碼，例如「Ask follow-up questions」「Use specific numbers」「STAR structure」）

**Company View**
- 側邊欄或下拉選單選公司
- 顯示：company research 重點摘要（來自公開的 `company_research/`）
- 推薦故事列表（從 bq_categories 交叉比對）
- 如果某公司還沒準備，顯示空狀態：「還沒準備這間公司。跟 tutor 說『我要面 [公司]』開始準備。」

**注意：** `pitch/companies/` 是 gitignored 的，GitHub Pages 部署的網站不會包含這些檔案。Company View 在部署版只顯示公開的 company research + general pitch。完整的公司特化 pitch 只有在本地 `npm run dev` 時才會出現（`import.meta.glob` 會在本地 build 時讀到這些檔案）。網站需要 gracefully handle 這些檔案不存在的情況。

**Story Detail（點進某個故事）**
- 渲染完整 STAR 格式 markdown
- Key talking points 突出顯示

### 與前兩個網站的差異

| | system-design / coding | interview-prep |
|---|---|---|
| 頁面數量 | 7 頁 | 2-3 頁 |
| 核心功能 | 知識複習 + 進度追蹤 | 面試前速查 |
| 內容量 | 大量筆記 | 少量精煉內容 |
| 使用場景 | 學習時瀏覽 | 面試前 10 分鐘 |

## 7. Tech Stack

- **Content**: Markdown files in repo
- **Website**: Vite + React + TypeScript
- **Markdown rendering**: react-markdown, remark-gfm, rehype-raw, rehype-highlight, highlight.js（同 coding-interview-tutor）
- **Styling**: Vanilla CSS with CSS custom properties, dark theme（同前兩個 repo — 均使用 vanilla CSS，Tailwind 安裝但未使用）
- **Deployment**: GitHub Pages via GitHub Actions
- **AI Tutor**: Claude Code with CLAUDE.md

## 8. CLAUDE.md Design

CLAUDE.md 定義 AI 教練的行為，核心要素：

- **Role**: 面試教練與 pitch 策展人，不是面試官
- **語言**: 討論用繁體中文，產出的 pitch 和故事用英文。使用者回答 BQ 可以用中文，tutor 幫轉英文。
- **五種互動模式**（見 Section 3）
- **自動行為**（見 Section 3）
- **漸進式萃取**：不要一次問太多，每次討論挖一個故事或改進一個 pitch 段落
- **Feedback 要具體**：不說「太籠統」，說「你說『improved efficiency』但沒有數字 — 是提升了多少？怎麼量的？」
- **讀履歷**：第一次互動時讀 `resume/ChengDe_2026.pdf`，了解使用者背景
- **搜尋公司資訊**：模式 2 時主動搜尋公司文化、values、技術棧、面試風格
