import {
  baseLayout,
  type LayoutBody,
  type LayoutDefinition,
  type SurfaceLayout,
} from '@north-star/canonical-model';
import { createHash } from 'node:crypto';

import type { CalculatedDisplayField } from '@north-star/canonical-model';
import type { ReleaseDiffEnvelope } from '@north-star/compiler';

/**
 * The plain-language release diff an approver reads (plan §11.9 item 9). It is
 * rendered from the compiler's diff envelope and the two normalized
 * definitions, never from the patch, so what the approver sees is what the
 * release actually changes. The rendered digest hashes exactly these bytes and
 * the approval binds it beside the canonical diff digest.
 */
export const RENDERED_DIFF_VERSION =
  'northstar.customization-rendered-diff/v1' as const;

type Json = Record<string, unknown>;

export interface DiffDefinition extends LayoutDefinition {
  readonly documentFields?: readonly {
    readonly fieldId: string;
    readonly entityId: string;
    readonly label: string;
    readonly maxCount: number;
    readonly required: boolean;
    readonly allowedCategoryIds: readonly string[];
  }[];
  readonly documentCategories?: readonly {
    readonly categoryId: string;
    readonly label: string;
  }[];
  readonly entities: readonly Json[];
  readonly fields: readonly Json[];
  readonly operations?: readonly Json[];
  readonly calculatedDisplayFields?: readonly CalculatedDisplayField[];
  readonly formulaRules?: readonly {
    readonly ruleId: string;
    readonly targetId: string;
    readonly message: string;
  }[];
  readonly operationRoleNarrowings?: readonly {
    readonly operationId: string;
    readonly roleKey: string;
  }[];
  readonly surfaces: readonly Json[];
  readonly relations?: readonly Json[];
  readonly stateMachines?: readonly Json[];
}

export interface StorageChange {
  readonly kind: string;
}

export interface RenderedReleaseDiff {
  readonly lines: readonly string[];
  readonly renderedDigest: string;
  readonly text: string;
}

