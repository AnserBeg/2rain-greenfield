import { BOOKING_CAPABILITY } from '@north-star/canonical-model';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
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
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callKeys = {
  hold: ['resourceId', 'quantity', 'interval'],
  confirm: ['bookingId', 'bookingRevision'],
  cancel: ['bookingId', 'bookingRevision', 'reason'],
  changeInterval: ['bookingId', 'bookingRevision', 'interval'],
  setCapacity: ['resourceId', 'capacityRevision', 'quantity', 'reason'],
} as const;
function refused(reason = 'booking.endpointUnavailable'): never {
  throw Object.assign(new Error(reason), {
    code: 'SEMANTIC_OPERATION_INPUT_INVALID',
  });
}

class BookingCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = BOOKING_CAPABILITY;
  private readonly prepared = new WeakMap<Authorization, Preparation>();
  constructor(
    private readonly service: PostgresCapabilityOperationExecutorContext,
  ) {}

  async prepareAuthorization(request: Preparation): Promise<Authorization> {
    const { booking } = request.definition;
    const input = request.input;
    if (
      !booking ||
      !object(input) ||
      typeof input.recordId !== 'string' ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !object(input.arguments) ||
      request.readBackDefinition.sourceEntityId !== booking.ownerEntity ||
      request.readBackDefinition.queryType !== 'get' ||
      Object.keys(input.arguments).some(
        (key) =>
          !(callKeys[booking.operation] as readonly string[]).includes(key),
      )
    )
      return refused();
    const storage = this.service.projection(PROJECTION_FAMILY_IDS.storageTarget)
      .payload as StorageTargetPayloadV1;
    const entity = storage.entities.find(
      (entry) =>
        entry.entityId === booking.ownerEntity && entry.lifecycle === 'active',
    );
    if (!entity || !/^[a-z_][a-z0-9_]{0,62}$/u.test(entity.physicalTableName))
      return refused();
    const scope = await withTrustedRequestTransaction(
      this.service.pool,
      request.context,
      (client) =>
        withModuleRuntimeRole(client, async () => {
          const owner = await client.query<{ company: string | null }>(
            `SELECT ${entity.legalEntity ? 'legal_entity_id' : 'NULL::uuid'} AS company
           FROM north_star_module."${entity.physicalTableName}" WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
            [
              request.context.tenantId,
              request.context.environmentId,
              input.recordId,
            ],
          );
          return owner.rows[0] ?? refused();
        }),
    );
    const queryScope = request.readBackDefinition.legalEntityScope;
    if (Boolean(scope.company) !== Boolean(queryScope)) return refused();
    const authorization: Authorization = Object.freeze({
      decisionInput: scope.company
        ? { legalEntityId: scope.company }
        : Object.freeze({}),
      legalEntityReadScopeIds: scope.company ? [scope.company] : [],
      readBackArguments: {
        recordId: input.recordId,
        ...(queryScope && scope.company
          ? {
              [queryScope.operand.parameterId]:
                queryScope.cardinality === 'exactlyOne'
                  ? scope.company
                  : [scope.company],
            }
          : {}),
      },
    });
    this.prepared.set(authorization, request);
    return authorization;
  }

  async execute(request: Execution): Promise<SemanticOperationResultEnvelope> {
    const prepared = this.prepared.get(request.authorization);
    this.prepared.delete(request.authorization);
    if (
      !prepared ||
      prepared.context !== request.context ||
      prepared.view !== request.view ||
      prepared.definition !== request.definition ||
      prepared.input !== request.input ||
      prepared.inputDigest !== request.inputDigest ||
      prepared.readBackDefinition !== request.readBackDefinition ||
      !object(request.input) ||
      !object(request.input.arguments)
    )
      return refused();
    const input = request.input;
    const args = request.input.arguments;
    const actor = await this.service.actorIssuer.issue(request.context);
    const command = {
      ...args,
      recordId: input.recordId,
      expectedOwnerRevision: input.expectedRevision,
      expectedRevision: args.bookingRevision ?? args.capacityRevision ?? 0,
    };
    let verifiedGrantId: string | undefined;
    if (
      request.definition.confirmation === 'humanRequired' ||
      request.channel === 'WORKFLOW'
    ) {
      verifiedGrantId = this.service.verifyConfirmation?.(
        request.view,
        request.definition,
        request.input,
        request.confirmationGrant ?? null,
      );
      const human =
        actor.actor.approvingHumanId ??
        (actor.actor.executionPrincipal.kind === 'HUMAN'
          ? actor.actor.executionPrincipal.principalId
          : null);
      if (!this.service.approvalPool || !verifiedGrantId || !human)
        return refused('booking.approvalRequired');
      await this.service.approvalPool.query(
        'SELECT platform.attest_booking_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          verifiedGrantId,
          request.context.tenantId,
          request.context.environmentId,
          request.context.principalId,
          human,
          request.view.release.releaseId,
          request.view.pointer.fence,
          request.definition.operationId,
          request.idempotencyKey,
          command,
          request.channel,
        ],
      );
    }
    const result = await withTrustedRequestTransaction(
      this.service.pool,
      request.context,
      async (client) => {
        const response = await client.query<{
          result: {
            refused?: string;
            bookingId?: string;
            revision: number;
            state: string;
            deadline: string;
            resourceKey: string;
            changeDocumentId: string;
            domainEventId: string;
            invocationId: string;
            outboxId: string;
          };
        }>('SELECT platform.booking_apply($1,$2,$3,$4,$5,$6) AS result', [
          request.view.release.releaseId,
          request.view.pointer.fence,
          request.definition.operationId,
          request.idempotencyKey,
          command,
          {
            ...actor.actor,
            approvalGrantId: verifiedGrantId,
            requestId: actor.requestId,
            channel: request.channel,
            policyVersion: request.policyVersion,
          },
        ]);
        return response.rows[0]!.result;
      },
    );
    if (result.refused) return refused(result.refused);
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const read = await this.service.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      if (
        read.outcome !== 'exact' ||
        read.records[0]?.recordId !== input.recordId
      )
        return refused();
      record = read.records[0]!;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    const decision: Record<string, string | number> = {
      revision: result.revision,
    };
    if (result.bookingId) {
      Object.assign(decision, {
        bookingId: result.bookingId,
        state: result.state,
        deadline: result.deadline,
      });
    } else {
      decision.resourceKey = result.resourceKey;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      ...(record ? { capabilityResult: decision } : {}),
      trust: {
        changeDocumentId: result.changeDocumentId,
        domainEventId: result.domainEventId,
        invocationId: result.invocationId,
        outboxId: result.outboxId,
      },
      unsupportedReason: null,
    };
  }
}

export const BOOKING_CAPABILITY_EXECUTOR_FACTORY: PostgresCapabilityOperationExecutorFactory =
  {
    capabilityId: BOOKING_CAPABILITY,
    verificationRefusal: {
      code: 'SEMANTIC_OPERATION_INPUT_INVALID',
      reason: 'booking.endpointUnavailable',
    },
    create: (service) => new BookingCapabilityExecutor(service),
  };
