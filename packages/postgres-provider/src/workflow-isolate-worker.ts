import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

import type { QuickJSHandle } from 'quickjs-emscripten';

const data = workerData as {
  readonly engine: string;
  readonly executable: string;
  readonly replay: string;
  readonly cpuMs: number;
  readonly maximumCallBytes: number;
};

const quickjs: typeof import('quickjs-emscripten') = await import(data.engine);
const memory = new WebAssembly.Memory({ initial: 256, maximum: 256 });
const isolate = await quickjs.newQuickJSWASMModule(
  quickjs.newVariant(quickjs.RELEASE_SYNC, { wasmMemory: memory }),
);
if (isolate.getWasmMemory() !== memory) throw new Error('Workflow WASM memory ceiling unavailable');
const runtime = isolate.newRuntime();
runtime.setMemoryLimit(4 * 1024 * 1024);
runtime.setMaxStackSize(256 * 1024);
const deadline = performance.now() + data.cpuMs;
runtime.setInterruptHandler(() => performance.now() >= deadline);
const guest = runtime.newContext();
let nextCall: string | undefined;
let invalidExit = false;
try {
  const dispatch = guest.newFunction('dispatch', (input: QuickJSHandle) => {
    if (nextCall !== undefined || guest.typeof(input) !== 'string') {
      invalidExit = true;
      return guest.undefined;
    }
    const call = guest.getString(input);
    if (Buffer.byteLength(call, 'utf8') > data.maximumCallBytes) invalidExit = true;
    nextCall = call;
    return guest.undefined;
  });
  guest.setProp(guest.global, '__dispatch', dispatch);
  dispatch.dispose();

  const source = `
    (() => {
      'use strict';
      const dispatch = globalThis.__dispatch;
      delete globalThis.__dispatch;
      const createFunction = Function;
      for (const name of ['Date', 'Temporal', 'performance', 'crypto', 'eval', 'WeakRef', 'FinalizationRegistry', 'Atomics', 'SharedArrayBuffer']) {
        delete globalThis[name];
      }
      delete Math.random;
      for (const object of [Object, Object.prototype, Array, Array.prototype, JSON, Math, String, String.prototype]) Object.freeze(object);
      const parse = JSON.parse;
      const stringify = JSON.stringify;
      const freeze = Object.freeze;
      const ownKeys = Object.keys;
      const { event, journal } = parse(${JSON.stringify(data.replay)});
      const suspend = freeze({});
      const diverged = freeze({});
      let cursor = 0;
      let divergence = false;
      const canonical = (value) => {
        if (value === null || typeof value !== 'object') return stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + ownKeys(value).sort().map(key => stringify(key) + ':' + canonical(value[key])).join(',') + '}';
      };
      const call = (input) => {
        const encoded = canonical(input);
        if (cursor === journal.length) {
          dispatch(encoded);
          throw suspend;
        }
        const saved = journal[cursor++];
        if (canonical(saved.call) !== encoded) {
          divergence = true;
          throw diverged;
        }
        return parse(stringify(saved.result));
      };
      const sdk = freeze({
        now: () => call({ kind: 'now' }),
        sleep: (milliseconds) => call({ kind: 'sleep', milliseconds }),
        waitForEvent: (eventType, timeoutMs) => call({ kind: 'waitForEvent', eventType, timeoutMs }),
        requestApproval: (summary) => call({ kind: 'requestApproval', summary }),
        query: (id, input) => call({ kind: 'query', id, input }),
        operation: (id, input) => call({ kind: 'operation', id, input }),
      });
      const body = createFunction(${JSON.stringify(`'use strict';\n${data.executable}\nreturn run;`)})();
      try { body(sdk, event); } catch (error) {
        if (error !== suspend) throw error;
      }
      if (divergence || cursor !== journal.length) throw new Error('Workflow journal diverged');
    })();
  `;
  const result = guest.evalCode(source, 'workflow.js', { type: 'global' });
  if (result.error) {
    // Dumping guest exceptions can run user-defined conversion code. Errors
    // cross the isolate boundary as a bounded host diagnostic instead.
    result.error.dispose();
    throw new Error(performance.now() >= deadline ? 'Workflow CPU limit exceeded' : 'Workflow execution or replay failed');
  }
  result.value.dispose();
  if (invalidExit) throw new Error('Workflow made an invalid or repeated host call');
  parentPort!.postMessage(nextCall === undefined ? { kind: 'done' } : { kind: 'call', call: nextCall });
} finally {
  guest.dispose();
  runtime.dispose();
}
