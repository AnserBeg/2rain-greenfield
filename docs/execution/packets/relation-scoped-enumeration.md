# relation-scoped-enumeration — complete same-scope relation pickers

Date: 2026-08-19
Base: `b5911150453c6e007d70a47f0e76319c91f8ac32` (`origin/main`, fetched and
confirmed unchanged before the fresh worktree was cut)
Branch: `packet/relation-scoped-enumeration-2`
Prior stopped branch: `packet/relation-scoped-enumeration` at `fa83edb`
Tier: Critical
Status: **EVIDENCE READY.** The gated executable candidate is
`92c447fb9610c7473fa5c6bfbd8909bbb803aea8`. The review target is the frozen
narrative descendant named in the writer handoff and verified on `origin`.
Two fresh, independent Critical PASS arms on that identical target are owed
before the one full matrix and required packet-into-main `--no-ff` merge.

## Packet definition

Goal: make every current required relation fillable from the web, including the
four legal-entity-scoped target lists and both relations on
`stock_count_line_form`, without weakening list completeness, scope, create-only
relation semantics, or posted-transaction affordance rules.

The lease was recorded in `docs/execution/lanes.md` in the branch's first commit,
`f994727`. No compiler or provider path was taken. The old stopped branch was
read as evidence and was not rebased or merged.

While round 1 was under review, `main` advanced by docs-only commit `9d669a0`.
The packet remains based on the current `origin/main` that existed when its fresh
worktree was cut; the required integration step will preserve both histories by
merging the packet into then-current `main` with `--no-ff` after review and the
one full matrix.

## Reconstruction and corrected specimen map

The preserved stop was correct: at its base every required-relation inventory
form declared an unregistered `record:activity` slot and refused before relation
enumeration. `inventory-form-anatomy` replaced that shape with the five
registered slots, `scoped-create-operand-impl` made scoped create operable, and
`form-wire-semantics` made validated strings with explicit empty intent the form
wire. The current release was re-read rather than inheriting the old table.

| relation | target | target list |
|---|---|---|
| `party_role_party` | `party` | unscoped |
| `inventory_transaction_line_transaction` | `inventory_transaction` | scoped |
| `stock_count_transaction` | `inventory_transaction` | scoped |
| `stock_count_line_session` | `stock_count` | scoped |
| `stock_count_line_transaction_line` | `inventory_transaction_line` | scoped |

`stock_count_line_form` therefore remains the decisive specimen: it has two
required relations and both targets are scoped. The existing submission wire
(`RELATION_SUBMISSION_PREFIX`, `relationInput`, and the create branch's
`relations`) was confirmed present and retained.

## Decisions and implementation

### Same-scope semantics

A scoped child may select only a parent returned by the target list under the
same selected legal entity. The runtime carries the current form selection into
the target list query under the **target query's own declared operand id**. It
does not reuse or derive the source form's parameter name.

If the source form requires scope and none is selected, its existing
`QUERY_LEGAL_ENTITY_SCOPE_REQUIRED` refusal runs before picker enumeration. If a
scoped target is reached without exactly one selection, the relation refuses by
its own id. The runtime never guesses a legal entity.

The target list still runs through the semantic query gateway and its Q1-P5
sealed read scope. This is distinct from ADR-0055's create path: the legal entity
posted to create is an untrusted, permission-authorized operand, not a
gateway-issued or sealed capability.

### Enumeration and completeness

- Exactly one active list surface may name a target entity. Zero or two refuse;
  the runtime never selects by order.
- The target query is re-invoked in-request at its declared maximum, labels come
  from `displayFieldId`, and the native options are sorted by label.
- `hasMore` is the completeness boundary. A true value refuses rather than
  presenting a valid-looking prefix.
- `truncatedByMaximum` does not independently refuse. With `hasMore: false`, the
  returned set is complete even when the requested size was clamped.
- A complete empty set is still complete. A required picker renders only its
  unselected “Choose…” option; it does not invent a record or misname the state
  as enumeration failure.
- A targetless optional relation renders no control. A targetless required
  relation refuses by relation id.
- The control is a server-rendered native `<select>` with no script.

