import assert from 'node:assert/strict';
import { availableParallelism, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { STRUCTURAL_LIMITS_V0 } from '../../packages/canonical-model/src/index.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { authoredFixture, compilerInput, normalizedBytes } from './helpers.js';

const FULL_COMPILE_BUDGET_MILLISECONDS = 5_000;
const MAXIMUM_NORMALIZED_SYSTEM_LOAD = 0.5;
const maximumSystemLoad =
  availableParallelism() * MAXIMUM_NORMALIZED_SYSTEM_LOAD;

interface CpuBudgetOptions {
  readonly maximumSystemLoad: number;
  readonly readCpuUsage: (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  readonly readSystemLoad: () => number;
  readonly readWallMilliseconds: () => number;
}

type CpuBudgetMeasurement<Value> =
  | {
      readonly beforeSystemLoad: number;
      readonly cpuMilliseconds: number;
      readonly status: 'measured';
      readonly value: Value;
      readonly wallMilliseconds: number;
    }
  | {
      readonly maximumSystemLoad: number;
      readonly observedSystemLoad: number;
      readonly status: 'indeterminate';
    };

const defaultOptions: CpuBudgetOptions = {
  maximumSystemLoad,
  readCpuUsage: (previousValue) => process.cpuUsage(previousValue),
  readSystemLoad: () => loadavg()[0]!,
  readWallMilliseconds: () => performance.now(),
};

const maximumFieldInput = (() => {
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
  return compilerInput(bytes);
})();

test('cold full compile stays within the numeric v0 maximum-field CPU budget', () => {
  const measurement = measureCpuBudget(
    () => compileApplication(maximumFieldInput),
    defaultOptions,
  );
  const result = requireMeasuredWithinBudget(measurement);

  assert.equal(result.value.status, 'compiled');
  process.stdout.write(
    `compile-budget: cpu_ms=${result.cpuMilliseconds.toFixed(1)} wall_ms=${result.wallMilliseconds.toFixed(1)} load=${result.beforeSystemLoad.toFixed(2)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
  );
});

test('system saturation makes the compile budget indeterminate, never green', () => {
  let operationRan = false;
  const overloaded = maximumSystemLoad + 0.01;
  const measurement = measureCpuBudget(
    () => {
      operationRan = true;
      return 'unreachable';
    },
    {
      ...defaultOptions,
      readSystemLoad: () => overloaded,
    },
  );

  assert.equal(operationRan, false);
  assert.deepEqual(measurement, {
    maximumSystemLoad,
    observedSystemLoad: overloaded,
    status: 'indeterminate',
  });
  assert.throws(
    () => requireMeasuredWithinBudget(measurement),
    /COMPILE_BUDGET_INDETERMINATE/u,
  );
});

test('four cold compiles exceed the unchanged single-compile CPU budget', () => {
  const measurement = measureCpuBudget(() => {
    let result: ReturnType<typeof compileApplication> | undefined;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      result = compileApplication(maximumFieldInput);
    }
    return result;
  }, defaultOptions);

  assert.equal(measurement.status, 'measured');
  process.stdout.write(
    `compile-budget-negative: cpu_ms=${measurement.cpuMilliseconds.toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
  );
  assert.throws(
    () => requireMeasuredWithinBudget(measurement),
    /COMPILE_BUDGET_EXCEEDED/u,
  );
});

function measureCpuBudget<Value>(
  operation: () => Value,
  options: CpuBudgetOptions,
): CpuBudgetMeasurement<Value> {
  const beforeSystemLoad = options.readSystemLoad();
  if (beforeSystemLoad > options.maximumSystemLoad) {
    return {
      maximumSystemLoad: options.maximumSystemLoad,
      observedSystemLoad: beforeSystemLoad,
      status: 'indeterminate',
    };
  }

  const startedCpu = options.readCpuUsage();
  const startedWall = options.readWallMilliseconds();
  const value = operation();
  const wallMilliseconds = options.readWallMilliseconds() - startedWall;
  const elapsedCpu = options.readCpuUsage(startedCpu);

  return {
    beforeSystemLoad,
    cpuMilliseconds: (elapsedCpu.system + elapsedCpu.user) / 1_000,
    status: 'measured',
    value,
    wallMilliseconds,
  };
}

function requireMeasuredWithinBudget<Value>(
  measurement: CpuBudgetMeasurement<Value>,
): Extract<CpuBudgetMeasurement<Value>, { readonly status: 'measured' }> {
  if (measurement.status === 'indeterminate') {
    assert.fail(
      `COMPILE_BUDGET_INDETERMINATE: system load ${measurement.observedSystemLoad.toFixed(2)} exceeds ${measurement.maximumSystemLoad.toFixed(2)}; rerun the exclusive gate`,
    );
  }
  assert.ok(
    measurement.cpuMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS,
    `COMPILE_BUDGET_EXCEEDED: cold full compile used ${measurement.cpuMilliseconds.toFixed(1)}ms CPU; budget is ${FULL_COMPILE_BUDGET_MILLISECONDS}ms`,
  );
  return measurement;
}
