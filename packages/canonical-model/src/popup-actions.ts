import { z } from 'zod';
import {
  baseLayout,
  layoutDigest,
  LayoutTextSchema,
  type LayoutDefinition,
} from './layout.js';
import type {
  CanonicalId,
  CompiledPopupSchema,
  SurfaceComposition,
  SurfaceForm,
  SurfaceDocumentEditor,
} from './schemas.js';

export const POPUP_READER = 39;
const version = z.literal('v6');
const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const source = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: version, kind: z.literal('userEntry') }),
  z.strictObject({
    schemaVersion: version,
    kind: z.literal('recordField'),
    fieldId: id,
    contractVersion: digest,
  }),
  z.strictObject({
    schemaVersion: version,
    kind: z.literal('constant'),
    type: z.literal('text'),
    value: z.string().max(2000),
  }),
]);
export const PopupRevisionSchema = z.strictObject({
  schemaVersion: version,
  surface: id,
  slot: id,
  actionId: id.regex(/:action\.custom_/u),
  revisionId: z.uuid(),
  predecessor: z.uuid().nullable(),
  status: z.enum(['active', 'retired']),
  label: LayoutTextSchema,
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      schemaVersion: version,
      kind: z.literal('operation'),
      operationId: id,
      taskId: id,
      contractVersion: digest,
    }),
    z.strictObject({
      schemaVersion: version,
      kind: z.literal('update'),
      operationId: id,
      contractVersion: digest,
    }),
    z.strictObject({
      schemaVersion: version,
      kind: z.literal('workflowStart'),
      operationId: id,
      workflowId: id,
      contractVersion: digest,
    }),
  ]),
  inputs: z
    .array(
      z.strictObject({
        schemaVersion: version,
        binding: id,
        contractVersion: digest,
        source,
      }),
    )
    .max(12),
});
export type PopupRevision = z.infer<typeof PopupRevisionSchema>;
type Task = SurfaceComposition['actions'][number];
type Row = Record<string, unknown>;
type Field = {
  id: string;
  label: string;
  contractVersion: string;
  type: string;
  required: boolean;
  automatic: boolean;
  maximumLength?: number;
};
export interface PopupOption {
  surface: string;
  page: string;
  slot: string;
  label: string;
  target: Exclude<PopupRevision['target'], { kind: 'workflowStart' }>;
  fields: Field[];
  sources: Field[];
  existing: PopupRevision[];
  task?: Task;
}
const ref = (v: unknown) => (v as { targetId?: string } | undefined)?.targetId;
const canon = (value: string) => value as CanonicalId;
const systemBindings: Task['steps'][number]['bindings'] = [
  { path: ['recordId'], value: { source: 'record', field: 'recordId' } },
  {
    path: ['expectedRevision'],
    value: { source: 'record', field: 'revision' },
  },
];

