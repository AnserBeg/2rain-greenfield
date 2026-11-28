import { z } from 'zod';

import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import type {
  OpenItemApplicationDeclaration,
  OpenItemDeclaration,
} from './open-item-schema.js';

/**
 * OPEN-ITEM-1: the order-free open-item core (design note v2 and its binding
 * read). Any record type takes the `openItem` role: a document a counterparty
 * owes or is owed, issued from a draft (numbered then, per company and
 * series, gap-free), with a stored total, applied and balance that only the
 * core writes. One application type (`openItemApplications`) records an
 * amount moved from a credit-side item to a debit-side item of the same
 * direction, so one shape covers a settlement against a charge, a credit
 * against a charge and a refund against a credit, receivable and payable
 * alike. A rental invoice, a clinic visit charge, a contractor bill, a
 * subscription credit and a hotel folio are each one declaration.
 *
 * The binder refuses by name what the core could not keep safe: a role field
 * that a generic create or update could write, a generic update, archive or
 * restore that is not draft-only, a generic transition on the item's machine,
 * a line relation that is not parent scoped, and an application across
 * directions. Omission emits nothing, so a release without the keys keeps the
 * bytes the preceding compiler produced.
 */
export const OPEN_ITEM_ISSUE_CAPABILITY =
  'northstar.openitem:capability.open_item_issue';
export const OPEN_ITEM_APPLY_CAPABILITY =
  'northstar.openitem:capability.open_item_apply';
/** The event every core operation emits. */
export const OPEN_ITEM_EVENT_SCHEMA_VERSION = 'northstar.open-item-event/v1';
// Operation catalog reader 9: an operation's open-item binding (assigned at
// merge; MIGRATION-RULE capability rung rule). It claims every reader below.
export const OPEN_ITEM_OPERATION_READER = 9;

export {
  openItemSchemas,
  type OpenItemApplicationDeclaration,
  type OpenItemDeclaration,
  type OpenItemStates,
} from './open-item-schema.js';

const ID =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const id = z.string().max(180).regex(ID);

/** One item type as the core reads it: field and relation IDs, no columns. */
const itemBinding = z.strictObject({
  entityId: id,
  direction: z.enum(['receivable', 'payable']),
  side: z.enum(['debit', 'credit']),
  counterpartyRelationId: id,
  currencyFieldId: id,
  numberFieldId: id,
  subtotalFieldId: id,
  totalFieldId: id,
  appliedFieldId: id,
  balanceFieldId: id,
  lines: z
    .strictObject({ entityId: id, relationId: id, amountFieldId: id })
    .optional(),
  amountFieldId: id.optional(),
  stateFieldId: id,
  states: z.strictObject({
    draft: id,
    open: id,
    partiallySettled: id,
    settled: id,
    void: id,
  }),
  number: z.strictObject({
    sequenceId: id,
    prefix: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/u),
    minimumDigits: z.int().min(1).max(12),
    start: z.int().min(1).max(1_000_000_000),
  }),
  scale: z.int().min(0).max(18),
});
export type OpenItemTypeBinding = z.infer<typeof itemBinding>;

/** The compiled key an issue or apply operation carries. */
export const OpenItemOperationBinding = z.discriminatedUnion('bindingVersion', [
  z.strictObject({
    bindingVersion: z.literal('openItem.issue/v1'),
    item: itemBinding,
  }),
  z.strictObject({
    bindingVersion: z.literal('openItem.apply/v1'),
    application: z.strictObject({
      entityId: id,
      sourceRelationId: id,
      targetRelationId: id,
      amountFieldId: id,
    }),
    source: itemBinding,
    target: itemBinding,
  }),
]);
export type OpenItemOperationBinding = z.infer<typeof OpenItemOperationBinding>;

export interface BoundOpenItems {
  readonly declared: boolean;
  /** The compiled binding by operation ID (issue and apply operations). */
  readonly operations: ReadonlyMap<string, OpenItemOperationBinding>;
  /** Core-written role fields by entity: out of every create and update. */
  readonly protectedFields: ReadonlyMap<string, ReadonlySet<string>>;
}

