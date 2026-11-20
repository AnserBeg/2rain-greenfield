import { z } from 'zod';
import { canonicalizeAndHash } from './canonicalize.js';
import { STATUS_ROLES } from './constants.js';

// Board v2 (ADR-0086, view revision member shape). Assigned against main
// immediately before integration: one rung above the highest serving reader.
export const BOARD_READER = 37;
export const BOARD_MEMBER_VERSION = 2;
const id = z.string().min(5).max(180);
const text = z.string().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** A field type's kind only. Labels and enum options never enter the contract. */
const fieldTypeKind = z.string().regex(/^[a-z][A-Za-z]{0,58}FieldType$/u);
const boundField = z.strictObject({ fieldId: id, fieldType: fieldTypeKind });
export const BoardMoveSchema = z.strictObject({
  operationId: id,
  effectKind: z.literal('transitionStateEffect'),
  transitionId: id,
  fromStateId: id,
  toStateId: id,
  tier: z.literal('o0'),
  contractDigest: sha256,
});
export const BoardGroupingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('lifecycleState'),
    version: z.literal(BOARD_MEMBER_VERSION),
    machineId: id,
    state: boundField,
    stages: z
      .array(z.strictObject({ stateId: id }))
      .min(1)
      .max(64),
    moves: z.array(BoardMoveSchema).max(128),
  }),
]);
export const BoardBodySchema = z.strictObject({
  version: z.literal(BOARD_MEMBER_VERSION),
  entityId: id,
  listSurfaceId: id,
  listQuery: z.strictObject({
    queryId: id,
    tier: z.literal('q0'),
    companyScope: z.enum(['none', 'exactlyOne', 'nonEmptySet']),
  }),
  recordSurfaceId: id,
  getQueryId: id,
  title: boundField,
  grouping: BoardGroupingSchema,
  facts: z.array(boundField).max(3),
});
export const SurfaceBoardSchema = z.strictObject({
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  body: BoardBodySchema,
  resultDigest: sha256,
});
/** Labels and Ledger roles render from the active release, outside the digest. */
export const BoardPresentationSchema = z.strictObject({
  stages: z.array(
    z.strictObject({
      stateId: id,
      label: text,
      role: z.enum(STATUS_ROLES).optional(),
    }),
  ),
  facts: z.array(z.strictObject({ fieldId: id, label: text })),
  moves: z.array(z.strictObject({ operationId: id, label: text })),
});
export type BoardBody = z.infer<typeof BoardBodySchema>;
export type BoardMove = z.infer<typeof BoardMoveSchema>;
export type SurfaceBoard = z.infer<typeof SurfaceBoardSchema>;
export type BoardPresentation = z.infer<typeof BoardPresentationSchema>;
type Row = Record<string, unknown>;
export interface BoardSource {
  surfaces: readonly Row[];
  queries: readonly Row[];
  operations?: readonly Row[];
  stateMachines?: readonly Row[];
  fields?: readonly Row[];
}
export interface BoardBindingConflict {
  code: 'RETIRED_TARGET' | 'INCOMPATIBLE_TYPE';
  subject: string;
  expected: unknown;
  observed: unknown;
}

const target = (ref: unknown) =>
  (ref as { targetId?: string } | undefined)?.targetId;
const active = (row: Row | undefined): row is Row =>
  !!row && row.lifecycle !== 'retired';
export const companyScopeOf = (query: Row) =>
  ((query.legalEntityScope as { cardinality?: string } | undefined)
    ?.cardinality ?? 'none') as BoardBody['listQuery']['companyScope'];
export const selectedFieldIds = (query: Row) =>
  (
    (query.selections as { field: { targetId: string } }[] | undefined) ?? []
  ).map((selection) => selection.field.targetId);
export const derivedStateFieldId = (machineId: string) =>
  machineId.replace(':', ':derived_state_field.');
/** The kind of a field's type; the derived lifecycle field is an enumeration. */
export function fieldTypeKindOf(
  def: BoardSource,
  fieldId: string,
): string | null {
  const field = def.fields?.find((f) => f.fieldId === fieldId);
  if (field)
    return active(field)
      ? String((field.fieldType as { kind?: string } | undefined)?.kind)
      : null;
  return (def.stateMachines ?? []).some(
    (m) => active(m) && derivedStateFieldId(String(m.machineId)) === fieldId,
  )
    ? 'enumFieldType'
    : null;
}
export const boardDigest = (body: BoardBody) =>
  canonicalizeAndHash(body).contentHash;
