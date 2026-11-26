import { z } from 'zod';

import {
  LINE_LOGICAL_FIELD_READER,
  LOGICAL_FIELD_READER,
  STORED_CURRENCY_CODES,
  AllowedValuesSchema,
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
  /** A text field's declared allowed values (a currency field's codes). */
  allowedValues: AllowedValuesSchema.optional(),
});
export type LogicalFieldBinding = z.infer<typeof LogicalFieldBindingSchema>;

interface DefinitionView {
  readonly package: { readonly namespace: string };
  readonly logicalFields?: readonly unknown[] | undefined;
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
    readonly collation?: string;
    readonly fieldType: Readonly<Record<string, unknown>>;
  }[];
  readonly relations?: readonly RelationView[];
}

interface RelationView {
  readonly relationId: string;
  readonly ownership?: string;
  readonly lifecycle?: string;
  readonly sourceEntity: { readonly targetId: string };
  readonly targetEntity: { readonly targetId: string };
}

/** Whether a record type is a line table: the child of a parent-scoped relation. */
export function isLineEntity(
  definition: { readonly relations?: readonly RelationView[] },
  entityId: string,
): boolean {
  return (definition.relations ?? []).some(
    (r) =>
      r.ownership === 'parentScopedChild' &&
      r.sourceEntity.targetId === entityId,
  );
}

/**
 * CUSTOMIZE-6 slice 2: the record type holding a stored amount's currency
 * field. No path is the amount's own record type (slice 1). The one path
 * admitted is the line's own parent link, so a line amount reads the header's
 * currency: a header is fixed for a line's life, while a reference link could
 * be repointed and silently re-currency stored amounts. Anything else is null.
 */
export function currencyHolderEntity(
  definition: { readonly relations?: readonly RelationView[] },
  entityId: string,
  via: readonly string[] | undefined,
): string | null {
  if (via === undefined) return entityId;
  if (via.length !== 1) return null;
  const parent = (definition.relations ?? []).find(
    (r) => r.relationId === via[0],
  );
  return parent &&
    parent.ownership === 'parentScopedChild' &&
    (parent.lifecycle ?? 'active') === 'active' &&
    parent.sourceEntity.targetId === entityId
    ? parent.targetEntity.targetId
    : null;
}

/**
 * The surface reader floor a definition's logical fields need: none without
 * the key; LINE_LOGICAL_FIELD_READER when any declaration (retired included)
 * is on a line table or any amount reads its currency through a path, since
 * an older reader would serve those without their meaning; otherwise
 * LOGICAL_FIELD_READER.
 */
export function logicalFieldReaderFloor(definition: {
  readonly logicalFields?: readonly unknown[] | undefined;
  readonly relations?: readonly RelationView[];
  readonly entities?: readonly {
    readonly reportSource?: {
      readonly amounts?: readonly { readonly currency: unknown }[];
    };
  }[];
}): number | null {
  if (!definition.logicalFields) return null;
  const onLine = definition.logicalFields.some((raw) => {
    const entityId = (raw as { entityId?: unknown } | null)?.entityId;
    return typeof entityId === 'string' && isLineEntity(definition, entityId);
  });
  const throughPath = (definition.entities ?? []).some((entity) =>
    (entity.reportSource?.amounts ?? []).some(
      (amount) =>
        (amount.currency as { via?: unknown } | null)?.via !== undefined,
    ),
  );
  return onLine || throughPath
    ? LINE_LOGICAL_FIELD_READER
    : LOGICAL_FIELD_READER;
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
  const bindings: z.input<typeof LogicalFieldBindingSchema>[] = [];
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
        // A currency read through a path names a declared currency field of
        // the header that path reaches (CUSTOMIZE-6 slice 2).
        if (amount.currency.kind === 'stored' && amount.currency.via) {
          const holder = currencyHolderEntity(
            definition,
            entity.entityId,
            amount.currency.via,
          );
          const fieldId = amount.currency.fieldId;
          if (
            holder === null ||
            !(definition.logicalFields ?? []).some(
              (d) =>
                (d as { fieldId?: unknown }).fieldId === fieldId &&
                (d as { entityId?: unknown }).entityId === holder &&
                (d as { logicalType?: unknown }).logicalType === 'currencyCode',
            )
          )
            return refuse(
              "money read through a path reads a declared currency field of the line's header.",
            );
        }
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
      case 'text': {
        if (type.kind !== 'textFieldType')
          return refuse(`${declaration.logicalType} stores a text value.`);
        const allowed = declaration.allowedValues;
        if (
          allowed?.some(
            (value) => [...value].length > Number(type.maximumLength),
          )
        )
          return refuse('an allowed value is longer than the field holds.');
        bindings.push(allowed ? { ...base, allowedValues: allowed } : base);
        break;
      }
      case 'currencyCode':
        if (
          type.kind !== 'textFieldType' ||
          type.maximumLength !== 3 ||
          field.collation !== 'binary'
        )
          return refuse(
            'a currency code stores three characters compared exactly.',
          );
        if (
          !declaration.allowedValues.every((code) =>
            (STORED_CURRENCY_CODES as readonly string[]).includes(code),
          )
        )
          return refuse(
            `a currency field allows only ${STORED_CURRENCY_CODES.join(', ')}.`,
          );
        bindings.push({ ...base, allowedValues: declaration.allowedValues });
        break;
    }
  }
  bindings.sort((a, b) =>
    a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
  );
  return {
    status: 'bound',
    bindings: bindings.map((binding) =>
      LogicalFieldBindingSchema.parse(binding),
    ),
  };
}
