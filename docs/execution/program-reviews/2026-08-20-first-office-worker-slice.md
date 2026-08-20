# Program review — the first office-worker slice, 2026-08-20

**Reviewed SHA: `7e1c81524008dd0b3a7bbfc461034ed2f84c89a4`** (`main`, clean, no lane in flight).
**Trigger:** the first end-to-end vertical slice completed and a purchasing/sales fan-out
is imminent — the `program-review` skill's named highest-ROI point, "because a flaw still
in the template is copied into every module built on it."

**Two independent arms, no shared context:** online Codex `gpt-5.6-sol` xhigh, and Fable
max (structured as a doctrine read plus four scoped sub-reviews). Neither executed
anything — Docker was unavailable — so every dynamic claim in both rests on source and
recorded evidence. **The orchestrator independently verified the load-bearing findings
against the tree; those verifications are marked VERIFIED below.**

---

## 1. Dial B — the two verdicts

### Goal: **KEEP.** Both arms, independently.

Codex: keep and sharpen the claim. Fable: keep, restated as an economics test. **Same
verdict from two arms that could not see each other, which is the strongest signal this
review produced.**

**The sharpened claim both arms converge on** — and it replaces the unfalsifiable form:

> One declarative module definition generates every supported projection. **Ordinary
> module variation requires no module-specific platform code.** A genuinely new semantic
> class may extend the platform **once**, as a reusable capability, and must then work
> across more than one module.

