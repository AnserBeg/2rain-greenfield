import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PredicateExpressionSchema,
  inspectPredicateForExecution,
  unicodeCaseFold,
  type CanonicalScalar,
  type PredicateExpression,
} from '../../packages/canonical-model/src/index.js';

export const Q1_CORPUS_FIELD_IDS = Object.freeze({
  binaryText: 'northstar.party:field.party_contact_summary',
  exactDecimal: 'northstar.party:field.party_q1_decimal',
  foldedText: 'northstar.party:field.party_q1_folded',
});

export type PredicateParityAxis =
  'absentValues' | 'exactDecimalOrdering' | 'unicodeCaseFold';

export interface PredicateParityCase {
  readonly axis: PredicateParityAxis;
  readonly caseId: string;
  readonly predicate: PredicateExpression;
}

export interface PredicateParityRow {
  readonly label: string;
  readonly recordId: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface PredicateParityCorpus {
  readonly cases: readonly PredicateParityCase[];
  readonly rows: readonly PredicateParityRow[];
  readonly schemaVersion: 'northstar.q1-predicate-parity-corpus/v1';
}

export interface PredicateScenario {
  readonly caseId: string;
  readonly expected: boolean;
  readonly given: string;
  readonly rowId: string;
  readonly scenarioId: string;
  readonly then: string;
  readonly when: string;
}

export interface PredicateScenarioArtifact {
  readonly scenarios: readonly PredicateScenario[];
  readonly schemaVersion: 'northstar.q1-predicate-scenarios/v1';
}

export interface QueryAggregateParityCase {
  readonly caseId: string;
  readonly elements: readonly string[];
  readonly expected: string;
  readonly field: Readonly<{
    fieldId: string;
    kind: 'exactDecimalFieldType' | 'quantityFieldType';
    precision: number;
    scale: number;
  }>;
}

export const Q1_AGGREGATE_PARITY_CASES: readonly QueryAggregateParityCase[] =
  Object.freeze([
    Object.freeze({
      caseId: 'required-exact-decimal-non-empty',
      elements: Object.freeze(['1.25', '-0.25', '999999999999999999.000001']),
      expected: '1000000000000000000.000001',
      field: Object.freeze({
        fieldId: 'northstar.q1:field.aggregate_exact_decimal',
        kind: 'exactDecimalFieldType' as const,
        precision: 24,
        scale: 6,
      }),
    }),
    Object.freeze({
      caseId: 'required-quantity-empty',
      elements: Object.freeze([]),
      expected: '0',
      field: Object.freeze({
        fieldId: 'northstar.q1:field.aggregate_quantity',
        kind: 'quantityFieldType' as const,
        precision: 20,
        scale: 6,
      }),
    }),
  ]);

const corpusPath = resolve('test/fixtures/q1/predicate-parity-corpus.v1.json');
const scenariosPath = resolve('test/fixtures/q1/predicate-scenarios.v1.json');

export function loadPredicateParityCorpus(): PredicateParityCorpus {
  const input = parseJson(corpusPath);
  assertRecord(input, 'corpus');
  assert.equal(input.schemaVersion, 'northstar.q1-predicate-parity-corpus/v1');
  assertRecord(input.authoring, 'authoring');
  assert.deepEqual(input.authoring, {
    generator: 'model-assisted',
    judgement: 'deterministic-ir-versus-postgresql',
    runtimeUse: 'forbidden',
  });
  assert.ok(Array.isArray(input.cases));
  assert.ok(Array.isArray(input.rows));
  const caseIds = new Set<string>();
  const cases = input.cases.map((candidate, index) => {
    assertRecord(candidate, `cases[${String(index)}]`);
    assert.ok(
      candidate.axis === 'absentValues' ||
        candidate.axis === 'exactDecimalOrdering' ||
        candidate.axis === 'unicodeCaseFold',
    );
    const axis = candidate.axis as PredicateParityAxis;
    const caseId = requiredString(candidate.caseId, 'caseId');
    assert.equal(caseIds.has(caseId), false);
    caseIds.add(caseId);
    const predicate = PredicateExpressionSchema.parse(candidate.predicate);
    return Object.freeze({
      axis,
      caseId,
      predicate: Object.freeze(predicate),
    });
  });
  const recordIds = new Set<string>();
  const rows = input.rows.map((candidate, index) => {
    assertRecord(candidate, `rows[${String(index)}]`);
    const label = requiredString(candidate.label, 'label');
    const recordId = requiredString(candidate.recordId, 'recordId');
    assert.equal(recordIds.has(recordId), false);
    recordIds.add(recordId);
    assertRecord(candidate.values, `rows[${String(index)}].values`);
    for (const value of Object.values(candidate.values)) {
      assert.equal(typeof value, 'string');
    }
    return Object.freeze({
      label,
      recordId,
      values: Object.freeze({ ...candidate.values } as Record<string, string>),
    });
  });
  assert.ok(cases.length > 0, 'the committed parity corpus reads zero cases');
  assert.ok(rows.length > 0, 'the committed parity corpus reads zero rows');
  assert.deepEqual(
    [...new Set(cases.map((candidate) => candidate.axis))].sort(),
    ['absentValues', 'exactDecimalOrdering', 'unicodeCaseFold'],
  );
  return Object.freeze({
    cases: Object.freeze(cases),
    rows: Object.freeze(rows),
    schemaVersion: 'northstar.q1-predicate-parity-corpus/v1' as const,
  });
}

export function loadPredicateScenarios(): PredicateScenarioArtifact {
  const input = parseJson(scenariosPath);
  assertRecord(input, 'scenarios');
  assert.equal(input.schemaVersion, 'northstar.q1-predicate-scenarios/v1');
  assertRecord(input.authoring, 'authoring');
  assert.deepEqual(input.authoring, {
    approvalSubject: 'behavior-not-implementation',
    generator: 'model-assisted',
    judgement: 'deterministic-kernel-evaluation',
    runtimeUse: 'forbidden',
  });
  assert.ok(Array.isArray(input.scenarios));
  const scenarioIds = new Set<string>();
  const scenarios = input.scenarios.map((candidate, index) => {
    assertRecord(candidate, `scenarios[${String(index)}]`);
    for (const key of [
      'caseId',
      'given',
      'rowId',
      'scenarioId',
      'then',
      'when',
    ]) {
      assert.equal(typeof candidate[key], 'string', `${key} must be a string`);
    }
    assert.equal(typeof candidate.expected, 'boolean');
    assert.equal(scenarioIds.has(String(candidate.scenarioId)), false);
    scenarioIds.add(String(candidate.scenarioId));
    return Object.freeze(candidate as unknown as PredicateScenario);
  });
  assert.ok(
    scenarios.length > 0,
    'the committed scenario artifact reads zero scenarios',
  );
  return Object.freeze({
    scenarios: Object.freeze(scenarios),
    schemaVersion: 'northstar.q1-predicate-scenarios/v1' as const,
  });
}

export function evaluatePredicateCase(
  candidate: PredicateParityCase,
  row: PredicateParityRow,
): boolean {
  const receipt = inspectPredicateForExecution(candidate.predicate, {
    bindingPosition: 'queryFilter',
    resolveComparison(comparison) {
      const fieldId = comparison.field.targetId;
      if (!Object.hasOwn(row.values, fieldId)) {
        return { presence: 'absent' };
      }
      const left = row.values[fieldId]!;
      const order = comparePresentValue(fieldId, left, comparison.value);
      return {
        presence: 'present',
        result: {
          equals: order === 0,
          greaterThan: order > 0,
          lessThan: order < 0,
          notEquals: order !== 0,
        }[comparison.operator],
      };
    },
  });
  assert.equal(receipt.outcome, 'evaluated');
  assert.equal(receipt.position, 'queryFilter');
  return receipt.result;
}

function comparePresentValue(
  fieldId: string,
  left: string,
  right: Readonly<CanonicalScalar>,
): number {
  if (fieldId === Q1_CORPUS_FIELD_IDS.exactDecimal) {
    assert.equal(right.kind, 'exactDecimalValue');
    return compareCanonicalDecimals(left, right.value);
  }
  assert.equal(right.kind, 'textValue');
  if (fieldId === Q1_CORPUS_FIELD_IDS.foldedText) {
    return compareUtf8(unicodeCaseFold(left), unicodeCaseFold(right.value));
  }
  assert.equal(fieldId, Q1_CORPUS_FIELD_IDS.binaryText);
  return compareUtf8(left, right.value);
}

function compareCanonicalDecimals(left: string, right: string): number {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftMagnitude = BigInt(
    `${leftParts.integer}${leftParts.fraction.padEnd(scale, '0')}`,
  );
  const rightMagnitude = BigInt(
    `${rightParts.integer}${rightParts.fraction.padEnd(scale, '0')}`,
  );
  const leftValue = leftParts.negative ? -leftMagnitude : leftMagnitude;
  const rightValue = rightParts.negative ? -rightMagnitude : rightMagnitude;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function decimalParts(value: string): {
  fraction: string;
  integer: string;
  negative: boolean;
} {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  assert.ok(integer !== undefined && /^\d+$/u.test(integer));
  assert.ok(/^\d*$/u.test(fraction));
  return { fraction, integer, negative };
}

function compareUtf8(left: string, right: string): number {
  return Math.sign(
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
}
