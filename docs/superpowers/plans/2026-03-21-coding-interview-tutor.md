# Coding Interview Tutor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal coding interview knowledge base with a review website, deployed to GitHub Pages.

**Architecture:** New repo at `/Users/chengde_lin/coding-interview-tutor`. Markdown files (patterns, data structures, cheat sheets, confusion ledger, roadmap) are the source of truth. A Vite + React static site reads these files at build time via `import.meta.glob`, parses YAML frontmatter with a lightweight custom parser (no `gray-matter` — it has Node.js dependencies that break in the browser), and renders them with `react-markdown` + `rehype-highlight` for syntax highlighting. Navigation is state-based (no React Router). GitHub Actions deploys to GitHub Pages on push to main.

**Tech Stack:** Vite 5, React 18, TypeScript, react-markdown, remark-gfm, rehype-raw, rehype-highlight, highlight.js, GitHub Actions, GitHub Pages

**IMPORTANT — Agent instructions for large files:** Tasks 4-9 describe CSS and React components without providing full code (because they are 100-700 lines each). The implementer agent MUST read the reference system-design-tutor web app at `/Users/chengde_lin/system-design-tutor/web/src/` to understand patterns, then write complete code following the spec requirements and CSS class names defined in this plan. Reference the existing `App.tsx` (944 lines) and `index.css` (667 lines) for style and structure.

**Spec:** `/Users/chengde_lin/system-design-tutor/docs/superpowers/specs/2026-03-21-coding-interview-tutor-design.md`

**Reference:** Existing system-design-tutor web app at `/Users/chengde_lin/system-design-tutor/web/` — follow the same patterns (import.meta.glob, react-markdown, vanilla CSS dark theme, state-based navigation) but with a componentized file structure.

---

## File Structure

```
/Users/chengde_lin/coding-interview-tutor/
├── .github/workflows/deploy.yml       # GitHub Actions → GitHub Pages
├── CLAUDE.md                          # AI tutor instructions
├── README.md                          # Project overview
├── roadmap.md                         # Pattern roadmap with tier tables
├── patterns/                          # One md per pattern (with frontmatter)
│   └── _template.md                   # Template for new patterns
├── data_structures/                   # One md per data structure
│   └── _template.md                   # Template for new data structures
├── cheatsheets/
│   └── master.md                      # Cheat sheet (initially empty structure)
├── assessments/
│   └── confusion_ledger.md            # Blind spot tracker
├── deep_dives/                        # Session notes (initially empty)
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── postcss.config.js
    ├── tailwind.config.js
    └── src/
        ├── main.tsx                   # React entry point
        ├── vite-env.d.ts              # Vite client types + *.md module declaration
        ├── index.css                  # All styling (dark theme, layout, prose)
        ├── types.ts                   # Shared TypeScript types
        ├── data.ts                    # Markdown loading, frontmatter parsing, data transforms
        ├── App.tsx                    # Layout shell, sidebar, navigation state, page routing
        └── pages/
            ├── Dashboard.tsx          # Progress overview + review recommendations
            ├── Roadmap.tsx            # Tier sections with pattern cards
            ├── ArticleView.tsx        # Markdown rendering + TOC + syntax highlight
            ├── CheatSheet.tsx         # Dense reference card layout
            └── ConfusionLedger.tsx    # Table rendering with status filtering
```

