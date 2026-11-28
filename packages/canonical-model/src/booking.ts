import { z } from 'zod';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import {
  registerEngineFactProvider,
  type EngineFactDeclaration,
} from './engine-facts.js';
import {
  registerServiceUseProvider,
  SERVICE_USE_SNAPSHOT_VERSION,
  type ServiceUseProvider,
  type ServiceUseSnapshot,
} from './service-evidence.js';

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

// ---- Booking declares its commitment state as an engine fact ----

/**
 * ADR-0073 A1 engineFactChanged (WORKFLOW-3 s1b). A commitment's state is a
 * Booking fact, not a declared record machine. Every state change ends in one
 * of Booking's two history writers, which name it (migration
 * 0078_booking_engine_facts.sql): one occurrence per commitment and revision,
 * owned by the binding's owner record. A create (a new hold, or an import of a
 * confirmed or in-use commitment) is not a change and names nothing.
 */
export const BOOKING_COMMITMENT_STATE_FACT =
  'northstar.booking:fact.commitment-state';
export const BOOKING_COMMITMENT_SUBJECT = 'northstar.booking:entity.booking';
/** Stored state to value ID; the SQL emit maps the same seven states. */
export const BOOKING_COMMITMENT_VALUES = Object.freeze({
  hold: 'northstar.booking:value.hold',
  confirmed: 'northstar.booking:value.confirmed',
  inUse: 'northstar.booking:value.in-use',
  returned: 'northstar.booking:value.returned',
  completed: 'northstar.booking:value.completed',
  noShow: 'northstar.booking:value.no-show',
  cancelled: 'northstar.booking:value.cancelled',
});
type CommitmentState = keyof typeof BOOKING_COMMITMENT_VALUES;
const COMMITMENT_LABELS: Readonly<Record<CommitmentState, string>> = {
  hold: 'Hold',
  confirmed: 'Confirmed',
  inUse: 'In use',
  returned: 'Returned',
  completed: 'Completed',
  noShow: 'No-show',
  cancelled: 'Cancelled',
};
/**
 * Every move a Booking writer makes (0059/0062 booking_fulfil, booking_apply,
 * booking_apply_kit, booking_finalize_due, the hold expiry). Timer moves run
 * under the arming command's release, so a value any timer enters is refused
 * as a trigger (E3): cancelled, completed and no-show.
 */
const COMMITMENT_MOVES: readonly (readonly [
  CommitmentState,
  CommitmentState,
  'command' | 'timer',
])[] = [
  ['hold', 'confirmed', 'command'],
  ['hold', 'cancelled', 'command'],
  ['hold', 'cancelled', 'timer'],
  ['confirmed', 'cancelled', 'command'],
  ['confirmed', 'inUse', 'command'],
  ['confirmed', 'noShow', 'command'],
  ['confirmed', 'noShow', 'timer'],
  ['confirmed', 'completed', 'timer'],
  ['noShow', 'inUse', 'command'],
  ['inUse', 'returned', 'command'],
  ['completed', 'noShow', 'command'],
  ['noShow', 'completed', 'command'],
];

/** One commitment-state fact per owner type an active binding names. */
export function bookingEngineFacts(
  value: unknown,
): readonly EngineFactDeclaration[] {
  if (!record(value) || !Array.isArray(value.operations)) return [];
  const owners = new Set<string>();
  for (const operation of value.operations) {
    if (!record(operation) || operation.lifecycle === 'retired') continue;
    const parsed = BookingOperationBinding.safeParse(operation.booking);
    if (parsed.success && parsed.data.operation !== 'setCapacity')
      owners.add(parsed.data.ownerEntity);
  }
  const states = Object.keys(BOOKING_COMMITMENT_VALUES) as CommitmentState[];
  return [...owners].sort().map((ownerTypeId) => ({
    factId: BOOKING_COMMITMENT_STATE_FACT,
    subjectId: BOOKING_COMMITMENT_SUBJECT,
    ownerTypeId,
    values: states.map((state) => ({
      valueId: BOOKING_COMMITMENT_VALUES[state],
      label: COMMITMENT_LABELS[state],
    })),
    moves: COMMITMENT_MOVES.map(([from, to, via]) => ({
      from: BOOKING_COMMITMENT_VALUES[from],
      to: BOOKING_COMMITMENT_VALUES[to],
      via,
    })),
  }));
}

registerEngineFactProvider({
  provider: 'northstar.booking',
  declarations: bookingEngineFacts,
});

