import {
  displayArithmeticType,
  type DisplayDecimalType,
} from './calculated-display.js';
import {
  logicalDecimals,
  zeroComparesStoredMoney,
} from './formula-validation-bindings.js';
import { inspectPredicateForExecution } from './predicate-kernel.js';
import type { VersionedNormalizedApplicationPackage } from './schemas.js';

/**
 * ADR-0094: three optional v6 declarations, each the general form of a block.
 *
 * - A DERIVED STORED DECIMAL (`derivedDecimals`): a stored decimal, money or
 *   quantity field whose value the server computes on every write of its row
 *   from same-row exact arithmetic (add, subtract, multiply; depth at most 4),
 *   rounded half away from zero to the target's scale. A rental line's days x
 *   rate, a work order's hours x rate, an order line's quantity x price less a
 *   percent discount, a timesheet's hours x factor.
 * - A ROLLUP (`rollups`): a header value that sums one stored decimal of its
 *   lines over one declared parent-scoped relation, computed on read in slice
 *   1 (F5-a). Any document with lines: contracts, orders, invoices, quotes,
 *   timesheets, tax evidence.
 * - A CREATE-ONLY FIELD (`createOnlyFields`): any stored field that is written
 *   on create and refused on update: a document's currency, a contract type,
 *   anything fixed at creation.
 *
 * Omission emits nothing anywhere, so a release without these keys keeps the
 * bytes the preceding compiler produced.
 */
// Operation catalog reader 8: derived fields, create-only fields, the
// money-against-zero comparison, and a totalled relation's maximum and header
// lock (assigned at merge; MIGRATION-RULE capability rung rule).
export const LINE_TOTALS_OPERATION_READER = 8;
// Query catalog reader 7: a get's on-read rollup (assigned at merge).
export const ROLLUP_QUERY_READER = 7;
/** The maximum a drafter offers when the author names none (owner Q3). */
export const DEFAULT_MAXIMUM_LINES = 1_000;
export const MAXIMUM_DERIVED_DEPTH = 4;
/** The largest result precision a rollup may declare (PostgreSQL numeric). */
export const MAXIMUM_ROLLUP_PRECISION = 38;

export {
  lineTotalsSchemas,
  type CreateOnlyFieldDeclaration,
  type DerivedDecimalDeclaration,
  type DerivedTerm,
  type RollupDeclaration,
} from './line-totals-schema.js';
import type {
  CreateOnlyFieldDeclaration,
  DerivedDecimalDeclaration,
  DerivedTerm,
  RollupDeclaration,
} from './line-totals-schema.js';

// ---------------------------------------------------------------------------
// Compiled contract shapes (operation and query catalogs)
// ---------------------------------------------------------------------------

/** One derived target as a create or update input contract carries it. */
export interface CompiledDerivedField {
  readonly classification: 'INTERNAL' | 'PUBLIC';
  readonly fieldId: string;
  readonly precision: number;
  readonly scale: number;
  readonly rounding: 'halfAwayFromZero';
  readonly expression: DerivedTerm;
  readonly absentAs?: Readonly<Record<string, string>>;
}

/** A line write's totalled parent: the header lock and the line maximum. */
export interface CompiledTotalledRelation {
  readonly relationId: string;
  readonly maximumLines: number;
}

