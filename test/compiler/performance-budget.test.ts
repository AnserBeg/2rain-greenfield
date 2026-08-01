import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { STRUCTURAL_LIMITS_V0 } from '../../packages/canonical-model/src/index.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { authoredFixture, compilerInput, normalizedBytes } from './helpers.js';

const FULL_COMPILE_BUDGET_MILLISECONDS = 5_000;
const MINIMUM_CPU_IDLE_FRACTION = 0.9;
const CPU_AVAILABILITY_SAMPLE_MILLISECONDS = 300;

interface CompileBudgetOptions {
  readonly minimumCpuIdleFraction: number;
  readonly readCpuUsage: (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  readonly readCpuIdleFraction: () => Promise<number>;
  readonly readWallMilliseconds: () => number;
}

type CompileBudgetMeasurement<Value> =
  | {
      readonly beforeCpuIdleFraction: number;
      readonly cpuMilliseconds: number;
      readonly status: 'measured';
      readonly value: Value;
      readonly wallMilliseconds: number;
    }
  | {
      readonly minimumCpuIdleFraction: number;
      readonly observedCpuIdleFraction: number;
      readonly status: 'indeterminate';
    };

const defaultOptions: CompileBudgetOptions = {
  minimumCpuIdleFraction: MINIMUM_CPU_IDLE_FRACTION,
  readCpuUsage: (previousValue) => process.cpuUsage(previousValue),
  readCpuIdleFraction: observeCurrentCpuIdleFraction,
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

test('cold full compile stays within the numeric v0 maximum-field budget', async () => {
  const measurement = await measureCompileBudget(
    () => compileApplication(maximumFieldInput),
    defaultOptions,
  );
  const result = requireMeasuredWithinBudget(measurement);

  assert.equal(result.value.status, 'compiled');
  process.stdout.write(
    `compile-budget: cpu_ms=${result.cpuMilliseconds.toFixed(1)} wall_ms=${result.wallMilliseconds.toFixed(1)} cpu_idle_pct=${(result.beforeCpuIdleFraction * 100).toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
  );
});

test('current CPU saturation makes the compile budget indeterminate, never green', async () => {
  let operationRan = false;
  const saturated = MINIMUM_CPU_IDLE_FRACTION - 0.01;
  const measurement = await measureCompileBudget(
    () => {
      operationRan = true;
      return 'unreachable';
    },
    {
      ...defaultOptions,
      readCpuIdleFraction: async () => saturated,
    },
  );

  assert.equal(operationRan, false);
  assert.deepEqual(measurement, {
    minimumCpuIdleFraction: MINIMUM_CPU_IDLE_FRACTION,
    observedCpuIdleFraction: saturated,
    status: 'indeterminate',
  });
  assert.throws(
    () => requireMeasuredWithinBudget(measurement),
    /COMPILE_BUDGET_INDETERMINATE/u,
  );
});

test('an over-budget controlled wall sample fails the compile budget', async () => {
  const wallSamples = [0, FULL_COMPILE_BUDGET_MILLISECONDS + 0.1];
  const measurement = await measureCompileBudget(
    () => compileApplication(maximumFieldInput),
    {
      ...defaultOptions,
      readCpuIdleFraction: async () => 1,
      readWallMilliseconds: () => wallSamples.shift()!,
    },
  );

  assert.equal(measurement.status, 'measured');
  assert.equal(measurement.value.status, 'compiled');
  assert.equal(
    measurement.wallMilliseconds,
    FULL_COMPILE_BUDGET_MILLISECONDS + 0.1,
  );
  process.stdout.write(
    `compile-budget-negative: controlled_wall_ms=${measurement.wallMilliseconds.toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
  );
  assert.throws(
    () => requireMeasuredWithinBudget(measurement),
    /COMPILE_BUDGET_EXCEEDED/u,
  );
});

async function measureCompileBudget<Value>(
  operation: () => Value,
  options: CompileBudgetOptions,
): Promise<CompileBudgetMeasurement<Value>> {
  const beforeCpuIdleFraction = await options.readCpuIdleFraction();
  if (beforeCpuIdleFraction < options.minimumCpuIdleFraction) {
    return {
      minimumCpuIdleFraction: options.minimumCpuIdleFraction,
      observedCpuIdleFraction: beforeCpuIdleFraction,
      status: 'indeterminate',
    };
  }

  const startedCpu = options.readCpuUsage();
  const startedWall = options.readWallMilliseconds();
  const value = operation();
  const wallMilliseconds = options.readWallMilliseconds() - startedWall;
  const elapsedCpu = options.readCpuUsage(startedCpu);

  return {
    beforeCpuIdleFraction,
    cpuMilliseconds: (elapsedCpu.system + elapsedCpu.user) / 1_000,
    status: 'measured',
    value,
    wallMilliseconds,
  };
}

function requireMeasuredWithinBudget<Value>(
  measurement: CompileBudgetMeasurement<Value>,
): Extract<CompileBudgetMeasurement<Value>, { readonly status: 'measured' }> {
  if (measurement.status === 'indeterminate') {
    assert.fail(
      `COMPILE_BUDGET_INDETERMINATE: observed CPU idle ${(measurement.observedCpuIdleFraction * 100).toFixed(1)}% is below required ${(measurement.minimumCpuIdleFraction * 100).toFixed(1)}%; rerun the exclusive gate`,
    );
  }
  assert.ok(
    measurement.wallMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS,
    `COMPILE_BUDGET_EXCEEDED: cold full compile took ${measurement.wallMilliseconds.toFixed(1)}ms; budget is ${FULL_COMPILE_BUDGET_MILLISECONDS}ms`,
  );
  return measurement;
}

interface CpuStatSample {
  readonly idleTicks: number;
  readonly totalTicks: number;
}

async function observeCurrentCpuIdleFraction(): Promise<number> {
  const before = readCpuStat();
  await delay(CPU_AVAILABILITY_SAMPLE_MILLISECONDS);
  const after = readCpuStat();
  const idleTicks = after.idleTicks - before.idleTicks;
  const totalTicks = after.totalTicks - before.totalTicks;
  assert.ok(
    totalTicks > 0,
    'CPU_AVAILABILITY_SAMPLE_INVALID: no CPU ticks elapsed',
  );
  assert.ok(
    idleTicks >= 0 && idleTicks <= totalTicks,
    'CPU_AVAILABILITY_SAMPLE_INVALID: idle CPU ticks are outside the elapsed total',
  );
  return idleTicks / totalTicks;
}

function readCpuStat(): CpuStatSample {
  const aggregate = readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '';
  assert.ok(
    aggregate?.startsWith('cpu '),
    'CPU_AVAILABILITY_SAMPLE_INVALID: /proc/stat has no aggregate CPU row',
  );
  const ticks = aggregate
    .trim()
    .split(/\s+/u)
    .slice(1, 9)
    .map((value) => Number(value));
  assert.equal(
    ticks.length,
    8,
    'CPU_AVAILABILITY_SAMPLE_INVALID: aggregate CPU row is incomplete',
  );
  assert.ok(
    ticks.every((value) => Number.isSafeInteger(value) && value >= 0),
    'CPU_AVAILABILITY_SAMPLE_INVALID: aggregate CPU ticks are malformed',
  );
  return {
    idleTicks: ticks[3]!,
    totalTicks: ticks.reduce((total, value) => total + value, 0),
  };
}
