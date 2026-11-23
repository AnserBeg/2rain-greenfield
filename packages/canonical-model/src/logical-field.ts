import { z } from 'zod';

/**
 * CUSTOMIZE-6 slice 1: the logical value kind of a field, beyond its stored
 * scalar. Each kind reuses an EXISTING canonical field type, so storage,
 * validation, reports and calculated displays read it as they read a
 * first-party field of that type:
 *
 * - `decimal`: an `exactDecimalFieldType` with its declared scale.
 * - `money`: an `exactDecimalFieldType` whose currency is the entity's
 *   `reportSource.amounts` binding (REPORTS-1), fixed or stored on the record.
 * - `quantity`: a `quantityFieldType` whose `baseUnit` names a declared unit;
 *   `unitLabel` is how the unit is shown.
 * - `longText`: a `textFieldType` shown as multiple lines.
 * - `currencyCode`: the three-character currency a stored money binding reads.
 *
 * The optional v6 `logicalFields` declaration and the surface manifest's
 * `logicalFieldBindings` carry the kind to readers at surface rung
 * LOGICAL_FIELD_READER. Omission emits nothing, so a release without these
 * kinds keeps the bytes the preceding compiler produced.
 */
// Provisional rung: assigned at merge (MIGRATION-RULE, capability rung rule).
export const LOGICAL_FIELD_READER = 48;
export const LOGICAL_FIELD_TYPES = [
  'decimal',
  'money',
  'quantity',
  'longText',
  'currencyCode',
] as const;
export type LogicalFieldType = (typeof LOGICAL_FIELD_TYPES)[number];
/** The codes a stored currency field may hold (the REPORTS-1 stored list). */
export const STORED_CURRENCY_CODES = ['CAD', 'USD', 'EUR'] as const;
/** The longest text a tenant long-text field holds. */
export const LONG_TEXT_MAXIMUM_LENGTH = 4_000;
/** Precision of a tenant decimal, money or quantity field. */
export const LOGICAL_DECIMAL_PRECISION = 18;
export const LOGICAL_DECIMAL_MAXIMUM_SCALE = 9;

const id = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  );
/** A unit as people write it: `kg`, `h`, `m3`, `km/h`, `pallet`. */
export const UnitLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(
    /^[A-Za-z][A-Za-z0-9 ./-]*$/u,
    'a unit starts with a letter and uses letters, digits, spaces, dots, slashes or hyphens',
  );
const common = {
  schemaVersion: z.literal('v6'),
  fieldId: id,
  entityId: id,
};
export const LogicalFieldDeclarationSchema = z.discriminatedUnion(
  'logicalType',
  [
    z.strictObject({ ...common, logicalType: z.literal('decimal') }),
    z.strictObject({ ...common, logicalType: z.literal('money') }),
    z.strictObject({
      ...common,
      logicalType: z.literal('quantity'),
      unitLabel: UnitLabelSchema,
    }),
    z.strictObject({ ...common, logicalType: z.literal('longText') }),
    z.strictObject({ ...common, logicalType: z.literal('currencyCode') }),
  ],
);
export type LogicalFieldDeclaration = z.infer<
  typeof LogicalFieldDeclarationSchema
>;

/** The declared unit's stable ID: one per unit spelling per namespace. */
export function logicalUnitId(namespace: string, unitLabel: string): string {
  const local = unitLabel
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 40);
  return `${namespace}:capability.unit_${local || 'unit'}`;
}
