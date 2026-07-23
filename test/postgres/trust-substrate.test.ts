import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  POLICY_DECISION_EVIDENCE_VERSION,
  type AcceptedMutationCommand,
  type ActorKind,
  type NonAcceptedInvocationCommand,
  type ResolvedActorAttribution,
  type TrustedActorEnvelope,
} from '../../packages/platform-runtime/src/trust/contracts.js';
import {
  assertSchemaMatchesSnapshot,
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  PostgresTrustService,
  TrustEvidenceError,
} from '../../packages/postgres-provider/src/trust/postgres-trust-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const checkedInSnapshot = resolve('db/schema.snapshot.json');
const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const humanA = 'aa000000-0000-4000-8000-000000000001';
const agentA = 'aa000000-0000-4000-8000-000000000002';
const automationA = 'aa000000-0000-4000-8000-000000000003';
const systemA = 'aa000000-0000-4000-8000-000000000004';
const approverA = 'aa000000-0000-4000-8000-000000000005';
const delegationA = 'aa000000-0000-4000-8000-000000000006';
const humanB = 'bb000000-0000-4000-8000-000000000001';
const releaseA = 'a3000000-0000-4000-8000-000000000001';
const releaseB = 'b3000000-0000-4000-8000-000000000001';
const releaseHashA = 'a'.repeat(64);
const releaseHashB = 'b'.repeat(64);
const sensitiveFixtureValue = 'g2-sensitive-persistence-fixture';
const secretFixtureValue = 'g2-secret-persistence-fixture';

const identities = new Map<string, AuthenticatedIdentity>([
  ['human-a', identity(tenantA, environmentA, humanA)],
  ['agent-a', identity(tenantA, environmentA, agentA)],
  ['automation-a', identity(tenantA, environmentA, automationA)],
  ['system-a', identity(tenantA, environmentA, systemA)],
  ['human-b', identity(tenantB, environmentB, humanB)],
]);

test('migrations 0006-0008 upgrade accepted G1 and converge with the checked-in snapshot', async () => {
  await withEphemeralPostgres('trust-upgrade', async ({ pool }) => {
    const migrations = await loadMigrations(checkedInMigrations);
    assert.equal(
      migrations.at(-1)?.name,
      '0008_module_runtime_role_assumption.sql',
    );
    const admin = await pool.connect();
    try {
      const acceptedG1 = await runMigrations(admin, migrations.slice(0, 5));
      assert.equal(acceptedG1.applied.length, 5);
      assert.equal(
        (
          await admin.query<{ relation: string | null }>(
            "SELECT to_regclass('platform.trust_action_invocations')::text AS relation",
          )
        ).rows[0]?.relation,
        null,
      );

      const upgraded = await runMigrations(admin, migrations);
      assert.deepEqual(upgraded.applied, [
        '0006_trust_substrate.sql',
        '0007_module_storage_transitions.sql',
        '0008_module_runtime_role_assumption.sql',
      ]);
      assert.equal(upgraded.verified.length, 8);
      await assertSchemaMatchesSnapshot(admin, checkedInSnapshot);
    } finally {
      admin.release();
    }
  });
});

