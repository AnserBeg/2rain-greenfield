import { derivedStateFieldId, selectedFieldIds } from './board.js';
import {
  BUSINESS_DATE_FIELD_ID,
  formulaFieldType,
} from './formula-validation-bindings.js';
import {
  inspectValidation,
  sameValidationValue,
  type ResolvedOperand,
  type ValidationOperand,
  type ValidationPredicate,
  type ValidationScalar,
} from './formula-validation.js';
import {
  CONTEXT_OPERANDS,
  RENDERED_SIZING,
  RENDERED_TONE_PLACEMENTS,
  MAX_TONE_RULES,
  type Placement,
  type PresentationOperandType,
  type SurfacePresentationRevision,
  type Tone,
  type TonePlacement,
} from './surface-presentation-schema.js';

type Row = Record<string, unknown>;
export interface PresentationSource {
  readonly fields?: readonly Row[];
  readonly surfaces: readonly Row[];
  readonly queries: readonly Row[];
  readonly stateMachines?: readonly Row[];
  readonly calculatedDisplayFields?: readonly Row[];
}
const target = (ref: unknown) =>
  (ref as { targetId?: string } | undefined)?.targetId;
const live = (row: Row | undefined): row is Row =>
  !!row && row.lifecycle !== 'retired';

/** A refusal that names the affected ID (rule 10). */
export class PresentationProblem extends Error {
  constructor(
    readonly subject: string,
    message: string,
  ) {
    super(`${message} (${subject})`);
  }
}

interface ListColumnLike {
  readonly field: string;
  readonly columnId: string;
}
interface ListLike {
  readonly columns: readonly ListColumnLike[];
  readonly views: readonly { readonly viewId: string }[];
}

/**
 * The placements a surface exposes, derived from its compiled slots, list,
 * layouts, line tables, board and launcher -- never hand-listed per module.
 */
export function surfacePlacements(
  def: PresentationSource,
  surface: Row,
): Placement[] {
  const v = 'v6' as const;
  const out: Placement[] = [];
  const slots = (surface.slots as { slot: string; slotId: string }[]) ?? [];
  const list = surface.list as ListLike | undefined;
  if (surface.archetype === 'list' && list) {
    if (slots.some((s) => s.slot === 'dataGrid' || s.slot === 'title'))
      out.push({ schemaVersion: v, kind: 'listToolbar' });
    out.push({ schemaVersion: v, kind: 'listRow' });
    for (const column of list.columns)
      out.push({ schemaVersion: v, kind: 'listCell', fieldId: column.field });
  }
  if (surface.archetype === 'board')
    out.push({ schemaVersion: v, kind: 'boardCard' });
  if (surface.surfaceRole === 'record') {
    if (slots.some((s) => s.slot === 'commandBar'))
      out.push({ schemaVersion: v, kind: 'formHeader' });
    const layouts =
      (surface.layouts as
        { body: { sections: { id: string }[] } }[] | undefined) ?? [];
    for (const section of layouts.flatMap((l) => l.body.sections))
      out.push({
        schemaVersion: v,
        kind: 'formSection',
        sectionId: section.id,
      });
    const query = def.queries.find(
      (q) => q.queryId === target(surface.dataSource),
    );
    for (const fieldId of query ? selectedFieldIds(query) : [])
      out.push({ schemaVersion: v, kind: 'field', fieldId });
    const children =
      (
        surface.composition as
          | { children?: { datasetId: string; fields?: { field: string }[] }[] }
          | undefined
      )?.children ?? [];
    for (const child of children) {
      out.push({
        schemaVersion: v,
        kind: 'lineTableToolbar',
        tableId: child.datasetId,
      });
      out.push({ schemaVersion: v, kind: 'lineRow', tableId: child.datasetId });
      for (const field of child.fields ?? [])
        out.push({
          schemaVersion: v,
          kind: 'lineCell',
          tableId: child.datasetId,
          fieldId: field.field,
        });
    }
  }
  const metrics =
    (surface.launcher as { metrics?: { metricId?: string }[] } | undefined)
      ?.metrics ?? [];
  for (const metric of metrics)
    if (metric.metricId)
      out.push({
        schemaVersion: v,
        kind: 'metricCard',
        metricId: metric.metricId,
      });
  if (surface.archetype === 'home')
    for (const slot of slots)
      out.push({ schemaVersion: v, kind: 'homeSection', slotId: slot.slotId });
  return out;
}

