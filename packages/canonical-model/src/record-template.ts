import { z } from 'zod';
import { canonicalizeAndHash } from './canonicalize.js';

// Reconcile this scalar with the immediately preceding build at integration.
export const RECORD_TEMPLATE_READER = 48;
export const RECORD_TEMPLATE_OPERATION_READER = 7;

export function hasRecordTemplateBinding(definition: unknown): boolean {
  if (
    !definition ||
    typeof definition !== 'object' ||
    !('surfaces' in definition)
  )
    return false;
  return (
    Array.isArray(definition.surfaces) &&
    definition.surfaces.some((s) => s?.recordTemplateBinding !== undefined)
  );
}
const id = z.string().min(5).max(180);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const column = z.strictObject({
  fieldId: id,
  fieldType: z.enum([
    'textFieldType',
    'integerFieldType',
    'enumFieldType',
    'booleanFieldType',
    'dateFieldType',
    'reference',
  ]),
  contract: digest,
  required: z.boolean(),
  copyEligible: z.boolean(),
  audienceValues: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(64)
    .optional(),
});
const context = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('wholeType') }),
  z.strictObject({ kind: z.literal('choice'), fieldId: id }),
  z.strictObject({
    kind: z.literal('link'),
    relationId: id,
    entityId: id,
    getQueryId: id,
  }),
]);

export const RecordTemplateBindingSchema = z.strictObject({
  version: z.literal(1),
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  status: z.enum(['active', 'retired']),
  resultDigest: digest,
  body: z.strictObject({
    formId: id,
    recordId: id,
    entityId: id,
    lineEntityId: id,
    parentRelationId: id,
    lineQueryId: id,
    createOperationId: id,
    createPermissionId: id,
    required: z.boolean(),
    context,
    columns: z.array(column).min(1).max(24),
  }),
});
export type RecordTemplateBinding = z.infer<typeof RecordTemplateBindingSchema>;
type Body = RecordTemplateBinding['body'];
type Row = Record<string, unknown>;
export interface TemplateSource {
  entities: readonly Row[];
  fields: readonly Row[];
  surfaces: readonly Row[];
  queries: readonly Row[];
  operations?: readonly Row[];
  relations?: readonly Row[];
}
export interface RecordTemplateOffer {
  label: string;
  frame: Omit<Body, 'required' | 'columns' | 'context'>;
  columns: (Body['columns'][number] & { label: string })[];
  contexts: { label: string; selector: Body['context'] }[];
  previous?: RecordTemplateBinding;
}

const obj = (v: unknown): Row =>
  typeof v === 'object' && v !== null ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const target = (v: unknown) => obj(v).targetId;
const live = (v: Row) => v.lifecycle !== 'retired';
const hash = (v: unknown) => canonicalizeAndHash(v).contentHash;
export const templateBindingDigest = (body: Body) => hash(body);

