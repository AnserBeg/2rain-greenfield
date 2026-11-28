/**
 * LINE-TOTALS slice 1 (ADR-0094): a tenant-built "Rental contract" with a line
 * table, declared through Customize patches, plus the three ADR-0094 keys the
 * slice-1 language admits. No Customize member declares them before slice 2,
 * so the test injects them into the authored package the patches produced.
 * The fixture has no dateTime field (ADR-0094 obligation 9's known exception).
 *
 * Rental is a test case only: every block here is general (rule 17).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  DEFAULT_COMPILER_LIMITS,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
  type CompileResult,
} from '../../packages/compiler/src/index.js';
import * as customization from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { withoutDocumentPosting } from './without-document-posting.js';

export const NS = 'northstar.app';
export const CONTRACT = `${NS}:entity.custom_rental_contract`;
export const LINES = `${NS}:entity.custom_rental_contract_lines`;
export const PARENT = `${NS}:relation.custom_rental_contract_lines_parent`;
export const h = (local: string) =>
  `${NS}:field.custom_rental_contract_${local}`;
export const l = (local: string) =>
  `${NS}:field.custom_rental_contract_lines_${local}`;
export const op = (local: string) =>
  `${NS}:operation.custom_rental_contract_${local}`;
export const query = (local: string) =>
  `${NS}:query.custom_rental_contract_${local}`;
export const TOTAL = h('total');
export const AMOUNT = l('amount');

export const contractType = {
  kind: 'addRecordType',
  label: 'Rental contract',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Currency', type: 'currency', required: true },
  ],
};
export const lineTable = {
  kind: 'addLineTable',
  entity: CONTRACT,
  label: 'Lines',
  fields: [
    { label: 'Item', type: 'text' },
    { label: 'Days', type: 'decimal', scale: 2 },
    {
      label: 'Daily rate',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
    { label: 'Discount', type: 'decimal', scale: 2 },
    {
      label: 'Amount',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
  ],
};

const field = (fieldId: string) => ({
  kind: 'field',
  schemaVersion: 'v6',
  fieldId,
  select: 'value',
});
const decimal = (value: string, precision = 18, scale = 2) => ({
  kind: 'literal',
  schemaVersion: 'v6',
  scalar: {
    kind: 'decimal',
    value,
    precision,
    scale,
    currency: null,
    unit: null,
  },
});
const rule = (
  local: string,
  anchor: string,
  message: string,
  predicate: unknown,
) => ({
  kind: 'validationRule',
  schemaVersion: 'v6',
  ruleId: `${NS}:validation.custom_rental_contract_lines_${local}`,
  targetId: LINES,
  boundOperationIds: [op('lines_create'), op('lines_update')],
  trigger: { kind: 'afterDefaultsOrChangedFields', schemaVersion: 'v6' },
  absence: { kind: 'validationThreeValued', schemaVersion: 'v6' },
  effect: 'refuse',
  existingRecords: 'grandfather',
  message,
  fieldAnchors: [anchor],
  predicate,
});
const comparison = (left: unknown, operator: string, right: unknown) => ({
  kind: 'comparison',
  schemaVersion: 'v6',
  operator,
  left,
  right,
});

/** Q2: a discount is a percent from 0 to 100; days and the rate are not negative. */
export const discountRange = rule(
  'discount_range',
  l('discount'),
  'Use a discount from 0 to 100.',
  {
    kind: 'all',
    schemaVersion: 'v6',
    terms: [
      comparison(field(l('discount')), 'greaterThanOrEqual', decimal('0')),
      comparison(field(l('discount')), 'lessThanOrEqual', decimal('100')),
    ],
  },
);
export const daysNonNegative = rule(
  'days_nonnegative',
  l('days'),
  'Days cannot be negative.',
  comparison(field(l('days')), 'greaterThanOrEqual', decimal('0')),
);
/** ADR-0094 amendment 10: stored-currency money against ZERO. */
export const rateNonNegative = rule(
  'rate_nonnegative',
  l('daily_rate'),
  'The daily rate cannot be negative.',
  comparison(field(l('daily_rate')), 'greaterThanOrEqual', decimal('0')),
);
// prettier-ignore
export const operandValidations = [discountRange, daysNonNegative, rateNonNegative];

/** amount = days x rate x (1 - discount x 0.01), a blank discount priced as 0. */
export const amountDerivation = {
  schemaVersion: 'v6',
  fieldId: AMOUNT,
  entityId: LINES,
  expression: {
    kind: 'arithmetic',
    operator: 'multiply',
    left: {
      kind: 'arithmetic',
      operator: 'multiply',
      left: { kind: 'field', fieldId: l('days') },
      right: { kind: 'field', fieldId: l('daily_rate') },
    },
    right: {
      kind: 'arithmetic',
      operator: 'subtract',
      left: { kind: 'decimalLiteral', value: '1' },
      right: {
        kind: 'arithmetic',
        operator: 'multiply',
        left: { kind: 'field', fieldId: l('discount') },
        right: { kind: 'decimalLiteral', value: '0.01' },
      },
    },
  },
  rounding: 'halfAwayFromZero',
  absentAs: [{ fieldId: l('discount'), value: '0' }],
};

export const totalRollup = (maximumLines: number) => ({
  schemaVersion: 'v6',
  fieldId: TOTAL,
  entityId: CONTRACT,
  label: 'Total',
  relationId: PARENT,
  operator: 'sum',
  aggregandFieldId: AMOUNT,
  maximumLines,
  materialize: 'onRead',
});

