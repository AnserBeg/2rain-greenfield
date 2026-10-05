import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  CanonicalModelError,
  STRUCTURAL_LIMITS_V0,
} from '../../packages/canonical-model/src/index.js';
import {
  resolvePinnedInventoryFactStorage,
  resolvePinnedInventoryPeriodLockStorage,
  resolvePinnedInventoryProviderWrittenReadModel,
} from '../../packages/compiler/src/conformance.js';
import {
  DEFAULT_COMPILER_LIMITS,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import {
  authoredFixture,
  compilerInput,
  mustCompile,
  normalizedBytes,
} from './helpers.js';

const FULL_COMPILE_BUDGET_MILLISECONDS = 5_000;
const FULL_COMPILE_SAMPLE_COUNT = 5;
const FULL_COMPILE_PROCESS_ARGUMENT = '--full-compile-budget-process';
const MINIMUM_CPU_IDLE_FRACTION = 0.9;
const CPU_AVAILABILITY_SAMPLE_MILLISECONDS = 300;
const isFullCompileProcess = process.argv.includes(
  FULL_COMPILE_PROCESS_ARGUMENT,
);

interface CompileBudgetSample {
  readonly cpuMilliseconds: number;
  readonly invocationCount: number;
  readonly pid: number;
  readonly status: 'compiled' | 'failed';
  readonly wallMilliseconds: number;
}

interface CompileBudgetOptions {
  readonly collectSamples: () => Promise<readonly CompileBudgetSample[]>;
  readonly minimumCpuIdleFraction: number;
  readonly readCpuIdleFraction: () => Promise<number>;
  readonly sampleCount: number;
}

type CompileBudgetMeasurement =
  | {
      readonly beforeCpuIdleFraction: number;
      readonly bestSample: CompileBudgetSample;
      readonly samples: readonly CompileBudgetSample[];
      readonly status: 'measured';
    }
  | {
      readonly minimumCpuIdleFraction: number;
      readonly observedCpuIdleFraction: number;
      readonly status: 'indeterminate';
    };

interface CompileProcessInput {
  readonly normalizedDefinitionBytes: Uint8Array;
}

const defaultOptions = {
  minimumCpuIdleFraction: MINIMUM_CPU_IDLE_FRACTION,
  readCpuIdleFraction: observeCurrentCpuIdleFraction,
  sampleCount: FULL_COMPILE_SAMPLE_COUNT,
} as const;

const maximumFieldBytes = (() => {
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
  return bytes;
})();

/**
 * THE PACKAGE-BYTE ENVELOPE (STRUCTURAL-LIMITS-RAISE, ADR-0070 -- PENDING owner
 * ruling). `compiler-slos.md` requires every package-byte bounds raise to rerun
 * this gate at the new ceiling. The field envelope above stays the family
 * stress; this one is the byte stress, shaped like the real application rather
 * than padded with long strings, because a padded package compiles far faster
 * per byte than the queries and surfaces that actually fill Rain.
 *
 * It is the checked-in `app.authored.json` plus renamed copies of itself until
 * the next copy would not fit, then one partial copy that drops whole modules
 * from the end until it fits. A copy renames every id in the package namespace
 * (except the package id), shares definitions declared in other namespaces,
 * and leaves out the entities the compiler pins by identity (fact storage,
 * provider-written read models, the period lock) with everything that names
 * them: those exist once per application, by design. The result must compile
 * and land within `PACKAGE_BYTE_ENVELOPE_MINIMUM_FRACTION` of the maximum.
 */
const APPLICATION_AUTHORED_PATH = 'apps/web/release/app.authored.json';
const PACKAGE_BYTE_ENVELOPE_MINIMUM_FRACTION = 0.85;
const COPIED_FAMILY_PRIMARY_KEYS = Object.freeze({
  assertions: 'assertionId',
  capabilityRequirements: 'capabilityId',
  entities: 'entityId',
  fields: 'fieldId',
  modules: 'moduleId',
  operations: 'operationId',
  permissions: 'permissionId',
  queries: 'queryId',
  relations: 'relationId',
  stateMachines: 'machineId',
  storageMappings: 'storageMappingId',
  surfaces: 'surfaceId',
} as const);
type CopiedFamily = keyof typeof COPIED_FAMILY_PRIMARY_KEYS;
type AuthoredElement = Record<string, unknown>;
type AuthoredApplication = Record<CopiedFamily, AuthoredElement[]> & {
  readonly package: { readonly namespace: string; readonly packageId: string };
};

interface PackageByteEnvelope {
  readonly applicationCopies: number;
  readonly normalizedDefinitionBytes: Uint8Array;
  readonly partialCopyModules: number;
}

function packageByteEnvelope(): PackageByteEnvelope {
  const base = JSON.parse(
    readFileSync(APPLICATION_AUTHORED_PATH, 'utf8'),
  ) as AuthoredApplication;
  const maximum = STRUCTURAL_LIMITS_V0.maximumNormalizedBytes;
  const moduleIds = [...base.modules]
    .sort((left, right) => Number(left.orderKey) - Number(right.orderKey))
    .map((module) => String(module.moduleId));
  let current = base;
  let currentBytes = normalizedBytesWithin(base);
  assert.ok(currentBytes, `${APPLICATION_AUTHORED_PATH} must fit by itself`);
  let applicationCopies = 1;
  let partialCopyModules = 0;
  for (let copy = 2; partialCopyModules === 0; copy += 1) {
    let next: { application: AuthoredApplication; bytes: Uint8Array } | null =
      null;
    let kept = moduleIds.length;
    for (; kept > 0 && !next; kept -= 1) {
      const application = withCopy(
        current,
        applicationCopy(base, copy, moduleIds.slice(kept)),
      );
      const bytes = normalizedBytesWithin(application);
      if (bytes) next = { application, bytes };
    }
    if (!next) break;
    current = next.application;
    currentBytes = next.bytes;
    if (kept + 1 === moduleIds.length) applicationCopies = copy;
    else partialCopyModules = kept + 1;
  }
  assert.ok(
    currentBytes.byteLength <= maximum &&
      currentBytes.byteLength >=
        maximum * PACKAGE_BYTE_ENVELOPE_MINIMUM_FRACTION,
    `package-byte envelope is ${currentBytes.byteLength} bytes; it must land between ${PACKAGE_BYTE_ENVELOPE_MINIMUM_FRACTION} x ${maximum} and ${maximum}`,
  );
  return {
    applicationCopies,
    normalizedDefinitionBytes: currentBytes,
    partialCopyModules,
  };
}

/** Normalized bytes, or null when (and only when) a byte maximum refuses. */
function normalizedBytesWithin(application: unknown): Uint8Array | null {
  try {
    return normalizedBytes(application);
  } catch (error) {
    if (
      error instanceof CanonicalModelError &&
      error.diagnostics.every(
        (entry) =>
          entry.code === 'CANON_LIMIT_PACKAGE_BYTES' ||
          entry.code === 'CANON_LIMIT_NORMALIZED_BYTES',
      )
    ) {
      return null;
    }
    throw error;
  }
}

function withCopy(
  application: AuthoredApplication,
  copy: Record<CopiedFamily, AuthoredElement[]>,
): AuthoredApplication {
  const merged = { ...application };
  for (const family of Object.keys(
    COPIED_FAMILY_PRIMARY_KEYS,
  ) as CopiedFamily[])
    merged[family] = [...application[family], ...copy[family]];
  return merged;
}

function applicationCopy(
  base: AuthoredApplication,
  copy: number,
  droppedModuleIds: readonly string[],
): Record<CopiedFamily, AuthoredElement[]> {
  const { namespace, packageId } = base.package;
  const renamed = (id: string) =>
    id.replace(/([^.:]*)$/u, `c${String(copy)}_$1`);
  const idPattern = new RegExp(
    `"(${namespace.replaceAll('.', '\\.')}:[^"]+)"`,
    'gu',
  );
  const moduleOrderKeyOffset =
    copy *
    (Math.max(...base.modules.map((module) => Number(module.orderKey))) + 1);
  const dropped = new Set<string>(
    droppedModuleIds.map((moduleId) => renamed(moduleId)),
  );
  for (const entity of base.entities) {
    const entityId = String(entity.entityId);
    if (
      resolvePinnedInventoryFactStorage(packageId, entityId) ||
      resolvePinnedInventoryProviderWrittenReadModel(packageId, entityId) ||
      resolvePinnedInventoryPeriodLockStorage(entityId)
    ) {
      dropped.add(renamed(entityId));
    }
  }
  const candidates = (
    Object.entries(COPIED_FAMILY_PRIMARY_KEYS) as Array<[CopiedFamily, string]>
  ).flatMap(([family, primaryKey]) =>
    base[family]
      .filter((element) =>
        String(element[primaryKey]).startsWith(`${namespace}:`),
      )
      .map((element) => {
        const text = JSON.stringify(element).replace(idPattern, (match, id) =>
          String(id).startsWith(`${namespace}:package.`)
            ? match
            : `"${renamed(String(id))}"`,
        );
        const copied = JSON.parse(text) as AuthoredElement;
        if (family === 'modules')
          copied.orderKey = Number(copied.orderKey) + moduleOrderKeyOffset;
        return {
          copied,
          family,
          id: String(copied[primaryKey]),
          references: [...text.matchAll(/"([a-z0-9.-]+:[^"]+)"/gu)].map(
            (match) => match[1]!,
          ),
        };
      }),
  );
  // Drop everything that names a dropped id, to a fixed point.
  let kept = candidates;
  for (let changed = true; changed;) {
    changed = false;
    kept = kept.filter((candidate) => {
      if (!candidate.references.some((id) => dropped.has(id))) return true;
      dropped.add(candidate.id);
      changed = true;
      return false;
    });
  }
  const result = Object.fromEntries(
    Object.keys(COPIED_FAMILY_PRIMARY_KEYS).map((family) => [family, []]),
  ) as unknown as Record<CopiedFamily, AuthoredElement[]>;
  for (const candidate of kept) result[candidate.family].push(candidate.copied);
  return result;
}

