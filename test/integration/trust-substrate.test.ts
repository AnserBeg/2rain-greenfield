import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  redactBusinessChanges,
  redactEvidenceMetadata,
  type ActorKind,
  type ResolvedActorAttribution,
} from '../../packages/platform-runtime/src/trust/contracts.js';
import {
  LIFECYCLE_OPERATION_INPUT_VERSION,
  LifecycleService,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type SemanticOperationGatewayPort,
} from '../../packages/platform-runtime/src/trust/lifecycle-service.js';
import {
  TrustedActorEnvelopeIssuer,
  assertTrustedActorEnvelope,
} from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = 'a1000000-0000-4000-8000-000000000001';
const humanId = 'aa000000-0000-4000-8000-000000000001';
const agentId = 'aa000000-0000-4000-8000-000000000002';
const automationId = 'aa000000-0000-4000-8000-000000000003';
const systemId = 'aa000000-0000-4000-8000-000000000004';
const approvingHumanId = 'aa000000-0000-4000-8000-000000000005';
const delegationId = 'aa000000-0000-4000-8000-000000000006';

const identities = new Map<string, AuthenticatedIdentity>([
  ['human', identity(humanId)],
  ['agent', identity(agentId)],
  ['automation', identity(automationId)],
  ['system', identity(systemId)],
]);

test('trusted actor envelopes preserve distinct execution and delegation identities', async () => {
  const contexts = await Promise.all(
    [...identities.keys()].map((session) => issueContext(session)),
  );
  const attributionByPrincipal = new Map<string, ResolvedActorAttribution>([
    [humanId, attribution('HUMAN', humanId)],
    [
      agentId,
      attribution('AGENT', agentId, {
        approvingHumanId,
        delegation: {
          delegatedTo: { kind: 'AGENT', principalId: agentId },
          delegatingPrincipal: { kind: 'HUMAN', principalId: humanId },
          delegationId,
        },
        initiatingHumanId: humanId,
        subject: { kind: 'HUMAN', principalId: humanId },
      }),
    ],
    [automationId, attribution('AUTOMATION', automationId)],
    [systemId, attribution('SYSTEM', systemId)],
  ]);
  const issuer = new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      const attribution = attributionByPrincipal.get(context.principalId);
      if (!attribution) throw new Error('fixture attribution missing');
      return attribution;
    },
  });

  const envelopes = await Promise.all(
    contexts.map((context) => issuer.issue(context)),
  );
  assert.deepEqual(
    envelopes.map(({ actor }) => actor.executionPrincipal.kind),
    ['HUMAN', 'AGENT', 'AUTOMATION', 'SYSTEM'],
  );
  for (const [index, envelope] of envelopes.entries()) {
    assertTrustedActorEnvelope(envelope);
    assert.equal(envelope.principalId, contexts[index]?.principalId);
    assert.equal(
      envelope.actor.executionPrincipal.principalId,
      contexts[index]?.principalId,
    );
    assert.equal(Object.isFrozen(envelope), true);
    assert.equal(Object.isFrozen(envelope.actor), true);
  }

  assert.deepEqual(envelopes[1]?.actor, {
    approvingHumanId,
    delegation: {
      delegatedTo: { kind: 'AGENT', principalId: agentId },
      delegatingPrincipal: { kind: 'HUMAN', principalId: humanId },
      delegationId,
    },
    executionPrincipal: { kind: 'AGENT', principalId: agentId },
    initiatingHumanId: humanId,
    subject: { kind: 'HUMAN', principalId: humanId },
  });
  assert.notDeepEqual(envelopes[2]?.actor.executionPrincipal, {
    kind: 'HUMAN',
    principalId: humanId,
  });
  assert.notDeepEqual(envelopes[3]?.actor.executionPrincipal, {
    kind: 'HUMAN',
    principalId: humanId,
  });

  const forged = {
    environmentId,
    principalId: humanId,
    requestId: 'aa000000-0000-4000-8000-000000000099',
    tenantId,
  } as TrustedRequestContext;
  await assert.rejects(
    issuer.issue(forged),
    /must be issued by AuthenticatedRequestEntryAdapter/,
  );

  const mismatchIssuer = new TrustedActorEnvelopeIssuer({
    async resolve() {
      return attribution('HUMAN', humanId);
    },
  });
  await assert.rejects(
    mismatchIssuer.issue(contexts[1] as TrustedRequestContext),
    /must match the issued request context/,
  );
});

