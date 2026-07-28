# Program review — G2 composition milestone (2026-07-27) — CONVERGED RECORD

## Scope reviewed

- **SHA:** clean `main` at `81df6e9`, working tree clean, nothing mid-packet.
- **Coverage:** whole app — G0 through G2 as built. Compiler, canonical model,
  release kernel, PostgreSQL provider, runtime gateways, trust substrate, the
  four domain modules (Party, Catalog, Location, Platform), `apps/web`, the
  ADR set, and the execution records.
- **Instrument:** `.agents/skills/program-review` — both dials mandatory, both
  models independent, read-only, ranked findings not an unbounded hunt.
- **Reviewers:** Codex `gpt-5.6-sol` xhigh and Fable max, each a fresh naive
  spawn with the identical whole-app charter and no shared context. Artifacts:
  `~/2rain-missions/program-review-g2-{codex,fable}.result.txt`.
- **Trigger:** the 2026-07-27 demonstrability ruling plus accumulated
  ADR-vs-code drift noticed across more than one packet. This is the second
  program review; the first was `2026-07-24-g2-p3-party`.

**Correction to the brief:** the charter I wrote said twenty-one ADRs. There are
twenty (ADR-0001…ADR-0020) plus `ADR-TEMPLATE.md`. Both arms caught it
independently. Recorded because a review brief is an authority document.

---

## Headline — the two arms converged

They ran independently and reached the same conclusion in different words.

> **Codex:** "the release kernel, deterministic compiler, generic PostgreSQL
> interpreter, tenant/environment RLS, and transactional trust substrate are
> credible components—but they do not yet compose into an application… the
> program is off course until composition—not more module fan-out—is made the
> controlling acceptance axis."

> **Fable:** "The organs are real; the organism is not… The program is on course
> in its architecture and off course in its verification economics."

Both arms rate the composition gap the single most material finding. Both keep
the goal. Both say adjust the approach. Neither recommends a rewrite, a
different substrate, or abandoning the factory thesis.

Fable's addition is the sharper one: **the program's own instruments recorded
the composition gap at least four times and routed it nowhere** — the
2026-07-24 review's "recorded future work", G2-P4's prose limit,
`doctrine-coverage.md`'s "not yet cut" row, and G2-P0's P9 assuming a composed
product no packet owned. A human tripped over it before the machinery did.

---

## Adjudication — where I corrected an arm

I verified every load-bearing claim myself rather than accept either arm. One
correction is material enough to change the next packet.

### AD-1 — Codex's first BLOCKER is real in fact and wrong in disposition

Codex found that every module declares `composition.status = "unsupported"`, that
this is the only schema-legal value (`schemas.ts:343`, `z.literal('unsupported')`),
and concluded: *"no canonical revision can contain Party, Catalog, Location, and
Platform together,"* dispositioned as *"decide and implement the complete
application-graph contract before G2-P5d."*

The fact is correct. The conclusion drawn from it is not. **I executed the
probe** rather than reasoning about it:

| Attempt | Result |
| --- | --- |
| Merge separately-namespaced modules into one package | **REJECTED** — 116 diagnostics: `CANON_ID_NAMESPACE_MISMATCH` ×46, `CANON_REFERENCE_CROSS_PACKAGE_UNSUPPORTED` ×68, `CANON_OWNERSHIP_MISMATCH` ×1, `CANON_ORDER_KEY_DUPLICATE` ×1 |
| Namespace-uniform two-module package | **REJECTED** — 3 diagnostics, all trivial authoring collisions from a crude rename |
| Three-module application package (Party + Catalog + Location under one namespace, distinct `orderKey`, shared `ownerPackageId`) | **ACCEPTED** — 3 modules, 4 entities, 12 surfaces, 16 queries |

That accepted package then **compiles through the unchanged production
`compileApplication`** with `MODULE_COMPILER_PROFILE`:

```
COMPILE STATUS: compiled
releaseRoot: 1eed139d166b89abcb67f853d216f06b1f867b8c3e00406059085749160ad6a9
PROJECTION FAMILY INSTANCES (9 families, one instance each):
  agent-discovery, operation-catalog, policy-references, query-catalog,
  reporting, semantic-model, storage-target, surface-manifest, verification-plan
```

