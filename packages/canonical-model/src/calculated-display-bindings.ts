import { canonicalize } from './canonicalize.js';
import {
  displayArithmeticType,
  decimalDisplayCoefficient,
  type DisplayDecimalType,
} from './calculated-display.js';
import type {
  CalculatedDisplayField,
  DisplayOperand,
} from './calculated-display-schema.js';
import { formulaFieldType } from './formula-validation-bindings.js';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

type PackageV6 = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;
type Field = PackageV6['fields'][number];

export interface BoundDisplayOperand {
  readonly operand: DisplayOperand;
  readonly valueType: DisplayDecimalType;
}

export interface BoundCalculatedDisplayField {
  readonly declaration: CalculatedDisplayField;
  readonly classification: 'public' | 'internal';
  readonly left: BoundDisplayOperand;
  readonly right: BoundDisplayOperand;
  readonly readSinks: readonly {
    readonly kind: 'record' | 'list';
    readonly surfaceId: string;
    readonly queryId: string;
    readonly permissionId: string;
  }[];
}

// The Catalog declares these stable slots separately for each currency. A
// display expression never infers a currency from tenant-authored names.
const catalogCurrencyByField = new Map([
  ['northstar.app:field.item_price_cad', 'CAD'],
  ['northstar.app:field.item_price_usd', 'USD'],
  ['northstar.app:field.item_price_eur', 'EUR'],
  ['northstar.app:field.item_standard_cost_cad', 'CAD'],
  ['northstar.app:field.item_standard_cost_usd', 'USD'],
  ['northstar.app:field.item_standard_cost_eur', 'EUR'],
]);

export function displayTypeForField(field: Field): DisplayDecimalType | null {
  if (field.classification !== 'public' && field.classification !== 'internal')
    return null;
  const type = formulaFieldType(field);
  if (type?.kind === 'integer')
    return { precision: 19, scale: 0, currency: null, unit: null };
  if (!type || type.kind !== 'decimal') return null;
  if (field.fieldType.kind !== 'exactDecimalFieldType')
    return {
      precision: type.precision,
      scale: type.scale,
      currency: type.currency,
      unit: type.unit,
    };
  const currency = catalogCurrencyByField.get(field.fieldId);
  return currency
    ? { precision: type.precision, scale: type.scale, currency, unit: null }
    : null;
}

