# Doctrine coverage map

Purpose: enumerate every binding rule in this program, the instrument that
holds it, how it is enforced today, and the exact packet or stage that makes
it executable. The point is to guarantee that no binding concern stays merely
prose — that "binding in the plan" always has a scheduled path to "fails CI if
violated."

This complements the capability-support matrix (which tracks *product
capabilities*); this map tracks *doctrine enforcement*. Update it whenever an
ADR, skill, or plan section adds or promotes a binding rule.

## Status legend

- `enforced` — an executable gate/test exists now, or an orchestrator-followed
  skill governs it now.
- `scheduled` — binding, not yet executable, but a named packet/stage will make
  it so and that packet is tracked (or seeded) in the ledger.
- `partially enforced` — an executable gate covers the structural/static
  boundary now, while a named later packet owns runtime or provider proof.
- `prose-only` — binding, but no enforcement instrument yet and no tracked
  packet. These are the real risk rows: they depend on someone remembering to
  promote them. Drive this column to empty.

G0-P3 is accepted. Every row whose "Enforced today by" cell names G0-P3 has
that structural boundary enforced now; `partially enforced` means only that a
separate runtime/provider proof remains scheduled, not that the P3 gate is
pending.

## Open gaps to close (the action list)

As of 2026-07-21, the binding rules not yet backed by a tracked enforcement
packet:

1. **UI/UX surface grammar** (archetypes, one-authority-per-surface,
   status-color grammar, weight-matches-consequence) — G1 skill-pin and the
   compiled SurfaceRuntime seam are now tracked by G1-P7/G1-P8. The full G2
   five-archetype conformance packet remains to be created at the G2 cut.
2. **Mobile/responsive contract** — same instruments; the G2 compact-projection
   conformance is described but not yet a tracked packet.
3. **Accessibility (WCAG 2.2 AA)** — plan §8.4/§8.5; G2 conformance + G7 audit
   described, not yet tracked.
4. **Customization boundaries** and **capability support cells** — plan §10,
   §5.5; enforcement lands at G6/per-capability, correctly later, but should be
   confirmed as tracked packets when those stages are cut.
None of these are *missing from the product* — they are designed and binding.
The risk is only that their promotion from prose to executable gate is not yet
scheduled as concrete packets. G1-P0 has created the G1 entries; the G2 and
later stage cuts must create their remaining enforcement packets.

## Authority and structure

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| One application/release authority | ADR-0001 | G0-P3 alternate-authority scan + authority-map review | G1-P3 persistence; G1-P4 activation; G1-P5 pinning | partially enforced |
| Modular monolith + dependency direction | ADR-0002 | G0-P3 boundary checker | G0-P3 boundary checker | enforced |
| PostgreSQL sole launch provider | ADR-0003 | G0-P3 protected-import scan | G0-P4a provider/migration tests | partially enforced |
| Trusted tenant/request context | ADR-0004 | G0-P4b authenticated-entry, two-tenant RLS, and pool-reuse tests | G0-P4b trusted context; G1-P5 request-view pinning tests | partially enforced |
| Drop `@agent-native/core` | ADR-0005 | G0-P3 manifest, lockfile, import, and compatibility-authority scan | G0-P3 boundary checker | enforced |
| Compiler determinism (round-trip/hash) | ADR-0001 (partial) + plan §5.3 | — | G1-P2 golden/hash tests | scheduled |

## Runtime, gateways, agent

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Human-controlled release activation | ADR-0006; plan §5.4 | authority-map review | G1-P4 activation; G6 approval flow | scheduled |
| Semantic Query/Operation gateway ownership | ADR-0008; plan §5.9, §9.2 | G0-P3 direct-access/private-registry scan | G1-P6 gateway skeleton and tests | partially enforced |
| Agent tool prohibitions (no raw DB/source; five fixed tools) | ADR-0009; plan §9.2, §9.2.5 | G0-P3 source/model-facing scan | G1-P2 projection + G1-P6 seam; G2 agent contracts/evals; benchmark G7 | partially enforced |
| LLM-only intent classification | salvaged user policy; plan §9 | — | agent packets (A-01+) | prose-only |
| Append-only inventory posting truth | ADR-0007; plan §6.3-6.4 | G0-P3 direct-write/writable-balance scan | G3 inventory property suite | partially enforced |

