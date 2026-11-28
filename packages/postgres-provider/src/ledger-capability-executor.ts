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
import { withTrustedRequestTransaction } from './request-context.js';
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
export const LEDGER_CHART_SETUP_CAPABILITY =
  'northstar.ledger:capability.ledger_chart_setup';
/** The post of a staged document (DOCUMENT-POSTING slice 1). */
export const LEDGER_GENERAL_LEDGER_CAPABILITY =
  'northstar.ledger:capability.general_ledger';

/**
 * The ledger's own permissions, checked in its SQL (`ledger_may`), as policy
 * bindings. A role granted an operation that reaches a ledger capability
 * receives that capability's grants in the same pass (`engineGrants`).
 * books_configure: books start, account put and chart setup (0074
 * `ledger_operation_access`).
 * journal_read: the journal reads (0071), reached by no operation until the
 * read queries of slice 1a-iv. journal_post: the document post (0077
 * `ledger_apply_document_post`), never books_configure.
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

export const LEDGER_JOURNAL_POST_GRANT = Object.freeze({
  action: 'post',
  permissionId: 'northstar.ledger:permission.journal_post',
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
  /**
   * What the operation targets: the company record itself, or a staged
   * document whose stored company the ledger reads (the post).
   */
  readonly target: 'company' | 'document';
}

const BOOKS_START: LedgerAction = Object.freeze({
  capabilityId: LEDGER_BOOKS_START_CAPABILITY,
  apply: 'platform.ledger_apply_books_start',
  argumentKeys: Object.freeze(['date', 'expectedPrior']),
  engineGrants: Object.freeze([LEDGER_BOOKS_CONFIGURE_GRANT]),
  target: 'company',
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
  target: 'company',
});

const CHART_SETUP: LedgerAction = Object.freeze({
  capabilityId: LEDGER_CHART_SETUP_CAPABILITY,
  apply: 'platform.ledger_apply_chart_setup',
  argumentKeys: Object.freeze(['starter', 'version', 'jurisdiction']),
  engineGrants: Object.freeze([LEDGER_BOOKS_CONFIGURE_GRANT]),
  target: 'company',
});

/**
 * The post of a staged document through the general document-posting binding
 * (DOCUMENT-POSTING slice 1): the target is the draft, the ledger resolves its
 * company, tables and columns from the released binding and storage plan.
 */
const DOCUMENT_POST: LedgerAction = Object.freeze({
  capabilityId: LEDGER_GENERAL_LEDGER_CAPABILITY,
  apply: 'platform.ledger_apply_document_post',
  argumentKeys: Object.freeze([]),
  engineGrants: Object.freeze([LEDGER_JOURNAL_POST_GRANT]),
  target: 'document',
});

function refused(reason = 'ledger.invalidOperation'): never {
  throw Object.assign(new Error(reason), {
    code: 'SEMANTIC_OPERATION_INPUT_INVALID',
  });
}

class LedgerCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId: string;
  readonly #prepared = new WeakMap<Authorization, Preparation>();
  /** The company each prepared authorization is scoped to. */
  readonly #companies = new WeakMap<Authorization, string>();
  constructor(
    private readonly service: PostgresCapabilityOperationExecutorContext,
    private readonly action: LedgerAction,
  ) {
    this.capabilityId = action.capabilityId;
  }

  async prepareAuthorization(request: Preparation): Promise<Authorization> {
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
      (this.action.argumentKeys.length === 0
        ? args !== undefined &&
          !(object(args) && Object.keys(args).length === 0)
        : !object(args) ||
          Object.keys(args).some(
            (key) => !this.action.argumentKeys.includes(key),
          ))
    )
      return refused();
    const record = input.recordId;
    // A company operation targets the company: policy scopes by it and the
    // ledger's SQL refuses it unless it is a live legal-entity record. A
    // document's company is its stored one, read through the ledger's
    // binding (missing, archived and foreign drafts are one refusal); the
    // apply re-derives it under the header lock.
    const company =
      this.action.target === 'company'
        ? record
        : await this.#documentCompany(request, record);
    const scope = request.readBackDefinition.legalEntityScope;
    if (
      this.action.target === 'document' &&
      (!scope || scope.cardinality !== 'exactlyOne')
    )
      return refused();
    const authorization: Authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId: company }),
      legalEntityReadScopeIds: Object.freeze([company]),
      readBackArguments: Object.freeze({
        recordId: record,
        ...(scope
          ? {
              [scope.operand.parameterId]:
                scope.cardinality === 'exactlyOne' ? company : [company],
            }
          : {}),
      }),
    });
    this.#prepared.set(authorization, request);
    this.#companies.set(authorization, company);
    return authorization;
  }

  async #documentCompany(
    request: Preparation,
    record: string,
  ): Promise<string> {
    const company = await withTrustedRequestTransaction(
      this.service.pool,
      request.context,
      async (client) =>
        (
          await client.query<{ company: string | null }>(
            'SELECT platform.ledger_document_company($1,$2,$3)::text AS company',
            [
              request.view.release.releaseId,
              request.definition.operationId,
              record,
            ],
          )
        ).rows[0]?.company ?? null,
    );
    return company && UUID.test(company)
      ? company
      : refused('ledger.unavailable');
  }

  async execute(request: Execution): Promise<SemanticOperationResultEnvelope> {
    const prepared = this.#prepared.get(request.authorization);
    const scopedCompany = this.#companies.get(request.authorization);
    this.#prepared.delete(request.authorization);
    this.#companies.delete(request.authorization);
    if (
      !prepared ||
      prepared.context !== request.context ||
      prepared.definition !== request.definition ||
      prepared.input !== request.input ||
      prepared.inputDigest !== request.inputDigest ||
      prepared.readBackDefinition !== request.readBackDefinition ||
      prepared.view !== request.view ||
      !object(request.input) ||
      !scopedCompany
    )
      return refused();
    // The record the change document is of: the company, or the document.
    const record = String(request.input.recordId);
    const company = scopedCompany;
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
          mutationResult: { recordId: record, applied },
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
              // The receipt check binds this to the grant's input.recordId.
              recordId: record,
              recordType: request.readBackDefinition.sourceEntityId,
              // A company operation: the company record's revision as the
              // apply read it under its lock, equal to the one confirmed. A
              // document post: the draft's revision after its state flip.
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
    let readBack: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const result = await this.service.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      readBack = result.records.find((row) => row.recordId === record) ?? null;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack,
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
  Object.freeze([
    ledgerFactory(BOOKS_START),
    ledgerFactory(ACCOUNT_PUT),
    ledgerFactory(CHART_SETUP),
    ledgerFactory(DOCUMENT_POST),
  ]);
