import {
  DateTimeBindingSchema,
  type DateTimeBinding,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

/**
 * ADR-0087 slice 1. Admits each `dateTimeFields` declaration against its one
 * logical field and refuses every consumer v1 does not admit, by logical type,
 * before any backing scalar is inspected. A refusal names the logical type,
 * the field and the consumer or operand position.
 */
export interface DateTimeRefusal {
  readonly subjectId: string;
  readonly path: string;
  readonly message: string;
}

type Json = Record<string, unknown>;

// Positions where the logical field is admitted: the field itself, its
// declaration, the governed read (selection), entry (form, header editor),
// display (record composition, list column, layouts) and the message anchor of
// a presence rule. Everything else is a consumer v1 refuses.
const ADMITTED = new Set([
  'fields.fieldId',
  'dateTimeFields.fieldId',
  'queries.selections.field.targetId',
  'surfaces.form.fields.fieldId',
  'surfaces.documentEditor.headerFields.fieldId',
  'surfaces.composition.fields.field',
  'surfaces.list.columns.field',
  'formulaRules.fieldAnchors',
]);

const CONSUMERS: readonly (readonly [string, string])[] = [
  ['surfaces.list.filters', 'list filter'],
  ['surfaces.list.views.filters', 'saved view filter'],
  ['surfaces.list.views.before', 'list view date condition'],
  ['surfaces.list.figures', 'list figure'],
  ['surfaces.list.searchChildren', 'search'],
  ['surfaces.launcher.metrics', 'metric card'],
  ['queries.listSumFields', 'metric card'],
  ['queries.aggregate', 'metric card'],
  ['queries.resolveMatchKeys', 'search'],
  ['queries.filter', 'filter'],
  ['calculatedDisplayFields', 'calculated operand'],
  ['workflows', 'workflow condition'],
];

function consumerFor(path: string): string {
  return (
    CONSUMERS.find(([prefix]) => path.startsWith(prefix))?.[1] ??
    `consumer ${path}`
  );
}

function isTenantRecordType(entityId: string): boolean {
  return (entityId.split(':')[1] ?? '').startsWith('entity.custom_');
}

export function compileDateTimeFields(
  def: VersionedNormalizedApplicationPackage,
): { payload: DateTimeBinding[] } | DateTimeRefusal | null {
  if (def.languageVersion !== 'v6') return null;
  const declarations = def.dateTimeFields ?? [];
  if (declarations.length === 0) return null;
  const declared = new Set<string>();
  const active: DateTimeBinding[] = [];
  for (const declaration of declarations) {
    const refuse = (detail: string): DateTimeRefusal => ({
      subjectId: declaration.fieldId,
      path: '$.dateTimeFields',
      message: `dateTime field ${declaration.fieldId}: ${detail}`,
    });
    if (declared.has(declaration.fieldId))
      return refuse('the field is declared twice.');
    declared.add(declaration.fieldId);
    const field = def.fields.find((f) => f.fieldId === declaration.fieldId);
    const entity = def.entities.find(
      (e) => e.entityId === declaration.entityId,
    );
    if (!field || !entity || field.entity.targetId !== declaration.entityId)
      return refuse('the declaration must name one field on its record type.');
    if (!isTenantRecordType(declaration.entityId))
      return refuse(
        'only a tenant record type can hold a dateTime field in v1 (first-party records, document headers and lines are named gaps).',
      );
    if (
      def.relations.some(
        (r) =>
          r.ownership === 'parentScopedChild' &&
          r.sourceEntity.targetId === declaration.entityId,
      )
    )
      return refuse('a line table cannot hold a dateTime field in v1.');
    const type = field.fieldType;
    if (
      type.kind !== 'dateTimeFieldType' ||
      type.timezoneSemantics !== 'utcInstant' ||
      type.precision !== 'millisecond'
    )
      return refuse(
        'the logical field must store a millisecond UTC instant as its scalar.',
      );
    if (field.searchable)
      return refuse('search is a capability gap for the dateTime type.');
    if (field.classification !== 'internal')
      return refuse('the field must be internal; its components inherit it.');
    if (field.lifecycle === 'active')
      active.push(DateTimeBindingSchema.parse(declaration));
  }
  const activeIds = new Set(active.map((binding) => binding.fieldId));
  const refusal = findConsumer(def as unknown as Json, activeIds);
  if (refusal) return refusal;
  return {
    payload: active.sort((left, right) =>
      left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0,
    ),
  };
}

function findConsumer(
  def: Json,
  ids: ReadonlySet<string>,
): DateTimeRefusal | null {
  let found: DateTimeRefusal | null = null;
  const walk = (value: unknown, keys: string[], ancestors: Json[]) => {
    if (found) return;
    if (typeof value === 'string') {
      if (!ids.has(value)) return;
      const path = keys.join('.');
      if (ADMITTED.has(path) || path.startsWith('surfaces.layouts.')) return;
      if (path.startsWith('formulaRules.')) {
        const operand = ancestors.findLast(
          (node) => node.kind === 'field' || node.kind === 'path',
        );
        const owner = ancestors.findLast(
          (node) => node.kind === 'required' || node.kind === 'comparison',
        );
        // Presence on the whole value is admitted; everything else is a gap.
        if (
          owner?.kind === 'required' &&
          operand?.kind === 'field' &&
          operand.select === 'value'
        )
          return;
        const position =
          operand?.select === 'textLength'
            ? 'maximum length'
            : operand?.kind === 'path'
              ? 'to-one comparison operand'
              : owner?.kind === 'comparison'
                ? 'comparison operand'
                : 'rule operand';
        found = {
          subjectId: value,
          path: '$.formulaRules',
          message: `dateTime field ${value} cannot be a ${position}; comparing date-time values is a capability gap.`,
        };
        return;
      }
      found = {
        subjectId: value,
        path: `$.${keys[0] ?? ''}`,
        message: `dateTime field ${value} cannot be used as a ${consumerFor(path)}; that is a capability gap for the dateTime type.`,
      };
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, keys, ancestors);
      return;
    }
    if (value && typeof value === 'object') {
      const node = value as Json;
      for (const [key, child] of Object.entries(node))
        walk(child, [...keys, key], [...ancestors, node]);
    }
  };
  walk(def, [], []);
  return found;
}
