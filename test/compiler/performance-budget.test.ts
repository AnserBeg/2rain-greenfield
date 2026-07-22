import assert from 'node:assert/strict';
import test from 'node:test';

import { STRUCTURAL_LIMITS_V0 } from '../../packages/canonical-model/src/index.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { authoredFixture, compilerInput, normalizedBytes } from './helpers.js';

const FULL_COMPILE_BUDGET_MILLISECONDS = 5_000;

test('cold full compile stays within the numeric v0 maximum-field budget', () => {
  const authored = authoredFixture('vertical-v1');
  authored.surfaces = [];
  authored.queries = [];
  authored.operations = [];
  authored.permissions = [];
  authored.capabilityRequirements = [];
  const template = structuredClone(authored.fields[0]!);
  authored.fields = Array.from(
    { length: STRUCTURAL_LIMITS_V0.families.fields },
    (_, index) => ({
      ...structuredClone(template),
      fieldId:
        `northstar.bootstrap:field.maximum_${String(index).padStart(4, '0')}` as typeof template.fieldId,
      label: `Field ${index}`,
      orderKey: index + 1,
    }),
  );

  const bytes = normalizedBytes(authored);
  assert.equal(authored.fields.length, STRUCTURAL_LIMITS_V0.families.fields);
  assert.ok(bytes.byteLength <= STRUCTURAL_LIMITS_V0.maximumNormalizedBytes);

  const started = process.hrtime.bigint();
  const result = compileApplication(compilerInput(bytes));
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.status, 'compiled');
  assert.ok(
    elapsedMilliseconds <= FULL_COMPILE_BUDGET_MILLISECONDS,
    `cold full compile took ${elapsedMilliseconds.toFixed(1)}ms; budget is ${FULL_COMPILE_BUDGET_MILLISECONDS}ms`,
  );
});
