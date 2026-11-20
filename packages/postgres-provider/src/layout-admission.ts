import {
  canonicalize,
  layoutDigest,
  LAYOUT_READER,
  SurfaceLayoutSchema,
} from '@north-star/canonical-model';

type Row = Record<string, unknown>;
const row = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
export function declaredLayouts(surfaces: unknown) {
  return rows(surfaces)
    .filter((s) => Object.hasOwn(s, 'layouts'))
    .map((s) => ({ surfaceId: s.surfaceId, layouts: s.layouts }))
    .sort((a, b) =>
      String(a.surfaceId).localeCompare(String(b.surfaceId), 'en'),
    );
}
/** Called on the immutable release before publication and on the actual serving bindings. */
export function layoutBindingsProblem(
  manifest: unknown,
  floor: number,
  operations: unknown,
  queries: unknown,
) {
  const surfaces = rows(row(manifest).surfaces);
  const declaring = surfaces.filter((s) => Object.hasOwn(s, 'layouts'));
  if (
    (!declaring.length && floor === LAYOUT_READER) ||
    (declaring.length && floor < LAYOUT_READER)
  )
    return 'The surface reader floor and declared layouts disagree.';
  for (const surface of declaring) {
    const parsed = SurfaceLayoutSchema.array()
      .min(1)
      .max(2)
      .safeParse(surface.layouts);
    if (!parsed.success) return 'The surface layout is malformed.';
    const query = rows(row(queries).queries).find(
      (q) => q.queryId === surface.dataSourceQueryId,
    );
    if (!query) return 'The layout query is missing.';
    for (const layout of parsed.data) {
      const b = layout.body;
      const slotIds = rows(surface.slots).map((s) => s.slotId);
      if (
        b.surfaceId !== surface.surfaceId ||
        !slotIds.includes(b.slotId) ||
        b.blocks.some((block) => !slotIds.includes(block.slotId)) ||
        layoutDigest(b) !== layout.resultLayoutDigest
      )
        return 'The layout has a changed owner, slot or result digest.';
      const fields = b.sections.flatMap((s) => s.fields);
      if (b.mode !== 'detail') {
        const editors = surfaces
          .map((s) => row(s.documentEditor))
          .filter((e) => e.headerFormSurfaceId === b.surfaceId);
        for (const editor of editors) {
          const bound = [
            ...rows(editor.headerFields),
            ...(b.mode === 'create' ? rows(editor.headerRelations) : []),
          ]
            .map((f) => f.fieldId)
            .sort();
          if (
            canonicalize(bound) !==
            canonicalize(
              fields
                .filter((f) => f.editorInput)
                .map((f) => f.id)
                .sort(),
            )
          )
            return 'The document editor header and layout bindings differ.';
        }
        if (fields.some((f) => f.editorInput) && !editors.length)
          return 'The layout has no document editor.';
      }
      const composition = row(surface.composition);
      if (b.mode === 'detail') {
        const columns = rows(composition.fields);
        const selected = rows(query.selections).map((v) => v.fieldId);
        if (
          fields.some((f) =>
            surface.composition
              ? !columns.some(
                  (c) => c.columnId === f.binding && c.field === f.id,
                )
              : !selected.includes(f.binding),
          )
        )
          return 'A layout member has no bound read.';
        if (
          b.blocks.some((block) =>
            block.kind === 'progression'
              ? !row(composition.presentation).progression
              : !rows(composition.children).some(
                  (c) => !row(c.presentation).rail,
                ),
          )
        )
          return 'A protected record block has no consumer.';
      } else {
        const effect =
          b.mode === 'create' ? 'createRecordEffect' : 'updateRecordEffect';
        const op = rows(row(operations).operations).find(
          (o) =>
            o.lifecycle === 'active' &&
            row(o.effect).kind === effect &&
            row(row(o.effect).entity).targetId === query.sourceEntityId,
        );
        const contract = row(op?.inputContract);
        const writable = rows(contract.fields);
        const relations = rows(contract.relationInputs);
        if (
          !op ||
          fields.some((f) =>
            f.bindingType.startsWith('relation:')
              ? !relations.some(
                  (r) =>
                    r.relationId === f.binding && r.required === f.required,
                )
              : !writable.some(
                  (w) =>
                    w.fieldId === f.binding &&
                    w.writable === true &&
                    w.fieldKind === f.bindingType &&
                    w.required === f.required,
                ),
          )
        )
          return 'A layout input has no matching operation binding.';
        const omitted = row(surface.form).omit;
        const inputs = new Set(
          rows(query.selections)
            .map((s) => s.fieldId)
            .filter(
              (id) =>
                !(Array.isArray(omitted) && omitted.includes(id)) &&
                writable.some((f) => f.fieldId === id && f.writable),
            ),
        );
        for (const r of relations) inputs.add(r.relationId);
        for (const f of fields) inputs.delete(f.binding);
        if (inputs.size) return 'The layout is missing a bound input.';
      }
    }
  }
  return null;
}
export function layoutDeclarationProblem(
  definition: unknown,
  manifest: unknown,
  floor: number,
) {
  const declarations = declaredLayouts(row(definition).surfaces);
  if (
    (declarations.length && floor < LAYOUT_READER) ||
    (!declarations.length && floor === LAYOUT_READER) ||
    canonicalize(declarations) !==
      canonicalize(declaredLayouts(row(manifest).surfaces))
  )
    return 'The layout declarations differ from the release surface projection or its reader floor.';
  return null;
}
