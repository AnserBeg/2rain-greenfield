import { randomUUID } from 'node:crypto';
import {
  baseLayout,
  LayoutModeSchema,
  LayoutTextSchema,
  layoutDigest,
  layoutProblem,
  type LayoutBody,
  type LayoutDefinition,
  type LayoutMode,
  type SurfaceLayout,
} from '@north-star/canonical-model';
import { z } from 'zod';

const id = z.string().min(1).max(512);
const version = z.literal('v6');
const positionSchema = z.union([
  z.strictObject({ edge: z.enum(['first', 'last']) }),
  z.strictObject({ before: id }),
  z.strictObject({ after: id }),
]);
const expect = z.string().regex(/^[a-f0-9]{64}$/u);
export const LayoutEditSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('createSection'),
    schemaVersion: version,
    id: z.string().regex(/^tenant-section\/[0-9a-f-]{36}$/u),
    parent: id,
    label: LayoutTextSchema,
    position: positionSchema,
    expected: expect,
  }),
  z.strictObject({
    kind: z.literal('rename'),
    schemaVersion: version,
    id,
    parent: id,
    label: LayoutTextSchema,
    expected: expect,
  }),
  z.strictObject({
    kind: z.literal('move'),
    schemaVersion: version,
    id,
    parent: id,
    destination: id,
    position: positionSchema,
    expected: expect,
  }),
]);
export const LayoutRevisionSchema = z.strictObject({
  kind: z.literal('addLayoutRevision'),
  schemaVersion: version,
  surface: id,
  mode: LayoutModeSchema,
  scope: z.strictObject({ kind: z.literal('tenant'), schemaVersion: version }),
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  edits: z.array(LayoutEditSchema).min(1).max(64),
  resultLayoutDigest: expect,
});
type Edit = z.infer<typeof LayoutEditSchema>;
type WithoutExpectation<E> = E extends Edit ? Omit<E, 'expected'> : never;
export type LayoutIntent = WithoutExpectation<Edit>;
export type LayoutRevision = z.infer<typeof LayoutRevisionSchema>;
export interface LayoutTarget {
  label: string;
  predecessor: string | null;
  body: LayoutBody;
}
export function currentLayout(
  def: LayoutDefinition,
  surface: Record<string, unknown>,
  mode: LayoutMode,
): LayoutTarget | null {
  const base = baseLayout(def, surface, mode);
  if (!base) return null;
  const current = (surface.layouts as SurfaceLayout[] | undefined)?.find(
    (l) => l.body.mode === mode,
  );
  return {
    label: String(surface.label),
    predecessor: current?.revisionId ?? null,
    body: current?.body ?? base,
  };
}
function locate(b: LayoutBody, id: string) {
  const section = b.sections.find((s) => s.id === id);
  const block = b.blocks.find((s) => s.id === id);
  if (section || block)
    return { parent: b.slotId, siblings: b.order, item: section ?? block! };
  for (const s of b.sections) {
    const field = s.fields.find((f) => f.id === id);
    if (field)
      return { parent: s.id, siblings: s.fields.map((f) => f.id), item: field };
  }
  return null;
}
function source(b: LayoutBody, id: string) {
  const at = locate(b, id);
  if (!at) return null;
  const index = at.siblings.indexOf(id);
  return {
    parent: at.parent,
    before: at.siblings[index - 1] ?? null,
    after: at.siblings[index + 1] ?? null,
    item: at.item,
  };
}
function expectation(b: LayoutBody, e: LayoutIntent) {
  const dest = e.kind === 'move' ? e.destination : e.parent;
  const anchor =
    'position' in e && !('edge' in e.position)
      ? 'before' in e.position
        ? e.position.before
        : e.position.after
      : null;
  return layoutDigest({
    surface: b.surfaceId,
    mode: b.mode,
    slot: b.slotId,
    member: source(b, e.id),
    destination: dest === b.slotId ? b.order : source(b, dest),
    anchor: anchor ? source(b, anchor) : null,
  });
}
function insertAt(ids: string[], p: z.infer<typeof positionSchema>) {
  if ('edge' in p) return p.edge === 'first' ? 0 : ids.length;
  const i = ids.indexOf('before' in p ? p.before : p.after);
  if (i < 0) throw new Error('The sibling anchor is outside the destination.');
  return i + Number('after' in p);
}
function applyEdit(b: LayoutBody, e: Edit) {
  if (expectation(b, e) !== e.expected)
    throw new Error(
      'The source binding, placement or previous value has changed.',
    );
  const at = locate(b, e.id);
  if (e.kind === 'createSection') {
    if (at || e.parent !== b.slotId)
      throw new Error('Choose a new section ID in the declared slot.');
    b.order.splice(insertAt(b.order, e.position), 0, e.id);
    b.sections.push({ id: e.id, label: e.label, fields: [] });
  } else {
    if (!at || at.parent !== e.parent)
      throw new Error('The member has moved or retired.');
    if (e.kind === 'rename') {
      if ('slotId' in at.item)
        throw new Error('Protected blocks keep their declared labels.');
      at.item.label = e.label;
    } else if ('binding' in at.item) {
      const from = b.sections.find((s) => s.id === e.parent)!;
      const to = b.sections.find((s) => s.id === e.destination);
      if (!to) throw new Error('A field needs a destination section.');
      from.fields.splice(
        from.fields.findIndex((f) => f.id === e.id),
        1,
      );
      to.fields.splice(
        insertAt(
          to.fields.map((f) => f.id),
          e.position,
        ),
        0,
        at.item,
      );
    } else {
      if (e.destination !== b.slotId)
        throw new Error('A section or protected block must stay in the body.');
      b.order.splice(b.order.indexOf(e.id), 1);
      b.order.splice(insertAt(b.order, e.position), 0, e.id);
    }
  }
  b.sections.sort((a, c) => b.order.indexOf(a.id) - b.order.indexOf(c.id));
}
export function draftLayoutRevision(
  target: LayoutTarget,
  intents: LayoutIntent[],
): LayoutRevision {
  const b = structuredClone(target.body);
  const edits = intents.map((intent) => {
    const edit = LayoutEditSchema.parse({
      ...intent,
      expected: expectation(b, intent),
    });
    applyEdit(b, edit);
    return edit;
  });
  return LayoutRevisionSchema.parse({
    kind: 'addLayoutRevision',
    schemaVersion: 'v6',
    surface: b.surfaceId,
    mode: b.mode,
    scope: { kind: 'tenant', schemaVersion: 'v6' },
    revisionId: randomUUID(),
    predecessor: target.predecessor,
    edits,
    resultLayoutDigest: layoutDigest(b),
  });
}
export function applyLayoutRevision(
  def: LayoutDefinition,
  patch: LayoutRevision,
): string | null {
  const s = def.surfaces.find((v) => v.surfaceId === patch.surface);
  const target = s && currentLayout(def, s, patch.mode);
  if (!s || !target) return 'This surface and mode cannot be arranged.';
  if (
    target.predecessor !== patch.predecessor ||
    patch.predecessor === patch.revisionId
  )
    return 'The predecessor of this layout revision differs.';
  const body = structuredClone(target.body);
  try {
    for (const edit of patch.edits) applyEdit(body, edit);
  } catch (error) {
    return (error as Error).message;
  }
  const layout = {
    body,
    revisionId: patch.revisionId,
    resultLayoutDigest: patch.resultLayoutDigest,
  };
  const problem = layoutProblem(layout, baseLayout(def, s, patch.mode));
  if (problem) return problem;
  const existing = (s.layouts as SurfaceLayout[] | undefined) ?? [];
  s.layouts = [
    ...existing.filter((l) => l.body.mode !== patch.mode),
    layout,
  ].sort((a, b) => a.body.mode.localeCompare(b.body.mode, 'en'));
  return null;
}

