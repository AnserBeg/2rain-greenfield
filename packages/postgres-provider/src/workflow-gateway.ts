import {
  canonicalize,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '@north-star/runtime';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  authorizeCurrentPolicy,
  trustedContextForRequestRuntimeView,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import type { Pool } from 'pg';

import {
  MalformedSemanticOperationRequestError,
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
  PostgresSemanticQueryDenialRecorder,
} from './current-policy.js';
import {
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresRequestRuntimeViewService } from './request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';
import {
  sha256,
  WorkflowPermanentEffectFailure,
  WorkflowEffectRefusal,
  type WorkflowGateway,
  type WorkflowRunPin,
} from './workflow-execution.js';
import type { WorkflowCall } from './workflow-sdk.js';

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

  async withRemedyAuthority<T>(
    operator: TrustedRequestContext,
    work: () => Promise<T>,
  ): Promise<T> {
    return withTrustedRequestTransaction(
      this.pool,
      operator,
      async (client) => {
        await client.query(
          'SELECT * FROM platform.lock_release_activation_authority_epoch($1)',
          [operator.tenantId],
        );
        const { rows } = await client.query<{ eligible: boolean }>(
          `SELECT eligible FROM platform.release_approver_eligibility_events
           WHERE tenant_id = $1 AND principal_id = $2
           ORDER BY policy_version DESC LIMIT 1`,
          [operator.tenantId, operator.principalId],
        );
        if (!rows[0]?.eligible)
          throw new Error('Workflow remedy permission refused');
        return work();
      },
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
    const actorIssuer = new TrustedActorEnvelopeIssuer({
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
    });
    const interpreter = new PostgresModuleRuntimeInterpreter(
      this.pool,
      actorIssuer,
      [],
      undefined,
      undefined,
      { workflowRunId: run.run_id },
    );
    try {
      if (call.kind === 'query') {
        const definition = registeredSemanticQueryFromPinnedView(
          actor,
          call.id,
        );
        if (definition && 'readModel' in definition && definition.readModel)
          throw new WorkflowEffectRefusal('unsupported-read-model');
        const denialRecorder = new PostgresSemanticQueryDenialRecorder(
          this.pool,
          actorIssuer,
          this.pool,
          'WORKFLOW',
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
          await denialRecorder.recordDenied({
            context: trustedContextForRequestRuntimeView(actor),
            policyVersion: actor.entryPolicyVersion,
            queryId: call.id,
            view: actor,
          });
          throw new WorkflowEffectRefusal('query-company-scope-refused');
        }
        const gateway = new SemanticQueryGateway(
          intersection,
          interpreter,
          undefined,
          undefined,
          undefined,
          denialRecorder,
        );
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

      const operation = parsePinnedOperationCatalog(
        actor.projections.operation.payload,
      ).find((definition) => definition.operationId === call.id);
      const proof = run.unattended_operations[call.id];
      if (
        operation?.tier !== 'o0' ||
        operation.confirmation !== 'none' ||
        operation.effect.kind !== 'createRecordEffect' ||
        !operation.inputContract ||
        !proof ||
        proof.releaseRoot !== run.release_root ||
        proof.operationDigest !== sha256(canonicalize(operation)) ||
        proof.inputContractDigest !==
          sha256(canonicalize(operation.inputContract)) ||
        !Array.isArray(proof.reachableWriteEntities) ||
        proof.reachableWriteEntities.length !== 1 ||
        proof.reachableWriteEntities[0] !== operation.effect.entity.targetId ||
        !Array.isArray(proof.tierBIntersections) ||
        proof.tierBIntersections.length !== 0
      ) {
        throw new WorkflowEffectRefusal('confirmation-required');
      }
      const input = asObject(call.input);
      const denial =
        'legalEntityId' in input && input.legalEntityId !== run.legal_entity_id
          ? {
              code: 'WORKFLOW_OPERATION_COMPANY_SCOPE_REFUSED',
              reason: 'operation-company-scope-refused',
            }
          : 'relations' in input &&
              Object.values(asObject(input.relations)).some(
                (value) => value !== run.receipt_id,
              )
            ? {
                code: 'WORKFLOW_OPERATION_RECEIPT_LINK_REFUSED',
                reason: 'operation-receipt-link-refused',
              }
            : null;
      if (denial) {
        await interpreter.recordNonAccepted({
          channel: 'WORKFLOW',
          context: trustedContextForRequestRuntimeView(actor),
          failureCode: denial.code,
          operationId: call.id,
          outcome: 'DENIED',
          policyDecision: 'DENY',
          policyVersion: actor.entryPolicyVersion,
          view: actor,
        });
        throw new WorkflowEffectRefusal(denial.reason);
      }
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
          error.code === 'WORKFLOW_POLICY_CHANGED' ||
          error.code === 'WORKFLOW_RUN_NOT_RUNNABLE')
      )
        throw new WorkflowEffectRefusal(
          error.code === 'WORKFLOW_STALE_FENCE'
            ? 'stale-release-pin'
            : error.code === 'WORKFLOW_RUN_NOT_RUNNABLE'
              ? 'run-not-runnable'
              : 'current-policy-refused',
        );
      if (
        call.kind === 'operation' &&
        (error instanceof MalformedSemanticOperationRequestError ||
          (error instanceof ModuleRuntimeInterpreterError &&
            (error.code !== 'MODULE_PROVIDER_FAILURE' ||
              /^(22|23)/.test(error.providerMetadata?.sqlstate ?? ''))))
      )
        throw new WorkflowPermanentEffectFailure(error.code, { cause: error });
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
