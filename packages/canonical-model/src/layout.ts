import { z } from 'zod';
import type { CalculatedDisplayField } from './calculated-display-schema.js';
import { canonicalize, canonicalizeAndHash } from './canonicalize.js';
import type {
  SurfaceComposition,
  SurfaceDocumentEditor,
  SurfaceForm,
} from './schemas.js';

export const LAYOUT_READER = 28;
export const REPLAYED_LAYOUT_READER = 34;
export const CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS = [
  'item',
  'location',
  'party',
  'purchase_order',
  'sales_order',
] as const;
export const LayoutModeSchema = z.enum(['create', 'edit', 'detail']);
export const LayoutTextSchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  text: z.string().trim().min(1).max(240),
});
const id = z.string().min(1).max(512);
const memberSchema = z.strictObject({
  id,
  binding: id,
  bindingType: id,
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  editorInput: z.boolean(),
  label: LayoutTextSchema,
  required: z.boolean(),
  tier: z.enum(['always', 'progressive']),
  visibility: z.literal('shown'),
});
const sectionSchema = z.strictObject({
  id,
  label: LayoutTextSchema,
  fields: z.array(memberSchema).max(256),
});
export const LayoutBodySchema = z.strictObject({
  schemaVersion: z.literal('v6'),
  surfaceId: id,
  mode: LayoutModeSchema,
  slotId: id,
  sections: z.array(sectionSchema).min(1).max(40),
  blocks: z
    .array(
      z.strictObject({
        id,
        slotId: id,
        label: LayoutTextSchema,
        kind: z.enum(['progression', 'children']),
      }),
    )
    .max(2),
  order: z.array(id).min(1).max(42),
});
export const SurfaceLayoutSchema = z.strictObject({
  placementRuleVersion: z.literal(1).optional(),
  revisionId: z.uuid(),
  resultLayoutDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  body: LayoutBodySchema,
});
export type LayoutBody = z.infer<typeof LayoutBodySchema>;
export type SurfaceLayout = z.infer<typeof SurfaceLayoutSchema>;
export type LayoutMode = LayoutBody['mode'];
type Field = LayoutBody['sections'][number]['fields'][number];
export const layoutText = (text: string) => ({
  schemaVersion: 'v6' as const,
  text,
});
export const layoutDigest = (value: unknown) =>
  canonicalizeAndHash(value).contentHash;

type Row = Record<string, unknown>;
export interface LayoutDefinition {
  readonly fields: readonly Row[];
  readonly surfaces: readonly Row[];
  readonly queries: readonly Row[];
  readonly operations?: readonly Row[];
  readonly relations?: readonly Row[];
  readonly languageVersion?: string;
  readonly calculatedDisplayFields?:
    readonly CalculatedDisplayField[] | undefined;
}
const ref = (value: unknown) =>
  (value as { targetId?: string } | undefined)?.targetId;
const byOrder = (a: { orderKey: number }, b: { orderKey: number }) =>
  a.orderKey - b.orderKey;
