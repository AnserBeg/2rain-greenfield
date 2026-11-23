import { z } from 'zod';

import { LayoutTextSchema } from './layout.js';
import type { ValidationPredicate } from './formula-validation.js';

/**
 * UI-CUSTOM-1 slice 1: the declared presentation of a surface (MIGRATION-RULE
 * rules 16 and 17). Its most general form is "a condition on any value the
 * surface already reads drives a semantic tone at any placement", plus
 * declared sizing by stable field ID. The placement vocabulary is closed and
 * versioned and names every surface kind now; a release renders only the
 * placements in `RENDERED_*` and refuses the rest by name, so a later slice
 * widens the rendered set without changing the stored member.
 *
 * Everything is declared from closed vocabularies: the four STATUS_ROLES plus
 * `neutral`, named widths, spans and densities. No colour, CSS or script.
 */
export const PRESENTATION_READER = 47;
export const PRESENTATION_MEMBER_VERSION = 1;

export const PLACEMENT_KINDS = [
  'formHeader',
  'formSection',
  'field',
  'listToolbar',
  'listRow',
  'listCell',
  'lineTableToolbar',
  'lineRow',
  'lineCell',
  'boardCard',
  'metricCard',
  'homeSection',
] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/** The placements a tone may target; buttons (slice 2) use the others too. */
export const TONE_PLACEMENTS = [
  'field',
  'listCell',
  'listRow',
  'lineRow',
  'lineCell',
  'boardCard',
  'metricCard',
] as const satisfies readonly PlacementKind[];
/** What this release renders. Slices 3 and 4 widen this set. */
export const RENDERED_TONE_PLACEMENTS: ReadonlySet<string> = new Set([
  'listCell',
  'listRow',
]);

/** The closed STATUS_ROLES plus `neutral` (a status with no role). */
export const TONES = [
  'success',
  'attention',
  'blocked',
  'inProgress',
  'neutral',
] as const;
export type Tone = (typeof TONES)[number];

export const COLUMN_WIDTHS = ['narrow', 'normal', 'wide', 'auto'] as const;
export const COLUMN_OVERFLOWS = ['wrap', 'truncate'] as const;
export const FIELD_SPANS = ['full', 'half', 'third', 'quarter'] as const;
export const FIELD_HEIGHTS = ['small', 'medium', 'large'] as const;
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export const DENSITIES = ['comfortable', 'compact'] as const;
/** Sizing targets this release renders. Form fields and cards: slice 4. */
export const RENDERED_SIZING: ReadonlySet<string> = new Set(['listColumn']);

/**
 * The shared CONDITION block is the ADR-0076 kernel unchanged: comparisons,
 * field versus field, literals, presence, and all / any / not. Context values
 * a later consumer needs (saved-view filters, button visibility) enter as
 * `field` operands with these reserved runtime IDs, so neither the operand
 * union nor the stored member is reshaped to add them: a date range is
 * `all` of two comparisons; "this week" compares with the week bounds; "me"
 * equals the current principal. The kernel already binds the business date
 * for validation. A tone rule in this release refuses every context operand by
 * name (`bindToneCondition`); each consumer admits the ones it can bind.
 */
export const CONTEXT_OPERAND_IDS = {
  today: 'northstar.runtime:field.business_date',
  weekStart: 'northstar.runtime:field.business_week_start',
  weekEnd: 'northstar.runtime:field.business_week_end',
  monthStart: 'northstar.runtime:field.business_month_start',
  monthEnd: 'northstar.runtime:field.business_month_end',
  currentUser: 'northstar.runtime:field.current_principal',
} as const;
export const CONTEXT_OPERANDS: ReadonlySet<string> = new Set(
  Object.values(CONTEXT_OPERAND_IDS),
);

export const MAX_TONE_RULES = 24;
export const MAX_SIZING_ENTRIES = 48;

const version = z.literal('v6');
const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
const sectionId = z.string().min(1).max(512);

const placement = {
  formHeader: z.strictObject({
    schemaVersion: version,
    kind: z.literal('formHeader'),
  }),
  formSection: z.strictObject({
    schemaVersion: version,
    kind: z.literal('formSection'),
    sectionId,
  }),
  field: z.strictObject({
    schemaVersion: version,
    kind: z.literal('field'),
    fieldId: id,
  }),
  listToolbar: z.strictObject({
    schemaVersion: version,
    kind: z.literal('listToolbar'),
  }),
  listRow: z.strictObject({
    schemaVersion: version,
    kind: z.literal('listRow'),
  }),
  listCell: z.strictObject({
    schemaVersion: version,
    kind: z.literal('listCell'),
    fieldId: id,
  }),
  lineTableToolbar: z.strictObject({
    schemaVersion: version,
    kind: z.literal('lineTableToolbar'),
    tableId: sectionId,
  }),
  lineRow: z.strictObject({
    schemaVersion: version,
    kind: z.literal('lineRow'),
    tableId: sectionId,
  }),
  lineCell: z.strictObject({
    schemaVersion: version,
    kind: z.literal('lineCell'),
    tableId: sectionId,
    fieldId: id,
  }),
  boardCard: z.strictObject({
    schemaVersion: version,
    kind: z.literal('boardCard'),
  }),
  metricCard: z.strictObject({
    schemaVersion: version,
    kind: z.literal('metricCard'),
    metricId: sectionId,
  }),
  homeSection: z.strictObject({
    schemaVersion: version,
    kind: z.literal('homeSection'),
    slotId: sectionId,
  }),
} as const satisfies Record<PlacementKind, z.ZodType>;