test('accepted mutation facts are atomic, attributed, redacted, immutable, and tenant isolated', async () => {
  await withEphemeralPostgres(
    'trust-substrate',
    async ({ connection, pool }) => {
      const migrations = await loadMigrations(checkedInMigrations);
      const admin = await pool.connect();
      try {
        const emptyPath = await runMigrations(admin, migrations);
        assert.equal(emptyPath.applied.length, 8);
        assert.equal(emptyPath.verified.length, 8);
        await assertSchemaMatchesSnapshot(admin, checkedInSnapshot);
        await seedReleaseFixtures(admin);
        await createBusinessMutationFixture(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const contexts = await issueContexts();
        const envelopes = await issueActorEnvelopes(contexts);
        const trust = new PostgresTrustService(runtimePool);
        const acceptedA = acceptedCommand('a', releaseA, releaseHashA);
        const callerActorAttempt = {
          ...acceptedA,
          actor: {
            executionPrincipal: { kind: 'HUMAN', principalId: humanA },
          },
        } as AcceptedMutationCommand;

        const receiptA = await trust.executeAcceptedMutation(
          contexts.agentA,
          envelopes.agentA,
          callerActorAttempt,
          async (transaction) => {
            await transaction.query(
              `INSERT INTO platform.trust_test_business_records (
                 tenant_id,
                 environment_id,
                 id,
                 label,
                 rollback_guard_tenant_id
               ) VALUES ($1, $2, $3, $4, $5)`,
              [
                tenantA,
                environmentA,
                'a9000000-0000-4000-8000-000000000001',
                'tenant-a accepted mutation',
                tenantA,
              ],
            );
            return Object.freeze({ recordId: acceptedA.change.recordId });
          },
        );
        assert.equal(receiptA.invocationId, acceptedA.invocationId);
        assert.deepEqual(receiptA.mutationResult, {
          recordId: acceptedA.change.recordId,
        });

        await resetOutboxWitness(pool);
        const rollbackCommand = acceptedCommand('c', releaseA, releaseHashA);
        await assert.rejects(
          trust.executeAcceptedMutation(
            contexts.agentA,
            envelopes.agentA,
            rollbackCommand,
            async (transaction) => {
              await transaction.query(
                `INSERT INTO platform.trust_test_business_records (
                   tenant_id,
                   environment_id,
                   id,
                   label,
                   rollback_guard_tenant_id
                 ) VALUES ($1, $2, $3, $4, $5)`,
                [
                  tenantA,
                  environmentA,
                  'a9000000-0000-4000-8000-000000000002',
                  'must roll back',
                  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                ],
              );
              return 'uncommitted';
            },
          ),
          /foreign key constraint/,
        );
        const witness = await pool.query<{
          is_called: boolean;
          last_value: string;
        }>(
          'SELECT last_value::text, is_called FROM platform.trust_test_outbox_insert_witness',
        );
        assert.deepEqual(witness.rows[0], {
          is_called: true,
          last_value: '1',
        });

        await recordNonAcceptedEvidence(trust, contexts, envelopes);
        await assert.rejects(
          trust.recordNonAcceptedInvocation(contexts.humanA, envelopes.humanA, {
            ...nonAcceptedCommand('9', 'DENIED', releaseA, releaseHashA),
            outcome: 'SUCCEEDED',
          } as unknown as NonAcceptedInvocationCommand),
          (error: unknown) =>
            error instanceof TrustEvidenceError &&
            error.code === 'STANDALONE_SUCCESS_FORBIDDEN',
        );

        const acceptedB = acceptedCommand('b', releaseB, releaseHashB);
        await trust.executeAcceptedMutation(
          contexts.humanB,
          envelopes.humanB,
          acceptedB,
          async (transaction) => {
            await transaction.query(
              `INSERT INTO platform.trust_test_business_records (
                 tenant_id,
                 environment_id,
                 id,
                 label,
                 rollback_guard_tenant_id
               ) VALUES ($1, $2, $3, $4, $5)`,
              [
                tenantB,
                environmentB,
                'b9000000-0000-4000-8000-000000000001',
                'tenant-b accepted mutation',
                tenantB,
              ],
            );
            return 'tenant-b';
          },
        );

        await assert.rejects(
          trust.recordNonAcceptedInvocation(
            contexts.agentA,
            envelopes.humanB,
            nonAcceptedCommand('8', 'FAILED', releaseA, releaseHashA),
          ),
          (error: unknown) =>
            error instanceof TrustEvidenceError &&
            error.code === 'TRUSTED_ACTOR_CONTEXT_MISMATCH',
        );

        const visibleA = await readVisibleTrust(runtimePool, contexts.agentA);
        assert.deepEqual(visibleA.counts, {
          business: 1,
          changes: 1,
          events: 1,
          invocations: 4,
          outbox: 1,
        });
        assert.deepEqual(visibleA.actorKinds, [
          'AGENT',
          'AUTOMATION',
          'HUMAN',
          'SYSTEM',
        ]);
        assert.equal(visibleA.tenantId, tenantA);
        assert.equal(visibleA.environmentId, environmentA);
        assert.equal(visibleA.principalId, agentA);
        await assertConnectionCleared(runtimePool, visibleA.backendPid);

        const visibleB = await readVisibleTrust(runtimePool, contexts.humanB);
        assert.deepEqual(visibleB.counts, {
          business: 1,
          changes: 1,
          events: 1,
          invocations: 1,
          outbox: 1,
        });
        assert.deepEqual(visibleB.actorKinds, ['HUMAN']);
        assert.equal(visibleB.tenantId, tenantB);
        assert.equal(visibleB.backendPid, visibleA.backendPid);
        await assertConnectionCleared(runtimePool, visibleA.backendPid);

        await assertAcceptedLinks(runtimePool, contexts.agentA, acceptedA);
        await assertRedactionAndChangeSemantics(
          runtimePool,
          contexts.agentA,
          acceptedA,
        );
        await assertForcedRls(pool);
        await assertAppendOnly(pool);
        assertProviderApiIsClosed();
      } finally {
        await runtimePool.end();
      }
    },
  );
});

interface IssuedContexts {
  agentA: TrustedRequestContext;
  automationA: TrustedRequestContext;
  humanA: TrustedRequestContext;
  humanB: TrustedRequestContext;
  systemA: TrustedRequestContext;
}

type IssuedEnvelopes = Record<keyof IssuedContexts, TrustedActorEnvelope>;

interface VisibleTrust {
  actorKinds: ActorKind[];
  backendPid: number;
  counts: {
    business: number;
    changes: number;
    events: number;
    invocations: number;
    outbox: number;
  };
  environmentId: string;
  principalId: string;
  tenantId: string;
}

async function issueContexts(): Promise<IssuedContexts> {
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const session = request.headers?.authorization;
    return typeof session === 'string'
      ? (identities.get(session) ?? null)
      : null;
  });
  const [
    humanAContext,
    agentAContext,
    automationAContext,
    systemAContext,
    humanBContext,
  ] = await Promise.all(
    ['human-a', 'agent-a', 'automation-a', 'system-a', 'human-b'].map(
      (authorization) => entry.enter({ headers: { authorization } }),
    ),
  );
  assert.ok(humanAContext);
  assert.ok(agentAContext);
  assert.ok(automationAContext);
  assert.ok(systemAContext);
  assert.ok(humanBContext);
  return {
    agentA: agentAContext,
    automationA: automationAContext,
    humanA: humanAContext,
    humanB: humanBContext,
    systemA: systemAContext,
  };
}