// ---- Booking implements the service-use evidence protocol ----

/** Booking stamps its decision clock in microseconds. The protocol carries
 * whole milliseconds, so every instant is truncated toward the past. The
 * truncation is monotone: Booking's no-overlap and pause-inside-use rules
 * still hold, and a sub-millisecond span becomes empty. */
export function truncateBookingInstant(value: string) {
  return new Date(value.replace(/(\.\d{3})\d+/u, '$1')).toISOString();
}
const bookingInstant = z.iso.datetime({ offset: true });
/** Validates a Booking instant, then truncates it. Canonical contracts only
 * validate (no schema transform), so the truncation is an explicit step. */
function effectiveInstant(value: unknown) {
  return truncateBookingInstant(bookingInstant.parse(value));
}
const ownerUsage = z.object({
  schemaVersion: z.literal('booking.ownerUsage/v1'),
  ownerRef: z.object({ entityId: z.string(), recordId: z.string() }),
  ownerScope: z.object({ kind: z.literal('company'), companyId: z.string() }),
  asOf: bookingInstant,
  cursor: z.string().regex(/^(0|[1-9]\d*)$/u),
  highWater: z.string(),
  hasMore: z.literal(false),
  changes: z.array(z.never()),
  bookings: z.array(
    z.object({
      bookingId: z.string(),
      slotId: z.string(),
      fulfilmentMode: z.string(),
      unit: z.string(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      bookingId: z.string(),
      revision: z.int().positive(),
      kind: z.enum(['use', 'pause', 'assignment', 'attendance']),
      voided: z.boolean(),
      effectiveStart: z.string(),
      effectiveEnd: z.string().nullable(),
      quantity: z.string().nullable(),
      unit: z.string().nullable(),
    }),
  ),
});

/** One engagement per booking. Each booking carries only its own unvoided
 * use and pause facts (a fact of another booking never joins it); assignment
 * and attendance facts are not use. A tracked booking reports actual use. */
export function bookingServiceUse(value: unknown): ServiceUseSnapshot {
  const usage = ownerUsage.parse(value);
  const facts = (bookingId: string, kind: 'use' | 'pause') =>
    usage.evidence.filter(
      (r) => r.bookingId === bookingId && !r.voided && r.kind === kind,
    );
  const span = (r: (typeof usage.evidence)[number]) => ({
    id: r.id,
    revision: String(r.revision),
    start: effectiveInstant(r.effectiveStart),
    end: r.effectiveEnd === null ? null : effectiveInstant(r.effectiveEnd),
  });
  return {
    schemaVersion: SERVICE_USE_SNAPSHOT_VERSION,
    owner: { ...usage.ownerRef, companyId: usage.ownerScope.companyId },
    asOf: effectiveInstant(usage.asOf),
    cursor: usage.cursor,
    complete: usage.cursor === usage.highWater,
    engagements: usage.bookings.map((b) => ({
      id: b.bookingId,
      subjectId: b.slotId,
      mode: b.fulfilmentMode === 'tracked' ? 'actual' : 'planned',
      unit: b.unit,
      legs: facts(b.bookingId, 'use').map((r) => ({
        ...span(r),
        quantity: r.quantity,
        unit: r.unit,
      })),
      pauses: facts(b.bookingId, 'pause').map(span),
    })),
  };
}

const bookingServiceUseProvider: ServiceUseProvider = {
  binding: BOOKING_USAGE_BINDING,
  resultKey: 'usage',
  // A subject is a tracked slot whose owner is the queried record type and
  // whose unit is the consumer's, at a scale the protocol's quantities carry.
  subjectProblem(pkg, query, subjectId, unit) {
    if (
      !('readModel' in query) ||
      query.readModel?.capability.targetId !== BOOKING_USAGE_CAPABILITY
    )
      return 'booking.usageCapabilityRequired';
    const declared = pkg.operations.some(
      (op) =>
        op.lifecycle === 'active' &&
        'booking' in op &&
        op.booking &&
        op.booking.slotId === subjectId &&
        op.booking.ownerEntity === query.sourceEntity.targetId &&
        op.booking.fulfilmentMode === 'tracked' &&
        op.booking.unit === unit &&
        op.booking.scale <= 9,
    );
    return declared ? undefined : 'booking.trackedSlotRequired';
  },
  window: (from, until) => ({ usage: { from, until } }),
  decode: bookingServiceUse,
};
registerServiceUseProvider(bookingServiceUseProvider);
