import type { EditLocation, ReplayConflict } from './upgrade-diagnostics.js';
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
/** The document editor declares at least one header input. Ordinary forms bind their own fields. */
export function arrangeableLayoutFields(
  body: LayoutBody,
  section: LayoutBody['sections'][number],
) {
  const editor =
    body.mode !== 'detail' &&
    body.sections.some((s) => s.fields.some((f) => f.editorInput));
  const fields = editor
    ? section.fields.filter((f) => f.editorInput)
    : section.fields;
  return [
    ...fields.filter((f) => f.tier === 'always'),
    ...fields.filter((f) => f.tier === 'progressive'),
  ];
}

/** Extend each adopted layout from the newly declared field contract, preserving the owner's placements. */
export function placeAddedLayoutField(def: LayoutDefinition, fieldId: string) {
  for (const surface of def.surfaces) {
    for (const layout of (surface.layouts as SurfaceLayout[] | undefined) ??
      []) {
      const body = layout.body;
      const base = baseLayout(def, surface, body.mode);
      const section = base?.sections.find((s) =>
        s.fields.some((f) => f.id === fieldId),
      );
      if (!section) continue;
      const index = section.fields.findIndex((f) => f.id === fieldId);
      const field = section.fields[index]!;
      const existing = body.sections
        .flatMap((s) => s.fields)
        .find((f) => f.id === fieldId);
      if (existing) {
        // Publishing screens for a historical query-only field binds its existing placement.
        Object.assign(existing, field, { label: existing.label });
      } else {
        placeAfterBasePredecessor(body, section.fields, index);
      }
      layout.resultLayoutDigest = layoutDigest(body);
    }
  }
}