/** ADR-0086 item 2: the operation contract, never its label or live policy. */
export const moveContractDigest = (
  move: Omit<BoardMove, 'contractDigest'> | BoardMove,
) =>
  canonicalizeAndHash({
    operationId: move.operationId,
    effect: {
      kind: move.effectKind,
      transitionId: move.transitionId,
      fromStateId: move.fromStateId,
      toStateId: move.toStateId,
    },
    tier: move.tier,
  }).contentHash;

/**
 * Self-consistency only: the body hashes to its recorded digest, every move's
 * contract digest covers its recorded contract, and each move stays inside the
 * chosen stages. It reads nothing from the current model.
 */
export function boardSelfProblem(board: SurfaceBoard): string | null {
  const { body } = board;
  const stages = body.grouping.stages.map((s) => s.stateId);
  const facts = body.facts.map((f) => f.fieldId);
  const operations = body.grouping.moves.map((m) => m.operationId);
  if (
    boardDigest(body) !== board.resultDigest ||
    board.predecessor === board.revisionId
  )
    return 'The Board digest does not match its recorded bindings.';
  if (
    new Set(stages).size !== stages.length ||
    new Set(facts).size !== facts.length ||
    new Set(operations).size !== operations.length ||
    body.grouping.moves.some(
      (m) =>
        m.contractDigest !== moveContractDigest(m) ||
        !stages.includes(m.fromStateId) ||
        !stages.includes(m.toStateId),
    )
  )
    return 'The Board moves, stages or facts are inconsistent.';
  return null;
}

/**
 * Structural check by stable ID (ADR-0085 A20 off the authoring base, and
 * every normalization of an active Board). Each recorded binding must be
 * present with the same contract; absence is reported before a changed
 * contract. It never derives a Board from the current model.
 */
export function boardBindingConflicts(
  def: BoardSource,
  body: BoardBody,
): BoardBindingConflict[] {
  const out: BoardBindingConflict[] = [];
  const retired = (subject: string, observed: unknown = null) =>
    out.push({ code: 'RETIRED_TARGET', subject, expected: subject, observed });
  const changed = (subject: string, expected: unknown, observed: unknown) =>
    out.push({ code: 'INCOMPATIBLE_TYPE', subject, expected, observed });
  const surface = (sid: string) =>
    def.surfaces.find((s) => s.surfaceId === sid);
  const query = (qid: string) => def.queries.find((q) => q.queryId === qid);
  const list = surface(body.listSurfaceId);
  if (!active(list)) retired(body.listSurfaceId, list ? 'retired' : null);
  else if (
    list.archetype !== 'list' ||
    (target(list.dataSource) !== body.listQuery.queryId &&
      (list.workspace as { entry?: { authorizationQueryId?: string } })?.entry
        ?.authorizationQueryId !== body.listQuery.queryId)
  )
    changed(
      body.listSurfaceId,
      { archetype: 'list', readsQueryId: body.listQuery.queryId },
      { archetype: list.archetype, readsQueryId: target(list.dataSource) },
    );
  const boundFields = [body.title, body.grouping.state, ...body.facts];
  const listQuery = query(body.listQuery.queryId);
  if (!active(listQuery))
    retired(body.listQuery.queryId, listQuery ? 'retired' : null);
  else {
    const selected = new Set(selectedFieldIds(listQuery));
    const expected = {
      queryType: 'list',
      sourceEntityId: body.entityId,
      tier: body.listQuery.tier,
      companyScope: body.listQuery.companyScope,
      selects: boundFields.map((f) => f.fieldId),
    };
    const observed = {
      queryType: listQuery.queryType,
      sourceEntityId: target(listQuery.sourceEntity),
      tier: listQuery.tier,
      companyScope: companyScopeOf(listQuery),
      selects: expected.selects.filter((f) => selected.has(f)),
    };
    if (JSON.stringify(observed) !== JSON.stringify(expected))
      changed(body.listQuery.queryId, expected, observed);
  }
  const record = surface(body.recordSurfaceId);
  if (!active(record)) retired(body.recordSurfaceId, record ? 'retired' : null);
  else if (
    record.surfaceRole !== 'record' ||
    target(record.dataSource) !== body.getQueryId
  )
    changed(
      body.recordSurfaceId,
      { surfaceRole: 'record', getQueryId: body.getQueryId },
      {
        surfaceRole: record.surfaceRole,
        getQueryId: target(record.dataSource),
      },
    );
  const getQuery = query(body.getQueryId);
  if (!active(getQuery)) retired(body.getQueryId, getQuery ? 'retired' : null);
  else if (
    getQuery.queryType !== 'get' ||
    target(getQuery.sourceEntity) !== body.entityId
  )
    changed(
      body.getQueryId,
      { queryType: 'get', sourceEntityId: body.entityId },
      {
        queryType: getQuery.queryType,
        sourceEntityId: target(getQuery.sourceEntity),
      },
    );
  for (const field of boundFields) {
    const kind = fieldTypeKindOf(def, field.fieldId);
    if (kind === null) retired(field.fieldId);
    else if (kind !== field.fieldType)
      changed(field.fieldId, field.fieldType, kind);
  }
  const { grouping } = body;
  const machine = def.stateMachines?.find(
    (m) => m.machineId === grouping.machineId,
  );
  if (!active(machine) || target(machine.entity) !== body.entityId) {
    retired(grouping.machineId, machine ? 'retired' : null);
    return out;
  }
  if (derivedStateFieldId(grouping.machineId) !== grouping.state.fieldId)
    changed(
      grouping.state.fieldId,
      derivedStateFieldId(grouping.machineId),
      grouping.state.fieldId,
    );
  const states = new Set(
    (machine.states as { stateId: string }[]).map((s) => s.stateId),
  );
  for (const stage of grouping.stages)
    if (!states.has(stage.stateId)) retired(stage.stateId);
  const transitions = machine.transitions as {
    transitionId: string;
    fromState: { targetId: string };
    toState: { targetId: string };
  }[];
  for (const move of grouping.moves) {
    const op = def.operations?.find((o) => o.operationId === move.operationId);
    const transition = transitions.find(
      (t) => t.transitionId === move.transitionId,
    );
    if (!active(op)) retired(move.operationId, op ? 'retired' : null);
    else if (!transition) retired(move.transitionId);
    else {
      const effect = op.effect as Row;
      const expected = {
        effectKind: move.effectKind,
        transitionId: move.transitionId,
        fromStateId: move.fromStateId,
        toStateId: move.toStateId,
        tier: move.tier,
      };
      const observed = {
        effectKind: effect.kind,
        transitionId: target(effect.transition),
        fromStateId: transition.fromState.targetId,
        toStateId: transition.toState.targetId,
        tier: op.tier,
      };
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        changed(move.operationId, expected, observed);
    }
  }
  return out;
}

