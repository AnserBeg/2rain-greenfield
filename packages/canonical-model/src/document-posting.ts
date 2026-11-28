import { z } from 'zod';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

/**
 * The general document-posting binding (DOCUMENT-POSTING slice 1). An
 * operation that hands a staged document -- a header record with its line
 * records -- to a posting engine carries this block. It names, by canonical
 * ID only, the header entity, the line relation, the header's state field
 * with the state the post reads (`from`) and the state the engine's definer
 * moves it to (`to`), and which field fills each role the engine declares.
 * `options` binds the engine's choice roles (debit/credit, manual/opening) to
 * the bound enum's option IDs, so no engine reads an option's name.
 *
 * Nothing here names an engine: engines register a declaration (their
 * capability ID and roles) and the compiler checks a block against the
 * registered declaration of its engine. The ledger is the first engine; the
 * inventory posting kernel and invoices are later users of the same block.
 */
export const DOCUMENT_POSTING_BINDING_VERSION = 'documentPosting/v1' as const;

/**
 * The operation-catalog reader that understands the block. Assigned at merge
 * (charter rungs rule): the next free operation reader above line totals.
 */
export const DOCUMENT_POSTING_OPERATION_READER = 9;

const id = z
  .string()
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const roleKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u);
const roleMap = z
  .record(roleKey, id)
  .refine((value) => Object.keys(value).length <= 64);

export const DocumentPostingBinding = z.strictObject({
  bindingVersion: z.literal(DOCUMENT_POSTING_BINDING_VERSION),
  engine: id,
  header: z.strictObject({ entity: id }),
  lines: z.strictObject({ relation: id }),
  state: z.strictObject({ field: id, from: id, to: id }),
  roles: roleMap.refine((value) => Object.keys(value).length >= 1),
  options: roleMap,
});
export type DocumentPostingBinding = z.infer<typeof DocumentPostingBinding>;

/** The value a role accepts, independent of any one engine. */
export type DocumentPostingValueClass =
  'exactNumber' | 'calendarDate' | 'text' | 'integer' | 'choice';

export interface DocumentPostingRole {
  readonly scope: 'header' | 'line';
  readonly valueClass: DocumentPostingValueClass;
  readonly required: boolean;
  /** For a choice: the option role keys every binding must bind. */
  readonly options?: readonly string[];
}

/** What an engine registers: its capability and the roles it reads. */
export interface DocumentPostingEngine {
  readonly capabilityId: string;
  readonly roles: Readonly<Record<string, DocumentPostingRole>>;
}

/**
 * An exact number staged on a document before an engine converts it: decimal
 * precision 18, scale 4 (below 10^14, and times 10^4 inside a bigint). The
 * engine, never the document, decides what a value may be (for money, whole
 * minor units of the currency).
 */
export const DOCUMENT_POSTING_EXACT_NUMBER = Object.freeze({
  precision: 18,
  scale: 4,
});

export interface DocumentPostingProblem {
  readonly operationId: string;
  readonly reason: string;
}

