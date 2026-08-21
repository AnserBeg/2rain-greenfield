import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// Keeping every routed observation exact is a two-way ratchet: another branch
// fails, and resolving one also fails until its owning row deliberately removes
// it from this record.
const routedPressLawDebt: readonly ModulePressLawViolation[] = [
  // Row 1e-2 owns these accepted G3-P1a module identities, newly visible when
  // Inventory became definition-backed. Occurrence-complete PRESS006 exposes
  // every pinned compiler assertion; keep all of them exact until that row
  // replaces the hard-coded contract pattern.
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 1888,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2338,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2377,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2546,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2550,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2555,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2559,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    line: 2693,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  // Row press-law-evasion owns the posting provider's exact frozen identity.
  // Its retirement path is not adjudicated; row 1e-2 owns only the separate
  // compiler-conformance identity.
  {
    file: 'packages/postgres-provider/src/inventory-posting-service.ts',
    line: 37,
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
  },
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    line: 103,
    message:
      'generic press contains platform-specific PostgresSavedFilterExecutor',
    moduleDirectory: 'platform',
    ruleId: 'PRESS007_MODULE_GLUE_IN_PRESS',
  },
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    line: 1013,
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
  assert.deepEqual(result.violations, routedPressLawDebt);
});

test('consolidated guard red: the previously omitted Platform module is observed', () => {
  const result = checkModulePressLaw(process.cwd());
  const platformViolations = result.violations.filter(
    (violation) => violation.moduleDirectory === 'platform',
  );
  assert.deepEqual(
    platformViolations,
    routedPressLawDebt.filter(
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

test('consolidated guard red: a statically interpolated module identity cannot hide from PRESS006', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const unrelated = 'ordinary' + '-value';",
      'export const capabilityId =',
      "  `${'northstar'}.${'widget'}:capability.posting`;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 3,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: a statically concatenated module identity cannot hide from PRESS006', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export const capabilityId = 'northstar' + '.' + 'widget' + ':capability.posting';\n",
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
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: direct and later constructed identities are additive in one file', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const routed = 'northstar.widget:capability.routed';",
      'export const later =',
      "  `${'northstar'}.${'widget'}:capability.later`;",
    ].join('\n'),
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
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 3,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: every completed constructed identity in one file is observed', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const first = `${'northstar'}.${'widget'}:capability.first`;",
      "export const second = 'northstar' + '.' + 'widget' + ':capability.second';",
    ].join('\n'),
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
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 2,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard records one observation when direct and constructed matches describe the same construction', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export const routed = 'northstar.widget' + ':capability.routed';\n",
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
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard keeps unrelated direct and constructed identities on one line', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export const values = ['northstar.widget:capability.direct', `${'northstar'}.${'widget'}:capability.constructed`];\n",
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    const expectedViolation: ModulePressLawViolation = {
      file: 'apps/api/src/generic.ts',
      line: 1,
      message: 'generic press references widget identity northstar.widget',
      moduleDirectory: 'widget',
      ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    };
    assert.deepEqual(checkModulePressLaw(root).violations, [
      expectedViolation,
      { ...expectedViolation },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: the routed Inventory literal cannot mask a later live-comparison splice', () => {
  const providerPath =
    'packages/postgres-provider/src/inventory-posting-service.ts';
  const providerSource = readFileSync(providerPath, 'utf8');
  const inventoryDefinition = readFileSync(
    'packages/domain/src/inventory/definition.ts',
    'utf8',
  );
  assert.match(
    providerSource,
    /export const INVENTORY_POSTING_CAPABILITY_ID =\n {2}'northstar\.inventory:capability\.posting' as const;/u,
  );
  const mutatedProvider = providerSource.replace(
    'registration.capabilityId !== INVENTORY_POSTING_CAPABILITY_ID',
    "registration.capabilityId !==\n      `${'northstar'}.${'inventory'}:capability.posting`",
  );
  assert.notEqual(mutatedProvider, providerSource);

  const root = createArchitectureFixture({
    [providerPath]: mutatedProvider,
    'packages/domain/src/inventory/definition.ts': inventoryDefinition,
  });
  try {
    assert.deepEqual(
      checkModulePressLaw(root).violations.filter(
        (violation) =>
          violation.ruleId === 'PRESS006_MODULE_ID_IN_PRESS' &&
          violation.message ===
            'generic press references inventory identity northstar.inventory',
      ),
      [
        {
          file: providerPath,
          line: 37,
          message:
            'generic press references inventory identity northstar.inventory',
          moduleDirectory: 'inventory',
          ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
        },
        {
          file: providerPath,
          line: 866,
          message:
            'generic press references inventory identity northstar.inventory',
          moduleDirectory: 'inventory',
          ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
        },
      ],
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard admission: completed static constructions may name a longer contract namespace', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const concatenated = 'northstar' + '.' + 'widget' + '-contract/v1';",
      "export const interpolated = `${'northstar'}.${'widget'}-contract/v1`;",
    ].join('\n'),
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

test('consolidated guard admission: a static prefix beneath a dynamic outer construction is not a completed value', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "const suffix = '-contract/v1';",
      "export const schema = 'northstar' + '.' + 'widget' + suffix;",
    ].join('\n'),
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

test('consolidated guard red: a statically bounded identity cannot hide inside a dynamic outer construction', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const tenantId: string;',
      'declare const version: string;',
      'export const message =',
      "  `${'northstar'}.${'widget'}:capability.posting denied for ${tenantId}`;",
      'export const route =',
      "  'northstar.' + 'widget:capability.posting/' + version;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 4,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 6,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard admission: an unbounded static prefix may continue through a runtime value', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const suffix: string;',
      'export const interpolated =',
      "  `${'northstar'}.${'widget'}${suffix}`;",
      'export const concatenated =',
      "  'northstar' + '.' + 'widget' + suffix;",
    ].join('\n'),
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

test('consolidated guard admission: a tagged template body is not an ordinary completed string', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const tag: (parts: TemplateStringsArray, ...values: unknown[]) => string;',
      "export const schema = tag`${'northstar'}.${'widget'}:capability.posting`;",
    ].join('\n'),
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

test('consolidated guard red: a completed concatenation in a tagged substitution is observed', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const tag: (parts: TemplateStringsArray, ...values: unknown[]) => string;',
      "export const value = tag`${'northstar' + '.' + 'widget'}`;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 2,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard admission: a completed tagged substitution may name a longer contract namespace', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const tag: (parts: TemplateStringsArray, ...values: unknown[]) => string;',
      "export const value = tag`${'northstar' + '.' + 'widget' + '-contract/v1'}`;",
    ].join('\n'),
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

test('consolidated guard red: a completed call argument beneath a dynamic concatenation is observed', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const wrap: (value: string) => string;',
      'declare const suffix: string;',
      "export const value = wrap('northstar' + '.' + 'widget') + suffix;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 3,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard admission: a completed call argument may name a longer contract namespace', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const wrap: (value: string) => string;',
      'declare const suffix: string;',
      "export const value = wrap('northstar' + '.' + 'widget' + '-contract/v1') + suffix;",
    ].join('\n'),
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

test('consolidated guard admission: a module may spell its own identity in its definition', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': 'export const generic = true;\n',
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