**The tripwire, armed at fan-out (Fable's, adopted):** at `PUR-1` + `SAL-1` acceptance,
count platform packets beyond the chartered posting-family work. **≤2 → the factory
economics hold where they matter. >4 → the goal question reopens at the next review**,
with the fallback being the narrower claim that ordinary modules are data while
specialized code stays governed and compiler-visible.

**What is genuinely proven:** a deterministic press with recomputed verification at
admission; immutable releases with request pinning; semantic gateways as real choke
points; a posting engine that is one engine rather than accreted cases — transactional,
concurrency-safe, idempotent, period-locked, correction-capable.

**What is not:** zero-dev-code is proven only at compile time. **No module has reached
operator-usable without platform work.** And there is **zero market evidence** — two
program reviews have now said the same thing: every instrument in this repository
measures engineering, and none can answer whether anyone will buy this.

### Approach: **CHANGE the execution method.** Both arms.

Keep every architecture bet — modular monolith, deterministic compiler, release pointer,
gateways, top-level posting transaction, the broad stage order, and the launch-scope
boundaries. Keep the step-packet cadence and the 2026-08-10/14 doctrine corrections,
which measurably cut review rounds from 5–7 to 2–4.

**Change five things:**

1. **Mechanize control verification.** Rounds 1–2 find production defects; rounds 3+ audit
   evidence by hand.
2. **Gate the record layer like the code.** The month's largest single loss was a record
   failure, not a code failure.
3. **Reinstate a scope instrument**, and write down which document actually owns
   sequencing.
4. **Spend about a week disarming the template's traps before fanning out.**
5. **Fix the evidence substrate.** A program whose product is evidence cannot run that
   evidence on a machine that has twice forged an outcome.

**Stop parallel fan-out.** Both arms, emphatically. `PUR-1` must run alone as the factory
experiment; running `SAL-1` beside it destroys the signal by letting both converge on a
shared mechanism that fits each other while breaking inventory.

---

## 2. Where the arms disagreed, and how it was adjudicated

**The orchestrator's charter was wrong in three places, and only one arm tested it.**
The charter asked to be treated as a claim under test. Fable did; Codex reasoned from it.
**All three corrections were verified against the tree:**

- **"The factory claim is untested — no zero-dev-code module has been built" is
  overstated.** Catalog (`G2-P6`), Location (`G2-P7`) and the saved-filters platform
  package (`G2-P5b`) compiled with **zero press changes** — ledger facts. The true and
  sharper statement is that no module has reached *operator-usable* without platform work.
- **The `familyId` magic string and the `goods_receipt` branch are NOT on `main`.** They
  exist only on the never-merged `packet/ps-1` probe. `main`'s posting engine is clean.
- **The merge-direction failure was two lanes independently, not three consecutive
  packets.** Five correct `--no-ff` merges have followed.

**Consequence, recorded plainly: a charter is not neutral input, it is steering.** Codex's
Dial B reasoning is weighted against evidence that is not real. Its verdict survives
because both arms reached it independently, but its cost accounting is bleaker than the
tree supports. **The orchestrator wrote that charter.**

**Both were also wrong on one count.** Stale conditional-ratification ADRs: the
orchestrator said four, Fable said eleven, **the tree says seven** (0026–0030, 0033, 0049).
The number matters less than what it proves — fixing them one at a time is the wrong
instrument.

**Where Codex is the better framing:** its Finding 1 treats operator legibility as a
**missing acceptance axis**, not a mispriced packet. Posting correctness and point-query
correctness were made first-class gates; "can an authorized operator discover and
understand the result" never was. That is the more durable correction, and it is adopted.

---

## 3. Dial A — ranked findings and dispositions

### R1 — The record layer is the only ungated subsystem. **FIX NOW.** Both arms rank it first.

The 2026-07-27 review coined *"a recorded finding with no owning row is a disposition with
no executing gate"* and filed queue row **`1a`**, annotated **"Cheapest correction on the
whole list; take it immediately."** **VERIFIED: row `1a` exists, is Mechanical, and has
been dormant since.** In the interval that same review's A2 finding was recorded a fifth
time, contributed to two packet BLOCKs, and was owned only when `inventory-form-anatomy`
tripped over it. **The lesson recurred as an instance of itself.**

Live at this SHA: seven stale ADR ratification lines · a `current-plan.md` footer reading
"Last updated: 2026-07-30" above 2026-08-20 entries · `dev-seed-has-no-inventory` still
arguing Tier 1 after its own drop-trigger fired · a duplicated ledger row · owed
correctives existing only as queue prose.

**The program has gated process rules three times** (`check-review-record.sh`,
`check-origin-sync.sh`, `check-parked-work.sh`, each with a hook) **and the record layer
zero times.**

**Disposition:** `scripts/check-records.sh` in the proven pattern — stale conditional
ratifications fail against the ledger, rows naming accepted packets or fired triggers are
flagged, every "routed to" must resolve, duplicate IDs fail. **The orchestrator performs
the one-time sweep** so the gate lands green; the lane builds the gate.

### R2 — Control verification is a missing mechanism, and it is ~80% built. **FIX NOW.**

**The decisive measurement, Fable's:** the one packet that committed its mutation runner
(`scoped-create-operand-mutations.mjs` — apply a named one-property mutation, run the
focused suite, require the exact expected red, restore) **converged in 2 rounds. Its
neighbours took 4–7.** Everywhere else, `AGENTS.md` §6's demanded reds are performed by
hand and transcribed into review-log prose, executable never again.

**Disposition:** generalize the 199-line runner into a manifest-driven expected-red
acceptance gate, plus an architecture check that every fenced claim names at least one
manifest entry. Backfill the mutations already recorded as prose. **What honestly stays
with reviewers: mutation choice and fixture self-correlation.**

### R3 — Two armed traps the template will copy. **FIX NOW, before fan-out.**

**(a)** Roughly fifteen distinct provider write-refusal codes survive to the web boundary
and **all render as one generic "Save unavailable"** — the web maps by error *name*, not
*code*. One code is hand-carved through, proving the route exists. **Purchasing and sales
are write-heavy; every new domain refusal would be born illegible.**

**(b)** The slot registry lets a **non-mutation slot veto all writes** — authoring the
grammar-required `activity`/`childTables` slots ships inert forms. **That is the exact
mechanism behind the five-inert-Inventory-forms incident, still armed**, with the dodge
living in a baseline comment.

### R4 — Gate-invisible scope evaporates. **DECISION REQUIRED.**

The stage-gate instrument has been dormant since G1 — exactly one stage-gate evidence
document exists. The plan's G3 build list required balance and availability read models, a
stock-overview UI, and agent support; **scope whose absence fails nothing evaporated
between packet-level acceptances, then resurfaced as "why can't a pilot user see
anything."** G4's list carries the same class.

**Not the architecture's fault — the gates'.** Meanwhile the plan calls itself "the single
sequencing authority" while real authority is the TRIAGE plus user directives never
written back into it.

**Disposition — the user chooses:** either stage-gate evidence documents return as a scope
ledger, or the plan is amended to devolve sequencing to `current-plan.md` explicitly.
**Either is legitimate. A nominally supreme, practically ignored plan is not.**

### R5 — A green gate makes a false claim. **FIX NOW.** VERIFIED.

```ts
export const INVENTORY_POSTING_CAPABILITY_ID =
  `${'northstar'}.${'inventory'}:capability.posting` as const;
```

The press-law guard matches `escapeRegExp(module.namespace)` against **source text**. The
source never contains the contiguous banned identity — it is spliced across template
interpolations — while the evaluated constant **is** that identity. **VERIFIED at
`inventory-posting-service.ts` and `module-press-law.ts`.** Open since 2026-08-08.

**Not malice** — the debt ratchet was one file short and no sanctioned exception was cheap
enough. **But a green gate asserting something false is this program's own worst
category.** Unsplice it and pin it in `routedPlatformDebt` with an owning row, or land the
adjudicated fix. **Consider refusing the splice idiom in production source.**

### R6 — The browsable balance is mispriced by several packets. **RE-CHARTER.** VERIFIED.

**This overturns a conclusion the orchestrator recorded on 2026-08-20.** The lane measured
the grouped-aggregate route correctly — `maximumResultCount: z.literal(1)`,
`grouping: 'unsupported'`, three one-property probes each `CANON_SCHEMA_INVALID` — and the
orchestrator accepted that as *the* route. **Neither checked whether another mechanism was
already sanctioned.**

**VERIFIED: ADR-0007 line 23 classifies materialized balances, cached totals and reports as
"rebuildable read-model projections."** And `inventory_movement` ships in the release with
**zero authored operations**, proving the press already admits a platform-written
browsable entity. The provider already maintains per-stock-identity totals transactionally
with a reconciliation arm.

**A posting-maintained `stock_balance` entity through the ordinary list query is one
packet.** **The honesty condition:** it answers "sum of all posted movements," not "on-hand
as of an instant." **Charter it as posted stock, declared as such, with reconciliation as
its honesty instrument.** The five-parameter lookup remains the precise bitemporal tool;
the grouped-language contract stays recorded for the next language cut.

### R7 — Authorization is a deny-capable skeleton with a constant-ALLOW evaluator. **DEFERRAL STANDS, with two smalls now.**

Half the 2026-07-27 finding is repaired — both gateways evaluate boundary and compiled
permission through deny-capable checkpoints, denials persist, scope re-authorizes per use.
Still true: **every production policy gateway returns ALLOW.** This is an explicit,
honestly recorded user ruling (row 7, "LAUNCH BLOCKER"), not drift.

**What should not wait:** a declared permission with no evaluator binding should **fail
compilation**, so the vacuum announces itself; and **VERIFIED —
`module_storage_backfill_checkpoints` has tenant columns, module-role write grants, and no
RLS at all**, the single exception in an otherwise consistent posture.

**Give row 7 a hard trigger: before `SAL-1` or the first outside login, whichever comes
first.**

### R8 — Posting-error classification sniffs any `code`. **FIX NOW (small).** VERIFIED.

`postgresErrorProperty` checks only property existence and string type, so **any error
carrying a string `code` is reported as a PostgreSQL storage rejection** — Node `ERR_*` and
`ECONNREFUSED` qualify. A connection drop mid-posting reads as a storage rejection, and the
same sniff gates the `23505` replay branch. **G4 posts through this engine; every future
incident would start with a misdiagnosis.** One-line SQLSTATE shape guard, its own small
packet because it moves a pinned error contract.

### R9 — The evidence substrate has forged outcomes twice. **PROMOTE.**

`container-pressure-forges-outcomes` records two independent reproductions of a **wrong**
release-activation outcome under Docker volume pressure. Its own words: *"everything else
in this tier costs time; this one costs correctness."* **It is unowned, in Tier 3**, while
the matrix runs 11–28 minutes serialized at ~1.29× baseline on one laptop where Docker
currently does not start.

**Cheap half now:** record container state inside every matrix log and refuse acceptance
runs above the measured pressure threshold. **The strategic half is Dial B item 5.**

### R10 — Version-cut hygiene, and four false comments. **COMMENTS NOW.**

Four cumulative predicates hand-enumerate `'v2'||'v3'||'v4'||'v5'` across three files — a
v6 cut silently exits all of them, the documented v5 failure mode — while the correct
ordered-list form already exists in-file. `projectionDispatchRevision` rewrites
`languageVersion` to `'v2'` so equality reads "v2 only" and means "always."

**And four comments still assert profile v2 is "deliberately NOT adopted" while the shipped
lineage head attests v2.** **False prose in a program that prosecutes false prose.** Fix
the comments now at zero byte risk; convert the predicates before any v6 cut — which R6's
grouped contract would otherwise force unprepared.

### R11 — The trust substrate is write-only. **PROMOTE AT G4 CHARTERING.**

Trust rows are written atomically on every accepted mutation; **nothing reads them.** The
outbox has no delivery-state columns, `apps/worker` is an empty stub, query-side denials
persist nothing, the activity rail is slotless. Six web mappings are frozen `INACCURATE` in
place. **Each freeze was correct packet discipline; collectively they are a debt class
nobody is chartered to retire.** G4 wants document timelines — their substrate is the
unread trust tables.

### R12 — Record mass is outgrowing its readers. **FOLD INTO R1.**

`current-plan.md` is 402KB with single rows up to 8.5KB; the ledger is 284KB;
`review-tiers` is 936 lines against its own ~15-row consolidation bound. **The TRIAGE
exists precisely because the queue became unreadable, and stale prose hides best in mass.**

### R13 — Batched smalls and dismissals.

Lifecycle buttons skip compiled preconditions · a second query-catalog reader guarded by
call order · unbounded on-hand anchor cache growth (fine at pilot scale) · two hand-written
trust-evidence writers · `recordedAt` has no monotonic floor · browser specs assert
"Create complete" seven-plus times with no shared constant.

**Dismissed with reason:** the dead `return cached` (a deliberate, commented mutation
victim) · the executor's `authorization: 'ALLOW'` literal (truthful — DENY cannot reach
it) · per-file `hasExactKeys` twins (private, tolerable) · **"the surface needs another
rewrite"** (it has a coherent central contract and registry; the remaining problems are
seams) · **"the capability floor is unenforced"** (the compiler emits it, the runtime
carries it, the provider refuses) · **"release admission is structural self-attestation"**
(`ensureReleaseAdmitted` now recompiles and evaluates declared scenarios) · **"the posting
kernel should be simplified"** (its complexity is correctly placed).

---

## 4. The single thing to change first

**Both arms, independently: make dispositions executable.**

R1's records-integrity gate plus row `1a`'s sweep. It is the cheapest item on either list,
the script-plus-hook pattern exists three times over, it is the mechanism behind the
month's largest loss, and it stands behind at least four other findings here.

**Fable's closing sentence is adopted verbatim as this review's own condition:**

> *Until dispositions are gated, a program review is one more prose record waiting to
> become its own next instance.*

---

## 5. What neither arm examined

Neither executed anything — no matrix, no app boot, no probes; Docker was unavailable, so
recorded greens were not reproduced and golden digests were not re-derived. Neither
operated the running application. The agent architecture (plan §9) is unbuilt and
unreviewed. The salvage quarry was untouched and `salvage-admission` compliance unaudited.
The visual system, performance and SLO claims were read but not validated. Depth sampling
was partial — roughly ten of fifty-seven ADRs in full, and the largest test files by
structure rather than line by line.

**Neither arm validated the market thesis, and neither could.** Both said so unprompted.

**This record is a two-arm converged review.** Fable's arm noted correctly that a
single-arm report must not be recorded as converged; both arms are present here, and the
orchestrator's independent tree verifications are marked VERIFIED.
