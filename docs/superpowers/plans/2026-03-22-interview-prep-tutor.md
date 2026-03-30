# Interview Prep Tutor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a behavioral interview prep knowledge base with a lightweight "pre-interview quick review" website, deployed to GitHub Pages.

**Architecture:** New repo at `/Users/chengde_lin/interview-prep-tutor`. Markdown files (pitch, stories, company research, BQ categories) are the source of truth. A Vite + React static site reads these at build time via `import.meta.glob` and renders a 3-page quick-review website. Some directories (`pitch/companies/`, `mock_sessions/`) are gitignored for privacy — the website gracefully handles their absence in deployed builds. GitHub Actions deploys to GitHub Pages.

**Tech Stack:** Vite 5+, React 18+, TypeScript, react-markdown, remark-gfm, rehype-raw, rehype-highlight, highlight.js, GitHub Actions, GitHub Pages

**Spec:** `/Users/chengde_lin/system-design-tutor/docs/superpowers/specs/2026-03-22-interview-prep-tutor-design.md`

**Reference:** Coding-interview-tutor web app at `/Users/chengde_lin/coding-interview-tutor/web/` — same tech stack, same CSS approach (vanilla CSS + custom properties), same `import.meta.glob` + `parseFrontmatter` pattern.

**IMPORTANT — Agent instructions:** For CSS and React components, the implementer agent MUST read the reference coding-interview-tutor at `/Users/chengde_lin/coding-interview-tutor/web/src/` to understand patterns, then write complete code. The interview-prep site is SIMPLER (fewer pages, no progress tracking).

---

## File Structure

```
/Users/chengde_lin/interview-prep-tutor/
├── .github/workflows/deploy.yml       # GitHub Actions → GitHub Pages
├── .gitignore                         # pitch/companies/, mock_sessions/
├── CLAUDE.md                          # AI 教練指令
├── README.md
├── resume/
│   ├── resume_notes.md                # 履歷分析（initially empty template）
│   └── ChengDe_2026.pdf              # 複製使用者的履歷
├── pitch/
│   ├── general.md                     # 通用版 pitch（initially empty template）
│   ├── short.md                       # 30 秒版（initially empty template）
│   └── companies/                     # [GITIGNORED] 公司特化版
├── stories/
│   └── _template.md                   # STAR 格式模板
├── bq_categories.md                   # BQ 類型 → 故事索引
├── company_research/                  # 公司研究（公開）
├── mock_sessions/                     # [GITIGNORED]
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── postcss.config.js
    └── src/
        ├── main.tsx
        ├── vite-env.d.ts
        ├── index.css                  # Dark theme CSS (lighter than coding-interview-tutor)
        ├── types.ts                   # Shared types
        ├── data.ts                    # Markdown loading + parsing
        ├── App.tsx                    # Layout shell, sidebar, page routing
        └── pages/
            ├── QuickReview.tsx        # Home: pitch + story bank + reminders
            ├── CompanyView.tsx        # Company research + recommended stories
            └── StoryDetail.tsx        # Full STAR story rendering
```

**Design decisions:**
- Only 3 page components (vs. 5 in coding-interview-tutor) — this is a simpler site
- No Dashboard, no progress tracking, no confusion ledger — not needed for BQ prep
- `data.ts` handles graceful absence of gitignored files (pitch/companies/, mock_sessions/)
- Copy the user's resume PDF from `/Users/chengde_lin/Downloads/ChengDe 2026.pdf`

---

## Task 1: Repo Scaffolding + Git Init

**Files:**
- Create: `/Users/chengde_lin/interview-prep-tutor/` (all content directories and initial files)

- [ ] **Step 1: Create repo and directory structure**

```bash
mkdir -p /Users/chengde_lin/interview-prep-tutor
cd /Users/chengde_lin/interview-prep-tutor
git init
mkdir -p resume pitch/companies stories company_research mock_sessions .github/workflows web/src/pages
```

- [ ] **Step 2: Create .gitignore**

Create `/Users/chengde_lin/interview-prep-tutor/.gitignore`:
```
node_modules/
web/dist/
.DS_Store
pitch/companies/
mock_sessions/
```

- [ ] **Step 3: Create README.md**

A project overview for a behavioral interview prep system. Include: title "Interview Prep Tutor", description mentioning AI-assisted pitch crafting, story bank, BQ practice, Quick Start (`cd web && npm run dev`), directory structure, and a note that some directories are gitignored for privacy.