The bounded follow-on for oversized target sets is assigned to
`ux-list-usability`: a server-rendered, non-operation search/page submission
preserves validated form strings and selected relations, requests one target
page at the declared maximum, and uses opaque previous/next cursors. It must not
invoke Save or invent list arguments. Until that exists, an incomplete set
refuses.

### Create-only visibility and named refusal

Relations remain absent from update input. An update form now discloses each
known relation under “Set at creation” and renders no relation control. The
existing operation-precondition gate still decides whether the update form and
Save exist; this packet does not loosen the posted-transaction rule or rework
the form page's title grammar.

The command bar and sections are separate shipped slots but now consume one
`resolveFormAdmission` decision. Surface/operation absence, relation refusal,
the current-record predicate, and admission are therefore decided in one order
for both. A relation refusal renders its diagnostic through sections while
suppressing both the form and the independent command-bar Save; a complete
eligible twin renders the form and Save. Relation resolution still precedes the
update predicate so a precondition-false update retains the freeze or named
authority refusal established after round 1.

`RELATION_ENUMERATION_UNAVAILABLE` is a blocking slot diagnostic whose required
subject is the relation id. A known enumeration problem no longer becomes an
unattributed `QUERY_UNSUPPORTED`. A wholly unavailable entity relation authority
still refuses and is never treated as an empty relation list.

### One complete operation-catalog authority

The blocked `relation-contract-integrity` remainder is absorbed here.
`parsePinnedOperationCatalog` now owns the closed catalog root, every operation
definition, and catalog-wide operation-id uniqueness before either consumer
selects an entity. The operation gateway and browser call that one parser. The
browser's former envelope check and post-filter identity set are gone; its
remaining code only maps the admitted typed result into surface bindings.

Two agreement controls compare both consumers against the same artifact:

1. valid catalog versus one extra root key; and
2. valid multi-entity catalog versus a one-property operation-id collision on
   another entity.

Both consumers accept the valid twin and refuse the forgery for the same named
reason. The old `sawCreate` flag was removed; absent authority derives from the
actual `relationInputs === null` state. The repeated-operation specimen now uses
a cross-entity collision that does not trip per-entity create arity first, and
every refusal callback asserts its precise diagnostic.

ADR-0052 §7 is amended explicitly: the former claim that the caller could not
supply a scoped target operand was false.

## Controls and deletion observations

The controls are committed and CI-reachable. The deletion executions below were
temporary author-chosen mutations, restored after each run: **0 committed
mutation harnesses, 26 ad-hoc deletion observations**. They are evidence about
the writer's model, not a substitute for the fresh-naive review. Every
production/test mutation was restored before the gates at `92c447f`; only the
documentation recording that evidence remained uncommitted.

| Deleted production check or carrier | Control that went red | Observed discriminator |
|---|---|---|
| target scope operand spread | scoped-target integration | named picker absent because the target query refused |
| `enumeration.hasMore` refusal | completeness integration | incomplete prefix rendered instead of refusal |
| exact-one candidate cardinality | ambiguous-list integration | form rendered after choosing the first list |
| update freeze rendering call | update-freeze integration | `data-relation-freeze` absent |
| precondition-false freeze carrier | precondition-false update integration | `data-relation-freeze` absent while the form remained suppressed |
| early unavailable-authority refusal return | unavailable-authority plus precondition-false integration | exact `QUERY_UNSUPPORTED` diagnostic disappeared into an empty sections slot |
| update availability return disabled | precondition-false update integration | update form and Save rendered despite the refusing predicate |
| update availability return broadened to every record | eligible-update admission twin | an eligible update lost its form and Save action |
| unavailable-authority guard | absent-authority integration | wrong `COMPONENT_RENDER_FAILED` instead of `QUERY_UNSUPPORTED` |
| command-bar admitted-status guard | five-slot incomplete-enumeration integration | blocking relation diagnostic and absent form/select remained, but the detached command-bar Save appeared |
| catalog root `assertExactKeys` | whole-catalog agreement | both consumers accepted the extra root key |
| catalog-wide duplicate operation-id check | whole-catalog agreement | both consumers accepted the cross-entity collision |
| entity create-contract agreement throw | relation-authority agreement | disagreeing contracts bound instead of refusing |
| relation-input create-only guard | browser/gateway parity | refusal changed to the later target-version reason |
| `relations` closed-key/effect biconditional | browser/gateway parity | missing expected rejection |
| duplicate relation-id guard | browser/gateway parity | missing expected rejection |
| targetless-optional `continue` | targetless relation integration | optional targetless form refused by name |
| `fields` array-shape guard | malformed-outside-slice integration | wrong `value.fields is not iterable` reason |
| operation-contract closed-root guard | missing-key subcase | wrong invalid-shape reason instead of closed-root reason |
| same closed-root guard, isolated extra-key subcase | unknown-key subcase | extra key was accepted |
| sole non-string closed-key guard | malformed-outside-slice integration | non-string key was accepted |
| duplicate field-id guard | malformed-outside-slice integration | repeated identity was accepted |
| relation diagnostic subject | typecheck | required `subject` property missing |
| native picker rendering map | native-picker integration | required relation `<select>` absent |
| create submission's `relations` carrier | submission integration | executor input carried `relations: undefined` |
| derived `relationInputs === null` unavailable arm | typecheck | `known` authority could contain `null` |