**The canonical model can represent a composed application today, with zero
press change.** The real fence is `normalize.ts:492` — every owned ID must be
born in the package namespace. What is genuinely unsupported is composing
*separately-namespaced packages* (the `compositionSeam`), which is the different
and later problem that **tenant-authored** modules will need.

Consequence: a demonstrable G2 does **not** require solving cross-package
composition first, and authoring one application package introduces no second
registry and no manually merged artifacts — so the dual-lineage objection Codex
raised against composing does not apply to this route. The job is materially
smaller than the Codex disposition implies.

Evidence preserved: `compose-probe.ts` / `compose-probe.output.txt` (scratchpad).
The probe ran out-of-tree; `git status` clean after.

### AD-2 — claims I confirmed exactly as reported

- **No runnable request path.** The only non-test caller of
  `createSurfaceRuntimeServer` is `demo-server.ts:24`, invoked *without*
  gateways, so `app-server.ts:42` returns 405 for POST. Every gateway-enabled
  construction lives in `test/fixtures/g2/**` or `apps/web/test/**`.
  `apps/api` and `apps/worker` contain one `package.json` each and nothing else.
  `demo-runtime.ts:41` returns unconditional ALLOW and is honestly
  self-labelled *"Local demonstration composition only."*
- **Release admission accepts asserted verification.** `assertReleaseIdentity`
  does `assertUuid(command.verificationEvidenceId, …)` and nothing more;
  executed results live in a process-local `WeakSet` (`verification.ts:68`).
  ADR-0020's enforcement clause requires that *no code path admits a candidate
  with an unexecuted verification set*. Real violation.
- **Component registry.** Exactly three entries, all
  `northstar.shell:component.*`. No dataGrid, keyFacts, sections, commandBar, or
  activity consumer exists.
- **Agent host.** `erp_discover|erp_execute|erp_verify` appear only in tests and
  the architecture-boundary allowlist. No implementation.
- **Status drift.** ADR-0012 reads *"proposed — ratification completes when
  G2-EK1 is accepted"*; G2-EK1 is `accepted` (ledger row 73). Condition met,
  text stale. G2-P5a: ledger says `evidence_ready`, `current-plan:78` says
  accepted.

### AD-3 — Fable's A2 is the most consequential finding either arm produced

Confirmed on every leg, and it is worse than the queue's row 1 records:

- `surface-runtime.ts:245-253` renders `renderedSlots` (slot dispatch) and
  `renderedData` (a hardwired generic data panel) as **two separate mechanisms
  side by side**. The UI that works ignores the slots entirely.
- Every module surface's slot carries `contentReferenceId`
  `northstar.<module>:capability.standard_surface_content`, which is registered
  **nowhere**. So all four modules render their declared slot as an
  `UNSUPPORTED_COMPONENT` diagnostic **today** — not "would", as row 1 says.
- A slot's capability must declare `supportStatus: 'supported'` or compilation
  fails (`compiler.ts:716-729`). The shipped `shell.authored.json` therefore
  carries a **live false claim**: `northstar.shell:component.future_insights ->
  supported`, with no such component registered.

This changes G2-P5d's shape: it is not "declare slots, grow the registry." Slot
dispatch and data rendering must be **unified**, and until the v3 disclosure
family lands the press *forces* untrue support claims.

### AD-4 — Fable's A4 confirmed: the disposition machinery leaks

`grep` for the destination that G2-P5b's F1 was "routed to" returns exactly one
hit — the ledger row that names it. There is no `write-path-hardening` packet,
queue row, or ledger row anywhere. A recorded finding with no owning row is a
disposition with no executing gate — the documentation twin of this program's
own standing lesson that every escaped defect was a declared rule with no
executing gate.

### AD-5 — Fable's A5/F7 confirmed

`storage.ts:578` emits `columns: ['tenant_id', 'environment_id',
column.physicalName]` with no archive predicate, while Catalog and Location both
declare `tenantEnvironmentCaseInsensitiveUnique` and both ship archive/restore.
Archiving a location coded `WH-A` reserves that code permanently. This is queue
row 11, whose own text already says it "arguably outranks several rows above it."

---

## Dial A — consolidated ranked findings

Union of both arms, adjudicated, ranked by materiality. Codex numbering `C#`,
Fable `A#`.

