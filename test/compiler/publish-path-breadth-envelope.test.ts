import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import { catalogModuleDefinition } from '../../packages/domain/src/catalog/definition.js';
import { locationModuleDefinition } from '../../packages/domain/src/location/definition.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/definition.js';

const APPLICATION_NAMESPACE = 'northstar.breadth';
const PACKAGE_ID = `${APPLICATION_NAMESPACE}:package.application`;
const COMPILE_SAMPLES_PER_POINT = 5;

const firstPartyModules = [
  partyModuleDefinition,
  catalogModuleDefinition,
  locationModuleDefinition,
] as const;

interface PhysicalIndexCount {
  readonly entityId: string;
  readonly physicalIndexCount: number;
}

interface BreadthPoint {
  readonly compileWallClockMilliseconds: number;
  readonly measuredAtSha: string;
  readonly moduleCount: number;
  readonly moduleIds: readonly string[];
  readonly physicalIndexCountByEntity: readonly PhysicalIndexCount[];
  readonly searchableFieldCount: number;
  readonly totalFieldCount: number;
}

interface BreadthCurve {
  readonly points: readonly BreadthPoint[];
}

test('records a shape-valid publish-path breadth curve over first-party modules', () => {
  const measuredAtSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const points = firstPartyModules.map((_, index) =>
    measureBreadthPoint(index + 1, measuredAtSha),
  );
  const curve = { points } satisfies BreadthCurve;

  assertBreadthCurveShape(curve);
  process.stdout.write(
    `publish-path-breadth-envelope=${JSON.stringify(curve)}\n`,
  );
});

test('breadth shape rejects absent points and missing dimensions', () => {
  assert.throws(
    () => assertBreadthCurveShape({ points: [] }),
    /at least one point/u,
  );
  assert.throws(
    () =>
      assertBreadthCurveShape({
        points: [
          {
            compileWallClockMilliseconds: 1,
            measuredAtSha: 'a'.repeat(40),
            moduleCount: 1,
            moduleIds: ['northstar.test:module.one'],
            physicalIndexCountByEntity: [],
            totalFieldCount: 1,
          },
        ],
      }),
    /searchableFieldCount/u,
  );
});

test('breadth shape rejects non-increasing N and non-finite values', () => {
  const point = validShapePoint();
  assert.throws(
    () => assertBreadthCurveShape({ points: [point, point] }),
    /strictly increase/u,
  );
  assert.throws(
    () =>
      assertBreadthCurveShape({
        points: [{ ...point, compileWallClockMilliseconds: Number.NaN }],
      }),
    /compileWallClockMilliseconds/u,
  );
});

