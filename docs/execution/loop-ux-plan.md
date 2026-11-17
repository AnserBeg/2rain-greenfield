# The loop plan — a purchase order → inventory → sales order loop a person wants to use

Written 2026-11-17 by the orchestrator after the owner tried the app ("in terms of ui/ux is horrifying… we need the perfect purchase
order, to inventory to sales order loop as in temp_inventory… they don't need to look exactly like PaneFlow… but they can't look like
what we have now"). Inputs: the hands-on walk and its causes ([evidence](evidence/2026-11-17-loop-ux-audit.md)), an independent
architecture audit ([program review](program-reviews/2026-11-17-architecture-audit.md)), a map of PaneFlow's loop, and the advisor.

## What the evidence says

- **The loop does not finish.** A shipped order cannot be invoiced or paid from the screens, and an order ships with no price.
- **Ten of the twelve ranked problems need no architecture change:** seven are the authored definition, three are the renderer. Two
  need a language concept (skipping the review stage; defaults from the selected row). None needs a client-side renderer.
- **The compiler, release and movement-ledger core is right** (audit §1, §4). The mistake was proving the platform before the daily job.
- **The earlier "visual phase" was never checked against a person.** This plan shows the owner the look before building it, and
  measures the loop in clicks, page loads and typed fields.

## Rules for this work (orchestrator rulings, 2026-11-17, under the owner's standing rule; owner may veto)

1. **Through the generator, never around it.** Every improvement lands in the authored definition, the renderer or the surface
   language, so a tenant-added record type gets it too. No hand-built screens for the loop. No renderer special cases keyed on an
   operation or entity id.
2. **A scorecard is the gate.** One browser journey walks the loop and counts clicks, full page loads, typed fields and raw codes per
   step, and repeats the receive-and-list part on a tenant-added record type. Each phase states its numbers.
3. **The owner picks the look.** Phase 2 builds nothing until he has chosen from mockups on real seed data.
4. **Freeze R2 holds for the parked features** (units, special orders, drop-ship, stock counts, returns, returnable assets). Exposing
   invoice and payment on the order is completing the loop, not a new feature.
5. **At most two build lanes** on this machine. No more review-of-fix rounds on activation (`AGENTS.md`: no confirm arms).
6. **Pre-tenant mode holds (ADR-0066):** a definition or language change re-baselines, and a dev database runs `dev:reset`.

## Phases

### Phase 1 — the loop completes and makes sense (packet LOOP-1; starts now; no rule change)
In the current renderer. The seven DEFINITION and three RENDERER rows of the evidence table:
- invoice and payment as next actions on the shipped order; a price is required; no confirm on a missing total;
- reserve and ship as one row-task over the lines; carrier and tracking optional; order date defaults to today;
- the PO and SO first screen cut to the fields the job needs; a task-shaped menu, a landing page and real icons;
- no raw codes or developer sentences; an error summary that links to the field; one next-action button; no clipped tables.

Scorecard target: the loop completes end to end, invoice and payment included; zero raw codes; zero invented values ("N/A");
create-and-place a PO in ≤ 8 clicks (today ~14); the sales side in ≤ 16 (today ~30).

### Phase 2 — the look (owner's choice; mockups start now, in parallel)
Two visual directions for five screens on seed data: the home page, a purchase order, the receive dialog, stock by item, and a sales
order. Published as pages he can click through. He picks one (or parts of both). Then the tokens, shell, document page, lists and
dialogs are rebuilt in the renderer to match, and the ux-grammar pins that the choice supersedes are amended in the same packet.

### Phase 3 — interaction (after phase 1; needs a canonical language change)
The two LANGUAGE rows, and PaneFlow's two best ideas:
- a task may skip the review stage when its consequence is low, and stage changes swap in place (ADR-0036 behaviour 7 extended to
  task stages; no client router or store);
- task inputs default from the selected row (open quantity, ordered cost, preferred location);
- a calculated before → after impact line in every posting dialog (on hand, reserved, available);
- pickers show price and availability; worklists show stage tabs with counts.

A two-day spike on PO-plus-receive measures in-place fragments against the scorecard before ADR-0036 is amended. A client-side
renderer over the same compiled surfaces (the audit's option b) is taken only if the spike shows fragments cannot reach the target.

Scorecard target: every posting in ≤ 2 page loads and ≤ 4 clicks; receive in full in 2 clicks.

### Speed (owner, 2026-11-17: "super super fast")
Measured: a purchase order page took 5.3 s, 4.85 s of it Node CPU, with 1,204 statements in 148 transactions. Two critical reviews
(Fable 5.2 with a profile; Codex gpt-6.2-astra) agree: no Rust, no edge hosting of pages; the time is repeated work. LOOP-1's "memo"
slice removes the catalog re-parse (~3-4 s); [SPEED-1](packets/SPEED-1-charter.md) brings a page to ≤ 3 transactions and ≤ 40
statements under a CI budget, without changing a security guarantee. The look ([LOOK-1](packets/LOOK-1-charter.md), owner's choice:
Ledger plus the next-step card, work queues and progress bars; [spec](../design/ledger-spec.md), [mockup](../design/ledger-final.html))
follows LOOP-1 and uses SPEED-1's batched loader for every count.

### Then, in this order (the audit's architecture findings)
1. **Customized upgrade, narrowed.** A field and a layout patch survive a first-party base change without `dev:reset`. Every
   definition edit in phases 1-3 moves the base, so this is the first thing a real tenant would hit (`CUSTOMIZE_BASE_STALE`).
2. **`customize recover`** for an interrupted activation; then fold publish, verification and scope into one atomic step.
3. **Sign-in and a pilot topology**: real authentication, and drafts and task state out of process memory.
Workflows as sandboxed TypeScript (plan §12.5) stay unbuilt until a customer needs one.

## Already in flight
- **AGENT-3** continues: the agent's plan is bound to its release (A1) and update patches are verified (A2) before act-then-undo
  merges. Its chat panel is not polished before phase 2 fixes the look.

## Corrections to earlier claims
- The plan's rollback promise restores the release's definition and data mapping. It does not restore older executor code: executors
  are selected by capability id with one version each (`capability-operation-executor-factory.ts:28-55`).
- "The app looks like the mockup" (`ui-ux-remaining.md` §1) is superseded: no comparison was ever made.