/** Both authoring channels resolve ids and anchor the edit to the layout they showed. */
export function layoutCommand(
  target: LayoutTarget,
  command: {
    action: string;
    member?: string | undefined;
    destination?: string | undefined;
    label?: string | undefined;
  },
) {
  const b = target.body;
  const label = () =>
    LayoutTextSchema.parse({ schemaVersion: 'v6', text: command.label });
  if (command.action === 'create')
    return draftLayoutRevision(target, [
      {
        kind: 'createSection',
        schemaVersion: 'v6',
        id: 'tenant-section/' + randomUUID(),
        parent: b.slotId,
        position: { edge: 'last' },
        label: label(),
      },
    ]);
  const member = command.member ?? '';
  const at = locate(b, member);
  if (!at) throw new Error('Choose a section, field or block from this page.');
  if (command.action === 'rename')
    return draftLayoutRevision(target, [
      {
        kind: 'rename',
        schemaVersion: 'v6',
        id: member,
        parent: at.parent,
        label: label(),
      },
    ]);
  let destination = at.parent;
  let position: z.infer<typeof positionSchema>;
  if (command.action === 'move') {
    if (!command.destination) throw new Error('Choose a destination section.');
    destination = command.destination;
    position = { edge: 'last' };
  } else {
    const i = at.siblings.indexOf(member);
    if (command.action === 'up' && i > 0)
      position = { before: at.siblings[i - 1]! };
    else if (command.action === 'down' && i < at.siblings.length - 1)
      position = { after: at.siblings[i + 1]! };
    else throw new Error('Choose a position inside this group.');
  }
  return draftLayoutRevision(target, [
    {
      kind: 'move',
      schemaVersion: 'v6',
      id: member,
      parent: at.parent,
      destination,
      position,
    },
  ]);
}
