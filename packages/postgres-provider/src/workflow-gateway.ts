import { parseNormalizedApplicationPackageJson } from '@north-star/canonical-model';
import { isTenantId } from '@north-star/customization';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '@north-star/runtime';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  authorizeCurrentPolicy,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import type { Pool } from 'pg';

import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  SemanticOperationPolicyDeniedError,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  CURRENT_POLICY_RUNTIME_BINDINGS,
  currentPolicyBindingsFromPermissions,
  PostgresCurrentPolicyGateway,
} from './current-policy.js';
import {
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresRequestRuntimeViewService } from './request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';
import {
  WorkflowEffectRefusal,
  type WorkflowGateway,
  type WorkflowRunPin,
} from './workflow-execution.js';
import type { WorkflowCall } from './workflow-sdk.js';

const GOODS_RECEIPT_ENTITY = 'northstar.app:entity.goods_receipt';

/** The worker gets only the same Semantic gateways a request would use. */
export class PostgresWorkflowGateway implements WorkflowGateway {
  readonly #loader: PostgresRequestRuntimeViewService;
  readonly #entryPolicy: PostgresCurrentPolicyGateway;

  constructor(private readonly pool: Pool) {
    this.#loader = new PostgresRequestRuntimeViewService(pool);
    this.#entryPolicy = new PostgresCurrentPolicyGateway(pool, []);
  }