export const currencyCreateOnly = {
  schemaVersion: 'v6',
  fieldId: h('currency'),
  entityId: CONTRACT,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Authored = Record<string, any>;

const applied = new Map<string, Authored>();
let bindings: readonly unknown[] = [];
/**
 * The first-party base with the two patches applied, as a tenant builds it.
 * `shared`: the contract and its lines are shared by every company.
 */
export function patchedAuthored(shared = false): Authored {
  const key = shared ? 'shared' : 'owned';
  if (!applied.has(key)) {
    const base = withoutDocumentPosting(
      JSON.parse(
        readFileSync(resolve('apps/web/release/app.authored.json'), 'utf8'),
      ) as Record<string, unknown>,
    );
    const result = customization.applyCustomizationPatches(
      base,
      [
        shared
          ? { ...contractType, companyOwnership: 'tenantShared' }
          : contractType,
        lineTable,
      ].map((patch) => customization.CustomizationPatchSchema.parse(patch)),
    );
    assert.ok(result.status === 'applied', JSON.stringify(result));
    applied.set(key, result.authored as Authored);
    bindings = result.permissionBindings;
  }
  return structuredClone(applied.get(key)!);
}

/**
 * The same two patches with more line fields (a quantity with a unit, a
 * price in a fixed currency), for typing cases the base fixture lacks.
 * Uncached; the permission bindings are the base fixture's.
 */
export function variantAuthored(extraLineFields: readonly unknown[]): Authored {
  patchedAuthored();
  const base = withoutDocumentPosting(
    JSON.parse(
      readFileSync(resolve('apps/web/release/app.authored.json'), 'utf8'),
    ) as Record<string, unknown>,
  );
  const result = customization.applyCustomizationPatches(
    base,
    [
      contractType,
      { ...lineTable, fields: [...lineTable.fields, ...extraLineFields] },
    ].map((patch) => customization.CustomizationPatchSchema.parse(patch)),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  return result.authored as Authored;
}

export interface RentalOptions {
  readonly maximumLines?: number;
  /** Leave the operands unconstrained (release verification's own values). */
  readonly validations?: boolean;
  readonly rollup?: boolean;
  readonly derive?: boolean;
  readonly createOnly?: boolean;
  /** Contract and lines shared by every company. */
  readonly shared?: boolean;
  /** A line validation that reads the contract through its parent link. */
  readonly pathValidation?: boolean;
  /**
   * For a record-template test: template columns carry no decimal, so the
   * amount's operands default when blank (one day at 40.00) and a member line
   * still derives an amount. The binding itself is activated through the
   * Customize service, whose admission has the verifier connection that
   * template verification needs (boot-time admission has none).
   */
  readonly template?: boolean;
}

export const TEMPLATE_FORM = `${NS}:surface.custom_rental_contract_form`;

/** A line's item may not repeat its contract's name (read through the parent). */
export const itemNotContractName = rule(
  'item_not_contract_name',
  l('item'),
  'An item cannot repeat the contract name.',
  comparison(field(l('item')), 'notEqual', {
    kind: 'path',
    schemaVersion: 'v6',
    fieldId: h('name'),
    relationIds: [PARENT],
  }),
);

/** The patched package with the ADR-0094 declarations injected. */
export function rentalContractAuthored(options: RentalOptions = {}): Authored {
  const authored = patchedAuthored(options.shared === true);
  if (options.createOnly !== false)
    authored.createOnlyFields = [currencyCreateOnly];
  if (options.derive !== false)
    authored.derivedDecimals = [
      options.template
        ? {
            ...amountDerivation,
            absentAs: [
              ...amountDerivation.absentAs,
              { fieldId: l('days'), value: '1' },
              { fieldId: l('daily_rate'), value: '40' },
            ],
          }
        : amountDerivation,
    ];
  if (options.rollup !== false)
    authored.rollups = [totalRollup(options.maximumLines ?? 1_000)];
  if (options.validations !== false)
    authored.formulaRules = [
      ...((authored.formulaRules as unknown[] | undefined) ?? []),
      ...operandValidations,
    ];
  if (options.pathValidation)
    authored.formulaRules = [
      ...((authored.formulaRules as unknown[] | undefined) ?? []),
      itemNotContractName,
    ];
  return authored;
}

/**
 * Compile a fixture package directly after the retained bootstrap, with the
 * patches' own permission bindings. The package is the tenant's patch output
 * with first-party provenance: slice 1 has no Customize member, so no tenant
 * path can declare these keys (ADR-0094 gaps b and c), and the sandbox gate
 * is not what this fixture tests.
 */
export function compileRental(authored: Authored): CompileResult {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const normalized = normalizeApplicationPackage({
    ...authored,
    package: { ...authored.package, provenance: 'firstParty' },
  });
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const acknowledgement = readUnboundPermissionAcknowledgementFor(
    authoredPath,
    normalized.package.packageId,
  );
  return compileApplicationRelease(
    {
      kind: 'compilerInput',
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(bootstrap.compiled),
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    {
      ...acknowledgement,
      evaluatorBindings: [
        ...(acknowledgement.evaluatorBindings ?? []),
        ...(bindings as NonNullable<typeof acknowledgement.evaluatorBindings>),
      ],
    },
  );
}

/** The installable compiled application for one fixture package. */
export function rentalApplication(authored: Authored) {
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const compiled = compileRental(authored);
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.status === 'compiled' ? [] : compiled.diagnostics),
  );
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(
      normalizeApplicationPackage({
        ...authored,
        package: { ...authored.package, provenance: 'firstParty' },
      }),
    ),
  );
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v1',
    application: customization.serializeRelease({
      compiled,
      normalizedDefinitionBytes,
    }),
    bootstrap: customization.serializeRelease(bootstrap),
  };
}