function measureBreadthPoint(
  moduleCount: number,
  measuredAtSha: string,
): BreadthPoint {
  const definition = composeFirstPartyModules(moduleCount);
  const normalized = normalizeApplicationPackage(definition);
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const input: CompilerInput = {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  };
  const samples: number[] = [];
  let compiled: CompileSuccess | null = null;

  for (let index = 0; index < COMPILE_SAMPLES_PER_POINT; index += 1) {
    const started = process.hrtime.bigint();
    const result = compileApplication(input);
    const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    if (result.status !== 'compiled') {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    assert.equal(result.attestation.compileMode, 'coldFull');
    compiled = result;
    samples.push(elapsedMilliseconds);
  }

  assert.ok(compiled, 'measurement produced no compiled result');
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const moduleIds = normalized.modules.map(({ moduleId }) => moduleId);

  return {
    compileWallClockMilliseconds: roundToMicrosecond(median(samples)),
    measuredAtSha,
    moduleCount: moduleIds.length,
    moduleIds,
    physicalIndexCountByEntity: storage.entities
      .map(({ entityId, indexes }) => ({
        entityId,
        physicalIndexCount: indexes.length,
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
    searchableFieldCount: normalized.fields.filter(
      ({ searchable }) => searchable,
    ).length,
    totalFieldCount: normalized.fields.length,
  };
}

function composeFirstPartyModules(
  moduleCount: number,
): Record<string, unknown> {
  const definitions = firstPartyModules
    .slice(0, moduleCount)
    .map((create) => create(APPLICATION_NAMESPACE));
  const first = definitions[0];
  if (!first) throw new TypeError('at least one module is required');

  const composed = structuredClone(first);
  for (const [name, value] of Object.entries(first)) {
    if (!Array.isArray(value)) continue;
    if (name === 'capabilityRequirements') {
      const sharedCapability: unknown = collection(first, name)[0];
      for (const definition of definitions.slice(1)) {
        assert.deepEqual(collection(definition, name), [sharedCapability]);
      }
      composed[name] = [sharedCapability];
      continue;
    }
    if (name === 'modules') {
      composed[name] = definitions.map((definition, index) => {
        const [module] = collection(definition, name);
        if (!isRecord(module)) {
          throw new TypeError('a first-party module definition is missing');
        }
        return {
          ...module,
          orderKey: (index + 1) * 10,
          ownerPackageId: PACKAGE_ID,
        };
      });
      continue;
    }
    composed[name] = definitions.flatMap((definition) =>
      collection(definition, name),
    );
  }

  const packageDefinition = requiredRecord(first.package, 'package');
  composed.package = {
    ...packageDefinition,
    namespace: APPLICATION_NAMESPACE,
    packageId: PACKAGE_ID,
  };
  return composed;
}

function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) throw new Error(`missing manifest ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk) throw new Error(`missing chunk ${familyId}`);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function assertBreadthCurveShape(
  value: unknown,
): asserts value is BreadthCurve {
  const curve = requiredRecord(value, 'curve');
  const points = curve.points;
  assert.ok(Array.isArray(points), 'points must be an array');
  assert.ok(points.length > 0, 'curve must carry at least one point');

  let previousModuleCount = 0;
  for (const [index, candidate] of points.entries()) {
    const point = requiredRecord(candidate, `points[${index}]`);
    const moduleCount = finiteCount(point.moduleCount, 'moduleCount');
    assert.ok(
      Number.isInteger(moduleCount) && moduleCount > previousModuleCount,
      'moduleCount must strictly increase',
    );
    previousModuleCount = moduleCount;
    const totalFieldCount = finiteCount(
      point.totalFieldCount,
      'totalFieldCount',
    );
    const searchableFieldCount = finiteCount(
      point.searchableFieldCount,
      'searchableFieldCount',
    );
    assert.ok(
      searchableFieldCount <= totalFieldCount,
      'searchableFieldCount must not exceed totalFieldCount',
    );
    finiteNumber(
      point.compileWallClockMilliseconds,
      'compileWallClockMilliseconds',
    );
    assert.match(
      requiredString(point.measuredAtSha, 'measuredAtSha'),
      /^[0-9a-f]{40}$/u,
    );
    assert.ok(Array.isArray(point.moduleIds), 'moduleIds must be an array');
    assert.equal(point.moduleIds.length, moduleCount);
    for (const moduleId of point.moduleIds) {
      requiredString(moduleId, 'moduleId');
    }
    assert.ok(
      Array.isArray(point.physicalIndexCountByEntity),
      'physicalIndexCountByEntity must be an array',
    );
    assert.ok(
      point.physicalIndexCountByEntity.length > 0,
      'physicalIndexCountByEntity must carry at least one entity',
    );
    for (const physicalCount of point.physicalIndexCountByEntity) {
      const entity = requiredRecord(
        physicalCount,
        'physicalIndexCountByEntity',
      );
      requiredString(entity.entityId, 'entityId');
      finiteCount(entity.physicalIndexCount, 'physicalIndexCount');
    }
  }
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  assert.ok(Number.isFinite(value), `${name} must be finite`);
  assert.ok(value >= 0, `${name} must not be negative`);
  return value;
}

function finiteCount(value: unknown, name: string): number {
  const count = finiteNumber(value, name);
  assert.ok(Number.isInteger(count), `${name} must be an integer`);
  return count;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validShapePoint(): BreadthPoint {
  return {
    compileWallClockMilliseconds: 1,
    measuredAtSha: 'a'.repeat(40),
    moduleCount: 1,
    moduleIds: ['northstar.test:module.one'],
    physicalIndexCountByEntity: [
      { entityId: 'northstar.test:entity.one', physicalIndexCount: 1 },
    ],
    searchableFieldCount: 1,
    totalFieldCount: 1,
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  if (middle === undefined) throw new TypeError('median requires samples');
  return middle;
}

function roundToMicrosecond(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function collection(
  definition: Record<string, unknown>,
  name: string,
): unknown[] {
  const value = definition[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`module definition is missing ${name}`);
  }
  return value;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
