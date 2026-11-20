import { z } from 'zod';
import { canonicalizeAndHash } from './canonicalize.js';
import { STATUS_ROLES } from './constants.js';
import type { SurfaceComposition, SurfaceList } from './schemas.js';

// Assigned against main immediately before integration.
export const BOARD_READER = 30;
const id = z.string().min(5).max(180);
const text = z.string().min(1).max(240);
const field = z.strictObject({ fieldId: id, label: text });
export const BoardGroupingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('lifecycleState'),
    version: z.literal(1),
    machineId: id,
    stateFieldId: id,
    stages: z
      .array(
        z.strictObject({
          stateId: id,
          label: text,
          role: z.enum(STATUS_ROLES).optional(),
        }),
      )
      .min(1)
      .max(64),
  }),
]);
export const BoardBodySchema = z.strictObject({
  version: z.literal(1),
  entityId: id,
  listSurfaceId: id,
  recordSurfaceId: id,
  listQueryId: id,
  getQueryId: id,
  titleFieldId: id,
  grouping: BoardGroupingSchema,
  facts: z.array(field).max(3),
  moves: z
    .array(
      z.strictObject({
        version: z.literal(1),
        operationId: id,
        transitionId: id,
        fromStateId: id,
        toStateId: id,
        label: text,
      }),
    )
    .max(128),
});
export const SurfaceBoardSchema = z.strictObject({
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  body: BoardBodySchema,
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type BoardBody = z.infer<typeof BoardBodySchema>;
export type SurfaceBoard = z.infer<typeof SurfaceBoardSchema>;
type Row = Record<string, unknown>;
interface Ref {
  targetId: string;
}
interface Machine {
  machineId: string;
  entity: Ref;
  states: { stateId: string; label?: string; orderKey: number }[];
  transitions: {
    transitionId: string;
    label?: string;
    fromState: Ref;
    toState: Ref;
  }[];
}
export interface BoardSource {
  surfaces: readonly Row[];
  queries: readonly Row[];
  operations?: readonly Row[];
  stateMachines?: readonly Row[];
}
const scopeCardinality = (query:Row) =>
  (query.legalEntityScope as {cardinality?:string} | undefined)?.cardinality;
const selectedFields = (query:Row) =>
  (query.selections as {field:Ref}[]).map(selection=>selection.field.targetId);
const target = (ref: unknown) => (ref as Ref | undefined)?.targetId;
export const boardDigest = (body: BoardBody) =>
  canonicalizeAndHash(body).contentHash;

/** Resolve both authored and normalized packages against the same lifecycle contract. */
export function boardForList(
  def: BoardSource,
  listSurfaceId: string,
): BoardBody | null {
  const owner = def.surfaces.find(
    (s) => s.surfaceId === listSurfaceId && s.lifecycle !== 'retired',
  );
  const list = owner?.list as SurfaceList | undefined;
  if (!list || owner?.archetype !== 'list') return null;
  const ownerQuery = def.queries.find(
    (q) => q.queryId === target(owner.dataSource),
  );
  // A List with supplementary figures may name its governed record collection
  // in its workspace entry. Keep the same entity, permission, filter and scope.
  const sourceId = ownerQuery?.readModel
    ? (
        owner.workspace as
          { entry?: { authorizationQueryId?: string } } | undefined
      )?.entry?.authorizationQueryId
    : ownerQuery?.queryId;
  const query = def.queries.find(
    (q) =>
      q.queryId === sourceId &&
      q.queryType === 'list' &&
      q.lifecycle !== 'retired',
  );
  const entityId = target(query?.sourceEntity);
  if (
    !query ||
    !ownerQuery ||
    !entityId ||
    ownerQuery.lifecycle === 'retired' ||
    query.readModel ||
    query.tier !== 'q0' ||
    (query.maximumResultCount as number) < 2 ||
    target(ownerQuery.sourceEntity) !== entityId ||
    target(ownerQuery.permission) !== target(query.permission) ||
    canonicalizeAndHash(ownerQuery.filter ?? null).contentHash !==
      canonicalizeAndHash(query.filter ?? null).contentHash ||
    scopeCardinality(ownerQuery) !== scopeCardinality(query) ||
    canonicalizeAndHash(selectedFields(ownerQuery)).contentHash !== canonicalizeAndHash(selectedFields(query)).contentHash
  )
    return null;
  const scope=(query.legalEntityScope as {operand:{parameterId:string}}|undefined);
  if((query.parameters as {parameterId:string}[]|undefined)?.some(p=>p.parameterId!==scope?.operand.parameterId))
    return null;
  const machine = def.stateMachines?.find(
    (m) => target(m.entity) === entityId && m.lifecycle !== 'retired',
  ) as unknown as Machine | undefined;
  if (!machine) return null;
  const stateFieldId = machine.machineId.replace(':', ':derived_state_field.');
  const records = def.surfaces.filter(
    (s) =>
      s.surfaceRole === 'record' &&
      s.lifecycle !== 'retired' &&
      def.queries.some(
        (q) =>
          q.queryId === target(s.dataSource) &&
          q.queryType === 'get' && q.lifecycle !== 'retired' &&
          target(q.sourceEntity) === entityId,
      ),
  );
  const record =
    records.find(
      (s) =>
        (s.workspace as { ownerSurfaceId?: string } | undefined)
          ?.ownerSurfaceId === listSurfaceId,
    ) ?? (records.length === 1 ? records[0] : undefined);
  const title = list.columns.find((c) => c.role === 'title');
  const status = list.columns.find(
    (c) => c.field === stateFieldId && c.role === 'status',
  );
  const selected = new Set(selectedFields(query));
  if (
    !record ||
    !title ||
    !status ||
    !selected.has(title.field) ||
    !selected.has(stateFieldId)
  )
    return null;
  const composition = record.composition as SurfaceComposition | undefined;
  const headerFacts = (composition?.presentation?.header?.facts ?? []).map(
    (id) => composition?.fields.find((f) => f.columnId === id)?.field,
  );
  const eligible = list.columns.filter(
    (c) => c.role === 'value' && selected.has(c.field) && !c.relation,
  );
  eligible.sort((a, b) => a.priority - b.priority || a.orderKey - b.orderKey);
  const facts = [...new Set([...headerFacts, ...eligible.map((c) => c.field)])]
    .flatMap((id) => {
      const column = eligible.find((c) => c.field === id);
      return column ? [{ fieldId: column.field, label: column.label }] : [];
    })
    .slice(0, 3);
  const moves = machine.transitions
    .flatMap((t) =>
      (def.operations ?? [])
        .filter(
          (op) =>
            op.tier === 'o0' &&
            op.lifecycle !== 'retired' &&
            def.queries.some(
              (q) =>
                q.queryId === target(op.readBack) &&
                q.queryType === 'get' && q.lifecycle !== 'retired' &&
                target(q.sourceEntity) === entityId,
            ) &&
            (op.effect as Row).kind === 'transitionStateEffect' &&
            target((op.effect as Row).transition) === t.transitionId,
        )
        .map((op) => ({
          version: 1 as const,
          operationId: String(op.operationId),
          transitionId: t.transitionId,
          fromStateId: t.fromState.targetId,
          toStateId: t.toState.targetId,
          label: String(op.label ?? t.label ?? t.transitionId),
        })),
    )
    .sort((a, b) => a.operationId.localeCompare(b.operationId, 'en'));
  const result=BoardBodySchema.safeParse({
    version: 1,
    entityId,
    listSurfaceId,
    recordSurfaceId: record.surfaceId,
    listQueryId: query.queryId,
    getQueryId: target(record.dataSource),
    titleFieldId: title.field,
    facts,
    moves,
    grouping: {
      kind: 'lifecycleState',
      version: 1,
      machineId: machine.machineId,
      stateFieldId,
      stages: [...machine.states]
        .sort(
          (a, b) =>
            a.orderKey - b.orderKey || a.stateId.localeCompare(b.stateId, 'en'),
        )
        .map((state) => {
          const role = status.statusRoles?.find(
            (r) => r.value === state.stateId,
          )?.role;
          return {
            stateId: state.stateId,
            label: state.label ?? state.stateId,
            ...(role && { role }),
          };
        }),
    },
  });
  return result.success ? result.data : null;
}

export function boardWithStages(
  source: BoardBody,
  stateIds: readonly string[],
): BoardBody | null {
  const stages = stateIds.map((id) =>
    source.grouping.stages.find((s) => s.stateId === id),
  );
  if (
    !stages.length ||
    new Set(stateIds).size !== stages.length ||
    stages.some((s) => !s)
  )
    return null;
  return {
    ...source,
    grouping: {
      ...source.grouping,
      stages: stages.filter((s) => s !== undefined),
    },
    moves: source.moves.filter(
      (m) => stateIds.includes(m.fromStateId) && stateIds.includes(m.toStateId),
    ),
  };
}
