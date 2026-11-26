import { randomUUID } from 'node:crypto';

import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorization as Authorization,
  type RegisteredCapabilityOperationAuthorizationRequest as Preparation,
  type RegisteredCapabilityOperationExecutionRequest as Execution,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';

/**
 * The ledger engine's confirmation-class operations (ADR-0093, ACCOUNTING-1
 * slice 1a-ii, ruling A). A person confirms through the gateway; this executor
 * verifies the gateway's grant, attests it through the approval-issuer pool,
 * and calls the ledger's apply definer, which consumes that exact grant once
 * and mints the trust invocation ID the general trust writer records in the
 * same transaction. The ledger's SQL holds every refusal; nothing here names a
 * declared application's record type or field.
 */
export const LEDGER_BOOKS_START_CAPABILITY =
  'northstar.ledger:capability.ledger_books_start';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface LedgerAction {
  readonly capabilityId: string;
  readonly apply: string;
  readonly argumentKeys: readonly string[];
}

const BOOKS_START: LedgerAction = Object.freeze({
  capabilityId: LEDGER_BOOKS_START_CAPABILITY,
  apply: 'platform.ledger_apply_books_start',
  argumentKeys: Object.freeze(['date', 'expectedPrior']),
});

function refused(reason = 'ledger.invalidOperation'): never {
  throw Object.assign(new Error(reason), {
    code: 'SEMANTIC_OPERATION_INPUT_INVALID',
  });
}

class LedgerCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId: string;
  readonly #prepared = new WeakMap<Authorization, Preparation>();
  constructor(
    private readonly service: PostgresCapabilityOperationExecutorContext,
    private readonly action: LedgerAction,
  ) {
    this.capabilityId = action.capabilityId;
  }

  prepareAuthorization(request: Preparation): Promise<Authorization> {
    const input = request.input;
    const args = object(input) ? input.arguments : undefined;
    if (
      request.definition.effect.capability.targetId !== this.capabilityId ||
      request.readBackDefinition.queryType !== 'get' ||
      !object(input) ||
      Object.keys(input).some(
        (key) => !['recordId', 'expectedRevision', 'arguments'].includes(key),
      ) ||
      typeof input.recordId !== 'string' ||
      !UUID.test(input.recordId) ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !object(args) ||
      Object.keys(args).some((key) => !this.action.argumentKeys.includes(key))
    )
      return refused();
    // The company is the target record. Policy scopes by it; the ledger's
    // SQL refuses it unless it is a live record of the legal-entity master.
    const company = input.recordId;
    const scope = request.readBackDefinition.legalEntityScope;
    const authorization: Authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId: company }),
      legalEntityReadScopeIds: Object.freeze([company]),
      readBackArguments: Object.freeze({
        recordId: company,
        ...(scope
          ? {
              [scope.operand.parameterId]:
                scope.cardinality === 'exactlyOne' ? company : [company],
            }
          : {}),
      }),
    });
    this.#prepared.set(authorization, request);
    return Promise.resolve(authorization);
  }

  async execute(request: Execution): Promise<SemanticOperationResultEnvelope> {
    const prepared = this.#prepared.get(request.authorization);
    this.#prepared.delete(request.authorization);
    if (
      !prepared ||
      prepared.context !== request.context ||
      prepared.definition !== request.definition ||
      prepared.input !== request.input ||
      prepared.inputDigest !== request.inputDigest ||
      prepared.readBackDefinition !== request.readBackDefinition ||
      prepared.view !== request.view ||
      !object(request.input)
    )
      return refused();
    const company = String(request.input.recordId);
    const revision = Number(request.input.expectedRevision);
    // The person's confirmation: the gateway grant, verified here and attested
    // for the ledger, which consumes it inside the apply.
    const grant = this.service.verifyConfirmation?.(
      request.view,
      request.definition,
      request.input,
      request.confirmationGrant ?? null,
    );
    const actor = await this.service.actorIssuer.issue(request.context);
    const human =
      actor.actor.approvingHumanId ??
      (actor.actor.executionPrincipal.kind === 'HUMAN'
        ? actor.actor.executionPrincipal.principalId
        : null);
    if (!this.service.approvalPool || !grant || !human)
      return refused('ledger.approvalRequired');
    await this.service.approvalPool.query(
      'SELECT platform.ledger_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        grant,
        request.context.tenantId,
        request.context.environmentId,
        request.context.principalId,
        human,
        request.view.release.releaseId,
        request.view.pointer.fence,
        request.definition.operationId,
        request.idempotencyKey,
        JSON.stringify(request.input),
        request.channel,
      ],
    );
    const trust = await new PostgresTrustService(
      this.service.pool,
    ).executeIdempotentAcceptedMutation<{
      readonly recordId: string;
      readonly applied: Readonly<Record<string, unknown>>;
    }>(
      request.context,
      actor,
      {
        actionId: request.definition.operationId,
        idempotencyKey: request.idempotencyKey,
        inputDigest: request.inputDigest,
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      },
      async (client) => {
        const applied = (
          await client.query<{ result: Record<string, unknown> }>(
            `SELECT ${this.action.apply}($1,$2,$3,$4,$5,$6,$7) AS result`,
            [
              grant,
              request.view.release.releaseId,
              request.view.pointer.fence,
              request.definition.operationId,
              request.idempotencyKey,
              request.channel,
              JSON.stringify(request.input),
            ],
          )
        ).rows[0]!.result;
        const invocationId = String(applied.invocationId);
        const metadata = {
          legalEntityId: {
            classification: 'INTERNAL' as const,
            value: company,
          },
          operationId: {
            classification: 'INTERNAL' as const,
            value: request.definition.operationId,
          },
        };
        return {
          mutationResult: { recordId: company, applied },
          command: {
            actionId: request.definition.operationId,
            causationId: null,
            channel: request.channel,
            correlationId: randomUUID(),
            // Minted by the ledger's apply, which verifies it at commit.
            invocationId,
            metadata,
            releaseContentHash: request.view.release.contentHash,
            releaseId: request.view.release.releaseId,
            policy: {
              decision: 'ALLOW' as const,
              evaluatorVersion: request.policyEvaluatorVersion,
              policyVersion: request.policyVersion,
              relevantInputs: metadata,
              schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
            },
            change: {
              changeDocumentId: randomUUID(),
              recordId: company,
              recordType: request.readBackDefinition.sourceEntityId,
              revision,
              changes: Object.entries(applied)
                .filter(([key]) => key !== 'invocationId' && key !== 'company')
                .map(([key, value]) => ({
                  classification: 'INTERNAL' as const,
                  fieldId: `northstar.ledger.fact.${key}`,
                  oldState: { state: 'ABSENT' as const },
                  newState:
                    value === null
                      ? { state: 'ABSENT' as const }
                      : { state: 'VALUE' as const, value: String(value) },
                })),
            },
            event: {
              eventId: randomUUID(),
              eventSchemaVersion: 'northstar.ledger.operation/v1',
              eventType: request.definition.operationId.replace(
                ':operation.',
                ':event.',
              ),
              payload: metadata,
            },
            outbox: {
              outboxId: randomUUID(),
              deduplicationKey: `${request.definition.operationId}:${request.context.principalId}:${request.idempotencyKey}`,
            },
          },
        };
      },
    );
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const result = await this.service.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      record = result.records.find((row) => row.recordId === company) ?? null;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      trust: {
        changeDocumentId: trust.changeDocumentId,
        domainEventId: trust.domainEventId,
        invocationId: trust.invocationId,
        outboxId: trust.outboxId,
      },
      unsupportedReason: null,
    };
  }
}

const ledgerFactory = (
  action: LedgerAction,
): PostgresCapabilityOperationExecutorFactory =>
  Object.freeze({
    capabilityId: action.capabilityId,
    singleUseConfirmation: true,
    verificationRefusal: {
      code: 'SEMANTIC_OPERATION_INPUT_INVALID',
      reason: 'ledger.invalidOperation',
    },
    create: (service: PostgresCapabilityOperationExecutorContext) =>
      new LedgerCapabilityExecutor(service, action),
  });

export const LEDGER_CAPABILITY_EXECUTOR_FACTORIES: readonly PostgresCapabilityOperationExecutorFactory[] =
  Object.freeze([ledgerFactory(BOOKS_START)]);
