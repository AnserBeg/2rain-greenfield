import type { FormulaValidationRule } from './formula-validation-schema.js';
import { resolveValidationPath } from './formula-validation-path.js';
import { canonicalize } from './canonicalize.js';
import {
  VALIDATION_POSITION_PROFILE,
  type ValidationOperand,
  type ValidationPredicate,
  type ValidationScalar,
} from './formula-validation.js';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

export const BUSINESS_DATE_FIELD_ID = 'northstar.runtime:field.business_date';
export const VALIDATION_KERNEL_VERSION = 'northstar.formula-validation/v1';

type Revision = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;
type Field = Revision['fields'][number];
export type FormulaValidationFieldType =
  | { readonly kind: 'text' | 'boolean' | 'integer' | 'date' | 'address' }
  | {
      readonly kind: 'decimal';
      readonly precision: number;
      readonly scale: number;
      readonly currency: string | null;
      readonly unit: string | null;
    };

export interface BoundValidationPath {
  readonly relationId: string;
  readonly targetEntityId: string;
  readonly fieldId: string;
  readonly fieldType: FormulaValidationFieldType;
  readonly fieldClassification: 'public' | 'internal';
  readonly readQueryId: string;
  readonly readPermissionId: string;
}

export interface BoundFormulaValidation {
  readonly rule: FormulaValidationRule;
  readonly bindingPosition: 'validation';
  readonly phase: 'transaction';
  readonly purity: 'deterministic';
  readonly target: 'transactionBoundServer';
  readonly resultType: 'threeValuedBoolean';
  readonly positionProfile: typeof VALIDATION_POSITION_PROFILE;
  readonly kernelVersion: typeof VALIDATION_KERNEL_VERSION;
  readonly writeSet: 'changedValues';
  readonly allowedSinks: readonly ['operationRefusal'];
  readonly explanation: 'configuredMessageAndFieldAnchors';
  readonly watchedFields: Readonly<Record<string, FormulaValidationFieldType>>;
  readonly watchedRelationIds?: readonly string[];
  readonly paths?: readonly BoundValidationPath[];
  readonly contextDependencies: readonly string[];
}

export type FormulaValidationBinding =
  | { readonly status: 'bound'; readonly binding: BoundFormulaValidation }
  | { readonly status: 'refused'; readonly message: string };

export function retypedFormulaRule(
  source: VersionedNormalizedApplicationPackage,
  target: VersionedNormalizedApplicationPackage,
  inheritedFrom?: VersionedNormalizedApplicationPackage,
): string | null {
  if (source.languageVersion !== 'v6' || !source.formulaRules) return null;
  if (target.languageVersion !== 'v6')
    return source.formulaRules[0]?.ruleId ?? null;
  for (const rule of source.formulaRules) {
    const before = bindLiteralValidation(rule, source);
    const after = target.formulaRules?.find(
      ({ ruleId }) => ruleId === rule.ruleId,
    );
    if (
      before.status !== 'bound' ||
      (!inheritedFrom &&
        (!after || bindLiteralValidation(after, target).status !== 'bound'))
    )
      return rule.ruleId;
    const watched = Object.keys(before.binding.watchedFields).filter(
      (fieldId) =>
        !inheritedFrom ||
        inheritedFrom.fields.some((field) => field.fieldId === fieldId),
    );
    const operationIds = rule.boundOperationIds.filter(
      (operationId) =>
        !inheritedFrom ||
        inheritedFrom.operations.some(
          (operation) => operation.operationId === operationId,
        ),
    );
    const fieldTypes = (revision: Revision) =>
      watched.map((fieldId) => {
        const field = revision.fields.find(
          (candidate) => candidate.fieldId === fieldId,
        );
        return field?.lifecycle === 'active' ? field.fieldType : null;
      });
    const operationTypes = (revision: Revision) =>
      operationIds.map((operationId) => {
        const operation = revision.operations.find(
          (candidate) => candidate.operationId === operationId,
        );
        return operation?.lifecycle === 'active'
          ? { effect: operation.effect, permission: operation.permission }
          : null;
      });
    const paths = before.binding.paths ?? [];
    const inheritedPaths = inheritedFrom
      ? paths.filter(
          ({ fieldId, relationId }) =>
            inheritedFrom.fields.some((field) => field.fieldId === fieldId) &&
            inheritedFrom.relations.some(
              (relation) => relation.relationId === relationId,
            ),
        )
      : paths;
    const pathTypes = (revision: Revision) =>
      inheritedPaths.map((path) => {
        const resolved = resolveValidationPath(
          {
            kind: 'path',
            schemaVersion: rule.schemaVersion,
            relationIds: [path.relationId],
            fieldId: path.fieldId,
          },
          rule.targetId,
          revision,
        );
        return resolved
          ? {
              fieldType: resolved.field.fieldType,
              classification: resolved.field.classification,
              relation: {
                cardinality: resolved.relation.cardinality,
                required: resolved.relation.required,
                ownership: resolved.relation.ownership,
                archiveBehavior: resolved.relation.archiveBehavior,
                targetEntityId: resolved.relation.targetEntity.targetId,
              },
              readQueryId: resolved.reader.queryId,
              readPermission: resolved.reader.permission,
              legalEntityScope: resolved.reader.legalEntityScope ?? null,
              filter: resolved.reader.filter,
            }
          : null;
      });
    if (
      canonicalize(fieldTypes(source)) !== canonicalize(fieldTypes(target)) ||
      canonicalize(operationTypes(source)) !==
        canonicalize(operationTypes(target)) ||
      canonicalize(pathTypes(source)) !== canonicalize(pathTypes(target))
    )
      return rule.ruleId;
  }
  return null;
}