export type OpenItemsBinding =
  | { readonly status: 'bound'; readonly binding: BoundOpenItems }
  | {
      readonly status: 'refused';
      readonly path: string;
      readonly subjectId: string;
      readonly message: string;
    };

type PackageV6 = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;
type Field = PackageV6['fields'][number];
type Operation = PackageV6['operations'][number];

function declarationsOf(revision: VersionedNormalizedApplicationPackage): {
  readonly items: readonly OpenItemDeclaration[];
  readonly applications: readonly OpenItemApplicationDeclaration[];
} {
  if (revision.languageVersion !== 'v6') return { items: [], applications: [] };
  const v6 = revision as PackageV6 & {
    openItems?: readonly OpenItemDeclaration[];
    openItemApplications?: readonly OpenItemApplicationDeclaration[];
  };
  return {
    items: v6.openItems ?? [],
    applications: v6.openItemApplications ?? [],
  };
}

/** True when the revision declares any open-item key (the reader floor). */
export function declaresOpenItems(
  revision: VersionedNormalizedApplicationPackage,
): boolean {
  const { items, applications } = declarationsOf(revision);
  return items.length > 0 || applications.length > 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The precondition `state equals draft`, exactly. */
function draftOnly(
  precondition: unknown,
  stateFieldId: string,
  draft: string,
): boolean {
  return (
    isRecord(precondition) &&
    precondition.kind === 'fieldComparisonPredicate' &&
    precondition.operator === 'equals' &&
    isRecord(precondition.field) &&
    precondition.field.targetId === stateFieldId &&
    isRecord(precondition.value) &&
    precondition.value.kind === 'textValue' &&
    precondition.value.value === draft
  );
}

/**
 * Binds every open-item declaration of a revision. A revision without them
 * binds to an empty result, and nothing is emitted for it.
 */
export function bindOpenItems(
  revision: VersionedNormalizedApplicationPackage,
): OpenItemsBinding {
  const empty: BoundOpenItems = {
    declared: false,
    operations: new Map(),
    protectedFields: new Map(),
  };
  if (!declaresOpenItems(revision)) {
    // An open-item operation with no declaration would reach the core unbound.
    const stray = revision.operations.find(
      (operation) =>
        operation.lifecycle === 'active' &&
        operation.effect.kind === 'registeredCapabilityEffect' &&
        [OPEN_ITEM_ISSUE_CAPABILITY, OPEN_ITEM_APPLY_CAPABILITY].includes(
          operation.effect.capability.targetId,
        ),
    );
    return stray
      ? {
          status: 'refused',
          path: '$.operations',
          subjectId: stray.operationId,
          message:
            'An open-item operation is named by an open-item declaration.',
        }
      : { status: 'bound', binding: empty };
  }
  const v6 = revision as PackageV6 & {
    rollups?: readonly { readonly fieldId: string }[];
    derivedDecimals?: readonly { readonly fieldId: string }[];
    createOnlyFields?: readonly { readonly fieldId: string }[];
  };
  const { items, applications } = declarationsOf(revision);
  const refuse = (
    path: string,
    subjectId: string,
    message: string,
  ): OpenItemsBinding => ({ status: 'refused', path, subjectId, message });
  const entities = new Map<string, PackageV6['entities'][number]>(
    v6.entities.map((e) => [e.entityId, e]),
  );
  const fields = new Map<string, Field>(v6.fields.map((f) => [f.fieldId, f]));
  const relations = new Map<string, PackageV6['relations'][number]>(
    v6.relations.map((r) => [r.relationId, r]),
  );
  const queries = new Map<string, PackageV6['queries'][number]>(
    v6.queries.map((q) => [q.queryId, q]),
  );
  const operations = new Map<string, Operation>(
    v6.operations.map((o) => [o.operationId, o]),
  );
  const computed = new Set([
    ...(v6.rollups ?? []).map((r) => r.fieldId),
    ...(v6.derivedDecimals ?? []).map((d) => d.fieldId),
  ]);
  const createOnly = new Set((v6.createOnlyFields ?? []).map((c) => c.fieldId));
  const activeEntity = (entityId: string) => {
    const entity = entities.get(entityId);
    return entity && entity.lifecycle === 'active' ? entity : undefined;
  };
  const fieldOf = (entityId: string, fieldId: string | undefined) => {
    const field = fieldId === undefined ? undefined : fields.get(fieldId);
    return field &&
      field.entity.targetId === entityId &&
      field.lifecycle === 'active'
      ? field
      : undefined;
  };
  const scaleOf = (field: Field | undefined) =>
    field?.fieldType.kind === 'exactDecimalFieldType'
      ? field.fieldType.scale
      : null;
  const numberingOf = (field: Field) =>
    'numbering' in field
      ? (field.numbering as
          | {
              sequenceId: string;
              prefix: string;
              minimumDigits: number;
              start: number;
              assignOn?: { transitionId: string };
              scope?: string;
            }
          | undefined)
      : undefined;
  const capabilityOperation = (
    operationId: string,
    capabilityId: string,
    readEntityId: string,
  ) => {
    const operation = operations.get(operationId);
    if (
      !operation ||
      operation.lifecycle !== 'active' ||
      operation.tier !== 'o1' ||
      operation.effect.kind !== 'registeredCapabilityEffect' ||
      operation.effect.capability.targetId !== capabilityId ||
      operation.confirmation !== 'humanRequired'
    )
      return false;
    const readBack = queries.get(operation.readBack.targetId);
    return (
      readBack?.lifecycle === 'active' &&
      readBack.queryType === 'get' &&
      readBack.sourceEntity.targetId === readEntityId
    );
  };
  const entityOperations = (entityId: string) =>
    v6.operations.filter(
      (operation) =>
        operation.lifecycle === 'active' &&
        'entity' in operation.effect &&
        operation.effect.entity.targetId === entityId,
    );

  const bound = new Map<string, OpenItemTypeBinding>();
  const protectedFields = new Map<string, ReadonlySet<string>>();
  const operationBindings = new Map<string, OpenItemOperationBinding>();
  for (const item of items) {
    const path = '$.openItems';
    const subject = item.entityId;
    const entity = activeEntity(item.entityId);
    if (!entity)
      return refuse(path, subject, 'An open item is an active record type.');
    if (bound.has(item.entityId))
      return refuse(path, subject, 'Declare a record type an open item once.');
    if (
      !('companyOwnership' in entity) ||
      entity.companyOwnership !== 'entityOwned'
    )
      return refuse(
        path,
        subject,
        'An open item belongs to one company: its record type is company owned.',
      );
    // Money roles: one exact decimal scale for every amount of the item.
    const amountRoles = [
      ['subtotal', item.subtotalFieldId],
      ['total', item.totalFieldId],
      ['applied', item.appliedFieldId],
      ['balance', item.balanceFieldId],
      ...(item.amountFieldId ? [['amount', item.amountFieldId]] : []),
    ] as const;
    let scale: number | null = null;
    for (const [role, fieldId] of amountRoles) {
      const field = fieldOf(item.entityId, fieldId);
      const fieldScale = scaleOf(field);
      if (!field || fieldScale === null)
        return refuse(
          path,
          fieldId,
          `The ${role} role is an exact decimal field of the open item's record type.`,
        );
      if (scale !== null && fieldScale !== scale)
        return refuse(
          path,
          fieldId,
          "Every amount of an open item has the same scale.",
        );
      scale = fieldScale;
    }
    // The core writes these; a generic write would forge a figure.
    const written = [
      item.numberFieldId,
      item.subtotalFieldId,
      item.totalFieldId,
      item.appliedFieldId,
      item.balanceFieldId,
    ];
    if (new Set([...written, item.amountFieldId]).size !== written.length + 1)
      return refuse(path, subject, 'Each open-item role is its own field.');
    for (const fieldId of written) {
      const field = fieldOf(item.entityId, fieldId);
      if (!field)
        return refuse(path, fieldId, 'A role field belongs to the open item.');
      if (computed.has(fieldId))
        return refuse(
          path,
          fieldId,
          'The core writes this figure when the item is issued; it is not a total or derived value read from lines.',
        );
      if (field.presence === 'required')
        return refuse(
          path,
          fieldId,
          'A figure the core writes is absent on a draft, so the field is optional.',
        );
    }
    const currency = fieldOf(item.entityId, item.currencyFieldId);
    if (!currency || currency.fieldType.kind !== 'textFieldType')
      return refuse(
        path,
        item.currencyFieldId,
        "The currency role is a text field of the open item's record type.",
      );
    if (!createOnly.has(item.currencyFieldId))
      return refuse(
        path,
        item.currencyFieldId,
        "An open item's currency is fixed at creation: declare it create-only.",
      );
    for (const [role, fieldId] of [
      ['document date', item.documentDateFieldId],
      ['due date', item.dueDateFieldId],
    ] as const)
      if (
        fieldId !== undefined &&
        fieldOf(item.entityId, fieldId)?.fieldType.kind !== 'dateFieldType'
      )
        return refuse(
          path,
          fieldId,
          `The ${role} role is a date field of the open item.`,
        );
    const counterparty = relations.get(item.counterpartyRelationId);
    if (
      !counterparty ||
      counterparty.lifecycle !== 'active' ||
      counterparty.sourceEntity.targetId !== item.entityId ||
      counterparty.cardinality !== 'manyToOne' ||
      !counterparty.required
    )
      return refuse(
        path,
        item.counterpartyRelationId,
        'The counterparty is a required link from the open item to one record.',
      );
    // Exactly one amount source: lines, or an entered amount.
    if ((item.lines === undefined) === (item.amountFieldId === undefined))
      return refuse(
        path,
        subject,
        'An open item totals its lines or copies its entered amount: declare exactly one.',
      );
    let lines: OpenItemTypeBinding['lines'];
    if (item.lines) {
      const relation = relations.get(item.lines.relationId);
      if (
        !relation ||
        relation.lifecycle !== 'active' ||
        relation.targetEntity.targetId !== item.entityId ||
        relation.ownership !== 'parentScopedChild'
      )
        return refuse(
          path,
          item.lines.relationId,
          'Lines are parent-scoped children of the open item, so the draft-only header guard freezes them at issue.',
        );
      const lineEntity = relation.sourceEntity.targetId;
      const amount = fieldOf(lineEntity, item.lines.amountFieldId);
      if (scaleOf(amount) !== scale)
        return refuse(
          path,
          item.lines.amountFieldId,
          "A line amount is an exact decimal of the line type, at the item's scale.",
        );
      lines = {
        entityId: lineEntity,
        relationId: item.lines.relationId,
        amountFieldId: item.lines.amountFieldId,
      };
    }
    // The state map over the item's machine.
    const machine = v6.stateMachines.find(
      (candidate) => candidate.machineId === item.states.machineId,
    );
    const states = [
      item.states.draft,
      item.states.open,
      item.states.partiallySettled,
      item.states.settled,
      item.states.void,
    ];
    if (
      !machine ||
      machine.lifecycle !== 'active' ||
      machine.entity.targetId !== item.entityId ||
      machine.initialState.targetId !== item.states.draft ||
      new Set(states).size !== states.length ||
      states.some(
        (state) => !machine.states.some((entry) => entry.stateId === state),
      )
    )
      return refuse(
        path,
        item.states.machineId,
        "The state map names five distinct states of the open item's own machine, starting in draft.",
      );
    const stateFieldId = machine.stateField.fieldId;
    const issueTransition = machine.transitions.find(
      (transition) => transition.transitionId === item.issue.transitionId,
    );
    if (
      !issueTransition ||
      issueTransition.fromState.targetId !== item.states.draft ||
      issueTransition.toState.targetId !== item.states.open
    )
      return refuse(
        path,
        item.issue.transitionId,
        "Issue is the machine's transition from draft to open.",
      );
    // Only the core moves the machine: a generic transition would issue or
    // void with no number, total or balance check.
    const machineTransitions = new Set(
      machine.transitions.map((transition) => transition.transitionId),
    );
    const generic = v6.operations.find(
      (operation) =>
        operation.lifecycle === 'active' &&
        operation.effect.kind === 'transitionStateEffect' &&
        machineTransitions.has(operation.effect.transition.targetId),
    );
    if (generic)
      return refuse(
        '$.operations',
        generic.operationId,
        "Only the open-item core moves an open item's state; remove the generic transition.",
      );
    // Generic writes stay on drafts: update, archive and restore are each
    // draft-only, and at least one update exists (the lines' parent guard).
    const writes = entityOperations(item.entityId);
    const updates = writes.filter(
      (operation) => operation.effect.kind === 'updateRecordEffect',
    );
    if (lines && updates.length === 0)
      return refuse(
        '$.operations',
        subject,
        'An open item with lines declares a draft-only update, which freezes its lines at issue.',
      );
    const loose = writes.find(
      (operation) =>
        operation.effect.kind !== 'createRecordEffect' &&
        !draftOnly(operation.precondition, stateFieldId, item.states.draft),
    );
    if (loose)
      return refuse(
        '$.operations',
        loose.operationId,
        "A generic update, archive or restore of an open item is draft-only.",
      );
    // The number: assigned at this issue, counted per company.
    const numberField = fieldOf(item.entityId, item.numberFieldId)!;
    const numbering = numberingOf(numberField);
    if (
      numberField.fieldType.kind !== 'textFieldType' ||
      !numbering ||
      numbering.assignOn?.transitionId !== item.issue.transitionId ||
      numbering.scope !== 'legalEntity'
    )
      return refuse(
        path,
        item.numberFieldId,
        "The number role is a text field numbered on this item's issue transition, per company.",
      );
    if (
      !capabilityOperation(
        item.issue.operationId,
        OPEN_ITEM_ISSUE_CAPABILITY,
        item.entityId,
      )
    )
      return refuse(
        path,
        item.issue.operationId,
        "Issue is an active, person-confirmed open-item issue operation that reads the item back.",
      );
    if (operationBindings.has(item.issue.operationId))
      return refuse(path, item.issue.operationId, 'An issue issues one type.');
    const binding: OpenItemTypeBinding = {
      entityId: item.entityId,
      direction: item.direction,
      side: item.side,
      counterpartyRelationId: item.counterpartyRelationId,
      currencyFieldId: item.currencyFieldId,
      numberFieldId: item.numberFieldId,
      subtotalFieldId: item.subtotalFieldId,
      totalFieldId: item.totalFieldId,
      appliedFieldId: item.appliedFieldId,
      balanceFieldId: item.balanceFieldId,
      ...(lines ? { lines } : {}),
      ...(item.amountFieldId ? { amountFieldId: item.amountFieldId } : {}),
      stateFieldId,
      states: {
        draft: item.states.draft,
        open: item.states.open,
        partiallySettled: item.states.partiallySettled,
        settled: item.states.settled,
        void: item.states.void,
      },
      number: {
        sequenceId: numbering.sequenceId,
        prefix: numbering.prefix,
        minimumDigits: numbering.minimumDigits,
        start: numbering.start,
      },
      scale: scale!,
    };
    bound.set(item.entityId, binding);
    protectedFields.set(item.entityId, new Set(written));
    operationBindings.set(item.issue.operationId, {
      bindingVersion: 'openItem.issue/v1',
      item: binding,
    });
  }
  // A number assigned at a transition is assigned by an open-item issue.
  for (const field of v6.fields) {
    const numbering = numberingOf(field);
    if (
      numbering?.assignOn &&
      !items.some(
        (item) =>
          item.numberFieldId === field.fieldId &&
          item.issue.transitionId === numbering.assignOn?.transitionId,
      )
    )
      return refuse(
        '$.fields.numbering',
        field.fieldId,
        'A number assigned at a transition is the number role of an open item issued across it.',
      );
  }

  const applicationEntities = new Set<string>();
  for (const application of applications) {
    const path = '$.openItemApplications';
    const subject = application.entityId;
    const entity = activeEntity(application.entityId);
    if (
      !entity ||
      !('companyOwnership' in entity) ||
      entity.companyOwnership !== 'entityOwned' ||
      bound.has(application.entityId) ||
      applicationEntities.has(application.entityId)
    )
      return refuse(
        path,
        subject,
        'An application type is one active, company-owned record type that is not itself an open item.',
      );
    applicationEntities.add(application.entityId);
    const end = (relationId: string) => {
      const relation = relations.get(relationId);
      return relation &&
        relation.lifecycle === 'active' &&
        relation.sourceEntity.targetId === application.entityId &&
        relation.cardinality === 'manyToOne' &&
        relation.required
        ? bound.get(relation.targetEntity.targetId)
        : undefined;
    };
    const source = end(application.sourceRelationId);
    const target = end(application.targetRelationId);
    if (!source || source.side !== 'credit')
      return refuse(
        path,
        application.sourceRelationId,
        'The source is a required link to a credit-side open item.',
      );
    if (!target || target.side !== 'debit')
      return refuse(
        path,
        application.targetRelationId,
        'The target is a required link to a debit-side open item.',
      );
    if (source.direction !== target.direction)
      return refuse(
        path,
        subject,
        'An application stays within one direction: a receivable never settles a payable.',
      );
    const sourceParty = relations.get(source.counterpartyRelationId);
    const targetParty = relations.get(target.counterpartyRelationId);
    if (sourceParty?.targetEntity.targetId !== targetParty?.targetEntity.targetId)
      return refuse(
        path,
        subject,
        "Both ends name their counterparty from the same record type.",
      );
    const amount = fieldOf(application.entityId, application.amountFieldId);
    if (
      scaleOf(amount) === null ||
      scaleOf(amount) !== source.scale ||
      source.scale !== target.scale
    )
      return refuse(
        path,
        application.amountFieldId,
        "The applied amount is an exact decimal at both items' scale.",
      );
    const generic = entityOperations(application.entityId)[0];
    if (generic)
      return refuse(
        '$.operations',
        generic.operationId,
        'Applications are written only by the open-item core: the type declares no generic operation.',
      );
    if (
      !capabilityOperation(
        application.applyOperationId,
        OPEN_ITEM_APPLY_CAPABILITY,
        application.entityId,
      ) ||
      operationBindings.has(application.applyOperationId)
    )
      return refuse(
        path,
        application.applyOperationId,
        'Apply is an active, person-confirmed open-item apply operation that reads an application back.',
      );
    operationBindings.set(application.applyOperationId, {
      bindingVersion: 'openItem.apply/v1',
      application: {
        entityId: application.entityId,
        sourceRelationId: application.sourceRelationId,
        targetRelationId: application.targetRelationId,
        amountFieldId: application.amountFieldId,
      },
      source,
      target,
    });
  }
  // A core operation is bound by exactly one declaration.
  for (const operation of v6.operations)
    if (
      operation.lifecycle === 'active' &&
      operation.effect.kind === 'registeredCapabilityEffect' &&
      [OPEN_ITEM_ISSUE_CAPABILITY, OPEN_ITEM_APPLY_CAPABILITY].includes(
        operation.effect.capability.targetId,
      ) &&
      !operationBindings.has(operation.operationId)
    )
      return refuse(
        '$.operations',
        operation.operationId,
        'An open-item operation is named by an open-item declaration.',
      );
  return {
    status: 'bound',
    binding: {
      declared: true,
      operations: operationBindings,
      protectedFields,
    },
  };
}
