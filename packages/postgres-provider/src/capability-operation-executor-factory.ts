import type { Pool } from 'pg';

import type { RegisteredCapabilityOperationExecutor } from '../../runtime/src/semantic-operation-gateway.js';
import type { SemanticQueryGateway } from '../../runtime/src/semantic-query-gateway.js';
import type { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

export interface PinnedCapabilityProjection {
  readonly contentHash: string;
  readonly payload: unknown;
}

export interface PostgresCapabilityOperationExecutorContext {
  readonly actorIssuer: TrustedActorEnvelopeIssuer;
  readonly currentInstant: () => string;
  readonly pool: Pool;
  readonly projection: (familyId: string) => PinnedCapabilityProjection;
  readonly queryGateway: SemanticQueryGateway;
  readonly releaseContentHash: string;
  readonly releaseId: string;
}

/** Product assembly supplies module-owned factories; generic code knows IDs only. */
export interface PostgresCapabilityOperationExecutorFactory {
  readonly capabilityId: string;
  create(
    context: PostgresCapabilityOperationExecutorContext,
  ): RegisteredCapabilityOperationExecutor;
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