- [ ] **Step 4: Create CLAUDE.md**

The AI coaching persona. Must include ALL of these sections:

**Role & Persona:** 面試教練與 pitch 策展人, 不是面試官. 討論用繁體中文, pitch/故事產出用英文.

**Core Objectives:** (1) Pitch Crafting — 漸進式萃取英文自我介紹 (2) Story Mining — STAR 格式故事庫 (3) BQ Practice — mock interview + feedback (4) Company-Specific Prep — 搜尋公司資訊, 調整 pitch

**Five Interaction Modes:**
- Mode 1: Pitch Crafting「幫我寫 pitch」→ 讀履歷, 請使用者自我介紹, 追問, 萃取英文 pitch, 存到 pitch/general.md + pitch/short.md
- Mode 2: Company-Specific「我要面 [公司]」→ 搜尋公司, 存 company_research/, 建議故事, 產出 pitch/companies/ (gitignored)
- Mode 3: Story Mining「我們來整理故事」→ 讀履歷, 追問細節, STAR 格式, 存 stories/, 更新 bq_categories.md
- Mode 4: Mock Interview「模擬面試」→ 扮演面試官, 使用者可用中文回答, feedback, 存 mock_sessions/ (gitignored)
- Mode 5: Pre-Interview Review「我明天要面 [公司]」→ 拉出 pitch + 推薦故事 + company research

**Auto behaviors:** 討論中挖出新故事 → 存 stories/ + 更新 bq_categories.md; pitch 修改 → 更新版本紀錄; 提到新公司 → 提議建立 company research

**Content formats:** Pitch file structure (English version, 中文參考, Key Talking Points, 版本紀錄), Story file structure (適用 BQ 類型, STAR, Key Talking Points, 版本紀錄), BQ categories table format, Company research format

**Rules:** 繁體中文討論, 英文產出. 程式碼用 Python. Feedback 要具體. 第一次互動讀 resume/ChengDe_2026.pdf. 搜尋公司資訊時用 WebSearch.

**Web App:** mention `cd web && npm run dev`

- [ ] **Step 5: Create roadmap and template files**

Create `bq_categories.md`:
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

Create `stories/_template.md`:
```markdown
# [Story Title]

## 適用 BQ 類型
-

## Situation


## Task


## Action


## Result


## Key Talking Points
-

## 版本紀錄

| 日期 | 修改內容 |
|------|---------|
```

Create `pitch/general.md`:
```markdown
# Self Introduction — General (2 min)

> 跟 tutor 討論後會逐步填入。說「幫我寫 pitch」開始。

## English Version



## 中文參考



## Key Talking Points


## 版本紀錄

| 日期 | 修改內容 |
|------|---------|
```

Create `pitch/short.md`:
```markdown
# Elevator Pitch (30 sec)

> 跟 tutor 討論後會逐步填入。

## English Version



## 版本紀錄

| 日期 | 修改內容 |
|------|---------|
```

Create `resume/resume_notes.md`:
```markdown
# Resume Analysis

> Tutor 分析你的履歷後會在這裡記錄改進建議。

## Strengths


## Areas to Improve


## Notes
```

- [ ] **Step 6: Copy user's resume PDF**

```bash
cp "/Users/chengde_lin/Downloads/ChengDe 2026.pdf" /Users/chengde_lin/interview-prep-tutor/resume/ChengDe_2026.pdf
```

- [ ] **Step 7: Create .gitkeep files for gitignored directories**

```bash
touch /Users/chengde_lin/interview-prep-tutor/pitch/companies/.gitkeep
touch /Users/chengde_lin/interview-prep-tutor/mock_sessions/.gitkeep
touch /Users/chengde_lin/interview-prep-tutor/company_research/.gitkeep
```

Note: `.gitkeep` files inside gitignored directories won't be tracked. For `company_research/` (which IS public), the `.gitkeep` will be tracked. For `pitch/companies/` and `mock_sessions/`, the directories simply won't appear on GitHub — that's fine.

- [ ] **Step 8: Initial commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add .
git commit -m "feat: initial repo scaffolding with CLAUDE.md, templates, and resume"
```

---

## Task 2: Web Project Setup

**Files:**
- Create: `web/package.json`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/tsconfig.node.json`, `web/postcss.config.js`, `web/src/main.tsx`, `web/src/vite-env.d.ts`