export function formulaFieldType(
  field: Pick<Field, 'fieldType'>,
): FormulaValidationFieldType | null {
  const type = field.fieldType;
  switch (type.kind) {
    case 'addressFieldType':
      return { kind: 'address' };
    case 'textFieldType':
      return { kind: 'text' };
    case 'booleanFieldType':
      return { kind: 'boolean' };
    case 'integerFieldType':
      return { kind: 'integer' };
    case 'dateFieldType':
      return { kind: 'date' };
    case 'exactDecimalFieldType':
    case 'quantityFieldType':
    case 'moneyFieldType':
      return {
        kind: 'decimal',
        precision: type.precision,
        scale: type.scale,
        currency: type.kind === 'moneyFieldType' ? type.currencyCode : null,
        unit: type.kind === 'quantityFieldType' ? type.baseUnit.targetId : null,
      };
    default:
      return null;
  }
}

function sameType(
  left: FormulaValidationFieldType,
  right: ValidationScalar | FormulaValidationFieldType,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'decimal' ||
      (right.kind === 'decimal' &&
        left.currency === right.currency &&
        left.unit === right.unit))
  );
}

export function bindLiteralValidation(
  rule: FormulaValidationRule,
  revision: Pick<
    Revision,
    'entities' | 'fields' | 'operations' | 'relations' | 'queries'
  >,
): FormulaValidationBinding {
  if (
    !revision.entities.some(
      (entity) =>
        entity.entityId === rule.targetId && entity.lifecycle === 'active',
    )
  ) {
    return { status: 'refused', message: 'Choose an active record type.' };
  }
  const operationIds = new Set(rule.boundOperationIds);
  if (operationIds.size !== rule.boundOperationIds.length) {
    return {
      status: 'refused',
      message: 'Bind each create or update operation once.',
    };
  }
  const operations = revision.operations.filter(
    (operation) =>
      operationIds.has(operation.operationId) &&
      operation.lifecycle === 'active' &&
      operation.tier === 'o0' &&
      (operation.effect.kind === 'createRecordEffect' ||
        operation.effect.kind === 'updateRecordEffect') &&
      operation.effect.entity.targetId === rule.targetId,
  );
  if (operations.length !== operationIds.size) {
    return {
      status: 'refused',
      message:
        'Bind the rule to active create and update operations for this record type.',
    };
  }

  const fields = new Map<string, Field>(
    revision.fields
      .filter(
        (field) =>
          field.entity.targetId === rule.targetId &&
          field.lifecycle === 'active' &&
          (field.classification === 'public' ||
            field.classification === 'internal'),
      )
      .map((field) => [field.fieldId, field]),
  );
  const dependencies = new Map<string, FormulaValidationFieldType>();
  const contextDependencies = new Set<string>();
  const paths = new Map<string, BoundValidationPath>();
  const fieldType = (
    operand: ValidationOperand,
  ): FormulaValidationFieldType | null => {
    if (operand.kind !== 'field') return null;
    const field = fields.get(operand.fieldId);
    const type = field && formulaFieldType(field);
    if (!type || (operand.select === 'textLength' && type.kind !== 'text'))
      return null;
    dependencies.set(operand.fieldId, type);
    return operand.select === 'textLength' ? { kind: 'integer' } : type;
  };

  const check = (predicate: ValidationPredicate): string | null => {
    switch (predicate.kind) {
      case 'required':
        return predicate.operand.kind === 'field' &&
          predicate.operand.select === 'value' &&
          fieldType(predicate.operand)
          ? null
          : 'A required rule must name a supported field on this record.';
      case 'not':
        return check(predicate.term);
      case 'all':
      case 'any':
        for (const term of predicate.terms) {
          const refusal = check(term);
          if (refusal) return refusal;
        }
        return null;
      case 'comparison': {
        const left = fieldType(predicate.left);
        if (!left || left.kind === 'address')
          return 'Compare a supported field on this record with a typed value.';
        if (
          predicate.operator !== 'equal' &&
          predicate.operator !== 'notEqual' &&
          (left.kind === 'text' || left.kind === 'boolean')
        )
          return 'Use a number, calendar date or text length for an ordered comparison.';
        const operand = predicate.right;
        if (
          operand.kind === 'field' &&
          operand.fieldId === BUSINESS_DATE_FIELD_ID &&
          operand.select === 'value'
        ) {
          if (left.kind !== 'date')
            return 'Use a calendar date field with the business date.';
          contextDependencies.add(BUSINESS_DATE_FIELD_ID);
          return null;
        }
        if (operand.kind === 'field') {
          const right = fieldType(operand);
          return right && sameType(left, right)
            ? null
            : 'Compare fields with the same type, currency and unit.';
        }
        if (operand.kind === 'path') {
          const resolved = resolveValidationPath(
            operand,
            rule.targetId,
            revision,
          );
          const right = resolved && formulaFieldType(resolved.field);
          if (!resolved || !right || !sameType(left, right))
            return 'Choose a visible field of the same type, currency and unit through one declared relation.';
          const { field, reader, relation } = resolved;
          paths.set(`${relation.relationId}/${field.fieldId}`, {
            relationId: relation.relationId,
            targetEntityId: relation.targetEntity.targetId,
            fieldId: field.fieldId,
            fieldType: right,
            fieldClassification:
              field.classification === 'public' ? 'public' : 'internal',
            readQueryId: reader.queryId,
            readPermissionId: reader.permission.targetId,
          });
          return null;
        }
        if (!sameType(left, operand.scalar))
          return 'The field and its bound must have the same type, currency and unit.';
        if (
          predicate.left.kind === 'field' &&
          predicate.left.select === 'textLength' &&
          operand.scalar.kind === 'integer' &&
          operand.scalar.value.startsWith('-')
        )
          return 'Use a nonnegative text length.';
        return null;
      }
    }
  };
  const refusal = check(rule.predicate);
  if (refusal) return { status: 'refused', message: refusal };
  if (
    new Set(rule.fieldAnchors).size !== rule.fieldAnchors.length ||
    rule.fieldAnchors.some((fieldId) => !dependencies.has(fieldId))
  ) {
    return {
      status: 'refused',
      message: 'Anchor the message to a field that the rule checks.',
    };
  }

  return {
    status: 'bound',
    binding: {
      rule,
      bindingPosition: 'validation',
      phase: 'transaction',
      purity: 'deterministic',
      target: 'transactionBoundServer',
      resultType: 'threeValuedBoolean',
      positionProfile: VALIDATION_POSITION_PROFILE,
      kernelVersion: VALIDATION_KERNEL_VERSION,
      writeSet: 'changedValues',
      allowedSinks: ['operationRefusal'],
      explanation: 'configuredMessageAndFieldAnchors',
      watchedFields: Object.fromEntries(
        [...dependencies].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
      contextDependencies: [...contextDependencies].sort(),
      ...(paths.size
        ? {
            paths: [...paths]
              .sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              )
              .map(([, path]) => path),
            watchedRelationIds: [
              ...new Set(
                [...paths.values()].map(({ relationId }) => relationId),
              ),
            ].sort(),
          }
        : {}),
    },
  };
}
