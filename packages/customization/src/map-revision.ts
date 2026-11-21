import { randomUUID } from 'node:crypto';
import {
  CanonicalIdSchema,
  companyScopeOf,
  fieldTypeKindOf,
  mapBindingConflicts,
  mapDigest,
  selectedFieldIds,
  sortableMapTypes,
  SurfaceMapSchema,
  SURFACE_SLOTS,
  VIEWPORT_CONTRACT,
  type BoardSource,
  type MapBody,
  type SurfaceList,
  type SurfaceMap,
} from '@north-star/canonical-model';
import { z } from 'zod';

export const MapViewRevisionSchema = SurfaceMapSchema.extend({
  kind: z.literal('addMapViewRevision'),
  version: z.literal(1),
  schemaVersion: z.literal('v6'),
  surfaceId: CanonicalIdSchema,
  label: z.string().trim().min(1).max(80),
  lifecycle: z.enum(['active', 'retired']),
});
type Revision = z.infer<typeof MapViewRevisionSchema>;
type Row = Record<string, unknown>;
const ref = (v: unknown) => (v as { targetId?: string } | undefined)?.targetId;
const live = (v: Row) => v.lifecycle !== 'retired';
export const MapDraftSchema = z.strictObject({
  kind: z.literal('addMapViewRevision'),
  surface: CanonicalIdSchema.describe('Owning List surface ID'),
  label: z.string().trim().min(1).max(80),
  addressFieldId: CanonicalIdSchema.describe(
    'Direct Address on this collection',
  ),
  orderFieldId: CanonicalIdSchema.describe(
    'Sortable field used for route order',
  ),
  direction: z.enum(['asc', 'desc']),
  groupFieldId: CanonicalIdSchema.optional().describe(
    'Choice field for route grouping',
  ),
  dayFieldId: CanonicalIdSchema.optional(),
  timeZone: z.string().max(100).optional(),
  savedViewId: z.string().min(1).max(180).optional(),
});
export type MapDraft = z.infer<typeof MapDraftSchema>;
export function mapTargets(def: BoardSource) {
  return def.surfaces
    .filter((s) => s.archetype === 'list' && live(s))
    .flatMap((owner) => {
      const list = owner.list as SurfaceList | undefined;
      const title = list?.columns.find((c) => c.role === 'title')?.field;
      const q = def.queries.find(
        (q) =>
          q.queryId === ref(owner.dataSource) &&
          q.queryType === 'list' &&
          q.tier === 'q0' &&
          !q.readModel &&
          live(q),
      );
      if (!list || !title || !q) return [];
      const eid = ref(q.sourceEntity);
      if (!eid) return [];
      const getIds = new Set(
        def.queries
          .filter(
            (x) =>
              x.queryType === 'get' &&
              x.tier === 'q0' &&
              live(x) &&
              ref(x.sourceEntity) === eid &&
              companyScopeOf(x) === companyScopeOf(q),
          )
          .map((x) => x.queryId),
      );
      const records = def.surfaces.filter(
        (s) =>
          s.surfaceRole === 'record' &&
          live(s) &&
          getIds.has(ref(s.dataSource)),
      );
      const record =
        records.find(
          (s) =>
            (s.workspace as { ownerSurfaceId?: string })?.ownerSurfaceId ===
            owner.surfaceId,
        ) ?? (records.length === 1 ? records[0] : null);
      const titleType = fieldTypeKindOf(def, title);
      if (!record || !titleType) return [];
      const fields = selectedFieldIds(q).flatMap((fieldId) => {
        const f = def.fields?.find(
          (f) => f.fieldId === fieldId && ref(f.entity) === eid && live(f),
        );
        const fieldType = fieldTypeKindOf(def, fieldId);
        return f && fieldType
          ? [{ fieldId, fieldType, label: String(f.label ?? fieldId) }]
          : [];
      });
      const addresses = fields.filter(
        (f) => f.fieldType === 'addressFieldType',
      );
      const orders = fields.filter((f) => sortableMapTypes.has(f.fieldType));
      if (
        !addresses.length ||
        !orders.length ||
        !fields.some((f) => f.fieldId === title)
      )
        return [];
      const listSurfaceId = String(owner.surfaceId);
      return [
        {
          frame: {
            version: 1 as const,
            viewport: VIEWPORT_CONTRACT,
            entityId: eid,
            listSurfaceId,
            listQueryId: String(q.queryId),
            recordSurfaceId: String(record.surfaceId),
            getQueryId: ref(record.dataSource)!,
            companyScope: companyScopeOf(q),
            label: { fieldId: title, fieldType: titleType },
          },
          listLabel: String(owner.label),
          addresses,
          orders,
          groups: fields.filter((f) => f.fieldType === 'enumFieldType'),
          dates: fields.filter((f) => f.fieldType === 'dateFieldType'),
          savedViews: list.views
            .filter((v) => !v.open && !v.supply && !v.before && !v.band)
            .map((v) => v.viewId),
          views: def.surfaces
            .filter(
              (s) =>
                (s.map as SurfaceMap | undefined)?.body.listSurfaceId ===
                listSurfaceId,
            )
            .map((s) => ({
              surfaceId: String(s.surfaceId),
              label: String(s.label),
              lifecycle: s.lifecycle,
              ...(s.map as SurfaceMap),
            })),
        },
      ];
    });
}
export type MapTarget = ReturnType<typeof mapTargets>[number];
function bodyFor(t: MapTarget, draft: MapDraft): MapBody {
  const choose = (members: MapTarget['orders'], id: string) => {
    const found = members.find((x) => x.fieldId === id);
    if (!found) throw new Error('Unavailable Map field ' + id);
    return { fieldId: found.fieldId, fieldType: found.fieldType };
  };
  if (
    t.frame.listSurfaceId !== draft.surface ||
    (draft.savedViewId && !t.savedViews.includes(draft.savedViewId)) ||
    Boolean(draft.dayFieldId) !== Boolean(draft.timeZone)
  )
    throw new Error('Choose an offered Map collection, view and day.');
  return {
    ...t.frame,
    addressFieldId: choose(t.addresses, draft.addressFieldId).fieldId,
    ...(draft.groupFieldId && { group: choose(t.groups, draft.groupFieldId) }),
    order: {
      kind: 'byField',
      field: choose(t.orders, draft.orderFieldId),
      direction: draft.direction,
    },
    defaultScope: draft.dayFieldId
      ? {
          kind: 'day',
          fieldId: choose(t.dates, draft.dayFieldId).fieldId,
          timeZone: draft.timeZone!,
        }
      : { kind: 'collection' },
    ...(draft.savedViewId && { savedViewId: draft.savedViewId }),
  };
}
export function draftMapRevision(
  t: MapTarget,
  input: MapDraft,
  previous?: MapTarget['views'][number],
  retire = false,
): Revision {
  const draft = MapDraftSchema.parse(input);
  const body = retire && previous ? previous.body : bodyFor(t, draft);
  return MapViewRevisionSchema.parse({
    kind: draft.kind,
    schemaVersion: 'v6',
    version: 1,
    surfaceId:
      previous?.surfaceId ??
      body.entityId.split(':')[0] + ':surface.custom_map_' + randomUUID(),
    label: draft.label,
    lifecycle: retire ? 'retired' : 'active',
    body,
    resultDigest: mapDigest(body),
    revisionId: randomUUID(),
    predecessor: previous?.revisionId ?? null,
  });
}
export function applyMapRevision(
  def: BoardSource & { surfaces: Row[] },
  p: Revision,
  check: 'authoring' | 'structural' | 'identity',
) {
  const { body, surfaceId, resultDigest, revisionId, predecessor } = p;
  const current = def.surfaces.find((s) => s.surfaceId === surfaceId),
    prior = current?.map as SurfaceMap | undefined;
  const conflicts = mapBindingConflicts;
  const refuse = (
    message: string,
    problems: ReturnType<typeof conflicts> = [],
  ) => ({ message, conflicts: problems });
  if (
    resultDigest !== mapDigest(body) ||
    (prior?.revisionId ?? null) !== predecessor ||
    revisionId === predecessor ||
    (current && (!prior || prior.body.listSurfaceId !== body.listSurfaceId)) ||
    !surfaceId.startsWith(
      body.listSurfaceId.split(':')[0] + ':surface.custom_map_',
    ) ||
    (p.lifecycle === 'retired' && prior?.resultDigest !== resultDigest)
  )
    return refuse('Map identity, digest or predecessor changed.');
  if (p.lifecycle === 'active' && check !== 'identity') {
    const problems = conflicts(def, body);
    if (problems.length)
      return refuse('Map binding changed: ' + problems[0]!.subject, problems);
    if (check === 'authoring') {
      const target = mapTargets(def).find(
        (t) => t.frame.listSurfaceId === body.listSurfaceId,
      );
      try {
        if (
          !target ||
          resultDigest !==
            mapDigest(
              bodyFor(target, {
                kind: p.kind,
                label: p.label,
                surface: body.listSurfaceId,
                addressFieldId: body.addressFieldId,
                orderFieldId: body.order.field.fieldId,
                direction: body.order.direction,
                ...(body.group && { groupFieldId: body.group.fieldId }),
                ...(body.defaultScope.kind === 'day' && {
                  dayFieldId: body.defaultScope.fieldId,
                  timeZone: body.defaultScope.timeZone,
                }),
                ...(body.savedViewId && { savedViewId: body.savedViewId }),
              }),
            )
        )
          return refuse('Map choices differ on the authoring base.');
      } catch {
        return refuse('Map choices are unavailable on the authoring base.');
      }
    }
  }
  const owner =
    def.surfaces.find((s) => s.surfaceId === body.listSurfaceId) ?? current;
  const content = (owner?.slots as { content: unknown }[] | undefined)?.[0]
    ?.content;
  if (!owner || !content) return refuse('The Map collection is unavailable.');
  const entry = (owner.workspace as { entry?: unknown } | undefined)?.entry;
  const next = {
    kind: 'surfaceDefinition',
    schemaVersion: 'v6',
    archetype: 'map',
    surfaceId,
    label: p.label,
    lifecycle: p.lifecycle,
    module: owner.module,
    dataSource: {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: body.listQueryId,
    },
    workspace: {
      membership: 'contextual',
      ownerSurfaceId: body.listSurfaceId,
      ...(entry && { entry }),
    },
    slots: SURFACE_SLOTS.map.map((slot, i) => ({
      kind: 'surfaceSlot',
      schemaVersion: 'v6',
      slot,
      orderKey: (i + 1) * 10,
      slotId:
        surfaceId.replace(':surface.', ':slot.') + '_' + slot.toLowerCase(),
      content,
    })),
    statusRoles: [],
    map: { body, resultDigest, revisionId, predecessor },
  };
  if (current) def.surfaces[def.surfaces.indexOf(current)] = next;
  else def.surfaces.push(next);
  return null;
}
