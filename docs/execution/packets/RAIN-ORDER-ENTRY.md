# RAIN-ORDER-ENTRY — normal metadata-defined order workspace

Status: evidence_ready; RAIN WORKSPACE INTERACTION COMPLETION (owner-authorized charter after the product-parity audit) implemented at executable `d9eca60a1d4ddbac6d69aaf323e53fc423b5721a` on the same PR #6 branch over audited candidate `35e3eaa1ba6dd912067c7c0d58ac3128c6b2a71e`: working Inventory destinations, eligible pickers and policy-aware quick create (A), in-place reference fragments (B, ADR-0036 behaviour 7), shared control semantics through Tasks (C). FORM-1..4/PAGING, editor F1/F2/F3 and Task P1/P2 preserved; sole LOCAL author; fresh CI / ONLINE review of the changed boundaries / owner acceptance pending; no merge/deployment.
Tier: Behavioral. Actual AGENTS §4 Critical set untouched; no local arm.
Dependency/base: `3830f95b6ff05c8e2b80113f812d59359a67f448`, open draft PR #5.
Branch/worktree: `packet/RAIN-ORDER-ENTRY`, `/home/rvham/2rain-greenfield-rain-order-entry`; draft base `packet/RAIN-META-SALES`.

## Workspace interaction completion (2026-09-26)

Owner-authorized charter after the product-parity audit and online
assessment. Three milestones on the same PR #6 branch over audited candidate
`35e3eaa1`; synthetic data only; reference `d057daff` used for interaction,
not architecture.

| Milestone | Reproduced cause | Change | Evidence |
|---|---|---|---|
| A · navigation/availability | Period lock: the composed release declares two update operations (advance, reopen) and no form, so the binder refused the whole family (INVALID_SURFACE_BINDING). Inventory lists: scoped queries without declared company entry. Line tables were operator destinations. `+ New` ignored authority; customer/vendor pickers listed every party. | A form-less family leaves its surplus create/update unbound; every exactly-one-scoped List declares company entry; line tables contextual, shown inside their documents; `SemanticOperationGateway.previewEligibility` (policy only, no write/evidence/grant) gates `+ New`, and a denial at invoke offers Cancel only; picker `eligibility` = related-record filter (EXISTS before count/page, echoed, cursor-bound) re-checked on every selection route; distributor seed gives partners their stated roles. | Integration: form-less binding, eligibility and create availability; PostgreSQL related filter (count/page/search/cursor/tenant); browser composed navigation. |
| B · in-place references | Submit-to-search; every search/select a full document. | ADR-0036 behaviour 7: focus/type/More/select/clear/create answered by same-origin fragment POSTs (`x-rain-fragment`, `connect-src 'self'`), bound to session, per-field lookup sequence and selection generation; answers name the one element they replace; fallback to the ordinary submit. Combobox popup, `+ New` last row, Enter never saves, Escape closes the popup first. | Integration: superseded/late/replayed answers, two fields out of order, withdrawn read, removed row, company, expired session, create-in-place/denied/cancel, HTTP guards. Browser: document loads vs fragment requests, held late answer, JS off. |
| C · shared controls | Receiving typed Base unit and currency; tasks had no choice/derived/decimal semantics; order views hid stored fields. | `control-semantics.ts` shared by editor, quick create and Task inputs; Task input `presentation` (derived from a selected-row column, choice with declared/record default, multiline); decimal bounds from the bound field; receiving unit derived, currency offered from the order; product quick-create base unit offered from configured codes; completion shows a business result; order views read back order date, currency, notes, unit price/cost. | Integration: receiving forged unit ignored, forged currency and malformed cost refused before any step, exact committed values; renamed non-Sales Task choice; validator refusals. Browser receive journey. |

Decisions of this increment:

- ADR-0036 §2 gains behaviour 7 under §2a; §7 names what stays refused (client
  caches/filtering, fetch beyond the fragment POST, script-composed elements).
  `ux-grammar`'s reference rule is amended in place (no new rule, one line
  shorter). No framework, library, router, store or second script.
- Surface manifest capability 9 when picker eligibility or typed Task inputs
  are declared; the runtime supports 9. Historical floors unchanged.
- The CSP adds `connect-src 'self'` only with gateways composed.
- Eligibility-to-start is not authority: invoke still decides per input, so a
  revocation after opening is refused and reported without a Retry loop.
- Selection is re-read through the declared get AND re-checked for
  eligibility on select, carrier change and create-and-return.
- Currency and unit code lists are editor policy over text fields, not unit
  masters or conversions.
- Field problems describe their control and never rename it: in the order
  header, quick create and Task inputs the message follows the label
  (aria-describedby), focus opens on the first input with a problem
  (autofocus without the script), and a modal Task reserves its pinned
  footer's height when scrolling to it.
- Quick create names existing matches before a second record is made: the
  field's declared list read by the same request without and with its
  eligibility, at most five, never the flow's own minted records, only before
  an attempt; any failure omits the warning. It warns and never blocks.