- [ ] **Step 1: Initialize npm and install dependencies**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web
npm init -y
npm install react react-dom react-markdown remark-gfm rehype-raw rehype-highlight highlight.js
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom autoprefixer
```

- [ ] **Step 2: Update package.json**

Add `"type": "module"` and scripts:
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

- [ ] **Step 3: Create config files**

Create `vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/interview-prep-tutor/',
  plugins: [react()],
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
```

Create `tsconfig.json`:
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

Create `tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "composite": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": false,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

Create `postcss.config.js`:
```javascript
export default {
  plugins: {
    autoprefixer: {},
  },
}
```

- [ ] **Step 4: Create index.html and entry files**

Create `index.html`:
```html
<!DOCTYPE html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Interview Prep Tutor</title>
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

Create `src/vite-env.d.ts`:
```typescript
/// <reference types="vite/client" />
```

Create `src/main.tsx`:
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

Create placeholder `src/App.tsx`:
```typescript
export default function App() {
  return <div>Interview Prep Tutor</div>
}
```

Create placeholder `src/index.css`:
```css
body {
  margin: 0;
  background: #0a0a0f;
  color: #e8e6e3;
}
```

- [ ] **Step 5: Verify dev server starts**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web && npx vite 2>&1 | head -5
```

- [ ] **Step 6: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add web/
git commit -m "feat: web project setup with Vite + React + TypeScript"
```

---

## Task 3: Types + Data Layer

**Files:**
- Create: `web/src/types.ts`, `web/src/data.ts`

- [ ] **Step 1: Create types.ts**

Create `/Users/chengde_lin/interview-prep-tutor/web/src/types.ts`:
```typescript
export interface StoryFile {
  slug: string
  name: string
  content: string
  bqTypes: string[]   // extracted from "## 適用 BQ 類型" section
}

export interface CompanyResearch {
  slug: string
  name: string
  content: string
}

export interface CompanyPitch {
  slug: string
  name: string
  content: string
}

export interface BQCategory {
  type: string
  commonQuestions: string
  recommendedStories: string
}

export type Page =
  | { type: 'quick-review' }
  | { type: 'company'; slug: string }
  | { type: 'story'; slug: string }
```

- [ ] **Step 2: Create data.ts**

Create `/Users/chengde_lin/interview-prep-tutor/web/src/data.ts`:
```typescript
import type {
  StoryFile,
  CompanyResearch,
  CompanyPitch,
  BQCategory,
} from './types'

// --- Lightweight frontmatter parser ---

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

// --- Raw markdown loading ---