/** One on-read total a header get carries. */
export interface CompiledRollup {
  readonly fieldId: string;
  readonly lineEntityId: string;
  readonly relationId: string;
  readonly aggregandFieldId: string;
  readonly precision: number;
  readonly scale: number;
  /** The line list query whose policy decides whether the total is read. */
  readonly lineQueryId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const DECIMAL = /^(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/u;
const ID =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 180 && ID.test(value);
const isScale = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;

function parseTerm(value: unknown, depth: number): DerivedTerm | null {
  if (!isRecord(value) || depth > MAXIMUM_DERIVED_DEPTH) return null;
  if (value.kind === 'field')
    return exactKeys(value, ['kind', 'fieldId']) && isId(value.fieldId)
      ? Object.freeze({ kind: 'field', fieldId: value.fieldId })
      : null;
  if (value.kind === 'decimalLiteral')
    return exactKeys(value, ['kind', 'value']) &&
      typeof value.value === 'string' &&
      DECIMAL.test(value.value)
      ? Object.freeze({ kind: 'decimalLiteral', value: value.value })
      : null;
  if (
    value.kind !== 'arithmetic' ||
    !exactKeys(value, ['kind', 'operator', 'left', 'right']) ||
    (value.operator !== 'add' &&
      value.operator !== 'subtract' &&
      value.operator !== 'multiply')
  )
    return null;
  const left = parseTerm(value.left, depth + 1);
  const right = parseTerm(value.right, depth + 1);
  return left && right
    ? Object.freeze({
        kind: 'arithmetic',
        operator: value.operator,
        left,
        right,
      })
    : null;
}

/** The pinned `derivedFields` key, read exactly; `null` when malformed. */
export function parseCompiledDerivedFields(
  value: unknown,
): readonly CompiledDerivedField[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const out: CompiledDerivedField[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !exactKeys(
        entry,
        [
          'classification',
          'expression',
          'fieldId',
          'precision',
          'rounding',
          'scale',
        ],
        ['absentAs'],
      ) ||
      (entry.classification !== 'INTERNAL' &&
        entry.classification !== 'PUBLIC') ||
      !isId(entry.fieldId) ||
      seen.has(entry.fieldId) ||
      !Number.isSafeInteger(entry.precision) ||
      Number(entry.precision) < 1 ||
      Number(entry.precision) > MAXIMUM_ROLLUP_PRECISION ||
      !isScale(entry.scale, Number(entry.precision)) ||
      entry.rounding !== 'halfAwayFromZero'
    )
      return null;
    const expression = parseTerm(entry.expression, 1);
    if (!expression) return null;
    let absentAs: Record<string, string> | undefined;
    if (entry.absentAs !== undefined) {
      if (!isRecord(entry.absentAs) || !Object.keys(entry.absentAs).length)
        return null;
      absentAs = {};
      for (const [fieldId, literal] of Object.entries(entry.absentAs)) {
        if (!isId(fieldId) || typeof literal !== 'string') return null;
        if (!DECIMAL.test(literal)) return null;
        absentAs[fieldId] = literal;
      }
    }
    seen.add(entry.fieldId);
    out.push(
      Object.freeze({
        classification: entry.classification,
        fieldId: entry.fieldId,
        precision: Number(entry.precision),
        scale: Number(entry.scale),
        rounding: 'halfAwayFromZero',
        expression,
        ...(absentAs ? { absentAs: Object.freeze(absentAs) } : {}),
      }),
    );
  }
  return Object.freeze(out);
}

/** The pinned `totalledRelations` key, read exactly; `null` when malformed. */
export function parseCompiledTotalledRelations(
  value: unknown,
): readonly CompiledTotalledRelation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const out: CompiledTotalledRelation[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['maximumLines', 'relationId']) ||
      !isId(entry.relationId) ||
      seen.has(entry.relationId) ||
      !Number.isSafeInteger(entry.maximumLines) ||
      Number(entry.maximumLines) < 1
    )
      return null;
    seen.add(entry.relationId);
    out.push(
      Object.freeze({
        relationId: entry.relationId,
        maximumLines: Number(entry.maximumLines),
      }),
    );
  }
  return Object.freeze(out);
}

/** The pinned `createOnlyFieldIds` key, read exactly; `null` when malformed. */
export function parseCreateOnlyFieldIds(
  value: unknown,
): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isId) ||
    new Set(value).size !== value.length
  )
    return null;
  return Object.freeze([...(value as string[])]);
}

/** A get's pinned `rollups` key, read exactly; `null` when malformed. */
export function parseCompiledRollups(
  value: unknown,
): readonly CompiledRollup[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const out: CompiledRollup[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, [
        'aggregandFieldId',
        'fieldId',
        'lineEntityId',
        'lineQueryId',
        'precision',
        'relationId',
        'scale',
      ]) ||
      !isId(entry.fieldId) ||
      seen.has(entry.fieldId) ||
      !isId(entry.lineEntityId) ||
      !isId(entry.relationId) ||
      !isId(entry.aggregandFieldId) ||
      !isId(entry.lineQueryId) ||
      !Number.isSafeInteger(entry.precision) ||
      Number(entry.precision) < 1 ||
      Number(entry.precision) > MAXIMUM_ROLLUP_PRECISION ||
      !isScale(entry.scale, Number(entry.precision))
    )
      return null;
    seen.add(entry.fieldId);
    out.push(
      Object.freeze({
        fieldId: entry.fieldId,
        lineEntityId: entry.lineEntityId,
        relationId: entry.relationId,
        aggregandFieldId: entry.aggregandFieldId,
        precision: Number(entry.precision),
        scale: Number(entry.scale),
        lineQueryId: entry.lineQueryId,
      }),
    );
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// The evaluator: the one rounding site
// ---------------------------------------------------------------------------

