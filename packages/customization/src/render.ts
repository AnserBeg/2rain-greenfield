import { createHash } from 'node:crypto';

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

export interface DiffDefinition {
  readonly entities: readonly Json[];
  readonly fields: readonly Json[];
  readonly surfaces: readonly Json[];
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

  const newEntities = new Set(
    added('entityDefinition').map((c) => c.subjectId),
  );
  for (const entityId of [...newEntities].sort()) {
    const label = entityLabel(to, entityId);
    const fields = to.fields
      .filter((field) => (field.entity as Json).targetId === entityId)
      .sort((left, right) => Number(left.orderKey) - Number(right.orderKey));
    lines.push(
      `New record type "${label}" with ${String(fields.length)} field${fields.length === 1 ? '' : 's'}:`,
    );
    for (const field of fields) lines.push(`  - ${describeField(field)}`);
    lines.push(
      `  It gets its own menu entry "${label}" with a list, a record page and a form.`,
      `  People who can use the rest of the application can create, change, archive and restore ${label} records.`,
    );
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
