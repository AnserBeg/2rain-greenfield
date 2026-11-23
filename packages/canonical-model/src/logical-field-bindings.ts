import { z } from 'zod';

import {
  LOGICAL_FIELD_TYPES,
  LogicalFieldDeclarationSchema,
  UnitLabelSchema,
  logicalUnitId,
  type LogicalFieldDeclaration,
} from './logical-field.js';
import {
  CanonicalIdSchema,
  ReportCurrencyBindingSchema,
  type ReportCurrencyBinding,
} from './schemas.js';

/**
 * What the surface manifest carries for each active logical field: its stable
 * ID, its kind and the facts a reader needs to show it -- the scale, the
 * currency binding (read from the entity's `reportSource`, never restated by
 * the author) and the unit. Derived from the definition alone, so a serving
 * loader recomputes it from the pinned revision and refuses a disagreement.
 */
export const LogicalFieldBindingSchema = z.strictObject({
  fieldId: CanonicalIdSchema,
  entityId: CanonicalIdSchema,
  logicalType: z.enum(LOGICAL_FIELD_TYPES),
  scale: z.int().min(0).max(18).optional(),
  currency: ReportCurrencyBindingSchema.optional(),
  unit: z
    .strictObject({ unitId: CanonicalIdSchema, label: UnitLabelSchema })
    .optional(),
});
export type LogicalFieldBinding = z.infer<typeof LogicalFieldBindingSchema>;

interface DefinitionView {
  readonly package: { readonly namespace: string };
  readonly logicalFields?: readonly unknown[];
  readonly entities: readonly {
    readonly entityId: string;
    readonly reportSource?: {
      readonly amounts?: readonly {
        readonly fieldId: string;
        readonly currency: ReportCurrencyBinding;
      }[];
    };
  }[];
  readonly fields: readonly {
    readonly fieldId: string;
    readonly entity: { readonly targetId: string };
    readonly lifecycle?: string;
    readonly fieldType: Readonly<Record<string, unknown>>;
  }[];
}

export type LogicalFieldOutcome =
  | { readonly status: 'bound'; readonly bindings: LogicalFieldBinding[] }
  | {
      readonly status: 'refused';
      readonly fieldId: string;
      readonly message: string;
    };

/** Admit every declaration against its one field and derive the bindings. */
export function deriveLogicalFieldBindings(
  definition: DefinitionView,
): LogicalFieldOutcome {
  const bindings: LogicalFieldBinding[] = [];
  const seen = new Set<string>();
  const unitLabels = new Map<string, string>();
  for (const raw of definition.logicalFields ?? []) {
    const parsed = LogicalFieldDeclarationSchema.safeParse(raw);
    const fieldId =
      (raw as { fieldId?: unknown } | null)?.fieldId?.toString() ?? 'unnamed';
    const refuse = (detail: string): LogicalFieldOutcome => ({
      status: 'refused',
      fieldId,
      message: `logical field ${fieldId}: ${detail}`,
    });
    if (!parsed.success) return refuse('the declaration is malformed.');
    const declaration: LogicalFieldDeclaration = parsed.data;
    if (seen.has(fieldId)) return refuse('the field is declared twice.');
    seen.add(fieldId);
    const field = definition.fields.find((f) => f.fieldId === fieldId);
    const entity = definition.entities.find(
      (e) => e.entityId === declaration.entityId,
    );
    if (!field || !entity || field.entity.targetId !== entity.entityId)
      return refuse('the declaration must name one field on its record type.');
    // Retired fields are not validated (MIGRATION-RULE rule 10).
    if ((field.lifecycle ?? 'active') !== 'active') continue;
    const type = field.fieldType;
    const amount = entity.reportSource?.amounts?.find(
      (a) => a.fieldId === fieldId,
    );
    const scale = typeof type.scale === 'number' ? type.scale : undefined;
    const base = {
      fieldId,
      entityId: entity.entityId,
      logicalType: declaration.logicalType,
    };
    switch (declaration.logicalType) {
      case 'decimal':
        if (type.kind !== 'exactDecimalFieldType' || amount)
          return refuse('a decimal stores an exact decimal without currency.');
        bindings.push({ ...base, scale: scale! });
        break;
      case 'money':
        if (type.kind !== 'exactDecimalFieldType' || !amount)
          return refuse(
            'money stores an exact decimal bound to a currency in the record type report source.',
          );
        bindings.push({ ...base, scale: scale!, currency: amount.currency });
        break;
      case 'quantity': {
        const unitId = (type.baseUnit as { targetId?: string } | undefined)
          ?.targetId;
        const expected = logicalUnitId(
          definition.package.namespace,
          declaration.unitLabel,
        );
        if (type.kind !== 'quantityFieldType' || unitId !== expected)
          return refuse('a quantity stores its declared unit as base unit.');
        const label = unitLabels.get(expected);
        if (label !== undefined && label !== declaration.unitLabel)
          return refuse(
            `the unit ${expected} is already spelled "${label}"; use one spelling.`,
          );
        unitLabels.set(expected, declaration.unitLabel);
        bindings.push({
          ...base,
          scale: scale!,
          unit: { unitId: expected, label: declaration.unitLabel },
        });
        break;
      }
      case 'longText':
        if (type.kind !== 'textFieldType')
          return refuse('long text stores a text value.');
        bindings.push(base);
        break;
      case 'currencyCode':
        if (type.kind !== 'textFieldType' || type.maximumLength !== 3)
          return refuse('a currency code stores three characters.');
        bindings.push(base);
        break;
    }
  }
  bindings.sort((a, b) =>
    a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
  );
  return { status: 'bound', bindings };
}