The initially written complete-empty assertion was itself wrong: it searched the
whole form for any non-empty `<option>` and caught legitimate enum options from
an unrelated field. It was narrowed to the relation select's option body before
the formal gates. This is the same wrong-reason class the packet was chartered
to remove, and it is recorded rather than hidden.

Round 2 exposed a second specimen mistake: all relation-refusal controls used
the fixture's compiler-valid sections-only form, while the shipped Inventory
forms render a separate command bar. The `hasMore` specimen now explicitly
rebuilds that form with the five registered Record slots and asserts both sides:
an incomplete enumeration has its named diagnostic but no form, relation select
or command-bar Save; a complete enumeration has all three. Deleting only the
command-bar admitted-status guard failed that exact final assertion while the
other refusal assertions still held.

## User-observable checkpoint

`pnpm dev` ran the distributor profile at `http://127.0.0.1:4174`. A headless
browser drove the same server-rendered controls a person uses and persisted this
chain under legal entity `DEFAULT`:

1. create Inventory transaction `MANUAL-RELENUM-TXN`;
2. create its transaction line by selecting that transaction;
3. create Stock count `MANUAL-RELENUM-COUNT` by selecting that transaction;
4. create a Stock count line by selecting **both** the stock-count session and
   transaction line; and
5. click **Save** and observe `Create complete` with no diagnostic.

Observed record ids:

```json
{
  "transactionId": "7d6affdf-c688-4648-a717-4af56a1a5c0a",
  "transactionLineId": "bc3e342f-8f12-439e-b81b-505d00c59223",
  "stockCountId": "5e6dc883-c5ff-4f19-aa3c-dbcee57d312e",
  "stockCountLineId": "88d92cdf-6492-4979-b6d0-602ca0953991"
}
```

The returned stock-count-line view displayed both relation names under “Set at
creation.” Two earlier harness attempts timed out before any write because they
mistook the workspace context link's list operand for the form operand; the
successful journey used the form query's declared parameter ids, as production
does.

Shutdown was explicit: `pnpm --filter @north-star/api dev:stop` stopped
`dev-composed-app-postgres`, then `fuser -k 4174/tcp` killed the node listener.
Port 4174 was observed closed.

## Gates before review