export function renderReleaseDiff(input: {
  readonly diff: ReleaseDiffEnvelope;
  readonly from: DiffDefinition;
  readonly storage: readonly StorageChange[];
  readonly to: DiffDefinition;
  /** A rollback reads its forward diff backwards. */
  readonly direction?: 'forward' | 'reverse';
}): RenderedReleaseDiff {
  const { diff, from, to } = input;
  const reverse = input.direction === 'reverse';
  const added = (kind: string) =>
    diff.changes.filter(
      (change) =>
        change.constructKind === kind && change.changeKind === 'added',
    );
  const changed = (kind: string) =>
    diff.changes.filter(
      (change) =>
        change.constructKind === kind && change.changeKind === 'changed',
    );
  const removed = diff.changes.filter(
    (change) =>
      change.changeKind === 'removed' && change.constructKind !== 'projection',
  );
  const entityLabel = (definition: DiffDefinition, entityId: string) =>
    String(
      definition.entities.find((entity) => entity.entityId === entityId)
        ?.label ?? entityId,
    );
  const lines: string[] = [];
  for (const field of to.documentFields ?? []) {
    if (from.documentFields?.some(({ fieldId }) => fieldId === field.fieldId))
      continue;
    const names = field.allowedCategoryIds.map(
      (id) =>
        to.documentCategories?.find(({ categoryId }) => categoryId === id)
          ?.label ?? id,
    );
    lines.push(
      `Adds the files field “${field.label}” to ${entityLabel(to, field.entityId)}. Maximum ${field.maxCount}. ${field.required ? 'Required to complete a document task.' : 'Optional.'} ${names.length ? `Categories ${names.join(', ')}.` : 'Accepts uncategorized files.'}`,
    );
  }
  for (const field of from.documentFields ?? []) {
    if (!to.documentFields?.some(({ fieldId }) => fieldId === field.fieldId))
      lines.push(
        `Removes the files field “${field.label}” from ${entityLabel(from, field.entityId)}. Its files stay in retention.`,
      );
  }
  const operandLabel = (
    operand: CalculatedDisplayField['expression']['left'],
  ) =>
    operand.kind === 'decimalLiteral'
      ? operand.value
      : String(
          to.fields.find(({ fieldId }) => fieldId === operand.fieldId)?.label ??
            operand.fieldId,
        );
  for (const field of to.calculatedDisplayFields ?? []) {
    if (
      from.calculatedDisplayFields?.some(
        ({ fieldId }) => fieldId === field.fieldId,
      )
    )
      continue;
    const { left, right, operator } = field.expression;
    const type = field.resultType;
    const sign = { add: '+', subtract: '−', multiply: '×' }[operator];
    const destinations = field.displaySinks.map(({ surfaceId }) =>
      String(
        to.surfaces.find((surface) => surface.surfaceId === surfaceId)?.label ??
          surfaceId,
      ),
    );
    lines.push(
      `Shows “${field.label}” on ${destinations.join(' and ')} as ${operandLabel(left)} ${sign} ${operandLabel(right)}. The exact value has up to ${type.precision} digits and ${type.scale} decimal places${type.currency ? ` in ${type.currency}` : ''}.`,
    );
  }
  for (const field of from.calculatedDisplayFields ?? []) {
    if (
      !to.calculatedDisplayFields?.some(
        ({ fieldId }) => fieldId === field.fieldId,
      )
    )
      lines.push(
        `Removes the calculated display field “${field.label}” from ${entityLabel(from, field.entityId)}.`,
      );
  }
  for (const rule of to.formulaRules ?? []) {
    if (!from.formulaRules?.some(({ ruleId }) => ruleId === rule.ruleId))
      lines.push(
        `Checks ${entityLabel(to, rule.targetId)} on save. The form shows “${rule.message}” when the check fails. Existing records keep their values.`,
      );
  }
  for (const rule of from.formulaRules ?? []) {
    if (!to.formulaRules?.some(({ ruleId }) => ruleId === rule.ruleId))
      lines.push(
        `Removes the save check “${rule.message}” from ${entityLabel(from, rule.targetId)}.`,
      );
  }
  for (const entry of to.operationRoleNarrowings ?? []) {
    if (
      from.operationRoleNarrowings?.some(
        (before) =>
          before.operationId === entry.operationId &&
          before.roleKey === entry.roleKey,
      )
    )
      continue;
    const action = to.operations?.find(
      (operation) => operation.operationId === entry.operationId,
    );
    const label =
      action?.label ??
      entry.operationId.split(':operation.').at(-1)!.replaceAll('_', ' ');
    lines.push(
      `Role "${entry.roleKey}" can no longer grant access to "${String(label)}".`,
    );
  }
  for (const entry of from.operationRoleNarrowings ?? []) {
    if (
      to.operationRoleNarrowings?.some(
        (after) =>
          after.operationId === entry.operationId &&
          after.roleKey === entry.roleKey,
      )
    )
      continue;
    const action = from.operations?.find(
      (operation) => operation.operationId === entry.operationId,
    );
    const label =
      action?.label ??
      entry.operationId.split(':operation.').at(-1)!.replaceAll('_', ' ');
    lines.push(
      `Restores the usual policy for "${String(label)}" under role "${entry.roleKey}".`,
    );
  }

  const newEntities = new Set(
    added('entityDefinition').map((c) => c.subjectId),
  );
  const parentByChild = new Map(
    (to.relations ?? [])
      .filter((relation) => relation.ownership === 'parentScopedChild')
      .map((relation) => [
        String((relation.sourceEntity as Json).targetId),
        String((relation.targetEntity as Json).targetId),
      ]),
  );
  for (const entityId of [...newEntities].sort()) {
    const label = entityLabel(to, entityId);
    const ownership = to.entities.find(
      (entity) => entity.entityId === entityId,
    )?.companyOwnership;
    const fields = to.fields
      .filter((field) => (field.entity as Json).targetId === entityId)
      .sort((left, right) => Number(left.orderKey) - Number(right.orderKey));
    const parent = parentByChild.get(entityId);
    lines.push(
      parent
        ? `New line table "${label}" on ${entityLabel(to, parent)}:`
        : `New record type "${label}" with ${String(fields.length)} field${fields.length === 1 ? '' : 's'}:`,
    );
    for (const field of fields) lines.push(`  - ${describeField(field)}`);
    if (ownership === 'entityOwned')
      lines.push('  Each record belongs to one company.');
    if (ownership === 'tenantShared')
      lines.push('  Records are shared by all companies in this tenant.');
    if (!parent)
      lines.push(
        `  It gets its own menu entry "${label}" with a list, a record page and a form.`,
        `  People who can use the rest of the application can create, change, archive and restore ${label} records.`,
      );
  }

  const fieldsByRelation = new Map(
    to.surfaces.flatMap((surface) =>
      (((surface.composition as Json | undefined)?.fields ?? []) as Json[])
        .filter((column) => column.reference)
        .map((column) => [column.field, String(column.label)] as const),
    ),
  );
  const originalRelations = new Set(
    (from.relations ?? []).map((relation) => relation.relationId),
  );
  for (const relation of to.relations ?? []) {
    const label = fieldsByRelation.get(relation.relationId);
    if (!label || originalRelations.has(relation.relationId)) continue;
    const source = entityLabel(
      to,
      String((relation.sourceEntity as Json).targetId),
    );
    const target = entityLabel(
      to,
      String((relation.targetEntity as Json).targetId),
    );
    lines.push(
      `New ${relation.required ? 'required' : 'optional'} link "${label}" from ${source} to ${target}. Choose it when creating a record.`,
    );
  }
  const originalMachines = new Set(
    (from.stateMachines ?? []).map((machine) => machine.machineId),
  );
  for (const machine of to.stateMachines ?? []) {
    if (originalMachines.has(machine.machineId)) continue;
    const states = new Map(
      (machine.states as Json[]).map((state) => [
        state.stateId,
        String(state.label),
      ]),
    );
    const initial = states.get((machine.initialState as Json).targetId);
    lines.push(
      `New lifecycle for ${entityLabel(to, String((machine.entity as Json).targetId))}. Records start at "${initial}".`,
    );
    for (const transition of machine.transitions as Json[]) {
      const fromState = states.get((transition.fromState as Json).targetId);
      const toState = states.get((transition.toState as Json).targetId);
      lines.push(
        `  - ${String(transition.label)} changes "${fromState}" to "${toState}" after confirmation.`,
      );
    }
  }

  for (const change of added('fieldDefinition')) {
    const field = to.fields.find((entry) => entry.fieldId === change.subjectId);
    if (!field) continue;
    const entityId = String((field.entity as Json).targetId);
    if (newEntities.has(entityId)) continue;
    lines.push(
      `New field on ${entityLabel(to, entityId)}: ${describeField(field)}.`,
    );
  }

  for (const change of changed('fieldDefinition')) {
    const before = from.fields.find(
      (entry) => entry.fieldId === change.subjectId,
    );
    const after = to.fields.find((entry) => entry.fieldId === change.subjectId);
    if (!before || !after) continue;
    const owner = entityLabel(to, String((after.entity as Json).targetId));
    const newOptions = optionLabels(after).filter(
      (option) => !optionLabels(before).includes(option),
    );
    if (newOptions.length > 0) {
      lines.push(
        `${owner} "${String(after.label)}" gains the choice${newOptions.length === 1 ? '' : 's'} ${newOptions.map((option) => `"${option}"`).join(', ')}. Existing records keep their value.`,
      );
    } else {
      lines.push(`${owner} "${String(after.label)}" changes.`);
    }
  }

  for (const change of changed('surfaceDefinition')) {
    const before = from.surfaces.find((s) => s.surfaceId === change.subjectId);
    const after = to.surfaces.find((s) => s.surfaceId === change.subjectId);
    if (!before || !after) continue;
    const beforeMetrics = ((before.launcher as Json | undefined)?.metrics ??
      []) as Json[];
    const oldLayouts = (before.layouts ?? []) as SurfaceLayout[];
    const newLayouts = (after.layouts ?? []) as SurfaceLayout[];
    const describeBody = (body: LayoutBody) =>
      body.order
        .map((id) => {
          const section = body.sections.find((s) => s.id === id);
          if (!section) return body.blocks.find((b) => b.id === id)!.label.text;
          const fields = section.fields.map((f) => f.label.text);
          return fields.length
            ? section.label.text + ' (' + fields.join(', ') + ')'
            : section.label.text;
        })
        .join(' → ');
    const modes = new Set(
      [...oldLayouts, ...newLayouts].map((l) => l.body.mode),
    );
    let layoutChanged = false;
    for (const mode of modes) {
      const previous = oldLayouts.find((l) => l.body.mode === mode);
      const next = newLayouts.find((l) => l.body.mode === mode);
      if (previous?.revisionId === next?.revisionId) continue;
      const oldBody = previous?.body ?? baseLayout(from, before, mode);
      const newBody = next?.body ?? baseLayout(to, after, mode);
      if (!oldBody || !newBody)
        throw new Error('Cannot describe the original and revised layout.');
      lines.push(
        String(after.label) + ' · ' + mode + ' layout',
        'Previously ' + describeBody(oldBody),
        'Now ' + describeBody(newBody),
      );
      layoutChanged = true;
    }
    if (layoutChanged) continue;
    const addedMetrics = (
      ((after.launcher as Json | undefined)?.metrics ?? []) as Json[]
    ).filter(
      (metric) =>
        !beforeMetrics.some((prior) => prior.metricId === metric.metricId),
    );
    if (addedMetrics.length) {
      for (const metric of addedMetrics) {
        const source = to.surfaces.find(
          (surface) => surface.surfaceId === metric.surface,
        );
        const view = (
          (source?.list as Json | undefined)?.views as Json[] | undefined
        )?.find((view) => view.viewId === metric.view);
        const field = to.fields.find(
          (field) => field.fieldId === metric.sumField,
        );
        lines.push(
          `Today gains the "${String(metric.label)}" card. It ${field ? `sums ${String(field.label)}` : 'counts records'} in ${String(source?.label)}${view ? ` → ${String(view.label)}` : ''}.`,
        );
      }
      continue;
    }
    const list = after.list as Json | undefined;
    const previousViews = new Set(
      ((before.list as Json | undefined)?.views as Json[] | undefined)?.map(
        (view) => view.viewId,
      ),
    );
    const savedViews = ((list?.views ?? []) as Json[]).filter(
      (view) => view.layout && !previousViews.has(view.viewId),
    );
    if (savedViews.length) {
      const headings = new Map(
        (list!.columns as Json[]).map((column) => [
          column.columnId,
          column.label,
        ]),
      );
      for (const view of savedViews) {
        const layout = view.layout as {
          columns: string[];
          sort: { columnId: string; direction: string }[];
        };
        lines.push(
          `The "${String(after.label)}" list gains the "${String(view.label)}" view.`,
          `  Columns in order: ${layout.columns.map((id) => String(headings.get(id))).join(', ')}.`,
        );
        if (layout.sort.length)
          lines.push(
            `  Sort: ${layout.sort.map(({ columnId, direction }) => `${String(headings.get(columnId))} ${direction}`).join(', ')}.`,
          );
        for (const { field, value } of view.filters as {
          field: string;
          value: string;
        }[]) {
          const declared = (
            list!.filters as {
              field: string;
              label: string;
              options: { value: string; label: string }[];
            }[]
          ).find((filter) => filter.field === field);
          lines.push(
            `  Filter: ${declared?.label ?? field} is ${declared?.options.find((option) => option.value === value)?.label ?? value}.`,
          );
        }
      }
      continue;
    }
    const columns = (surface: Json) =>
      (
        ((surface.list as Json | undefined)?.columns as Json[] | undefined) ??
        []
      )
        .slice()
        .sort((l, r) => Number(l.orderKey) - Number(r.orderKey))
        .map((column) => String(column.label));
    const was = columns(before);
    const now = columns(after);
    if (was.join('\u0000') !== now.join('\u0000')) {
      lines.push(
        `The "${String(after.label)}" list shows the columns ${now.map((c) => `"${c}"`).join(', ')} (was ${was.map((c) => `"${c}"`).join(', ')}).`,
      );
    } else {
      const placements = (surface: Json) =>
        ((surface.documentEditor as Json | undefined)?.headerFields ??
          (surface.form as Json | undefined)?.fields ??
          []) as Json[];
      const previous = new Map(
        placements(before).map((field) => [field.fieldId, field]),
      );
      const moved = placements(after).filter(
        (field) =>
          !previous.has(field.fieldId) ||
          previous.get(field.fieldId)?.disclosure !== field.disclosure,
      );
      if (moved.length) {
        for (const field of moved)
          lines.push(
            `The "${String(after.label)}" editor shows "${String(field.label)}" ${field.disclosure === 'more' ? 'under More details' : 'up front'}.`,
          );
      } else {
        lines.push(`The "${String(after.label)}" screen changes.`);
      }
    }
  }

  for (const change of removed) {
    lines.push(
      `Removes ${humanKind(change.constructKind)} ${change.subjectId}.`,
    );
  }

  if (lines.length === 0) {
    lines.push('No change a person would see.');
  }

  const storage = input.storage.map((element) => element.kind);
  lines.push('');
  lines.push(
    storage.length === 0
      ? 'Stored data: nothing changes.'
      : `Stored data: ${storageSentence(storage)} Nothing already stored is changed or removed.`,
  );
  lines.push(
    'Rolling back hides this change again and keeps every record entered under it.',
  );

  const text = reverse
    ? [
        'Roll back this change:',
        ...lines.map((line) => (line === '' ? '' : `  ${line}`)),
        '',
        'After the roll back the change is hidden; its stored records stay and come back if it is activated again.',
      ].join('\n')
    : lines.join('\n');
  return Object.freeze({
    lines: Object.freeze(text.split('\n')),
    renderedDigest: renderedDiffDigest(text),
    text,
  });
}