test('classified evidence redacts secret and sensitive values before persistence shapes exist', () => {
  const sensitiveFixtureValue = 'g2-sensitive-fixture-value';
  const secretFixtureValue = 'g2-secret-fixture-value';
  const metadata = redactEvidenceMetadata({
    credentialMaterial: {
      classification: 'SECRET',
      value: secretFixtureValue,
    },
    internalRoute: { classification: 'INTERNAL', value: 'master-fixture' },
    personalContact: {
      classification: 'SENSITIVE',
      value: sensitiveFixtureValue,
    },
    publicSource: { classification: 'PUBLIC', value: 'integration-test' },
  });
  assert.deepEqual(metadata, {
    credentialMaterial: {
      classification: 'SECRET',
      representation: 'REDACTED',
    },
    internalRoute: {
      classification: 'INTERNAL',
      representation: 'VALUE',
      value: 'master-fixture',
    },
    personalContact: {
      classification: 'SENSITIVE',
      representation: 'REDACTED',
    },
    publicSource: {
      classification: 'PUBLIC',
      representation: 'VALUE',
      value: 'integration-test',
    },
  });
  assert.doesNotMatch(JSON.stringify(metadata), /g2-(?:secret|sensitive)/);

  const changes = redactBusinessChanges([
    {
      classification: 'PUBLIC',
      fieldId: 'displayName',
      newState: { state: 'VALUE', value: 'new' },
      oldState: { state: 'VALUE', value: 'old' },
    },
    {
      classification: 'INTERNAL',
      fieldId: 'optionalCode',
      newState: { state: 'VALUE', value: 'A-1' },
      oldState: { state: 'ABSENT' },
    },
    {
      classification: 'PUBLIC',
      fieldId: 'nickname',
      newState: { state: 'CLEARED' },
      oldState: { state: 'VALUE', value: 'before' },
    },
    {
      classification: 'SECRET',
      fieldId: 'credentialMaterial',
      newState: { state: 'VALUE', value: secretFixtureValue },
      oldState: { state: 'VALUE', value: sensitiveFixtureValue },
    },
  ]);
  assert.deepEqual(changes[1]?.oldState, { state: 'ABSENT' });
  assert.deepEqual(changes[2]?.newState, { state: 'CLEARED' });
  assert.deepEqual(changes[3]?.oldState, {
    classification: 'SECRET',
    representation: 'REDACTED',
    state: 'VALUE',
  });
  assert.doesNotMatch(JSON.stringify(changes), /g2-(?:secret|sensitive)/);
});

test('LifecycleService exposes archive and restore only through the Semantic Operation Gateway port', async () => {
  const calls: Array<{ context: object; request: unknown }> = [];
  const gateway: SemanticOperationGatewayPort<object, { accepted: true }> = {
    async invoke(context, request) {
      calls.push({ context, request });
      return { accepted: true };
    },
  };
  const context = Object.freeze({ request: 'issued-view-fixture' });
  const service = new LifecycleService(gateway);
  const binding = {
    archiveOperationId: 'fixture.master:archive',
    restoreOperationId: 'fixture.master:restore',
  };

  assert.deepEqual(
    await service.archive(context, binding, {
      expectedRevision: 4,
      reason: 'inactive fixture',
      recordId: 'master-1',
    }),
    { accepted: true },
  );
  assert.deepEqual(
    await service.restore(context, binding, {
      expectedRevision: 5,
      reason: 'fixture reopened',
      recordId: 'master-1',
    }),
    { accepted: true },
  );
  assert.deepEqual(calls, [
    {
      context,
      request: {
        input: {
          expectedRevision: 4,
          lifecycleAction: 'ARCHIVE',
          reason: 'inactive fixture',
          recordId: 'master-1',
          schemaVersion: LIFECYCLE_OPERATION_INPUT_VERSION,
        },
        operationId: 'fixture.master:archive',
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
    },
    {
      context,
      request: {
        input: {
          expectedRevision: 5,
          lifecycleAction: 'RESTORE',
          reason: 'fixture reopened',
          recordId: 'master-1',
          schemaVersion: LIFECYCLE_OPERATION_INPUT_VERSION,
        },
        operationId: 'fixture.master:restore',
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
    },
  ]);
  assert.throws(
    () =>
      service.archive(
        context,
        {
          archiveOperationId: 'fixture.master:remove',
          restoreOperationId: 'fixture.master:restore',
        },
        {
          expectedRevision: 6,
          reason: 'invalid binding proof',
          recordId: 'master-1',
        },
      ),
    /archive binding must end with :archive/,
  );
  assert.equal(calls.length, 2);

  assert.deepEqual(
    Object.getOwnPropertyNames(LifecycleService.prototype).toSorted(),
    ['archive', 'constructor', 'restore'],
  );
  const source = readFileSync(
    resolve('packages/platform-runtime/src/trust/lifecycle-service.ts'),
    'utf8',
  );
  assert.match(source, /SemanticOperationGatewayPort/);
  assert.doesNotMatch(source, /\b(?:DELETE|delete|table|repository|sql)\b/);
});

function identity(principalId: string): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

async function issueContext(session: string): Promise<TrustedRequestContext> {
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const fixtureSession = request.headers?.authorization;
    return typeof fixtureSession === 'string'
      ? (identities.get(fixtureSession) ?? null)
      : null;
  });
  return entry.enter({ headers: { authorization: session } });
}

function attribution(
  kind: ActorKind,
  principalId: string,
  overrides: Partial<ResolvedActorAttribution> = {},
): ResolvedActorAttribution {
  return {
    approvingHumanId: null,
    delegation: null,
    executionPrincipal: { kind, principalId },
    initiatingHumanId: null,
    subject: null,
    ...overrides,
  };
}
