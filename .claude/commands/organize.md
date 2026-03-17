Organize the current conversation's discussion into a structured, reviewable note.

## When to use

When the user says "幫我整理" or wants the current discussion saved as a reference.

## Process

1. Identify the main topic of the discussion.
2. Create a file at `deep_dives/<topic>.md` using the topic as filename (snake_case).
3. Structure the note as follows:

```markdown
# <Topic Title>

## 問題定義 (Problem Definition)
What system/feature are we designing? What are the key requirements?

## 關鍵需求 (Key Requirements)
- Functional requirements
- Non-functional requirements (scale, latency, availability, consistency)

## 粗略估算 (Back-of-the-Envelope)
QPS, storage, bandwidth, memory estimates with calculations shown.

## 高層架構 (High-Level Architecture)
Core components and their interactions. Use ASCII diagrams.

## 深入探討 (Deep Dive)
The 1-2 components we dove deep into. Include trade-off discussions.

## 關鍵決策 (Key Decisions)
| Decision | Options Considered | Choice | Why |
|----------|-------------------|--------|-----|

## 學到的重點 (Key Takeaways)
Bullet points of the most important insights from this discussion.
```

## Rules
- Extract information from the conversation; don't invent new content.
- Keep it concise but complete enough to be useful for review.
- Use Traditional Chinese for headings and explanations, English for technical terms.
- If any confusion was detected during the discussion, also update `assessments/confusion_ledger.md` via the confusion tracking workflow.
