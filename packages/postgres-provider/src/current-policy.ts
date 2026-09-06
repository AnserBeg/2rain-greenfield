import {
  CURRENT_POLICY_DECISION_VERSION,
  LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
  trustedContextForCurrentPolicyDecision,
  trustedContextForCurrentPolicySubject,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
} from '@north-star/runtime/request-runtime-view';
import { OPERATION_BOUNDARY_PERMISSION_ID } from '../../runtime/src/semantic-operation-gateway.js';
import {
  QUERY_BOUNDARY_PERMISSION_ID,
  type SemanticQueryDenialRecorder,
} from '../../runtime/src/semantic-query-gateway.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  POLICY_DECISION_EVIDENCE_VERSION,
  type EvidenceMetadataInput,
} from '../../platform-runtime/src/trust/contracts.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import type { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

export const CURRENT_POLICY_EVALUATOR_VERSION =
  'northstar.postgres-current-policy/v1' as const;

export interface CurrentPolicyPermissionBinding {
  readonly action: string;
  readonly permissionId: string;
  readonly resourceId: string;
  readonly scopeMode?: 'membershipOnly' | 'resource';
}

export const CURRENT_POLICY_RUNTIME_BINDINGS = Object.freeze([
  Object.freeze({
    action: 'invoke',
    permissionId: QUERY_BOUNDARY_PERMISSION_ID,
    resourceId: 'northstar.runtime:gateway.semantic-query',
    scopeMode: 'membershipOnly',
  }),
  Object.freeze({
    action: 'invoke',
    permissionId: OPERATION_BOUNDARY_PERMISSION_ID,
    resourceId: 'northstar.runtime:gateway.semantic-operation',
    scopeMode: 'membershipOnly',
  }),
  Object.freeze({
    action: 'read',
    permissionId: LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
    resourceId: 'northstar.runtime:scope.legal-entity',
    scopeMode: 'resource',
  }),
] as const satisfies readonly CurrentPolicyPermissionBinding[]);

/**
 * Exact evaluator contracts required by the receiving extension. These are
 * independent of its business tables: when the declarations arrive, the
 * compiler verifies these same action/id/resource triples and the live
 * evaluator remains deny-by-default until an administrator grants them.
 */
export const RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS = Object.freeze([
  receiptBinding('archive', 'goods_receipt_archive', 'goods_receipt'),
  receiptBinding('create', 'goods_receipt_create', 'goods_receipt'),
  receiptBinding('archive', 'goods_receipt_line_archive', 'goods_receipt_line'),
  receiptBinding('create', 'goods_receipt_line_create', 'goods_receipt_line'),
  receiptBinding('read', 'goods_receipt_line_read', 'goods_receipt_line'),
  receiptBinding('restore', 'goods_receipt_line_restore', 'goods_receipt_line'),
  receiptBinding('update', 'goods_receipt_line_update', 'goods_receipt_line'),
  receiptBinding('transition', 'goods_receipt_post', 'goods_receipt'),
  receiptBinding('read', 'goods_receipt_read', 'goods_receipt'),
  receiptBinding('restore', 'goods_receipt_restore', 'goods_receipt'),
  receiptBinding('update', 'goods_receipt_update', 'goods_receipt'),
  receiptBinding(
    'transition',
    'purchase_order_line_amend',
    'purchase_order_line',
  ),
  receiptBinding(
    'read',
    'purchase_order_received_read',
    'purchase_order_received',
  ),
] as const satisfies readonly CurrentPolicyPermissionBinding[]);

export class CurrentPolicyBindingError extends Error {
  override readonly name = 'CurrentPolicyBindingError';
}

/** Live, deny-by-default authorization over explicit evaluator bindings. */
export class PostgresCurrentPolicyGateway implements CurrentPolicyGateway {
  readonly #bindings: ReadonlyMap<string, CurrentPolicyPermissionBinding>;

