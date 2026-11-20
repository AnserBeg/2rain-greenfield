import {
  AddressProjectionSchema,
  baseLayout,
  type AddressProjection,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

export function compileAddressBindings(
  def: VersionedNormalizedApplicationPackage,
):
  | { payload: AddressProjection }
  | { message: string; subjectId: string }
  | null {
  if (def.languageVersion !== 'v6') return null;
  const fields = def.fields.filter(
    (f) => f.fieldType.kind === 'addressFieldType',
  );
  const declarations = def.connectorBindings ?? [];
  const placements = def.mapPlacements ?? [];
  if (!fields.length && !declarations.length && !placements.length) return null;
  const bound = new Set<string>();
  const bindings: AddressProjection['bindings'] = [];
  for (const declaration of declarations) {
    const { fieldId, entityId } = declaration;
    const field = fields.find(
      (f) => f.fieldId === fieldId && f.entity.targetId === entityId,
    );
    const detail = def.surfaces.find(
      (s) =>
        s.surfaceRole === 'record' &&
        def.queries.some(
          (q) =>
            q.queryId === s.dataSource.targetId &&
            q.tier === 'q0' &&
            q.queryType === 'get' &&
            q.sourceEntity.targetId === entityId &&
            q.selections.some(
              (selection) => selection.field.targetId === fieldId,
            ),
        ),
    );
    const layout = detail && baseLayout(def, detail, 'detail');
    const operations = def.operations.filter(
      (op) =>
        op.tier === 'o0' &&
        op.lifecycle === 'active' &&
        (op.effect.kind === 'createRecordEffect' ||
          op.effect.kind === 'updateRecordEffect') &&
        op.effect.entity.targetId === entityId,
    );
    if (
      !field ||
      field.lifecycle !== 'active' ||
      field.classification !== 'internal' ||
      bound.has(fieldId) ||
      !detail ||
      !layout ||
      !operations.length
    )
      return {
        subjectId: fieldId,
        message:
          'An Address needs a unique, eligible record field with an authorized edit and detail read.',
      };
    bound.add(fieldId);
    const local = fieldId.split(':field.')[1];
    const ns = def.package.namespace;
    bindings.push({
      ...declaration,
      recordQueryId: detail.dataSource.targetId,
      editOperationIds: operations.map((op) => op.operationId).sort(),
      suggestQueryId: ns + ':query.address_suggest_' + local,
      mapQueryId: ns + ':query.address_map_' + local,
      geocodeOperationId: ns + ':operation.address_geocode_' + local,
    });
  }
  const unbound = fields.find((f) => !bound.has(f.fieldId));
  if (unbound)
    return {
      subjectId: unbound.fieldId,
      message: 'The Address has no connector binding.',
    };
  const layouts = new Map<string, AddressProjection['layouts'][number]>();
  const ids = new Set<string>();
  for (const p of placements) {
    const binding = bindings.find((b) => b.fieldId === p.fieldId);
    const surface = def.surfaces.find(
      (s) => s.surfaceId === p.surfaceId && s.surfaceRole === 'record',
    );
    const layout =
      surface?.layouts?.find((l) => l.body.mode === 'detail')?.body ??
      (surface && baseLayout(def, surface, 'detail'));
    if (
      !binding ||
      binding.recordQueryId !== surface?.dataSource.targetId ||
      !layout?.sections.some((s) => s.id === p.sectionId) ||
      ids.has(p.placementId)
    )
      return {
        subjectId: p.placementId,
        message:
          'A map must name a unique placement and an existing section on the field’s Record surface.',
      };
    layouts.set(p.surfaceId, layout);
    ids.add(p.placementId);
  }
  return {
    payload: AddressProjectionSchema.parse({
      kind: 'connectorPayload',
      schemaVersion: 'northstar.connector-payload/v1',
      bindings,
      placements,
      layouts: [...layouts.values()],
    }),
  };
}