/** Resolve the authoritative editor slots, ownership edge, operations and selectors. */
export function recordTemplateOffers(
  def: TemplateSource,
): RecordTemplateOffer[] {
  return def.surfaces.filter(live).flatMap((surface) => {
    const editor = obj(surface.documentEditor);
    if (
      surface.surfaceRole !== 'form' ||
      editor.headerFormSurfaceId !== surface.surfaceId
    )
      return [];
    const relation = def.relations?.find(
      (r) =>
        r.relationId === editor.parentRelationId &&
        live(r) &&
        r.ownership === 'parentScopedChild',
    );
    if (!relation) return [];
    const entityId = String(target(relation.targetEntity)),
      lineEntityId = String(target(relation.sourceEntity));
    const owned = (id: string) =>
      def.entities.some(
        (e) =>
          e.entityId === id && live(e) && e.companyOwnership === 'entityOwned',
      );
    if (!owned(entityId) || !owned(lineEntityId)) return [];
    const create = def.operations?.find(
      (o) =>
        live(o) &&
        o.tier === 'o0' &&
        obj(o.effect).kind === 'createRecordEffect' &&
        target(obj(o.effect).entity) === entityId,
    );
    const query = def.queries.find(
      (q) =>
        live(q) &&
        q.queryId === editor.lineQueryId &&
        target(q.sourceEntity) === lineEntityId &&
        q.tier === 'q0' &&
        q.legalEntityScope &&
        !q.readModel,
    );
    if (!create || !query) return [];
    const contexts: RecordTemplateOffer['contexts'] = [
      { label: 'Entire record type', selector: { kind: 'wholeType' } },
    ];
    for (const field of def.fields.filter(live)) {
      if (
        target(field.entity) === entityId &&
        obj(field.fieldType).kind === 'enumFieldType'
      ) {
        contexts.push({
          label: String(field.label),
          selector: { kind: 'choice', fieldId: String(field.fieldId) },
        });
      }
    }
    for (const link of rows(editor.headerRelations)) {
      const edge = def.relations?.find(
        (r) =>
          live(r) &&
          r.ownership === 'reference' &&
          r.relationId === link.fieldId &&
          target(r.sourceEntity) === entityId,
      );
      const targetId = String(target(edge?.targetEntity));
      const get = def.queries.find(
        (q) =>
          live(q) &&
          q.queryId === obj(link.reference).getQueryId &&
          q.queryType === 'get' &&
          target(q.sourceEntity) === targetId &&
          q.legalEntityScope &&
          !q.readModel,
      );
      if (edge && get && owned(targetId))
        contexts.push({
          label: String(link.label),
          selector: {
            kind: 'link',
            relationId: String(edge.relationId),
            entityId: targetId,
            getQueryId: String(get.queryId),
          },
        });
    }
    const columns = rows(editor.lineFields).flatMap((input) => {
      const field = def.fields.find(
        (f) =>
          live(f) &&
          f.fieldId === input.fieldId &&
          target(f.entity) === lineEntityId,
      );
      if (
        !field ||
        !['public', 'internal'].includes(String(field.classification)) ||
        !rows(query.selections).some((s) => target(s.field) === field.fieldId)
      )
        return [];
      const type = obj(field.fieldType);
      const kind = column.shape.fieldType.safeParse(type.kind);
      if (!kind.success) return [];
      const { options, ...contract } = type;
      // An enum relabel preserves its stable option IDs. Order belongs to the UI.
      const fieldContract = options
        ? {
            ...contract,
            options: rows(options)
              .map((o) => String(o.optionId))
              .sort(),
          }
        : contract;
      return [
        {
          fieldId: String(field.fieldId),
          fieldType: kind.data,
          required: field.presence === 'required',
          contract: hash(fieldContract),
          copyEligible: false,
          label: String(field.label),
        },
      ];
    });
    if (!columns.length) return [];
    return [
      {
        label: String(def.entities.find((e) => e.entityId === entityId)?.label),
        frame: {
          formId: String(surface.surfaceId),
          recordId: String(editor.recordSurfaceId),
          entityId,
          lineEntityId,
          parentRelationId: String(relation.relationId),
          lineQueryId: String(query.queryId),
          createOperationId: String(create.operationId),
          createPermissionId: String(target(create.permission)),
        },
        columns,
        contexts,
        ...(surface.recordTemplateBinding
          ? { previous: surface.recordTemplateBinding as RecordTemplateBinding }
          : {}),
      },
    ];
  });
}

/** Compare only recorded choices with their current contracts. New fields and labels are independent. */
export function templateBindingConflict(
  binding: RecordTemplateBinding,
  offer: RecordTemplateOffer | undefined,
) {
  const { body } = binding;
  const problem = (subject: string, expected: unknown, observed: unknown) => ({
    code:
      observed === null
        ? ('RETIRED_TARGET' as const)
        : ('INCOMPATIBLE_TYPE' as const),
    subject,
    expected,
    observed,
  });
  if (!offer) return problem(body.formId, body.formId, null);
  for (const required of offer.columns.filter((c) => c.required)) {
    if (!body.columns.some((c) => c.fieldId === required.fieldId))
      return problem(required.fieldId, required.fieldType, null);
  }
  for (const [key, value] of Object.entries(offer.frame)) {
    const expected = body[key as keyof RecordTemplateOffer['frame']];
    if (value !== expected) return problem(expected, expected, value);
  }
  if (!offer.contexts.some((c) => hash(c.selector) === hash(body.context)))
    return problem(
      body.context.kind === 'choice'
        ? body.context.fieldId
        : body.context.kind === 'link'
          ? body.context.relationId
          : body.formId,
      body.context,
      null,
    );
  for (const pinned of body.columns) {
    const current = offer.columns.find((c) => c.fieldId === pinned.fieldId);
    if (!current) return problem(pinned.fieldId, pinned.fieldType, null);
    if (current.fieldType !== pinned.fieldType)
      return problem(pinned.fieldId, pinned.fieldType, current.fieldType);
    if (
      current.contract !== pinned.contract ||
      current.required !== pinned.required
    )
      return problem(pinned.fieldId, pinned, current);
  }
  return null;
}