export function bindCalculatedDisplayField(
  declaration: CalculatedDisplayField,
  revision: Pick<
    PackageV6,
    'package' | 'entities' | 'fields' | 'queries' | 'surfaces'
  >,
):
  | { status: 'bound'; binding: BoundCalculatedDisplayField }
  | { status: 'refused'; message: string } {
  if (!declaration.fieldId.startsWith(`${revision.package.namespace}:field.`))
    return {
      status: 'refused',
      message: 'Choose a field ID in the application namespace.',
    };
  if (
    !revision.entities.some(
      (entity) =>
        entity.entityId === declaration.entityId &&
        entity.lifecycle === 'active',
    )
  )
    return { status: 'refused', message: 'Choose an active record type.' };
  const operandType = (operand: DisplayOperand): DisplayDecimalType | null => {
    if (operand.kind === 'decimalLiteral')
      return decimalDisplayCoefficient(operand.value, operand.decimalType) ===
        null
        ? null
        : operand.decimalType;
    const field = revision.fields.find(
      (field) =>
        field.fieldId === operand.fieldId &&
        field.entity.targetId === declaration.entityId &&
        field.lifecycle === 'active',
    );
    return field ? displayTypeForField(field) : null;
  };
  const { operator, left, right } = declaration.expression;
  const leftType = operandType(left);
  const rightType = operandType(right);
  if (!leftType || !rightType)
    return {
      status: 'refused',
      message:
        'Choose readable numeric fields with declared units and currencies.',
    };
  const expected = displayArithmeticType(operator, leftType, rightType);
  if (!expected)
    return {
      status: 'refused',
      message:
        'The calculation combines incompatible currencies or units, or exceeds the exact decimal display bounds.',
    };
  if (
    expected.precision !== declaration.resultType.precision ||
    expected.scale !== declaration.resultType.scale ||
    expected.currency !== declaration.resultType.currency ||
    expected.unit !== declaration.resultType.unit
  )
    return {
      status: 'refused',
      message: 'The declared display type must match the calculation.',
    };
  const inputs = [left, right].flatMap((operand) =>
    operand.kind === 'field' ? [operand.fieldId] : [],
  );
  if (!inputs.length)
    return {
      status: 'refused',
      message: 'Choose at least one field from the record.',
    };
  const classification = revision.fields.some(
    (field) =>
      inputs.includes(field.fieldId) && field.classification === 'internal',
  )
    ? 'internal'
    : 'public';
  const sinks: BoundCalculatedDisplayField['readSinks'][number][] = [];
  const surfaces = new Set<string>();
  for (const sink of declaration.displaySinks) {
    const surface = revision.surfaces.find(
      (surface) =>
        surface.surfaceId === sink.surfaceId && surface.lifecycle === 'active',
    );
    const query =
      surface &&
      revision.queries.find(
        (query) =>
          query.queryId === surface.dataSource?.targetId &&
          query.lifecycle === 'active' &&
          query.sourceEntity.targetId === declaration.entityId &&
          query.tier === 'q0' &&
          !query.readModel,
      );
    const columns =
      surface &&
      (sink.kind === 'record'
        ? surface.composition?.fields
        : surface.list?.columns);
    if (
      !surface ||
      surface.surfaceRole !== sink.kind ||
      !columns ||
      !query ||
      query.queryType !== (sink.kind === 'record' ? 'get' : 'list') ||
      surfaces.has(sink.surfaceId)
    )
      return {
        status: 'refused',
        message: 'Choose a direct record page or list for this record type.',
      };
    const selected = new Set(
      query.selections.map(({ field }) => String(field.targetId)),
    );
    if (inputs.some((fieldId) => !selected.has(fieldId)))
      return {
        status: 'refused',
        message:
          'The page or list must already read every field used in the calculation.',
      };
    surfaces.add(sink.surfaceId);
    sinks.push({
      ...sink,
      queryId: query.queryId,
      permissionId: query.permission.targetId,
    });
  }
  if (!sinks.some(({ kind }) => kind === 'record'))
    return {
      status: 'refused',
      message: 'Choose a record page for the calculated value.',
    };
  return {
    status: 'bound',
    binding: {
      declaration,
      classification,
      left: { operand: left, valueType: leftType },
      right: { operand: right, valueType: rightType },
      readSinks: sinks,
    },
  };
}

export function retypedCalculatedDisplayField(
  source: VersionedNormalizedApplicationPackage,
  target: VersionedNormalizedApplicationPackage,
  inheritedFrom?: VersionedNormalizedApplicationPackage,
): string | null {
  if (source.languageVersion !== 'v6' || !source.calculatedDisplayFields)
    return null;
  if (target.languageVersion !== 'v6')
    return source.calculatedDisplayFields[0]?.fieldId ?? null;
  for (const display of source.calculatedDisplayFields) {
    const operandIds = [
      display.expression.left,
      display.expression.right,
    ].flatMap((operand) =>
      operand.kind === 'field' &&
      (!inheritedFrom ||
        inheritedFrom.fields.some(({ fieldId }) => fieldId === operand.fieldId))
        ? [operand.fieldId]
        : [],
    );
    const operandTypes = (revision: PackageV6) =>
      operandIds.map((id) => {
        const field = revision.fields.find(({ fieldId }) => fieldId === id);
        return field?.lifecycle === 'active'
          ? {
              fieldType: field.fieldType,
              classification: field.classification,
              displayType: displayTypeForField(field),
            }
          : null;
      });
    if (
      canonicalize(operandTypes(source)) !== canonicalize(operandTypes(target))
    )
      return display.fieldId;
    if (inheritedFrom) continue;
    const before = bindCalculatedDisplayField(display, source);
    const declaration = target.calculatedDisplayFields?.find(
      ({ fieldId }) => fieldId === display.fieldId,
    );
    const after =
      declaration && bindCalculatedDisplayField(declaration, target);
    if (
      before.status !== 'bound' ||
      after?.status !== 'bound' ||
      canonicalize(before.binding) !== canonicalize(after.binding)
    )
      return display.fieldId;
  }
  return null;
}