export function popupOptions(
  def: LayoutDefinition,
  surface: Row,
): PopupOption[] {
  if (surface.surfaceRole !== 'record' || !baseLayout(def, surface, 'detail'))
    return [];
  const slot = (surface.slots as { slot: string; slotId: string }[]).find(
    (s) => s.slot === 'commandBar',
  )?.slotId;
  if (!slot) return [];
  const query = def.queries.find((q) => q.queryId === ref(surface.dataSource))!;
  const entity = ref(query.sourceEntity);
  const selected = new Set(
    (query.selections as { field: { targetId: string } }[]).map(
      (s) => s.field.targetId,
    ),
  );
  const composition = surface.composition as SurfaceComposition | undefined;
  const describe = (field: Row): Field => {
    const type = field.fieldType as Row;
    const id = String(field.fieldId);
    return {
      id,
      label: String(field.label),
      type: String(type.kind),
      required: field.presence === 'required',
      contractVersion: layoutDigest({
        entity,
        id,
        type,
        presence: field.presence,
        classification: field.classification,
      }),
      automatic:
        type.kind === 'textFieldType' &&
        !['item_base_unit', 'item_lifecycle', 'location_lifecycle'].includes(
          id.split(':field.')[1] ?? '',
        ),
      ...(typeof type.maximumLength === 'number'
        ? { maximumLength: type.maximumLength }
        : {}),
    };
  };
  const sources = def.fields
    .filter(
      (f) =>
        ref(f.entity) === entity &&
        selected.has(String(f.fieldId)) &&
        f.lifecycle !== 'retired',
    )
    .map(describe)
    .filter((f) => f.automatic);
  const common = {
    surface: String(surface.surfaceId),
    page: String(surface.label),
    slot,
    sources,
    existing: (surface.popupActions ?? []) as PopupRevision[],
  };
  const options: PopupOption[] = [];
  const ops = def.operations ?? [];
  for (const op of ops) {
    if (op.lifecycle === 'retired') continue;
    const operationId = String(op.operationId);
    const effect = op.effect as Row;
    const contract = {
      operationId,
      effect,
      permission: op.permission,
      readBack: op.readBack,
      tier: op.tier,
      confirmation: op.confirmation,
      guard: op.precondition ?? {
        kind: 'booleanPredicate',
        schemaVersion: 'v6',
        value: true,
      },
      capabilityVersion:
        (
          (def as LayoutDefinition & { capabilityRequirements?: Row[] })
            .capabilityRequirements ?? []
        ).find((c) => c.capabilityId === ref(effect.capability))
          ?.capabilityVersion ?? null,
      entity,
      query: query.queryId,
      scope: query.legalEntityScope ?? null,
    };
    if (effect.kind === 'updateRecordEffect' && ref(effect.entity) === entity) {
      const form = def.surfaces.find(
        (s) =>
          s.surfaceRole === 'form' &&
          def.queries.some(
            (q) =>
              q.queryId === ref(s.dataSource) && ref(q.sourceEntity) === entity,
          ),
      );
      const layout = form && baseLayout(def, form, 'edit');
      const editor = def.surfaces
        .map((s) => s.documentEditor as SurfaceDocumentEditor | undefined)
        .find((e) => form && e?.headerFormSurfaceId === form.surfaceId);
      const editable = new Set(
        layout?.sections.flatMap((s) =>
          s.fields.filter((f) => !editor || f.editorInput).map((f) => f.id),
        ) ?? [],
      );
      const fields = def.fields
        .filter(
          (f) =>
            editable.has(String(f.fieldId)) &&
            !f.numbering &&
            !(form?.form as SurfaceForm | undefined)?.references?.some(
              (r) => r.field === f.fieldId,
            ) &&
            !editor?.headerFields.find((h) => h.fieldId === f.fieldId)
              ?.reference,
        )
        .map(describe)
        .filter((f) =>
          [
            'textFieldType',
            'integerFieldType',
            'exactDecimalFieldType',
            'dateFieldType',
          ].includes(f.type),
        );
      if (fields.length)
        options.push({
          ...common,
          label: 'Update ' + String(surface.label),
          target: {
            kind: 'update',
            schemaVersion: 'v6',
            operationId,
            contractVersion: layoutDigest(contract),
          },
          fields,
        });
    }
    for (const task of composition?.actions ?? []) {
      // A single record Task already owns the full argument contract, state guards and effects preview.
      if (
        task.steps.length !== 1 ||
        task.steps[0]!.operation.targetId !== operationId ||
        task.rows ||
        task.datasetId ||
        task.presentation ||
        task.navigate
      )
        continue;
      const bindings = task.steps[0]!.bindings;
      if (
        !systemBindings.every((b) =>
          bindings.some((c) => layoutDigest(c) === layoutDigest(b)),
        )
      )
        continue;
      const fields = task.inputs.map((input) => ({
        id: String(input.inputId),
        label: input.label,
        type: input.type,
        required: input.required,
        contractVersion: layoutDigest(input),
        automatic:
          input.type === 'text' &&
          !input.presentation &&
          !task.stockImpacts &&
          bindings.some(
            (b) =>
              b.path.length === 2 &&
              b.path[0] === 'arguments' &&
              b.value.source === 'input' &&
              b.value.inputId === input.inputId,
          ) &&
          bindings
            .filter(
              (b) =>
                b.value.source === 'input' && b.value.inputId === input.inputId,
            )
            .every((b) => b.path[0] === 'arguments'),
      }));
      options.push({
        ...common,
        label: task.label,
        task,
        target: {
          kind: 'operation',
          schemaVersion: 'v6',
          operationId,
          taskId: task.actionId,
          contractVersion: layoutDigest({ contract, task }),
        },
        fields,
      });
    }
  }
  return options.map((o) => ({
    ...o,
    existing: o.existing.filter(
      (r) => r.target.contractVersion === o.target.contractVersion,
    ),
  }));
}