if (isFullCompileProcess) {
  let invocationCount = 0;
  process.once('message', (message: CompileProcessInput) => {
    invocationCount += 1;
    const input = compilerInput(message.normalizedDefinitionBytes);
    const startedCpu = process.cpuUsage();
    const startedWall = performance.now();
    const result = compileApplication(input);
    const wallMilliseconds = performance.now() - startedWall;
    const elapsedCpu = process.cpuUsage(startedCpu);
    process.send?.(
      {
        cpuMilliseconds: (elapsedCpu.system + elapsedCpu.user) / 1_000,
        invocationCount,
        pid: process.pid,
        status: result.status,
        wallMilliseconds,
      } satisfies CompileBudgetSample,
      () => process.disconnect(),
    );
  });
}

if (!isFullCompileProcess) {
  test('cold full compile stays within the numeric v0 maximum-field budget', async () => {
    const measurement = await measureCompileBudget({
      ...defaultOptions,
      collectSamples: () =>
        collectFreshProcessSamples(
          maximumFieldBytes,
          FULL_COMPILE_SAMPLE_COUNT,
        ),
    });
    const result = requireMeasuredWithinBudget(measurement);

    assert.equal(
      new Set(result.samples.map((sample) => sample.pid)).size,
      FULL_COMPILE_SAMPLE_COUNT,
      'each cold compile budget sample must come from a distinct process',
    );
    assert.deepEqual(
      result.samples.map((sample) => sample.invocationCount),
      Array.from({ length: FULL_COMPILE_SAMPLE_COUNT }, () => 1),
      'each sample must time the first compile invocation in its process',
    );
    process.stdout.write(
      `compile-budget: estimator=best-of-${FULL_COMPILE_SAMPLE_COUNT} cpu_ms=${result.bestSample.cpuMilliseconds.toFixed(1)} wall_ms=${result.bestSample.wallMilliseconds.toFixed(1)} cpu_idle_pct=${(result.beforeCpuIdleFraction * 100).toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS} sample_wall_ms=${result.samples.map((sample) => sample.wallMilliseconds.toFixed(1)).join(',')} sample_cpu_ms=${result.samples.map((sample) => sample.cpuMilliseconds.toFixed(1)).join(',')}\n`,
    );
  });

  test('cold full compile stays within budget at the v0 package-byte maximum', async () => {
    const envelope = packageByteEnvelope();
    const compiled = mustCompile(
      compilerInput(envelope.normalizedDefinitionBytes),
    );
    const stagedOutputBytes = compiled.stagedArtifacts.reduce(
      (sum, artifact) => sum + artifact.canonicalBytes.byteLength,
      0,
    );
    assert.ok(stagedOutputBytes <= DEFAULT_COMPILER_LIMITS.maximumOutputBytes);
    const measurement = await measureCompileBudget({
      ...defaultOptions,
      collectSamples: () =>
        collectFreshProcessSamples(
          envelope.normalizedDefinitionBytes,
          FULL_COMPILE_SAMPLE_COUNT,
        ),
    });
    const result = requireMeasuredWithinBudget(measurement);

    assert.equal(
      new Set(result.samples.map((sample) => sample.pid)).size,
      FULL_COMPILE_SAMPLE_COUNT,
      'each cold compile budget sample must come from a distinct process',
    );
    assert.deepEqual(
      result.samples.map((sample) => sample.invocationCount),
      Array.from({ length: FULL_COMPILE_SAMPLE_COUNT }, () => 1),
      'each sample must time the first compile invocation in its process',
    );
    const normalizedByteLength = envelope.normalizedDefinitionBytes.byteLength;
    process.stdout.write(
      `compile-budget-package-bytes: normalized_bytes=${normalizedByteLength} maximum_bytes=${STRUCTURAL_LIMITS_V0.maximumNormalizedBytes} fraction_of_maximum=${(normalizedByteLength / STRUCTURAL_LIMITS_V0.maximumNormalizedBytes).toFixed(4)} application_copies=${envelope.applicationCopies} partial_copy_modules=${envelope.partialCopyModules} staged_output_bytes=${stagedOutputBytes} output_cap_bytes=${DEFAULT_COMPILER_LIMITS.maximumOutputBytes} estimator=best-of-${FULL_COMPILE_SAMPLE_COUNT} cpu_ms=${result.bestSample.cpuMilliseconds.toFixed(1)} wall_ms=${result.bestSample.wallMilliseconds.toFixed(1)} cpu_idle_pct=${(result.beforeCpuIdleFraction * 100).toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS} sample_wall_ms=${result.samples.map((sample) => sample.wallMilliseconds.toFixed(1)).join(',')} sample_cpu_ms=${result.samples.map((sample) => sample.cpuMilliseconds.toFixed(1)).join(',')}\n`,
    );
  });

  test('current CPU saturation makes the compile budget indeterminate, never green', async () => {
    let collectorRan = false;
    const saturated = MINIMUM_CPU_IDLE_FRACTION - 0.01;
    const measurement = await measureCompileBudget({
      ...defaultOptions,
      collectSamples: async () => {
        collectorRan = true;
        return [];
      },
      readCpuIdleFraction: async () => saturated,
    });

    assert.equal(collectorRan, false);
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

  test('one noisy sample no longer decides the best-of-five verdict', async () => {
    const noisyWallMilliseconds = FULL_COMPILE_BUDGET_MILLISECONDS + 250;
    const controlledSamples = [
      controlledSample(1, noisyWallMilliseconds),
      controlledSample(2, 4_100),
      controlledSample(3, 4_000),
      controlledSample(4, 4_200),
      controlledSample(5, 4_150),
    ];
    const measurement = await measureCompileBudget({
      ...defaultOptions,
      collectSamples: async () => controlledSamples,
      readCpuIdleFraction: async () => 1,
    });
    const result = requireMeasuredWithinBudget(measurement);

    assert.equal(
      noisyWallMilliseconds > FULL_COMPILE_BUDGET_MILLISECONDS,
      true,
    );
    assert.equal(result.bestSample.wallMilliseconds, 4_000);
    process.stdout.write(
      `compile-budget-noise-control: old_single_wall_ms=${noisyWallMilliseconds.toFixed(1)} old_single_verdict=FAIL new_best_of_five_wall_ms=${result.bestSample.wallMilliseconds.toFixed(1)} new_verdict=PASS budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
    );
  });

  test('five over-budget controlled samples fail the best-of-five verdict', async () => {
    const controlledSamples = Array.from(
      { length: FULL_COMPILE_SAMPLE_COUNT },
      (_, index) =>
        controlledSample(
          index + 1,
          FULL_COMPILE_BUDGET_MILLISECONDS + 100 + index,
        ),
    );
    const measurement = await measureCompileBudget({
      ...defaultOptions,
      collectSamples: async () => controlledSamples,
      readCpuIdleFraction: async () => 1,
    });
    assert.throws(
      () => requireMeasuredWithinBudget(measurement),
      /COMPILE_BUDGET_EXCEEDED/u,
    );
    process.stdout.write(
      `compile-budget-negative: best_wall_ms=${controlledSamples[0]!.wallMilliseconds.toFixed(1)} budget_ms=${FULL_COMPILE_BUDGET_MILLISECONDS}\n`,
    );
  });

  test('an empty or malformed sample set cannot pass vacuously', async () => {
    await assert.rejects(
      measureCompileBudget({
        ...defaultOptions,
        collectSamples: async () => [],
        readCpuIdleFraction: async () => 1,
      }),
      /COMPILE_BUDGET_SAMPLE_COUNT_INVALID/u,
    );
    await assert.rejects(
      measureCompileBudget({
        ...defaultOptions,
        collectSamples: async () => [
          controlledSample(1, Number.NaN),
          controlledSample(2, 4_000),
          controlledSample(3, 4_000),
          controlledSample(4, 4_000),
          controlledSample(5, 4_000),
        ],
        readCpuIdleFraction: async () => 1,
      }),
      /COMPILE_BUDGET_SAMPLE_INVALID/u,
    );
  });
}

function collectFreshProcessSamples(
  normalizedDefinitionBytes: Uint8Array,
  sampleCount: number,
): Promise<readonly CompileBudgetSample[]> {
  return Array.from({ length: sampleCount }).reduce<
    Promise<CompileBudgetSample[]>
  >(
    async (samplesPromise) => [
      ...(await samplesPromise),
      await measureFirstInvocationInFreshProcess(normalizedDefinitionBytes),
    ],
    Promise.resolve([]),
  );
}

function measureFirstInvocationInFreshProcess(
  normalizedDefinitionBytes: Uint8Array,
): Promise<CompileBudgetSample> {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [FULL_COMPILE_PROCESS_ARGUMENT], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let sample: CompileBudgetSample | undefined;
    child.once('message', (message: CompileBudgetSample) => {
      sample = message;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `full-compile process exited with code ${String(code)} signal ${String(signal)}`,
          ),
        );
      } else if (!sample) {
        reject(new Error('full-compile process exited without a result'));
      } else {
        resolve(sample);
      }
    });
    child.send({ normalizedDefinitionBytes } satisfies CompileProcessInput);
  });
}

async function measureCompileBudget(
  options: CompileBudgetOptions,
): Promise<CompileBudgetMeasurement> {
  const beforeCpuIdleFraction = await options.readCpuIdleFraction();
  if (beforeCpuIdleFraction < options.minimumCpuIdleFraction) {
    return {
      minimumCpuIdleFraction: options.minimumCpuIdleFraction,
      observedCpuIdleFraction: beforeCpuIdleFraction,
      status: 'indeterminate',
    };
  }

  const samples = await options.collectSamples();
  if (samples.length !== options.sampleCount || samples.length === 0) {
    throw new Error(
      `COMPILE_BUDGET_SAMPLE_COUNT_INVALID: expected ${options.sampleCount}, received ${samples.length}`,
    );
  }
  for (const sample of samples) {
    if (
      sample.status !== 'compiled' ||
      sample.invocationCount !== 1 ||
      !Number.isSafeInteger(sample.pid) ||
      sample.pid <= 0 ||
      !Number.isFinite(sample.cpuMilliseconds) ||
      sample.cpuMilliseconds < 0 ||
      !Number.isFinite(sample.wallMilliseconds) ||
      sample.wallMilliseconds < 0
    ) {
      throw new Error(
        `COMPILE_BUDGET_SAMPLE_INVALID: ${JSON.stringify(sample)}`,
      );
    }
  }

  const bestSample = samples.reduce((best, sample) =>
    sample.wallMilliseconds < best.wallMilliseconds ? sample : best,
  );
  return {
    beforeCpuIdleFraction,
    bestSample,
    samples,
    status: 'measured',
  };
}

function requireMeasuredWithinBudget(
  measurement: CompileBudgetMeasurement,
): Extract<CompileBudgetMeasurement, { readonly status: 'measured' }> {
  if (measurement.status === 'indeterminate') {
    assert.fail(
      `COMPILE_BUDGET_INDETERMINATE: observed CPU idle ${(measurement.observedCpuIdleFraction * 100).toFixed(1)}% is below required ${(measurement.minimumCpuIdleFraction * 100).toFixed(1)}%; rerun the exclusive gate`,
    );
  }
  assert.ok(
    measurement.bestSample.wallMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS,
    `COMPILE_BUDGET_EXCEEDED: best of ${FULL_COMPILE_SAMPLE_COUNT} cold full compiles took ${measurement.bestSample.wallMilliseconds.toFixed(1)}ms; budget is ${FULL_COMPILE_BUDGET_MILLISECONDS}ms; samples were ${measurement.samples.map((sample) => sample.wallMilliseconds.toFixed(1)).join(', ')}ms`,
  );
  return measurement;
}

function controlledSample(
  pid: number,
  wallMilliseconds: number,
): CompileBudgetSample {
  return {
    cpuMilliseconds: wallMilliseconds,
    invocationCount: 1,
    pid,
    status: 'compiled',
    wallMilliseconds,
  };
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