- One focus ring for every input, select and textarea (order lines, Task
  inputs and multiline fields had the browser default). The focus-ring gate
  now also visits the Sales order draft editor, so `textarea` is measured on
  its real ground rather than admitted by a list.
- One application lineage entry for the increment. Development compiles had
  appended four (14 -> 18); every fresh tenant replays each transition, and
  the composed PostgreSQL suite slowed 10-30% until "advances an existing
  deployment" passed its 300s bound. None of the four was pushed or served
  beyond disposable fixtures, so the lineage is 35e3eaa1's fourteen entries
  (byte-identical) plus one compiled from the unchanged authored source. The
  bound is unchanged. Proof: the fourteen entries and the bootstrap hash
  identically at `35e3eaa1` and at the head, and `git diff --numstat` reports
  660 lines added and none deleted in one hunk. A database active on a dropped
  intermediate entry refuses to start (the runtime requires its active release
  in the lineage) -- fail-closed; only disposable fixtures ever activated one.
- ONLINE review of `35e3eaa1..8bfe8fc0` (D1-D5), corrected: every request on
  a reference field takes the field's next number and only the newest answer
  is applied, and a field accepts no further change or lookup while one is
  answering (D1); answers may replace only the requesting field, its lookup,
  the dependents the server declared for it and the create slot; a selection
  re-checks the newest offered set after its read, and every refused
  selection drops its lookup (D2); create-open is bound to the field
  generation and re-checks create ownership, save state, draft, row and field
  immediately before opening (D3); quick create marks and natively autofocuses
  the same field (D4); a current request's transport failure is repeated as
  the ordinary submit, a cancelled lookup or a page being left is not (D5);
  without fetch metadata a fragment must carry an Origin naming this server.

## Form-usability correction (2026-09-25)

Owner rejected the reviewed forms: generic text inputs, inadequate reference
pickers, no in-context creation of missing customers/vendors/products, and a
stacked line layout. Reference: disposable PaneFlow copy at `d057daff`, driven
in a real browser (customer combobox with "+ New customer", currency select,
one-row lines).

Claims of this delta:

1. Canonical editor metadata declares each control: `choice` (offered set,
   declared default) over a text field, `multiline`, `derived` (read from the
   sibling reference's exact get), and reference pickers (list query, exact get,
   label/detail fields, optional governed create flow). The compile-time
   validator checks every binding against the entity model; the schema is closed.
2. One reusable reference control serves Customer, Vendor and Product: server-side
   search and paging, selection only from offered results re-read through the
   declared get, keyboard search/selection, loading/no-results/error states, and
   "+ New X" quick create returning to the same document, line and field with
   focus. A form-changed carrier is accepted only after an authorized exact read.
3. Quick create chains existing governed creates (Party then an active customer or
   supplier PartyRole; Item), keeps every entered order value, works on an
   invalid order, mints stable keys and record ids once, reports denied, partial
   and read-back-withheld outcomes without selecting, and cancel writes nothing.
4. Lines render as one aligned row under shared headings (Product | Quantity |
   Unit | Unit price or Unit cost | Remove), stable line identity, compact cards
   at phone width, no dead Tax/Discount/Route/Bin/FX columns.
5. Exact decimals stay strings: canonical spelling, bounds from the pinned
   operation contract checked before any step commits, comparison by value so
   unchanged reopened lines plan no update. Save names each missing or invalid
   field beside its control and writes nothing. The one numeric conversion is
   the shared typed control's finiteness probe (`Number.isFinite(Number(value))`)
   deciding whether a native number input can display a stored value; it keeps
   the original string, so nothing is rounded. An earlier handoff's "never
   passes through Number" wording was wrong and is withdrawn.

### FORM-1..4 review correction

Source counterexamples came from the ONLINE reviewer; each was reproduced
here before correction, through the harness named. Evidence kinds:
controlled executor (real SurfaceRuntime, policy and semantic gateways over the
integration stub executor), browser against isolated PostgreSQL, and
normalization. No hosted evidence is claimed.