interface Exact {
  readonly coefficient: bigint;
  readonly scale: number;
}

function exactOf(text: string): Exact | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) return null;
  const [, sign = '', whole = '', fraction = ''] = match;
  return {
    coefficient: BigInt(`${sign}${whole}${fraction}`),
    scale: fraction.length,
  };
}

function align(value: Exact, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

/**
 * Half away from zero, to `scale`: `0.495` -> `0.50`, `-0.125` -> `-0.13`.
 * The result is a coefficient AT the target scale.
 */
export function roundHalfAwayFromZero(value: Exact, scale: number): bigint {
  if (value.scale <= scale) return align(value, scale);
  const divisor = 10n ** BigInt(value.scale - scale);
  const negative = value.coefficient < 0n;
  const magnitude = negative ? -value.coefficient : value.coefficient;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

/** A coefficient at `scale` in canonical spelling (no trailing zeros). */
export function canonicalDecimalText(
  coefficient: bigint,
  scale: number,
): string {
  const sign = coefficient < 0n ? '-' : '';
  const digits = String(coefficient < 0n ? -coefficient : coefficient).padStart(
    scale + 1,
    '0',
  );
  if (!scale) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  const text = digits.slice(0, -scale) + (fraction ? `.${fraction}` : '');
  return text === '0' ? '0' : sign + text;
}

export type DerivedOutcome =
  | {
      readonly kind: 'value';
      readonly value: string;
      readonly coefficient: bigint;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'overflow' };

/**
 * Evaluate one derived target over a row's values. Intermediate results are
 * exact; the result is rounded once, here, and refused when its integer part
 * does not fit the target's precision. An absent operand (after `absentAs`)
 * makes the result absent.
 */
export function evaluateDerivedField(
  field: Pick<
    CompiledDerivedField,
    'expression' | 'precision' | 'scale' | 'absentAs'
  >,
  values: Readonly<Record<string, unknown>>,
): DerivedOutcome {
  const read = (fieldId: string): Exact | null | undefined => {
    const raw = values[fieldId];
    const value =
      raw === null || raw === undefined ? field.absentAs?.[fieldId] : raw;
    if (value === null || value === undefined) return null;
    const text =
      typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
    return typeof text === 'string' ? (exactOf(text) ?? undefined) : undefined;
  };
  const evaluate = (term: DerivedTerm): Exact | null => {
    switch (term.kind) {
      case 'field': {
        const value = read(term.fieldId);
        if (value === undefined)
          throw new TypeError(
            `derived operand ${term.fieldId} is not a decimal`,
          );
        return value;
      }
      case 'decimalLiteral':
        return exactOf(term.value);
      case 'arithmetic': {
        const left = evaluate(term.left);
        const right = evaluate(term.right);
        if (!left || !right) return null;
        if (term.operator === 'multiply')
          return {
            coefficient: left.coefficient * right.coefficient,
            scale: left.scale + right.scale,
          };
        const scale = Math.max(left.scale, right.scale);
        const a = align(left, scale);
        const b = align(right, scale);
        return {
          coefficient: term.operator === 'add' ? a + b : a - b,
          scale,
        };
      }
    }
  };
  const exact = evaluate(field.expression);
  if (!exact) return { kind: 'absent' };
  const coefficient = roundHalfAwayFromZero(exact, field.scale);
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  if (magnitude >= 10n ** BigInt(field.precision)) return { kind: 'overflow' };
  return {
    kind: 'value',
    value: canonicalDecimalText(coefficient, field.scale),
    coefficient,
  };
}

/** Two stored decimals equal as numbers ("0.50" equals "0.5"). */
export function sameDecimal(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined
  )
    return (left ?? null) === (right ?? null);
  const a = typeof left === 'string' ? exactOf(left) : null;
  const b = typeof right === 'string' ? exactOf(right) : null;
  if (!a || !b) return left === right;
  const scale = Math.max(a.scale, b.scale);
  return align(a, scale) === align(b, scale);
}

// ---------------------------------------------------------------------------
// The binder: every compile refusal of ADR-0094
// ---------------------------------------------------------------------------

type PackageV6 = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;
type Field = PackageV6['fields'][number];

export interface BoundLineTotals {
  /** Derived targets by entity, as the create and update contracts carry them. */
  readonly derived: ReadonlyMap<string, readonly CompiledDerivedField[]>;
  /** Totalled relations by line entity. */
  readonly totalled: ReadonlyMap<string, readonly CompiledTotalledRelation[]>;
  /** On-read totals by header entity. */
  readonly rollups: ReadonlyMap<string, readonly CompiledRollup[]>;
  /** Create-only field IDs by entity. */
  readonly createOnly: ReadonlyMap<string, readonly string[]>;
  readonly declared: boolean;
}

export type LineTotalsBinding =
  | { readonly status: 'bound'; readonly binding: BoundLineTotals }
  | {
      readonly status: 'refused';
      readonly path: string;
      readonly subjectId: string;
      readonly message: string;
    };

type Typed = DisplayDecimalType & { readonly binding: string | null };

function declarationsOf(revision: VersionedNormalizedApplicationPackage) {
  if (revision.languageVersion !== 'v6')
    return { derived: [], rollups: [], createOnly: [] };
  const v6 = revision as PackageV6 & {
    derivedDecimals?: readonly DerivedDecimalDeclaration[];
    rollups?: readonly RollupDeclaration[];
    createOnlyFields?: readonly CreateOnlyFieldDeclaration[];
  };
  return {
    derived: v6.derivedDecimals ?? [],
    rollups: v6.rollups ?? [],
    createOnly: v6.createOnlyFields ?? [],
  };
}

/** True when the revision declares any ADR-0094 key. */
export function declaresLineTotals(
  revision: VersionedNormalizedApplicationPackage,
): boolean {
  const { derived, rollups, createOnly } = declarationsOf(revision);
  return derived.length + rollups.length + createOnly.length > 0;
}

/**
 * A money field's currency as a BINDING: the field it reads, through the
 * relations it reads it through. Two operands share a currency only when they
 * resolve to the same field through the same path, not when their codes look
 * equal. `undefined` when the field has no declared currency.
 */
export function currencyBindingOf(
  revision: PackageV6,
  field: Field,
): string | null | undefined {
  if (field.fieldType.kind === 'moneyFieldType')
    return `fixed:${field.fieldType.currencyCode}`;
  const logical = logicalDecimals(revision).get(field.fieldId);
  if (logical?.logicalType !== 'money') return null;
  for (const entity of revision.entities as readonly {
    reportSource?: {
      amounts?: readonly {
        fieldId: string;
        currency:
          | { kind: 'fixed'; currencyCode: string }
          | { kind: 'stored'; fieldId: string; via?: readonly string[] };
      }[];
    };
  }[])
    for (const amount of entity.reportSource?.amounts ?? [])
      if (amount.fieldId === field.fieldId)
        return amount.currency.kind === 'fixed'
          ? `fixed:${amount.currency.currencyCode}`
          : `stored:${[...(amount.currency.via ?? []), amount.currency.fieldId].join('>')}`;
  return undefined;
}

function storedBindingField(binding: string | null): {
  readonly via: readonly string[];
  readonly fieldId: string;
} | null {
  if (!binding?.startsWith('stored:')) return null;
  const parts = binding.slice('stored:'.length).split('>');
  return { via: parts.slice(0, -1), fieldId: parts.at(-1)! };
}

function decimalTypeOf(
  revision: PackageV6,
  field: Field,
): Typed | null | undefined {
  const type = field.fieldType;
  if (
    type.kind !== 'exactDecimalFieldType' &&
    type.kind !== 'quantityFieldType' &&
    type.kind !== 'moneyFieldType'
  )
    return null;
  const binding = currencyBindingOf(revision, field);
  if (binding === undefined) return undefined;
  return {
    precision: type.precision,
    scale: type.scale,
    currency: binding,
    unit: type.kind === 'quantityFieldType' ? type.baseUnit.targetId : null,
    binding,
  };
}

function literalType(value: string): DisplayDecimalType {
  const digits = value.replace(/^-/u, '').replace('.', '');
  const scale = value.includes('.') ? value.split('.')[1]!.length : 0;
  return {
    precision: Math.max(digits.replace(/^0+(?=\d)/u, '').length, scale, 1),
    scale,
    currency: null,
    unit: null,
  };
}

function termDepth(term: DerivedTerm): number {
  return term.kind === 'arithmetic'
    ? 1 + Math.max(termDepth(term.left), termDepth(term.right))
    : 1;
}

function termFields(term: DerivedTerm, out = new Set<string>()): Set<string> {
  if (term.kind === 'field') out.add(term.fieldId);
  if (term.kind === 'arithmetic') {
    termFields(term.left, out);
    termFields(term.right, out);
  }
  return out;
}

function predicateFieldIds(
  value: unknown,
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) predicateFieldIds(entry, out);
    return out;
  }
  if (!isRecord(value)) return out;
  if (
    (value.kind === 'field' || value.kind === 'path') &&
    typeof value.fieldId === 'string'
  )
    out.add(value.fieldId);
  for (const [key, entry] of Object.entries(value))
    if (key !== 'fieldId') predicateFieldIds(entry, out);
  return out;
}

