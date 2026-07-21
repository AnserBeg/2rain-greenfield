---
name: capture-learnings
description: How adjudicated lessons are recorded so future packets and
  agents inherit them. Use when a bug, review finding, or process failure
  yields a reusable rule.
---

# Capture learnings

Append to `learnings.md` at the repo root (create it on first use). One
entry per lesson:

```markdown
## Short imperative title
Date: YYYY-MM-DD
Why: one or two sentences — the failure or discovery that earned the rule.
How to apply: the concrete behavior change, testable where possible.
```

Rules:

- Only adjudicated lessons — confirmed by evidence or a settled review, not
  hunches.
- Keep entries under ~6 lines; link the packet/ADR for detail.
- If a lesson contradicts an earlier entry, supersede it explicitly
  ("supersedes: <title>") rather than leaving both.
- Lessons that harden into policy graduate into AGENTS.md, a skill, or an
  ADR — note the graduation in the entry.
