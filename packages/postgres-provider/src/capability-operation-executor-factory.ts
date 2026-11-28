import type { Pool } from 'pg';

import {
  type RegisteredCapabilityOperationExecutor,
  SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import type { SemanticQueryGateway } from '../../runtime/src/semantic-query-gateway.js';
import type { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';
import type { CurrentPolicyPermissionBinding } from './current-policy.js';

export interface PinnedCapabilityProjection {
  readonly contentHash: string;
  readonly payload: unknown;
}

export interface PostgresCapabilityOperationExecutorContext {
  readonly approvalPool?: Pool;
  readonly verifyConfirmation?: SemanticOperationMediationAuthority['assertConfirmationGrant'];
  readonly actorIssuer: TrustedActorEnvelopeIssuer;
  readonly currentInstant: () => string;
  readonly pool: Pool;
  readonly projection: (familyId: string) => PinnedCapabilityProjection;
  readonly queryGateway: SemanticQueryGateway;
  readonly releaseContentHash: string;
  readonly releaseId: string;
}

export interface CapabilityVerificationRefusalExpectation {
  readonly code: string;
  readonly reason: string;
}

/** Product assembly supplies module-owned factories; generic code knows IDs only. */
export interface PostgresCapabilityOperationExecutorFactory {
  readonly capabilityId: string;
  readonly singleUseConfirmation?: boolean;
  readonly verificationRefusal: CapabilityVerificationRefusalExpectation;
  /**
   * Permissions the capability's own engine checks in its storage, beyond the
   * operation's declared permission. A role granted the permission of an
   * operation whose effect names this capability receives these too, in the
   * same grant pass (`capabilityEngineGrants`), so the engine's check and the
   * gateway's check read grants written together. Without one the engine
   * refuses; without the operation permission the gateway refuses.
   */
  readonly engineGrants?: readonly CurrentPolicyPermissionBinding[];
  create(
    context: PostgresCapabilityOperationExecutorContext,
  ): RegisteredCapabilityOperationExecutor;
}

export function capabilityMediationAuthority(
  factories: readonly PostgresCapabilityOperationExecutorFactory[],
) {
  return new SemanticOperationMediationAuthority(
    new Set(
      factories
        .filter((factory) => factory.singleUseConfirmation)
        .map((factory) => factory.capabilityId),
    ),
  );
}

export function createRegisteredCapabilityExecutors(
  factories: readonly PostgresCapabilityOperationExecutorFactory[],
  requiredCapabilityIds: ReadonlySet<string>,
  context: PostgresCapabilityOperationExecutorContext,
): readonly RegisteredCapabilityOperationExecutor[] {
  const seen = new Set<string>();
  const executors: RegisteredCapabilityOperationExecutor[] = [];
  for (const factory of factories) {
    if (seen.has(factory.capabilityId)) {
      throw new TypeError(
        `capability executor factory is duplicated: ${factory.capabilityId}`,
      );
    }
    seen.add(factory.capabilityId);
    if (!requiredCapabilityIds.has(factory.capabilityId)) continue;
    const executor = factory.create(context);
    if (executor.capabilityId !== factory.capabilityId) {
      throw new TypeError(
        `capability executor factory changed its registered identity: ${factory.capabilityId}`,
      );
    }
    executors.push(executor);
  }
  return Object.freeze(
    executors.toSorted((left, right) =>
      left.capabilityId.localeCompare(right.capabilityId),
    ),
  );
}

/** One projection reader for deciding which exact-ID factories are load-bearing. */
export function registeredCapabilityIdsFromOperationCatalog(
  value: unknown,
): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.operations)) {
    throw new TypeError('compiled operation catalog is invalid');
  }
  return new Set(
    value.operations.flatMap((operation) =>
      isRecord(operation) &&
      isRecord(operation.effect) &&
      operation.effect.kind === 'registeredCapabilityEffect' &&
      isRecord(operation.effect.capability) &&
      typeof operation.effect.capability.targetId === 'string'
        ? [operation.effect.capability.targetId]
        : [],
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CapabilityOperationReference {
  readonly lifecycle?: string;
  readonly permission: { readonly targetId: string };
  readonly effect: {
    readonly kind: string;
    readonly capability?: { readonly targetId: string };
  };
}

/**
 * The engine grants owed to a role that holds `held`: for every active
 * released operation whose effect is a registered capability and whose
 * declared permission the role holds, that capability's `engineGrants`, once
 * per permission. Keyed by capability and declared permission only, so it
 * names no module, entity or operation.
 */
export function capabilityEngineGrants(
  operations: readonly CapabilityOperationReference[],
  held: readonly CurrentPolicyPermissionBinding[],
  factories: readonly PostgresCapabilityOperationExecutorFactory[],
): CurrentPolicyPermissionBinding[] {
  const heldIds = new Set(held.map((binding) => binding.permissionId));
  const byCapability = new Map(
    factories.map((factory) => [factory.capabilityId, factory.engineGrants]),
  );
  const owed = new Map<string, CurrentPolicyPermissionBinding>();
  for (const operation of operations) {
    if (
      operation.lifecycle === 'retired' ||
      operation.effect.kind !== 'registeredCapabilityEffect' ||
      !heldIds.has(operation.permission.targetId)
    )
      continue;
    for (const grant of byCapability.get(
      operation.effect.capability?.targetId ?? '',
    ) ?? [])
      if (!heldIds.has(grant.permissionId)) owed.set(grant.permissionId, grant);
  }
  return [...owed.values()];
}
