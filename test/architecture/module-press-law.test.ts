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
  // Row 1e-2 owns this accepted G3-P1a module identity, newly visible when
  // Inventory became definition-backed; keep it exact until that row lands.
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 1317,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
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
    'inventory',
    'location',
    'party',
    'platform',
  ]);
  assert.equal(result.modulesRead, 5);
  assert.ok(
    result.productionFilesRead > 0,
    'press-law guard read zero production files',
  );
  assert.ok(result.scannedFiles > 0, 'press-law guard read zero files');
  assert.deepEqual(result.violations, routedPlatformDebt);
});

test('consolidated guard red: the previously omitted Platform module is observed', () => {
  const result = checkModulePressLaw(process.cwd());
  const platformViolations = result.violations.filter(
    (violation) => violation.moduleDirectory === 'platform',
  );
  assert.deepEqual(
    platformViolations,
    routedPlatformDebt.filter(
      (violation) => violation.moduleDirectory === 'platform',
    ),
  );
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

test('consolidated guard red: an absent production press cannot pass vacuously', () => {
  const root = createArchitectureFixture({
    'packages/domain/src/widget/definition.ts':
      "export const WIDGET_NAMESPACE = 'northstar.widget';\n",
  });
  try {
    const result = checkModulePressLaw(root);
    assert.equal(result.modulesRead, 1);
    assert.equal(result.productionFilesRead, 0);
    assert.deepEqual(
      result.violations.map((violation) => violation.ruleId),
      ['PRESS009_NO_PRODUCTION_PRESS'],
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard derives generated query and operation local IDs', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': "export const queryId = 'widget_list';\n",
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 1,
        message: 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard distinguishes a module namespace from a longer contract namespace', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export const schema = 'northstar.widget-contract/v1';\n",
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, []);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard rejects a structurally copied module assertion', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': 'export const generic = true;\n',
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
    'test/unit/widget.test.ts': [
      "import assert from 'node:assert/strict';",
      'assert.doesNotMatch(source, /northstar\\.widget|widget_(?:get|list|create)/);',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'test/unit/widget.test.ts',
        line: 2,
        message:
          'module press law is reimplemented outside the consolidated guard',
        moduleDirectory: null,
        ruleId: 'PRESS008_COPIED_MODULE_GUARD',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard detects every module-specific glue role in identifiers and filenames', () => {
  const files: Record<string, string> = {
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  };
  for (const role of [
    'Handler',
    'Executor',
    'Gateway',
    'Repository',
    'Service',
  ]) {
    files[`apps/api/src/identifier-${role.toLowerCase()}.ts`] =
      `export const widget${role} = true;\n`;
    files[`scripts/widget-${role.toLowerCase()}.ts`] =
      'export const generic = true;\n';
  }
  const root = createArchitectureFixture(files);
  try {
    const result = checkModulePressLaw(root);
    assert.equal(result.violations.length, 10);
    assert.deepEqual(
      result.violations.map((violation) => violation.ruleId),
      Array.from({ length: 10 }, () => 'PRESS007_MODULE_GLUE_IN_PRESS'),
    );
    for (const role of [
      'handler',
      'executor',
      'gateway',
      'repository',
      'service',
    ]) {
      assert.ok(
        result.violations.some(
          (violation) =>
            violation.file === `apps/api/src/identifier-${role}.ts`,
        ),
      );
      assert.ok(
        result.violations.some(
          (violation) => violation.file === `scripts/widget-${role}.ts`,
        ),
      );
    }
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard detects underscore-separated source glue', () => {
  const root = createArchitectureFixture({
    'apps/api/src/glue.ts': 'export const widget_handler = true;\n',
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/glue.ts',
        line: 1,
        message: 'generic press contains widget-specific widget_handler',
        moduleDirectory: 'widget',
        ruleId: 'PRESS007_MODULE_GLUE_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard detects role-first module glue filenames', () => {
  const root = createArchitectureFixture({
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
    'scripts/handler-widget.ts': 'export const generic = true;\n',
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'scripts/handler-widget.ts',
        line: 1,
        message:
          'generic press contains widget-specific scripts/handler-widget.ts',
        moduleDirectory: 'widget',
        ruleId: 'PRESS007_MODULE_GLUE_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});
