import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

/**
 * GENERALIZE-1: a state-dependent write invariant. While a record of
 * `entityId` holds `guardedStateId` in `stateFieldId`, an ordinary update may
 * not change any of the `frozenFields`. The state field may itself be frozen,
 * which means "leave this state only through the owning capability's own
 * command".
 *
 * The capability that owns the record type declares it. The generic record
 * writer enforces it and names no module, entity or field: a stock count
 * freezing its counting mode, a work order freezing its crew while in
 * progress and a clinic visit freezing its practitioner once checked in are
 * the same declaration with different IDs.
 */
export interface StateDependentWriteInvariant {
  readonly entityId: string;
  readonly stateFieldId: string;
  readonly guardedStateId: string;
  /**
   * The invariant binds only records that carry this field. A record written
   * under an earlier definition that had no such field is exempt.
   */
  readonly appliesToRecordsWithFieldId: string;
  /** Checked in order; the first changed field refuses with its message. */
  readonly frozenFields: readonly Readonly<{
    fieldId: string;
    refusal: string;
  }>[];
}

/**
 * Capability-owned: resolves its declared invariants against one pinned
 * storage target. Product assembly supplies the providers; generic code never
 * constructs one.
 */
export interface ModuleWriteInvariantProvider {
  readonly providerId: string;
  bind(
    storage: StorageTargetPayloadV1,
  ): readonly StateDependentWriteInvariant[];
}

export const MODULE_WRITE_INVARIANT_REFUSAL_CODE =
  'MODULE_OPERATION_PRECONDITION_REFUSED' as const;

export function validatedWriteInvariantProviders(
  providers: readonly ModuleWriteInvariantProvider[],
): readonly ModuleWriteInvariantProvider[] {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (
      typeof provider.providerId !== 'string' ||
      provider.providerId.trim() === '' ||
      typeof provider.bind !== 'function'
    )
      throw new TypeError('module write invariant provider is invalid');
    if (seen.has(provider.providerId))
      throw new TypeError(
        `module write invariant provider is duplicated: ${provider.providerId}`,
      );
    seen.add(provider.providerId);
  }
  return Object.freeze([...providers]);
}

/** Every provider's invariants for one storage target, grouped by entity. */
export function bindWriteInvariants(
  providers: readonly ModuleWriteInvariantProvider[],
  storage: StorageTargetPayloadV1,
): ReadonlyMap<string, readonly StateDependentWriteInvariant[]> {
  const byEntity = new Map<string, StateDependentWriteInvariant[]>();
  for (const provider of providers) {
    for (const invariant of provider.bind(storage)) {
      const nonEmpty = (value: unknown) =>
        typeof value === 'string' && value.trim() !== '';
      if (
        !nonEmpty(invariant.entityId) ||
        !nonEmpty(invariant.stateFieldId) ||
        !nonEmpty(invariant.guardedStateId) ||
        !nonEmpty(invariant.appliesToRecordsWithFieldId) ||
        invariant.frozenFields.length === 0 ||
        invariant.frozenFields.some(
          (frozen) => !nonEmpty(frozen.fieldId) || !nonEmpty(frozen.refusal),
        )
      )
        throw new TypeError(
          `module write invariant is invalid: ${provider.providerId}`,
        );
      const list = byEntity.get(invariant.entityId) ?? [];
      list.push(Object.freeze({ ...invariant }));
      byEntity.set(invariant.entityId, list);
    }
  }
  return new Map(
    [...byEntity].map(([entityId, list]) => [entityId, Object.freeze(list)]),
  );
}

/**
 * The refusal an ordinary update earns, or null. `prior` is the stored image
 * and `patch` the caller's change; neither is trusted for the guard beyond
 * what the stored state says.
 */
export function stateWriteInvariantRefusal(
  invariants: readonly StateDependentWriteInvariant[],
  prior: Readonly<Record<string, ImmutableJsonValue>>,
  patch: Readonly<Record<string, ImmutableJsonValue>>,
): string | null {
  for (const invariant of invariants) {
    if (
      !Object.hasOwn(prior, invariant.appliesToRecordsWithFieldId) ||
      prior[invariant.stateFieldId] !== invariant.guardedStateId
    )
      continue;
    for (const { fieldId, refusal } of invariant.frozenFields) {
      if (Object.hasOwn(patch, fieldId) && patch[fieldId] !== prior[fieldId])
        return refusal;
    }
  }
  return null;
}
