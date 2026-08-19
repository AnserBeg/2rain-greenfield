# relation-scoped-enumeration — complete same-scope relation pickers

Date: 2026-08-19
Base: `b5911150453c6e007d70a47f0e76319c91f8ac32` (`origin/main`, fetched and
confirmed unchanged before the fresh worktree was cut)
Branch: `packet/relation-scoped-enumeration-2`
Prior stopped branch: `packet/relation-scoped-enumeration` at `fa83edb`
Tier: Critical
Status: **EVIDENCE READY.** The gated executable candidate is
`edc41ae3c04c48743652b2bf2ee41c54cf5857b8`. The review target is the frozen
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
existing operation-precondition gate still decides whether Edit or update Save
exists; this packet does not loosen the posted-transaction rule.

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
mutation harnesses, 21 ad-hoc deletion observations**. They are evidence about
the writer's model, not a substitute for the fresh-naive review. The tree was
clean at `edc41ae` before and after the sequence.

| Deleted production check or carrier | Control that went red | Observed discriminator |
|---|---|---|
| target scope operand spread | scoped-target integration | named picker absent because the target query refused |
| `enumeration.hasMore` refusal | completeness integration | incomplete prefix rendered instead of refusal |
| exact-one candidate cardinality | ambiguous-list integration | form rendered after choosing the first list |
| update freeze rendering call | update-freeze integration | `data-relation-freeze` absent |
| unavailable-authority guard | absent-authority integration | wrong `COMPONENT_RENDER_FAILED` instead of `QUERY_UNSUPPORTED` |
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
`edc41ae3c04c48743652b2bf2ee41c54cf5857b8`; `git rev-parse HEAD` was identical
before and after.

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format` | pass |
| `pnpm test:browser` | 90 passed, 0 failed |
| `pnpm test:integration` | 147 passed, 0 failed |
| `pnpm test:contracts` | 16 passed, 0 failed |
| `pnpm test:postgres` | 203 passed, 0 failed |

No full matrix has run. Per `git-workflow`, it runs once after both Critical
review arms converge, at the SHA that integrates.

`scripts/check-parked-work.sh` exited 1 and reported seven stale branches:
`proj-disc`, `ps-0`, `ps-1`, `ps-2`, `pur-1`, the preserved stopped
`relation-scoped-enumeration`, and `u5-design`. The handoff predicted six; the
old stopped relation branch crossed the three-day threshold. None was changed.

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

## Pasteable review prompts

The prompts below use `<FROZEN_SHA>` because a commit cannot contain its own
identity. Replace it with the exact remote SHA printed in the writer handoff.

### Arm 1 — fresh Codex xhigh

```text
You are the fresh-naive first reviewer for Critical packet
relation-scoped-enumeration in /home/rvham/2rain-greenfield.

Review exact candidate <FROZEN_SHA> against base
b5911150453c6e007d70a47f0e76319c91f8ac32. The remote branch is
packet/relation-scoped-enumeration-2; verify the supplied git ls-remote line
before reading. Work read-only. Do not edit, commit, run a full matrix, or widen
the charter. Return PASS, REVISE, or BLOCK with file/symbol evidence for every
material finding.

Read first: AGENTS.md; .agents/skills/review-tiers/SKILL.md;
.agents/skills/ux-grammar/SKILL.md; docs/execution/packets/relation-scoped-enumeration.md;
ADR-0052, ADR-0041, ADR-0044, ADR-0036 §2, ADR-0051, ADR-0053, ADR-0054,
and ADR-0055. Re-locate symbols; do not trust line numbers.

GATES ALREADY GREEN at executable parent edc41ae3c04c48743652b2bf2ee41c54cf5857b8:
typecheck, lint, format; browser 90/90; integration 147/147; contracts 16/16;
PostgreSQL 203/203. The distributor manual journey created a transaction,
transaction line, stock count, and stock-count line, selecting both required
scoped relations on the last form. Do not rerun the full matrix or re-derive
settled mechanical counts.

IN SCOPE:
1. Same-scope target enumeration: each scoped target query receives exactly the
   selected legal entity under the target query's declared operand, and an
   absent/multiple operand cannot guess or leak another scope.
2. Completeness/refusal: hasMore refuses, truncatedByMaximum alone does not,
   malformed/unavailable results never become an empty list, targetless optional
   renders nothing, and exactly one active list surface is required.
3. Form semantics: native server-rendered relation selects post the existing
   relation wire; stock_count_line can supply both relations; update renders no
   relation control and visibly discloses the create-only freeze without
   weakening operation preconditions.
4. Attribution: an enumeration refusal names the relation subject, while
   EntityRelationAuthority unavailable is never read as known-empty.
5. Shared catalog authority absorbed from relation-contract-integrity: browser
   and gateway call one whole-catalog parser before filtering, reject extra root
   keys and cross-entity operation-id collisions for the same reason, and the
   repaired wrong-reason controls actually reach the checks they name.
6. ADR-0052 accurately records the implemented ruling, especially the explicit
   §7 amendment and the distinction between Q1-P5 sealed read scope and
   ADR-0055's permission-authorized create operand.

OUT OF SCOPE — record only if material and reachable; do not require a fix here:
dev-seed-has-no-inventory; form-required-field-not-rendered;
provider-refusals-erased-at-the-web-boundary;
runtime-integrity-attribution-untwinned; activity-rail-unowned;
ux-list-usability beyond checking that incomplete enumeration refuses and the
bounded follow-on is honestly recorded; relation-update-fork beyond visible
freeze; compiler source; and posted-transaction affordance redesign.

THREAT MODEL: accidental or plain malformed release artifacts and ordinary
tenant users choosing URL/form values. Check cross-tenant/cross-legal-entity
leakage through the declared gateway boundaries. Active obfuscation, malicious
compiler output crafted to evade source scans, and a new sealed write-capability
design are not this packet.

DECISIVE QUESTIONS:
A. Can any reachable scoped form display or submit a parent outside the selected
   legal entity, or silently choose a scope/list authority?
B. Can any incomplete, malformed, refused, or unavailable target result render a
   valid-looking prefix/empty picker instead of the named refusal?
C. Can stock_count_line_form post both required scoped relations and reach the
   existing relation input unchanged?
D. Can an update form make a relation appear editable or hide the create-only
   freeze, including when update preconditions do not hold?
E. Is any independent browser catalog validator still capable of disagreeing
   with the gateway on the two forged catalogs, or does filtering precede whole-
   catalog admission anywhere?
F. For each new/repaired control, identify the cheapest production deletion or
   one-property survivor. Treat the writer's 21 ad-hoc, author-chosen deletion
   observations as supporting evidence only, not as a fence on your review.
G. Does ADR-0052 claim more than the code and executed evidence establish?

The lane fenced no finding from review. The explicit charter bounds scope; the
green deterministic gates bound rework. Return only in-scope, material,
reachable findings. Classify valid out-of-scope observations separately.
```

### Arm 2 — independent Fable max confirmation after Arm 1 PASS

Use the identical candidate and charter in a fresh Fable max conversation. Add:

```text
This is the independent Critical confirmation arm. Do not read or rely on the
first review's verdict. Re-derive the decisive questions from the candidate and
primary records. PASS only if the identical SHA satisfies the charter; otherwise
return REVISE or BLOCK with the same evidence standard.
```
