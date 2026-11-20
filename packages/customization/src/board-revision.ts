import { randomUUID } from 'node:crypto';
import {
  boardDigest,
  boardForList,
  boardWithStages,
  CanonicalIdSchema,
  SURFACE_SLOTS,
  type BoardBody,
  type BoardSource,
  type SurfaceBoard,
} from '@north-star/canonical-model';
import { z } from 'zod';

export const BoardViewRevisionSchema = z.strictObject({
  kind: z.literal('addBoardViewRevision'),
  schemaVersion: z.literal('v6'),
  surfaceId: CanonicalIdSchema,
  listSurfaceId: CanonicalIdSchema,
  label: z.string().trim().min(1).max(240),
  lifecycle: z.enum(['active', 'retired']),
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  grouping: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('lifecycleState'),
      version: z.literal(1),
      machineId: CanonicalIdSchema,
      states: z.array(CanonicalIdSchema).min(1).max(64),
    }),
  ]),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Revision = z.infer<typeof BoardViewRevisionSchema>;
export interface BoardTarget {
  listLabel: string;
  body: BoardBody;
  views: {
    surfaceId: string;
    label: string;
    revisionId: string;
    lifecycle: string;
    states:string[];
  }[];
}
export function boardTargets(def: BoardSource): BoardTarget[] {
  return def.surfaces.flatMap((list) => {
    if (!list.list) return [];
    const body = boardForList(def, String(list.surfaceId));
    if (!body) return [];
    const views = def.surfaces.flatMap((surface) => {
      const board = surface.board as SurfaceBoard | undefined;
      return board?.body.listSurfaceId === body.listSurfaceId
        ? [
            {
              surfaceId: String(surface.surfaceId),
              label: String(surface.label),
              revisionId: board.revisionId,
              states:board.body.grouping.stages.map(s=>s.stateId),
              lifecycle: String(surface.lifecycle ?? 'active'),
            },
          ]
        : [];
    });
    return [{ listLabel: String(list.label), body, views }];
  });
}
export function draftBoardRevision(
  target: BoardTarget,
  label: string,
  states: readonly string[],
  previous?: BoardTarget['views'][number],
  lifecycle: Revision['lifecycle'] = 'active',
): Revision {
  const body = boardWithStages(target.body, states);
  if (!body) throw new Error('Choose distinct stages from this lifecycle.');
  const namespace = body.listSurfaceId.split(':')[0];
  return BoardViewRevisionSchema.parse({
    kind: 'addBoardViewRevision',
    schemaVersion: 'v6',
    label,
    lifecycle,
    surfaceId:
      previous?.surfaceId ??
      namespace + ':surface.custom_board_' + randomUUID(),
    listSurfaceId: body.listSurfaceId,
    revisionId: randomUUID(),
    predecessor: previous?.revisionId ?? null,
    grouping: {
      kind: 'lifecycleState',
      version: 1,
      machineId: body.grouping.machineId,
      states,
    },
    resultDigest: boardDigest(body),
  });
}
export function applyBoardRevision(
  def: BoardSource & { surfaces: Record<string, unknown>[] },
  patch: Revision,
): string | null {
  const { surfaceId, listSurfaceId, revisionId, predecessor, resultDigest } =
    patch;
  const source = boardForList(def, listSurfaceId);
  const owner = def.surfaces.find((s) => s.surfaceId === listSurfaceId);
  const current = def.surfaces.find((s) => s.surfaceId === surfaceId);
  const prior = current?.board as SurfaceBoard | undefined;
  const namespace = listSurfaceId.split(':')[0]!;
  if (
    !source ||
    !owner ||
    source.grouping.machineId !== patch.grouping.machineId
  )
    return 'Choose a List with the declared lifecycle and an accessible Record.';
  if (
    !surfaceId.startsWith(namespace + ':surface.custom_board_') ||
    (current && (!prior || prior.body.listSurfaceId !== listSurfaceId)) ||
    (prior?.revisionId ?? null) !== predecessor ||
    predecessor === revisionId ||
    (!current && patch.lifecycle === 'retired')
  )
    return 'The Board identity or predecessor has changed.';
  const body = boardWithStages(source, patch.grouping.states);
  if (!body || boardDigest(body) !== resultDigest)
    return 'The Board stages, key facts or transition bindings have changed.';
  const content = (owner.slots as { content: unknown }[])[0]?.content;
  if (!content) return 'The List has no registered slot content.';
  const local = surfaceId.split(':surface.')[1];
  const workspace = owner.workspace as { entry?: unknown } | undefined;
  const next = {
    kind: 'surfaceDefinition',
    schemaVersion: 'v6',
    archetype: 'board',
    surfaceId,
    label: patch.label,
    lifecycle: patch.lifecycle,
    module: owner.module,
    dataSource: {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: body.listQueryId,
    },
    workspace: {
      membership: 'contextual',
      ownerSurfaceId: listSurfaceId,
      ...(workspace?.entry ? { entry: workspace.entry } : {}),
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
