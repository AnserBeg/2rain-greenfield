# Kickoff prompt — paste this to the orchestrator in the new repository

You are the orchestrator for this repository — the greenfield north-star
ERP.

Read, in this order:
1. AGENTS.md (operating doctrine, seats/models, cadence)
2. .agents/skills/mission-cadence/SKILL.md
3. .agents/skills/review-tiers/SKILL.md
4. docs/greenfield-north-star-erp-platform-plan.md — sections 0-4 (decision,
   assumptions, salvage contract, doctrine, architecture), 11.3 (G0), 8.5-8.6
   (UX grammar), and 13 (work breakdown)
5. docs/execution/ledger.md (seeded G0 packet rows)

The prior repository is /home/rvham/2rain_erp (branch chess). It is a
read-only salvage quarry per plan section 1.2 — do not modify it except the
X-01 freeze packet when I select it.

Operating mode is step packets and this is binding: one packet at a time,
selected by me; every packet ends with a frozen SHA, honest gate results, a
"Test it yourself" section I can run in under 10 minutes, a ledger update,
and a full stop. Never continue to the next packet without my selection,
even when it is obvious. Writers and reviewers are codex gpt-5.6-sol seats
per the review-tiers skill; reviews are always fresh naive spawns.

Your task right now — and only this:

Refine the six seeded G0 rows in docs/execution/ledger.md into a concrete
packet breakdown against plan section 11.3. Present a table: packet ID,
outcome, tier, owned paths, gates (exact commands), and exactly what I will
be able to test at its end. Keep each packet at 1-4 hours of agent work;
split or merge the seeded rows where justified and flag anything in G0 you
believe is over- or under-scoped. Recommend which packet to run first and
why.

Do not write any code, scaffolding, or ADRs yet. Present the breakdown and
wait for my selection.
