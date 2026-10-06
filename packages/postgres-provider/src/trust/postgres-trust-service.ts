import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import {
  ACTION_INVOCATION_VERSION,
  BUSINESS_CHANGE_DOCUMENT_VERSION,
  POLICY_DECISION_EVIDENCE_VERSION,
  TRUST_DOMAIN_EVENT_VERSION,
  TRUST_OUTBOX_VERSION,
  assertCanonicalId,
  assertNonBlank,
  assertUuid,
  redactBusinessChanges,
  redactEvidenceMetadata,
  type AcceptedMutationCommand,
  type ActorKind,
  type InvocationChannel,
  type IdempotentMutationBinding,
  type NonAcceptedInvocationCommand,
  type NonAcceptedInvocationOutcome,
  type PersistedBusinessFieldChange,
  type PersistedEvidenceMetadata,
  type ResolvedActorAttribution,
  type TrustedActorEnvelope,
} from '../../../platform-runtime/src/trust/contracts.js';
import { withTrustedRequestTransaction } from '../request-context.js';
import { assertTrustedActorEnvelope } from './trusted-actor-envelope.js';

export interface AcceptedMutationReceipt<TMutationResult> {
  readonly changeDocumentId: string;
  readonly correlationId: string;
  readonly domainEventId: string;
  readonly invocationId: string;
  readonly mutationResult: TMutationResult;
  readonly outboxId: string;
  readonly recordedAt: string;
}

export interface NonAcceptedInvocationReceipt {
  readonly correlationId: string;
  readonly invocationId: string;
  readonly outcome: NonAcceptedInvocationOutcome;
  readonly recordedAt: string;
}

export type BusinessMutation<TMutationResult> = (
  transaction: PoolClient,
) => Promise<TMutationResult>;

export type IdempotentBusinessMutation<TMutationResult> = (
  transaction: PoolClient,
) => Promise<{
  readonly command: AcceptedMutationCommand;
  readonly mutationResult: TMutationResult;
}>;

export class TrustEvidenceError extends Error {
  override readonly name = 'TrustEvidenceError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PreparedInvocation {
  actionId: string;
  causationId: string | null;
  channel: InvocationChannel;
  correlationId: string;
  invocationId: string;
  metadata: PersistedEvidenceMetadata;
  policyDecision: 'ALLOW' | 'DENY';
  policyEvaluatorVersion: string;
  policyInputs: PersistedEvidenceMetadata;
  policyVersion: string;
  releaseContentHash: string;
  releaseId: string;
}

interface InvocationLinks {
  changeDocumentId: string | null;
  domainEventId: string | null;
  outboxId: string | null;
}

interface RecordedInvocationRow {
  recorded_at: Date;
}

interface RecordedIdempotencyRow<TMutationResult> {
  change_document_id: string;
  correlation_id: string;
  domain_event_id: string;
  input_digest: string;
  invocation_id: string;
  mutation_result: TMutationResult;
  outbox_id: string;
  principal_id: string;
  recorded_at: Date;
}

interface ActorColumns {
  approvingHumanId: string | null;
  delegatedToKind: ActorKind | null;
  delegatedToPrincipalId: string | null;
  delegatingPrincipalId: string | null;
  delegatingPrincipalKind: ActorKind | null;
  delegationId: string | null;
  executionPrincipalId: string;
  executionPrincipalKind: ActorKind;
  initiatingHumanId: string | null;
  subjectPrincipalId: string | null;
  subjectPrincipalKind: ActorKind | null;
}

/**
 * Owns the transaction boundary for accepted mutations. Successful evidence
 * has no public standalone writer; non-accepted evidence cannot receive a
 * business mutation callback or create change/event/outbox rows.
 */
export class PostgresTrustService {
  constructor(private readonly pool: Pool) {}