async function issueActorEnvelopes(
  contexts: IssuedContexts,
): Promise<IssuedEnvelopes> {
  const attributions = new Map<string, ResolvedActorAttribution>([
    [humanA, attribution('HUMAN', humanA)],
    [
      agentA,
      attribution('AGENT', agentA, {
        approvingHumanId: approverA,
        delegation: {
          delegatedTo: { kind: 'AGENT', principalId: agentA },
          delegatingPrincipal: { kind: 'HUMAN', principalId: humanA },
          delegationId: delegationA,
        },
        initiatingHumanId: humanA,
        subject: { kind: 'HUMAN', principalId: humanA },
      }),
    ],
    [automationA, attribution('AUTOMATION', automationA)],
    [systemA, attribution('SYSTEM', systemA)],
    [humanB, attribution('HUMAN', humanB)],
  ]);
  const issuer = new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      const resolved = attributions.get(context.principalId);
      if (!resolved) throw new Error('fixture attribution missing');
      return resolved;
    },
  });
  return {
    agentA: await issuer.issue(contexts.agentA),
    automationA: await issuer.issue(contexts.automationA),
    humanA: await issuer.issue(contexts.humanA),
    humanB: await issuer.issue(contexts.humanB),
    systemA: await issuer.issue(contexts.systemA),
  };
}