/**
 * The queries that carry a record type's on-read totals: its active, direct
 * (q0, no read model) gets. One predicate for the compiler's emission and the
 * binder's refusal, so nothing compiles that the reader would refuse.
 */
export function readsRollups(query: {
  readonly queryType: string;
  readonly lifecycle: string;
  readonly tier: string;
}): boolean {
  return (
    query.queryType === 'get' &&
    query.lifecycle === 'active' &&
    query.tier === 'q0' &&
    !('readModel' in query && (query as { readModel?: unknown }).readModel)
  );
}

/**
 * Binds every ADR-0094 declaration of a revision, refusing by name anything
 * the runtime could not honour. A revision without declarations binds to an
 * empty result, and nothing is emitted for it.
 */
export function bindLineTotals(
  revision: VersionedNormalizedApplicationPackage,
): LineTotalsBinding {
  const empty: BoundLineTotals = {
    derived: new Map(),
    totalled: new Map(),
    rollups: new Map(),
    createOnly: new Map(),
    declared: false,
  };
  if (revision.languageVersion !== 'v6' || !declaresLineTotals(revision))
    return { status: 'bound', binding: empty };
  const v6 = revision as PackageV6;
  const declarations = declarationsOf(revision);
  const refuse = (
    path: string,
    subjectId: string,
    message: string,
  ): LineTotalsBinding => ({ status: 'refused', path, subjectId, message });
  const fields = new Map<string, Field>(
    v6.fields.map((field) => [field.fieldId, field]),
  );
  const entities = new Map<string, PackageV6['entities'][number]>(
    v6.entities.map((entity) => [entity.entityId, entity]),
  );
  const activeEntity = (entityId: string) =>
    entities.get(entityId)?.lifecycle === 'active';
  const fieldOf = (entityId: string, fieldId: string) => {
    const field = fields.get(fieldId);
    return field &&
      field.entity.targetId === entityId &&
      field.lifecycle === 'active'
      ? field
      : undefined;
  };
  const numbered = (field: Field) =>
    'numbering' in field && field.numbering !== undefined;
  const derivedTargets = new Set(declarations.derived.map((d) => d.fieldId));
  const rollupFields = new Set(declarations.rollups.map((r) => r.fieldId));

  // Create-only fields.
  const createOnly = new Map<string, string[]>();
  const createOnlyIds = new Set<string>();
  for (const declaration of declarations.createOnly) {
    const path = '$.createOnlyFields';
    if (createOnlyIds.has(declaration.fieldId))
      return refuse(
        path,
        declaration.fieldId,
        'Declare a field create-only once.',
      );
    if (rollupFields.has(declaration.fieldId))
      return refuse(
        path,
        declaration.fieldId,
        'A total is not a create-only field.',
      );
    if (derivedTargets.has(declaration.fieldId))
      return refuse(
        path,
        declaration.fieldId,
        'A derived value is written by the server, so it is not a create-only input.',
      );
    const field = fieldOf(declaration.entityId, declaration.fieldId);
    if (!activeEntity(declaration.entityId) || !field)
      return refuse(
        path,
        declaration.fieldId,
        'A create-only field is an active stored field of its record type.',
      );
    if (numbered(field))
      return refuse(
        path,
        declaration.fieldId,
        'A document number is assigned by the server, so it is not a create-only input.',
      );
    createOnlyIds.add(declaration.fieldId);
    const list = createOnly.get(declaration.entityId) ?? [];
    list.push(declaration.fieldId);
    createOnly.set(declaration.entityId, list);
  }
  // A currency a derived value or a total binds through a relation must be
  // fixed for the life of the record: create-only and required (gap a).
  const requireFrozenCurrency = (
    path: string,
    subjectId: string,
    binding: string | null,
    allowSameRow: boolean,
  ): LineTotalsBinding | null => {
    const stored = storedBindingField(binding);
    if (!stored || (allowSameRow && stored.via.length === 0)) return null;
    const currency = fields.get(stored.fieldId);
    if (
      !currency ||
      !createOnlyIds.has(stored.fieldId) ||
      currency.presence !== 'required'
    )
      return refuse(
        path,
        subjectId,
        'The currency field this value reads must be declared create-only and required.',
      );
    return null;
  };

  // Derived decimals.
  const derived = new Map<string, CompiledDerivedField[]>();
  const derivedTypes = new Map<string, Typed>();
  for (const declaration of declarations.derived) {
    const path = '$.derivedDecimals';
    const id = declaration.fieldId;
    if (derived.get(declaration.entityId)?.some((d) => d.fieldId === id))
      return refuse(path, id, 'Derive a field once.');
    const target = fieldOf(declaration.entityId, id);
    if (!activeEntity(declaration.entityId) || !target)
      return refuse(
        path,
        id,
        'A derived value is an active stored field of its record type.',
      );
    if (numbered(target))
      return refuse(path, id, 'A document number cannot be derived.');
    const targetType = decimalTypeOf(v6, target);
    if (!targetType)
      return refuse(
        path,
        id,
        'A derived value is a stored decimal, money or quantity field with a declared currency.',
      );
    if (target.presence === 'required')
      return refuse(
        path,
        id,
        'A derived value is optional: it is absent while an operand is absent.',
      );
    if (termDepth(declaration.expression) > MAXIMUM_DERIVED_DEPTH)
      return refuse(path, id, 'Nest a derivation at most four levels deep.');
    const operands = termFields(declaration.expression);
    for (const operand of operands) {
      if (derivedTargets.has(operand) || rollupFields.has(operand))
        return refuse(
          path,
          id,
          'A derivation reads stored inputs only: another derived value or a total is not an operand.',
        );
    }
    let refusal: string | null = null;
    const typeOf = (term: DerivedTerm): DisplayDecimalType | null => {
      if (refusal) return null;
      if (term.kind === 'decimalLiteral') return literalType(term.value);
      if (term.kind === 'field') {
        const field = fieldOf(declaration.entityId, term.fieldId);
        const type = field && decimalTypeOf(v6, field);
        if (!type)
          refusal =
            'An operand is a decimal, money or quantity field of the same record with a declared currency.';
        return type ?? null;
      }
      const left = typeOf(term.left);
      const right = typeOf(term.right);
      if (!left || !right) return null;
      const result = displayArithmeticType(term.operator, left, right);
      if (!result)
        refusal =
          term.operator === 'multiply'
            ? left.currency && right.currency
              ? 'Money cannot be multiplied by money.'
              : left.unit && right.unit
                ? 'A quantity cannot be multiplied by a quantity.'
                : 'The exact intermediate result is larger than 76 digits or scale 36.'
            : left.currency !== right.currency
              ? 'Add or subtract amounts of the same currency, read through the same field.'
              : left.unit !== right.unit
                ? 'Add or subtract quantities of the same unit.'
                : 'The exact intermediate result is larger than 76 digits or scale 36.';
      return result;
    };
    const resultType = typeOf(declaration.expression);
    if (refusal || !resultType)
      return refuse(path, id, refusal ?? 'Invalid derivation.');
    if (resultType.currency !== targetType.currency)
      return refuse(
        path,
        id,
        'The derivation and its target read their currency through the same field.',
      );
    if (resultType.unit !== targetType.unit)
      return refuse(
        path,
        id,
        'The derivation and its target have the same unit.',
      );
    const frozen = requireFrozenCurrency(path, id, targetType.binding, true);
    if (frozen) return frozen;
    let absentAs: Record<string, string> | undefined;
    for (const entry of declaration.absentAs ?? []) {
      if (
        !operands.has(entry.fieldId) ||
        absentAs?.[entry.fieldId] !== undefined
      )
        return refuse(
          path,
          id,
          'An absence default names one operand of this derivation once.',
        );
      (absentAs ??= {})[entry.fieldId] = entry.value;
    }
    const list = derived.get(declaration.entityId) ?? [];
    list.push(
      Object.freeze({
        classification:
          target.classification === 'public' ? 'PUBLIC' : 'INTERNAL',
        fieldId: id,
        precision: targetType.precision,
        scale: targetType.scale,
        rounding: 'halfAwayFromZero',
        expression: declaration.expression,
        ...(absentAs ? { absentAs: Object.freeze(absentAs) } : {}),
      }),
    );
    derived.set(declaration.entityId, list);
    derivedTypes.set(id, targetType);
  }

  // No validation watches a derived target: its witnesses would have to be
  // sent as input, and a derived value is nobody's input.
  for (const rule of v6.formulaRules ?? [])
    for (const fieldId of predicateFieldIds(rule.predicate))
      if (derivedTargets.has(fieldId))
        return refuse(
          '$.formulaRules',
          rule.ruleId,
          'Validate the operands of a derived value, not the derived value.',
        );
  // Nothing offers a derived value for entry.
  for (const surface of v6.surfaces) {
    const editor =
      'documentEditor' in surface ? surface.documentEditor : undefined;
    for (const value of editor?.createValues ?? [])
      if (derivedTargets.has(String(value.fieldId)))
        return refuse(
          '$.surfaces',
          String(value.fieldId),
          'A derived value is not a create value.',
        );
    const composition =
      'composition' in surface ? surface.composition : undefined;
    for (const action of composition?.actions ?? [])
      for (const step of action.steps)
        for (const binding of step.bindings)
          if (binding.path.some((segment) => derivedTargets.has(segment)))
            return refuse(
              '$.surfaces',
              String(action.actionId),
              'A derived value is not a composition input.',
            );
  }

  // Rollups.
  const rollups = new Map<string, CompiledRollup[]>();
  const totalled = new Map<string, CompiledTotalledRelation[]>();
  const declaredIds = new Set<string>([
    ...v6.fields.map((field) => field.fieldId),
    ...(v6.calculatedDisplayFields ?? []).map((field) => field.fieldId),
  ]);
  for (const declaration of declarations.rollups) {
    const path = '$.rollups';
    const id = declaration.fieldId;
    if (declaredIds.has(id))
      return refuse(
        path,
        id,
        'A total has its own field ID, used by nothing else.',
      );
    declaredIds.add(id);
    if (declaration.materialize === 'stored')
      return refuse(
        path,
        id,
        'A stored total is not available yet: slice 1 computes a total on read (ADR-0094, plan §5.11 step 4).',
      );
    if (!activeEntity(declaration.entityId))
      return refuse(path, id, 'A total belongs to an active record type.');
    const relation = v6.relations.find(
      (candidate) =>
        candidate.relationId === declaration.relationId &&
        candidate.lifecycle === 'active',
    );
    if (
      !relation ||
      relation.ownership !== 'parentScopedChild' ||
      relation.targetEntity.targetId !== declaration.entityId
    )
      return refuse(
        path,
        id,
        'A total sums the lines of one declared parent-scoped relation of its record type.',
      );
    const lineEntityId = relation.sourceEntity.targetId;
    const lineEntity = entities.get(lineEntityId);
    if (!lineEntity || lineEntity.lifecycle !== 'active')
      return refuse(
        path,
        id,
        'The lines of a total are an active record type.',
      );
    const ownership = (entity: unknown) =>
      (entity as { companyOwnership?: string }).companyOwnership ?? null;
    if (ownership(entities.get(declaration.entityId)) !== ownership(lineEntity))
      return refuse(
        path,
        id,
        'A record and the lines it totals have the same company ownership.',
      );
    const aggregand = fieldOf(lineEntityId, declaration.aggregandFieldId);
    const aggregandType = aggregand && decimalTypeOf(v6, aggregand);
    if (
      !aggregand ||
      !aggregandType ||
      (!derivedTargets.has(aggregand.fieldId) &&
        aggregand.presence !== 'required')
    )
      return refuse(
        path,
        id,
        'A total sums a derived value or a required stored decimal of its lines.',
      );
    const stored = storedBindingField(aggregandType.binding);
    if (
      stored &&
      (stored.via.length !== 1 ||
        stored.via[0] !== declaration.relationId ||
        fields.get(stored.fieldId)?.entity.targetId !== declaration.entityId)
    )
      return refuse(
        path,
        id,
        "A total's amounts read their currency from a field of the totalled record, through the totalled relation.",
      );
    const frozen = requireFrozenCurrency(
      path,
      id,
      aggregandType.binding,
      false,
    );
    if (frozen) return frozen;
    const precision =
      aggregandType.precision + String(declaration.maximumLines).length;
    if (precision > MAXIMUM_ROLLUP_PRECISION)
      return refuse(
        path,
        id,
        'A total holds at most 38 digits: lower the line maximum or the amount precision.',
      );
    if (
      !v6.queries.some(
        (query) =>
          query.sourceEntity.targetId === declaration.entityId &&
          readsRollups(query),
      )
    )
      return refuse(
        path,
        id,
        'A total is read by an active direct get of its record type.',
      );
    const lineLists = v6.queries.filter(
      (query) =>
        query.lifecycle === 'active' &&
        query.queryType === 'list' &&
        query.tier === 'q0' &&
        !('readModel' in query && query.readModel) &&
        query.sourceEntity.targetId === lineEntityId &&
        query.selections.some(
          (selection) => selection.field.targetId === aggregand.fieldId,
        ),
    );
    // The total sums every live line, so the query that authorizes it must
    // show every live line: a filtered one would let a reader see a sum over
    // lines no query they hold can show (owner Q4).
    const lineQuery = lineLists.find(
      (query) =>
        inspectPredicateForExecution(query.filter).outcome === 'accepted',
    );
    const lineQueryId = lineQuery?.queryId;
    if (!lineQueryId)
      return refuse(
        path,
        id,
        lineLists.length > 0
          ? 'A total is read under an unfiltered list query of its lines, so it never sums a line that query hides.'
          : "A total is read under its lines' list query, which selects the summed field.",
      );
    const relations = totalled.get(lineEntityId) ?? [];
    const prior = relations.find(
      (entry) => entry.relationId === declaration.relationId,
    );
    if (prior && prior.maximumLines !== declaration.maximumLines)
      return refuse(
        path,
        id,
        'Every total over one relation declares the same line maximum.',
      );
    if (!prior) {
      relations.push(
        Object.freeze({
          relationId: declaration.relationId,
          maximumLines: declaration.maximumLines,
        }),
      );
      totalled.set(lineEntityId, relations);
    }
    // A record template creates at most 100 members plus 100 entered lines
    // (record-template-content.ts; the create's templateLines). Template
    // content is tenant data, so the compiler refuses on that bound.
    const templated = v6.surfaces.some(
      (surface) =>
        'recordTemplateBinding' in surface &&
        surface.recordTemplateBinding !== undefined &&
        (
          surface.recordTemplateBinding as {
            body?: { parentRelationId?: string };
          }
        ).body?.parentRelationId === declaration.relationId,
    );
    if (templated && declaration.maximumLines < 200)
      return refuse(
        path,
        id,
        'A record template can create up to 200 lines, more than this line maximum.',
      );
    const list = rollups.get(declaration.entityId) ?? [];
    list.push(
      Object.freeze({
        fieldId: id,
        lineEntityId,
        relationId: declaration.relationId,
        aggregandFieldId: aggregand.fieldId,
        precision,
        scale: aggregandType.scale,
        lineQueryId,
      }),
    );
    rollups.set(declaration.entityId, list);
  }
  const sortById = <T extends { fieldId: string }>(map: Map<string, T[]>) =>
    new Map(
      [...map].map(([key, list]) => [
        key,
        Object.freeze(
          [...list].sort((a, b) =>
            a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
          ),
        ),
      ]),
    );
  return {
    status: 'bound',
    binding: {
      derived: sortById(derived),
      totalled: new Map(
        [...totalled].map(([key, list]) => [
          key,
          Object.freeze(
            [...list].sort((a, b) =>
              a.relationId < b.relationId
                ? -1
                : a.relationId > b.relationId
                  ? 1
                  : 0,
            ),
          ),
        ]),
      ),
      rollups: sortById(rollups),
      createOnly: new Map(
        [...createOnly].map(([key, list]) => [
          key,
          Object.freeze([...list].sort()),
        ]),
      ),
      declared: true,
    },
  };
}

/**
 * Which reader floors a definition's ADR-0094 declarations raise: the
 * operation catalog's (a derived decimal, a create-only field, a totalled
 * relation's maximum and header lock, or the money-against-zero comparison)
 * and the query catalog's (a get's on-read rollup). One function, read by the
 * compiler's invariant, release registration and the runtime view load.
 * `null` when the declarations do not bind.
 */
export function lineTotalsReaderFloors(
  definition: VersionedNormalizedApplicationPackage,
): { readonly operation: boolean; readonly query: boolean } | null {
  const bound = bindLineTotals(definition);
  if (bound.status !== 'bound') return null;
  const { binding } = bound;
  return {
    operation:
      binding.derived.size > 0 ||
      binding.createOnly.size > 0 ||
      binding.totalled.size > 0 ||
      zeroComparesStoredMoney(definition),
    query: binding.rollups.size > 0,
  };
}
