import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkModulePressLaw,
  formatModulePressLaw,
  type ModulePressLawViolation,
} from '../../packages/dev-tooling/src/module-press-law.js';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

// Row 1c owns this exact pre-existing contradiction. Keeping the observations
// exact is a two-way ratchet: another branch fails, and resolving either one
// also fails until the routed debt is deliberately removed from this record.
const routedPlatformDebt: readonly ModulePressLawViolation[] = [
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    line: 101,
    message:
      'generic press contains platform-specific PostgresSavedFilterExecutor',
    moduleDirectory: 'platform',
    ruleId: 'PRESS007_MODULE_GLUE_IN_PRESS',
  },
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    line: 994,
    message: 'generic press references platform identity northstar.platform',
    moduleDirectory: 'platform',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
] as const;

test('one auto-discovered guard covers every definition-backed product module', () => {
  const result = checkModulePressLaw(process.cwd());
  console.log(formatModulePressLaw(result));
  assert.deepEqual(result.moduleDirectories, [
    'catalog',
    'location',
    'party',
    'platform',
  ]);
  assert.equal(result.modulesRead, 4);
  assert.ok(result.scannedFiles > 0, 'press-law guard read zero files');
  assert.deepEqual(result.violations, routedPlatformDebt);
});

test('consolidated guard red: the previously omitted Platform module is observed', () => {
  const result = checkModulePressLaw(process.cwd());
  const platformViolations = result.violations.filter(
    (violation) => violation.moduleDirectory === 'platform',
  );
  assert.deepEqual(platformViolations, routedPlatformDebt);
  assert.ok(
    platformViolations.some(
      (violation) => violation.ruleId === 'PRESS006_MODULE_ID_IN_PRESS',
    ),
  );
  assert.ok(
    platformViolations.some(
      (violation) => violation.ruleId === 'PRESS007_MODULE_GLUE_IN_PRESS',
    ),
  );
});

test('consolidated guard red: an absent module corpus cannot pass vacuously', () => {
  const root = createArchitectureFixture({
    'apps/web/src/app.ts': 'export const app = true;\n',
  });
  try {
    assert.deepEqual(
      checkModulePressLaw(root).violations.map((violation) => violation.ruleId),
      ['PRESS001_NO_MODULES'],
    );
  } finally {
    removeArchitectureFixture(root);
  }
});
