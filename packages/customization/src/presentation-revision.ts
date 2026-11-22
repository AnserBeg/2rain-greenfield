import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  COLUMN_OVERFLOWS,
  COLUMN_WIDTHS,
  DENSITIES,
  MAX_SIZING_ENTRIES,
  MAX_TONE_RULES,
  TONES,
  type SurfacePresentationRevision,
} from '../../canonical-model/src/surface-presentation-schema.js';
import {
  bindToneCondition,
  presentationOperands,
  PresentationProblem,
  type PresentationOperand,
  type PresentationSource,
} from '../../canonical-model/src/surface-presentation.js';
import type {
  ValidationOperand,
  ValidationPredicate,
  ValidationScalar,
} from '../../canonical-model/src/formula-validation.js';
import { SurfacePresentationRevisionSchema } from '../../canonical-model/src/schemas.js';

/** UI-CUSTOM-1: the persisted member, the revision plus its kind. */
export const PresentationRevisionPatchSchema =
  SurfacePresentationRevisionSchema.extend({
    kind: z.literal('addPresentationRevision'),
  });
export type PresentationRevisionPatch = z.infer<
  typeof PresentationRevisionPatchSchema
>;

type Row = Record<string, unknown>;
const v = 'v6' as const;

/** What a company may present on one list: every value its rows already read. */
export interface PresentationTarget {
  readonly surfaceId: string;
  readonly label: string;
  /** The current revision, the predecessor of the next one. */
  readonly revisionId: string | null;
  readonly current: SurfacePresentationRevision | null;
  readonly operands: readonly PresentationOperand[];
  readonly columns: readonly {
    readonly fieldId: string;
    readonly label: string;
  }[];
  readonly views: readonly {
    readonly viewId: string;
    readonly label: string;
  }[];
}

export function presentationTargets(
  def: PresentationSource,
): PresentationTarget[] {
  return def.surfaces.flatMap((surface: Row) => {
    const list = surface.list as
      | {
          columns: { field: string; label: string }[];
          views: { viewId: string; label: string }[];
        }
      | undefined;
    if (
      surface.archetype !== 'list' ||
      !list ||
      surface.lifecycle === 'retired'
    )
      return [];
    const current =
      (surface.presentation as SurfacePresentationRevision | undefined) ?? null;
    return [
      {
        surfaceId: String(surface.surfaceId),
        label: String(surface.label),
        revisionId: current?.revisionId ?? null,
        current,
        operands: presentationOperands(def, surface),
        columns: list.columns.map((c) => ({
          fieldId: c.field,
          label: c.label,
        })),
        views: list.views.map((view) => ({
          viewId: view.viewId,
          label: view.label,
        })),
      },
    ];
  });
}

const id = z.string().min(1).max(180).meta({ description: 'ID' });
const COMPARISONS = [
  'equal',
  'notEqual',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
] as const;

/**
 * What the drafter emits: choices by listed IDs. It is turned into the member
 * by `presentationMember`, which binds types, literals and revision IDs, so
 * the model never writes a digest, a revision ID or a typed scalar.
 */
export const PresentationDraftSchema = z.strictObject({
  kind: z.literal('addPresentationRevision'),
  surface: id,
  tones: z
    .array(
      z.strictObject({
        target: z.enum(['cell', 'row']),
        cellFieldId: id.optional(),
        fieldId: id,
        operator: z.enum(COMPARISONS),
        compareTo: z.union([
          z.strictObject({ fieldId: id }),
          z.strictObject({ value: z.string().min(1).max(240) }),
        ]),
        tone: z.enum(TONES),
        reason: z.string().trim().min(1).max(80),
      }),
    )
    .max(MAX_TONE_RULES)
    .optional(),
  columns: z
    .array(
      z.strictObject({
        fieldId: id,
        width: z.enum(COLUMN_WIDTHS),
        overflow: z.enum(COLUMN_OVERFLOWS).optional(),
      }),
    )
    .max(MAX_SIZING_ENTRIES)
    .optional(),
  density: z.enum(DENSITIES).optional(),
  /**
   * The current rules and sizing are kept by default; a drafted rule with the
   * same reason replaces its namesake. `remove` names reasons to drop, and
   * `replaceCurrent` starts from nothing.
   */
  remove: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  replaceCurrent: z.boolean().optional(),
  retire: z.boolean().optional(),
});
export type PresentationDraft = z.infer<typeof PresentationDraftSchema>;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 60) || 'rule';

function literal(operand: PresentationOperand, raw: string): ValidationScalar {
  const type = operand.type;
  if (operand.options) {
    const option = operand.options.find(
      (o) => o.id === raw || o.label.toLowerCase() === raw.trim().toLowerCase(),
    );
    if (!option)
      throw new Error(
        `Choose one of ${operand.options.map((o) => o.label).join(', ')} for ${operand.label}.`,
      );
    return { kind: 'text', value: option.id };
  }
  switch (type.kind) {
    case 'decimal': {
      const value = raw.trim();
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
        throw new Error(`Give ${operand.label} a plain number.`);
      return { ...type, value };
    }
    case 'integer':
      if (!/^-?(?:0|[1-9]\d*)$/u.test(raw.trim()))
        throw new Error(`Give ${operand.label} a whole number.`);
      return { kind: 'integer', value: raw.trim() };
    case 'boolean':
      return { kind: 'boolean', value: /^(?:true|yes)$/iu.test(raw.trim()) };
    case 'date':
      return { kind: 'date', value: raw.trim() };
    default:
      return { kind: 'text', value: raw };
  }
}