**Design decisions:**
- Split into page components (unlike system-design-tutor's monolithic App.tsx) because we have 5+ distinct page layouts
- `data.ts` centralizes all markdown loading and parsing — single source of truth for components
- `types.ts` defines shared interfaces used across pages and data layer
- Deep Dives page is not a separate file — it's handled by ArticleView.tsx (same rendering as patterns)
- **Deferred to V2:** Pattern page table filtering by difficulty/status, same-tier sidebar in article view, cheat sheet pattern-based filtering, cheat sheet links to pattern notes. These are in the spec but omitted from V1 to ship a working site faster.
- Vanilla CSS (same approach as system-design-tutor; Tailwind installed but not actively used for styling)

---

## Task 1: Repo Scaffolding + Git Init

**Files:**
- Create: `/Users/chengde_lin/coding-interview-tutor/` (all content directories and initial files)

- [ ] **Step 1: Create repo and initialize git**

```bash
mkdir -p /Users/chengde_lin/coding-interview-tutor
cd /Users/chengde_lin/coding-interview-tutor
git init
```

- [ ] **Step 2: Create directory structure**

```bash
cd /Users/chengde_lin/coding-interview-tutor
mkdir -p patterns data_structures cheatsheets assessments deep_dives .github/workflows web/src/pages
```

- [ ] **Step 3: Create .gitignore**

Create `/Users/chengde_lin/coding-interview-tutor/.gitignore`:
```
node_modules/
web/dist/
.DS_Store
```

- [ ] **Step 4: Create README.md**

Create `/Users/chengde_lin/coding-interview-tutor/README.md`:
```markdown
# Coding Interview Tutor

A personal knowledge base for mastering coding interview patterns. AI-assisted learning with structured pattern notes, blind spot tracking, cheat sheets, and a review website.

## Quick Start

```bash
# Review your notes in the browser
cd web && npm run dev
```

Then open http://localhost:5173

## Directory Structure

```
coding-interview-tutor/
├── CLAUDE.md                          # AI tutor instructions
├── roadmap.md                         # Pattern roadmap + progress tracking
├── patterns/                          # Algorithm pattern notes
├── data_structures/                   # Data structure notes
├── cheatsheets/
│   └── master.md                      # Pre-interview cheat sheet
├── assessments/
│   └── confusion_ledger.md            # Blind spot tracker
├── deep_dives/                        # Discussion session notes
└── web/                               # Review website (Vite + React)
```

## Ground Rules

1. **No hand-waving.** Every claim backed by a number or mechanism.
2. **Pattern recognition > memorization.** Understand the "why" behind each pattern.
3. **Track your blind spots.** What trips you up repeatedly is what costs you in interviews.
4. **Review before interviews.** The cheat sheet exists for the 30 minutes before you walk in.
```

- [ ] **Step 5: Create CLAUDE.md**

Create `/Users/chengde_lin/coding-interview-tutor/CLAUDE.md` — this is the AI tutor persona for the coding interview repo:

```markdown
# Coding Interview Tutor - CLAUDE.md

## Role & Persona

你是一位頂級的 Coding Interview 導師，專門指導 Senior Software Engineer 級別的開發者準備演算法面試。你的目標是透過深度討論，幫助使用者精通常見的演算法 Pattern、釐清資料結構的使用時機，並追蹤知識盲區，確保面試時不會在同一個坑跌倒兩次。

**面試難度基準：Google L4/L5。** 覆蓋此難度即可涵蓋大多數 Tier 1 公司（Apple, Nvidia, Microsoft, Netflix 等）。

**你不是面試官。** 你的角色是知識策展人與導師：回答問題、記錄困惑、整理筆記，讓使用者高效複習。

## Core Objectives

1. **Pattern Mastery**：幫助使用者建立對每個演算法 pattern 的直覺 — 什麼時候用、為什麼有效、常見陷阱。
2. **Confusion Tracking**：主動捕捉使用者的觀念盲區或錯誤認知，討論後更新 `assessments/confusion_ledger.md`。
3. **Cheat Sheet Curation**：從使用者的個人踩坑紀錄中萃取精煉的速查條目，更新 `cheatsheets/master.md`。
4. **Progress Tracking**：每次討論完一個 pattern，更新 `roadmap.md` 中的狀態。

## Project Structure

```
coding-interview-tutor/
├── CLAUDE.md                          # This file
├── README.md                          # Project overview
├── roadmap.md                         # Pattern roadmap + progress
├── patterns/                          # Algorithm pattern notes
├── data_structures/                   # Data structure notes
├── cheatsheets/
│   └── master.md                      # Pre-interview cheat sheet
├── assessments/
│   └── confusion_ledger.md            # Blind spot tracker
├── deep_dives/                        # Discussion session notes
└── web/                               # Review website (Vite + React)
```

## Interaction Modes

### Mode 1: Topic Study — 「我們今天來討論 [pattern]」
1. Ask the user's current understanding of this pattern
2. Use 2-3 classic problems to build intuition, progressing from easy to hard
3. Record points where the user gets stuck
4. After the session, update: pattern note → confusion ledger → cheat sheet → roadmap status

### Mode 2: Post-Practice Review — 「我剛做了 LC XXX，卡在 [某個點]」
1. Identify root cause: concept gap? edge case? wrong pattern choice?
2. Categorize into the relevant pattern
3. Update confusion ledger + cheat sheet

### Mode 3: Stuck in Real-time — 「我卡在這題，想不出來」
1. Give hints first — do NOT give the answer directly
2. If still stuck after 2 rounds of hints, provide the full approach
3. Record the reason for getting stuck

### Mode 4: Review Session — 「幫我複習」/「review」
1. Show confusion ledger entries marked as 「需複習」
2. Pick 2-3 entries and ask targeted questions to test retention
3. Pass → mark as 「已修正」; Fail → keep as 「需複習」

## Workflows (Automatic)

### Auto: Confusion Tracking
- Whenever you detect a misconception, uncertainty, or knowledge gap, **automatically** append to `assessments/confusion_ledger.md`.
- Don't ask for permission. Just do it and mention what you recorded.

### Auto: Cheat Sheet Update
- After recording a confusion/pitfall, **automatically** extract the 1-2 line summary to `cheatsheets/master.md` under the relevant pattern heading.

### Auto: Roadmap Update
- After completing a pattern discussion, update the pattern's status in `roadmap.md`.

### Auto: Organize Notes
- When a discussion is substantial (>3 exchanges on the same topic), **offer** to organize into `deep_dives/<topic>.md`.
- When the user says "幫我整理", do it immediately.

## Content Formats

### Pattern Files (`patterns/*.md`)
Must include YAML frontmatter with `last_updated`, `status`, `tier` fields.
Sections: 核心觀念 → 識別信號 → 程式模板 → 複雜度 → 常見陷阱 → 變體 → 經典題

### Data Structure Files (`data_structures/*.md`)
Sections: 核心概念 → 操作複雜度 → 什麼時候用 → 實作重點 → 常見陷阱 → 相關 Patterns

### Confusion Ledger (`assessments/confusion_ledger.md`)
Table columns: 日期 | 主題 | 我的盲區/錯誤認知 | 核心正解 | 狀態 | 複習建議
Status values: `需複習` / `已修正`

### Cheat Sheet (`cheatsheets/master.md`)
Ultra-condensed. Each entry is 1-2 lines from personal pitfalls. Grouped by pattern heading.

## Rules of Engagement

- **保持專業與精煉**：直接切入技術核心，不過度客套。
- **No hand-waving**：每個 claim 必須有數字或機制支撐。
- **先引導再揭示**：Mode 3 先給提示，兩輪後才給答案。
- **主要使用繁體中文撰寫所有筆記與回應**。英文專有名詞在首次出現時以括號標註，之後可直接使用英文。
- **程式碼用 Python**：除非使用者特別要求其他語言。

## Web App

Review website at `web/`. Run with:
```bash
cd web && npm run dev
```
```

- [ ] **Step 6: Create roadmap.md with all patterns**

Create `/Users/chengde_lin/coding-interview-tutor/roadmap.md`:
```markdown
---
last_updated: 2026-03-21
---

# Coding Interview Roadmap

> 以 Google L4/L5 面試為基準。狀態：`未開始` / `學習中` / `需複習` / `已掌握`

## Tier 1 — 必須精通
> 面試高頻，必須 15 分鐘內解完

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|
| Two Pointers | 未開始 | — | 0 | — |
| Sliding Window | 未開始 | — | 0 | — |
| Binary Search | 未開始 | — | 0 | — |
| BFS / DFS | 未開始 | — | 0 | — |
| Dynamic Programming (1D) | 未開始 | — | 0 | — |
| Hash Map Patterns | 未開始 | — | 0 | — |
| Stack / Monotonic Stack | 未開始 | — | 0 | — |
| Heap / Priority Queue | 未開始 | — | 0 | — |
| Backtracking | 未開始 | — | 0 | — |
| Sorting + Greedy | 未開始 | — | 0 | — |

## Tier 2 — 需要熟練
> 經常出現，需穩定解出

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|
| Dynamic Programming (2D / Interval) | 未開始 | — | 0 | — |
| Union Find | 未開始 | — | 0 | — |
| Trie | 未開始 | — | 0 | — |
| Topological Sort | 未開始 | — | 0 | — |
| Segment Tree / BIT | 未開始 | — | 0 | — |
| Divide and Conquer | 未開始 | — | 0 | — |
| Bit Manipulation | 未開始 | — | 0 | — |
| Linked List Techniques | 未開始 | — | 0 | — |

## Tier 3 — 了解即可
> 偶爾出現，知道方向就好

| Pattern | 狀態 | 上次學習 | 關聯題數 | 筆記連結 |
|---------|------|---------|---------|---------|
| String Algorithms (KMP, Rabin-Karp) | 未開始 | — | 0 | — |
| Shortest Path (Dijkstra, Bellman-Ford) | 未開始 | — | 0 | — |
| Game Theory (Minimax) | 未開始 | — | 0 | — |
| Geometry / Sweep Line | 未開始 | — | 0 | — |
| Math & Number Theory | 未開始 | — | 0 | — |
```

- [ ] **Step 7: Create initial content files**

Create `/Users/chengde_lin/coding-interview-tutor/patterns/_template.md`:
```markdown
---
last_updated:
status: 未開始
tier:
---

# [Pattern Name]

## 核心觀念


## 識別信號


## 程式模板

```python
# TODO
```

## 複雜度


## 常見陷阱


## 變體


## 經典題

| 題目 | 難度 | 關鍵考點 | 我的狀態 |
|------|------|---------|---------|
```

Create `/Users/chengde_lin/coding-interview-tutor/data_structures/_template.md`:
```markdown
# [Data Structure Name]

## 核心概念


## 操作複雜度

| 操作 | 平均 | 最差 | 備註 |
|------|------|------|------|

## 什麼時候用


## 實作重點


## 常見陷阱


## 相關 Patterns

```

Create `/Users/chengde_lin/coding-interview-tutor/cheatsheets/master.md`:
```markdown
# Cheat Sheet — 面試前速查

> 這裡的每一條都來自你個人踩過的坑。面試前 30 分鐘掃一遍。

<!-- 隨著討論累積，這裡會自動更新 -->
```

Create `/Users/chengde_lin/coding-interview-tutor/assessments/confusion_ledger.md`:
```markdown
# Confusion Ledger — 盲區追蹤

> 每次討論後自動更新。定期複習以強化修正。

| 日期 | 主題 | 我的盲區/錯誤認知 | 核心正解 | 狀態 | 複習建議 |
|------|------|-------------------|---------|------|---------|
```

- [ ] **Step 8: Initial commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add .gitignore README.md CLAUDE.md roadmap.md patterns/ data_structures/ cheatsheets/ assessments/ deep_dives/
git commit -m "feat: initial repo scaffolding with CLAUDE.md, roadmap, and content templates"
```

---

## Task 2: Web Project Setup

**Files:**
- Create: `web/package.json`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/tsconfig.node.json`, `web/postcss.config.js`, `web/tailwind.config.js`, `web/src/main.tsx`, `web/src/vite-env.d.ts`

- [ ] **Step 1: Initialize npm project and install dependencies**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web
npm init -y
npm install react react-dom react-markdown remark-gfm rehype-raw rehype-highlight highlight.js
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss postcss autoprefixer @tailwindcss/typography
```

- [ ] **Step 2: Create vite.config.ts**

Create `/Users/chengde_lin/coding-interview-tutor/web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/coding-interview-tutor/',
  plugins: [react()],
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
```

- [ ] **Step 3: Create tsconfig.json**

Create `/Users/chengde_lin/coding-interview-tutor/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `/Users/chengde_lin/coding-interview-tutor/web/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create PostCSS and Tailwind config**

Create `/Users/chengde_lin/coding-interview-tutor/web/postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

Create `/Users/chengde_lin/coding-interview-tutor/web/tailwind.config.js`:
```javascript
import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [typography],
}
```

**Important:** After `npm init -y`, ensure `web/package.json` has `"type": "module"` and the correct scripts:
```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```
Add these fields to the generated package.json before proceeding.

- [ ] **Step 5: Create index.html**

Create `/Users/chengde_lin/coding-interview-tutor/web/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Coding Interview Tutor</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create src entry files**

Create `/Users/chengde_lin/coding-interview-tutor/web/src/vite-env.d.ts`:
```typescript
/// <reference types="vite/client" />

declare module '*.md' {
  const content: string
  export default content
}
```

Create `/Users/chengde_lin/coding-interview-tutor/web/src/main.tsx`:
```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 7: Create placeholder App.tsx to verify build works**

Create `/Users/chengde_lin/coding-interview-tutor/web/src/App.tsx`:
```typescript
export default function App() {
  return <div>Coding Interview Tutor</div>
}
```

Create `/Users/chengde_lin/coding-interview-tutor/web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  background: #0a0a0f;
  color: #e8e6e3;
}
```

- [ ] **Step 8: Verify dev server starts**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web && npx vite --host 2>&1 | head -5
```

Expected: Vite dev server starts on localhost:5173

- [ ] **Step 9: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/
git commit -m "feat: web project setup with Vite + React + TypeScript"
```

---

## Task 3: Types + Data Layer

**Files:**
- Create: `web/src/types.ts`, `web/src/data.ts`

- [ ] **Step 1: Create types.ts**

Create `/Users/chengde_lin/coding-interview-tutor/web/src/types.ts`:
```typescript
export type PatternStatus = '未開始' | '學習中' | '需複習' | '已掌握'
export type ConfusionStatus = '需複習' | '已修正'

export interface PatternFrontmatter {
  last_updated: string | null
  status: PatternStatus
  tier: number | null
}

export interface PatternFile {
  slug: string          // filename without extension, e.g. "sliding_window"
  name: string          // display name derived from H1 heading or slug
  content: string       // raw markdown (frontmatter stripped)
  frontmatter: PatternFrontmatter
}

export interface DataStructureFile {
  slug: string
  name: string
  content: string
}

export interface DeepDiveFile {
  slug: string
  name: string
  content: string
}

export interface RoadmapEntry {
  pattern: string
  status: PatternStatus
  lastStudied: string
  problemCount: number
  noteLink: string | null
}

export interface RoadmapTier {
  tier: number
  title: string
  description: string
  entries: RoadmapEntry[]
}

export interface ConfusionEntry {
  date: string
  topic: string
  blindSpot: string
  correction: string
  status: ConfusionStatus
  reviewAdvice: string
}

export type Page =
  | { type: 'dashboard' }
  | { type: 'roadmap' }
  | { type: 'pattern'; slug: string }
  | { type: 'data-structure'; slug: string }
  | { type: 'cheatsheet' }
  | { type: 'confusion-ledger' }
  | { type: 'deep-dive'; slug: string }
```

- [ ] **Step 2: Create data.ts — markdown loading + parsing**

Create `/Users/chengde_lin/coding-interview-tutor/web/src/data.ts`:
```typescript
import type {
  PatternFile,
  PatternFrontmatter,
  DataStructureFile,
  DeepDiveFile,
  RoadmapTier,
  RoadmapEntry,
  ConfusionEntry,
  PatternStatus,
  ConfusionStatus,
} from './types'

// --- Lightweight frontmatter parser (no gray-matter — it needs Node.js builtins) ---

function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, content: raw }
  const data: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      data[key] = val
    }
  }
  return { data, content: match[2] }
}

// --- Raw markdown loading via Vite glob ---

const patternMds = import.meta.glob('../../patterns/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const dataStructureMds = import.meta.glob('../../data_structures/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const deepDiveMds = import.meta.glob('../../deep_dives/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const cheatsheetMd = import.meta.glob('../../cheatsheets/master.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const roadmapMd = import.meta.glob('../../roadmap.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const confusionMd = import.meta.glob('../../assessments/confusion_ledger.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// --- Helpers ---

function slugFromPath(path: string): string {
  const filename = path.split('/').pop() || ''
  return filename.replace(/\.md$/, '')
}

function nameFromSlug(slug: string): string {
  return slug
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function extractH1(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

// --- Pattern files ---

export function getPatterns(): PatternFile[] {
  return Object.entries(patternMds)
    .filter(([path]) => !path.includes('_template'))
    .map(([path, raw]) => {
      const { data, content } = parseFrontmatter(raw)
      const slug = slugFromPath(path)
      const fm = data as Partial<PatternFrontmatter>
      return {
        slug,
        name: extractH1(content) || nameFromSlug(slug),
        content,
        frontmatter: {
          last_updated: fm.last_updated ? String(fm.last_updated) : null,
          status: (fm.status as PatternStatus) || '未開始',
          tier: fm.tier ?? null,
        },
      }
    })
}

// --- Data structure files ---

export function getDataStructures(): DataStructureFile[] {
  return Object.entries(dataStructureMds)
    .filter(([path]) => !path.includes('_template'))
    .map(([path, raw]) => {
      const { content } = parseFrontmatter(raw)
      const slug = slugFromPath(path)
      return {
        slug,
        name: extractH1(content) || nameFromSlug(slug),
        content,
      }
    })
}

// --- Deep dive files ---

export function getDeepDives(): DeepDiveFile[] {
  return Object.entries(deepDiveMds)
    .map(([path, raw]) => {
      const { content } = parseFrontmatter(raw)
      const slug = slugFromPath(path)
      return {
        slug,
        name: extractH1(content) || nameFromSlug(slug),
        content,
      }
    })
}

// --- Cheat sheet ---

export function getCheatSheet(): string {
  const raw = Object.values(cheatsheetMd)[0]
  if (!raw) return ''
  const { content } = parseFrontmatter(raw)
  return content
}

// --- Roadmap parsing ---

const STATUS_VALUES: PatternStatus[] = ['未開始', '學習中', '需複習', '已掌握']

function parseRoadmapTable(lines: string[]): RoadmapEntry[] {
  // Skip header row and separator row, parse data rows
  const dataLines = lines.filter(
    (l) => l.startsWith('|') && !l.includes('---') && !l.includes('Pattern')
  )
  return dataLines.map((line) => {
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    const linkMatch = cells[4]?.match(/\[.*?\]\((.*?)\)/)
    return {
      pattern: cells[0] || '',
      status: STATUS_VALUES.includes(cells[1] as PatternStatus)
        ? (cells[1] as PatternStatus)
        : '未開始',
      lastStudied: cells[2] || '—',
      problemCount: parseInt(cells[3] || '0', 10) || 0,
      noteLink: linkMatch ? linkMatch[1] : null,
    }
  })
}

export function getRoadmap(): RoadmapTier[] {
  const raw = Object.values(roadmapMd)[0]
  if (!raw) return []
  const { content } = parseFrontmatter(raw)
  const lines = content.split('\n')

  const tiers: RoadmapTier[] = []
  let currentTier: RoadmapTier | null = null
  let tableLines: string[] = []

  for (const line of lines) {
    const tierMatch = line.match(/^## Tier (\d+)\s*[—–-]\s*(.+)/)
    if (tierMatch) {
      if (currentTier && tableLines.length > 0) {
        currentTier.entries = parseRoadmapTable(tableLines)
      }
      currentTier = {
        tier: parseInt(tierMatch[1], 10),
        title: tierMatch[2].trim(),
        description: '',
        entries: [],
      }
      tiers.push(currentTier)
      tableLines = []
      continue
    }
    if (currentTier && line.startsWith('>')) {
      currentTier.description = line.replace(/^>\s*/, '').trim()
      continue
    }
    if (currentTier && line.startsWith('|')) {
      tableLines.push(line)
    }
  }
  // Flush last tier
  if (currentTier && tableLines.length > 0) {
    currentTier.entries = parseRoadmapTable(tableLines)
  }

  return tiers
}