export function baseLayout(
  def: LayoutDefinition,
  surface: Row,
  mode: LayoutMode,
  contracts?: Map<string, Record<string, unknown>>,
): LayoutBody | null {
  if (
    def.languageVersion !== 'v6' ||
    surface.archetype !== 'record' ||
    surface.lifecycle === 'retired' ||
    surface.surfaceRole !== (mode === 'detail' ? 'record' : 'form')
  )
    return null;
  const query = def.queries.find((q) => q.queryId === ref(surface.dataSource));
  const entity = ref(query?.sourceEntity);
  if (!entity || query?.queryType !== 'get') return null;
  const local = entity.split(':entity.')[1] ?? '';
  if (
    !(CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS as readonly string[]).includes(
      local,
    ) &&
    !local.startsWith('custom_')
  )
    return null;
  if (
    def.relations?.some(
      (r) =>
        r.ownership === 'parentScopedChild' && ref(r.sourceEntity) === entity,
    )
  )
    return null;
  const slots = surface.slots as { slot: string; slotId: string }[];
  const slotId = slots.find((s) => s.slot === 'sections')?.slotId;
  if (!slotId) return null;
  const surfaceId = String(surface.surfaceId);
  const builtin = (key: string) => [surfaceId, mode, slotId, key].join('/');
  const editor = def.surfaces
    .map((s) => s.documentEditor as SurfaceDocumentEditor | undefined)
    .find((e) => e?.headerFormSurfaceId === surfaceId);
  const c = surface.composition as SurfaceComposition | undefined;
  const form = surface.form as SurfaceForm | undefined;
  const selections = [
    ...(query.selections as {
      field: { targetId: string };
      orderKey: number;
    }[]),
  ].sort(byOrder);
  const definitions = new Map(def.fields.map((f) => [String(f.fieldId), f]));
  const operations =
    mode === 'detail'
      ? []
      : (def.operations ?? []).filter(
          (o) =>
            o.lifecycle !== 'retired' &&
            (o.effect as Row)?.kind ===
              (mode === 'create'
                ? 'createRecordEffect'
                : 'updateRecordEffect') &&
            ref((o.effect as Row).entity) === entity,
        );
  if (mode !== 'detail' && operations.length !== 1) return null;
  const members: Field[] = [];
  const sections: LayoutBody['sections'] = [
    {
      id: builtin('details'),
      label: layoutText(
        mode === 'detail' ? 'Details' : (editor?.headerLabel ?? 'Details'),
      ),
      fields: members,
    },
  ];
  const blocks: LayoutBody['blocks'] = [];
  function add(
    fieldId: string,
    binding: string,
    bindingType: string,
    label: string,
    required: boolean,
    more: boolean,
    into = members,
    calculation?: CalculatedDisplayField,
  ) {
    const contract = {
      owner: entity,
      operation: operations[0]?.operationId ?? null,
      query: query!.queryId,
      mode,
      field: fieldId,
      binding,
      type: definitions.get(fieldId)?.fieldType ?? null,
      ...(calculation && { calculation }),
      reference: form?.references?.find((r) => r.field === fieldId) ?? null,
      editor:
        [
          ...(editor?.headerFields ?? []),
          ...(editor?.headerRelations ?? []),
        ].find((f) => f.fieldId === fieldId) ?? null,
      column:
        c?.fields.find((col) => col.columnId === binding)?.reference ?? null,
    };
    contracts?.set(fieldId, contract);
    into.push({
      id: fieldId,
      binding,
      bindingType,
      contractDigest: layoutDigest(contract),
      editorInput:
        !!editor &&
        [
          ...editor.headerFields,
          ...(mode === 'create' ? (editor.headerRelations ?? []) : []),
        ].some((f) => f.fieldId === fieldId),
      label: layoutText(label),
      required,
      tier:
        more && !required && !fieldId.endsWith(':field.item_base_unit')
          ? 'progressive'
          : 'always',
      visibility: 'shown',
    });
  }
  if (mode === 'detail' && c) {
    const header = c.presentation?.header;
    const fixed = new Set([
      header?.title,
      header?.status,
      ...(header?.subtitle ?? []),
      ...(header?.facts ?? []),
      ...(c.presentation?.print?.totals ?? []),
    ]);
    const groups = new Map<string, Field[]>();
    for (const group of c.presentation?.blocks ?? []) {
      // Historical sales order releases predate section IDs. This permanent
      // platform key identifies their shipping-address group across relabels.
      if (!group.columns.some((id) => id.endsWith(':column.ship_to_name')))
        return null;
      const key = 'shipping-address';
      const fields: Field[] = [];
      sections.push({
        id: builtin('group/' + key),
        label: layoutText(group.label),
        fields,
      });
      for (const column of group.columns) groups.set(column, fields);
    }
    for (const col of [...c.fields].sort(byOrder)) {
      if (fixed.has(col.columnId)) continue;
      const field = definitions.get(col.field);
      add(
        col.field,
        col.columnId,
        'query:' +
          String((field?.fieldType as Row | undefined)?.kind ?? 'result'),
        col.label,
        field?.presence === 'required',
        !!header && members.length >= 8,
        groups.get(col.columnId),
      );
    }
    for (const calculation of def.calculatedDisplayFields ?? []) {
      if (
        calculation.entityId === entity &&
        calculation.displaySinks.some(
          (sink) => sink.kind === 'record' && sink.surfaceId === surfaceId,
        )
      ) {
        add(
          calculation.fieldId,
          calculation.fieldId,
          'query:calculatedDisplay',
          calculation.label,
          false,
          !!header && members.length >= 8,
          members,
          calculation,
        );
      }
    }
    if (c.presentation?.progression)
      blocks.push({
        id: builtin('progression'),
        slotId,
        kind: 'progression',
        label: layoutText('Progress and next step'),
      });
    const childSlot = slots.find((s) => s.slot === 'childTables');
    if (childSlot && c.children.some((d) => !d.presentation?.rail))
      blocks.push({
        id: builtin('children'),
        slotId: childSlot.slotId,
        kind: 'children',
        label: layoutText('Tables and totals'),
      });
  } else {
    const header = [
      ...(editor?.headerFields ?? []),
      ...(mode === 'create' ? (editor?.headerRelations ?? []) : []),
    ];
    const ordered = [
      ...new Set([
        ...header.map((f) => String(f.fieldId)),
        ...selections.map((s) => s.field.targetId),
      ]),
    ];
    for (const fieldId of ordered) {
      const f = definitions.get(fieldId);
      const ef = header.find((f) => f.fieldId === fieldId);
      const ff = form?.fields?.find((f) => f.fieldId === fieldId);
      if (
        mode !== 'detail' &&
        (!f ||
          f.lifecycle === 'retired' ||
          f.numbering ||
          fieldId.includes(':derived_state_field.') ||
          form?.omit?.some((id) => id === fieldId))
      )
        continue;
      const required = f?.presence === 'required';
      add(
        fieldId,
        fieldId,
        String((f?.fieldType as Row | undefined)?.kind ?? 'queryValue'),
        ef?.label ?? ff?.label ?? String(f?.label ?? fieldId),
        required,
        ((ef && 'disclosure' in ef ? ef.disclosure : undefined) ??
          ff?.disclosure) === 'more',
      );
    }
    if (mode === 'create')
      for (const relation of def.relations ?? []) {
        if (
          ref(relation.sourceEntity) !== entity ||
          relation.lifecycle === 'retired'
        )
          continue;
        const relationId = String(relation.relationId);
        const ef = editor?.headerRelations?.find(
          (f) => f.fieldId === relationId,
        );
        add(
          relationId,
          relationId,
          'relation:' + String(ref(relation.targetEntity)),
          ef?.label ?? relationId.split('.').at(-1)!.replaceAll('_', ' '),
          relation.required === true,
          false,
        );
      }
  }
  const order = [...blocks.map((b) => b.id), ...sections.map((s) => s.id)];
  return {
    schemaVersion: 'v6',
    surfaceId,
    mode,
    slotId,
    sections,
    blocks,
    order,
  };
}
export function layoutProblem(
  layout: SurfaceLayout,
  base: LayoutBody | null,
): string | null {
  if (!base) return 'This surface and mode do not declare a compatible slot.';
  const { body } = layout;
  if (layoutDigest(body) !== layout.resultLayoutDigest)
    return 'The effective layout digest differs.';
  if (
    body.slotId !== base.slotId ||
    canonicalize(body.blocks) !== canonicalize(base.blocks)
  )
    return 'The declared slot or protected block bindings differ.';
  const ids = body.sections.map((s) => s.id);
  const baseIds = base.sections.map((s) => s.id);
  const order = [...ids, ...body.blocks.map((b) => b.id)];
  if (
    new Set(order).size !== order.length ||
    baseIds.some((id) => !ids.includes(id)) ||
    ids.some(
      (id) =>
        !baseIds.includes(id) && !/^tenant-section\/[0-9a-f-]{36}$/u.test(id),
    ) ||
    canonicalize([...order].sort()) !== canonicalize([...body.order].sort())
  )
    return 'Every section and protected block needs one placement in the body.';
  const contracts = (b: LayoutBody) =>
    b.sections
      .flatMap((s) => s.fields)
      .map((f) => canonicalize({ ...f, label: null }))
      .sort();
  if (
    canonicalize(body.order.filter((id) => ids.includes(id))) !==
    canonicalize(ids)
  )
    return 'The section order differs from the visible order.';
  const fields = body.sections.flatMap((s) => s.fields.map((f) => f.id));
  if (new Set(fields).size !== fields.length)
    return 'Each stable field has one placement.';
  if (canonicalize(contracts(base)) !== canonicalize(contracts(body)))
    return 'Every bound field needs exactly one compatible placement.';
  return null;
}