/** The operands a surface's rows carry, with their pinned types. */
export interface PresentationOperand {
  readonly fieldId: string;
  readonly label: string;
  readonly type: PresentationOperandType;
  /** For a choice or lifecycle state: the option IDs it may equal. */
  readonly options?: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Every value a list row already reads: the fields its query selects and the
 * calculated displays shown on it. A tone rule reads nothing else (rule 2:
 * no new read, so no new company or field boundary to cross).
 */
export function presentationOperands(
  def: PresentationSource,
  surface: Row,
): PresentationOperand[] {
  const query = def.queries.find(
    (q) => q.queryId === target(surface.dataSource),
  );
  if (!query) return [];
  const list = surface.list as ListLike | undefined;
  const label = (fieldId: string, fallback: unknown) =>
    String(
      (list?.columns as { field: string; label?: string }[] | undefined)?.find(
        (c) => c.field === fieldId,
      )?.label ??
        fallback ??
        fieldId,
    );
  const out: PresentationOperand[] = [];
  for (const fieldId of selectedFieldIds(query)) {
    const field = def.fields?.find((f) => f.fieldId === fieldId);
    if (field) {
      if (!live(field)) continue;
      const fieldType = field.fieldType as Row & { kind: string };
      if (fieldType.kind === 'enumFieldType') {
        out.push({
          fieldId,
          label: label(fieldId, field.label),
          type: { kind: 'text' },
          options: (
            (fieldType.options as { optionId: string; label?: string }[]) ?? []
          ).map((o) => ({
            id: o.optionId,
            label: String(o.label ?? o.optionId),
          })),
        });
        continue;
      }
      if (
        (
          def as { dateTimeFields?: { fieldId: string }[] }
        ).dateTimeFields?.some((d) => d.fieldId === fieldId)
      )
        continue;
      const type = formulaFieldType(
        field as Parameters<typeof formulaFieldType>[0],
      );
      if (!type || type.kind === 'address' || type.kind === 'dateTime')
        continue;
      out.push({
        fieldId,
        label: label(fieldId, field.label),
        type: type as PresentationOperandType,
      });
      continue;
    }
    const machine = (def.stateMachines ?? []).find(
      (m) =>
        live(m) &&
        ((m.stateField as { fieldId?: string } | undefined)?.fieldId ??
          derivedStateFieldId(String(m.machineId))) === fieldId,
    );
    if (machine)
      out.push({
        fieldId,
        label: label(fieldId, 'Status'),
        type: { kind: 'text' },
        options: (
          (machine.states as { stateId: string; label?: string }[]) ?? []
        ).map((s) => ({ id: s.stateId, label: String(s.label ?? s.stateId) })),
      });
  }
  for (const calculated of def.calculatedDisplayFields ?? []) {
    const sinks =
      (calculated.displaySinks as { kind: string; surfaceId: string }[]) ?? [];
    const result = calculated.resultType as {
      precision: number;
      scale: number;
      currency: string | null;
      unit: string | null;
    };
    if (
      !sinks.some(
        (s) => s.kind === 'list' && s.surfaceId === surface.surfaceId,
      ) ||
      result.precision > 38 ||
      result.scale > 18
    )
      continue;
    out.push({
      fieldId: String(calculated.fieldId),
      label: String(calculated.label),
      type: { kind: 'decimal', ...result },
    });
  }
  return out;
}

function sameType(
  left: PresentationOperandType,
  right: PresentationOperandType | ValidationScalar,
) {
  return (
    left.kind === right.kind &&
    (left.kind !== 'decimal' ||
      (right.kind === 'decimal' &&
        left.currency === right.currency &&
        left.unit === right.unit))
  );
}

const placementKey = (p: TonePlacement) =>
  p.kind === 'listCell' || p.kind === 'field'
    ? `${p.kind}:${p.fieldId}`
    : p.kind === 'lineCell'
      ? `${p.kind}:${p.tableId}:${p.fieldId}`
      : p.kind === 'lineRow'
        ? `${p.kind}:${p.tableId}`
        : p.kind === 'metricCard'
          ? `${p.kind}:${p.metricId}`
          : p.kind;

/**
 * Bind one rule's condition on this surface: every operand a value the row
 * already reads, compared with a value of the same type, currency and unit.
 * Returns the operand types the renderer needs to build exact scalars.
 */
export function bindToneCondition(
  operands: readonly PresentationOperand[],
  ruleId: string,
  when: ValidationPredicate,
): Record<string, PresentationOperandType> {
  const byId = new Map(operands.map((o) => [o.fieldId, o]));
  const used = new Map<string, PresentationOperandType>();
  const fail = (subject: string, message: string): never => {
    throw new PresentationProblem(subject, message);
  };
  const typeOf = (operand: ValidationOperand): PresentationOperandType => {
    if (operand.kind === 'path')
      return fail(
        ruleId,
        'A tone rule cannot read a linked record in this release',
      );
    if (operand.kind === 'literal')
      return operand.scalar.kind === 'decimal'
        ? {
            kind: 'decimal',
            precision: operand.scalar.precision,
            scale: operand.scalar.scale,
            currency: operand.scalar.currency,
            unit: operand.scalar.unit,
          }
        : { kind: operand.scalar.kind };
    if (
      operand.fieldId === BUSINESS_DATE_FIELD_ID ||
      CONTEXT_OPERANDS.has(operand.fieldId)
    )
      return fail(
        operand.fieldId,
        'A tone rule cannot read a context value (today, this week, me) in this release',
      );
    const found =
      byId.get(operand.fieldId) ??
      fail(operand.fieldId, 'The tone rule reads a value this list does not');
    used.set(operand.fieldId, found.type);
    if (operand.select === 'textLength') {
      if (found.type.kind !== 'text')
        fail(operand.fieldId, 'Only text has a length');
      return { kind: 'integer' };
    }
    return found.type;
  };
  const walk = (term: ValidationPredicate, depth: number): void => {
    if (depth > 4) fail(ruleId, 'The condition is nested too deeply');
    switch (term.kind) {
      case 'required':
        typeOf(term.operand);
        return;
      case 'not':
        walk(term.term, depth + 1);
        return;
      case 'all':
      case 'any':
        for (const child of term.terms) walk(child, depth + 1);
        return;
      case 'comparison': {
        const left = typeOf(term.left);
        const right = typeOf(term.right);
        if (!sameType(left, right))
          fail(ruleId, 'Compare values with the same type, currency and unit');
        if (
          term.operator !== 'equal' &&
          term.operator !== 'notEqual' &&
          (left.kind === 'text' || left.kind === 'boolean')
        )
          fail(ruleId, 'Use a number or date for an ordered comparison');
        for (const [side, other] of [
          [term.left, term.right],
          [term.right, term.left],
        ] as const) {
          if (side.kind !== 'field' || side.select !== 'value') continue;
          const options = byId.get(side.fieldId)?.options;
          if (
            options &&
            other.kind === 'literal' &&
            other.scalar.kind === 'text' &&
            !options.some((o) => o.id === other.scalar.value)
          )
            fail(side.fieldId, 'Choose one of the listed options');
        }
        return;
      }
    }
  };
  walk(when, 1);
  return Object.fromEntries(
    [...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * The compiled surface key. A retired revision is carried, never validated
 * (rule 10). An active one binds every rule it can on this base.
 *
 * `authoring` (the authoring base only, as Board v2's eligibility gates):
 * every rule and sized column must target what the surface exposes and this
 * release renders, by stable ID, or the change is refused by name.
 * `structural` (normalization, the compiler, admission, another base): a rule
 * or sized column whose placement or value is gone is carried INERT with a
 * diagnostic naming the affected ID. It stops applying and never mis-colours,
 * so hiding a column or removing a field never blocks arranging the list.
 */
export function compilePresentation(
  def: PresentationSource,
  surface: Row,
  mode: 'authoring' | 'structural' = 'structural',
): {
  revision: SurfacePresentationRevision;
  operands?: Record<string, Record<string, PresentationOperandType>>;
  inert?: { id: string; subject: string; reason: string }[];
} {
  const revision = surface.presentation as SurfacePresentationRevision;
  if (revision.surface !== surface.surfaceId)
    throw new PresentationProblem(
      String(surface.surfaceId),
      'The presentation names another surface',
    );
  if (revision.status === 'retired') return { revision };
  const subject = String(surface.surfaceId);
  const list = surface.list as ListLike | undefined;
  const placements = new Set(
    surfacePlacements(def, surface)
      .filter((p) => p.kind !== 'formSection' && p.kind !== 'homeSection')
      .map((p) => placementKey(p as TonePlacement)),
  );
  const ruleIds = revision.toneRules.map((r) => r.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length)
    throw new PresentationProblem(subject, 'Each tone rule needs its own ID');
  if (revision.toneRules.length > MAX_TONE_RULES)
    throw new PresentationProblem(subject, 'Too many tone rules');
  const inert: { id: string; subject: string; reason: string }[] = [];
  const check = (id: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      if (mode === 'authoring' || !(error instanceof PresentationProblem))
        throw error;
      inert.push({ id, subject: error.subject, reason: error.message });
    }
  };
  const operands = presentationOperands(def, surface);
  const bound: Record<string, Record<string, PresentationOperandType>> = {};
  for (const rule of revision.toneRules)
    check(rule.ruleId, () => {
      if (!RENDERED_TONE_PLACEMENTS.has(rule.target.kind))
        throw new PresentationProblem(
          rule.ruleId,
          `This release does not render a tone on a ${rule.target.kind} placement`,
        );
      if (!placements.has(placementKey(rule.target)))
        throw new PresentationProblem(
          rule.target.kind === 'listCell' ? rule.target.fieldId : rule.ruleId,
          'The tone targets a placement this surface does not have',
        );
      bound[rule.ruleId] = bindToneCondition(operands, rule.ruleId, rule.when);
    });
  const sized = new Set<string>();
  for (const entry of revision.sizing) {
    if (entry.kind === 'listColumn' && sized.has(entry.fieldId))
      throw new PresentationProblem(entry.fieldId, 'Size each column once');
    if (entry.kind === 'listColumn') sized.add(entry.fieldId);
    check(entry.kind === 'listColumn' ? entry.fieldId : entry.kind, () => {
      if (!RENDERED_SIZING.has(entry.kind))
        throw new PresentationProblem(
          subject,
          `This release does not size a ${entry.kind}`,
        );
      if (
        entry.kind === 'listColumn' &&
        !list?.columns.some((c) => c.field === entry.fieldId)
      )
        throw new PresentationProblem(
          entry.fieldId,
          'The sized column is not on this list',
        );
    });
  }
  if ((revision.density !== null || revision.viewDensity.length) && !list)
    throw new PresentationProblem(subject, 'Density applies to a list');
  for (const view of revision.viewDensity)
    check(view.viewId, () => {
      if (!list?.views.some((v) => v.viewId === view.viewId))
        throw new PresentationProblem(
          view.viewId,
          'The view is not on this list',
        );
    });
  return {
    revision,
    ...(Object.keys(bound).length ? { operands: bound } : {}),
    ...(inert.length ? { inert } : {}),
  };
}

/** A rule ready to evaluate: a tenant's declared rule, or one a release derives. */
export interface EvaluableTone {
  readonly ruleId: string;
  readonly target: TonePlacement;
  readonly when: ValidationPredicate;
  readonly tone: Tone;
  readonly reason: string;
  readonly operands: Readonly<Record<string, PresentationOperandType>>;
  /**
   * How the tone shows. A declared rule always shows its word. A rule a
   * release derives from its own declaration may show a glyph with the word
   * as its accessible name, and name its own marker attribute.
   */
  readonly mark?: { readonly glyph: string; readonly attribute: string };
}

export function evaluableTones(compiled: {
  readonly revision: SurfacePresentationRevision;
  readonly operands?:
    Record<string, Record<string, PresentationOperandType>> | undefined;
  readonly inert?:
    readonly { readonly id: string; readonly subject: string }[] | undefined;
}): EvaluableTone[] {
  if (compiled.revision.status !== 'active') return [];
  const inert = new Set((compiled.inert ?? []).map((entry) => entry.id));
  return compiled.revision.toneRules
    .flatMap((rule) => (inert.has(rule.ruleId) ? [] : [rule]))
    .map((rule) => ({
      ruleId: rule.ruleId,
      target: rule.target,
      when: rule.when,
      tone: rule.tone,
      reason: rule.reason.text,
      operands: compiled.operands?.[rule.ruleId] ?? {},
    }));
}

function readValue(
  values: Readonly<Record<string, unknown>>,
  fieldId: string,
  type: PresentationOperandType | undefined,
): ResolvedOperand {
  const unreadable = {
    status: 'refused',
    code: 'VALIDATION_OPERAND_UNREADABLE',
  } as const;
  const malformed = {
    status: 'refused',
    code: 'VALIDATION_OPERAND_MALFORMED',
  } as const;
  // A withheld value is unreadable: no tone, never a guess (rule 2).
  if (!type || !Object.hasOwn(values, fieldId)) return unreadable;
  const value = values[fieldId];
  if (value === null || value === undefined) return { status: 'absent' };
  if (type.kind === 'boolean')
    return typeof value === 'boolean'
      ? { status: 'present', scalar: { kind: 'boolean', value } }
      : malformed;
  if (typeof value !== 'string') return malformed;
  const scalar: ValidationScalar =
    type.kind === 'decimal' ? { ...type, value } : { kind: type.kind, value };
  return sameValidationValue(scalar, scalar)
    ? { status: 'present', scalar }
    : malformed;
}

export interface AppliedTone {
  readonly ruleId: string;
  readonly tone: Tone;
  readonly reason: string;
  readonly mark?: EvaluableTone['mark'];
}

export interface RowPresentation {
  /** The first holding rule per cell, by field ID, in declared order. */
  readonly cells: ReadonlyMap<string, AppliedTone>;
  readonly row: AppliedTone | null;
  /** Rules that could not be judged on this row (a withheld or malformed value). */
  readonly unavailable: readonly string[];
}

/**
 * Judge every rule against one row the viewer already read, three-valued:
 * only a `true` condition shows its tone; `unknown` shows none; a withheld or
 * malformed operand shows none and is reported as unavailable.
 */
export function presentRow(
  rules: readonly EvaluableTone[],
  values: Readonly<Record<string, unknown>>,
): RowPresentation {
  const cells = new Map<string, AppliedTone>();
  let row: AppliedTone | null = null;
  const unavailable: string[] = [];
  for (const rule of rules) {
    const result = inspectValidation(rule.when, (operand) =>
      operand.kind === 'field'
        ? readValue(values, operand.fieldId, rule.operands[operand.fieldId])
        : { status: 'refused', code: 'VALIDATION_OPERAND_UNREADABLE' },
    );
    if (result.status === 'refused') {
      unavailable.push(rule.ruleId);
      continue;
    }
    if (result.value !== 'true') continue;
    const applied: AppliedTone = {
      ruleId: rule.ruleId,
      tone: rule.tone,
      reason: rule.reason,
      ...(rule.mark ? { mark: rule.mark } : {}),
    };
    if (rule.target.kind === 'listRow') row ??= applied;
    else if (rule.target.kind === 'listCell' && !cells.has(rule.target.fieldId))
      cells.set(rule.target.fieldId, applied);
  }
  return { cells, row, unavailable };
}
