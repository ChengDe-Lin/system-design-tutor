import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface FileEntry {
  path: string
  name: string
  content: string
}

interface Section {
  key: string
  title: string
  description: string
  files: FileEntry[]
}

const componentMds = import.meta.glob('../../components/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const deepDiveMds = import.meta.glob('../../deep_dives/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const assessmentMds = import.meta.glob('../../assessments/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function toDisplayName(path: string): string {
  const fileName = path.split('/').pop()?.replace('.md', '') || ''
  return fileName
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function parseFiles(mds: Record<string, string>): FileEntry[] {
  return Object.entries(mds)
    .map(([path, content]) => ({ path, name: toDisplayName(path), content }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export default function App() {
  const [selected, setSelected] = useState<FileEntry | null>(null)

  const sections: Section[] = useMemo(
    () => [
      {
        key: 'components',
        title: 'Components',
        description: 'Trade-off comparisons',
        files: parseFiles(componentMds),
      },
      {
        key: 'deep_dives',
        title: 'Deep Dives',
        description: 'Architecture case studies',
        files: parseFiles(deepDiveMds),
      },
      {
        key: 'assessments',
        title: 'Assessments',
        description: 'Blind spot tracking',
        files: parseFiles(assessmentMds),
      },
    ],
    [],
  )

  const allFiles = sections.flatMap((s) => s.files)

  return (
    <div className="flex h-screen bg-slate-900 text-slate-200">
      {/* Sidebar */}
      <aside className="w-72 bg-slate-800/60 border-r border-slate-700/50 flex flex-col shrink-0">
        <div className="p-5 border-b border-slate-700/50">
          <button
            onClick={() => setSelected(null)}
            className="text-left w-full"
          >
            <h1 className="text-base font-bold text-white tracking-tight">
              System Design Tutor
            </h1>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {allFiles.length} notes
            </p>
          </button>
        </div>

        <nav className="flex-1 overflow-auto p-3 space-y-6">
          {sections.map((s) => (
            <div key={s.key}>
              <h2 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-1.5 px-2">
                {s.title}
              </h2>
              <p className="text-[10px] text-slate-600 px-2 mb-2">
                {s.description}
              </p>
              {s.files.length === 0 ? (
                <p className="text-xs text-slate-600 italic px-2">
                  No notes yet
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {s.files.map((f) => (
                    <li key={f.path}>
                      <button
                        onClick={() => setSelected(f)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-150 ${
                          selected?.path === f.path
                            ? 'bg-blue-500/15 text-blue-400 font-medium shadow-sm shadow-blue-500/5'
                            : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                        }`}
                      >
                        {f.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {selected ? (
          <div className="max-w-5xl mx-auto px-10 py-8">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 mb-8 text-xs text-slate-500">
              <button
                onClick={() => setSelected(null)}
                className="hover:text-slate-300 transition-colors"
              >
                Home
              </button>
              <span className="text-slate-700">/</span>
              <span className="text-slate-400">{selected.name}</span>
            </div>

            {/* Article */}
            <article className="prose prose-invert prose-slate max-w-none prose-headings:font-bold prose-h1:text-3xl prose-h1:border-b prose-h1:border-slate-700 prose-h1:pb-3 prose-h2:text-2xl prose-h2:mt-10 prose-h3:text-xl prose-td:text-slate-300 prose-th:text-slate-200 prose-strong:text-slate-100 prose-a:text-blue-400 prose-blockquote:border-blue-500 prose-blockquote:text-slate-400 prose-hr:border-slate-700">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {selected.content}
              </ReactMarkdown>
            </article>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-lg px-6">
              <h2 className="text-2xl font-bold text-slate-300 mb-3">
                System Design Tutor
              </h2>
              <p className="text-slate-500 text-sm leading-relaxed mb-10">
                Select a note from the sidebar to start reviewing. Notes are
                organized into Components, Deep Dives, and Assessments.
              </p>

              {allFiles.length > 0 && (
                <div>
                  <p className="text-[11px] text-slate-600 uppercase tracking-widest mb-3">
                    All Notes
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {allFiles.map((f) => (
                      <button
                        key={f.path}
                        onClick={() => setSelected(f)}
                        className="px-4 py-2 rounded-lg bg-slate-800/80 text-slate-400 text-sm hover:bg-slate-700 hover:text-slate-200 transition-all border border-slate-700/50"
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