async function recordNonAcceptedEvidence(
  trust: PostgresTrustService,
  contexts: IssuedContexts,
  envelopes: IssuedEnvelopes,
): Promise<void> {
  await trust.recordNonAcceptedInvocation(
    contexts.humanA,
    envelopes.humanA,
    nonAcceptedCommand('1', 'DENIED', releaseA, releaseHashA),
  );
  await trust.recordNonAcceptedInvocation(
    contexts.automationA,
    envelopes.automationA,
    nonAcceptedCommand('2', 'FAILED', releaseA, releaseHashA),
  );
  await trust.recordNonAcceptedInvocation(
    contexts.systemA,
    envelopes.systemA,
    nonAcceptedCommand('3', 'TIMED_OUT', releaseA, releaseHashA),
  );
}

function acceptedCommand(
  prefix: 'a' | 'b' | 'c',
  releaseId: string,
  releaseContentHash: string,
): AcceptedMutationCommand {
  const ids = acceptedIds(prefix);
  return {
    actionId: 'fixture.master:create',
    causationId: null,
    change: {
      changeDocumentId: ids.changeDocumentId,
      changes: [
        {
          classification: 'PUBLIC',
          fieldId: 'displayName',
          newState: { state: 'VALUE', value: 'new fixture' },
          oldState: { state: 'VALUE', value: 'old fixture' },
        },
        {
          classification: 'INTERNAL',
          fieldId: 'optionalCode',
          newState: { state: 'VALUE', value: 'FIX-1' },
          oldState: { state: 'ABSENT' },
        },
        {
          classification: 'PUBLIC',
          fieldId: 'nickname',
          newState: { state: 'CLEARED' },
          oldState: { state: 'VALUE', value: 'old nickname' },
        },
        {
          classification: 'SENSITIVE',
          fieldId: 'personalContact',
          newState: { state: 'VALUE', value: sensitiveFixtureValue },
          oldState: { state: 'ABSENT' },
        },
        {
          classification: 'SECRET',
          fieldId: 'credentialMaterial',
          newState: { state: 'VALUE', value: secretFixtureValue },
          oldState: { state: 'VALUE', value: sensitiveFixtureValue },
        },
      ],
      recordId: `${prefix}-master-1`,
      recordType: 'fixture.master:record',
      revision: 1,
    },
    channel: prefix === 'a' || prefix === 'c' ? 'AGENT' : 'UI',
    correlationId: ids.correlationId,
    event: {
      eventId: ids.eventId,
      eventSchemaVersion: 'fixture.master-created/v1',
      eventType: 'fixture.master:created',
      payload: {
        credentialMaterial: {
          classification: 'SECRET',
          value: secretFixtureValue,
        },
        recordReference: {
          classification: 'INTERNAL',
          value: `${prefix}-master-1`,
        },
      },
    },
    invocationId: ids.invocationId,
    metadata: {
      credentialMaterial: {
        classification: 'SECRET',
        value: secretFixtureValue,
      },
      personalContact: {
        classification: 'SENSITIVE',
        value: sensitiveFixtureValue,
      },
      source: { classification: 'PUBLIC', value: 'provider-test' },
    },
    outbox: {
      deduplicationKey: `${prefix}:fixture.master:created:1`,
      outboxId: ids.outboxId,
    },
    policy: {
      decision: 'ALLOW',
      evaluatorVersion: 'fixture-evaluator/v1',
      policyVersion: 'fixture-policy/7',
      relevantInputs: {
        credentialMaterial: {
          classification: 'SECRET',
          value: secretFixtureValue,
        },
        permission: {
          classification: 'INTERNAL',
          value: 'fixture.master:create',
        },
      },
      schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
    },
    releaseContentHash,
    releaseId,
  };
}