| # | Finding | Arms | Disposition |
| --- | --- | --- | --- |
| 1 | **No composed application.** Organs real, organism absent. Gateways unwired, domain modules imported only by tests, harnesses bypass the CAS activation trigger as superuser, `apps/api`/`apps/worker` are husks. | C1+C2, A1 | **Fix now.** Composition packet. Scoped by AD-1: author one application package — proven legal and compilable today. |
| 2 | **Slot dispatch and data rendering are disconnected; the registry cannot render the anatomy; the press forces a false support claim** (`future_insights -> supported`, shipped). | A2 (+C5 partial) | **Fix now.** Folds into G2-P5d, which must be re-scoped from "declare slots" to "unify dispatch". |
| 3 | **Release admission accepts asserted, not executed, verification.** UUID check only; executed results in a process-local `WeakSet`. Violates ADR-0020. | C3 | **Fix now, Critical.** Durable content-bound verification results; exact plan/result conformance at admission. |
| 4 | **Platform package is a second storage/runtime lineage.** Decorative `dedicatedTable`; real table hand-authored in migration 0012; 1,000+ line bespoke executor. Violates ADR-0011 verbatim. `northstar.platform` is in no press guard. | C4, A3 | **Fix now (small).** Binary choice: make it genuinely generic, or amend ADR-0011 with a declared Tier-B/platform tier and strip the decorative declarations. Not both. |
| 5 | **Disposition machinery leaks** — findings routed to destinations that do not exist. Composition gap recorded four times with no owner. | A4 | **Fix now (process).** Binding rule + one-time sweep. Cheapest item on this list. |
| 6 | **"Supported" and "complete" are structural self-attestations.** Projection families emitted unconditionally; support copied from authored data; conformance checks role presence, not anatomy. 163 violations are one symptom. | C5, A2 | **Fix now**, then move required anatomy + registered-component compatibility into candidate admission. |
| 7 | **Product authorization does not exist.** Storage isolation strong (forced RLS, restricted roles, no destructive grants); every `CurrentPolicyGateway` returns ALLOW; permission IDs compile and are never evaluated. Plus: backfill-checkpoints table has tenant columns and no RLS; migration 0010's principal drop compensated only in app code; all policies PERMISSIVE with no RESTRICTIVE base. | C6, A6 | **Fix before G3**, hard-gated (queue row 7). Fold in the three sub-items. RLS is defense in depth, not authorization. |
| 8 | **Live correctness defects in accepted modules.** F7 archive-aware uniqueness (archiving `WH-A` reserves it forever); saved-filter F1 (revoked rows write-mutable but read-invisible, restore practically unreachable). | A5 | **Fix now (small packet).** Correctness in shipped modules outranks baseline/curve rows. |
| 9 | **Agent and audit legs are projection stubs.** Five `erp_*` tool IDs, no host. Trust is write-only: no UI or API reads any trust table; activity slot declared by no module; query-side denials leave no record. | C7, A8, A9 | **Into the G2 gate** (agent host + activity rail), per both arms. Query-denial evidence → policy-kernel packet. |
| 10 | **Press-law guards are themselves copied per module and have diverged.** Party's scans 3 directories, Catalog/Location 7, Platform none. `db/`, `scripts/`, `test/` outside every scan. | A7 | **Fix now (cheap).** Consolidate into one data-driven guard with module auto-discovery — the pattern the ratchet already proves. |
| 11 | **One-way seams.** Outbox written, never drained. Saved-filter criteria stored, canonically valid, unexecutable (fence admits only literal `true`). Saved filters unreachable from `apps/web`. | A9 | **Recorded, named owners:** outbox → G3 worker; saved-filter execution → Q1; its UI → P5d. |
| 12 | **Record and status drift.** ADR-0012 stale-proposed; G2-P5a `evidence_ready` vs accepted; G2-P5c packet vs ledger; plan §4.4 shape vs actual layout; ADR-0007's inventory exemption hardcodes a path that will never match; deep relative imports bypass export maps. | C9, A11 | **Mechanical hygiene packet.** |
| 13 | **No lawful-erasure path.** No-hard-delete holds system-wide (four layers, verified). Its unresolved consequence: shared release, trust, outbox, receipt, and module records have no data-subject erasure mechanism. | C8 | **Recorded, decision deadline before G3/market commitment.** Do not weaken no-hard-delete. |
| 14 | **Determinism, no-hard-delete, activation, expression kernel hold system-wide.** PASS with nits: one raw `Date.now()` in materializer prepare; `localeCompare` at four non-digest sites; hermeticity scan covers compiler only, not canonical-model. | A10 | `Date.now` + scan extension → next materializer packet. **Dismissed with reason:** the non-digest `localeCompare` sites (verified order-insensitive or cosmetic). |
| 15 | **Shared-blob content-hash existence oracle.** | A6 | **Dismissed with reason** — requires knowing exact bytes; revisit at multi-tenant exposure. |