| Finding | Pre-fix observation | Correction | Tested result |
|---|---|---|---|
| FORM-1 unselected lookup results under current authority | Controlled executor through SurfaceRuntime: after a customer search showed name/number sentinels, `party_read` was withdrawn between requests; the Add line, failed repeat-search and failed More responses all still contained the sentinels. | The buffer keeps only term, pages requested and ids last offered. Every response re-reads displayed pages through the declared lookup under its own authority (request-local reuse only); any failed read drops the lookup. Offered-selection and exact-read checks kept. | Controlled executor: all three responses free of sentinels, no operation calls, then authorized search/More/select work. Browser/PostgreSQL: after 20+ results and More, withdrawn read plus Add line discloses none of the shown names. |
| FORM-2 Enter must not cancel quick create | Real browser on the fixture, JS on and off: Enter in New customer Name submitted `draftCreate=cancel`; the dialog closed and nothing was created. | Primary submit is the form's first submit button (visual order matches); Cancel stays explicit with `formnovalidate`. No script change. | Browser/PostgreSQL, JS on: Enter with number missing sends no request (native `valueMissing`), explicit Cancel creates nothing and keeps the order, Enter in Name creates and selects exactly one party with a customer role, Enter in product Base unit creates it. JS off: missing-value Enter sends nothing, Cancel keeps the order with zero parties, Enter in Name creates one party with a customer role. |
| FORM-3 choice metadata inside quick create | Controlled executor, compiled variant with `item_base_unit` choice EA/BOX default EA: plain text input, no default, forged `PALLET` returned 200 and `item_create` ran with `PALLET`. | Create fields use the editor's shared choice render/admission/default helpers: native select, default applied once when a flow opens, every collected value (choice and required) admitted before any step, values frozen only once admitted, a refused value cleared rather than defaulted. | Controlled executor: Sales variant renders EA selected, `PALLET` gives 422 with zero operation calls, `BOX` creates and derives the unit. Non-Sales variant (Purchase, renamed, two-step inventory transaction then line with the choice on step 2): `PALLET` gives 422 with zero calls — the earlier step did not run — and `BOX` runs both steps with the relation bound. |
| FORM-PAGING silent lookup truncation | Controlled executor with deterministic paged data (201 matches, twenty per page): after Search and nine More, 200 shown, no More, no message and no "no matches" text although match 201 existed; a direct More at the cap returned 200 with the same silent state. | Query continuation (this request's read) and the display limit (ten pages) are separate facts. Exhausted: nothing more. Continues below the limit: More. Continues past it: "More matches exist. Refine your search." directly under the search box, which it describes and which takes focus; no More that cannot advance. A More at the cap re-reads the same bounded pages. A new search starts at page one and replaces the offered ids. Only a current authorized read may state that more exist. | Controlled executor: 201 states the limit, More below the cap works, a More at the cap is bounded (at most ten list reads) with no mutation, narrowing finds and selects match 201 with the order kept and the old offered id refused; exactly 200 is exhaustion with no message; read withdrawn at the limit shows no labels and no claim. Browser/PostgreSQL with 201 masters, JavaScript on and off: message and no More after nine presses, focus on the search box, keyboard refinement to match 201 and keyboard selection, order values kept. |
| FORM-4 validate every supplied exact get | Normalization: a plain customer picker (no create, no details) naming `item_get` was admitted. | Any supplied get must be a get of the picker entity selecting its labels and details; absent-get legacy pickers keep their behaviour. | Normalization with literal diagnostics: valid plain list/get passes; `item_get`, a list as get, a missing query and a same-entity get lacking the label are refused; legacy absent get passes. |

Decisions of this delta:

- Currency is an editor choice (CAD/USD/EUR, default CAD) over the domain's text
  field. It is editor policy, not a domain rule: a stored value outside the set
  is shown as "(current value)" and kept on unrelated edits; a submitted value
  outside the set is refused.
- The Sales unit is derived from the selected product's base unit and never read
  from the form; Purchase has no unit field. No price, conversion or commercial
  default is invented.
- "+ New X" is offered when every step is a bound governed create without a
  human confirmation grant. This is availability, not authority: the operation
  gateway decides each step at invoke time and a refusal is reported without a
  write. Per-principal pre-authorization of the button is not claimed.
- ADR-0036 §2 gains a sixth behaviour (reference-control keyboard presentation)
  under its §2a test; the create dialog reuses behaviour 5's native dialog, with
  Escape activating the server-rendered Cancel. `ux-grammar` records the
  reference-control rule. No framework, router, store, tenant script, client
  fetch or client business rule.
- `CompiledSurfaceInputField` gains the pinned contract's `bounds`, read from the
  same admitted operation catalog; the provider still enforces them.
- The order-entry fixture gains `--distributor` (master volume only) and two
  verify-mode switches — revoke/restore one named permission, count stored
  masters by name — so browser proofs observe refusals and duplicates in
  PostgreSQL.
- F2/F3 integration witnesses now drive their provider refusal with a well-formed
  quantity the stub provider refuses (the editor refuses `'invalid'` before any
  commit), and use a line's own unit price as the child sentinel (unit is
  derived). Their subjects are unchanged.

## Claims

1. Typed workspace membership compiles operator navigation independently of capability existence; document/task context highlights the owning workspace.
2. Declared entry uses current authorized active companies: single auto-entry, scoped advisory preference or choice, useful no-access state, invalid explicit scope refusal.
3. Shared Record draft authoring binds readable party/product references, header and multiple lines to explicit company/parent through existing semantic gateways.
4. Sequential Save keeps stable identities and exact frozen retry inputs/keys, reports partial/withheld outcomes, handles stale revisions, and confirms governed persisted archive; Save remains distinct from Release.
5. Browser-created Sales and Purchase orders save/reopen exact two owned lines without draft stock effects; existing fulfillment/packing and receiving run in document context. Closed P1/P2 kernels are unchanged.