function nonAcceptedCommand(
  suffix: string,
  outcome: 'DENIED' | 'FAILED' | 'TIMED_OUT',
  releaseId: string,
  releaseContentHash: string,
): NonAcceptedInvocationCommand {
  return {
    actionId: 'fixture.master:update',
    causationId: null,
    channel: 'API',
    correlationId: `d1000000-0000-4000-8000-00000000000${suffix}`,
    failureCode:
      outcome === 'DENIED'
        ? 'POLICY_DENIED'
        : outcome === 'FAILED'
          ? 'HANDLER_FAILED'
          : 'EXECUTION_TIMED_OUT',
    invocationId: `d2000000-0000-4000-8000-00000000000${suffix}`,
    metadata: {
      credentialMaterial: {
        classification: 'SECRET',
        value: secretFixtureValue,
      },
      phase: { classification: 'INTERNAL', value: 'execution' },
    },
    outcome,
    policy: {
      decision: outcome === 'DENIED' ? 'DENY' : 'ALLOW',
      evaluatorVersion: 'fixture-evaluator/v1',
      policyVersion: 'fixture-policy/7',
      relevantInputs: {
        personalContact: {
          classification: 'SENSITIVE',
          value: sensitiveFixtureValue,
        },
      },
      schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
    },
    releaseContentHash,
    releaseId,
  };
}

function acceptedIds(prefix: 'a' | 'b' | 'c'): {
  changeDocumentId: string;
  correlationId: string;
  eventId: string;
  invocationId: string;
  outboxId: string;
} {
  return {
    changeDocumentId: `${prefix}5000000-0000-4000-8000-000000000001`,
    correlationId: `${prefix}4000000-0000-4000-8000-000000000001`,
    eventId: `${prefix}6000000-0000-4000-8000-000000000001`,
    invocationId: `${prefix}7000000-0000-4000-8000-000000000001`,
    outboxId: `${prefix}8000000-0000-4000-8000-000000000001`,
  };
}

async function readVisibleTrust(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<VisibleTrust> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const state = await client.query<{
      backend_pid: number;
      environment_id: string;
      principal_id: string;
      tenant_id: string;
    }>(`
      SELECT pg_backend_pid() AS backend_pid,
             current_setting('north_star.tenant_id') AS tenant_id,
             current_setting('north_star.environment_id') AS environment_id,
             current_setting('north_star.principal_id') AS principal_id
    `);
    const counts = await client.query<{
      business: string;
      changes: string;
      events: string;
      invocations: string;
      outbox: string;
    }>(`
      SELECT
        (SELECT count(*) FROM platform.trust_test_business_records)::text AS business,
        (SELECT count(*) FROM platform.trust_business_change_documents)::text AS changes,
        (SELECT count(*) FROM platform.trust_domain_events)::text AS events,
        (SELECT count(*) FROM platform.trust_action_invocations)::text AS invocations,
        (SELECT count(*) FROM platform.trust_outbox)::text AS outbox
    `);
    const kinds = await client.query<{ execution_principal_kind: ActorKind }>(`
      SELECT DISTINCT execution_principal_kind
        FROM platform.trust_action_invocations
       ORDER BY execution_principal_kind
    `);
    const current = state.rows[0];
    const count = counts.rows[0];
    assert.ok(current);
    assert.ok(count);
    return {
      actorKinds: kinds.rows.map(
        ({ execution_principal_kind }) => execution_principal_kind,
      ),
      backendPid: current.backend_pid,
      counts: {
        business: Number(count.business),
        changes: Number(count.changes),
        events: Number(count.events),
        invocations: Number(count.invocations),
        outbox: Number(count.outbox),
      },
      environmentId: current.environment_id,
      principalId: current.principal_id,
      tenantId: current.tenant_id,
    };
  });
}