---

## Dial B — Verdict 1: is the GOAL right

**KEEP — with the claim sharpened, not softened.** Both arms, independently.

The factory mechanism is validated where it has actually been tested: four
declarative definitions produced tenant-scoped storage with forced RLS,
case-folded uniqueness, lifecycle-only operations, compiled surfaces, and agent
projections through one unchanged press. The marginal cost of a module genuinely
collapsed — the economic heart of the thesis. Nothing found argues for replacing
the compiler-backed factory with hand-coded CRUD modules; that would produce a
demo sooner and abandon the differentiator, recreating the fork problem the
program exists to solve.

Both arms independently sharpened the same three qualifications:

1. "A module is data" is proven for **master-data CRUD with one-slot surfaces
   and literal-true predicates** — the easiest module class.
2. The first module that stepped off that path (saved filters) immediately
   needed a hand migration and a bespoke executor. The honest reading is *"the
   press covers what it covers, and the program noticed."*
3. **No module has ever been used through a composed product**, so "a module
   works" has never been tested — only "a module compiles, stores, and answers
   its own harness."

The goal should not mean "every ERP behavior is zero-code." It should mean
**ordinary modules are data, and specialized code stays versioned, governed,
shared, and visible to the compiler.** That is already the plan's intended
distinction; saved filters violated it in implementation.

There is no market evidence yet. Fifty-one packets without a usable application
validate neither demand nor workflow quality — a reason to reach a product
sooner, not to abandon the goal. Re-run this verdict at the G3 program review,
where the factory meets its first non-CRUD domain.

## Dial B — Verdict 2: is the APPROACH right

**ADJUST MATERIALLY — keep the architecture and the cadence; correct the
verification economics and add composition as an acceptance axis.** Both arms.

Working and verified: the modular monolith with scanner-enforced boundaries; the
deterministic-compiler and release-pointer bets; one-real-module-before-fan-out
(which caught the manifest-version, case-fold, and resolver defects exactly as
designed); step packets with honest red reporting; debates that settle design
before code; and the trigger-gated program review itself, which has now fired
correctly twice.

Fable's framing is the precise one: **this is not a program bending away from
its plan; it is a program whose plan-conformance instruments outran its
product-observation instruments.**

**On "zero press changes":** the right *guard*, the wrong *headline*. It froze
the press during fan-out and forced the Location capability-status finding into
the open. But it measures the factory's input discipline, not the product's
output — a module can score perfect while shipping one-seventh of its anatomy
and rendering diagnostics, which is what happened three times, celebrated each
time. The plan itself never endorsed the shorthand: §15.7's productivity gate is
a bundle. **Replace it with a module-acceptance bundle:** zero press edits *and*
ratchet-clean against exact anatomy *and* a composed-journey demonstration *and*
an honest ten-cell support claim.

**On the template:** the canonical definition is the right artifact; copied
definition and test bodies are not. The multiplier is proven — the platform
package inherited 33 violations *after* the defect was identified — and the
copied scaffolding extends further than the ledger records: the press guards
diverged, the runtime harnesses are ~92% identical and all encode the superuser
CAS bypass, and no browser spec asserts the absence of the
`UNSUPPORTED_COMPONENT` diagnostic, which is why nobody saw the panels. A prose
template cannot hold against that gravity — the pinned `ux-grammar` skill spelled
out all seven Record slots before any module existed, and the template won
anyway. The right artifact is **generated-or-discovered, not copied**. Keeping
the `adding-a-module` skill *after* the anatomy packet is correct; writing it
first would make the defect doctrine.

**On the layer-shaped gating pattern:** present systematically, and it is the
program's characteristic failure mode. Named instances across both arms: the
conformance checker fed a fixture; the component registry against a compiler
that validates no components; agent projections with no runtime; the outbox
written and never drained; saved filters storing predicates nothing can execute;
per-module browser journeys instead of a composed one; generated verification
plans against unbound release admission; permission references against absent
policy evaluation; trust writes against an absent read path; Platform's compiled
storage against its hand-written real storage; and G2-P9 itself, cut to certify a
composition no packet owned.

