import { readFileSync } from 'node:fs';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '@north-star/runtime/request-context';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
} from '@north-star/runtime/request-runtime-view';

export interface DemoRuntimeOptions {
  readonly compiledFixturePath: string;
  readonly environmentId: string;
  readonly pointerFence: number;
  readonly pointerId: string;
  readonly principalId: string;
  readonly releaseId: string;
  readonly tenantId: string;
}

/**
 * Local demonstration composition only. Production callers inject their P5
 * PostgreSQL loader; neither server nor renderer can construct a view itself.
 */
export function createDemoRequestRuntimeEntry(
  options: DemoRuntimeOptions,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identity: AuthenticatedIdentity = Object.freeze({
    environmentId: options.environmentId,
    principalId: options.principalId,
    tenantId: options.tenantId,
  });
  const definition = readCompiledDefinition(options);
  const authenticatedEntry = new AuthenticatedRequestEntryAdapter(
    async () => identity,
  );
  const currentPolicy: CurrentPolicyGateway = Object.freeze({
    async authorize() {
      return Object.freeze({
        decision: 'ALLOW' as const,
        decisionVersion: 'northstar.current-policy-decision/v1' as const,
        policyVersion: 'demo-policy-v1',
      });
    },
    async readCurrentVersion() {
      return Object.freeze({ policyVersion: 'demo-policy-v1' });
    },
  });

  return new AuthenticatedRequestRuntimeEntryAdapter(
    authenticatedEntry,
    Object.freeze({
      async load() {
        return definition;
      },
    }),
    currentPolicy,
  );
}

export function readDemoCompiledFixture(
  compiledFixturePath: string,
): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(readFileSync(compiledFixturePath, 'utf8'));
  if (!isRecord(value))
    throw new Error('compiled shell fixture is not an object');
  return Object.freeze(value);
}

function readCompiledDefinition(
  options: DemoRuntimeOptions,
): LoadedRequestRuntimeDefinition {
  const fixture = readDemoCompiledFixture(options.compiledFixturePath);
  if (
    fixture.schemaVersion !== 'northstar.web:compiled-shell-fixture/v1' ||
    !isSha256(fixture.normalizedDefinitionDigest) ||
    !isRecord(fixture.projections)
  ) {
    throw new Error('compiled shell fixture has an invalid envelope');
  }
  const projections = fixture.projections;
  const agent = projection(
    projections.agent,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
  );
  const catalog = projection(
    projections.catalog,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
  );
  const operation = projection(
    projections.operation,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
  );
  const query = projection(
    projections.query,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
  );
  const surface = projection(
    projections.surface,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
  );

  return Object.freeze({
    environmentId: options.environmentId,
    pointer: Object.freeze({
      fence: options.pointerFence,
      pointerId: options.pointerId,
    }),
    projections: Object.freeze({ agent, catalog, operation, query, surface }),
    release: Object.freeze({
      contentHash: fixture.normalizedDefinitionDigest,
      releaseId: options.releaseId,
    }),
    tenantId: options.tenantId,
  });
}

function projection<TFamily extends string>(value: unknown, familyId: TFamily) {
  if (
    !isRecord(value) ||
    value.familyId !== familyId ||
    !isSha256(value.artifactRoot) ||
    !isSha256(value.semanticDigest) ||
    !isNonBlank(value.instanceId) ||
    !isNonBlank(value.payloadSchemaVersion) ||
    !isImmutableJson(value.payload)
  ) {
    throw new Error(`compiled shell fixture is missing ${familyId}`);
  }
  return Object.freeze({
    artifactRoot: value.artifactRoot,
    familyId,
    instanceId: value.instanceId,
    payload: value.payload,
    payloadSchemaVersion: value.payloadSchemaVersion,
    semanticDigest: value.semanticDigest,
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImmutableJson(value: unknown): value is ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isImmutableJson);
  if (isRecord(value)) return Object.values(value).every(isImmutableJson);
  return false;
}
