# System Design Tutor

A personal knowledge base for mastering distributed system design. AI-assisted learning with structured trade-off comparisons, blind spot tracking, and a review website.

## Quick Start

```bash
# Review your notes in the browser
cd web && npm run dev
```

Then open http://localhost:5173

## Directory Structure

```
system-design-tutor/
├── CLAUDE.md                          # AI tutor instructions
├── components/                        # Technology trade-off comparisons
│   └── message_queue.md               # SQS vs Kafka vs RabbitMQ
├── deep_dives/                        # Architecture case studies
├── assessments/
│   └── confusion_ledger.md            # Blind spot & misconception tracker
├── web/                               # Review website (Vite + React + Tailwind)
└── .claude/commands/                  # Custom slash commands
    ├── trade-off.md                   # /project:trade-off - generate comparison
    ├── confusion.md                   # /project:confusion - track blind spots
    └── organize.md                    # /project:organize - structure discussion notes
```

## Slash Commands

| Command | Trigger | What it does |
|---------|---------|--------------|
| `/project:trade-off` | Comparing technologies | Generates a deep comparison and saves to `components/` |
| `/project:confusion` | After discussion or "review" | Updates `assessments/confusion_ledger.md` |
| `/project:organize` | "organize" or "summarize" | Structures discussion into `deep_dives/` |

## Ground Rules

1. **No hand-waving.** Every claim must be backed by a number or a mechanism.
2. **"It depends" is not an answer.** State the conditions under which each option wins.
3. **Failure modes matter.** What breaks first? How do we detect it? How do we recover?
4. **Scale is a spectrum.** Design for 1x first, then ask "what changes at 10x, 100x, 1000x?"
