import { z } from 'zod';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

export const BOOKING_CAPABILITY = 'northstar.booking:capability.commitments';
export const BOOKING_OPERATION_READER = 5;
const id = z
  .string()
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );

/** Resolved inputs to a single operation in a booking slot. The immutable
 * release supplies the slot, both endpoint types, permissions and pack dials. */
export const BookingOperationBinding = z
  .strictObject({
    bindingVersion: z.literal('booking.commitment/v1'),
    declarationRevision: id,
    slotRevision: id,
    slotId: id,
    resourceEntity: id,
    ownerEntity: id,
    ownerReadPermission: id,
    resourceReadPermission: id,
    operation: z.enum([
      'hold',
      'confirm',
      'cancel',
      'changeInterval',
      'setCapacity',
    ]),
    kind: z.enum(['unit', 'pool']),
    fulfilmentMode: z.enum(['tracked', 'scheduled']),
    maxBackdateDays: z.int().min(0).max(31),
    holdSeconds: z.int().min(1).max(86400),
    unit: z.string().min(1).max(120),
    scale: z.int().min(0).max(18),
  })
  .refine((binding) => binding.kind !== 'unit' || binding.scale === 0)
  .refine(
    (binding) =>
      binding.operation !== 'setCapacity' ||
      (binding.kind === 'pool' &&
        binding.resourceEntity === binding.ownerEntity),
  );
export type BookingOperationBinding = z.infer<typeof BookingOperationBinding>;

export function hasBookingOperations(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operations' in value &&
    Array.isArray(value.operations) &&
    value.operations.some(
      (op: unknown) => typeof op === 'object' && op !== null && 'booking' in op,
    )
  );
}

/** The provider may use only the released entities and the read permissions
 * that their exact queries require. Admission also catches a misbound yes. */
export function bookingDeclarationProblem(
  pkg: VersionedNormalizedApplicationPackage,
): string | undefined {
  const configs = new Map<string, string>();
  for (const operation of pkg.operations) {
    const hasBinding =
      'booking' in operation && operation.booking !== undefined;
    const isPack =
      operation.effect.kind === 'registeredCapabilityEffect' &&
      operation.effect.capability.targetId === BOOKING_CAPABILITY;
    if (!hasBinding && !isPack) continue;
    const parsed = BookingOperationBinding.safeParse(
      hasBinding ? operation.booking : undefined,
    );
    if (!isPack || !parsed.success || pkg.languageVersion !== 'v6')
      return operation.operationId;
    const b = parsed.data;
    if (
      !pkg.capabilityRequirements.some(
        (req) =>
          req.capabilityId === BOOKING_CAPABILITY &&
          req.capabilityVersion === 1 &&
          req.lifecycle === 'active' &&
          req.supportStatus === 'supported' &&
          req.declaredEffects.includes('appendFact'),
      )
    )
      return operation.operationId;
    if (b.operation !== 'hold' && operation.confirmation !== 'humanRequired')
      return operation.operationId;
    const ownerQuery = pkg.queries.find(
      (q) => q.queryId === operation.readBack.targetId,
    );
    if (
      !ownerQuery ||
      ownerQuery.lifecycle !== 'active' ||
      ownerQuery.queryType !== 'get' ||
      ownerQuery.tier !== 'q0' ||
      ownerQuery.filter.kind !== 'booleanPredicate' ||
      !ownerQuery.filter.value ||
      ownerQuery.sourceEntity.targetId !== b.ownerEntity ||
      ownerQuery.permission.targetId !== b.ownerReadPermission
    )
      return operation.operationId;
    if (
      !pkg.queries.some(
        (q) =>
          q.lifecycle === 'active' &&
          q.queryType === 'get' &&
          q.tier === 'q0' &&
          q.filter.kind === 'booleanPredicate' &&
          q.filter.value &&
          q.sourceEntity.targetId === b.resourceEntity &&
          q.permission.targetId === b.resourceReadPermission,
      )
    )
      return operation.operationId;
    if (
      ![b.resourceEntity, b.ownerEntity].every((id) =>
        pkg.entities.some((e) => e.entityId === id && e.lifecycle === 'active'),
      )
    )
      return operation.operationId;
    // Rules on these operations acquire their own satisfying and refusing witnesses with Customize.
    if (
      operation.precondition.kind !== 'booleanPredicate' ||
      operation.precondition.value !== true ||
      pkg.formulaRules?.some((rule) =>
        rule.boundOperationIds.includes(operation.operationId),
      )
    )
      return operation.operationId;
    for (const [key, terms] of [
      [
        b.declarationRevision,
        [b.resourceEntity, b.kind, b.unit, b.scale, b.holdSeconds],
      ],
      [
        b.slotRevision,
        [b.ownerEntity, b.slotId, b.fulfilmentMode, b.maxBackdateDays],
      ],
    ] as const) {
      const value = JSON.stringify(terms);
      if (configs.has(key) && configs.get(key) !== value)
        return operation.operationId;
      configs.set(key, value);
    }
  }
  return undefined;
}

export function bookingCatalogTerms(value: unknown): unknown[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('operations' in value) ||
    !Array.isArray(value.operations)
  )
    return [];
  return value.operations.flatMap((op: unknown) =>
    op && typeof op === 'object' && 'operationId' in op && 'booking' in op
      ? [[op.operationId, op.booking]]
      : [],
  );
}