/** Labels and roles from the active release; a missing one falls back to its ID. */
export function boardPresentation(
  def: BoardSource,
  body: BoardBody,
): BoardPresentation {
  const machine = def.stateMachines?.find(
    (m) => m.machineId === body.grouping.machineId,
  );
  const states = (machine?.states ?? []) as {
    stateId: string;
    label?: string;
  }[];
  const transitions = (machine?.transitions ?? []) as {
    transitionId: string;
    label?: string;
  }[];
  const list = def.surfaces.find((s) => s.surfaceId === body.listSurfaceId)
    ?.list as
    | {
        columns: {
          field: string;
          role: string;
          label: string;
          statusRoles?: {
            value: string;
            role: (typeof STATUS_ROLES)[number];
          }[];
        }[];
      }
    | undefined;
  const status = list?.columns.find(
    (c) => c.field === body.grouping.state.fieldId && c.role === 'status',
  );
  const label = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim().length > 0
      ? value.slice(0, 240)
      : fallback;
  return {
    stages: body.grouping.stages.map(({ stateId }) => {
      const role = status?.statusRoles?.find((r) => r.value === stateId)?.role;
      return {
        stateId,
        label: label(states.find((s) => s.stateId === stateId)?.label, stateId),
        ...(role && { role }),
      };
    }),
    facts: body.facts.map(({ fieldId }) => ({
      fieldId,
      label: label(
        list?.columns.find((c) => c.field === fieldId)?.label ??
          def.fields?.find((f) => f.fieldId === fieldId)?.label,
        fieldId,
      ),
    })),
    moves: body.grouping.moves.map((m) => ({
      operationId: m.operationId,
      label: label(
        def.operations?.find((o) => o.operationId === m.operationId)?.label ??
          transitions.find((t) => t.transitionId === m.transitionId)?.label,
        m.transitionId,
      ),
    })),
  };
}