/** A placement by canonical IDs, never labels. */
export const PlacementSchema = z.discriminatedUnion('kind', [
  placement.formHeader,
  placement.formSection,
  placement.field,
  placement.listToolbar,
  placement.listRow,
  placement.listCell,
  placement.lineTableToolbar,
  placement.lineRow,
  placement.lineCell,
  placement.boardCard,
  placement.metricCard,
  placement.homeSection,
]);
export type Placement = z.infer<typeof PlacementSchema>;

export const TonePlacementSchema = z.discriminatedUnion('kind', [
  placement.field,
  placement.listCell,
  placement.listRow,
  placement.lineRow,
  placement.lineCell,
  placement.boardCard,
  placement.metricCard,
]);
export type TonePlacement = z.infer<typeof TonePlacementSchema>;

export const SizingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: version,
    kind: z.literal('listColumn'),
    fieldId: id,
    width: z.enum(COLUMN_WIDTHS),
    overflow: z.enum(COLUMN_OVERFLOWS),
  }),
  z.strictObject({
    schemaVersion: version,
    kind: z.literal('formField'),
    fieldId: id,
    span: z.enum(FIELD_SPANS),
    height: z.enum(FIELD_HEIGHTS).optional(),
  }),
  z.strictObject({
    schemaVersion: version,
    kind: z.literal('card'),
    size: z.enum(CARD_SIZES),
  }),
]);
export type Sizing = z.infer<typeof SizingSchema>;

/** The field-type pins a compiled rule carries, as ADR-0076 bindings do. */
export const PresentationOperandTypeSchema = z.union([
  z.strictObject({
    kind: z.enum(['text', 'boolean', 'integer', 'date']),
  }),
  z.strictObject({
    kind: z.literal('decimal'),
    precision: z.int().min(1).max(38),
    scale: z.int().min(0).max(18),
    currency: z.string().min(3).max(3).nullable(),
    unit: id.nullable(),
  }),
]);
export type PresentationOperandType = z.infer<
  typeof PresentationOperandTypeSchema
>;

/**
 * The member body. `predicate` is the ADR-0076 condition kernel's schema, so a
 * tone reuses the validation language rather than a new one.
 */
export function surfacePresentationRevisionSchema(
  predicate: z.ZodType<ValidationPredicate>,
) {
  const toneRule = z.strictObject({
    schemaVersion: version,
    ruleId: id,
    target: TonePlacementSchema,
    when: predicate,
    tone: z.enum(TONES),
    /** The word shown and the accessible reason ("Short of stock"). */
    reason: LayoutTextSchema,
  });
  return z.strictObject({
    schemaVersion: version,
    version: z.literal(PRESENTATION_MEMBER_VERSION),
    surface: id,
    revisionId: z.uuid(),
    predecessor: z.uuid().nullable(),
    status: z.enum(['active', 'retired']),
    toneRules: z.array(toneRule).max(MAX_TONE_RULES),
    sizing: z.array(SizingSchema).max(MAX_SIZING_ENTRIES),
    density: z.enum(DENSITIES).nullable(),
    viewDensity: z
      .array(
        z.strictObject({
          viewId: id,
          density: z.enum(DENSITIES),
        }),
      )
      .max(8),
  });
}
export type SurfacePresentationRevision = z.infer<
  ReturnType<typeof surfacePresentationRevisionSchema>
>;
export type ToneRule = SurfacePresentationRevision['toneRules'][number];

/** The compiled surface key: the member, plus pinned operand types per rule. */
export function compiledPresentationSchema(
  revision: ReturnType<typeof surfacePresentationRevisionSchema>,
) {
  return z.strictObject({
    revision,
    operands: z
      .record(id, z.record(id, PresentationOperandTypeSchema))
      .optional(),
    /** Rules or sizes that stopped applying on this base, by affected ID. */
    inert: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(512),
          subject: z.string().min(1).max(512),
          reason: z.string().min(1).max(400),
        }),
      )
      .optional(),
  });
}