  async executeAcceptedMutation<TMutationResult>(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: AcceptedMutationCommand,
    mutate: BusinessMutation<TMutationResult>,
  ): Promise<AcceptedMutationReceipt<TMutationResult>> {
    assertExecutionAuthority(context, actorEnvelope);
    const prepared = prepareInvocation(command, 'SUCCEEDED');
    if (prepared.policyDecision !== 'ALLOW') {
      throw new TrustEvidenceError(
        'ACCEPTED_MUTATION_POLICY_NOT_ALLOWED',
        'accepted mutation evidence requires an ALLOW policy decision',
      );
    }
    const changes = redactBusinessChanges(command.change.changes);
    validateAcceptedMutation(command);
    const eventPayload = redactEvidenceMetadata(command.event.payload);

    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      await assertPinnedRelease(client, context, prepared);
      const mutationResult = await mutate(client);
      return persistAcceptedEvidence(
        client,
        context,
        actorEnvelope,
        command,
        prepared,
        changes,
        eventPayload,
        mutationResult,
      );
    });
  }

  /**
   * The canonical input digest a request key is already recorded with, or
   * `null`. Read-only and outside the key's lock: a receipt is never updated
   * or deleted, so a digest read here is still the recorded one when
   * `executeIdempotentAcceptedMutation` re-reads it under the lock.
   */
  async recordedIdempotencyInputDigest(
    context: TrustedRequestContext,
    binding: IdempotentMutationBinding,
  ): Promise<string | null> {
    validateIdempotencyBinding(binding);
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const existing = await findIdempotencyReceipt(client, context, binding);
      return existing?.input_digest ?? null;
    });
  }

  async executeIdempotentAcceptedMutation<TMutationResult>(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    binding: IdempotentMutationBinding,
    mutate: IdempotentBusinessMutation<TMutationResult>,
    serializeBeforeIdempotency?: BusinessMutation<void>,
  ): Promise<AcceptedMutationReceipt<TMutationResult>> {
    assertExecutionAuthority(context, actorEnvelope);
    validateIdempotencyBinding(binding);
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      // Stock-affecting domain capabilities must establish the canonical stock
      // serializer before any request-key or row lock. Ordinary trust callers
      // omit this hook and retain the existing transaction order.
      await serializeBeforeIdempotency?.(client);
      await lockIdempotencyBinding(client, context, binding);
      const existing = await findIdempotencyReceipt<TMutationResult>(
        client,
        context,
        binding,
      );
      if (existing) {
        if (
          existing.principal_id.toLowerCase() !==
          context.principalId.toLowerCase()
        ) {
          throw new TrustEvidenceError(
            'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT',
            'idempotency key is already bound to another principal',
          );
        }
        if (existing.input_digest !== binding.inputDigest) {
          throw new TrustEvidenceError(
            'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT',
            'idempotency key is already bound to different canonical input',
          );
        }
        return Object.freeze({
          changeDocumentId: existing.change_document_id,
          correlationId: existing.correlation_id,
          domainEventId: existing.domain_event_id,
          invocationId: existing.invocation_id,
          mutationResult: existing.mutation_result,
          outboxId: existing.outbox_id,
          recordedAt: existing.recorded_at.toISOString(),
        });
      }
      await assertPinnedRelease(client, context, binding);
      const attempted = await mutate(client);
      assertCommandMatchesIdempotencyBinding(attempted.command, binding);
      const prepared = prepareInvocation(attempted.command, 'SUCCEEDED');
      const changes = redactBusinessChanges(attempted.command.change.changes);
      validateAcceptedMutation(attempted.command);
      const eventPayload = redactEvidenceMetadata(
        attempted.command.event.payload,
      );
      const receipt = await persistAcceptedEvidence(
        client,
        context,
        actorEnvelope,
        attempted.command,
        prepared,
        changes,
        eventPayload,
        attempted.mutationResult,
      );
      await insertIdempotencyReceipt(client, context, binding, receipt);
      return receipt;
    });
  }

  async recordNonAcceptedInvocation(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: NonAcceptedInvocationCommand,
  ): Promise<NonAcceptedInvocationReceipt> {
    assertExecutionAuthority(context, actorEnvelope);
    validateNonAcceptedOutcome(command.outcome);
    const prepared = prepareInvocation(command, command.outcome);
    assertFailureCode(command.failureCode);
    if (command.outcome === 'DENIED' && prepared.policyDecision !== 'DENY') {
      throw new TrustEvidenceError(
        'DENIAL_POLICY_EVIDENCE_INVALID',
        'denied invocation evidence requires a DENY policy decision',
      );
    }

    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      await assertPinnedRelease(client, context, prepared);
      const invocation = await insertInvocation(
        client,
        context,
        actorColumns(actorEnvelope.actor),
        prepared,
        command.outcome,
        command.failureCode,
        {
          changeDocumentId: null,
          domainEventId: null,
          outboxId: null,
        },
      );
      return Object.freeze({
        correlationId: command.correlationId,
        invocationId: command.invocationId,
        outcome: command.outcome,
        recordedAt: invocation.recorded_at.toISOString(),
      });
    });
  }
}