export function boundPopupOption(
  options: readonly PopupOption[],
  revision: PopupRevision,
) {
  const target = revision.target;
  return options.find(
    (o) =>
      o.surface === revision.surface &&
      o.slot === revision.slot &&
      o.target.kind === target.kind &&
      o.target.operationId === target.operationId &&
      (target.kind !== 'operation' || o.task?.actionId === target.taskId),
  );
}
export function resolvePopup(
  options: PopupOption[],
  revision: PopupRevision,
): Task {
  const target = revision.target;
  const option = boundPopupOption(options, revision);
  if (!option)
    throw new Error(
      'The record, action position or target operation is unavailable.',
    );
  if (option.target.contractVersion !== target.contractVersion)
    throw new Error('The operation contract changed.');
  if (
    !revision.actionId.startsWith(
      revision.surface.split(':')[0] + ':action.custom_',
    )
  )
    throw new Error('Use an action ID in this application.');
  if (
    new Set(revision.inputs.map((i) => i.binding)).size !==
    revision.inputs.length
  )
    throw new Error('A Task input is bound twice.');
  if (
    option.task
      ? option.fields.some(
          (f) => !revision.inputs.some((i) => i.binding === f.id),
        )
      : !revision.inputs.length
  )
    throw new Error('The Task is missing an input binding.');
  const inputs: Task['inputs'] = [];
  const bindings: Task['steps'][number]['bindings'] = [];
  for (const [order, input] of revision.inputs.entries()) {
    const field = option.fields.find((f) => f.id === input.binding);
    if (!field || field.contractVersion !== input.contractVersion)
      throw new Error('A bound input was removed or changed.');
    const value = input.source;
    const inputId = canon(input.binding);
    if (value.kind === 'userEntry') {
      const inherited = option.task?.inputs.find((i) => i.inputId === inputId);
      inputs.push(
        inherited
          ? { ...inherited, orderKey: order }
          : {
              inputId,
              label: field.label,
              type: 'text',
              orderKey: order,
              required: field.required,
            },
      );
      bindings.push({
        path: ['patch', field.id],
        value: { source: 'input', inputId },
      });
    } else {
      if (!field.automatic)
        throw new Error('This input requires a value entered by the person.');
      if (value.kind === 'recordField') {
        const from = option.sources.find(
          (f) =>
            f.id === value.fieldId &&
            f.contractVersion === value.contractVersion,
        );
        if (
          !from ||
          (from.type !== field.type &&
            !(field.type === 'text' && from.type === 'textFieldType')) ||
          (field.required && !from.required) ||
          (from.maximumLength ?? Infinity) > (field.maximumLength ?? Infinity)
        )
          throw new Error(
            'The record field is unavailable or has an incompatible contract.',
          );
        bindings.push({
          path: ['patch', field.id],
          value: { source: 'record', field: from.id },
        });
      } else {
        if (
          value.value.length > (field.maximumLength ?? Infinity) ||
          (field.required && !value.value.trim())
        )
          throw new Error('The constant does not fit the field.');
        bindings.push({
          path: ['patch', field.id],
          value: { source: 'literal', value: value.value },
        });
      }
    }
  }
  return {
    ...option.task,
    actionId: canon(revision.actionId),
    label: revision.label.text,
    description: option.task?.description ?? option.label,
    orderKey: 0,
    conditions: option.task?.conditions ?? [],
    inputs,
    steps: option.task?.steps.map((step) => ({
      ...step,
      bindings: step.bindings.map((b) => {
        const value = b.value;
        if (value.source !== 'input') return b;
        const replacement = bindings.find(
          (binding) => binding.path[1] === value.inputId,
        );
        return replacement ? { ...b, value: replacement.value } : b;
      }),
    })) ?? [
      {
        stepId: canon(revision.actionId),
        operation: {
          schemaVersion: 'v6',
          kind: 'operationReference',
          targetId: canon(target.operationId),
        },
        bindings: [...systemBindings, ...bindings],
      },
    ],
  };
}
export function compiledPopups(def: LayoutDefinition, surface: Row) {
  const options = popupOptions(def, surface);
  const all = surface.popupActions as PopupRevision[];
  const ids = all.map((r) => r.actionId);
  const base = surface.composition as SurfaceComposition | undefined;
  if (
    new Set(ids).size !== ids.length ||
    base?.actions.some((a) => ids.includes(a.actionId)) ||
    all.filter((r) => r.status === 'active').length > 3 ||
    all.some((r) => r.surface !== surface.surfaceId)
  )
    throw new Error(
      'The record has conflicting action IDs, positions or button count.',
    );
  return all.map((revision) => ({
    revision,
    ...(revision.status === 'active'
      ? { task: resolvePopup(options, revision) }
      : {}),
  }));
}
export type CompiledPopup = z.infer<typeof CompiledPopupSchema>;
