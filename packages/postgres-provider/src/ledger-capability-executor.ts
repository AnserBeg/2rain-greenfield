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
import type { CurrentPolicyPermissionBinding } from './current-policy.js';
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
export const LEDGER_ACCOUNT_PUT_CAPABILITY =
  'northstar.ledger:capability.ledger_account_put';

/**
 * The ledger's own permissions, checked in its SQL (`ledger_may`), as policy
 * bindings. A role granted an operation that reaches a ledger capability
 * receives that capability's grants in the same pass (`engineGrants`).
 * books_configure: books start and account put (0073
 * `ledger_operation_access`).
 * journal_read: the journal reads (0071), reached by no operation until the
 * read queries of slice 1a-iv. journal_post has no SQL check yet; its binding
 * is born with the post.
 */
export const LEDGER_BOOKS_CONFIGURE_GRANT = Object.freeze({
  action: 'configure',
  permissionId: 'northstar.ledger:permission.books_configure',
  resourceId: 'northstar.ledger:capability.books',
} as const satisfies CurrentPolicyPermissionBinding);

export const LEDGER_JOURNAL_READ_GRANT = Object.freeze({
  action: 'read',
  permissionId: 'northstar.ledger:permission.journal_read',
  resourceId: 'northstar.ledger:capability.journal',
} as const satisfies CurrentPolicyPermissionBinding);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface LedgerAction {
  readonly capabilityId: string;
  readonly apply: string;
  readonly argumentKeys: readonly string[];
  readonly engineGrants: readonly CurrentPolicyPermissionBinding[];
}

const BOOKS_START: LedgerAction = Object.freeze({
  capabilityId: LEDGER_BOOKS_START_CAPABILITY,
  apply: 'platform.ledger_apply_books_start',
  argumentKeys: Object.freeze(['date', 'expectedPrior']),
  engineGrants: Object.freeze([LEDGER_BOOKS_CONFIGURE_GRANT]),
});

const ACCOUNT_PUT: LedgerAction = Object.freeze({
  capabilityId: LEDGER_ACCOUNT_PUT_CAPABILITY,
  apply: 'platform.ledger_apply_account_put',
  argumentKeys: Object.freeze([
    'code',
    'kind',
    'label',
    'active',
    'expectedLabel',
    'expectedActive',
  ]),
  engineGrants: Object.freeze([LEDGER_BOOKS_CONFIGURE_GRANT]),
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
      'SELECT platform.ledger_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        grant,
        this.capabilityId,
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
      readonly applied: AppliedFacts;
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
        const applied = appliedFacts(
          (
            await client.query<{ result: unknown }>(
              `SELECT ${this.action.apply}($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
              [
                grant,
                request.view.release.releaseId,
                request.view.pointer.fence,
                request.definition.operationId,
                request.idempotencyKey,
                request.channel,
                request.policyVersion,
                JSON.stringify(request.input),
              ],
            )
          ).rows[0]?.result,
        );
        const invocationId = applied.invocationId;
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
              // The epoch the apply held locked; it refused unless the
              // gateway decided under the same one.
              policyVersion: applied.policyVersion,
              relevantInputs: metadata,
              schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
            },
            change: {
              changeDocumentId: randomUUID(),
              recordId: company,
              recordType: request.readBackDefinition.sourceEntityId,
              // The company record's revision as the apply read it, under
              // its lock, equal to the one the person confirmed against.
              revision: applied.revision,
              changes: applied.changes.map((change) => ({
                classification: 'INTERNAL' as const,
                fieldId: `northstar.ledger.fact.${change.fact}`,
                oldState: factState(change.old),
                newState: factState(change.new),
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

interface AppliedFacts {
  readonly invocationId: string;
  readonly policyVersion: string;
  readonly revision: number;
  readonly changes: readonly {
    readonly fact: string;
    readonly old: string | null;
    readonly new: string | null;
  }[];
}

/** The apply's result, refused unless it has exactly the evidence shape. */
function appliedFacts(value: unknown): AppliedFacts {
  const fact = (change: unknown) =>
    object(change) &&
    typeof change.fact === 'string' &&
    /^[a-z][A-Za-z0-9]*$/u.test(change.fact) &&
    (change.old === null || typeof change.old === 'string') &&
    (change.new === null || typeof change.new === 'string');
  if (
    !object(value) ||
    typeof value.invocationId !== 'string' ||
    !UUID.test(value.invocationId) ||
    typeof value.policyVersion !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    !value.changes.every(fact)
  )
    throw new Error('ledger apply returned an unexpected result');
  return value as unknown as AppliedFacts;
}

const factState = (value: string | null) =>
  value === null
    ? { state: 'ABSENT' as const }
    : { state: 'VALUE' as const, value };

const ledgerFactory = (
  action: LedgerAction,
): PostgresCapabilityOperationExecutorFactory =>
  Object.freeze({
    capabilityId: action.capabilityId,
    engineGrants: action.engineGrants,
    singleUseConfirmation: true,
    verificationRefusal: {
      code: 'SEMANTIC_OPERATION_INPUT_INVALID',
      reason: 'ledger.invalidOperation',
    },
    create: (service: PostgresCapabilityOperationExecutorContext) =>
      new LedgerCapabilityExecutor(service, action),
  });

export const LEDGER_CAPABILITY_EXECUTOR_FACTORIES: readonly PostgresCapabilityOperationExecutorFactory[] =
  Object.freeze([ledgerFactory(BOOKS_START), ledgerFactory(ACCOUNT_PUT)]);