/** Turn drafted choices into the member on this base, checked as it compiles. */
export function presentationMember(
  targets: readonly PresentationTarget[],
  input: unknown,
): PresentationRevisionPatch {
  const draft = PresentationDraftSchema.parse(input);
  const target = targets.find((t) => t.surfaceId === draft.surface);
  if (!target) throw new Error('Choose a listed list surface.');
  const namespace = target.surfaceId.split(':')[0]!;
  const current =
    draft.replaceCurrent || target.current?.status !== 'active'
      ? null
      : target.current;
  const operand = (fieldId: string) => {
    const found = target.operands.find((o) => o.fieldId === fieldId);
    if (!found)
      throw new Error(
        `The list does not read ${fieldId}; choose a listed value.`,
      );
    return found;
  };
  const field = (fieldId: string): ValidationOperand => ({
    schemaVersion: v,
    kind: 'field',
    fieldId,
    select: 'value',
  });
  const used = new Set<string>();
  const toneRules = (draft.tones ?? []).map((tone) => {
    const left = operand(tone.fieldId);
    const right: ValidationOperand =
      'fieldId' in tone.compareTo
        ? field(operand(tone.compareTo.fieldId).fieldId)
        : {
            schemaVersion: v,
            kind: 'literal',
            scalar: literal(left, tone.compareTo.value),
          };
    const when: ValidationPredicate = {
      schemaVersion: v,
      kind: 'comparison',
      operator: tone.operator,
      left: field(left.fieldId),
      right,
    };
    // The ID derives from the reason, so redrafting "Low stock" replaces it.
    let ruleId = `${namespace}:tone.custom_${slug(tone.reason)}`;
    for (let n = 2; used.has(ruleId); n += 1)
      ruleId = `${namespace}:tone.custom_${slug(tone.reason)}_${String(n)}`;
    used.add(ruleId);
    const cell = tone.cellFieldId ?? tone.fieldId;
    if (
      tone.target === 'cell' &&
      !target.columns.some((c) => c.fieldId === cell)
    )
      throw new Error('Colour a cell of a column the list shows.');
    return {
      schemaVersion: v,
      ruleId,
      target:
        tone.target === 'row'
          ? ({ schemaVersion: v, kind: 'listRow' } as const)
          : ({ schemaVersion: v, kind: 'listCell', fieldId: cell } as const),
      when,
      tone: tone.tone,
      reason: { schemaVersion: v, text: tone.reason },
    };
  });
  const sizing = [
    ...(current?.sizing ?? []).filter(
      (entry) =>
        entry.kind !== 'listColumn' ||
        !draft.columns?.some((c) => c.fieldId === entry.fieldId),
    ),
    ...(draft.columns ?? []).map((column) => {
      if (!target.columns.some((c) => c.fieldId === column.fieldId))
        throw new Error('Size a column the list shows.');
      return {
        schemaVersion: v,
        kind: 'listColumn' as const,
        fieldId: column.fieldId,
        width: column.width,
        overflow: column.overflow ?? 'wrap',
      };
    }),
  ];
  const patch: PresentationRevisionPatch = {
    kind: 'addPresentationRevision',
    schemaVersion: v,
    version: 1,
    surface: target.surfaceId,
    revisionId: randomUUID(),
    predecessor: target.revisionId,
    status: draft.retire ? 'retired' : 'active',
    toneRules: [
      ...(current?.toneRules ?? []).filter(
        (rule) =>
          !toneRules.some((next) => next.ruleId === rule.ruleId) &&
          !(draft.remove ?? []).some(
            (reason) => reason.toLowerCase() === rule.reason.text.toLowerCase(),
          ),
      ),
      ...toneRules,
    ],
    sizing,
    density: draft.density ?? current?.density ?? null,
    viewDensity: current?.viewDensity ?? [],
  };
  if (draft.retire) {
    if (!target.current) throw new Error('There is no presentation to retire.');
    return {
      ...target.current,
      kind: 'addPresentationRevision',
      revisionId: patch.revisionId,
      predecessor: target.revisionId,
      status: 'retired',
    };
  }
  for (const rule of patch.toneRules)
    bindToneCondition(target.operands, rule.ruleId, rule.when);
  return PresentationRevisionPatchSchema.parse(patch);
}

/**
 * Replay on another base (ADR-0085 A20 structural checks): every chosen ID must
 * still be on the list with a compatible type. A removed value names its ID
 * and the rule stops applying; a label change is not seen at all.
 */
export function presentationReplayProblem(
  def: PresentationSource,
  patch: PresentationRevisionPatch,
): { subject: string; message: string } | null {
  if (patch.status === 'retired') return null;
  const surface = def.surfaces.find((s) => s.surfaceId === patch.surface);
  if (!surface) return { subject: patch.surface, message: 'retired list' };
  const operands = presentationOperands(def, surface);
  try {
    for (const rule of patch.toneRules)
      bindToneCondition(operands, rule.ruleId, rule.when);
  } catch (error) {
    if (error instanceof PresentationProblem)
      return { subject: error.subject, message: error.message };
    throw error;
  }
  const columns = new Set(
    (
      (surface.list as { columns?: { field: string }[] } | undefined)
        ?.columns ?? []
    ).map((c) => c.field),
  );
  for (const entry of patch.sizing)
    if (entry.kind === 'listColumn' && !columns.has(entry.fieldId))
      return { subject: entry.fieldId, message: 'removed column' };
  for (const rule of patch.toneRules)
    if (rule.target.kind === 'listCell' && !columns.has(rule.target.fieldId))
      return { subject: rule.target.fieldId, message: 'removed column' };
  return null;
}