const storyMds = import.meta.glob('../../stories/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const companyResearchMds = import.meta.glob('../../company_research/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

// Gitignored — may be empty in deployed build
const companyPitchMds = import.meta.glob('../../pitch/companies/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const generalPitchMd = import.meta.glob('../../pitch/general.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const shortPitchMd = import.meta.glob('../../pitch/short.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const bqCategoriesMd = import.meta.glob('../../bq_categories.md', {
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
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function extractH1(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

function extractBQTypes(content: string): string[] {
  const section = content.match(/## 適用 BQ 類型\s*\n([\s\S]*?)(?=\n## |\n$)/m)
  if (!section) return []
  return section[1]
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

// --- Stories ---

export function getStories(): StoryFile[] {
  return Object.entries(storyMds)
    .filter(([path]) => !path.includes('_template'))
    .map(([path, raw]) => {
      const { content } = parseFrontmatter(raw)
      const slug = slugFromPath(path)
      return {
        slug,
        name: extractH1(content) || nameFromSlug(slug),
        content,
        bqTypes: extractBQTypes(content),
      }
    })
}

// --- Company research ---

export function getCompanyResearch(): CompanyResearch[] {
  return Object.entries(companyResearchMds)
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

// --- Company pitches (gitignored, may be empty) ---

export function getCompanyPitches(): CompanyPitch[] {
  return Object.entries(companyPitchMds)
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

// --- Pitches ---

export function getGeneralPitch(): string {
  const raw = Object.values(generalPitchMd)[0]
  if (!raw) return ''
  return parseFrontmatter(raw).content
}

export function getShortPitch(): string {
  const raw = Object.values(shortPitchMd)[0]
  if (!raw) return ''
  return parseFrontmatter(raw).content
}

// --- BQ Categories ---

export function getBQCategories(): BQCategory[] {
  const raw = Object.values(bqCategoriesMd)[0]
  if (!raw) return []
  const { content } = parseFrontmatter(raw)
  const lines = content.split('\n').filter(
    (l) => l.startsWith('|') && !l.includes('---') && !l.includes('BQ 類型')
  )
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean)
    return {
      type: cells[0] || '',
      commonQuestions: cells[1] || '',
      recommendedStories: cells[2] || '',
    }
  })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add web/src/types.ts web/src/data.ts
git commit -m "feat: types and data layer for markdown loading"
```

---

## Task 4: CSS Theme + App Shell

**Files:**
- Modify: `web/src/index.css`, `web/src/App.tsx`
- Create: `web/src/pages/QuickReview.tsx`, `web/src/pages/CompanyView.tsx`, `web/src/pages/StoryDetail.tsx`

- [ ] **Step 1: Write index.css**

Read the reference CSS at `/Users/chengde_lin/coding-interview-tutor/web/src/index.css` and write a LIGHTER version (~400-500 lines) for this project. Same CSS variables, same dark theme, but:
- Use a **warm accent** (#c9a84c gold/amber) to visually distinguish from coding-interview-tutor (blue) and system-design-tutor (gold — actually same, so consider #d4956a warm coral or keep gold)
- **Simpler layout**: Sidebar is narrower or replaced with a top-nav on mobile
- **Pitch section styling**: Large readable text for pitch content, designed for quick scanning
- **Story cards**: Compact cards showing title + BQ types
- **No Dashboard/Roadmap/Confusion-specific styles** — don't include those sections
- Key CSS classes needed: `.app`, `.sidebar`, `.sidebar-header`, `.sidebar-title`, `.sidebar-nav`, `.nav-item`, `.nav-item.active`, `.nav-item-sub`, `.nav-section-header`, `.main-content`, `.quick-review`, `.pitch-section`, `.pitch-label`, `.story-grid`, `.story-card`, `.story-card-name`, `.story-card-tags`, `.bq-tag`, `.reminders`, `.reminder-item`, `.company-view`, `.company-header`, `.company-content`, `.article-layout`, `.article-content`, `.article-back`, `.prose` (full markdown styling), `.table-wrapper`, `.empty-state`, `.toc`, `.toc-item`, responsive breakpoints, fadeIn animation

- [ ] **Step 2: Write App.tsx**

```typescript
import { useState } from 'react'
import type { Page } from './types'
import { getStories, getCompanyResearch } from './data'
import QuickReview from './pages/QuickReview'
import CompanyView from './pages/CompanyView'
import StoryDetail from './pages/StoryDetail'

export default function App() {
  const [page, setPage] = useState<Page>({ type: 'quick-review' })

  const stories = getStories()
  const companies = getCompanyResearch()

  function renderPage() {
    switch (page.type) {
      case 'quick-review':
        return <QuickReview onNavigate={setPage} />
      case 'company': {
        const company = companies.find((c) => c.slug === page.slug)
        return <CompanyView company={company || null} slug={page.slug} onNavigate={setPage} />
      }
      case 'story': {
        const story = stories.find((s) => s.slug === page.slug)
        if (!story) return <div className="empty-state">Story not found</div>
        return <StoryDetail story={story} onBack={() => setPage({ type: 'quick-review' })} />
      }
    }
  }

  const isActive = (type: string, slug?: string) => {
    if (page.type !== type) return false
    if (slug && 'slug' in page) return page.slug === slug
    return true
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header" onClick={() => setPage({ type: 'quick-review' })}>
          <h1 className="sidebar-title">Interview Prep<br />Tutor</h1>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${isActive('quick-review') ? 'active' : ''}`}
            onClick={() => setPage({ type: 'quick-review' })}
          >
            Quick Review
          </button>

          {companies.length > 0 && (
            <>
              <div className="nav-section-header">Companies</div>
              {companies.map((c) => (
                <button
                  key={c.slug}
                  className={`nav-item nav-item-sub ${isActive('company', c.slug) ? 'active' : ''}`}
                  onClick={() => setPage({ type: 'company', slug: c.slug })}
                >
                  {c.name}
                </button>
              ))}
            </>
          )}

          {stories.length > 0 && (
            <>
              <div className="nav-section-header">Stories</div>
              {stories.map((s) => (
                <button
                  key={s.slug}
                  className={`nav-item nav-item-sub ${isActive('story', s.slug) ? 'active' : ''}`}
                  onClick={() => setPage({ type: 'story', slug: s.slug })}
                >
                  {s.name}
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

`QuickReview.tsx`:
```typescript
import type { Page } from '../types'
interface Props { onNavigate: (page: Page) => void }
export default function QuickReview({ onNavigate: _onNavigate }: Props) {
  return <div className="quick-review"><h1>Quick Review</h1></div>
}
```

`CompanyView.tsx`:
```typescript
import type { Page, CompanyResearch } from '../types'
interface Props { company: CompanyResearch | null; slug: string; onNavigate: (page: Page) => void }
export default function CompanyView({ slug }: Props) {
  return <div className="company-view"><h1>Company: {slug}</h1></div>
}
```

`StoryDetail.tsx`:
```typescript
import type { StoryFile } from '../types'
interface Props { story: StoryFile; onBack: () => void }
export default function StoryDetail({ story, onBack }: Props) {
  return (
    <div className="article-layout">
      <div className="article-content">
        <button className="article-back" onClick={onBack}>← Back</button>
        <h1>{story.name}</h1>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify dev server starts**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web && npx vite 2>&1 | head -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add web/src/
git commit -m "feat: app shell with sidebar navigation and dark theme CSS"
```

---

## Task 5: Quick Review Page

**Files:**
- Modify: `web/src/pages/QuickReview.tsx`

- [ ] **Step 1: Implement QuickReview**

The home page. Shows everything you need in the 10 minutes before an interview:

1. **Elevator Pitch** (`.pitch-section`):
   - Label: "Elevator Pitch (30 sec)" with `.pitch-label`
   - Render `getShortPitch()` with react-markdown + `.prose`
   - If empty, show: "還沒有 elevator pitch。跟 tutor 說『幫我寫 pitch』開始。"

2. **Full Pitch** (`.pitch-section`):
   - Label: "Self Introduction (2 min)"
   - Render `getGeneralPitch()` with react-markdown + `.prose`
   - If empty, same empty state message

3. **Story Bank** (`.story-grid`):
   - Title: "Story Bank"
   - Call `getStories()`
   - Each story as a `.story-card` showing: name, BQ type tags (`.bq-tag`), clickable → `onNavigate({ type: 'story', slug })`
   - If no stories: "還沒有故事。跟 tutor 說『我們來整理故事』開始。"

4. **面試前提醒** (`.reminders`):
   - Title: "Pre-Interview Reminders"
   - Hardcoded list of `.reminder-item`:
     - "Use the STAR structure for every answer"
     - "Include specific numbers and metrics"
     - "Keep answers under 2 minutes"
     - "Ask clarifying questions before answering"
     - "Prepare 2-3 questions to ask the interviewer"
     - "Show enthusiasm for the company's mission"

- [ ] **Step 2: Verify it renders**

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add web/src/pages/QuickReview.tsx
git commit -m "feat: Quick Review page with pitch, stories, and reminders"
```

---

## Task 6: Company View + Story Detail Pages

**Files:**
- Modify: `web/src/pages/CompanyView.tsx`, `web/src/pages/StoryDetail.tsx`

- [ ] **Step 1: Implement CompanyView**

- If `company` prop is null, show empty state: "還沒準備這間公司。跟 tutor 說『我要面 {slug}』開始準備。"
- If company exists:
  - Render company research markdown with react-markdown + `.prose`
  - Show "推薦故事" section: cross-reference `getBQCategories()` to find stories tagged for this company's common BQ types, link to story detail pages
  - Check if a company-specific pitch exists in `getCompanyPitches()` matching this slug — if yes, render it; otherwise show general pitch with a note "（使用通用版 pitch）"

- [ ] **Step 2: Implement StoryDetail**

- Back button calling `onBack()`
- Render full STAR story markdown with react-markdown + remarkGfm + rehypeRaw + rehypeHighlight
- Add `.prose` class for styling
- BQ type tags at the top (`.bq-tag` badges)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add web/src/pages/CompanyView.tsx web/src/pages/StoryDetail.tsx
git commit -m "feat: Company View and Story Detail pages"
```

---

## Task 7: GitHub Actions + Final Polish

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create GitHub Actions workflow**

Create `/Users/chengde_lin/interview-prep-tutor/.github/workflows/deploy.yml`:
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

- [ ] **Step 2: Verify full build succeeds**

```bash
cd /Users/chengde_lin/interview-prep-tutor/web && npm run build 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
cd /Users/chengde_lin/interview-prep-tutor
git add .github/workflows/deploy.yml
git commit -m "ci: add GitHub Pages deployment workflow"
```

- [ ] **Step 4: Check for uncommitted files**

```bash
cd /Users/chengde_lin/interview-prep-tutor && git status
```

If any remaining files, commit with "chore: final cleanup".