async function persistAcceptedEvidence<TMutationResult>(
  client: PoolClient,
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
  command: AcceptedMutationCommand,
  prepared: PreparedInvocation,
  changes: readonly PersistedBusinessFieldChange[],
  eventPayload: PersistedEvidenceMetadata,
  mutationResult: TMutationResult,
): Promise<AcceptedMutationReceipt<TMutationResult>> {
  const actor = actorColumns(actorEnvelope.actor);
  const invocation = await insertInvocation(
    client,
    context,
    actor,
    prepared,
    'SUCCEEDED',
    null,
    {
      changeDocumentId: command.change.changeDocumentId,
      domainEventId: command.event.eventId,
      outboxId: command.outbox.outboxId,
    },
  );
  await insertBusinessChangeDocument(
    client,
    context,
    actor,
    prepared,
    command,
    changes,
  );
  await insertDomainEvent(client, context, prepared, command, eventPayload);
  await insertOutbox(client, context, prepared, command);
  return Object.freeze({
    changeDocumentId: command.change.changeDocumentId,
    correlationId: prepared.correlationId,
    domainEventId: command.event.eventId,
    invocationId: prepared.invocationId,
    mutationResult,
    outboxId: command.outbox.outboxId,
    recordedAt: invocation.recorded_at.toISOString(),
  });
}

function validateIdempotencyBinding(binding: IdempotentMutationBinding): void {
  assertCanonicalId(binding.actionId, 'actionId');
  assertUuid(binding.idempotencyKey, 'idempotencyKey');
  assertUuid(binding.releaseId, 'releaseId');
  if (!/^[0-9a-f]{64}$/.test(binding.inputDigest)) {
    throw new TypeError('inputDigest must be a lowercase SHA-256 digest');
  }
  if (!/^[0-9a-f]{64}$/.test(binding.releaseContentHash)) {
    throw new TypeError(
      'releaseContentHash must be a lowercase SHA-256 digest',
    );
  }
}

function assertCommandMatchesIdempotencyBinding(
  command: AcceptedMutationCommand,
  binding: IdempotentMutationBinding,
): void {
  if (
    command.actionId !== binding.actionId ||
    command.releaseId !== binding.releaseId ||
    command.releaseContentHash !== binding.releaseContentHash
  ) {
    throw new TrustEvidenceError(
      'IDEMPOTENCY_EVIDENCE_BINDING_MISMATCH',
      'accepted mutation evidence does not match its idempotency binding',
    );
  }
}

async function lockIdempotencyBinding(
  client: PoolClient,
  context: TrustedRequestContext,
  binding: IdempotentMutationBinding,
): Promise<void> {
  const lockIdentity = [
    context.tenantId.toLowerCase(),
    context.environmentId.toLowerCase(),
    binding.actionId,
    binding.idempotencyKey.toLowerCase(),
  ].join('\u001f');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    lockIdentity,
  ]);
}