async function assertAcceptedLinks(
  pool: pg.Pool,
  context: TrustedRequestContext,
  command: AcceptedMutationCommand,
): Promise<void> {
  await withTrustedRequestTransaction(pool, context, async (client) => {
    const linked = await client.query<{ count: string }>(
      `SELECT count(*)
         FROM platform.trust_action_invocations invocation
         JOIN platform.trust_business_change_documents change
           ON change.tenant_id = invocation.tenant_id
          AND change.environment_id = invocation.environment_id
          AND change.invocation_id = invocation.invocation_id
          AND change.change_document_id = invocation.change_document_id
         JOIN platform.trust_domain_events event
           ON event.tenant_id = invocation.tenant_id
          AND event.environment_id = invocation.environment_id
          AND event.invocation_id = invocation.invocation_id
          AND event.domain_event_id = invocation.domain_event_id
          AND event.change_document_id = change.change_document_id
         JOIN platform.trust_outbox outbox
           ON outbox.tenant_id = invocation.tenant_id
          AND outbox.environment_id = invocation.environment_id
          AND outbox.invocation_id = invocation.invocation_id
          AND outbox.outbox_id = invocation.outbox_id
          AND outbox.change_document_id = change.change_document_id
          AND outbox.domain_event_id = event.domain_event_id
        WHERE invocation.invocation_id = $1
          AND invocation.outcome = 'SUCCEEDED'
          AND invocation.request_id = change.request_id
          AND invocation.request_id = event.request_id
          AND invocation.request_id = outbox.request_id
          AND invocation.action_id = change.action_id
          AND invocation.action_id = event.action_id
          AND invocation.action_id = outbox.action_id
          AND invocation.correlation_id = change.correlation_id
          AND invocation.correlation_id = event.correlation_id
          AND invocation.correlation_id = outbox.correlation_id`,
      [command.invocationId],
    );
    assert.equal(linked.rows[0]?.count, '1');

    const attribution = await client.query<{
      approving_human_id: string;
      delegated_to_principal_id: string;
      delegated_to_principal_kind: ActorKind;
      delegating_principal_id: string;
      delegating_principal_kind: ActorKind;
      delegation_id: string;
      execution_principal_id: string;
      execution_principal_kind: ActorKind;
      initiating_human_id: string;
      subject_principal_id: string;
      subject_principal_kind: ActorKind;
    }>(
      `SELECT approving_human_id,
              delegated_to_principal_id,
              delegated_to_principal_kind,
              delegating_principal_id,
              delegating_principal_kind,
              delegation_id,
              execution_principal_id,
              execution_principal_kind,
              initiating_human_id,
              subject_principal_id,
              subject_principal_kind
         FROM platform.trust_business_change_documents
        WHERE invocation_id = $1`,
      [command.invocationId],
    );
    assert.deepEqual(attribution.rows[0], {
      approving_human_id: approverA,
      delegated_to_principal_id: agentA,
      delegated_to_principal_kind: 'AGENT',
      delegating_principal_id: humanA,
      delegating_principal_kind: 'HUMAN',
      delegation_id: delegationA,
      execution_principal_id: agentA,
      execution_principal_kind: 'AGENT',
      initiating_human_id: humanA,
      subject_principal_id: humanA,
      subject_principal_kind: 'HUMAN',
    });
  });
}

async function assertRedactionAndChangeSemantics(
  pool: pg.Pool,
  context: TrustedRequestContext,
  command: AcceptedMutationCommand,
): Promise<void> {
  await withTrustedRequestTransaction(pool, context, async (client) => {
    const persisted = await client.query<{ evidence: string }>(`
      SELECT string_agg(evidence, ' ') AS evidence
        FROM (
          SELECT policy_inputs::text || ' ' || metadata::text AS evidence
            FROM platform.trust_action_invocations
          UNION ALL
          SELECT changes::text
            FROM platform.trust_business_change_documents
          UNION ALL
          SELECT payload::text
            FROM platform.trust_domain_events
        ) all_evidence
    `);
    const evidence = persisted.rows[0]?.evidence ?? '';
    assert.doesNotMatch(
      evidence,
      /g2-(?:secret|sensitive)-persistence-fixture/,
    );
    assert.match(evidence, /"classification": "SECRET"/);
    assert.match(evidence, /"representation": "REDACTED"/);

    const result = await client.query<{ changes: unknown }>(
      `SELECT changes
         FROM platform.trust_business_change_documents
        WHERE invocation_id = $1`,
      [command.invocationId],
    );
    const serialized = JSON.stringify(result.rows[0]?.changes);
    assert.match(serialized, /"state":"ABSENT"/);
    assert.match(serialized, /"state":"CLEARED"/);
    assert.match(serialized, /"representation":"VALUE"/);
    assert.match(serialized, /"representation":"REDACTED"/);
  });
}