export interface DocumentPostingContext {
  readonly engines: readonly DocumentPostingEngine[];
  /**
   * True when the compiled storage gives the line relation a foreign key that
   * carries the company (`legal_entity_id`), so a line's company is its
   * header's by construction.
   */
  readonly companyScopedRelation: (relationId: string) => boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Pkg = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;
type Operation = Pkg['operations'][number];
type Field = Pkg['fields'][number];

function fieldMatches(field: Field, valueClass: DocumentPostingValueClass) {
  const type = field.fieldType as Record<string, unknown>;
  switch (valueClass) {
    case 'exactNumber':
      return (
        type.kind === 'exactDecimalFieldType' &&
        type.precision === DOCUMENT_POSTING_EXACT_NUMBER.precision &&
        type.scale === DOCUMENT_POSTING_EXACT_NUMBER.scale
      );
    case 'calendarDate':
      return type.kind === 'dateFieldType';
    case 'text':
      return type.kind === 'textFieldType';
    case 'integer':
      return type.kind === 'integerFieldType';
    case 'choice':
      return type.kind === 'enumFieldType';
  }
}

function enumOptionIds(field: Field): readonly string[] {
  const type = field.fieldType as Record<string, unknown>;
  return Array.isArray(type.options)
    ? type.options.flatMap((option) =>
        record(option) && typeof option.optionId === 'string'
          ? [option.optionId]
          : [],
      )
    : [];
}

/** `state equals <stateId>` on the given field, exactly. */
function stateEquals(term: unknown, fieldId: string): string | undefined {
  if (
    !record(term) ||
    term.kind !== 'fieldComparisonPredicate' ||
    term.operator !== 'equals' ||
    !record(term.field) ||
    term.field.targetId !== fieldId ||
    !record(term.value) ||
    term.value.kind !== 'textValue' ||
    typeof term.value.value !== 'string'
  )
    return undefined;
  return term.value.value;
}

/**
 * The states a header guard provably refuses: the `not(state equals S)` terms
 * of a lone `notPredicate` or of an `allPredicate` (any further term only
 * narrows it). The negative spelling is the one a create can share
 * (`purchasing/definition.ts`, `editableStates`).
 */
function refusedStates(precondition: unknown, fieldId: string): Set<string> {
  const terms =
    record(precondition) && precondition.kind === 'allPredicate'
      ? Array.isArray(precondition.terms)
        ? precondition.terms
        : []
      : [precondition];
  const refused = new Set<string>();
  for (const term of terms) {
    if (!record(term) || term.kind !== 'notPredicate') continue;
    const state = stateEquals(term.term, fieldId);
    if (state) refused.add(state);
  }
  return refused;
}

/**
 * Every document-posting block in a revision is checked against its engine's
 * registered declaration. Refuses (naming the operation and the reason)
 * unless the operation is the engine's confirmation-class capability
 * operation, every role is bound to an active field of its value class on the
 * header or the line, the line relation is a required parent-scoped child of
 * the header that carries the company, the post reads a state of the header's
 * machine and the engine moves it to a terminal state no declared transition
 * reaches or leaves, and every header edit is refused in every state except
 * the machine's initial one, so lines freeze once the document leaves it.
 */
export function documentPostingDeclarationProblem(
  revision: VersionedNormalizedApplicationPackage,
  context: DocumentPostingContext,
): DocumentPostingProblem | undefined {
  const engineIds = new Set(context.engines.map((e) => e.capabilityId));
  for (const operation of revision.operations as readonly Operation[]) {
    const hasBlock =
      'documentPosting' in operation && operation.documentPosting !== undefined;
    const namesEngine =
      operation.effect.kind === 'registeredCapabilityEffect' &&
      engineIds.has(operation.effect.capability.targetId);
    if (!hasBlock && !namesEngine) continue;
    const refuse = (reason: string): DocumentPostingProblem => ({
      operationId: operation.operationId,
      reason,
    });
    if (revision.languageVersion !== 'v6') return refuse('languageVersion');
    const pkg = revision as Pkg;
    if (operation.lifecycle !== 'active' && !hasBlock) continue;
    const parsed = DocumentPostingBinding.safeParse(
      hasBlock
        ? (operation as { documentPosting?: unknown }).documentPosting
        : undefined,
    );
    if (!parsed.success) return refuse('binding');
    const b = parsed.data;
    const engine = context.engines.find((e) => e.capabilityId === b.engine);
    if (!engine) return refuse('engineUnregistered');
    // 1. The engine's own confirmation-class capability operation.
    if (
      operation.effect.kind !== 'registeredCapabilityEffect' ||
      operation.effect.capability.targetId !== b.engine
    )
      return refuse('effect');
    if (
      !pkg.capabilityRequirements.some(
        (c) =>
          c.capabilityId === b.engine &&
          c.lifecycle === 'active' &&
          c.supportStatus === 'supported',
      )
    )
      return refuse('capabilityRequirement');
    if (operation.confirmation !== 'humanRequired')
      return refuse('confirmation');
    if (operation.tier !== 'o1') return refuse('tier');
    const header = pkg.entities.find(
      (e) => e.entityId === b.header.entity && e.lifecycle === 'active',
    );
    if (!header) return refuse('header');
    const relation = pkg.relations.find(
      (r) => r.relationId === b.lines.relation && r.lifecycle === 'active',
    );
    // 3. Lines: a required, parent-scoped child of the header that carries
    // the header's company.
    if (
      !relation ||
      relation.ownership !== 'parentScopedChild' ||
      relation.required !== true ||
      relation.targetEntity.targetId !== header.entityId ||
      relation.sourceEntity.targetId === header.entityId ||
      !context.companyScopedRelation(relation.relationId)
    )
      return refuse('lines');
    const lineEntityId = relation.sourceEntity.targetId;
    if (
      !pkg.entities.some(
        (e) => e.entityId === lineEntityId && e.lifecycle === 'active',
      )
    )
      return refuse('lines');
    // 2. Roles: exactly the engine's set, each an active field of its value
    // class, required where the role is; every option bound, distinct, and
    // an option of its own field.
    const declared = Object.keys(engine.roles).sort();
    const bound = Object.keys(b.roles).sort();
    if (JSON.stringify(declared) !== JSON.stringify(bound))
      return refuse('roles');
    const boundFields = new Set<string>();
    const optionKeys: string[] = [];
    for (const key of declared) {
      const role = engine.roles[key]!;
      const field = pkg.fields.find(
        (f) => f.fieldId === b.roles[key] && f.lifecycle === 'active',
      );
      const owner = role.scope === 'header' ? header.entityId : lineEntityId;
      if (
        !field ||
        field.entity.targetId !== owner ||
        !fieldMatches(field, role.valueClass) ||
        (role.required && field.presence !== 'required') ||
        boundFields.has(field.fieldId) ||
        field.fieldId === b.state.field
      )
        return refuse(`role.${key}`);
      boundFields.add(field.fieldId);
      if (role.valueClass === 'choice') {
        const own = new Set(enumOptionIds(field));
        for (const option of role.options ?? []) {
          optionKeys.push(option);
          const optionId = b.options[option];
          if (!optionId || !own.has(optionId))
            return refuse(`option.${option}`);
        }
      }
    }
    if (
      JSON.stringify([...optionKeys].sort()) !==
        JSON.stringify(Object.keys(b.options).sort()) ||
      new Set(Object.values(b.options)).size !== optionKeys.length
    )
      return refuse('options');
    // 4. State: the header's active machine and its state field; `to` is
    // terminal and some transition enters `from`.
    const machine = pkg.stateMachines.find(
      (m) =>
        m.lifecycle === 'active' &&
        m.entity.targetId === header.entityId &&
        m.stateField.fieldId === b.state.field,
    );
    if (!machine) return refuse('state');
    const states = new Map<string, (typeof machine.states)[number]>(
      machine.states.map((s) => [s.stateId, s]),
    );
    const from = states.get(b.state.from);
    const to = states.get(b.state.to);
    if (
      !from ||
      !to ||
      from === to ||
      to.terminal !== true ||
      to.stateId === machine.initialState.targetId ||
      !machine.transitions.some((t) => t.toState.targetId === b.state.from)
    )
      return refuse('state');
    // 5. Posted protection: only the engine's definer reaches `to`.
    if (
      machine.transitions.some(
        (t) =>
          t.toState.targetId === b.state.to ||
          t.fromState.targetId === b.state.to,
      )
    )
      return refuse('postedReachable');
    // 6. Freeze: every header update, archive and restore is refused in every
    // state except the initial one, spelled not(state equals S); the line
    // writers inherit the update guard through the declared relation.
    const initial = machine.initialState.targetId;
    if (initial === b.state.from) return refuse('freeze');
    const headerEdits = pkg.operations.filter(
      (o) =>
        o.lifecycle === 'active' &&
        'entity' in o.effect &&
        o.effect.entity.targetId === header.entityId &&
        (o.effect.kind === 'updateRecordEffect' ||
          o.effect.kind === 'archiveRecordEffect' ||
          o.effect.kind === 'restoreRecordEffect'),
    );
    if (!headerEdits.some((o) => o.effect.kind === 'updateRecordEffect'))
      return refuse('freeze');
    const frozen = machine.states
      .map((s) => s.stateId)
      .filter((s) => s !== initial);
    for (const edit of headerEdits) {
      const refused = refusedStates(edit.precondition, b.state.field);
      if (frozen.some((s) => !refused.has(s))) return refuse('freeze');
    }
    // 7. Permission: a transition permission on the header.
    const permission = pkg.permissions.find(
      (p) => p.permissionId === operation.permission.targetId,
    );
    if (
      !permission ||
      permission.lifecycle !== 'active' ||
      permission.action !== 'transition' ||
      permission.resource.targetId !== header.entityId
    )
      return refuse('permission');
    const readBack = pkg.queries.find(
      (q) => q.queryId === operation.readBack.targetId,
    );
    if (
      !readBack ||
      readBack.queryType !== 'get' ||
      readBack.sourceEntity.targetId !== header.entityId
    )
      return refuse('readBack');
  }
  return undefined;
}

/**
 * The block of each catalog operation that carries one, as [operationId,
 * block] pairs: read from a definition or from a compiled operation catalog,
 * so the compiler and the release loader can require them byte-equal.
 */
export function documentPostingCatalogTerms(
  value: unknown,
): [unknown, unknown][] {
  if (!record(value) || !Array.isArray(value.operations)) return [];
  return value.operations.flatMap((operation) =>
    record(operation) && Object.hasOwn(operation, 'documentPosting')
      ? [[operation.operationId, operation.documentPosting]]
      : [],
  );
}

export function hasDocumentPosting(value: unknown): boolean {
  return documentPostingCatalogTerms(value).length > 0;
}