async function findIdempotencyReceipt<TMutationResult>(
  client: PoolClient,
  context: TrustedRequestContext,
  binding: IdempotentMutationBinding,
): Promise<RecordedIdempotencyRow<TMutationResult> | null> {
  const result = await client.query<RecordedIdempotencyRow<TMutationResult>>(
    `SELECT principal_id, input_digest, mutation_result, invocation_id, correlation_id,
            change_document_id, domain_event_id, outbox_id, recorded_at
       FROM platform.semantic_operation_receipts
      WHERE tenant_id = $1
        AND environment_id = $2
        AND action_id = $3
        AND idempotency_key = $4`,
    [
      context.tenantId,
      context.environmentId,
      binding.actionId,
      binding.idempotencyKey,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertIdempotencyReceipt<TMutationResult>(
  client: PoolClient,
  context: TrustedRequestContext,
  binding: IdempotentMutationBinding,
  receipt: AcceptedMutationReceipt<TMutationResult>,
): Promise<void> {
  const serialized = JSON.stringify(receipt.mutationResult);
  if (serialized === undefined) {
    throw new TypeError('idempotent mutation result must be JSON serializable');
  }
  await client.query(
    `INSERT INTO platform.semantic_operation_receipts (
       tenant_id, environment_id, principal_id, release_id,
       release_content_hash, action_id, idempotency_key, input_digest,
       mutation_result, invocation_id, correlation_id, change_document_id,
       domain_event_id, outbox_id, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
       $14, $15
     )`,
    [
      context.tenantId,
      context.environmentId,
      context.principalId,
      binding.releaseId,
      binding.releaseContentHash,
      binding.actionId,
      binding.idempotencyKey,
      binding.inputDigest,
      serialized,
      receipt.invocationId,
      receipt.correlationId,
      receipt.changeDocumentId,
      receipt.domainEventId,
      receipt.outboxId,
      receipt.recordedAt,
    ],
  );
}

function assertExecutionAuthority(
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
): void {
  assertTrustedRequestContext(context);
  assertTrustedActorEnvelope(actorEnvelope);
  if (
    actorEnvelope.tenantId !== context.tenantId ||
    actorEnvelope.environmentId !== context.environmentId ||
    actorEnvelope.requestId !== context.requestId ||
    actorEnvelope.principalId !== context.principalId ||
    actorEnvelope.actor.executionPrincipal.principalId !== context.principalId
  ) {
    throw new TrustEvidenceError(
      'TRUSTED_ACTOR_CONTEXT_MISMATCH',
      'trusted actor envelope does not belong to the issued request context',
    );
  }
}

function prepareInvocation(
  command: AcceptedMutationCommand | NonAcceptedInvocationCommand,
  outcome: 'SUCCEEDED' | NonAcceptedInvocationOutcome,
): PreparedInvocation {
  assertUuid(command.invocationId, 'invocationId');
  assertUuid(command.correlationId, 'correlationId');
  if (command.causationId !== null) {
    assertUuid(command.causationId, 'causationId');
  }
  assertUuid(command.releaseId, 'releaseId');
  assertCanonicalId(command.actionId, 'actionId');
  if (!isInvocationChannel(command.channel)) {
    throw new TypeError('channel is not supported');
  }
  if (!/^[0-9a-f]{64}$/.test(command.releaseContentHash)) {
    throw new TypeError(
      'releaseContentHash must be a lowercase SHA-256 digest',
    );
  }
  if (command.policy.schemaVersion !== POLICY_DECISION_EVIDENCE_VERSION) {
    throw new TypeError('policy decision evidence version is not supported');
  }
  if (
    command.policy.decision !== 'ALLOW' &&
    command.policy.decision !== 'DENY'
  ) {
    throw new TypeError('policy decision evidence has an invalid decision');
  }
  assertNonBlank(command.policy.policyVersion, 'policyVersion');
  assertNonBlank(command.policy.evaluatorVersion, 'evaluatorVersion');
  if (outcome === 'SUCCEEDED' && command.policy.decision !== 'ALLOW') {
    throw new TrustEvidenceError(
      'ACCEPTED_MUTATION_POLICY_NOT_ALLOWED',
      'accepted mutation evidence requires an ALLOW policy decision',
    );
  }
  return {
    actionId: command.actionId,
    causationId: command.causationId,
    channel: command.channel,
    correlationId: command.correlationId,
    invocationId: command.invocationId,
    metadata: redactEvidenceMetadata(command.metadata),
    policyDecision: command.policy.decision,
    policyEvaluatorVersion: command.policy.evaluatorVersion,
    policyInputs: redactEvidenceMetadata(command.policy.relevantInputs),
    policyVersion: command.policy.policyVersion,
    releaseContentHash: command.releaseContentHash,
    releaseId: command.releaseId,
  };
}

function validateAcceptedMutation(command: AcceptedMutationCommand): void {
  assertUuid(command.change.changeDocumentId, 'changeDocumentId');
  assertUuid(command.event.eventId, 'eventId');
  assertUuid(command.outbox.outboxId, 'outboxId');
  const factIds = new Set([
    command.invocationId,
    command.change.changeDocumentId,
    command.event.eventId,
    command.outbox.outboxId,
  ]);
  if (factIds.size !== 4) {
    throw new TypeError('accepted trust fact IDs must be distinct');
  }
  assertCanonicalId(command.change.recordType, 'recordType');
  assertNonBlank(command.change.recordId, 'recordId');
  if (
    !Number.isSafeInteger(command.change.revision) ||
    command.change.revision <= 0
  ) {
    throw new TypeError(
      'business change revision must be a positive safe integer',
    );
  }
  assertCanonicalId(command.event.eventType, 'eventType');
  assertNonBlank(command.event.eventSchemaVersion, 'eventSchemaVersion');
  assertNonBlank(command.outbox.deduplicationKey, 'deduplicationKey');
}

async function assertPinnedRelease(
  client: PoolClient,
  context: TrustedRequestContext,
  invocation: Pick<PreparedInvocation, 'releaseContentHash' | 'releaseId'>,
): Promise<void> {
  const result = await client.query<{ content_hash: string }>(
    `SELECT content_hash
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND release_id = $3`,
    [context.tenantId, context.environmentId, invocation.releaseId],
  );
  const release = result.rows[0];
  if (!release || release.content_hash !== invocation.releaseContentHash) {
    throw new TrustEvidenceError(
      'PINNED_RELEASE_EVIDENCE_MISMATCH',
      'trust evidence release does not match the tenant-scoped immutable release',
    );
  }
}

async function insertInvocation(
  client: PoolClient,
  context: TrustedRequestContext,
  actor: ActorColumns,
  invocation: PreparedInvocation,
  outcome: 'SUCCEEDED' | NonAcceptedInvocationOutcome,
  failureCode: string | null,
  links: InvocationLinks,
): Promise<RecordedInvocationRow> {
  const result = await client.query<RecordedInvocationRow>(
    `INSERT INTO platform.trust_action_invocations (
       tenant_id,
       environment_id,
       invocation_id,
       invocation_version,
       request_id,
       action_id,
       channel,
       outcome,
       correlation_id,
       causation_id,
       release_id,
       release_content_hash,
       execution_principal_kind,
       execution_principal_id,
       subject_principal_kind,
       subject_principal_id,
       initiating_human_id,
       approving_human_id,
       delegation_id,
       delegating_principal_kind,
       delegating_principal_id,
       delegated_to_principal_kind,
       delegated_to_principal_id,
       policy_evidence_version,
       policy_decision,
       policy_version,
       policy_evaluator_version,
       policy_inputs,
       metadata,
       failure_code,
       change_document_id,
       domain_event_id,
       outbox_id,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       $24, $25, $26, $27, $28::jsonb, $29::jsonb, $30, $31, $32,
       $33, clock_timestamp()
     )
     RETURNING recorded_at`,
    [
      context.tenantId,
      context.environmentId,
      invocation.invocationId,
      ACTION_INVOCATION_VERSION,
      context.requestId,
      invocation.actionId,
      invocation.channel,
      outcome,
      invocation.correlationId,
      invocation.causationId,
      invocation.releaseId,
      invocation.releaseContentHash,
      actor.executionPrincipalKind,
      actor.executionPrincipalId,
      actor.subjectPrincipalKind,
      actor.subjectPrincipalId,
      actor.initiatingHumanId,
      actor.approvingHumanId,
      actor.delegationId,
      actor.delegatingPrincipalKind,
      actor.delegatingPrincipalId,
      actor.delegatedToKind,
      actor.delegatedToPrincipalId,
      POLICY_DECISION_EVIDENCE_VERSION,
      invocation.policyDecision,
      invocation.policyVersion,
      invocation.policyEvaluatorVersion,
      JSON.stringify(invocation.policyInputs),
      JSON.stringify(invocation.metadata),
      failureCode,
      links.changeDocumentId,
      links.domainEventId,
      links.outboxId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('action invocation was not inserted');
  return row;
}

async function insertBusinessChangeDocument(
  client: PoolClient,
  context: TrustedRequestContext,
  actor: ActorColumns,
  invocation: PreparedInvocation,
  command: AcceptedMutationCommand,
  changes: readonly PersistedBusinessFieldChange[],
): Promise<void> {
  await client.query(
    `INSERT INTO platform.trust_business_change_documents (
       tenant_id,
       environment_id,
       change_document_id,
       document_version,
       invocation_id,
       invocation_outcome,
       request_id,
       action_id,
       correlation_id,
       release_id,
       release_content_hash,
       record_type,
       record_id,
       revision,
       changes,
       execution_principal_kind,
       execution_principal_id,
       subject_principal_kind,
       subject_principal_id,
       initiating_human_id,
       approving_human_id,
       delegation_id,
       delegating_principal_kind,
       delegating_principal_id,
       delegated_to_principal_kind,
       delegated_to_principal_id,
       domain_event_id,
       outbox_id,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'SUCCEEDED', $6, $7, $8, $9, $10,
       $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $26, $27, clock_timestamp()
     )`,
    [
      context.tenantId,
      context.environmentId,
      command.change.changeDocumentId,
      BUSINESS_CHANGE_DOCUMENT_VERSION,
      invocation.invocationId,
      context.requestId,
      invocation.actionId,
      invocation.correlationId,
      invocation.releaseId,
      invocation.releaseContentHash,
      command.change.recordType,
      command.change.recordId,
      command.change.revision,
      JSON.stringify(changes),
      actor.executionPrincipalKind,
      actor.executionPrincipalId,
      actor.subjectPrincipalKind,
      actor.subjectPrincipalId,
      actor.initiatingHumanId,
      actor.approvingHumanId,
      actor.delegationId,
      actor.delegatingPrincipalKind,
      actor.delegatingPrincipalId,
      actor.delegatedToKind,
      actor.delegatedToPrincipalId,
      command.event.eventId,
      command.outbox.outboxId,
    ],
  );
}

async function insertDomainEvent(
  client: PoolClient,
  context: TrustedRequestContext,
  invocation: PreparedInvocation,
  command: AcceptedMutationCommand,
  eventPayload: PersistedEvidenceMetadata,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.trust_domain_events (
       tenant_id,
       environment_id,
       domain_event_id,
       domain_event_version,
       invocation_id,
       invocation_outcome,
       change_document_id,
       request_id,
       action_id,
       correlation_id,
       release_id,
       release_content_hash,
       event_type,
       event_schema_version,
       payload,
       outbox_id,
       occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'SUCCEEDED', $6, $7, $8, $9, $10,
       $11, $12, $13, $14::jsonb, $15, clock_timestamp()
     )`,
    [
      context.tenantId,
      context.environmentId,
      command.event.eventId,
      TRUST_DOMAIN_EVENT_VERSION,
      invocation.invocationId,
      command.change.changeDocumentId,
      context.requestId,
      invocation.actionId,
      invocation.correlationId,
      invocation.releaseId,
      invocation.releaseContentHash,
      command.event.eventType,
      command.event.eventSchemaVersion,
      JSON.stringify(eventPayload),
      command.outbox.outboxId,
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  context: TrustedRequestContext,
  invocation: PreparedInvocation,
  command: AcceptedMutationCommand,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.trust_outbox (
       tenant_id,
       environment_id,
       outbox_id,
       outbox_version,
       invocation_id,
       invocation_outcome,
       change_document_id,
       domain_event_id,
       request_id,
       action_id,
       correlation_id,
       release_id,
       release_content_hash,
       event_type,
       event_schema_version,
       deduplication_key,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'SUCCEEDED', $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, clock_timestamp()
     )`,
    [
      context.tenantId,
      context.environmentId,
      command.outbox.outboxId,
      TRUST_OUTBOX_VERSION,
      invocation.invocationId,
      command.change.changeDocumentId,
      command.event.eventId,
      context.requestId,
      invocation.actionId,
      invocation.correlationId,
      invocation.releaseId,
      invocation.releaseContentHash,
      command.event.eventType,
      command.event.eventSchemaVersion,
      command.outbox.deduplicationKey,
    ],
  );
}

function actorColumns(actor: ResolvedActorAttribution): ActorColumns {
  return {
    approvingHumanId: actor.approvingHumanId,
    delegatedToKind: actor.delegation?.delegatedTo.kind ?? null,
    delegatedToPrincipalId: actor.delegation?.delegatedTo.principalId ?? null,
    delegatingPrincipalId:
      actor.delegation?.delegatingPrincipal.principalId ?? null,
    delegatingPrincipalKind: actor.delegation?.delegatingPrincipal.kind ?? null,
    delegationId: actor.delegation?.delegationId ?? null,
    executionPrincipalId: actor.executionPrincipal.principalId,
    executionPrincipalKind: actor.executionPrincipal.kind,
    initiatingHumanId: actor.initiatingHumanId,
    subjectPrincipalId: actor.subject?.principalId ?? null,
    subjectPrincipalKind: actor.subject?.kind ?? null,
  };
}

function validateNonAcceptedOutcome(
  outcome: NonAcceptedInvocationOutcome,
): void {
  if (outcome !== 'DENIED' && outcome !== 'FAILED' && outcome !== 'TIMED_OUT') {
    throw new TrustEvidenceError(
      'STANDALONE_SUCCESS_FORBIDDEN',
      'standalone invocation evidence accepts only denied, failed, or timed-out outcomes',
    );
  }
}

function assertFailureCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(value)) {
    throw new TypeError('failureCode must be a stable uppercase code');
  }
}

function isInvocationChannel(value: unknown): value is InvocationChannel {
  return (
    value === 'AGENT' ||
    value === 'API' ||
    value === 'IMPORT' ||
    value === 'SYSTEM' ||
    value === 'UI' ||
    value === 'WORKFLOW'
  );
}
