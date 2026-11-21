import { z } from 'zod';
import {
  companyScopeOf,
  fieldTypeKindOf,
  selectedFieldIds,
  type BoardSource,
} from './board.js';
import { canonicalizeAndHash } from './canonicalize.js';

// Provisional against main. Both capabilities are assigned again at integration.
export const VIEWPORT_READER = 38;
export const MAP_VIEW_READER = 39;
export const VIEWPORT_CONTRACT = 'map.viewport/v1' as const;
const id = z.string().min(5).max(180);
const field = z.strictObject({ fieldId: id, fieldType: z.string().min(1) });
export const MapBodySchema = z.strictObject({
  version: z.literal(1),
  viewport: z.literal(VIEWPORT_CONTRACT),
  entityId: id,
  listSurfaceId: id,
  listQueryId: id,
  recordSurfaceId: id,
  getQueryId: id,
  companyScope: z.enum(['none', 'exactlyOne', 'nonEmptySet']),
  label: field,
  addressFieldId: id,
  group: field.optional(),
  order: z.strictObject({
    kind: z.literal('byField'),
    field,
    direction: z.enum(['asc', 'desc']),
  }),
  defaultScope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('collection') }),
    z.strictObject({
      kind: z.literal('day'),
      fieldId: id,
      timeZone: z.string().min(1).max(100),
    }),
  ]),
  savedViewId: id.optional(),
});
export const SurfaceMapSchema = z.strictObject({
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  body: MapBodySchema,
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type MapBody = z.infer<typeof MapBodySchema>;
export type SurfaceMap = z.infer<typeof SurfaceMapSchema>;
export const mapDigest = (body: MapBody) =>
  canonicalizeAndHash(body).contentHash;
export const sortableMapTypes = new Set([
  'textFieldType',
  'integerFieldType',
  'exactDecimalFieldType',
  'dateTimeFieldType',
  'dateFieldType',
  'timeFieldType',
  'enumFieldType',
]);
const target = (ref: unknown) =>
  (ref as { targetId?: string } | undefined)?.targetId;
type Conflict = {
  code: 'RETIRED_TARGET' | 'INCOMPATIBLE_TYPE' | 'INCOMPATIBLE_SCOPE';
  subject: string;
  expected: unknown;
  observed: unknown;
};
export function mapBindingConflicts(
  def: BoardSource,
  body: MapBody,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const missing = (subject: string) =>
    conflicts.push({
      code: 'RETIRED_TARGET',
      subject,
      expected: subject,
      observed: null,
    });
  const changed = (subject: string, expected: unknown, observed: unknown) =>
    conflicts.push({ code: 'INCOMPATIBLE_TYPE', subject, expected, observed });
  const active = (
    rows: readonly Record<string, unknown>[],
    key: string,
    value: string,
  ) => rows.find((r) => r[key] === value && r.lifecycle !== 'retired');
  const list = active(def.surfaces, 'surfaceId', body.listSurfaceId);
  const record = active(def.surfaces, 'surfaceId', body.recordSurfaceId);
  const query = active(def.queries, 'queryId', body.listQueryId);
  const get = active(def.queries, 'queryId', body.getQueryId);
  if (!list) missing(body.listSurfaceId);
  else if (
    list.archetype !== 'list' ||
    target(list.dataSource) !== body.listQueryId
  )
    changed(body.listSurfaceId, body.listQueryId, target(list.dataSource));
  if (!record) missing(body.recordSurfaceId);
  else if (
    record.surfaceRole !== 'record' ||
    target(record.dataSource) !== body.getQueryId
  )
    changed(body.recordSurfaceId, body.getQueryId, target(record.dataSource));
  for (const [q, id, kind] of [
    [query, body.listQueryId, 'list'],
    [get, body.getQueryId, 'get'],
  ] as const) {
    if (!q) {
      missing(id);
      continue;
    }
    if (
      q.tier !== 'q0' ||
      q.readModel ||
      q.queryType !== kind ||
      target(q.sourceEntity) !== body.entityId
    )
      changed(id, body.entityId, target(q.sourceEntity));
    if (companyScopeOf(q) !== body.companyScope)
      conflicts.push({
        code: 'INCOMPATIBLE_SCOPE',
        subject: id,
        expected: body.companyScope,
        observed: companyScopeOf(q),
      });
  }
  const selected = query ? selectedFieldIds(query) : [];
  const fields = [
    body.label,
    body.order.field,
    { fieldId: body.addressFieldId, fieldType: 'addressFieldType' },
  ];
  if (body.group) fields.push(body.group);
  if (body.defaultScope.kind === 'day') {
    fields.push({
      fieldId: body.defaultScope.fieldId,
      fieldType: 'dateFieldType',
    });
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.defaultScope.timeZone });
    } catch {
      changed(
        body.defaultScope.fieldId,
        'IANA time zone',
        body.defaultScope.timeZone,
      );
    }
  }
  for (const { fieldId, fieldType } of fields) {
    const kind = fieldTypeKindOf(def, fieldId);
    if (!kind) missing(fieldId);
    else if (kind !== fieldType || !selected.includes(fieldId))
      changed(
        fieldId,
        fieldType,
        selected.includes(fieldId) ? kind : 'unselected',
      );
  }
  if (!sortableMapTypes.has(body.order.field.fieldType))
    changed(
      body.order.field.fieldId,
      'sortable field',
      body.order.field.fieldType,
    );
  if (body.group && body.group.fieldType !== 'enumFieldType')
    changed(body.group.fieldId, 'choice', body.group.fieldType);
  if (
    body.savedViewId &&
    !(list?.list as { views?: { viewId: string }[] } | undefined)?.views?.some(
      (v) => v.viewId === body.savedViewId,
    )
  )
    missing(body.savedViewId);
  return conflicts;
}