// --- Confusion ledger parsing ---

export function getConfusionEntries(): ConfusionEntry[] {
  const raw = Object.values(confusionMd)[0]
  if (!raw) return []
  const { content } = parseFrontmatter(raw)
  const lines = content.split('\n').filter(
    (l) => l.startsWith('|') && !l.includes('---') && !l.includes('日期')
  )
  return lines.map((line) => {
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    return {
      date: cells[0] || '',
      topic: cells[1] || '',
      blindSpot: cells[2] || '',
      correction: cells[3] || '',
      status: cells[4] === '已修正' ? '已修正' as ConfusionStatus : '需複習' as ConfusionStatus,
      reviewAdvice: cells[5] || '',
    }
  })
}

// --- Aggregated stats ---

export function getStats() {
  const roadmap = getRoadmap()
  const allEntries = roadmap.flatMap((t) => t.entries)
  const confusion = getConfusionEntries()

  return {
    totalPatterns: allEntries.length,
    mastered: allEntries.filter((e) => e.status === '已掌握').length,
    inProgress: allEntries.filter((e) => e.status === '學習中').length,
    needsReview: allEntries.filter((e) => e.status === '需複習').length,
    notStarted: allEntries.filter((e) => e.status === '未開始').length,
    confusionOpen: confusion.filter((e) => e.status === '需複習').length,
    confusionResolved: confusion.filter((e) => e.status === '已修正').length,
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web && npx tsc --noEmit 2>&1 | head -20
```

Note: There may be TS errors from the placeholder App.tsx not importing anything yet — that's expected. The key is that `types.ts` and `data.ts` themselves have no syntax errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/types.ts web/src/data.ts
git commit -m "feat: add types and data layer for markdown loading + parsing"
```

---

## Task 4: CSS Theme + App Shell with Sidebar

**Files:**
- Modify: `web/src/index.css` (replace placeholder)
- Modify: `web/src/App.tsx` (replace placeholder)

The CSS follows the system-design-tutor's approach: vanilla CSS with CSS custom properties for a dark editorial theme. The App shell includes a sidebar with navigation and a main content area.

- [ ] **Step 1: Write complete index.css**

Overwrite `/Users/chengde_lin/coding-interview-tutor/web/src/index.css` with the full dark theme CSS. Key sections:
- CSS variables (colors, fonts, dimensions) — use a blue/teal accent instead of system-design-tutor's gold, to visually distinguish
- Reset + scrollbar
- App layout (sidebar + main)
- Sidebar styling (272px width, nav items, section headers)
- Home/Dashboard page (grid cards, progress bars, stat counters)
- Article layout (content + TOC sidebar)
- Prose styling (headings, tables, code blocks, blockquotes)
- Cheat sheet layout (dense, high-density reference cards)
- Status badges (color-coded: green=已掌握, blue=學習中, orange=需複習, gray=未開始)
- Confusion ledger table styling
- Roadmap cards
- Table of Contents sidebar (sticky, ≥1340px)
- Responsive (hide sidebar on mobile)
- Animations (fadeIn)

Key CSS variables:
```css
:root {
  --sidebar-w: 272px;
  --toc-w: 210px;
  --bg-deep: #0a0a0f;
  --bg-base: #111118;
  --bg-surface: #1a1a24;
  --bg-elevated: #232330;
  --text-primary: #e8e6e3;
  --text-secondary: #9a9a9a;
  --text-muted: #6a6a6a;
  --accent: #5ba4cf;
  --accent-dim: rgba(91, 164, 207, 0.15);
  --accent-green: #4caf84;
  --accent-green-dim: rgba(76, 175, 132, 0.15);
  --accent-orange: #e0a458;
  --accent-orange-dim: rgba(224, 164, 88, 0.15);
  --accent-red: #cf5b5b;
  --font-display: 'Instrument Serif', serif;
  --font-body: 'Plus Jakarta Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

This is a large CSS file (~600-700 lines). Write the complete file following the system-design-tutor's `index.css` structure but adapted for coding interview content. The CSS must support all page layouts defined in the spec: Dashboard grid, Roadmap cards, Article prose, Cheat Sheet reference cards, Confusion Ledger table.

- [ ] **Step 2: Write complete App.tsx with sidebar + page routing**

Overwrite `/Users/chengde_lin/coding-interview-tutor/web/src/App.tsx`:

```typescript
import { useState } from 'react'
import type { Page } from './types'
import { getPatterns, getDataStructures, getDeepDives, getStats } from './data'
import Dashboard from './pages/Dashboard'
import Roadmap from './pages/Roadmap'
import ArticleView from './pages/ArticleView'
import CheatSheet from './pages/CheatSheet'
import ConfusionLedger from './pages/ConfusionLedger'

export default function App() {
  const [page, setPage] = useState<Page>({ type: 'dashboard' })

  const patterns = getPatterns()
  const dataStructures = getDataStructures()
  const deepDives = getDeepDives()
  const stats = getStats()

  // Sidebar nav items
  const navSections = [
    { label: 'Dashboard', page: { type: 'dashboard' } as Page },
    { label: 'Roadmap', page: { type: 'roadmap' } as Page },
    { label: 'Cheat Sheet', page: { type: 'cheatsheet' } as Page },
    { label: 'Confusion Ledger', page: { type: 'confusion-ledger' } as Page },
  ]

  function renderPage() {
    switch (page.type) {
      case 'dashboard':
        return <Dashboard stats={stats} onNavigate={setPage} />
      case 'roadmap':
        return <Roadmap onNavigate={setPage} />
      case 'pattern':
        const pat = patterns.find((p) => p.slug === page.slug)
        if (!pat) return <div>Pattern not found</div>
        return <ArticleView content={pat.content} name={pat.name} onBack={() => setPage({ type: 'roadmap' })} />
      case 'data-structure':
        const ds = dataStructures.find((d) => d.slug === page.slug)
        if (!ds) return <div>Data structure not found</div>
        return <ArticleView content={ds.content} name={ds.name} onBack={() => setPage({ type: 'dashboard' })} />
      case 'cheatsheet':
        return <CheatSheet />
      case 'confusion-ledger':
        return <ConfusionLedger />
      case 'deep-dive':
        const dd = deepDives.find((d) => d.slug === page.slug)
        if (!dd) return <div>Deep dive not found</div>
        return <ArticleView content={dd.content} name={dd.name} onBack={() => setPage({ type: 'dashboard' })} />
    }
  }

  const isActive = (type: string) => page.type === type

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header" onClick={() => setPage({ type: 'dashboard' })}>
          <h1 className="sidebar-title">Coding Interview<br />Tutor</h1>
        </div>
        <nav className="sidebar-nav">
          {navSections.map((item) => (
            <button
              key={item.label}
              className={`nav-item ${isActive(item.page.type) ? 'active' : ''}`}
              onClick={() => setPage(item.page)}
            >
              {item.label}
            </button>
          ))}

          {/* Patterns section */}
          <div className="nav-section-header">Patterns</div>
          {patterns.map((p) => (
            <button
              key={p.slug}
              className={`nav-item nav-item-sub ${page.type === 'pattern' && page.slug === p.slug ? 'active' : ''}`}
              onClick={() => setPage({ type: 'pattern', slug: p.slug })}
            >
              {p.name}
            </button>
          ))}

          {/* Data Structures section */}
          {dataStructures.length > 0 && (
            <>
              <div className="nav-section-header">Data Structures</div>
              {dataStructures.map((d) => (
                <button
                  key={d.slug}
                  className={`nav-item nav-item-sub ${page.type === 'data-structure' && page.slug === d.slug ? 'active' : ''}`}
                  onClick={() => setPage({ type: 'data-structure', slug: d.slug })}
                >
                  {d.name}
                </button>
              ))}
            </>
          )}

          {/* Deep Dives section */}
          {deepDives.length > 0 && (
            <>
              <div className="nav-section-header">Deep Dives</div>
              {deepDives.map((d) => (
                <button
                  key={d.slug}
                  className={`nav-item nav-item-sub ${page.type === 'deep-dive' && page.slug === d.slug ? 'active' : ''}`}
                  onClick={() => setPage({ type: 'deep-dive', slug: d.slug })}
                >
                  {d.name}
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Create placeholder page components**

Create all page files with minimal content so the app compiles:

`web/src/pages/Dashboard.tsx`:
```typescript
import type { Page } from '../types'

interface Props {
  stats: { totalPatterns: number; mastered: number; inProgress: number; needsReview: number; notStarted: number; confusionOpen: number; confusionResolved: number }
  onNavigate: (page: Page) => void
}

export default function Dashboard({ stats }: Props) {
  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      <p>Patterns: {stats.totalPatterns} | Mastered: {stats.mastered}</p>
    </div>
  )
}
```

`web/src/pages/Roadmap.tsx`:
```typescript
import type { Page } from '../types'

interface Props {
  onNavigate: (page: Page) => void
}

export default function Roadmap({ onNavigate }: Props) {
  return <div className="roadmap"><h1>Roadmap</h1></div>
}
```

`web/src/pages/ArticleView.tsx`:
```typescript
interface Props {
  content: string
  name: string
  onBack: () => void
}

export default function ArticleView({ name }: Props) {
  return <div className="article"><h1>{name}</h1></div>
}
```

`web/src/pages/CheatSheet.tsx`:
```typescript
export default function CheatSheet() {
  return <div className="cheatsheet"><h1>Cheat Sheet</h1></div>
}
```

`web/src/pages/ConfusionLedger.tsx`:
```typescript
export default function ConfusionLedger() {
  return <div className="confusion-ledger"><h1>Confusion Ledger</h1></div>
}
```

- [ ] **Step 4: Verify dev server renders the app shell with sidebar**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web && npx vite --host 2>&1 | head -5
```

Open localhost:5173 and verify sidebar renders with nav items and Dashboard placeholder shows.

- [ ] **Step 5: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/
git commit -m "feat: app shell with sidebar navigation and dark theme CSS"
```

---

## Task 5: Dashboard Page

**Files:**
- Modify: `web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement Dashboard with stats grid + review recommendations**

Replace the placeholder `Dashboard.tsx` with the full implementation:

- **Progress overview section**: Show stats (total, mastered, in progress, needs review, not started) as colored stat cards in a grid
- **Progress bar**: Visual bar showing proportion of each status
- **Review recommendations**: Parse confusion ledger, filter by status `需複習`, sort by date ascending (oldest first), display as a list of cards with topic, blind spot summary, and date
- **Recently updated**: Show patterns sorted by `last_updated` frontmatter, top 5

The component receives `stats` and `onNavigate` as props. It also calls `getConfusionEntries()` and `getPatterns()` directly for the recommendation and recent-update sections.

- [ ] **Step 2: Verify Dashboard renders correctly**

Start dev server, check that stats display, progress bar renders, and the page looks correct. With the initial roadmap (all `未開始`), the progress bar should be fully gray and stats should show all 23 patterns as "not started".

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard page with progress stats and review recommendations"
```

---

## Task 6: Roadmap Page

**Files:**
- Modify: `web/src/pages/Roadmap.tsx`

- [ ] **Step 1: Implement Roadmap with tier sections and pattern cards**

Replace the placeholder with full implementation:

- Call `getRoadmap()` to get tier data
- Render each tier as a section with title and description
- Each pattern entry rendered as a card with:
  - Pattern name
  - Status badge (color-coded: green=已掌握, blue=學習中, orange=需複習, gray=未開始)
  - Problem count
  - Last studied date
  - Clickable → `onNavigate({ type: 'pattern', slug })` (derive slug from pattern name by lowercasing and replacing spaces with underscores)
- Overall progress summary at the top (same progress bar as Dashboard)

- [ ] **Step 2: Verify Roadmap renders all 23 patterns across 3 tiers**

Start dev server, navigate to Roadmap via sidebar. Verify all patterns show with status badges.

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/pages/Roadmap.tsx
git commit -m "feat: Roadmap page with tier sections and pattern cards"
```

---

## Task 7: Article View (Patterns, Data Structures, Deep Dives)

**Files:**
- Modify: `web/src/pages/ArticleView.tsx`

- [ ] **Step 1: Implement ArticleView with markdown rendering + syntax highlighting + TOC**

Replace placeholder with full implementation:

- **Markdown rendering**: Use `react-markdown` with `remark-gfm` and `rehype-raw` plugins (same as system-design-tutor)
- **Syntax highlighting**: Add `rehype-highlight` plugin. Import `highlight.js/styles/github-dark.css` or a suitable dark theme.
- **Table of Contents**: Extract H1/H2/H3 headings from content. Render as sticky sidebar (same approach as system-design-tutor). Add `id` attributes to headings for anchor links. Highlight active heading via IntersectionObserver.
- **Custom renderers**:
  - `h1`, `h2`, `h3`: Add slugified `id` for anchor links
  - `table`: Wrap in scrollable div
  - `code`: Syntax highlighting applied automatically by rehype-highlight
- **Back button**: "← Back" link at top, calls `onBack()`
- **Breadcrumb**: "Home / Patterns / {name}" or "Home / Data Structures / {name}"

- [ ] **Step 2: Create a sample pattern file to test rendering**

Create `/Users/chengde_lin/coding-interview-tutor/patterns/two_pointers.md`:
```markdown
---
last_updated: 2026-03-21
status: 學習中
tier: 1
---

# Two Pointers

## 核心觀念
利用兩個指標在已排序（或有特定結構）的序列上同時移動，避免暴力雙層迴圈，將 O(n^2) 降為 O(n)。

## 識別信號
- 題目給的是 sorted array 或可以先排序
- 要找兩個元素滿足某種條件（sum, difference）
- 需要 in-place 操作（remove duplicates, partition）

## 程式模板

```python
def two_sum_sorted(nums: list[int], target: int) -> list[int]:
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        s = nums[lo] + nums[hi]
        if s == target:
            return [lo, hi]
        elif s < target:
            lo += 1
        else:
            hi -= 1
    return []
```

## 複雜度
- Time: O(n) — 每個指標最多走 n 步
- Space: O(1) — 只用兩個變數

## 常見陷阱
- 忘記處理 duplicate elements（跳過重複值）
- while 條件用 `lo <= hi` 還是 `lo < hi` 要看具體問題

## 變體
- **Same direction**: fast/slow pointer（linked list cycle detection）
- **Opposite direction**: 從兩端往中間（上面的模板）
- **三指標**: 3Sum 問題，固定一個 + two pointers

## 經典題

| 題目 | 難度 | 關鍵考點 | 我的狀態 |
|------|------|---------|---------|
| LC 1 Two Sum | Easy | Hash map 更快，但 sorted 版用 two pointers | 已掌握 |
| LC 15 3Sum | Medium | 去重 + 排序 + two pointers | 需複習 |
| LC 11 Container With Most Water | Medium | 移動較短的那邊 | 未開始 |
| LC 42 Trapping Rain Water | Hard | 左右最高牆 | 未開始 |
```

- [ ] **Step 3: Create a sample data structure file to test rendering**

Create `/Users/chengde_lin/coding-interview-tutor/data_structures/heap.md`:
```markdown
# Heap / Priority Queue

## 核心概念
一種完全二叉樹結構，保證根節點是最小（min-heap）或最大（max-heap）元素。支援 O(log n) 插入和 O(log n) 取出極值。

## 操作複雜度

| 操作 | 平均 | 最差 | 備註 |
|------|------|------|------|
| Insert (push) | O(log n) | O(log n) | sift up |
| Extract min/max (pop) | O(log n) | O(log n) | sift down |
| Peek | O(1) | O(1) | 只看不取 |
| Heapify (build) | O(n) | O(n) | 不是 O(n log n) |

## 什麼時候用
- 需要反覆取「目前最大/最小」的場景（Top-K, merge K sorted lists）
- 需要動態維護排序的場景（median finder）
- Dijkstra / Prim 等 greedy 算法

## 實作重點

```python
import heapq

# Python heapq 是 min-heap
nums = [3, 1, 4, 1, 5]
heapq.heapify(nums)          # in-place, O(n)
heapq.heappush(nums, 2)      # O(log n)
smallest = heapq.heappop(nums)  # O(log n)

# Max-heap: 取負值
max_heap = [-x for x in nums]
heapq.heapify(max_heap)
largest = -heapq.heappop(max_heap)

# Top-K smallest
top_k = heapq.nsmallest(k, nums)  # O(n log k)
```

## 常見陷阱
- Python `heapq` 只有 min-heap，要 max-heap 必須取負
- `heapq.heappush` / `heappop` 不是 method，是 function（傳 list 進去）
- 自定義排序用 tuple: `heapq.heappush(heap, (priority, item))`

## 相關 Patterns
- Heap / Priority Queue pattern
- Merge K Sorted（用 min-heap merge）
- Sliding Window Maximum（用 deque 更好，但 heap 也能解）
```

- [ ] **Step 4: Verify ArticleView renders both samples with syntax highlighting and TOC**

Navigate to "Two Pointers" and "Heap" in the sidebar. Verify:
- Markdown renders correctly with headings, tables, code blocks
- Python code has syntax highlighting
- TOC sidebar shows on wide screens
- Back button works

- [ ] **Step 5: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/pages/ArticleView.tsx patterns/two_pointers.md data_structures/heap.md
git commit -m "feat: ArticleView with markdown rendering, syntax highlighting, and TOC"
```

---

## Task 8: Cheat Sheet Page

**Files:**
- Modify: `web/src/pages/CheatSheet.tsx`

- [ ] **Step 1: Implement CheatSheet with dense reference card layout**

Replace placeholder with full implementation:

- Call `getCheatSheet()` to get raw markdown
- Render with `react-markdown` but with a special CSS class for dense layout
- Each `## Heading` becomes a card/section
- Bullet points rendered as compact, scannable items
- No TOC needed — the page itself is the reference card
- If cheat sheet is empty (initial state), show a friendly empty state: "還沒有踩坑紀錄。開始跟 tutor 討論 pattern 後，這裡會自動填入你的個人速查筆記。"

- [ ] **Step 2: Verify CheatSheet renders empty state**

Navigate to Cheat Sheet via sidebar. Verify empty state message shows.

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/pages/CheatSheet.tsx
git commit -m "feat: Cheat Sheet page with dense reference card layout"
```

---

## Task 9: Confusion Ledger Page

**Files:**
- Modify: `web/src/pages/ConfusionLedger.tsx`

- [ ] **Step 1: Implement ConfusionLedger with table and status filtering**

Replace placeholder with full implementation:

- Call `getConfusionEntries()` to get parsed entries
- Render as a styled table (same table styling as article prose)
- Add filter controls at top:
  - Status filter: All / 需複習 / 已修正
  - Topic filter: dropdown or text input for free-text filtering
- Status badges: `需複習` in orange, `已修正` in green
- If no entries, show empty state: "還沒有盲區紀錄。跟 tutor 討論時發現的盲區會自動記錄在這裡。"
- Sort by date descending (newest first) by default

- [ ] **Step 2: Verify empty state renders**

Navigate to Confusion Ledger via sidebar. Verify empty state shows.

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add web/src/pages/ConfusionLedger.tsx
git commit -m "feat: Confusion Ledger page with table rendering and status filtering"
```

---

## Task 10: GitHub Actions Deployment + Final Polish

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `web/package.json` (add build script if missing)

- [ ] **Step 1: Create GitHub Actions workflow**

Create `/Users/chengde_lin/coding-interview-tutor/.github/workflows/deploy.yml`:
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build-and-deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: web/package-lock.json

      - name: Install dependencies
        run: npm ci
        working-directory: web

      - name: Build
        run: npm run build
        working-directory: web

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: web/dist

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Ensure package.json has correct scripts**

Verify `web/package.json` has:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 3: Verify full build succeeds**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web && npm run build 2>&1 | tail -10
```

Expected: Build completes successfully, output in `web/dist/`.

- [ ] **Step 4: Verify preview works**

```bash
cd /Users/chengde_lin/coding-interview-tutor/web && npx vite preview --host 2>&1 | head -5
```

Open the preview URL and do a final walkthrough:
- Dashboard shows stats (all zeros/未開始)
- Roadmap shows all 23 patterns across 3 tiers
- Two Pointers article renders with syntax highlighting
- Cheat Sheet shows empty state
- Confusion Ledger shows empty state
- Sidebar navigation works between all pages

- [ ] **Step 5: Commit**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add .github/workflows/deploy.yml web/package.json
git commit -m "ci: add GitHub Pages deployment workflow"
```

- [ ] **Step 6: Final commit with any remaining files**

```bash
cd /Users/chengde_lin/coding-interview-tutor
git add -A
git status
# If there are uncommitted files:
git commit -m "feat: complete initial coding-interview-tutor setup"
```