  constructor(
    private readonly pool: Pool,
    bindings: readonly CurrentPolicyPermissionBinding[],
  ) {
    const byId = new Map<string, CurrentPolicyPermissionBinding>();
    for (const binding of [...CURRENT_POLICY_RUNTIME_BINDINGS, ...bindings]) {
      if (
        !canonicalId(binding.permissionId) ||
        !canonicalId(binding.resourceId) ||
        binding.action.trim() === '' ||
        byId.has(binding.permissionId)
      ) {
        throw new CurrentPolicyBindingError(
          `current policy binding is invalid or duplicated: ${binding.permissionId}`,
        );
      }
      byId.set(binding.permissionId, Object.freeze({ ...binding }));
    }
    this.#bindings = byId;
  }

  async readCurrentVersion(subject: CurrentPolicySubject) {
    const context = trustedContextForCurrentPolicySubject(subject);
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{ policy_version: string }>(
        `SELECT COALESCE(
           (SELECT policy_version::text
              FROM platform.current_policy_epochs
             WHERE tenant_id = $1 AND environment_id = $2),
           '0'
         ) AS policy_version`,
        [context.tenantId, context.environmentId],
      );
      return Object.freeze({
        policyVersion: policyVersion(result.rows[0]?.policy_version),
      });
    });
  }

  async authorize(request: CurrentPolicyDecisionRequest) {
    const context = trustedContextForCurrentPolicyDecision(request);
    const binding = this.#bindings.get(request.permissionId);
    const scope = extractLegalEntityScope(request.decisionInput);
    if (!binding || scope.status === 'invalid') {
      return Object.freeze({
        decision: 'DENY' as const,
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: await this.#readVersion(context),
      });
    }

    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{
        grant_role_id: string | null;
        legal_entity_id: string | null;
        policy_version: string;
      }>(
        `WITH policy_version AS (
           SELECT COALESCE(
             (SELECT policy_version
                FROM platform.current_policy_epochs
               WHERE tenant_id = $1 AND environment_id = $2),
             0
           ) AS value
         )
         SELECT permission_grant.role_id AS grant_role_id,
                membership.legal_entity_id,
                policy_version.value::text AS policy_version
           FROM policy_version
           LEFT JOIN platform.current_policy_memberships AS membership
             ON membership.tenant_id = $1
            AND membership.environment_id = $2
            AND membership.principal_id = $3
            AND membership.revoked_at IS NULL
           LEFT JOIN platform.current_policy_roles AS role
             ON role.tenant_id = membership.tenant_id
            AND role.environment_id = membership.environment_id
            AND role.role_id = membership.role_id
            AND role.revoked_at IS NULL
           LEFT JOIN platform.current_policy_permission_grants AS permission_grant
             ON permission_grant.tenant_id = role.tenant_id
            AND permission_grant.environment_id = role.environment_id
            AND permission_grant.role_id = role.role_id
            AND permission_grant.permission_id = $4
            AND permission_grant.resource_id = $5
            AND permission_grant.revoked_at IS NULL`,
        [
          context.tenantId,
          context.environmentId,
          context.principalId,
          binding.permissionId,
          binding.resourceId,
        ],
      );
      const version = policyVersion(result.rows[0]?.policy_version);
      const memberships = result.rows
        .filter((row) => row.grant_role_id !== null)
        .map((row) => row.legal_entity_id?.toLowerCase() ?? null);
      const global = memberships.includes(null);
      const allowed =
        binding.scopeMode === 'membershipOnly'
          ? memberships.length > 0
          : scope.legalEntityIds.length === 0
            ? global
            : global ||
              scope.legalEntityIds.every((id) => memberships.includes(id));
      return Object.freeze({
        decision: allowed ? ('ALLOW' as const) : ('DENY' as const),
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: version,
      });
    });
  }

  async #readVersion(
    context: ReturnType<typeof trustedContextForCurrentPolicyDecision>,
  ): Promise<string> {
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{ policy_version: string }>(
        `SELECT COALESCE(
           (SELECT policy_version::text
              FROM platform.current_policy_epochs
             WHERE tenant_id = $1 AND environment_id = $2),
           '0'
         ) AS policy_version`,
        [context.tenantId, context.environmentId],
      );
      return policyVersion(result.rows[0]?.policy_version);
    });
  }
}