function placeAfterBasePredecessor(
  body: LayoutBody,
  baseFields: LayoutBody['sections'][number]['fields'],
  index: number,
) {
  const predecessor = baseFields[index - 1];
  const field = baseFields[index]!;
  const destination = body.sections.find((section) =>
    section.fields.some((f) => f.id === predecessor?.id),
  );
  if (destination) {
    const at = destination.fields.findIndex((f) => f.id === predecessor!.id);
    destination.fields.splice(at + 1, 0, field);
  } else body.sections[0]!.fields.push(field);
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
function applyEdit(b: LayoutBody, e: Edit, verifyDigest = true) {
  if (verifyDigest && expectation(b, e) !== e.expected)
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
export type LayoutReplayFinding = ReplayConflict & { editIndex: number };
export interface LayoutReplay {
  source: LayoutBody;
  findings: LayoutReplayFinding[];
  externalFailures?: ReadonlyMap<string, EditLocation>;
  blocked: { editIndex: number; blockedBy: number | EditLocation }[];
}

function structuralConflict(
  sourceBody: LayoutBody,
  body: LayoutBody,
  edit: Edit,
): ReplayConflict | undefined {
  const destination = edit.kind === 'move' ? edit.destination : edit.parent;
  const anchor =
    'position' in edit && !('edge' in edit.position)
      ? 'before' in edit.position
        ? edit.position.before
        : edit.position.after
      : undefined;
  const ids = new Set(
    [edit.id, destination, anchor].filter((id): id is string => !!id),
  );
  const section =
    edit.kind === 'move' && sourceBody.sections.find((s) => s.id === edit.id);
  if (section) for (const field of section.fields) ids.add(field.id);
  for (const id of ids) {
    if (id === body.slotId) continue;
    const before = locate(sourceBody, id);
    const after = locate(body, id);
    if (!before && !after && edit.kind === 'createSection' && id === edit.id)
      continue;
    const expected = before?.parent ?? null;
    const observed = after?.parent ?? null;
    if (!after)
      return { code: 'RETIRED_TARGET', subject: id, expected, observed };
    if (!before || observed !== expected)
      return { code: 'MOVED_MEMBER', subject: id, expected, observed };
    if ('binding' in before.item) {
      const old = before.item;
      const next = after.item;
      if (
        !('binding' in next) ||
        old.contractDigest !== next.contractDigest ||
        old.required !== next.required ||
        old.editorInput !== next.editorInput ||
        old.tier !== next.tier
      )
        return {
          code: 'INCOMPATIBLE_TYPE',
          subject: id,
          expected: old,
          observed: next,
        };
    }
    // Ignore additions and removals elsewhere. A touched member crossing an existing
    // sibling has moved even if its parent ID still matches.
    const peers = before.siblings.filter((peer) =>
      after.siblings.includes(peer),
    );
    const actual = after.siblings.filter((peer) => peers.includes(peer));
    if (
      peers
        .slice(0, peers.indexOf(id))
        .some((peer) => actual.indexOf(peer) > actual.indexOf(id)) ||
      peers
        .slice(peers.indexOf(id) + 1)
        .some((peer) => actual.indexOf(peer) < actual.indexOf(id))
    )
      return {
        code: 'MOVED_MEMBER',
        subject: id,
        expected: peers,
        observed: actual,
      };
  }
  return;
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
  replay?: LayoutReplay,
): string | null {
  const s = def.surfaces.find((v) => v.surfaceId === patch.surface);
  const target = s && currentLayout(def, s, patch.mode);
  if (!s || !target) {
    replay?.findings.push({
      code: 'RETIRED_TARGET',
      subject: patch.surface,
      expected: patch.mode,
      observed: null,
      editIndex: 0,
    });
    return 'This surface and mode cannot be arranged.';
  }
  if (
    target.predecessor !== patch.predecessor ||
    patch.predecessor === patch.revisionId
  )
    return 'The predecessor of this layout revision differs.';
  const body = structuredClone(target.body);
  const original = replay && structuredClone(replay.source);
  const base = baseLayout(def, s, patch.mode)!;
  const setAside = new Set<string>();
  if (original) {
    const known = new Set(
      original.sections.flatMap((section) => section.fields.map((f) => f.id)),
    );
    for (const section of body.sections) {
      for (const field of section.fields)
        if (!known.has(field.id)) setAside.add(field.id);
      section.fields = section.fields.filter((f) => !setAside.has(f.id));
    }
  }
  const failed = new Map<string, number | EditLocation>(
    replay?.externalFailures,
  );
  try {
    for (const [editIndex, edit] of patch.edits.entries()) {
      if (original && replay) {
        const refs = [edit.id, edit.parent];
        if (edit.kind === 'move') refs.push(edit.destination);
        if ('position' in edit && !('edge' in edit.position))
          refs.push(
            'before' in edit.position
              ? edit.position.before
              : edit.position.after,
          );
        const blockedBy = refs
          .map((id) => failed.get(id))
          .find((index) => index !== undefined);
        const conflict = structuralConflict(original, body, edit);
        applyEdit(original, edit, false);
        if (blockedBy !== undefined || conflict) {
          if (blockedBy !== undefined)
            replay.blocked.push({ editIndex, blockedBy });
          else replay.findings.push({ ...conflict!, editIndex });
          if (edit.kind !== 'rename')
            failed.set(edit.id, blockedBy ?? editIndex);
          continue;
        }
      }
      const section = body.sections.find((s) => s.id === edit.parent);
      const field = section?.fields.find((f) => f.id === edit.id);
      if (!section || !field) {
        applyEdit(body, edit, !original);
        continue;
      }
      const visible = arrangeableLayoutFields(body, section);
      if (!visible.some((f) => f.id === field.id))
        return `${field.label.text} has no input in the document editor.`;
      const oldPosition = visible.findIndex((f) => f.id === field.id);
      applyEdit(body, edit, !original);
      if (
        edit.kind === 'move' &&
        edit.destination === section.id &&
        arrangeableLayoutFields(body, section)[oldPosition]?.id === field.id
      )
        return 'This move leaves the field in the same place. Reorder it within its up-front or More details group.';
    }
  } catch (error) {
    return (error as Error).message;
  }
  if (replay && (replay.findings.length || replay.blocked.length))
    return 'The layout conflicts with the destination.';
  for (const section of base.sections) {
    for (const [index, field] of section.fields.entries())
      if (setAside.has(field.id))
        placeAfterBasePredecessor(body, section.fields, index);
  }
  const layout = {
    body,
    ...(replay ? { placementRuleVersion: 1 as const } : {}),
    revisionId: patch.revisionId,
    resultLayoutDigest: replay ? layoutDigest(body) : patch.resultLayoutDigest,
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
    const section = b.sections.find((s) => s.id === at.parent);
    const item = at.item;
    const siblings =
      section && 'tier' in item
        ? arrangeableLayoutFields(b, section)
            .filter((f) => f.tier === item.tier)
            .map((f) => f.id)
        : at.siblings;
    const i = siblings.indexOf(member);
    if (command.action === 'up' && i > 0)
      position = { before: siblings[i - 1]! };
    else if (command.action === 'down' && i >= 0 && i < siblings.length - 1)
      position = { after: siblings[i + 1]! };
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
