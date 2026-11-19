# ADR-0073. Workflow isolation, replay and authority

Date 2026-11-18. Proposed in WORKFLOW-1. Release admission is awaiting a scope ruling.

## Decision

Use exactly `quickjs-emscripten@0.32.0`, released 2026-02-16, with a fresh synchronous WebAssembly instance per execution attempt. Supply fixed-size host-owned linear memory, set QuickJS heap and stack limits, and use a monotonic interrupt deadline plus a supervisor watchdog. Release every isolate before waiting. An execution attempt exposes one dispatch function with bounded JSON strings. The host owns parsing, contract checks, current authorization, receipt verification and effect execution. Keep module loading and ambient I/O unavailable. Remove the real clock, randomness and nondeterministic garbage-collection APIs before guest code begins.

Workflow TypeScript, trigger declarations, grants and verification fixtures belong to the immutable package revision. The compiler derives the release SDK and a content-addressed executable artifact from that revision. An authoring patch produces that package content through the ordinary diff, approval and activation path. Replay the patch on a new base and revalidate the SDK bindings, reporting missing or incompatible targets. The approval summary derives from the trigger, grants and callable targets.

An instance binds the tenant, environment, event identity, workflow identity, release ID and root, body digest, automation principal, author and activation approver. The event consumer uses verified release activation and a unique occurrence key, so one committed receipt starts a workflow at most once. Rollback changes which definitions start runs. Existing instances retain their pins and evidence. Any operation that the ordinary gateway refuses under its release and storage rules records that refusal.

The journal cursor identifies the next host call. Record the canonical request and its result under the same cursor on every replay. A different request at a recorded cursor, or an attempt to finish before consuming the recorded journal, is a deterministic failure. Enqueue effects and persist their request in one database transaction. Dispatch a whole Semantic Operation with an idempotency key derived from the instance and cursor. Its durable receipt supports recovery across the operation-commit and journal-commit boundary. Persist absolute timer deadlines and journal the wake result. Resume with a new isolate and the original input and journal. Persist approver identity and the release, operation, scope and exact input digest before any approved effect dispatches.

### Computed inputs to Tier B

Require exact human confirmation for every Tier B operation and every operation whose admitted input or writable destinations can produce a published Tier B dependency, including through relations, child rows or indirect effects. Treat incomplete dependency and effect information as confirmation-class. This rule applies equally to literals, values copied from queries, and computed values. The host also applies any stricter confirmation required by the operation and current policy. Confirmation binds the canonical arguments and the one effect occurrence. The automation principal's effective grant stays within its declared grants and the activation approver's authority captured at activation. The host rechecks current policy for the automation actor and the relevant human authority on dispatch. Before N5 every confirmation-class call suspends for a person. Tier B facts are produced only by the owning capability's registered Semantic Operation.

## Bakeoff

The 2026-11-18 probe ran on Node 22.22.2 against Emscripten 0.32.0 and Vercel's QuickJS-WASI 3.6.3, released 2026-10-19. Both passed one narrow JSON dispatch, absence of the filesystem and network entry points and the removed clock and random globals, a 32 MiB allocation refusal at a 4 MiB heap limit, and interruption of a busy loop with a 25 ms budget. Emscripten accepted an imported 16 MiB fixed-size memory and rejected a request to grow it. The WASI binary had no memory import, so its stock API did not supply that independent host ceiling. Emscripten gives us the hard ceiling while keeping the dependency count to one direct pin. npm's audit found zero advisories in the temporary two-candidate install. The repository scans are still due for the actual dependency change. [Emscripten API](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten-core/src/module.ts) · [QuickJS-WASI API](https://github.com/vercel-labs/quickjs-wasi) · [npm release metadata](https://registry.npmjs.org/quickjs-emscripten)

## Release admission required

The current v6 package shapes have no workflow collection. ADR-0047 §7 permits an optional authored addition that preserves historical bytes. A workflow-bearing release also needs a runtime compatibility floor that current readers actually check. The current loader checks the required projection families, so an independent projection alone leaves older readers able to serve a release and silently omit its automation.

`PostgresReleaseVerificationService` executes a pinned release's query and operation scenarios. Its capability factory hook binds Semantic Operation executors. The workflow admission gate needs successful execution and replay evidence tied to the exact body, SDK and candidate release. The charter places this service and contract version changes on the STOP list. The proposed release path adds the floor and makes this evidence mandatory only for releases declaring workflows. The posting kernel keeps its existing active-release fence.

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
assert.throws(() => emEval('new ArrayBuffer(32 * 1024 * 1024)'), /memory/i);
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
assert.throws(() => wasiEval('new ArrayBuffer(32 * 1024 * 1024)'), /memory/i);
deadline = performance.now() + 25;
assert.throws(() => wasiEval('while (true) {}'), /interrupt/i);
wasi.dispose();
console.log(`WASI: heap limit, interrupt, ambient isolation and one dispatch passed in ${Math.round(performance.now() - started)} ms. The module does not import host-capped memory.`);
```