export class PostgresSemanticQueryDenialRecorder implements SemanticQueryDenialRecorder {
  readonly #trust: PostgresTrustService;

  constructor(
    pool: Pool,
    private readonly actorIssuer: TrustedActorEnvelopeIssuer,
  ) {
    this.#trust = new PostgresTrustService(pool);
  }

  async recordDenied(
    request: Parameters<SemanticQueryDenialRecorder['recordDenied']>[0],
  ) {
    const actor = await this.actorIssuer.issue(request.context);
    const metadata: EvidenceMetadataInput = Object.freeze({
      queryId: Object.freeze({
        classification: 'INTERNAL' as const,
        value: request.queryId,
      }),
      requestKind: Object.freeze({
        classification: 'INTERNAL' as const,
        value: 'semantic-query',
      }),
    });
    await this.#trust.recordNonAcceptedInvocation(
      request.context,
      actor,
      Object.freeze({
        actionId: request.queryId,
        causationId: null,
        channel: 'UI',
        correlationId: randomUUID(),
        failureCode: 'SEMANTIC_QUERY_POLICY_DENIED',
        invocationId: randomUUID(),
        metadata,
        outcome: 'DENIED',
        policy: Object.freeze({
          decision: 'DENY',
          evaluatorVersion: CURRENT_POLICY_EVALUATOR_VERSION,
          policyVersion: request.policyVersion,
          relevantInputs: metadata,
          schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
        }),
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      }),
    );
  }
}

export function currentPolicyBindingsFromPermissions(
  permissions: readonly Readonly<{
    action: string;
    permissionId: string;
    resource: { targetId: string };
  }>[],
): readonly CurrentPolicyPermissionBinding[] {
  return Object.freeze(
    permissions.map((permission) =>
      Object.freeze({
        action: permission.action,
        permissionId: permission.permissionId,
        resourceId: permission.resource.targetId,
      }),
    ),
  );
}

function receiptBinding(
  action: string,
  permission: string,
  resource: string,
): CurrentPolicyPermissionBinding {
  return Object.freeze({
    action,
    permissionId: `northstar.app:permission.${permission}`,
    resourceId: `northstar.app:entity.${resource}`,
    scopeMode: 'resource' as const,
  });
}

type ScopeResult =
  | { readonly legalEntityIds: readonly string[]; readonly status: 'valid' }
  | { readonly legalEntityIds: readonly []; readonly status: 'invalid' };

function extractLegalEntityScope(input: ImmutableJsonValue): ScopeResult {
  const candidates: string[] = [];
  let invalid = false;
  const visit = (value: ImmutableJsonValue, key: string | null): void => {
    if (invalid) return;
    const scopedKey =
      key === 'legalEntityId' ||
      key === 'legal_entity_id' ||
      key?.endsWith('_legal_entity_id') === true ||
      key?.endsWith('_legal_entity_scope') === true;
    if (scopedKey) {
      const values = Array.isArray(value) ? value : [value];
      if (
        values.length === 0 ||
        values.some((member) => typeof member !== 'string' || !uuid(member))
      ) {
        invalid = true;
        return;
      }
      candidates.push(
        ...(values as string[]).map((member) => member.toLowerCase()),
      );
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((member) => visit(member, null));
    } else if (isRecord(value)) {
      Object.entries(value).forEach(([memberKey, member]) =>
        visit(member, memberKey),
      );
    }
  };
  visit(input, null);
  if (invalid) return { legalEntityIds: [], status: 'invalid' };
  return {
    legalEntityIds: Object.freeze([...new Set(candidates)].sort()),
    status: 'valid',
  };
}

function policyVersion(value: string | undefined): string {
  return `northstar.current-policy/${value ?? '0'}`;
}

function canonicalId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(
    value,
  );
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, ImmutableJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
