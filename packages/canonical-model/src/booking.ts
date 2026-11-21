import { z } from 'zod';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

export const BOOKING_CAPABILITY = 'northstar.booking:capability.commitments';
export const BOOKING_USAGE_CAPABILITY =
  'northstar.booking:capability.owner_usage';
export const BOOKING_USAGE_BINDING =
  'northstar.booking:protocol.owner_usage_v1';
export const BOOKING_USAGE_QUERY_READER = 5;
export const BOOKING_OPERATION_READER = 5;
export const BOOKING_FULFILMENT_READER = 6;
const id = z
  .string()
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );

/** Resolved inputs to a single operation in a booking slot. The immutable
 * release supplies the slot, both endpoint types, permissions and pack dials. */
const commitment = z.strictObject({
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
});
const fulfilment = commitment.extend({
  bindingVersion: z.literal('booking.fulfilment/v1'),
  operation: z.enum([
    'start',
    'return',
    'swap',
    'pause',
    'resume',
    'noShow',
    'changeQuantity',
    'correctActuals',
    'recordExisting',
  ]),
  stewardPermission: id,
  maxCorrectionAgeDays: z.int().nonnegative(),
});
const kit = commitment.extend({
  bindingVersion: z.literal('booking.kit/v1'),
  operation: z.enum(['hold', 'confirm', 'cancel']),
  memberOperations: z.array(id).min(1).max(20),
});
export const BookingOperationBinding = z
  .discriminatedUnion('bindingVersion', [commitment, fulfilment, kit])
  .refine((binding) => binding.kind !== 'unit' || binding.scale === 0)
  .refine(
    (binding) =>
      binding.operation !== 'setCapacity' ||
      (binding.kind === 'pool' &&
        binding.resourceEntity === binding.ownerEntity),
  );
export type BookingOperationBinding = z.infer<typeof BookingOperationBinding>;

export function bookingReaderFloor(value: unknown): number {
  const bindings = bookingCatalogTerms(value);
  if (!bindings.length) return 0;
  return bindings.some(
    ([, binding]) =>
      typeof binding === 'object' &&
      binding !== null &&
      'bindingVersion' in binding &&
      ['booking.fulfilment/v1', 'booking.kit/v1'].includes(
        String(binding.bindingVersion),
      ),
  )
    ? BOOKING_FULFILMENT_READER
    : BOOKING_OPERATION_READER;
}