The root cause is structural, and Fable named it best: **in a fast AI-driven
program, layer-local gates are cheap to author because the writer controls both
sides, while composition gates require the scarce resource — integrated product
attention.** The program over-bought depth where depth was cheap (eight review
rounds on an index-observation oracle) and under-bought the one observation that
was expensive (opening the app).

**The antibody is an admission rule, not a heroic review:** for every artifact
family the press emits, "supported" requires at least one **executed proof on the
consuming side** — doctrine #10 read as a gate rather than a definition. Any
packet claiming a supported capability must name its final production consumer,
and a required walking-slice leg may not be deferred as non-blocking future work.

Launch scope is otherwise right: Q1-before-G3, policy-kernel-before-G3, the
accounting exclusion, and the G2-demonstrable ruling are all correct calls. Keep
bounded charters, review tiers, and the packet cadence.

---

## Reviewer evidence and reconciliation

| | Codex `gpt-5.6-sol` xhigh | Fable max |
| --- | --- | --- |
| Headline | Components credible, do not compose | Organs real, organism is not |
| Dial B1 | KEEP, stop describing it as proven | KEEP, claim sharpened |
| Dial B2 | ADJUST MATERIALLY | ADJUST |
| Unique contributions | Release-admission verification integrity; lawful erasure | Slot/render disconnect + shipped false support claim; disposition leak; F7/F1 promotion; press-guard divergence; determinism nits |
| Could not verify | Fable spawn returned `ENOTIMP` (its own attempt); read-only sandbox blocked temp dirs, so no full CI/PostgreSQL/browser run | Did not re-run full matrix; ran the conformance ratchet at HEAD (`catalog=33/33, location=33/33, party=64/64, platform=33/33`) |

Both arms independently reproduced the production conformance observation
33/33/64/33 — agreeing with the G2-P5c baseline and with each other.

The reconciliation required one substantive correction (AD-1): Codex's
application-graph BLOCKER is a real fact with an oversized disposition, and the
executed probe shows the cheap route is legal today. Everything else from both
arms was confirmed rather than adjusted. No finding from either arm was
dismissed except the two explicitly marked dismissed-with-reason above.

---

## Recommended course corrections

Surfaced as decisions, not actions taken.

1. **Build the composed application now, and make a composed journey a standing
   gate.** Author one application package (proven legal today per AD-1); wire
   gateways to PostgreSQL; honest demo authenticator; real approval→activation.
   Add one composed-product browser journey to the permanent matrix from that
   packet onward — the antibody to the entire finding-1/finding-11 class.
2. **Re-scope G2-P5d** from "declare the missing slots" to "unify slot dispatch
   with the data path, grow the registry, and burn the anatomy down," carrying
   AD-3's disconnect fact and the stale "130" (it is 163).
3. **Adopt a disposition-integrity rule and run a one-time sweep.** No finding,
   packet limit, or routed risk may terminate in prose; every disposition names
   an existing row or creates one. Sweep: saved-filter F1, trust read-model/NC3,
   query-denial evidence, the ADR-0011 platform contradiction, the repo-shape
   mapping.
4. **Repair release admission** before relying on the release kernel: persist
   executed verification, require exact plan/result conformance, ban random
   evidence IDs and direct pointer mutation from any conformance journey.
5. **Resolve the Platform classification** — genuinely generic, or declared
   Tier-B with the decorative declarations stripped. Add `northstar.platform` to
   the press guards and consolidate the four divergent guards into one.
6. **Retire "zero press changes" as the headline**; adopt the module-acceptance
   bundle.
7. **Promote the small correctness packet** (F7 + F1) above the baseline/curve
   rows.
8. **Change review admission, not review intensity.** Every packet claiming a
   supported capability names its final production consumer; a required
   walking-slice leg cannot be deferred as non-blocking.

---

## Standing lesson added

> A recorded finding with no owning row is a disposition with no executing gate.

This is the documentation twin of the program's existing lesson that every
escaped defect was a declared rule with no executing gate. It is the mechanism
that produced this review's trigger, and it is the cheapest of all the
corrections to close.
