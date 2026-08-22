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

test('consolidated guard red: every identity in one completed construction is observed', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export const identities = 'northstar.widget:first ' + 'northstar.widget:second';\n",
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

test('consolidated guard admission: completed values own direct literal-token boundaries', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const local = 'widget_list' + 'er';",
      "export const symbol = 'WIDGET_IDS' + '_EXTENSION';",
      "export const namespace = 'northstar.widget' + '-contract/v1';",
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

test('consolidated guard red: type-literal ownership is unchanged by an empty runtime concatenation', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'export const direct =',
      "  'ordinary' satisfies 'ordinary' | 'northstar.widget';",
      'export const constructed =',
      "  ('ordinary' satisfies 'ordinary' | 'northstar.widget') + '';",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    const expectedViolation: ModulePressLawViolation = {
      file: 'apps/api/src/generic.ts',
      line: 2,
      message: 'generic press references widget identity northstar.widget',
      moduleDirectory: 'widget',
      ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    };
    assert.deepEqual(checkModulePressLaw(root).violations, [
      expectedViolation,
      { ...expectedViolation, line: 4 },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: runtime construction and independent type literal retain separate ownership', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'export const value =',
      "  ('northstar.widget:capability.runtime' satisfies",
      "    string | 'northstar.widget:capability.type') +",
      "  '';",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    const expectedViolation: ModulePressLawViolation = {
      file: 'apps/api/src/generic.ts',
      line: 2,
      message: 'generic press references widget identity northstar.widget',
      moduleDirectory: 'widget',
      ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    };
    assert.deepEqual(checkModulePressLaw(root).violations, [
      expectedViolation,
      { ...expectedViolation, line: 3 },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard red: every transparent wrapper retains a split runtime identity', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const parenthesized = ('northstar') + '.' + 'widget';",
      "export const asserted = ('northstar' as string | 'northstar.widget:capability.as-type') + '.' + 'widget';",
      "export const angleAsserted = (<string | 'northstar.widget:capability.angle-type'>'northstar') + '.' + 'widget';",
      "export const satisfied = ('northstar' satisfies string | 'northstar.widget:capability.satisfies-type') + '.' + 'widget';",
      "export const nonNull = ('northstar'!) + '.' + 'widget';",
    ].join('\n'),
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
    assert.deepEqual(
      checkModulePressLaw(root).violations,
      [1, 2, 2, 3, 3, 4, 4, 5].map((line) => ({
        ...expectedViolation,
        line,
      })),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard observes literal-only template types without refusing longer contract types', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export type DirectCapability = 'northstar.widget:capability.direct';",
      'export type SplicedCapability =',
      "  `${'northstar'}.${'widget'}:capability.spliced`;",
      "export type ContractNamespace = `${'northstar'}.${'widget'}-contract/v1`;",
    ].join('\n'),
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
      { ...expectedViolation, line: 3 },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard discovers spliced template types beneath completed typed runtime constructions', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export const direct = 'ordinary' satisfies string | `${'northstar'}.${'widget'}:capability.direct-type`;",
      "export const completed = ('ordinary' satisfies string | `${'northstar'}.${'widget'}:capability.completed-type`) + '';",
    ].join('\n'),
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
      { ...expectedViolation, line: 2 },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard preserves unknown right adjacency for contiguous and split template types', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'type UnknownContiguous<T extends string> = `northstar.widget${T}`;',
      "type UnknownSplit<T extends string> = `${'northstar'}.${'widget'}${T}`;",
      'type BoundedContiguous<T extends string> = `northstar.widget:${T}`;',
      "type BoundedSplit<T extends string> = `${'northstar'}.${'widget'}:${T}`;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
    ].join('\n'),
  });
  try {
    const expectedViolation: ModulePressLawViolation = {
      file: 'apps/api/src/generic.ts',
      line: 3,
      message: 'generic press references widget identity northstar.widget',
      moduleDirectory: 'widget',
      ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    };
    assert.deepEqual(checkModulePressLaw(root).violations, [
      expectedViolation,
      { ...expectedViolation, line: 4 },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard preserves unknown left adjacency across template type tails and substitutions', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'type TailUnknown<T extends string> = `${T}widget_list`;',
      "type SubstitutionUnknown<T extends string> = `${T}${'widget_list'}`;",
      'type TailBounded<T extends string> = `${T}:widget_list`;',
      "type SubstitutionBounded<T extends string> = `${T}:${'widget_list'}`;",
      'type SymbolUnknown<T extends string> = `${T}WIDGET_IDS`;',
      'type SymbolBounded<T extends string> = `${T}:WIDGET_IDS`;',
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
      'const listQueryId = `${WIDGET_NAMESPACE}:query.widget_list`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(
      checkModulePressLaw(root).violations,
      [3, 4, 6].map((line) => ({
        file: 'apps/api/src/generic.ts',
        line,
        message:
          line === 6
            ? 'generic press references widget identity WIDGET_IDS'
            : 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      })),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard observes exact primitive and nested template type spans', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export type Numeric = `${'northstar.widget'}${1}`;",
      "export type BigInt = `${'widget_phase'}${3n}`;",
      "export type Boolean = `${'widget_flag'}${true}`;",
      "export type Null = `${'widget_null'}${null}`;",
      "export type Undefined = `${'widget_undefined'}${undefined}`;",
      "export type Parenthesized = `${('widget')}_${('parenthesized')}`;",
      "export type Nested = `${`${'widget'}_${'nested'}`}`;",
      "export type Contract = `${'northstar.widget'}${1}-contract/v1`;",
      "export type SubstitutionContinuation = `${'widget_phase3'}_extension`;",
      "export type TailContinuation = `${'prefix_'}widget_phase3`;",
      "export type HeadContinuation = `widget_phase3${'_extension'}`;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget1';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
      'const primitiveIds = [',
      '  `${WIDGET_NAMESPACE}:query.widget_phase3`,',
      '  `${WIDGET_NAMESPACE}:query.widget_flagtrue`,',
      '  `${WIDGET_NAMESPACE}:query.widget_nullnull`,',
      '  `${WIDGET_NAMESPACE}:query.widget_undefinedundefined`,',
      '  `${WIDGET_NAMESPACE}:query.widget_parenthesized`,',
      '  `${WIDGET_NAMESPACE}:query.widget_nested`,',
      '];',
    ].join('\n'),
  });
  try {
    const expectedIdentities = [
      'northstar.widget1',
      'widget_phase3',
      'widget_flagtrue',
      'widget_nullnull',
      'widget_undefinedundefined',
      'widget_parenthesized',
      'widget_nested',
    ];
    assert.deepEqual(
      checkModulePressLaw(root).violations,
      expectedIdentities.map((identity, index) => ({
        file: 'apps/api/src/generic.ts',
        line: index + 1,
        message: `generic press references widget identity ${identity}`,
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      })),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard discovers an independently exact template type inside a rejected outer type', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts':
      "export type Nested<T extends string> = `${T | `${'northstar'}.${'widget'}:capability.nested`}`;",
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
      'export const suffix =',
      "  `${tenantId}: ${'northstar'}.${'widget'}`;",
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
      {
        file: 'apps/api/src/generic.ts',
        line: 8,
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

test('consolidated guard admission: contiguous and split literal segments preserve unknown adjacency', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const prefix: string;',
      'declare const suffix: string;',
      "export const contiguousLocal = prefix + 'widget_list';",
      "export const splitLocal = prefix + 'widget' + '_' + 'list';",
      "export const contiguousSymbol = prefix + 'WIDGET_IDS';",
      "export const splitSymbol = prefix + 'WIDGET' + '_' + 'IDS';",
      "export const contiguousNamespace = 'northstar.widget' + suffix;",
      "export const splitNamespace = 'northstar' + '.' + 'widget' + suffix;",
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

test('consolidated guard red: contiguous and split literal segments retain static boundaries', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const prefix: string;',
      'declare const suffix: string;',
      "export const contiguousLocal = prefix + ':' + 'widget_list';",
      "export const splitLocal = prefix + ':' + 'widget' + '_' + 'list';",
      "export const contiguousSymbol = prefix + ':' + 'WIDGET_IDS';",
      "export const splitSymbol = prefix + ':' + 'WIDGET' + '_' + 'IDS';",
      "export const contiguousNamespace = 'northstar.widget:' + suffix;",
      "export const splitNamespace = 'northstar' + '.' + 'widget:' + suffix;",
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
        message: 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 4,
        message: 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 5,
        message: 'generic press references widget identity WIDGET_IDS',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 6,
        message: 'generic press references widget identity WIDGET_IDS',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 7,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 8,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard preserves unknown left adjacency for word-bounded identities', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const prefix: string;',
      'export const localAdmitted =',
      "  `${prefix}${'widget'}_${'list'}`;",
      'export const localRefused =',
      "  `${prefix}:${'widget'}_${'list'}`;",
      'export const symbolAdmitted =',
      "  `${prefix}${'WIDGET'}_${'IDS'}`;",
      'export const symbolRefused =',
      "  `${prefix}:${'WIDGET'}_${'IDS'}`;",
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
        line: 5,
        message: 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
      {
        file: 'apps/api/src/generic.ts',
        line: 9,
        message: 'generic press references widget identity WIDGET_IDS',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard reports every bounded partial run in one incomplete construction', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const gap: string;',
      'declare const tail: string;',
      'export const message =',
      "  'northstar.' + 'widget:first ' + gap +",
      "  ' northstar.' + 'widget:second ' + tail;",
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
        line: 5,
        message: 'generic press references widget identity northstar.widget',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
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
