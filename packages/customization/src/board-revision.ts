import { randomUUID } from 'node:crypto';
import {
  BOARD_MEMBER_VERSION,
  BoardBodySchema,
  boardBindingConflicts,
  boardDigest,
  boardSelfProblem,
  canonicalizeAndHash,
  CanonicalIdSchema,
  companyScopeOf,
  derivedStateFieldId,
  fieldTypeKindOf,
  moveContractDigest,
  selectedFieldIds,
  SURFACE_SLOTS,
  type BoardBindingConflict,
  type BoardBody,
  type BoardMove,
  type BoardSource,
  type SurfaceBoard,
  type SurfaceComposition,
  type SurfaceList,
} from '@north-star/canonical-model';
import { z } from 'zod';

/**
 * Board v2 patch member (ADR-0086, view revision member shape). It records the
 * author's choices by stable ID, and every other binding once with its closed
 * contract. The v1 shape carries no `version` and is refused by this parser.
 */
export const BoardViewRevisionSchema = z.strictObject({
  kind: z.literal('addBoardViewRevision'),
  schemaVersion: z.literal('v6'),
  version: z.literal(BOARD_MEMBER_VERSION),
  surfaceId: CanonicalIdSchema,
  label: z.string().trim().min(1).max(240),
  lifecycle: z.enum(['active', 'retired']),
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  body: BoardBodySchema,
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Revision = z.infer<typeof BoardViewRevisionSchema>;
type Row = Record<string, unknown>;
const target = (ref: unknown) =>
  (ref as { targetId?: string } | undefined)?.targetId;
const live = (row: Row | undefined): row is Row =>
  !!row && row.lifecycle !== 'retired';
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What the builder offers for one List. Labels are for the author only. */
export interface BoardOffer {
  listLabel: string;
  /** Every binding except the choices, resolved once on this base. */
  frame: Omit<BoardBody, 'facts' | 'grouping'> & {
    grouping: Omit<BoardBody['grouping'], 'stages' | 'moves'>;
  };
  stages: { stateId: string; label: string }[];
  moves: (BoardMove & { label: string })[];
  facts: { fieldId: string; fieldType: string; label: string }[];
  /** The builder's default facts: key facts, then List priority. */
  defaultFacts: string[];
}
export interface BoardChoices {
  stateIds: readonly string[];
  operationIds: readonly string[];
  factFieldIds: readonly string[];
}

/**
 * The authoring eligibility gates. They run when an author drafts, and again
 * only on that authoring base when the patch applies. Normalization, serving
 * admission and replay on another base never call this.
 */
export function boardOffer(
  def: BoardSource,
  listSurfaceId: string,
): BoardOffer | null {
  const owner = def.surfaces.find((s) => s.surfaceId === listSurfaceId);
  const list = owner?.list as SurfaceList | undefined;
  if (!live(owner) || !list || owner.archetype !== 'list') return null;
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
    (q) => q.queryId === sourceId && q.queryType === 'list' && live(q),
  );
  const entityId = target(query?.sourceEntity);
  const hash = (v: unknown) => canonicalizeAndHash(v ?? null).contentHash;
  if (
    !query ||
    !live(ownerQuery) ||
    !entityId ||
    query.readModel ||
    query.tier !== 'q0' ||
    (query.maximumResultCount as number) < 2 ||
    target(ownerQuery.sourceEntity) !== entityId ||
    target(ownerQuery.permission) !== target(query.permission) ||
    hash(ownerQuery.filter) !== hash(query.filter) ||
    companyScopeOf(ownerQuery) !== companyScopeOf(query) ||
    hash(selectedFieldIds(ownerQuery)) !== hash(selectedFieldIds(query))
  )
    return null;
  const scope = query.legalEntityScope as
    { operand: { parameterId: string } } | undefined;
  if (
    (query.parameters as { parameterId: string }[] | undefined)?.some(
      (p) => p.parameterId !== scope?.operand.parameterId,
    )
  )
    return null;
  const machine = def.stateMachines?.find(
    (m) => target(m.entity) === entityId && live(m),
  );
  if (!machine) return null;
  const machineId = String(machine.machineId);
  const stateFieldId = derivedStateFieldId(machineId);
  const records = def.surfaces.filter(
    (s) =>
      s.surfaceRole === 'record' &&
      live(s) &&
      def.queries.some(
        (q) =>
          q.queryId === target(s.dataSource) &&
          q.queryType === 'get' &&
          live(q) &&
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
  const selected = selectedFieldIds(query);
  const titleType = title && fieldTypeKindOf(def, title.field);
  const stateType = fieldTypeKindOf(def, stateFieldId);
  if (
    !record ||
    !title ||
    !status ||
    !titleType ||
    !stateType ||
    !selected.includes(title.field) ||
    !selected.includes(stateFieldId)
  )
    return null;
  // Any field of this type that the list query selects can be a fact. Hiding,
  // reordering or relabelling its List column later changes nothing here.
  const facts = selected.flatMap((fieldId) => {
    const field = def.fields?.find((f) => f.fieldId === fieldId);
    const fieldType = fieldTypeKindOf(def, fieldId);
    if (
      !live(field) ||
      !fieldType ||
      target(field.entity) !== entityId ||
      fieldId === title.field ||
      fieldId === stateFieldId ||
      fieldType === 'addressFieldType'
    )
      return [];
    const column = list.columns.find((c) => c.field === fieldId);
    return [
      {
        fieldId,
        fieldType,
        label: String(column?.label ?? field.label ?? fieldId),
      },
    ];
  });
  const composition = record.composition as SurfaceComposition | undefined;
  const headerFacts = (composition?.presentation?.header?.facts ?? []).map(
    (cid) => composition?.fields.find((f) => f.columnId === cid)?.field,
  );
  const eligible = list.columns.filter(
    (c) => c.role === 'value' && selected.includes(c.field) && !c.relation,
  );
  eligible.sort((a, b) => a.priority - b.priority || a.orderKey - b.orderKey);
  const defaultFacts = [
    ...new Set([...headerFacts, ...eligible.map((c) => c.field)]),
  ]
    .filter((fid): fid is string => facts.some((f) => f.fieldId === fid))
    .slice(0, 3);
  const transitions = machine.transitions as {
    transitionId: string;
    label?: string;
    fromState: { targetId: string };
    toState: { targetId: string };
  }[];
  const moves = transitions
    .flatMap((t) =>
      (def.operations ?? [])
        .filter(
          (op) =>
            op.tier === 'o0' &&
            live(op) &&
            def.queries.some(
              (q) =>
                q.queryId === target(op.readBack) &&
                q.queryType === 'get' &&
                live(q) &&
                target(q.sourceEntity) === entityId,
            ) &&
            (op.effect as Row).kind === 'transitionStateEffect' &&
            target((op.effect as Row).transition) === t.transitionId,
        )
        .map((op) => {
          const move = {
            operationId: String(op.operationId),
            effectKind: 'transitionStateEffect' as const,
            transitionId: t.transitionId,
            fromStateId: t.fromState.targetId,
            toStateId: t.toState.targetId,
            tier: 'o0' as const,
          };
          return {
            ...move,
            contractDigest: moveContractDigest(move),
            label: String(op.label ?? t.label ?? t.transitionId),
          };
        }),
    )
    .sort((a, b) => byCodeUnits(a.operationId, b.operationId));
  const states = [
    ...(machine.states as {
      stateId: string;
      label?: string;
      orderKey: number;
    }[]),
  ].sort(
    (a, b) => a.orderKey - b.orderKey || byCodeUnits(a.stateId, b.stateId),
  );
  return {
    listLabel: String(owner.label),
    frame: {
      version: BOARD_MEMBER_VERSION,
      entityId,
      listSurfaceId,
      listQuery: {
        queryId: String(query.queryId),
        tier: 'q0',
        companyScope: companyScopeOf(query),
      },
      recordSurfaceId: String(record.surfaceId),
      getQueryId: String(target(record.dataSource)),
      title: { fieldId: title.field, fieldType: titleType },
      grouping: {
        kind: 'lifecycleState',
        version: BOARD_MEMBER_VERSION,
        machineId,
        state: { fieldId: stateFieldId, fieldType: stateType },
      },
    },
    stages: states.map((s) => ({
      stateId: s.stateId,
      label: s.label ?? s.stateId,
    })),
    moves,
    facts,
    defaultFacts,
  };
}

/** The body for explicit choices on the offer's base, or why they are not offered. */
export function boardBodyFor(
  offer: BoardOffer,
  choices: BoardChoices,
): BoardBody | string {
  const { stateIds, operationIds, factFieldIds } = choices;
  if (
    !stateIds.length ||
    new Set(stateIds).size !== stateIds.length ||
    stateIds.some((sid) => !offer.stages.some((s) => s.stateId === sid))
  )
    return 'Choose distinct stages from this lifecycle.';
  if (
    factFieldIds.length > 3 ||
    new Set(factFieldIds).size !== factFieldIds.length ||
    factFieldIds.some((fid) => !offer.facts.some((f) => f.fieldId === fid))
  )
    return 'Choose up to three distinct key facts the List reads.';
  const moves = operationIds.map((oid) =>
    offer.moves.find(
      (m) =>
        m.operationId === oid &&
        stateIds.includes(m.fromStateId) &&
        stateIds.includes(m.toStateId),
    ),
  );
  if (
    new Set(operationIds).size !== operationIds.length ||
    moves.some((m) => !m)
  )
    return 'Choose moves between the chosen stages.';
  return BoardBodySchema.parse({
    ...offer.frame,
    grouping: {
      ...offer.frame.grouping,
      stages: stateIds.map((stateId) => ({ stateId })),
      moves: moves.map((m) => ({
        operationId: m!.operationId,
        effectKind: m!.effectKind,
        transitionId: m!.transitionId,
        fromStateId: m!.fromStateId,
        toStateId: m!.toStateId,
        tier: m!.tier,
        contractDigest: m!.contractDigest,
      })),
    },
    facts: factFieldIds.map((fid) => {
      const fact = offer.facts.find((f) => f.fieldId === fid)!;
      return { fieldId: fact.fieldId, fieldType: fact.fieldType };
    }),
  });
}
export const choicesOf = (body: BoardBody): BoardChoices => ({
  stateIds: body.grouping.stages.map((s) => s.stateId),
  operationIds: body.grouping.moves.map((m) => m.operationId),
  factFieldIds: body.facts.map((f) => f.fieldId),
});

export interface BoardView {
  surfaceId: string;
  label: string;
  revisionId: string;
  lifecycle: string;
  body: BoardBody;
}
export interface BoardTarget extends BoardOffer {
  views: BoardView[];
  /** The List no longer passes the authoring gates: its Boards can only retire. */
  retireOnly?: true;
}
export function boardTargets(def: BoardSource): BoardTarget[] {
  return def.surfaces.flatMap((list) => {
    if (!list.list) return [];
    const listSurfaceId = String(list.surfaceId);
    const views = def.surfaces.flatMap((surface) => {
      const board = surface.board as SurfaceBoard | undefined;
      return board?.body.listSurfaceId === listSurfaceId
        ? [
            {
              surfaceId: String(surface.surfaceId),
              label: String(surface.label),
              revisionId: board.revisionId,
              lifecycle: String(surface.lifecycle ?? 'active'),
              body: board.body,
            },
          ]
        : [];
    });
    const offer = boardOffer(def, listSurfaceId);
    if (offer) return [{ ...offer, views }];
    // Keep a way out: an existing Board on a List that no longer qualifies can
    // still be retired, which checks identity and predecessor only.
    const body = views.find((v) => v.lifecycle === 'active')?.body;
    if (!body) return [];
    const { grouping } = body;
    return [
      {
        listLabel: String(list.label),
        frame: {
          version: body.version,
          entityId: body.entityId,
          listSurfaceId: body.listSurfaceId,
          listQuery: body.listQuery,
          recordSurfaceId: body.recordSurfaceId,
          getQueryId: body.getQueryId,
          title: body.title,
          grouping: {
            kind: grouping.kind,
            version: grouping.version,
            machineId: grouping.machineId,
            state: grouping.state,
          },
        },
        stages: grouping.stages.map((s) => ({
          stateId: s.stateId,
          label: s.stateId,
        })),
        moves: [],
        facts: [],
        defaultFacts: [],
        views,
        retireOnly: true as const,
      },
    ];
  });
}
/** The builder's default offer: the stages, every move between them, default facts. */
export function defaultBoardChoices(
  offer: BoardOffer,
  stateIds: readonly string[] = offer.stages.map((s) => s.stateId),
): BoardChoices {
  return {
    stateIds,
    operationIds: offer.moves
      .filter(
        (m) =>
          stateIds.includes(m.fromStateId) && stateIds.includes(m.toStateId),
      )
      .map((m) => m.operationId),
    factFieldIds: offer.defaultFacts,
  };
}
export function draftBoardRevision(
  offer: BoardOffer,
  label: string,
  choices: BoardChoices,
  previous?: BoardView,
  lifecycle: Revision['lifecycle'] = 'active',
): Revision {
  // A retirement keeps the predecessor's recorded body; it binds nothing new.
  const body =
    lifecycle === 'retired' && previous
      ? previous.body
      : boardBodyFor(offer, choices);
  if (typeof body === 'string') throw new Error(body);
  const namespace = body.listSurfaceId.split(':')[0];
  return BoardViewRevisionSchema.parse({
    kind: 'addBoardViewRevision',
    schemaVersion: 'v6',
    version: BOARD_MEMBER_VERSION,
    label,
    lifecycle,
    surfaceId:
      previous?.surfaceId ??
      namespace + ':surface.custom_board_' + randomUUID(),
    revisionId: randomUUID(),
    predecessor: previous?.revisionId ?? null,
    body,
    resultDigest: boardDigest(body),
  });
}

/**
 * How a recorded revision is checked where it applies (ADR-0085 A20, ADR-0086
 * items 4 and 5):
 * - `authoring`: on its own authoring base the choices must reproduce the
 *   exact recorded digest;
 * - `structural`: on another base each binding is checked by stable ID, and a
 *   failure is a typed conflict naming it;
 * - `identity`: a superseded revision checks identity and predecessor only.
 * A retire revision is always checked as `identity`.
 */
export type BoardCheck = 'authoring' | 'structural' | 'identity';
export interface BoardApplyProblem {
  message: string;
  conflicts: BoardBindingConflict[];
}
export function applyBoardRevision(
  def: BoardSource & { surfaces: Record<string, unknown>[] },
  patch: Revision,
  check: BoardCheck,
): BoardApplyProblem | null {
  const { surfaceId, revisionId, predecessor, resultDigest, body } = patch;
  const listSurfaceId = body.listSurfaceId;
  const current = def.surfaces.find((s) => s.surfaceId === surfaceId);
  const prior = current?.board as SurfaceBoard | undefined;
  const namespace = listSurfaceId.split(':')[0]!;
  const refuse = (
    message: string,
    conflicts: BoardBindingConflict[] = [],
  ): BoardApplyProblem => ({ message, conflicts });
  const self = boardSelfProblem({
    revisionId,
    predecessor,
    body,
    resultDigest,
  });
  if (self) return refuse(self);
  if (
    !surfaceId.startsWith(namespace + ':surface.custom_board_') ||
    (current && (!prior || prior.body.listSurfaceId !== listSurfaceId)) ||
    (prior?.revisionId ?? null) !== predecessor ||
    (patch.lifecycle === 'retired' &&
      (!prior || boardDigest(prior.body) !== resultDigest))
  )
    return refuse('The Board identity or predecessor has changed.');
  if (patch.lifecycle === 'active' && check !== 'identity') {
    if (check === 'authoring') {
      const offer = boardOffer(def, listSurfaceId);
      const expected = offer
        ? boardBodyFor(offer, choicesOf(body))
        : 'Choose a List with the declared lifecycle and an accessible Record.';
      if (typeof expected === 'string') return refuse(expected);
      if (boardDigest(expected) !== resultDigest)
        return refuse(
          'The Board digest does not match its recorded IDs and contracts on this base.',
        );
    }
    const conflicts = boardBindingConflicts(def, body);
    if (conflicts.length)
      return refuse(
        'The Board binding ' + conflicts[0]!.subject + ' has changed.',
        conflicts,
      );
  }
  const owner = def.surfaces.find((s) => s.surfaceId === listSurfaceId);
  const slotContent = (surface: Row | undefined) =>
    (surface?.slots as { content: unknown }[] | undefined)?.[0]?.content;
  const content = slotContent(owner) ?? slotContent(current);
  if (!content) return refuse('The List has no registered slot content.');
  const local = surfaceId.split(':surface.')[1];
  const entry = (
    (owner ?? current)?.workspace as { entry?: unknown } | undefined
  )?.entry;
  const next = {
    kind: 'surfaceDefinition',
    schemaVersion: 'v6',
    archetype: 'board',
    surfaceId,
    label: patch.label,
    lifecycle: patch.lifecycle,
    module: owner?.module ?? current?.module,
    dataSource: {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: body.listQuery.queryId,
    },
    workspace: {
      membership: 'contextual',
      ownerSurfaceId: listSurfaceId,
      ...(entry ? { entry } : {}),
    },
    slots: SURFACE_SLOTS.board.map((slot, index) => ({
      kind: 'surfaceSlot',
      schemaVersion: 'v6',
      slot,
      orderKey: 10 * (index + 1),
      slotId: namespace + ':slot.' + local + '_' + slot.toLowerCase(),
      content,
    })),
    statusRoles: [],
    board: { body, revisionId, predecessor, resultDigest },
  };
  if (current) def.surfaces[def.surfaces.indexOf(current)] = next;
  else def.surfaces.push(next);
  return null;
}

/** ADR-0086 item 5: binding checks apply to the last revision of each Board. */
export function supersededBoardRevisions(
  chain: readonly (
    { kind: string; patches?: readonly unknown[] } | Record<string, unknown>
  )[],
): Set<string> {
  const last = new Map<string, string>();
  const all: string[] = [];
  for (const change of chain) {
    const members = (
      change.kind === 'changeSet' ? (change.patches as unknown[]) : [change]
    ) as { kind?: string; surfaceId?: string; revisionId?: string }[];
    for (const member of members)
      if (member.kind === 'addBoardViewRevision' && member.revisionId) {
        last.set(String(member.surfaceId), member.revisionId);
        all.push(member.revisionId);
      }
  }
  const latest = new Set(last.values());
  return new Set(all.filter((id) => !latest.has(id)));
}