Owned: canonical schemas/validator/exports, compiler surface output/capability admission, domain workspace declarations, web entry/navigation/shared draft editor/transport, affected fixtures/tests/artifacts/inventory, approved ADR/UX/plan amendments, this packet and one-line queue/ledger/lanes records.
Boundary: no pricing/tax/FX expansion, target-order seeding, bespoke Sales renderer, prototype, inherited audit, retained process/data/lock replacement, PR #5 rewrite, merge or deployment.

## Decisions

- Owner approves ADR-0030 navigation membership, ADR-0037 authorized entry and ADR-0015 advisory-preference distinction; narrow UX/plan text aligns.
- ADR-0047 §7 admits additive optional declarations on adopted v6; workspace/editor requires capability 8; absent keys and historical floors/bytes remain reproducible.
- Existing Record slots/typed controls render both editors; a metadata-only Purchase label variant and unrelated canonical fixture exercise reuse.
- Purchase line has no writable unit field: picker displays product base unit. Receiving requires explicit unit plus actual cost/currency or an explicitly absent-cost action, with no order-price fallback.
- Buffers/preferences are process-local, scoped to trusted identity/release/company; buffers expire monotonically after 60 minutes. No durable autosave or atomic Save claim.
- Supporting masters retain existing setup/module destinations; contextual surfaces, queries, operations, raw deep links and agent discovery remain available.
- Bridges: Sales browser uses independent buffers for stale conflict and exact Line column; mixed-version test attributes paths to the actual mutated entities instead of assuming index zero.
- Inventory re-derived without instrument changes: 2,299 → 2,351 obligations, 554 → 601 observations; new decision identities, unchanged two unhonored join-eligibility entries, no per-obligation execution claim.
- Program review not due: unintegrated vertical, no stage boundary/new posting domain/imminent module fan-out; no autonomous review launched.
- New caller seam delegates pinned Task/draft continuations to their own checks; buffered persisted lines reauthorize before display/writes. Committed redacted replays retain HTTP 200, with no cached fields or retry controls. P1/P2 kernels unchanged.
- Draft recovery now records acknowledged gateway receipts separately from an immutable pending plan. A pending exact retry reaches receipt lookup with its original key/input/revision; fresh edits still compare current revision. Correctable replanning removes only acknowledged archives and keeps unexecuted removals governed by confirmation.
- After continuation identity/release/scope/document validation, initial header, workspace, pre-execution header/child and final render reads share one acknowledged-aware boundary. Read loss after an acknowledged partial save returns redacted HTTP 200; zero-ack, invalid/foreign and uncertain-only refusals retain ordinary behavior, while authorized retries remain usable.

## Slices and actual reference

- First working Sales list → New → three lines/edit/remove → Save → leave/reopen checkpoint shown at desktop and 390 px; continued to completion.
- Disposable PaneFlow 4301 at `d057daffd17a199309675a6b0a31c8bdbca05282`: actual Sales/Purchase lists, create, Add/remove, saved-draft editing and leave/reopen observed with synthetic SO-000002/PO-000001. Single organization selector visibly disabled.
- Reference JPEGs show actual disposable UI. Live 3000/original checkout, existing SO-000001 and retained Rain processes/data/locks untouched. Reference tax/payment/progression logic not imported.

## Gates

Gap fixes, executable `8bfe8fc092b50c20c7b6e9101f8cd8aa8d880a95` (records `8bdbba09729a4e45b72e6a7bedae80199117b4d1`, tree equal to HEAD at start and end of every run):

- Format, lint, typecheck, build, schema, app/demo release freshness, boundaries (207 files), records, unit 168/168, compiler 175/175, integration 225/225 (header problem markup, Task first-invalid focus, duplicate warning offered/not offered/failed read/no match), surface contracts 30/30, agent 3/3, architecture 195/195.
- PostgreSQL 249/249 and language coverage PASS (2,413 obligations, 645 observations) on mains power: the 300s-bounded pair at 242.9s and 201.1s. Two earlier runs of the same tree are not counted as green: one on mains had a Docker published-port refusal in `saved-filter.test.ts` (passed in every other run), one on battery cancelled the bounded pair.
- Browser 105/105 at `8bdbba09`: the supported wrapper 65 (order-entry journeys with the duplicate step, meta-sales JS on/off with focus on the corrected input), then composed-application 23/23 (focus-ring gate: 12 derived selectors including `textarea:focus-visible`, 198/198 rings painted, worst 4.03:1) and `message-catalog.spec.ts` 17/17 in separate runs. The wrapper's message-catalog `beforeAll` exceeds its 120s hook bound under four workers at the audited base too (paired, same host: base `35e3eaa1` fixture ready at 122.9s, head 124.0s); the bound is not raised.

Workspace interaction completion, executable `174b4d355d9a2def4582b9a44e3fd421189475c3` (records `a324eb9c66103523aa0bda9a677f7d07aaac17d0`, tree equal to HEAD at start and end of every run):