export function renderedDiffDigest(text: string): string {
  return createHash('sha256')
    .update(`${RENDERED_DIFF_VERSION}\u0000`)
    .update(text, 'utf8')
    .digest('hex');
}

function describeField(field: Json): string {
  const fieldType = field.fieldType as Json;
  const required = field.presence === 'required' ? ', required' : '';
  switch (fieldType.kind) {
    case 'textFieldType':
      return `${String(field.label)} (text${required})`;
    case 'integerFieldType':
      return `${String(field.label)} (whole number${required})`;
    case 'dateFieldType':
      return `${String(field.label)} (date${required})`;
    case 'booleanFieldType':
      return `${String(field.label)} (yes or no${required})`;
    case 'enumFieldType':
      return `${String(field.label)} (one of ${optionLabels(field)
        .map((option) => `"${option}"`)
        .join(', ')}${required})`;
    default:
      return `${String(field.label)} (${String(fieldType.kind)}${required})`;
  }
}

function optionLabels(field: Json): string[] {
  const fieldType = field.fieldType as Json;
  return fieldType.kind === 'enumFieldType'
    ? (fieldType.options as Json[])
        .slice()
        .sort((l, r) => Number(l.orderKey) - Number(r.orderKey))
        .map((option) => String(option.label))
    : [];
}

function storageSentence(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const words: Record<string, [string, string]> = {
    addColumn: ['a new column', 'new columns'],
    createIndex: ['a new index', 'new indexes'],
    createTable: ['a new table', 'new tables'],
    widenEnumDomain: [
      'a wider list of allowed choices',
      'wider lists of allowed choices',
    ],
  };
  return `${[...counts.entries()]
    .map(([kind, count]) => {
      const [one, many] = words[kind] ?? [kind, `${kind} x${String(count)}`];
      return count === 1 ? one : `${String(count)} ${many}`;
    })
    .join(', ')}.`;
}

function humanKind(kind: string): string {
  return kind
    .replace(/Definition$/u, '')
    .replace(/[A-Z]/gu, (c) => ` ${c.toLowerCase()}`);
}