All formal gates ran at exact SHA
`92c447fb9610c7473fa5c6bfbd8909bbb803aea8`; `git rev-parse HEAD` was identical
before and after.

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format` | pass |
| `pnpm test:browser` | 90 passed, 0 failed |
| `pnpm test:integration` | 148 passed, 0 failed |
| `pnpm test:contracts` | 16 passed, 0 failed |
| `pnpm test:postgres` | 203 passed, 0 failed |

During the round-1 correction, the first PostgreSQL attempt at `7c424fd` reached
202/203: one ephemeral container
reported PostgreSQL ready internally while its newly published localhost port
still returned `ECONNREFUSED`. That test never reached an assertion. No file
changed; the complete rerun passed 203/203, including the exact failed specimen,
on that SHA. The new `92c447f` run passed 203/203 on its first attempt. The prior
failed attempt is retained here rather than smoothed out.

No full matrix has run. Per `git-workflow`, it runs once after both Critical
review arms converge, at the SHA that integrates.

`scripts/check-parked-work.sh` exited 1 and reported seven stale branches:
`proj-disc`, `ps-0`, `ps-1`, `ps-2`, `pur-1`, the preserved stopped
`relation-scoped-enumeration`, and `u5-design`. The handoff predicted six; the
old stopped relation branch crossed the three-day threshold. None was changed.

## Review evidence and rounds 1-2 disposition

Round 1 reviewed exact remote candidate
`9b89d104ac36eb2aa48d849dba3aa6ca3ef8863d` and returned **REVISE** with one
material production finding. `renderSections` checked the update precondition
before resolving relation disclosure, so a directly addressed posted,
relation-bearing form rendered an empty sections slot. Relation controls and
Save were suppressed correctly, but the create-only freeze (or relation-
authority refusal) disappeared too. The reviewer closed decisive questions A-C,
E and the remainder of G; no out-of-scope finding survived.

The correction is executable commit `21304a96c8a9b95dec035114e4e6d84e2693e45d`.
`renderRelationContent` now resolves before the current-record availability
gate. A refusing update returns only the freeze or refusal; it cannot render a
form, relation control, Save action or operation submission. The committed
control changes only the child update operation's `precondition` from absent to
a valid comparison contradicted by the seeded record. Its eligible twin proves
that an update whose predicate holds still renders both the freeze and form.
Commit `7c424fda109cacac5710cb9916f57798bdf193aa` composes the same refusing
precondition with unavailable relation authority and requires the named
`QUERY_UNSUPPORTED` disclosure while the form, relation select and Save remain
absent. Deleting the early refusal return makes that precise diagnostic vanish.

This round is licensed to continue by `review-tiers`: the finding was in
production, and the repair subsumes the prior eligible-only disclosure check by
covering both sides of the availability gate. It is not a new-scope stop. The
`capture-learnings` check produced no `learnings.md` entry: the reviewer applied
the already-recorded one-property-survivor rule rather than establishing a new
reusable doctrine.

Round 2 reviewed exact remote candidate
`854b0dd856fdcccd2596af4f0f6aab6c905088c9` and returned **REVISE** with one
material production finding. It accepted the round-1 ordering correction and
its known/unavailable/predicate controls, then followed the independently
rendered slot path the fixture omitted: `renderSections` could refuse relation
enumeration and emit no form while `renderCommandBar` still offered a dead Save
button. That is not an authorization bypass, but it violates ADR-0052 §5 by
offering a write control for a form the relation authority refuses. The
reviewer closed the other decisive questions and reported no out-of-scope
observation.

The correction is executable commit
`92c447fb9610c7473fa5c6bfbd8909bbb803aea8`. `resolveFormAdmission` is the one
decision used by both the sections and command-bar slots. It preserves the
round-1 ordering—relation refusal before the update predicate—and admits Save
only with the same decision that admits the form. The `hasMore` specimen now
uses the shipped five-slot Record anatomy. Its incomplete branch requires the
named diagnostic with no form, relation select or Save; its complete twin keeps
all three. Deleting the command-bar admitted-status guard alone makes only the
Save-absence assertion red.

This next arm is round 3, so the continuing criterion is explicit:
`review-tiers` says a production defect always continues. The correction is
subsuming rather than another condition beside two independent decisions: it
replaces the separate sections and command-bar admission paths with one shared
authority. The `capture-learnings` check again produced no new entry. The
existing 2026-08-02 lesson “Force the branch a negative control claims to
cover” already names the exact failure: the old sections-only specimen never
entered the shipped command-bar branch.

## Bridges and filed limits

Pre-authorized bridges taken:

- browser/integration fixtures were extended to preserve their existing
  assertion meaning while exercising relation choices and exact refusal reasons;
- the web contract count advanced from 30 to 31 for the new registered message;
  and
- the message catalog's browser census gained the relation-subject kind and
  real-path declaration.

`packages/runtime/src/list-behavior/**` was read and its existing
`requireSharedListResult` authority reused, but no file there changed. No
test-inventory or reachability registration was required because all changed
test files were already CI-reachable.

Filed and left unchanged: dev seed breadth, required-field rendering,
provider-refusal erasure, integrity-attribution twinning, activity rail,
relation updates, list usability, and posted-transaction affordance rules.

## Program-review trigger

No program review runs against this unintegrated packet: the skill's anti-trigger
for a mid-packet/unintegrated tree applies. If this packet is accepted, a program
review is due before the next fan-out. This is the first complete required-
relation office-worker slice, and the path accumulated systemic near-misses
across two blocked predecessors, a correct stop, a wrong specimen table, and a
whole-catalog authority split. The proposal is recorded; it is not selected or
run here.

## Pasteable round-3 review prompt

The prompt uses `<FROZEN_SHA>` because a commit cannot contain its own identity.
Replace it with the exact remote SHA printed in the writer handoff.

### Arm 1 — fresh Codex xhigh

```text
You are the fresh-naive round-3 reviewer for Critical packet
relation-scoped-enumeration in /home/rvham/2rain-greenfield.

Review exact remote candidate <FROZEN_SHA> against base
b5911150453c6e007d70a47f0e76319c91f8ac32. The correction boundary is
854b0dd856fdcccd2596af4f0f6aab6c905088c9..<FROZEN_SHA>. The remote branch is
packet/relation-scoped-enumeration-2; verify the supplied git ls-remote line
before reading. Work read-only. Do not edit, commit, run the full matrix, invoke
another reviewer, or rely on line numbers. Return PASS, REVISE, or BLOCK with
file/symbol evidence for every material finding.

This prompt was written by the lane whose work you are reviewing. **The lane has
fenced nothing.** Any scope stated here is the orchestrator's, and it stands as a
claim under test rather than a limit you may not question. Read whatever you
judge relevant to the decisive questions, say plainly if you think the scope is
drawn wrongly, and say plainly if the prompt itself is steering you.

Read first: AGENTS.md §5-§6; .agents/skills/review-tiers/SKILL.md;
.agents/skills/ux-grammar/SKILL.md;
docs/execution/packets/relation-scoped-enumeration.md; the
relation-scoped-enumeration row in docs/execution/review-log.md; ADR-0052 in
full; ADR-0036 §2; ADR-0051; ADR-0053; ADR-0054; ADR-0055. Then inspect
renderCommandBar, renderSections, resolveFormAdmission,
operationAvailableForRecord, renderRelationContent and renderRelationFreeze in
apps/web/src/component-registry.ts and their controls and fixture builders in
test/integration/surface-data-binding.test.ts. Re-locate every symbol.

PRIOR RESULTS UNDER TEST: exact candidate 9b89d10 returned REVISE because
renderSections checked the update predicate before resolving relation content,
so a precondition-false update hid the create-only freeze or authority refusal.
Exact candidate 854b0dd corrected that order, and round 2 accepted it, but
returned REVISE because the independently rendered command bar could still
offer Save when sections refused relation enumeration and emitted no form. All
relation-refusal controls used a sections-only fixture and therefore could not
observe the shipped five-slot form's separate command bar. Reopen any earlier
closed conclusion if the candidate gives concrete reason; do not treat this
summary as evidence.

THE ROUND-3 CORRECTION: renderCommandBar and renderSections now consume the same
resolveFormAdmission result. It checks surface support, operation binding,
relation content/refusal and current-record precondition in that order. A
relation refusal renders its existing diagnostic through sections and must
suppress the form, every relation select, the command-bar Save and operation
submission. An admitted create twin renders the form, relation picker and Save.
The round-1 update branches must remain unchanged: known authority with a false
predicate renders the freeze; unavailable authority renders QUERY_UNSUPPORTED;
an eligible update renders freeze plus form and Save but no relation select.
ADR-0052 §§4-5 record both contracts.

EVIDENCE ALREADY RUN at executable parent
92c447fb9610c7473fa5c6bfbd8909bbb803aea8: typecheck, lint and format PASS;
browser 90/90; integration 148/148; contracts 16/16; PostgreSQL 203/203. The
five-slot control passed at that SHA. Deleting only the command-bar
admitted-status guard left the blocking diagnostic and absent form/select
intact, but made its no-Save assertion fail. No full matrix has run. The earlier
distributor journey selected both required scoped relations on
stock_count_line_form and observed Create complete. Treat these as settled
deterministic evidence, not a restriction on source review.

ROUND-3 CONVERGENCE CLAIM UNDER TEST: the continuing criterion is “production
defect always continues.” The correction is claimed to subsume, not enumerate:
one form-admission authority replaces the independent slot decisions that made
the survivor possible. Say plainly if the implementation does not earn that
classification.

DECISIVE QUESTIONS:

A. On an otherwise-eligible five-slot create whose relation enumeration refuses,
   is the precise diagnostic present while the sections form, relation select,
   command-bar Save and operation submission are all absent?
B. Do sections and command-bar Save genuinely consume one form-admission
   authority, or does an independent admission path survive for either slot?
   Check every status of resolveFormAdmission, not only hasMore.
C. Does the one-property complete enumeration twin still render its form,
   relation select and command-bar Save? Did centralising admission suppress a
   valid create or change truncatedByMaximum's admitted meaning?
D. Are both round-1 update outcomes preserved before the predicate return:
   known authority yields the freeze, unavailable authority yields the named
   refusal, and neither exposes form/select/Save when the predicate is false?
   Does the eligible update twin still retain freeze, form and Save with no
   relation picker?
E. Does the five-slot control reach the shipped cross-slot branch for the exact
   stated reason? Identify the cheapest deletion or one-property survivor that
   would leave it green. The writer's 26 temporary author-chosen deletion
   observations are supporting evidence only.
F. Does ADR-0052 claim exactly the shared admission and update-disclosure
   behavior production establishes? Did the correction regress scoped
   enumeration, completeness, two-relation submission, whole-catalog authority
   or posted-transaction predicate handling in a reachable way?

THREAT MODEL: an ordinary authorized tenant user directly addresses a compiled
form with record and legal-entity URL values, including a posted stock count;
an otherwise-valid create receives an incomplete, ambiguous, malformed or
unavailable relation target enumeration; and a plain malformed/unavailable
pinned relation authority. Check fail-closed behavior at the existing gateway
boundaries and across separately rendered form slots. Active obfuscation,
malicious compiler output engineered to evade source scans, and a new sealed
write-capability design are not claimed here.

KNOWN EVIDENCE LIMITS: the five-slot refusal control reproduces the shipped
Record anatomy in a compiled integration fixture rather than driving a browser
journey through a first-party incomplete target list; the precondition-false
controls likewise use that fixture rather than the shipped posted stock_count
form; the distributor journey proved scoped creation, not either refusal
branch; the deletion observations were temporary and author-selected; and the
full matrix is deliberately deferred until Critical review converges.

FILE AND LEAVE if valid rather than making this correction own them:
dev-seed-has-no-inventory; form-required-field-not-rendered;
provider-refusals-erased-at-the-web-boundary;
runtime-integrity-attribution-untwinned; activity-rail-unowned;
ux-list-usability; relation-update-fork beyond the visible create-only freeze;
compiler source; or a redesign of posted-transaction affordance rules.

PASS only if the exact candidate closes the round-2 cross-slot Save survivor,
preserves the round-1 update correction, and introduces no new in-scope material
defect. Classify any valid out-of-scope observation separately.
```

### Arm 2 — independent Fable max, only after Arm 1 PASS

Use the identical `<FROZEN_SHA>` and the complete charter above in a fresh Fable
max conversation. Add:

```text
This is the independent Critical confirmation arm. Do not read or rely on the
first review's verdict. Re-derive the decisive questions from the candidate and
primary records. PASS only if the identical SHA satisfies the charter;
otherwise return REVISE or BLOCK with the same evidence standard.
```