- Format, lint, typecheck, build, schema, app/demo release freshness, boundaries (207 files), records, unit 168/168, compiler 175/175, integration 224/224 (Milestone A/B/C subtests in `surface-data-binding.test.ts`), surface contracts 30/30, agent 3/3, architecture 195/195.
- Browser 105/105 at `a324eb9c`: the supported wrapper passed 65 (order-entry picker and lifecycle journeys, meta-sales JS on/off, receiving) until the message-catalog `beforeAll` exceeded its 120s hook bound; the composed-application project then passed 23/23 and `message-catalog.spec.ts` 17/17 in separate runs of the same tree. The catalog fixture's spawn-to-ready time is unchanged by the increment (paired, alternating, same host: base `35e3eaa1` 89.4s/95.6s, head 91.5s/93.1s).
- PostgreSQL 247/249: every file passes except the two 300s-bounded composed deployment tests ("advances an existing deployment to an exact compiled successor", "ADR-0047 §6 refuses a profile-only rollback edge…"), cancelled at the bound. In-matrix: 270s/226s at `fe849a6a` (18 lineage entries), timeout/294s at `07c35caa` (18), timeout/timeout at `a324eb9c` (15) with the laptop on battery (Win32_Battery status 1, 42%; host CPU 62%; format 16s -> 26s between the last two runs). Paired attribution of the first test on the same host, alternating, with a measurement-only timeout in scratch copies (the committed bound is unchanged): base `35e3eaa1` 383s/391s, head 401s/397s -- the increment adds about 3% (its one lineage entry) and both pass every assertion. Language coverage reports the PostgreSQL reachability evidence unsuccessful for that reason alone. A green bounded run needs a host at its normal speed; if it reds there, the test's own note prescribes splitting again, never raising the bound.
- The first full run at `07c35caa` found, and `174b4d35` fixes: four lineage entries appended by development compiles (now one); two expectations still naming runtime support 8; three composed browser journeys encoding pre-charter behaviour (an unscoped movement list refused, a customer without a role, a destination walk displacing the compact navigation budget). The run at `fe849a6a` found the composed-inventory guard, the eligibility predicate read, the Task field-error placement and the page-one picker assertion, fixed in `4f13c155`.
- No CI polling, hosted result, inherited audit, dependency installation or mutation population.

FORM-PAGING correction, executable `2d62597523b1e2b39746669c45b59166857a1307`:

- Pre-fix reproduction at `4b081e08` (controlled executor with the stub's opt-in shared-list paging, 201 matches): after Search and nine More, 200 shown with no More, no message and no exhaustion text; a direct More at the cap returned 200 with the same silent state.
- Affected set against frozen `2d62597523b1e2b39746669c45b59166857a1307` (tree equal to HEAD at start and end): format, lint, typecheck, build, app-release freshness, boundaries (205 files), unit 167/167, integration 207/207 (including FORM-PAGING's three subtests with the FORM-1 and FORM-3 regressions and the F1/F2/F3 witnesses), surface contracts 30/30 (the message is control text, as the existing "No … matches" state is, so no catalog entry was added), architecture 195/195, and the complete supported browser wrapper 105/105.
- Browser/PostgreSQL inspection with 201 masters (`--lookup-volume=201`), JavaScript on and off: 200 shown after nine More presses, the message directly under the search box, no More button, focus on the search box (`aria-describedby` the message); keyboard refinement to "Paging match 201" (Enter with JavaScript; Tab to Search without it), keyboard selection, order number and notes kept. The first inspection at `6fddb886` showed the message only at the end of the 200-item scrolling list; `2d625975` moves it under the search row.
- Compiler, agent and language coverage were not repeated: no canonical, schema or agent path changed. No hosted result, CI polling or mutation population.


FORM-1..4 correction, executable `4b081e08891b4d97264c4d3dda2053ac1323aa27`:

- Full affected set against frozen `78ef50328064c51822aad9c41ec107c3f8cc5b15` (tree equal to HEAD at start and end): format, lint, typecheck, build, schema, both release-freshness checks, boundaries (205 files), unit 167/167, compiler 175/175, integration 203/203, surface contracts 30/30, agent 3/3, architecture 195/195, language coverage (unchanged 2,399 obligations). Browser: the picker journey's product step became ambiguous once the new FORM-1 step added a second line (test code only); scoped to line 1 in `4b081e08`, the complete supported browser wrapper then passed 105/105 at `4b081e08891b4d97264c4d3dda2053ac1323aa27` with the tree clean at start and end.
- Discriminating regressions: controlled executor `FORM-1` and `FORM-3` (Sales and non-Sales two-step subtests) in `surface-data-binding.test.ts`; normalization `FORM-4` in `workspace-contract.test.ts`; browser/PostgreSQL FORM-1 (withdrawn read) and FORM-2 (Enter, JavaScript on and off) in the order-entry picker journey. PostgreSQL masters measured by the journey: Blank Glazing 0 after blocked Enter and Cancel; Enter Glazing 1 with a customer role; NoScript Glazing 0 after Cancel, then 1 with a customer role; Thermal Roll exactly 1 item after Enter in Base unit.
- Real-browser inspection on the corrected fixture: the same reproduction that submitted `draftCreate=cancel` now submits `draftCreate=submit` and selects the new customer with JavaScript on and off; Enter with the number missing leaves the dialog open with focus on it; footer order is Create and use, then Cancel.
- Editor F1/F2/F3 and Task P1/P2 witnesses stayed green inside the integration run; their historical audit was not re-run. No hosted result is claimed: hosted jobs currently fail before runner execution. No CI polling, full mutation population or gate weakening.


Form-usability correction (2026-09-25), executable `736b512940d2e5a1cefc3c8366ae70cee87ffc4c`:

- Full affected set against frozen `f2e818a3091513bc489681b577bf5edaf3618281` (tree equal to HEAD at start and end): format, lint, typecheck, build, schema, both release-freshness checks, boundaries (205 files), unit 166/166, compiler 175/175, integration 199/199, surface contracts 30/30, agent 3/3, architecture 195/195 including the new seam red control, language coverage (2,351 → 2,399 obligations, 601 → 631 observations, unhonored set unchanged). Browser 103/105 through the supported wrapper: the two failures were the receiving and SALE-FULFILLMENT journeys still choosing a counterparty from the retired full select. Their only change moves them onto the picker (test files only); both then pass at `736b512940d2e5a1cefc3c8366ae70cee87ffc4c`.
- The first full run, at `95fb6707`, found three real defects that the fix commit corrects: the client script was emitted on record pages that declare an editor without rendering one (meta-sales asserts script-free record pages); the new controls module was not registered in the SurfaceRuntime seam; the coverage decisions were stale for the new declarations.
- Order-entry browser 2/2 against PostgreSQL with the distributor master set: the lifecycle journey on pickers (drafts, reserve 8, ship 5, release remainder, packing 5 EA, receive 2 EA at 2.45 CAD, redaction after revocation); and the picker journey — 20 results plus More on the first page, server search finds a customer off that page, keyboard Enter searches and never saves, Escape cancel writes nothing, denied create writes nothing while selection still works, partial create stores one party and no role, then Retry completes it with one party and one customer role, duplicate create replay 409 with no second master, stale create return 422 with nothing written, read-back withheld is created but not selected, product created from line 1 returns to line 1 with its unit, Purchase "+ New vendor" stores a supplier role, and the no-JavaScript search/select/create-and-return stores one party with a customer role.
- A manual real-browser walk-through on the demo fixture also covered save with nothing selected (no write, problems named beside Customer and Line 1 product), a tampered currency refused, a 22-digit decimal refused before any write and kept exactly, four lines with a different line removed, save/leave/reopen, then an edit of quantity, price and notes plus a governed removal of a saved line, and an unchanged re-save that planned nothing.
- No CI polling, full local matrix, expected-red run, inherited audit or dependency installation. Fresh CI and the bounded ONLINE review are required and not claimed.

Earlier gates:

- Pass: typecheck, build, affected ESLint/Prettier, both artifact freshness checks, boundaries (204 files), language inventory (2,351 decision-covered obligations, zero execution receipts).
- Pass: affected canonical/compiler scope/adoption/normalization/determinism 27/27; workspace/catalog contracts 34/34; order-entry plus retained P1/P2 integration witnesses 12/12.
- Pass: composed Sales policy/lifecycle browser 1/1: denied update, stale draft, foreign scope, released-line refusal, unchanged stock; initial caller mismatches corrected with exact assertions.
- Pass: browser 3/3 (shared Sales/Purchase authoring with reopened editing and released guards, retained fulfillment JS on/off): exact two owned lines, unchanged draft movements/balances, 10/8/2 → 5/3/2 → 5/0/5, packing 5 EA, receiving 2 EA at entered 2.45 CAD.
- Final committed-source browser 1/1 at `20e5c1d4f389b1bcb887c6e71cf51d9e056cb731`: same complete journey, two-tab scope pin, Sales-read revocation after completion, HTTP 200 receipt with order data redacted, second persisted stock measurement unchanged. Initial diagnostic expectation used the wrong success case; corrected to existing Task-complete contract, no kernel change.
- CI attempt `35049655167` exposed one lint finding, three catalog codes without path drivers, stale Inventory composition equality, stale capability-7 expectations and a performance run indeterminate at 34.4% CPU idle. The correction removes the unused argument, drives all three messages through real requests, admits only the exact typed workspace addition while preserving every protected Inventory binding, and pins capability 8. Performance code, budget and timeouts are unchanged.
- Correction gates: complete message catalog 17/17 with 18/46 real path drivers; all seven affected PostgreSQL files 95/95, with Inventory posting independently 19/19; retained browser order-entry/meta-sales 3/3, Sales order 1/1, fulfillment 1/1 and receiving 1/1. Full lint, Prettier, both TypeScript checks, authored/release freshness and boundaries (204 files) pass. The final copy correction also passes workspace contracts 4/4 and the two affected architecture files 50/50 through the shared lock.
- CI run `35060214443` passed PostgreSQL, locale, catalog and the order-entry/meta-sales/Sales/fulfillment/receiving journeys, then exposed one ordinary-form script assertion, five obsolete composed-browser expectations and skipped quality-tail checks. The consolidated correction emits the CSP-pinned client enhancement only for a rendered eligible native Task dialog; ordinary native-picker pages are script-free. Browser expectations now prove owner navigation, contextual deep links, explicit company scope/continuity and the actual rail/raised-overlay focus grounds. Workspace-aware conformance preserves required owner/setup reachability while contextual surfaces remain reachable through their owner or deep links; the generic editor remains a typed SurfaceRuntime delegate and its value-import red control fails closed.
- Complete correction evidence: `surface-data-binding.test.ts` 58/58; integration 174/174; browser 104/104 through the unfiltered supported wrapper with every project/dependency; architecture 194/194; agent 3/3; surface contracts 30/30; expected-red 139/139 plus 38 self-controls; format, lint, typecheck, build, demo/app release freshness and language coverage pass. The prior CI PostgreSQL/locale pass was retained. The CPU-idle performance result was not retried and no budget, threshold, timeout or compiler code changed, as directed.
- Remaining F3 reproduced on reviewed candidate `8f88a279fa967bf2908f92919e9502284de5b1b4`: a first submission rendered the normal partial-failure editor after an acknowledged header update and later line failure; only then, header/child policy denial or provider failure made the same current continuation return generic 422 in all four cleared/retained-plan variants.
- Recovery evidence at executable `484a0da85f1aedcd77233ed4ec9ff953412257fc`: focused F1/F2/F3 14/14; complete `surface-data-binding.test.ts` 72/72; integration 188/188; surface contracts 30/30; browser 104/104 through the exact unfiltered wrapper; architecture 194/194; records OK; format, lint, typecheck, build and boundaries (204 files) pass. The new controls prove redacted HTTP 200, no protected values/forms/retry controls, no further invocation, safe repeats, refused invalid/foreign and zero-ack/uncertain-only continuations, and successful authorized retry. These are deterministic controlled-executor observations through real gateways and SurfaceRuntime; no new PostgreSQL execution or hosted qualification is claimed.
- Fresh candidate CI starts through the same stacked draft PR after push. No full local matrix, inherited audit, dependency installation or CI polling; CI/ONLINE verdict required and not claimed green.

## Test it yourself

In the Ubuntu worktree: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`, then open the printed URL. Masters only: 45 parties holding their stated customer or supplier role, ~140 products, no orders.

1. Sales → New. Click Customer: the first 20 customers open at once, More continues, "+ New customer" is the last row. Suppliers (type "Cascade") are not offered.
2. Type "White": the list narrows as you type; Enter or a click picks Whitecourt Forestry in place. Nothing reloads and focus stays on Customer; Escape closes the list and keeps the choice.
3. Enter an order number, date, notes and two lines ("notebook", Enter; Add line; "lamp"). Type a customer that does not exist, "+ New customer": the name carries over; add a number, Create and use. You are back on Customer with it selected, everything else as you left it.
4. On a line, "+ New product" offers the base unit (EA, BOX, CASE, PACK, PAIR, ROLL) and returns to that line with its unit.
5. Save draft: the order shows order date, requested date, currency, notes and unit prices.
6. Purchasing → New (vendors only), save, Release under Record actions, select the line, "Receive with actual cost": the base unit is shown, not typed; the currency is offered from the order's; the cost takes exact decimals. Review, Confirm: the result says what was received.
7. Inventory → transaction, stock count, period lock and movement all open with the company; a transaction shows its lines and posted movements.
8. With JavaScript disabled, Search and the result buttons do the same as ordinary submits.

Release, reservation, shipment and packing are unchanged. Ctrl-C closes only this disposable fixture.

## Filed limits

- Production sign-in integration absent from loopback demo: trusted entry/current policy exist, while `composition-root.ts` explicitly selects `localDemoIdentity: true`. No fake login or production-authentication claim.
- Process loss/expiry loses unsaved buffers/preferences; reopen persisted records before retrying work. Neither durable drafts nor an atomic batch-save capability is added.
- PaneFlow commercial taxes/payment/FX, Purchase approval/supplier-invoice states and promised-date availability are outside existing Rain capabilities and this change.
- Interaction limits (2026-09-26): fragment state (lookup requests, generations, an open create) is process-local like the draft buffer; a value typed into an ordinary field reaches the session only with the page's next ordinary submit, so when another request advances the draft first (another tab, a replayed form), the conflict answer shows the session's values and that value is entered again; composition Task reference inputs (stock and receiving location) remain native selects over the full declared list -- the audit rated them matched, and past 1,000 records the Task refuses openly rather than truncating; picker eligibility supports an owned relation from an unscoped, unfiltered related list only (anything else is refused); unit and currency choices are declared code lists, not a unit master, precision or conversion; the sale-fulfillment journey now creates the customer role before the order (the customer carrier requires it), so it no longer exercises an order that predates its role -- reservation still checks current role facts on the server; the loopback composition's ordinary POST path carries no origin check under `localDemoIdentity` (an existing composition boundary, not the fragment path).
- Business gaps kept out of this increment (assessment backlog): pricing and cost sources, payment terms, addresses, discounts, tax, charges, FX and totals; approvals and placement; multi-line receipts, carriers and tracking; unit conversions and granularity; returns, supply routes, warehouse workflows, valuation, invoicing and payments; documents, imports and integrations.
- PR #5 alone remains unqualified for the selective Task client contract; the corrected PR #5 + PR #6 stack is the intended integration candidate, subject to fresh CI, ONLINE review and owner approval.

## Bounded ONLINE handoff

Same ONLINE reviewer, changed boundaries only, diff `35e3eaa1ba6dd912067c7c0d58ac3128c6b2a71e..d9eca60a1d4ddbac6d69aaf323e53fc423b5721a`: fragment transport and binding (`apps/web/src/{app-server,surface-runtime,document-editor,surface-client}.ts`), authority under fragments (FORM-1), picker eligibility (canonical schema/validator, `packages/runtime/src/list-behavior/*`, `semantic-query-gateway.ts`, the EXISTS in `module-runtime-interpreter.ts`), `previewEligibility` and denied creates, Task input semantics (`control-semantics.ts`, `surface-composition.ts`) and the form-less surplus in `surface-contract.ts`. Production defects separately from everything else. No merge/deployment or CI polling.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RAIN-ORDER-ENTRY",
  "base": "3830f95b6ff05c8e2b80113f812d59359a67f448",
  "head": "d9eca60a1d4ddbac6d69aaf323e53fc423b5721a",
  "changedPaths": [
    ".agents/skills/ux-grammar/SKILL.md",
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts",
    "apps/web/src/control-semantics.ts",
    "apps/web/src/document-editor.ts",
    "apps/web/src/editor-controls.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-client.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "docs/decisions/ADR-0015-legal-entity-business-dimension.md",
    "docs/decisions/ADR-0030-compiled-navigation-grouping.md",
    "docs/decisions/ADR-0036-minimum-client-capability.md",
    "docs/decisions/ADR-0037-workspace-context-bar.md",
    "docs/execution/current-plan.md",
    "docs/execution/lanes.md",
    "docs/execution/ledger.md",
    "docs/execution/packets/RAIN-ORDER-ENTRY.md",
    "docs/greenfield-north-star-erp-platform-plan.md",
    "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/projections.ts",
    "packages/dev-tooling/src/surface-grammar-conformance/index.ts",
    "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/app/seed.ts",
    "packages/domain/src/inventory/workspace.ts",
    "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-operation-gateway.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/architecture/surface-runtime-seam.test.ts",
    "test/compiler/adopted-language-shape.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/assert-composed-inventory.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/inventory-posting.test.ts",
    "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-terminal-state.test.ts",
    "test/postgres/module-runtime.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/party-runtime.test.ts",
    "test/postgres/request-runtime-view.test.ts",
    "test/postgres/stock-serializer.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/document-editor.ts",
      "name": "documentEditor"
    },
    {
      "path": "packages/canonical-model/src/surface-workspace.ts",
      "name": "validateSurfaceWorkspaces"
    },
    {
      "path": "apps/web/src/editor-controls.ts",
      "name": "renderReferenceControl"
    },
    {
      "path": "apps/web/src/surface-client.ts",
      "name": "SURFACE_CLIENT_SCRIPT"
    },
    {
      "path": "apps/web/src/control-semantics.ts",
      "name": "canonicalDecimal"
    },
    {
      "path": "apps/web/src/control-semantics.ts",
      "name": "decimalProblem"
    },
    {
      "path": "apps/web/src/control-semantics.ts",
      "name": "renderChoice"
    },
    {
      "path": "apps/web/src/control-semantics.ts",
      "name": "admitsChoice"
    },
    {
      "path": "apps/web/src/workspace-entry.ts",
      "name": "workspaceEligible"
    },
    {
      "path": "packages/runtime/src/list-behavior/index.ts",
      "name": "SharedListRelatedFilter"
    },
    {
      "path": "packages/runtime/src/semantic-operation-gateway.ts",
      "name": "SemanticOperationGateway"
    },
    {
      "path": "packages/domain/src/inventory/workspace.ts",
      "name": "inventoryDocumentWorkspace"
    },
    {
      "path": "apps/web/src/editor-controls.ts",
      "name": "PossibleDuplicates"
    }
  ]
}
```
