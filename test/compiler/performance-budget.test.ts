import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';

import { STRUCTURAL_LIMITS_V0 } from '../../packages/canonical-model/src/index.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { authoredFixture, compilerInput, normalizedBytes } from './helpers.js';

const FULL_COMPILE_BUDGET_MILLISECONDS = 5_000;
const FULL_COMPILE_SAMPLE_COUNT = 5;
const FULL_COMPILE_PROCESS_ARGUMENT = '--full-compile-budget-process';
const isFullCompileProcess = process.argv.includes(
  FULL_COMPILE_PROCESS_ARGUMENT,
);

interface CompileProcessInput {
  normalizedDefinitionBytes: Uint8Array;
}

interface CompileProcessResult {
  elapsedMilliseconds: number;
  status: 'compiled' | 'failed';
}

function measureFirstInvocationInFreshProcess(
  normalizedDefinitionBytes: Uint8Array,
): Promise<CompileProcessResult> {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [FULL_COMPILE_PROCESS_ARGUMENT], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let result: CompileProcessResult | undefined;
    child.once('message', (message: CompileProcessResult) => {
      result = message;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`full-compile process exited with code ${code}`));
      } else if (!result) {
        reject(new Error('full-compile process exited without a result'));
      } else {
        resolve(result);
      }
    });
    child.send({ normalizedDefinitionBytes } satisfies CompileProcessInput);
  });
}

if (isFullCompileProcess) {
  process.once('message', (message: CompileProcessInput) => {
    const input = compilerInput(message.normalizedDefinitionBytes);
    const started = process.hrtime.bigint();
    const result = compileApplication(input);
    const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    process.send?.(
      {
        elapsedMilliseconds,
        status: result.status,
      } satisfies CompileProcessResult,
      () => process.disconnect(),
    );
  });
}

if (!isFullCompileProcess) {
  test('cold full compile stays within the numeric v0 maximum-field budget', async (t) => {
    const authored = authoredFixture('vertical-v1');
    const template = structuredClone(authored.fields[0]!);
    authored.fields = Array.from(
      { length: STRUCTURAL_LIMITS_V0.families.fields },
      (_, index) =>
        index === 0
          ? template
          : {
              ...structuredClone(template),
              fieldId:
                `northstar.bootstrap:field.maximum_${String(index).padStart(4, '0')}` as typeof template.fieldId,
              label: `Field ${index}`,
              orderKey: (index + 1) * 10,
            },
    );

    const bytes = normalizedBytes(authored);
    assert.equal(authored.fields.length, STRUCTURAL_LIMITS_V0.families.fields);
    assert.ok(bytes.byteLength <= STRUCTURAL_LIMITS_V0.maximumNormalizedBytes);

    // Scheduler contention can only lengthen a sample, so the minimum observes
    // available compiler capacity without turning a slow sample into a retry.
    // A fresh process gives every sample new V8 code, inline caches, module state,
    // and heap while timing only its first compileApplication invocation.
    const samples: CompileProcessResult[] = [];
    for (let sample = 0; sample < FULL_COMPILE_SAMPLE_COUNT; sample += 1) {
      samples.push(await measureFirstInvocationInFreshProcess(bytes));
    }

    assert.deepEqual(
      samples.map((sample) => sample.status),
      Array.from({ length: FULL_COMPILE_SAMPLE_COUNT }, () => 'compiled'),
    );
    const elapsedSamplesMilliseconds = samples.map(
      (sample) => sample.elapsedMilliseconds,
    );
    const bestElapsedMilliseconds = Math.min(...elapsedSamplesMilliseconds);
    t.diagnostic(
      `full-compile-budget=${JSON.stringify({
        budgetMilliseconds: FULL_COMPILE_BUDGET_MILLISECONDS,
        estimator: 'minimum',
        sampleMilliseconds: elapsedSamplesMilliseconds.map((elapsed) =>
          Number(elapsed.toFixed(1)),
        ),
      })}`,
    );
    assert.ok(
      bestElapsedMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS,
      `best of ${FULL_COMPILE_SAMPLE_COUNT} cold full compiles took ${bestElapsedMilliseconds.toFixed(1)}ms; budget is ${FULL_COMPILE_BUDGET_MILLISECONDS}ms; samples were ${elapsedSamplesMilliseconds.map((elapsed) => elapsed.toFixed(1)).join(', ')}ms`,
    );
  });
}
