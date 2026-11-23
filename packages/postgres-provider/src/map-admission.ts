import {
  canonicalize,
  MAP_VIEW_READER,
  mapDigest,
  SurfaceMapSchema,
  SURFACE_SLOTS,
  VIEWPORT_CONTRACT,
} from '@north-star/canonical-model';

type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
const maps = (source: unknown) =>
  rows(row(source).surfaces).filter(
    (s) => s.archetype === 'map' || Object.hasOwn(s, 'map'),
  );
export const hasMapDeclaration = (source: unknown) => maps(source).length > 0;
export function mapDeclarationProblem(source: unknown, manifest: unknown) {
  const bindings = (v: unknown) =>
    maps(v)
      .map((s) => [s.surfaceId, s.lifecycle, s.archetype, s.map])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
  return canonicalize(bindings(source)) === canonicalize(bindings(manifest))
    ? null
    : 'Map declaration differs from its manifest.';
}
export function mapBindingsProblem(
  manifest: unknown,
  floor: number,
  queries: unknown,
  connector: unknown,
) {
  const declarations = maps(manifest),
    viewports = rows(row(connector).viewports);
  if (
    (declarations.length > 0 && floor < MAP_VIEW_READER) ||
    (!declarations.length && floor === MAP_VIEW_READER)
  )
    return 'Map bindings and the reader floor disagree.';
  const expected: Row[] = [];
  for (const s of declarations) {
    const parsed = SurfaceMapSchema.safeParse(s.map);
    if (
      !parsed.success ||
      s.archetype !== 'map' ||
      parsed.data.resultDigest !== mapDigest(parsed.data.body) ||
      parsed.data.revisionId === parsed.data.predecessor ||
      rows(s.slots)
        .map((slot) => slot.slot)
        .join() !== SURFACE_SLOTS.map.join()
    )
      return 'Malformed Map declaration.';
    const b = parsed.data.body;
    if (
      s.dataSourceQueryId !== b.listQueryId ||
      row(s.workspace).ownerSurfaceId !== b.listSurfaceId
    )
      return 'Map collection binding differs.';
    if (s.lifecycle === 'retired') continue;
    const q = rows(row(queries).queries).find(
      (q) =>
        q.queryId === b.listQueryId &&
        q.queryType === 'list' &&
        q.sourceEntityId === b.entityId,
    );
    const get = rows(row(queries).queries).find(
      (q) =>
        q.queryId === b.getQueryId &&
        q.queryType === 'get' &&
        q.sourceEntityId === b.entityId,
    );
    const surfaces = rows(row(manifest).surfaces);
    if (
      !q ||
      !get ||
      (row(q.legalEntityScope).cardinality ?? 'none') !== b.companyScope ||
      !surfaces.some(
        (r) =>
          r.surfaceId === b.recordSurfaceId &&
          r.dataSourceQueryId === b.getQueryId &&
          r.lifecycle === 'active',
      ) ||
      !surfaces.some(
        (r) =>
          r.surfaceId === b.listSurfaceId &&
          r.dataSourceQueryId === b.listQueryId &&
          r.lifecycle === 'active',
      )
    )
      return 'Map query or Record binding differs.';
    const selected = rows(q.selections).map((f) => f.fieldId);
    if (
      ![
        b.label.fieldId,
        b.addressFieldId,
        b.order.field.fieldId,
        ...(b.group ? [b.group.fieldId] : []),
        ...(b.defaultScope.kind === 'day' ? [b.defaultScope.fieldId] : []),
      ].every((id) => selected.includes(id))
    )
      return 'Map field binding differs.';
    expected.push({
      surfaceId: s.surfaceId,
      fieldId: b.addressFieldId,
      contract: VIEWPORT_CONTRACT,
    });
  }
  const sort = (items: Row[]) =>
    [...items].sort((a, b) =>
      String(a.surfaceId).localeCompare(String(b.surfaceId), 'en'),
    );
  if (canonicalize(sort(expected)) !== canonicalize(sort(viewports)))
    return 'Map viewport bindings differ from the connector.';
  return null;
}
