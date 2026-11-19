# ADR-0073. Workflow isolation, replay and authority

Date 2026-11-18. Fable 5.2 approved the amended WORKFLOW-1 design to build in
slices. The owner ruled on 2026-11-18 that Gate N2 v1 uses same-pin retry or
cancel. The plan records this in §12.5.

## Authority boundaries

The attackers in scope are tenant-authored guest code and a compromised
`north_star_workflow_worker` role. Worker-authored state is untrusted as proof
of human authority, verified code, or the scope of a source event. Receipt scope
comes from the posting event and its linked change document. The workflow
verifier's evidence, frozen at release approval, pins the executable. The
Semantic gateways enforce the automation actor's current grants and the
approver's authority. Release activation owns the pointer and fence.

Until sign-in exists, the platform trusts the application runtime's principal
assertion and the runtime's existing writes of release approvals and activation
verification receipts under the release activation contracts introduced in 0004.
Customize approval uses this same mechanism.
`PostgresCustomizationService.approve` obtains the trusted approver context and
calls the normal release helpers, which use
`PostgresReleaseApprovalService.createApproval`. The release activation service
writes the verification receipt under the same trusted request context.
[Customize approval](../../packages/postgres-provider/src/customization-service.ts#L1219) ·
[Release approval helper](../../packages/postgres-provider/src/composed-application-runtime.ts#L3011) ·
[Principal assertion](../../packages/postgres-provider/src/request-context.ts#L611) ·
[Verification receipt](../../packages/postgres-provider/src/release-activation-service.ts#L427) ·
[0004 approval grant](../../db/migrations/0004_release_activation_contracts.sql#L1112) ·
[0005 verification receipt grant](../../db/migrations/0005_release_activation_kernel.sql#L1025)

- **R1.** A Tier B or unknown-dependency write requires a recorded human decision bound
  to the exact plan and execution fence.
- **R2.** Only workflow code verified at approval may run.
- **R3.** Every workflow effect stays within the automation actor's tenant and
  company grants.
- **R4.** Workflows never block activation or rollback. Release changes can
  proceed while a workflow waits or runs guest code. The platform serializes
  bounded claim and effect transactions against the active fence.

The runtime's ability to fabricate a human decision or to fabricate activation
evidence is filed under sign-in packet item 1. The workflow scheduler defaults
to off. Enable it only in the local demo until sign-in closes item 1.
[Filed findings](../execution/current-plan-archive.md#filed-during-the-freeze)

## Host and SDK

Use exactly `quickjs-emscripten@0.32.0`. Each execution attempt gets a fresh
synchronous WebAssembly instance in a dedicated Node worker thread with fixed
host-owned linear memory, QuickJS heap and stack limits, and a monotonic deadline.
QuickJS's interrupt is cooperative. A watchdog on the supervising thread
terminates the worker at the deadline even if the guest never checks the
interrupt. The supervisor discards an incomplete worker response. Only the
supervisor can authorize and commit effects. Release the worker before waiting.

The guest has a single dispatch entry point for bounded canonical JSON. An
attempt replays its recorded prefix and can yield at most one new host request,
then the supervisor releases the isolate. The supervisor validates requests
against the pinned release's callable catalog, input contract, declared grants,
and current policy. It mediates live business
calls through the Semantic Query and Semantic Operation gateways. The typed SDK
is generated from the pinned `TenantRelease` and exposes those calls plus
`now`, `sleep`, `waitForEvent` and `requestApproval`. Remove module loading,
filesystem and network access, the real clock, randomness and nondeterministic
garbage-collection APIs before guest code runs. Constrained pure compute in
§10.4 rung 9 can reuse this host with zero host grants. Workflows have only
durable process authority. Validations, guards, formulas and operation effects
stay in the existing declarative or capability contracts.

### Computed inputs to Tier B

Require exact human confirmation for every Tier B operation and every operation
whose admitted inputs or reachable write effects intersect a published Tier B
dependency, including through relations, child rows or indirect effects. An
incomplete dependency or write-effect set is confirmation-class. The rule treats
literals, copied query results and computed values alike. Apply any stricter
operation or current policy requirement. Tier B facts can be produced only by
the owning capability's whole Semantic Operation. Before N5, every
confirmation-class call waits for explicit human approval of the exact plan.

## Package content and authoring

Use a typed `saveWorkflow` patch under CUSTOMIZE-4's bounded identifier check.
The patch carries workflow identity, trigger, grants, and a digest reference to
the body bundle. Keep the 64 KiB patch and upgrade payload limits. Store source
and verification fixtures in the new immutable, tenant- and environment-scoped
`platform.workflow_body_blobs` table, keyed by the SHA-256 of the canonical
bundle bytes. Admission checks the digest and bundle size, with a 1 MiB cap for
the source and fixtures together. The body is package-revision content by
digest. The immutable revision binds the digest, and the compiled release
artifact closure includes the executable and SDK binding. Source and fixtures
are retained for replay of the authoring intent, audit and recompilation.
A missing or mismatched blob fails closed at draft replay and candidate admission.

UPGRADE-1 re-applies the original patch and body digest against the new base,
regenerates SDK bindings, and reports missing or incompatible targets before
activation. Release rollback uses existing revision and release identities and
digests. It can reverse activation without parsing the patch it reverses.
Customize shows the read-only source, trigger, grants and a plain-language
summary derived from declared grants and callable targets. `customize ask`
drafts, type-checks, lints and tests a proposed body. The ordinary diff,
approval and activation path governs publication. The assistant worklist uses
the existing five tools and the same pending-plan authority as the Approvals
screen.

## Event consumer and activation watermark

Posting already writes the versioned receipt-posted event in
`platform.trust_domain_events` and the linked `platform.trust_outbox` row in the
posting transaction. The consumer joins those rows and the change document by
their scoped identities and validates event type, version, company and receipt
identity. An authorized query through the pinned SDK resolves the item
condition from the posted movements. The worker enumerates provisioned tenant/environment IDs from
`platform.environments` through a scheduler-only, read-only ID enumeration
function. Work for each pair runs in a separate trusted transaction with
tenant/environment context and forced RLS. Event payloads cannot supply that
context. No posting writer or posting-side hook changes.

Each verified activation gets a watermark keyed by tenant, environment, pointer
ID and fence in `platform.workflow_activation_watermarks`. Capture it with an
insert hook on a `SWAPPED_VERIFIED` receipt in
`platform.release_activation_verification_receipts`, in the same transaction
and under the verification path's pointer lock. This hook is a Critical touch of
the 0005 receipts table. Return without capturing a watermark or seeding
occurrences if neither the incoming nor outgoing release declares workflows.
The capture statement's MVCC snapshot defines the boundary. Seed in one
set-based statement filtered to the union of the incoming and outgoing
subscriptions' event types. Give each matching unresolved outbox ID visible at
capture a pre-activation disposition. Previously consumed IDs already have a
disposition. The activation test must compare latency and persisted bytes for
a no-workflow tenant against the pre-hook path and establish that both stay
unchanged.
The boundary uses committed row membership. UUIDs and posting timestamps
cannot serve as a high-water mark because they can be observed out of order.
A receipt becoming visible after capture is eligible only if its source release
ID and root match the verified active release at consumption. A fence with no
verified watermark, including a fence from before installation, cannot start
runs. Verified activation of a workflow-bearing release establishes its first
watermark.

`platform.workflow_event_occurrences` is the durable consumer cursor. Poll in
bounded batches for visible source IDs without a disposition, with no advancing
timestamp cursor. Index the eligible lookup and measure the polling bound against
an accumulated outbox. Lock the pointer for the claim transaction, require its
current fence and verify the matching watermark, and atomically commit the event
disposition and all matching run starts. Claimed starts become visible to
execution only after that transaction commits. A unique start key binds tenant,
environment, source event and stable workflow identity across releases.
An event committed before a rollback and still pending when the rollback is
verified is recorded as pre-activation. It starts zero runs.
If the start committed first, the existing run retains its original pin and
moves to suspension on the release change. A late commit from a superseded
release is recorded as ineligible by the source release check.

## Run pinning, replay and approval

The instance is the logical occurrence. It binds the tenant, environment,
company scope, source event, stable workflow identity, and trigger attribution.
An execution run binds that instance and its immutable release ID/root, initial
activation fence, body and SDK artifact digests, exact engine build and host/SDK
versions, automation principal, author and activation approver. Retain the
matching artifacts and runtime implementations or suspend with a named
unavailable-version reason. An upgraded binary must never select its defaults
for a pinned run. The automation actor's effective authority is bounded by
declared grants and the activation approver's authority at activation. Recheck
current policy for the automation actor and relevant human authority on every
call.

Each journal cursor has an append-only canonical request and, once complete,
an append-only result. Replay returns recorded results for exactly matching
requests. A different request, a skipped cursor, or a body exit before all
recorded calls are consumed atomically quarantines the run with a diagnostic.
Quarantined runs leave the runnable queue and retain evidence for human
inspection. An outbox row and its effect request commit together. The dispatcher
invokes a whole Semantic Operation with a stable idempotency key derived from
the logical occurrence and effect cursor. It recovers a committed result from
the exact durable receipt across an operation-commit/journal-commit crash.
Compensation uses declared correcting operations.

Before scheduling or resuming live work, compare the run's release and current
execution fence with the verified active pointer. A stale run enters
`SUSPENDED` and stops taking effects, even on timer wake. Recheck at dispatch.
Admit fresh Tier A writes transactionally against the active fence. Capability
calls remain subject to their own writer fences. An
`INVENTORY_POSTING_RELEASE_MISMATCH` caused by a stale pin racing the precheck
suspends the run. Record the suspension as control evidence outside the replay
results. A mismatch
while the ID and root are still active raises a named integrity failure and
requires investigation. Reconcile any in-flight effect to its durable receipt
before remedying the run.

Approvals bind the exact canonical arguments, effect occurrence, release ID and
root, activation fence, operation and company scope. Persist the approving
human's identity. Check the active binding and current authority both when a
person approves and before dispatch. Stale pending approvals and stale approvals
whose effects have not committed become permanently ineligible. Keep their
history visible and report the reason in the worklist and assistant. Returning
to the same digest under a later fence cannot revive a prior approval.

An operator can cancel or retry suspended runs in bulk. Evaluate each run
individually and audit each result. A retry is admitted only when the original
release is verified active again and the run retains its original release, body,
SDK and runtime pins. Reconcile in-flight effects and admit the new execution
fence before resuming. Outstanding confirmation needs a fresh plan and human
decision. Cancellation preserves completed effects and evidence. Successor
retry against a different release is deferred.

The Gate N2 v1 proof starts a run before an upgrade, shows it suspending while
stale, then restores the original release and demonstrates that a person's
same-pin retry finishes the run. While a different release is active, the
operator can cancel the suspended run.

## Timers, signals and external delivery

`now` journals a trusted instant. `sleep` persists the computed UTC deadline
and commits its wake result once. Restart reloads due timers. In-process elapsed
time and budget checks use a monotonic source, and time tests inject their clocks.
`waitForEvent` registers a durable wait for a pinned event contract and exact
authorized correlation in the run's tenant, environment and company. Register
the request and its visible-event baseline in one transaction, using source
IDs to exclude events already visible at registration. Under the wait lock,
choose the first eligible visible match ordered by source recorded time and ID.
Claim and journal its identity and payload atomically at the wait cursor. Poll
the durable source after restart, including when the start subscription has
already consumed that event. Recheck the run's release and authority at wake. A duplicate delivery cannot wake a
wait twice.

Connector calls, when admitted in a later packet, use typed registered
connector contracts through the same journal and transactional outbox.
WORKFLOW-1 exposes zero connector calls. Outbound delivery binds a stable
occurrence key to connector, destination and canonical payload. Provider retry
reuses that key and reconciles a committed receipt before any resend. If a
provider cannot deduplicate or prove the prior attempt did not commit, park the
ambiguous delivery for reconciliation. Inbound provider deliveries are
authenticated and deduplicated on tenant, environment, connector endpoint and
provider message ID before starting or waking a workflow. The N2 communication
proof must observe one external delivery across a crash after provider acceptance
and before local acknowledgement.

## Release admission and verifier scope

Carry workflows as an optional authored addition under ADR-0047 §7. A release
with workflows includes a workflow projection and raises the runtime floor on
the existing required surface manifest that serving readers already check via
`unsupportedRuntimeCapability`. Emit workflow facts only when declared. Refuse
a missing, inconsistent or unsupported workflow projection for a
workflow-bearing candidate. Workflow-bearing releases require surface reader 27, following Today metrics
at 25 and Inspection metadata at 26.

The proposed Critical verifier change is limited to
`PostgresReleaseVerificationService` candidate verification and evidence
read-back. `releaseVerificationBinding` binds each declared workflow to its
verified projection, body, executable, SDK, runtime versions and test fixture
digests under the staged candidate root. The service runs the workflow gates
before accepting or persisting verification evidence. Persist the exact
workflow evidence alongside the existing evidence under the same evidence ID
and transaction. On read-back, require a complete passing workflow evidence set
bound to the same candidate and digests. Missing, stale or mismatched evidence
refuses the candidate. Existing query/operation execution, capability factories,
activation authority and posting remain governed by their existing contracts.

Type-check against the generated SDK and lint before emitting executable code. Refuse
`Date.now`, `Math.random`, other ambient clock, random and I/O APIs, and module
imports outside the SDK. Require at least one verification fixture for each
workflow. For each fixture, execute the compiled body once with deterministic
inputs and mocked host integrations and a second time in a fresh isolate
replaying the first run's journal. Require the same ordered
requests and outcome, full journal consumption, and zero new effects during
replay. An unmocked call or any divergence fails candidate admission. Tests must
observe both refusals. A checked-in before/after control compiles the same
no-workflow input on both sides of the extension and compares canonical package
bytes, release manifest and artifact bytes and roots, and persisted verification
evidence bytes under identical fixture identities. The extension emits no
workflow projection, evidence or added floor for these releases.

## Migration

Follow the migration numbering rule. At merge time, fetch `origin/main` and
assign the single forward migration the next free number after its highest
migration. Regenerate the schema snapshot and migration-list tests and rerun CI.
Fetch again immediately before pushing `main` and repeat if another migration
landed. Coordinate with other lanes so only one migration merge proceeds at a
time. The
migration declares these relations in `platform`:

| Table | Responsibility |
| --- | --- |
| `workflow_body_blobs` | Immutable source and fixture bundles by digest |
| `workflow_definitions` | Immutable, release-scoped workflow bindings and grants |
| `workflow_verification_evidence` | Candidate-bound run-twice evidence, linked to release verification |
| `workflow_activation_watermarks` | Verified activation fence and source boundary |
| `workflow_event_occurrences` | Per-source consumption disposition and start deduplication |
| `workflow_instances`, `workflow_runs` | Logical occurrence, immutable execution pins and durable run state |
| `workflow_journal` | Append-only requests, results and control evidence |
| `workflow_timers`, `workflow_event_waits` | Durable deadline and correlation registrations |
| `workflow_effect_outbox` | Transactional effect dispatch, claims and receipt recovery |
| `workflow_pending_approvals` | Exact pending plans, decisions and stale status |

Use tenant/environment keys and forced RLS as in 0029. Grant only scoped reads,
inserts and the narrow state transitions each role needs. Keep the body,
definition, watermark, occurrence, verification and journal evidence immutable.
The migration adds the verified-activation receipt hook and read-only scheduler
enumeration function. Use a dedicated `north_star_workflow_worker` role. A Codex read is required
before any tenant activates a workflow-bearing release.

## Deploy rule

Never roll back code below the newest patch parser or release reader floor a
tenant has used.

## Bakeoff

The 2026-11-18 probe ran on Node 22.22.2 against Emscripten 0.32.0 and Vercel's QuickJS-WASI 3.6.3, released 2026-10-19. Both passed one narrow JSON dispatch, absence of the filesystem and network entry points and the removed clock and random globals, an 8 MiB allocation refusal at a 4 MiB heap limit, and interruption of a busy loop with a 25 ms budget. Emscripten accepted an imported 16 MiB fixed-size memory and rejected a request to grow it. The WASI binary had no memory import, so its stock API did not supply that independent host ceiling. Emscripten gives us the hard ceiling while keeping the dependency count to one direct pin. npm's audit found zero advisories in the temporary two-candidate install. The repository scans are still due for the actual dependency change. [Emscripten API](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten-core/src/module.ts) · [QuickJS-WASI API](https://github.com/vercel-labs/quickjs-wasi) · [npm release metadata](https://registry.npmjs.org/quickjs-emscripten)

## Reproduce the bakeoff

In a temporary directory, install the two candidate pins and save the JavaScript block as `probe.mjs`. Run `node probe.mjs`. Both candidates should print a passing result.

```bash
npm --cache ./cache install --ignore-scripts --no-audit --no-fund --save-exact quickjs-emscripten@0.32.0 quickjs-wasi@3.6.3
npm --cache ./cache audit --audit-level high --omit dev
```

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { RELEASE_SYNC, newQuickJSWASMModule, newVariant } from 'quickjs-emscripten';
import { QuickJS } from 'quickjs-wasi';

const pageCount = 256;
const budget = 4 * 1024 * 1024;
const start = performance.now();
const memory = new WebAssembly.Memory({ initial: pageCount, maximum: pageCount });
const quick = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
assert.equal(quick.getWasmMemory(), memory);
assert.throws(() => memory.grow(1), RangeError);
const runtime = quick.newRuntime();
runtime.setMemoryLimit(budget);
runtime.setMaxStackSize(256 * 1024);
let deadline = Infinity;
runtime.setInterruptHandler(() => performance.now() >= deadline);
const guest = runtime.newContext();
let calls = 0;
const hostCall = guest.newFunction('dispatch', (input) => {
  assert.equal(guest.typeof(input), 'string');
  assert.equal(guest.getString(input), '{"kind":"now"}');
  ++calls;
  return guest.newNumber(7);
});
guest.setProp(guest.global, 'dispatch', hostCall);
hostCall.dispose();
const emEval = (source) => {
  const result = guest.evalCode(source);
  if (result.error) {
    const error = guest.dump(result.error);
    result.error.dispose();
    throw new Error(error.message);
  }
  const value = guest.dump(result.value);
  result.value.dispose();
  return value;
};
const bootstrap = `delete globalThis.Date; delete Math.random; delete globalThis.WeakRef; delete globalThis.FinalizationRegistry;`;
const absent = `JSON.stringify([typeof fetch, typeof process, typeof require, typeof Date, typeof Math.random, typeof crypto])`;
const absentValues = JSON.stringify(Array(6).fill('undefined'));
emEval(bootstrap);
assert.equal(emEval(absent), absentValues);
assert.equal(emEval(`dispatch('{"kind":"now"}')`), 7);
assert.equal(calls, 1);
assert.throws(() => emEval('new ArrayBuffer(8 * 1024 * 1024)'), /memory/i);
deadline = performance.now() + 25;
assert.throws(() => emEval('while (true) {}'), /interrupt/i);
guest.dispose();
runtime.dispose();
console.log(`Emscripten: hard WASM cap, heap limit, interrupt, ambient isolation and one dispatch passed in ${Math.round(performance.now() - start)} ms`);

const wasiBytes = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const wasiModule = await WebAssembly.compile(wasiBytes);
assert.equal(WebAssembly.Module.imports(wasiModule).some(({ kind }) => kind === 'memory'), false);
const started = performance.now();
deadline = Infinity;
const wasi = await QuickJS.create({ wasm: wasiModule, memoryLimit: budget, interruptHandler: () => performance.now() >= deadline, timezoneOffset: 0 });
const wasiEval = (source) => wasi.evalCode(source).consume((value) => wasi.dump(value));
calls = 0;
const wasiDispatch = wasi.newFunction('dispatch', (input) => {
  assert.equal(input.toString(), '{"kind":"now"}');
  ++calls;
  return wasi.newNumber(7);
});
wasi.setProp(wasi.global, 'dispatch', wasiDispatch);
wasiDispatch.dispose();
wasiEval(bootstrap);
assert.equal(wasiEval(absent), absentValues);
assert.equal(wasiEval(`dispatch('{"kind":"now"}')`), 7);
assert.equal(calls, 1);
assert.throws(() => wasiEval('new ArrayBuffer(8 * 1024 * 1024)'), /memory/i);
deadline = performance.now() + 25;
assert.throws(() => wasiEval('while (true) {}'), /interrupt/i);
wasi.dispose();
console.log(`WASI: heap limit, interrupt, ambient isolation and one dispatch passed in ${Math.round(performance.now() - started)} ms. The module does not import host-capped memory.`);
```