## UI/UX and customization

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Surface grammar (5 archetypes, one authority per surface, status colors, weight-matches-consequence) | plan §8.5-8.6; `ux-grammar` skill | skill (advisory) | G1-P7 compiled shell + G1-P8 skill-pin/seam; G2 full conformance | scheduled |
| Responsive/mobile contract | plan §8.5; `ux-grammar` skill | skill (advisory) | G2 compact-projection conformance | prose-only (packets untracked) |
| Accessibility (WCAG 2.2 AA) | plan §8.4-8.5 | — | G2 conformance; G7 audit | prose-only (packets untracked) |
| Customize content, never grammar | plan §8.6, §10 | `ux-grammar` skill | G6 customization gates | scheduled |
| Customization boundaries (what tenants may change) | plan §10.2-10.3 | — | G6 | scheduled |
| Capability support cells (supported = every edge + evidence) | plan §5.5 | — | per-capability from N1 | scheduled |

## Trust, lifecycle, recovery

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Lifecycle / audit / correction / recovery doctrine | ADR-0010; plan §7.3-7.4 | G0-P3 duplicate-authority and hard-delete scan | T-01 trust substrate (G2); drills G7 | partially enforced |
| No hard delete for business data | ADR-0010; AGENTS.md; plan §7.4 | G0-P3 hard-delete scan | G2 operation gateway test | partially enforced |
| Backup / restore / RPO / RTO | ADR-0010; plan §7.5 | authority-map review | G7 recovery drill | scheduled |
| Secrets never in source/fixtures/prompts | AGENTS.md | G0-P5c clean-history scan plus committed synthetic-secret negative gate | G0-P5c secret scan in CI | enforced |

## Process and evidence (already enforced by skills)

| Concern | Instrument | Enforced today by | Status |
|---|---|---|---|
| Step-packet cadence (one packet, user checkpoint, no autonomous continuation) | `mission-cadence` skill | orchestrator follows skill | enforced |
| Seat/model + threat-bounded review tiers | `review-tiers` skill | packet records and fresh review prompts state in-scope and deferred threat cases | enforced |
| Salvage admission (PORT/RE-EXPRESS/REFERENCE) | `salvage-admission` skill | per-port admission record | enforced |
| Branching / commit / push discipline | `git-workflow` skill | orchestrator follows skill | enforced |
| Evidence packet per stage gate | AGENTS.md + template | per-gate record | enforced |

## Observability and security

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Baseline observability (structured logs, correlation/trace IDs, health/readiness, metrics/error evidence) | plan §15.2; AGENTS.md | G0-P5 propagation, PostgreSQL-loss readiness, redaction, metrics, and CI-evidence tests | G0-P5 observability packet | enforced |
| SLOs / error budgets | plan §15.1 | — | G7 | prose-only |
| Tenant isolation (defense in depth) | ADR-0004; plan §7.2 | G0-P4b tenant/environment RLS and pool-reuse tests | G0-P4b smoke fixture; G7 pentest | partially enforced |
| Dependency / secret scanning | AGENTS.md | G0-P5c high/critical dependency audit, clean-history scan, negative secret fixture, and retained CI reports | G0-P5c CI scans | enforced |

## Maintenance rule

Every accepted ADR, new skill, or promoted plan section updates this map in the
same packet. A stage cut (G1, G2, …) must, as part of its packet breakdown,
create tracked packets for every `scheduled` or `prose-only` row whose
executable-at column names that stage — otherwise a binding rule silently
enters a stage with no enforcement packet. The `prose-only` column is the
standing to-do; the goal is to keep driving it toward empty.