async function assertForcedRls(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{
    force_row_level_security: boolean;
    relation: string;
    row_level_security: boolean;
  }>(`
    SELECT c.relname AS relation,
           c.relrowsecurity AS row_level_security,
           c.relforcerowsecurity AS force_row_level_security
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'platform'
       AND c.relname IN (
         'trust_action_invocations',
         'trust_business_change_documents',
         'trust_domain_events',
         'trust_outbox'
       )
     ORDER BY c.relname
  `);
  assert.equal(result.rows.length, 4);
  for (const row of result.rows) {
    assert.equal(row.row_level_security, true, row.relation);
    assert.equal(row.force_row_level_security, true, row.relation);
    const privileges = await pool.query<{
      can_delete: boolean;
      can_update: boolean;
    }>(
      `SELECT has_table_privilege('north_star_runtime', $1, 'DELETE') AS can_delete,
              has_table_privilege('north_star_runtime', $1, 'UPDATE') AS can_update`,
      [`platform.${row.relation}`],
    );
    assert.deepEqual(privileges.rows[0], {
      can_delete: false,
      can_update: false,
    });
  }
}

async function assertAppendOnly(pool: pg.Pool): Promise<void> {
  for (const relation of [
    'trust_action_invocations',
    'trust_business_change_documents',
    'trust_domain_events',
    'trust_outbox',
  ]) {
    const timestampColumn =
      relation === 'trust_domain_events' ? 'occurred_at' : 'recorded_at';
    await assert.rejects(
      pool.query(
        `UPDATE platform.${relation} SET ${timestampColumn} = clock_timestamp()`,
      ),
      /trust_immutable_write_guard_reject/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM platform.${relation}`),
      /trust_immutable_write_guard_reject/,
    );
  }
}

function assertProviderApiIsClosed(): void {
  assert.deepEqual(
    Object.getOwnPropertyNames(PostgresTrustService.prototype).toSorted(),
    ['constructor', 'executeAcceptedMutation', 'recordNonAcceptedInvocation'],
  );
  const source = readFileSync(
    resolve('packages/postgres-provider/src/trust/postgres-trust-service.ts'),
    'utf8',
  );
  assert.match(source, /await mutate\(client\)/);
  assert.match(source, /await insertOutbox/);
  assert.doesNotMatch(source, /(?:write|record)(?:Accepted|Success)Evidence/);
}

async function assertConnectionCleared(
  pool: pg.Pool,
  expectedBackendPid: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      backend_pid: number;
      environment_id: string | null;
      principal_id: string | null;
      request_id: string | null;
      tenant_id: string | null;
    }>(`
      SELECT pg_backend_pid() AS backend_pid,
             nullif(current_setting('north_star.tenant_id', true), '') AS tenant_id,
             nullif(current_setting('north_star.environment_id', true), '') AS environment_id,
             nullif(current_setting('north_star.principal_id', true), '') AS principal_id,
             nullif(current_setting('north_star.request_id', true), '') AS request_id
    `);
    assert.deepEqual(result.rows[0], {
      backend_pid: expectedBackendPid,
      environment_id: null,
      principal_id: null,
      request_id: null,
      tenant_id: null,
    });
  } finally {
    client.release();
  }
}

async function resetOutboxWitness(pool: pg.Pool): Promise<void> {
  await pool.query(
    "SELECT setval('platform.trust_test_outbox_insert_witness', 1, false)",
  );
}

async function createBusinessMutationFixture(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    CREATE TABLE platform.trust_test_business_records (
      tenant_id uuid NOT NULL,
      environment_id uuid NOT NULL,
      id uuid NOT NULL,
      label text NOT NULL,
      rollback_guard_tenant_id uuid NOT NULL,
      PRIMARY KEY (tenant_id, environment_id, id),
      FOREIGN KEY (tenant_id, environment_id)
        REFERENCES platform.environments (tenant_id, id),
      FOREIGN KEY (rollback_guard_tenant_id)
        REFERENCES platform.tenants (id)
        DEFERRABLE INITIALLY DEFERRED
    );
    ALTER TABLE platform.trust_test_business_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform.trust_test_business_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY trust_test_business_records_context
      ON platform.trust_test_business_records
      FOR ALL
      TO north_star_runtime
      USING (
        tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
        AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
        AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
      );
    GRANT SELECT, INSERT ON platform.trust_test_business_records TO north_star_runtime;

    CREATE SEQUENCE platform.trust_test_outbox_insert_witness;
    GRANT USAGE ON SEQUENCE platform.trust_test_outbox_insert_witness
      TO north_star_runtime;
    CREATE FUNCTION platform.record_trust_test_outbox_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      PERFORM nextval('platform.trust_test_outbox_insert_witness');
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER trust_test_outbox_inserted
      AFTER INSERT ON platform.trust_outbox
      FOR EACH ROW
      EXECUTE FUNCTION platform.record_trust_test_outbox_insert();
  `);
}

async function seedReleaseFixtures(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'trust-tenant-a'), ($2, 'trust-tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'), ($3, $4, 'production')`,
    [tenantA, environmentA, tenantB, environmentB],
  );
  await client.query(
    `INSERT INTO platform.app_package_revisions (
       tenant_id,
       revision_id,
       schema_version,
       language_version,
       normalization_profile_version,
       canonicalization_profile_version,
       hash_algorithm,
       content_hash,
       desired_state,
       provenance,
       created_by
     ) VALUES
       ($1, 'a2000000-0000-4000-8000-000000000001', 'v1', 'v0', 'v1', 'v1',
        'sha256', $2, decode('01', 'hex'), 'firstParty', $3),
       ($4, 'b2000000-0000-4000-8000-000000000001', 'v1', 'v0', 'v1', 'v1',
        'sha256', $5, decode('02', 'hex'), 'firstParty', $6)`,
    [tenantA, 'c'.repeat(64), humanA, tenantB, 'd'.repeat(64), humanB],
  );
  await client.query(
    `INSERT INTO platform.release_artifact_blobs (
       content_hash,
       artifact_kind,
       domain_tag,
       media_type,
       canonical_bytes,
       byte_length
     ) VALUES
       ($1, 'releaseManifest', 'trust-a',
        'application/vnd.northstar.canonical+json', decode('01', 'hex'), 1),
       ($2, 'releaseManifest', 'trust-b',
        'application/vnd.northstar.canonical+json', decode('02', 'hex'), 1)`,
    [releaseHashA, releaseHashB],
  );
  await client.query(
    `INSERT INTO platform.tenant_releases (
       tenant_id,
       environment_id,
       release_id,
       app_package_revision_id,
       compiler_version,
       compiler_semantic_profile_version,
       output_protocol_version,
       content_hash,
       compiler_attestation_digest,
       verification_evidence_id,
       created_by
     ) VALUES
       ($1, $2, $3, 'a2000000-0000-4000-8000-000000000001',
        'compiler/v1', 'profile/v1', 'protocol/v1', $4, $5,
        'a3100000-0000-4000-8000-000000000001', $6),
       ($7, $8, $9, 'b2000000-0000-4000-8000-000000000001',
        'compiler/v1', 'profile/v1', 'protocol/v1', $10, $11,
        'b3100000-0000-4000-8000-000000000001', $12)`,
    [
      tenantA,
      environmentA,
      releaseA,
      releaseHashA,
      'e'.repeat(64),
      humanA,
      tenantB,
      environmentB,
      releaseB,
      releaseHashB,
      'f'.repeat(64),
      humanB,
    ],
  );
}

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
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
