import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

import type * as QuickJS from 'quickjs-emscripten';

const data = workerData as {
  readonly traceMethods?: readonly string[];
  readonly cpuMs: number;
  readonly engine: string;
  readonly executable: string;
  readonly input: string;
  readonly maximumCallBytes: number;
};

const { newQuickJSWASMModule, newVariant, RELEASE_SYNC }: typeof QuickJS =
  await import(data.engine);
const pageCount = 256;
const memory = new WebAssembly.Memory({
  initial: pageCount,
  maximum: pageCount,
});
const isolate = await newQuickJSWASMModule(
  newVariant(RELEASE_SYNC, { wasmMemory: memory }),
);
if (isolate.getWasmMemory() !== memory)
  throw new Error('Workflow WASM memory ceiling unavailable');
const runtime = isolate.newRuntime();
runtime.setMemoryLimit(4 * 1024 * 1024);
runtime.setMaxStackSize(256 * 1024);
const guest = runtime.newContext();

try {
  const source = `
    (() => {
      'use strict';
      const world = globalThis;
      const createFunction = Function;
      const keep = new Set([
        'globalThis', 'undefined', 'NaN', 'Infinity',
        'Object', 'Boolean', 'Number', 'String', 'Symbol', 'BigInt',
        'Array', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint8ClampedArray',
        'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
        'Float32Array', 'Float64Array', 'BigUint64Array', 'BigInt64Array',
        'Map', 'Set', 'WeakMap', 'WeakSet', 'Reflect', 'Iterator', 'JSON', 'Math',
        'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
        'EvalError', 'URIError', 'AggregateError', 'parseInt', 'parseFloat',
        'isFinite', 'isNaN', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
      ]);
      for (const key of Reflect.ownKeys(world)) {
        if (!keep.has(key) && !Reflect.deleteProperty(world, key)) throw new Error('Guest global could not be removed');
      }
      delete Math.random;
      const functionPrototype = createFunction.prototype;
      delete functionPrototype.constructor;
      delete Object.getPrototypeOf(function* () {}).constructor;
      delete Object.getPrototypeOf(async function () {}).constructor;
      delete Object.getPrototypeOf(async function* () {}).constructor;

      // Capture the functions used by the journal before running tenant code.
      const objectPrototype = Object.freeze(Object.prototype);
      const arrayPrototype = Object.freeze(Array.prototype);
      const freeze = Object.freeze;
      const keys = Reflect.ownKeys;
      const descriptor = Object.getOwnPropertyDescriptor;
      const prototype = Object.getPrototypeOf;
      const array = Array.isArray;
      const isInteger = Number.isSafeInteger;
      const is = Object.is;
      const sort = functionPrototype.call.bind(arrayPrototype.sort);
      const codeUnit = functionPrototype.call.bind(String.prototype.charCodeAt);
      const parse = JSON.parse;
      const stringify = JSON.stringify;
      const { event, prefix } = parse(${JSON.stringify(data.input)});
      const yieldEffect = freeze({});
      const rejectCall = freeze({});
      let cursor = 0;
      let request;
      let invalid = false;
      let dispatching = false;
      let divergence = false;

      function quote(value) {
        for (let i = 0; i < value.length; i++) {
          const unit = codeUnit(value, i);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = codeUnit(value, ++i);
            if (!(low >= 0xdc00 && low <= 0xdfff)) throw rejectCall;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw rejectCall;
          }
        }
        return stringify(value);
      }

      function encode(value, depth = 0) {
        if (depth > 64) throw rejectCall;
        if (value === null || typeof value === 'boolean') return stringify(value);
        if (typeof value === 'string') return quote(value);
        if (typeof value === 'number' && isInteger(value) && !is(value, -0)) return stringify(value);
        if (typeof value !== 'object') throw rejectCall;
        const own = keys(value);
        if (array(value)) {
          if (own.length !== value.length + 1) throw rejectCall;
          let result = '[';
          for (let index = 0; index < value.length; index++) {
            const property = descriptor(value, index);
            if (!property || !('value' in property)) throw rejectCall;
            result += (index ? ',' : '') + encode(property.value, depth + 1);
          }
          return result + ']';
        }
        const parent = prototype(value);
        if (parent !== objectPrototype && parent !== null) throw rejectCall;
        for (let index = 0; index < own.length; index++) {
          if (typeof own[index] !== 'string') throw rejectCall;
        }
        sort(own);
        let result = '{';
        for (let index = 0; index < own.length; index++) {
          const key = own[index];
          const property = descriptor(value, key);
          if (!property.enumerable || !('value' in property)) throw rejectCall;
          result += (index ? ',' : '') + quote(key) + ':' + encode(property.value, depth + 1);
        }
        return result + '}';
      }

      function dispatch(call) {
        if (dispatching || request !== undefined || invalid || divergence) {
          invalid = true;
          throw rejectCall;
        }
        dispatching = true;
        try {
          const encoded = encode(call);
          if (encoded.length > ${data.maximumCallBytes}) throw rejectCall;
          if (cursor === prefix.length) {
            request = encoded;
            throw yieldEffect;
          }
          const entry = prefix[cursor];
          if (entry.request !== encoded) {
            divergence = true;
            throw rejectCall;
          }
          cursor++;
          return parse(entry.result);
        } catch (error) {
          if (error !== yieldEffect && !divergence) invalid = true;
          throw error;
        } finally {
          dispatching = false;
        }
      }

      const sdk = {
        now: () => dispatch({ kind: 'now' }),
        sleep: (milliseconds) => dispatch({ kind: 'sleep', milliseconds }),
        waitForEvent: (eventType, timeoutMs) => dispatch({ kind: 'waitForEvent', eventType, timeoutMs }),
        requestApproval: (summary, ...args) => dispatch(args.length === 0
          ? { kind: 'requestApproval', summary }
          : { kind: 'requestApproval', summary, operationId: args[0], input: args[1] }),
        query: (id, input) => dispatch({ kind: 'query', id, input }),
        operation: (id, input) => dispatch({ kind: 'operation', id, input }),
      };
      const sites = [];
      const methods = ${JSON.stringify(data.traceMethods ?? [])};
      for (let i = 0; i < methods.length; i++) {
        const method = sdk[methods[i]];
        sdk['site' + i] = (...args) => {
          sites[sites.length] = i;
          return method(...args);
        };
      }
      freeze(sdk);
      let failed = false;
      try {
        const run = createFunction(${JSON.stringify(`'use strict';\n${data.executable}\nreturn run;`)})();
        failed = run(sdk, freeze(event)) !== undefined;
      } catch (error) {
        failed = error !== yieldEffect;
      }
      if (divergence) return '{"kind":"changed-request","cursor":' + cursor + '}';
      if (cursor !== prefix.length) return '{"kind":"unconsumed-prefix","cursor":' + cursor + '}';
      if (invalid) return '{"kind":"invalid-call"}';
      if (failed) return '{"kind":"execution-failed"}';
      if (request !== undefined) return '{"kind":"call","request":' + stringify(request) + '}';
      return ${data.traceMethods ? 'stringify({kind:"done", sites})' : '\'{"kind":"done"}\''};
    })();
  `;
  const deadline = performance.now() + data.cpuMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted = performance.now() >= deadline;
    return interrupted;
  });
  parentPort!.postMessage({ kind: 'ready' });
  const result = guest.evalCode(source, 'workflow.js', { type: 'global' });
  let outcome: string;
  if (result.error) {
    // Reading a guest exception can invoke its conversion hooks.
    result.error.dispose();
    if (!interrupted) throw new Error('Workflow isolate evaluation failed');
    outcome = '{"kind":"cpu-limit"}';
  } else {
    try {
      outcome =
        interrupted || performance.now() >= deadline
          ? '{"kind":"cpu-limit"}'
          : guest.getString(result.value);
    } finally {
      result.value.dispose();
    }
  }
  parentPort!.postMessage({ kind: 'outcome', outcome });
} finally {
  guest.dispose();
  runtime.dispose();
}