export function hasBookingOperations(value: unknown): boolean {
  return bookingReaderFloor(value) > 0;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function bookingUsageCatalogTerms(value: unknown): unknown[] {
  if (!record(value) || !Array.isArray(value.queries)) return [];
  const queries = value.queries.filter(record);
  const terms = (q: Record<string, unknown>) => [
    q.queryId,
    q.queryType,
    q.tier,
    q.lifecycle,
    q.filter,
    record(q.permission) ? q.permission.targetId : q.permissionId,
    record(q.sourceEntity) ? q.sourceEntity.targetId : q.sourceEntityId,
  ];
  return queries.flatMap((q) => {
    const model = q.readModel;
    if (
      !record(model) ||
      !record(model.capability) ||
      model.capability.targetId !== BOOKING_USAGE_CAPABILITY
    )
      return [];
    const owner =
      record(model.queries) && record(model.queries.owner)
        ? model.queries.owner.targetId
        : undefined;
    const source = queries.find((candidate) => candidate.queryId === owner);
    return [[terms(q), model, source ? terms(source) : null]];
  });
}

export function hasBookingUsage(value: unknown): boolean {
  return bookingUsageCatalogTerms(value).length > 0;
}

/** The provider may use only the released entities and the read permissions
 * that their exact queries require. Admission also catches a misbound yes. */
export function bookingDeclarationProblem(
  pkg: VersionedNormalizedApplicationPackage,
): string | undefined {
  const configs = new Map<string, string>();
  for (const query of pkg.queries) {
    if (
      query.tier === 'q2' &&
      (!('readModel' in query) ||
        query.readModel?.capability.targetId !== BOOKING_USAGE_CAPABILITY)
    )
      return query.queryId;
    if (
      !('readModel' in query) ||
      query.readModel?.capability.targetId !== BOOKING_USAGE_CAPABILITY
    )
      continue;
    const model = query.readModel;
    const owner = pkg.queries.find(
      (q) => q.queryId === model.queries.owner?.targetId,
    );
    if (
      model.binding !== BOOKING_USAGE_BINDING ||
      !model.resultFields.usage ||
      Object.keys(model.resultFields).length !== 1 ||
      Object.keys(model.queries).length !== 1 ||
      query.queryType !== 'get' ||
      query.tier !== 'q2' ||
      query.lifecycle !== 'active' ||
      query.filter.kind !== 'booleanPredicate' ||
      !query.filter.value ||
      !owner ||
      owner.queryType !== 'get' ||
      owner.tier !== 'q0' ||
      owner.lifecycle !== 'active' ||
      ('readModel' in owner && owner.readModel) ||
      owner.filter.kind !== 'booleanPredicate' ||
      !owner.filter.value ||
      owner.sourceEntity.targetId !== query.sourceEntity.targetId ||
      owner.permission.targetId === query.permission.targetId ||
      !pkg.permissions.some(
        (p) =>
          p.permissionId === query.permission.targetId &&
          p.action === 'read' &&
          p.resource.targetId === query.sourceEntity.targetId &&
          p.lifecycle === 'active',
      ) ||
      !pkg.capabilityRequirements.some(
        (c) =>
          c.capabilityId === BOOKING_USAGE_CAPABILITY &&
          c.capabilityVersion === 1 &&
          c.lifecycle === 'active' &&
          c.supportStatus === 'supported',
      )
    )
      return query.queryId;
  }
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
    const permission = pkg.permissions.find(
      (entry) => entry.permissionId === operation.permission.targetId,
    );
    if (
      !permission ||
      permission.lifecycle !== 'active' ||
      permission.resource.targetId !== b.ownerEntity ||
      !['update', 'transition'].includes(permission.action)
    )
      return operation.operationId;
    if (b.bindingVersion === 'booking.kit/v1') {
      if (
        new Set(b.memberOperations).size !== b.memberOperations.length ||
        b.memberOperations.some((id) => {
          const member = pkg.operations.find((o) => o.operationId === id);
          return (
            !member ||
            member.lifecycle !== 'active' ||
            !('booking' in member) ||
            !member.booking ||
            member.booking.bindingVersion !== 'booking.commitment/v1' ||
            member.booking.operation !== b.operation
          );
        })
      )
        return operation.operationId;
    }
    if (b.bindingVersion === 'booking.fulfilment/v1') {
      const steward = pkg.permissions.find(
        (p) => p.permissionId === b.stewardPermission,
      );
      if (
        !steward ||
        steward.lifecycle !== 'active' ||
        steward.action !== 'transition' ||
        steward.resource.targetId !== b.ownerEntity ||
        (['correctActuals', 'recordExisting'].includes(b.operation)
          ? permission.permissionId !== steward.permissionId
          : permission.permissionId === steward.permissionId)
      )
        return operation.operationId;
      if (
        (b.operation === 'swap' && b.kind !== 'unit') ||
        (b.operation === 'changeQuantity' && b.kind !== 'pool')
      )
        return operation.operationId;
    }
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

export function bookingCatalogTerms(value: unknown): [unknown, unknown][] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('operations' in value) ||
    !Array.isArray(value.operations)
  )
    return [];
  return value.operations.flatMap<[unknown, unknown]>((op: unknown) =>
    op && typeof op === 'object' && 'operationId' in op && 'booking' in op
      ? [[op.operationId, op.booking]]
      : [],
  );
}
