import {
  BOARD_READER,
  boardDigest,
  canonicalize,
  SurfaceBoardSchema,
  SURFACE_SLOTS,
} from '@north-star/canonical-model';

type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
const boards = (value: unknown) =>
  rows(row(value).surfaces).filter(
    (s) => s.archetype === 'board' || Object.hasOwn(s, 'board'),
  );
export const hasBoardDeclaration = (definition: unknown) =>
  boards(definition).length > 0;

export function boardDeclarationProblem(
  definition: unknown,
  manifest: unknown,
  floor: number,
) {
  const bindings = (model: unknown) =>
    boards(model)
      .map((s) => [s.surfaceId, s.archetype, s.lifecycle, s.board])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
  const declared = bindings(definition);
  if (
    (declared.length && floor < BOARD_READER) ||
    canonicalize(declared) !== canonicalize(bindings(manifest))
  )
    return 'Board declarations and the surface manifest disagree.';
  return null;
}
export function boardBindingsProblem(
  manifest: unknown,
  floor: number,
  operations: unknown,
  queries: unknown,
) {
  const declarations = boards(manifest);
  if (
    (declarations.length && floor < BOARD_READER) ||
    (!declarations.length && floor === BOARD_READER)
  )
    return 'Board bindings and the surface reader floor disagree.';
  for (const surface of declarations) {
    const parsed = SurfaceBoardSchema.safeParse(surface.board);
    if (surface.archetype !== 'board' || !parsed.success)
      return 'Malformed Board definition.';
    const { body, resultDigest } = parsed.data;
    const byId = (id: string) =>
      rows(row(manifest).surfaces).find((s) => s.surfaceId === id);
    const list = byId(body.listSurfaceId),
      record = byId(body.recordSurfaceId);
    const query = (id: string) =>
      rows(row(queries).queries).find(
        (q) => q.queryId === id && q.sourceEntityId === body.entityId,
      );
    const listQuery = query(body.listQueryId),
      getQuery = query(body.getQueryId);
    const selected = new Set(rows(listQuery?.selections).map((s) => s.fieldId));
    if (
      boardDigest(body) !== resultDigest ||
      surface.dataSourceQueryId !== body.listQueryId ||
      list?.archetype !== 'list' ||
      (list.dataSourceQueryId !== body.listQueryId &&
        row(row(list.workspace).entry).authorizationQueryId !==
          body.listQueryId) ||
      record?.surfaceRole !== 'record' ||
      record.dataSourceQueryId !== body.getQueryId ||
      listQuery?.queryType !== 'list' ||
      getQuery?.queryType !== 'get' ||
      rows(surface.slots)
        .map((s) => s.slot)
        .join() !== SURFACE_SLOTS.board.join() ||
      ![
        body.titleFieldId,
        body.grouping.stateFieldId,
        ...body.facts.map((f) => f.fieldId),
      ].every((id) => selected.has(id))
    )
      return 'The Board record, columns or query bindings differ from the release.';
    for (const move of body.moves) {
      const op = rows(row(operations).operations).find(
        (o) => o.operationId === move.operationId,
      );
      const effect = row(op?.effect);
      if (
        op?.lifecycle !== 'active' ||
        op.tier !== 'o0' ||
        effect.kind !== 'transitionStateEffect' ||
        row(effect.entity).targetId !== body.entityId ||
        effect.stateFieldId !== body.grouping.stateFieldId ||
        row(effect.transition).targetId !== move.transitionId ||
        effect.fromStateId !== move.fromStateId ||
        effect.toStateId !== move.toStateId
      )
        return 'The Board move must bind the declared lifecycle transition.';
    }
  }
  return null;
}