  loadView(
    principal: Pick<
      TrustedRequestContext,
      'tenantId' | 'environmentId' | 'principalId'
    >,
  ): Promise<RequestRuntimeView> {
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => principal),
      this.#loader,
      this.#entryPolicy,
    );
    return entry.run({}, (view) => view);
  }

  async authorizeRemedy(operator: TrustedRequestContext): Promise<boolean> {
    return withTrustedRequestTransaction(
      this.pool,
      operator,
      async (client) =>
        (
          await client.query<{ eligible: boolean }>(
            `SELECT eligible FROM platform.release_approver_eligibility_events
          WHERE tenant_id = $1 AND principal_id = $2
            AND authority_policy_contract_version = 'northstar.release-approver-authority/v1'
          ORDER BY policy_version DESC LIMIT 1`,
            [operator.tenantId, operator.principalId],
          )
        ).rows[0]?.eligible === true,
    );
  }

  async dispatch(
    run: WorkflowRunPin,
    call: Extract<WorkflowCall, { kind: 'query' | 'operation' }>,
    idempotencyKey: string,
  ): Promise<ImmutableJsonValue> {
    const scope = {
      tenantId: run.tenant_id,
      environmentId: run.environment_id,
    };
    const [actor, approver] = await Promise.all([
      this.loadView({ ...scope, principalId: run.automation_principal_id }),
      this.loadView({ ...scope, principalId: run.approver_id }),
    ]);
    for (const view of [actor, approver]) {
      if (
        view.release.releaseId !== run.release_id ||
        view.release.contentHash !== run.release_root ||
        view.pointer.pointerId !== run.pointer_id ||
        String(view.pointer.fence) !== run.execution_fence
      ) {
        throw new WorkflowEffectRefusal('stale-release-pin');
      }
    }

    const bindings = await this.#loadBindings(actor, scope);
    const current = new PostgresCurrentPolicyGateway(this.pool, bindings);
    const byPermission = new Map(
      [...CURRENT_POLICY_RUNTIME_BINDINGS, ...bindings].map(
        (binding) => [binding.permissionId, binding] as const,
      ),
    );
    const intersection: CurrentPolicyGateway = {
      readCurrentVersion: (subject) => current.readCurrentVersion(subject),
      authorize: async (request) => {
        const binding = byPermission.get(request.permissionId);
        const input = asObject(call.input);
        // A company-scoped call was confined to the event company below.
        // A shared call requires a tenant-wide grant for the resource.
        const company =
          call.kind === 'query' || input.legalEntityId !== undefined
            ? run.legal_entity_id
            : null;
        const inSnapshot =
          binding &&
          run.approver_grants.some(
            ([permission, resource, scopeId]) =>
              permission === binding.permissionId &&
              resource === binding.resourceId &&
              (binding.scopeMode === 'membershipOnly' ||
                scopeId === null ||
                scopeId === company),
          );
        const actorDecision = await current.authorize(request);
        if (!inSnapshot || actorDecision.decision !== 'ALLOW')
          return { ...actorDecision, decision: 'DENY' };
        const human = await authorizeCurrentPolicy(
          current,
          approver,
          request.permissionId,
          request.decisionInput,
        );
        return {
          ...actorDecision,
          decision:
            human.decision === 'ALLOW' &&
            human.policyVersion === actorDecision.policyVersion
              ? 'ALLOW'
              : 'DENY',
        };
      },
    };
    const interpreter = new PostgresModuleRuntimeInterpreter(
      this.pool,
      new TrustedActorEnvelopeIssuer({
        async resolve(context) {
          if (context.principalId !== run.automation_principal_id)
            throw new Error('Workflow attribution principal mismatch');
          return {
            executionPrincipal: {
              kind: 'AUTOMATION',
              principalId: context.principalId,
            },
            subject: null,
            initiatingHumanId: null,
            approvingHumanId: null,
            delegation: null,
          };
        },
      }),
    );
    try {
      if (call.kind === 'query') {
        const definition = registeredSemanticQueryFromPinnedView(
          actor,
          call.id,
        );
        const company = definition?.legalEntityScope?.operand.parameterId;
        const selected = company && asObject(call.input)[company];
        if (
          !company ||
          (selected !== run.legal_entity_id &&
            !(
              Array.isArray(selected) &&
              selected.length === 1 &&
              selected[0] === run.legal_entity_id
            ))
        ) {
          throw new WorkflowEffectRefusal('query-company-scope-refused');
        }
        const gateway = new SemanticQueryGateway(intersection, interpreter);
        const request = {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: call.id,
          arguments: call.input,
        };
        const result =
          definition.queryType === 'aggregate'
            ? await gateway.invokeAggregate(actor, request)
            : await gateway.invoke(actor, request);
        return (
          'records' in result
            ? { outcome: result.outcome, records: result.records }
            : { outcome: result.outcome, value: result.value }
        ) as ImmutableJsonValue;
      }

      // This slice proves tenant-created records. A first-party entity, a
      // transition, an undeclared relation target, or a wider write requires
      // confirmation until its complete Tier B intersection has been proven.
      const operation = parsePinnedOperationCatalog(
        actor.projections.operation.payload,
      ).find((definition) => definition.operationId === call.id);
      if (
        operation?.tier !== 'o0' ||
        operation.confirmation !== 'none' ||
        operation.effect.kind !== 'createRecordEffect' ||
        !isTenantId(operation.effect.entity.targetId) ||
        !operation.inputContract ||
        operation.inputContract.assignedFields?.length ||
        operation.inputContract.relationInputs.some(
          (relation) => relation.targetEntityId !== GOODS_RECEIPT_ENTITY,
        )
      ) {
        throw new WorkflowEffectRefusal('confirmation-required');
      }
      const input = asObject(call.input);
      if (
        'legalEntityId' in input &&
        input.legalEntityId !== run.legal_entity_id
      )
        throw new WorkflowEffectRefusal('operation-company-scope-refused');
      if (
        'relations' in input &&
        Object.values(asObject(input.relations)).some(
          (value) => value !== run.receipt_id,
        )
      )
        throw new WorkflowEffectRefusal('operation-receipt-link-refused');
      const mediation = new SemanticOperationMediationAuthority();
      const gateway = new SemanticOperationGateway(
        intersection,
        interpreter,
        mediation,
      );
      const result = await gateway.invoke(
        actor,
        {
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          operationId: call.id,
          input: call.input,
          idempotencyKey,
          confirmationGrant: null,
        },
        mediation.issueInvocation(actor, 'WORKFLOW'),
      );
      return {
        outcome: result.outcome,
        readBack: result.readBack,
      } as ImmutableJsonValue;
    } catch (error) {
      if (
        error instanceof SemanticQueryPolicyDeniedError ||
        error instanceof SemanticOperationPolicyDeniedError
      )
        throw new WorkflowEffectRefusal('current-policy-refused');
      if (
        error instanceof ModuleRuntimeInterpreterError &&
        (error.code === 'WORKFLOW_STALE_FENCE' ||
          error.code === 'WORKFLOW_POLICY_CHANGED')
      )
        throw new WorkflowEffectRefusal(
          error.code === 'WORKFLOW_STALE_FENCE'
            ? 'stale-release-pin'
            : 'current-policy-refused',
        );
      throw error;
    }
  }

  async #loadBindings(
    view: RequestRuntimeView,
    scope: { tenantId: string; environmentId: string },
  ) {
    const context = await new AuthenticatedRequestEntryAdapter(async () => ({
      ...scope,
      principalId: view.principalId,
    })).enter({});
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const row = (
        await client.query<{ desired_state: Buffer }>(
          `SELECT revision.desired_state
           FROM platform.tenant_releases AS release
           JOIN platform.app_package_revisions AS revision
             ON revision.tenant_id = release.tenant_id AND revision.revision_id = release.app_package_revision_id
          WHERE release.tenant_id = $1 AND release.environment_id = $2
            AND release.release_id = $3 AND release.content_hash = $4`,
          [
            scope.tenantId,
            scope.environmentId,
            view.release.releaseId,
            view.release.contentHash,
          ],
        )
      ).rows[0];
      if (!row) throw new WorkflowEffectRefusal('unavailable-release-artifact');
      return currentPolicyBindingsFromPermissions(
        parseNormalizedApplicationPackageJson(row.desired_state).permissions,
      );
    });
  }
}

function asObject(
  value: ImmutableJsonValue | undefined,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Readonly<Record<string, ImmutableJsonValue>>;
  throw new WorkflowEffectRefusal('invalid-effect-input');
}
