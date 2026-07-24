import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { expect, test } from '@playwright/test';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type ContentAddressedArtifact,
} from '@north-star/compiler';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '@north-star/runtime/request-context';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../../../packages/runtime/src/request-runtime-view.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../../../../test/fixtures/g2/module-conformance/definitions.js';
import { createSurfaceRuntimeServer } from '../../src/app-server.js';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  const compiled = compileFixture();
  const policy = allowPolicy();
  const executor = new BrowserFixtureExecutor();
  executor.createSeed('Existing live master');
  server = createSurfaceRuntimeServer(runtimeEntry(compiled, policy), {
    operationGateway: new SemanticOperationGateway(policy, executor),
    queryGateway: new SemanticQueryGateway(policy, executor),
  });
  baseUrl = await listen(server);
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('fixture list and form render live DTOs and reflect a semantic create', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ authorization: 'fixture-user' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'master list',
  );
  await expect(
    page.getByRole('cell', { name: 'Existing live master' }),
  ).toBeVisible();
  await expect(page.locator('[data-data-state="exact"]')).toBeVisible();

  await page.getByRole('link', { name: 'master form' }).click();
  await expect(
    page.getByRole('heading', { name: 'Create master form' }),
  ).toBeVisible();
  await page.getByLabel('Master Name').fill('Browser-created master');
  await page.getByRole('button', { name: 'Create record' }).click();

  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.getByRole('status')).toContainText(
    'trust evidence is linked',
  );
  await expect(page.getByLabel('Master Name')).toHaveValue(
    'Browser-created master',
  );

  await page.getByRole('link', { name: 'master list' }).click();
  await expect(
    page.getByRole('cell', { name: 'Browser-created master' }),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText('north_star_module');
  await expect(page.locator('body')).not.toContainText('storageClass');
});

class BrowserFixtureExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  private readonly records = new Map<string, SemanticRecordDto>();

  createSeed(name: string): void {
    const recordId = randomUUID();
    this.records.set(recordId, dto(recordId, name));
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    if ('arguments' in request) {
      const args = recordValue(request.arguments);
      const records =
        request.definition.queryType === 'get'
          ? [...this.records.values()].filter(
              (record) => record.recordId === args.recordId,
            )
          : [...this.records.values()];
      return {
        kind: 'semanticQueryResult',
        outcome:
          records.length > 0 || request.definition.queryType === 'list'
            ? 'exact'
            : 'not-found',
        queryId: request.definition.queryId,
        records,
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: null,
      };
    }

    const input = recordValue(request.input);
    const values = recordValue(input.values ?? {});
    const recordId = String(input.recordId);
    const created = dto(
      recordId,
      String(values[FIXTURE_IDS.fieldIds.parentName] ?? ''),
    );
    this.records.set(recordId, created);
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: created,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }
}

function allowPolicy(): CurrentPolicyGateway {
  return {
    async authorize() {
      return {
        decision: 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'browser-surface-policy/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'browser-surface-policy/v1' };
    },
  };
}

function runtimeEntry(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) =>
      request.headers?.authorization === 'fixture-user' ? identity : null,
    ),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId,
          pointer: { fence: 1, pointerId },
          projections: runtimeProjections(compiled),
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId,
        };
      },
    },
    policy,
  );
}

function dto(recordId: string, name: string): SemanticRecordDto {
  return Object.freeze({
    archived: false,
    entityId: FIXTURE_IDS.entityIds.parent,
    recordId,
    revision: 1,
    values: Object.freeze({ [FIXTURE_IDS.fieldIds.parentName]: name }),
  });
}

function runtimeProjections(
  compiled: CompileSuccess,
): LoadedRequestRuntimeDefinition['projections'] {
  return {
    agent: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.agent),
    catalog: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog),
    operation: projection(
      compiled,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
    ),
    query: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.query),
    surface: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.surface),
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestValue = decode(artifact(compiled, reference.artifactRoot));
  assert.ok(Array.isArray(manifestValue.chunks));
  const descriptor = manifestValue.chunks[0];
  assert.ok(isRecord(descriptor));
  const contentHash = descriptor.contentHash;
  assert.equal(typeof contentHash, 'string');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(
      artifact(compiled, String(contentHash)),
    ) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  assert.ok(value);
  return value;
}

function decode(value: ContentAddressedArtifact): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(value.canonicalBytes),
  );
  assert.ok(isRecord(decoded));
  return decoded;
}

function compileFixture(): CompileSuccess {
  const normalized = normalizeApplicationPackage(ordinaryModuleV1());
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  const address = target.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${address.port}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
