import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkModulePressLaw,
  formatModulePressLaw,
  isNameLawRule,
  lowerNameLawBaseline,
  type ModulePressLawResult,
  type ModulePressLawViolation,
  type NameLawBaseline,
} from '../../packages/dev-tooling/src/module-press-law.js';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

/**
 * A routed press-law observation, located BY CONTENT.
 *
 * **This replaced a line number, and the reason is measured rather than
 * asserted.** The `inventory-posting-service.ts` coordinate moved ELEVEN times
 * across FOUR unrelated packets -- 866, 1112, 1115, 1116, 1118, 1125, 1132,
 * 1193, 1278, 1311 -- and every packet that added a line to the upper half of
 * that file inherited an architecture red it did not cause and, being outside
 * its lease, could not fix. Two of those moves were caused purely by adding
 * COMMENTS.
 *
 * The eleventh move is what settled it. A bridge was granted to change the
 * integer from 1193 to 1278, and **by the time the grant came back the answer
 * was 1311**, because closing an unrelated review finding had added a type
 * alias in the same file. **The integer went stale inside the round trip that
 * existed solely to update it.** A locator that cannot survive the latency of
 * its own repair is not a locator.
 *
 * `sourceLine` is the trimmed text of the line the violation sits on, and
 * `occurrence` disambiguates identical text within one file -- three of these
 * rows are the same `'northstar.inventory:capability.posting',` literal in
 * `conformance.ts`, so content ALONE would have silently collapsed them.
 *
 * WHAT THIS IS STILL SENSITIVE TO, and deliberately: adding or removing an
 * EARLIER occurrence of the same text shifts the occurrence index. That is a
 * real change to which pinned identity is routed, and it should fail.
 */
interface RoutedPressLawDebt {
  readonly file: string;
  readonly message: string;
  // Mirrors `ModulePressLawViolation` exactly, nullability included, so a
  // violation outside any module directory cannot be silently reshaped here.
  readonly moduleDirectory: string | null;
  readonly occurrence: number;
  readonly ruleId: ModulePressLawViolation['ruleId'];
  readonly sourceLine: string;
}

function routedIdentityDebt(
  file: string,
  moduleDirectory: string,
  identity: string,
  sourceLine: string,
  occurrence = 1,
): RoutedPressLawDebt {
  return {
    file,
    message: `generic press references ${moduleDirectory} identity ${identity}`,
    moduleDirectory,
    occurrence,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine,
  };
}

/**
 * Re-express a reported violation by WHAT it sits on rather than WHERE. Refuses
 * rather than guessing when the line cannot be read, so a stale or out-of-range
 * report fails closed instead of silently comparing `undefined`.
 */
function locatedByContent(
  root: string,
): (violation: ModulePressLawViolation) => RoutedPressLawDebt {
  return (violation) => locateIn(root, violation);
}

function locateIn(
  root: string,
  violation: ModulePressLawViolation,
): RoutedPressLawDebt {
  const lines = readFileSync(join(root, violation.file), 'utf8').split('\n');
  const text = lines[violation.line - 1];
  assert.ok(
    text !== undefined,
    `press-law reported ${violation.file}:${String(violation.line)}, which that file does not have`,
  );
  const trimmed = text.trim();
  const occurrence = lines
    .slice(0, violation.line)
    .filter((candidate) => candidate.trim() === trimmed).length;
  return {
    file: violation.file,
    message: violation.message,
    moduleDirectory: violation.moduleDirectory,
    occurrence,
    ruleId: violation.ruleId,
    sourceLine: trimmed,
  };
}

// Keeping every routed observation exact is a two-way ratchet: another branch
// fails, and resolving one also fails until its owning row deliberately removes
// it from this record.
//
// Row 1e-2 owns the accepted G3-P1a compiler-conformance identities; row
// press-law-evasion owns the posting provider's frozen identity, whose
// retirement path is not adjudicated.
const routedPressLawDebt: readonly RoutedPressLawDebt[] = [
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_line_get',
    "'goods_receipt_line_get',",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_line_list',
    "'goods_receipt_line_list',",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_line_list',
    "'goods_receipt_line_list',",
    2,
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'purchase_order_amendment_get',
    "'purchase_order_amendment_get',",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_get',
    "['goods_receipt_form', 'goods_receipt_get'],",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_list',
    "['goods_receipt_list', 'goods_receipt_list'],",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_list',
    "['goods_receipt_list', 'goods_receipt_list'],",
  ),
  routedIdentityDebt(
    'apps/web/src/receiving-section.ts',
    'purchasing',
    'goods_receipt_list',
    "return `<section class=\"panel data-panel\" data-receiving-progress><h2>Receiving</h2><p><a href=\"${link('goods_receipt_form')}\">Create goods receipt</a> · <a href=\"${link('goods_receipt_list')}\">View receipts and corrections</a></p><p>Receive against a released order. Close only when every active line has zero remaining. Reopen before receiving, correcting or amending a closed order.</p><table><thead><tr><th>Order line</th><th>Ordered</th><th>Received</th><th>Remaining</th></tr></thead><tbody>${section.lines.map((line) => `<tr data-order-line=\"${escapeHtml(line.recordId)}\"><td><a href=\"${link('purchase_order_line_detail', line.recordId)}\">${escapeHtml(line.item)}</a></td><td>${escapeHtml(line.ordered)}</td><td>${escapeHtml(line.received)}</td><td>${escapeHtml(line.remaining)}</td></tr>`).join('')}</tbody></table>${section.lines.length === 0 ? '<p>No active order lines.</p>' : ''}<p>Corrections append compensating movements; they never edit the original receipt. If a correction would make historical stock negative, correct the erroneous outbound movement first, or use the stock-count process if the discrepancy is physical.</p></section>`;",
  ),
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:capability.posting',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:operation.re_baseline',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 2,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:capability.posting',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:operation.advance_period_lock',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:permission.advance_period_lock',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:operation.reopen_period',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:permission.reopen_period',",
  },
  {
    file: 'packages/compiler/src/conformance.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 3,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:capability.posting',",
  },
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_archive',
    "receiptBinding('archive', 'goods_receipt_archive', 'goods_receipt'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_create',
    "receiptBinding('create', 'goods_receipt_create', 'goods_receipt'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_line_archive',
    "receiptBinding('archive', 'goods_receipt_line_archive', 'goods_receipt_line'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_line_create',
    "receiptBinding('create', 'goods_receipt_line_create', 'goods_receipt_line'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_line_restore',
    "receiptBinding('restore', 'goods_receipt_line_restore', 'goods_receipt_line'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_line_update',
    "receiptBinding('update', 'goods_receipt_line_update', 'goods_receipt_line'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_restore',
    "receiptBinding('restore', 'goods_receipt_restore', 'goods_receipt'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/current-policy.ts',
    'purchasing',
    'goods_receipt_update',
    "receiptBinding('update', 'goods_receipt_update', 'goods_receipt'),",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/fulfillment.ts',
    'sales',
    'northstar.sales',
    "'northstar.sales:capability.fulfillment' as const;",
  ),
  routedIdentityDebt(
    'packages/postgres-provider/src/goods-receipt.ts',
    'purchasing',
    'northstar.purchasing',
    "'northstar.purchasing:capability.receiving' as const;",
  ),
  {
    file: 'packages/postgres-provider/src/inventory-posting-service.ts',
    message: 'generic press references inventory identity northstar.inventory',
    moduleDirectory: 'inventory',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "'northstar.inventory:capability.posting' as const;",
  },
  // PAYABLES: vendor bills, payments and credits post through their own
  // capability; the settlement executor they share names no module.
  routedIdentityDebt(
    'packages/postgres-provider/src/payables-capability-executor.ts',
    'purchasing',
    'northstar.purchasing',
    "'northstar.purchasing:capability.payables' as const;",
  ),
  // SALES-PARITY ruling C: invoices, payments and credits post through their
  // own capability, named as fulfillment's and receiving's are.
  routedIdentityDebt(
    'packages/postgres-provider/src/receivables-capability-executor.ts',
    'sales',
    'northstar.sales',
    "'northstar.sales:capability.receivables' as const;",
  ),
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    message:
      'generic press contains platform-specific PostgresSavedFilterExecutor',
    moduleDirectory: 'platform',
    occurrence: 1,
    ruleId: 'PRESS007_MODULE_GLUE_IN_PRESS',
    sourceLine: 'export class PostgresSavedFilterExecutor',
  },
  {
    file: 'packages/postgres-provider/src/saved-filter-executor.ts',
    message: 'generic press references platform identity northstar.platform',
    moduleDirectory: 'platform',
    occurrence: 1,
    ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
    sourceLine: "eventType: 'northstar.platform:event.saved_filter_changed',",
  },
  routedIdentityDebt(
    'scripts/reconcile-inventory.ts',
    'inventory',
    'inventory_movement_on_hand',
    'aggregateQueryId: `${namespace}:query.inventory_movement_on_hand`,',
  ),
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
    'purchasing',
    'sales',
  ]);
  assert.equal(result.modulesRead, 7);
  assert.ok(
    result.productionFilesRead > 0,
    'press-law guard read zero production files',
  );
  assert.ok(result.scannedFiles > 0, 'press-law guard read zero files');
  assert.deepEqual(
    result.violations.map(locatedByContent(process.cwd())),
    routedPressLawDebt,
  );
});

test('consolidated guard red: the previously omitted Platform module is observed', () => {
  const result = checkModulePressLaw(process.cwd());
  const platformViolations = result.violations
    .map(locatedByContent(process.cwd()))
    .filter((violation) => violation.moduleDirectory === 'platform');
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
    'registration.capabilityId === INVENTORY_POSTING_CAPABILITY_ID',
    "registration.capabilityId ===\n        `${'northstar'}.${'inventory'}:capability.posting`",
  );
  assert.notEqual(mutatedProvider, providerSource);

  const root = createArchitectureFixture({
    [providerPath]: mutatedProvider,
    'packages/domain/src/inventory/definition.ts': inventoryDefinition,
  });
  try {
    assert.deepEqual(
      checkModulePressLaw(root)
        .violations.filter(
          (violation) =>
            violation.ruleId === 'PRESS006_MODULE_ID_IN_PRESS' &&
            violation.message ===
              'generic press references inventory identity northstar.inventory',
        )
        .map(locatedByContent(root)),
      [
        {
          file: providerPath,
          message:
            'generic press references inventory identity northstar.inventory',
          moduleDirectory: 'inventory',
          occurrence: 1,
          ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
          sourceLine: "'northstar.inventory:capability.posting' as const;",
        },
        {
          file: providerPath,
          // PUR-2a. Read from `checkModulePressLaw`, not arithmetic -- the same
          // instruction the routed-debt block above carries. This coordinate is
          // the spliced `registration.capabilityId` comparison, and it moves for
          // ANY packet that adds a line above `validateRegistration`. Locating
          // it by content instead of by integer would make this control immune;
          // filed as `press-law-splice-control-pinned-by-line-number`.
          //
          // Note it is the line AFTER the comparison starts: the splice is two
          // lines, so the identity lands on the second. Deriving this from a
          // grep of the unmutated source is wrong -- which is what the
          // routed-debt comment above means by "arithmetic".
          //
          // This coordinate moved EIGHT times inside `PUR-2a` alone: 866, then
          // 1112, 1115, 1116, 1118, 1125, 1132, 1193. Two moves were caused
          // purely by adding COMMENTS above `validateRegistration`; the others
          // by an argument list, a call, a struct field, and -- the last, and
          // the largest jump -- two interface declarations and a nullable
          // binding. **Every single edit this packet made to the upper half of
          // a 4,000-line file moved it, without exception, across eight
          // rounds.** That is the measurement behind
          // `press-law-splice-control-pinned-by-line-number`. Eight moves in
          // one packet is not an argument for a stronger reminder to update the
          // integer; it is an argument that the integer is the wrong locator
          // and the splice should be found by CONTENT.
          //
          // **DONE, 2026-08-31, after an ELEVENTH move settled it.** The
          // writer-inventory work moved this coordinate 1193 -> 1278. A bridge
          // was requested to change the one integer, and **by the time the
          // grant came back the answer was 1311**: closing a review finding had
          // added a type alias in the upper half of the same file. The integer
          // went stale INSIDE the round trip that existed solely to update it.
          // A locator that cannot survive the latency of its own repair is not
          // a locator, so there is no longer an integer here to go stale.
          //
          // This entry is the SPLICED line the mutation above introduces, which
          // is why its text is a template literal rather than the frozen
          // constant.
          message:
            'generic press references inventory identity northstar.inventory',
          moduleDirectory: 'inventory',
          occurrence: 1,
          sourceLine: "`${'northstar'}.${'inventory'}:capability.posting` &&",
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

test('consolidated guard attributes a multiline partial template type to the template node', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'type Multiline<T extends string> =',
      '  `',
      '${T}',
      ':widget_list`;',
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
      'const listQueryId = `${WIDGET_NAMESPACE}:query.widget_list`;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(checkModulePressLaw(root).violations, [
      {
        file: 'apps/api/src/generic.ts',
        line: 2,
        message: 'generic press references widget identity widget_list',
        moduleDirectory: 'widget',
        ruleId: 'PRESS006_MODULE_ID_IN_PRESS',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard reports every bounded partial run in one unresolved template type', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'type Three<A extends string, B extends string, C extends string> =',
      "  `${'northstar'}.${'widget'}:${A} ${'northstar'}.${'widget'}:${B} ${'widget'}_${'list'}:${C}`;",
    ].join('\n'),
    'packages/domain/src/widget/definition.ts': [
      "export const WIDGET_NAMESPACE = 'northstar.widget';",
      'const entityId = `${WIDGET_NAMESPACE}:entity.widget`;',
      'const listQueryId = `${WIDGET_NAMESPACE}:query.widget_list`;',
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
      expectedViolation,
      {
        ...expectedViolation,
        message: 'generic press references widget identity widget_list',
      },
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('consolidated guard observes exact primitive and nested template type spans', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      "export type Numeric = `${'northstar.widget'}${1}`;",
      "export type BigInt = `${'widget_phase'}${3n}`;",
      "export type BooleanTrue = `${'widget_flag'}${true}`;",
      "export type BooleanFalse = `${'widget_flag'}${false}`;",
      "export type Null = `${'widget_null'}${null}`;",
      "export type Undefined = `${'widget_undefined'}${undefined}`;",
      "export type Parenthesized = `${('widget')}_${('parenthesized')}`;",
      "export type Nested = `${`${'widget'}_`}nested`;",
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
      '  `${WIDGET_NAMESPACE}:query.widget_flagfalse`,',
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
      'widget_flagfalse',
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

test('consolidated guard retains raw ownership inside an unresolved template type span', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'type RawInsideRejectedSpan<T extends string> =',
      "  `prefix:${T | 'northstar.widget:capability.raw'}`;",
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

test('consolidated guard preserves no-substitution template literal boundaries in incomplete concatenations', () => {
  const root = createArchitectureFixture({
    'apps/api/src/generic.ts': [
      'declare const suffix: string;',
      'export const bounded =',
      '  `northstar.` + `widget:` + suffix;',
      'export const admitted =',
      '  `northstar.` + `widget` + suffix;',
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

// ---------------------------------------------------------------------------
// GUARD-WIDEN: the first-party name law. Tests whose names start with
// "GUARD-WIDEN" are the packet's rule 8 set: one red per layer plus the real
// tree. test/evidence/GUARD-WIDEN.expected-red.json runs exactly that set and
// requires each layer's mutation to kill its own red and nothing else in it.
// ---------------------------------------------------------------------------

const firstPartyRelease = {
  capabilityRequirements: [{ capabilityId: 'acme.app:capability.fulfillment' }],
  entities: [
    { entityId: 'acme.app:entity.sales_order' },
    { entityId: 'acme.app:entity.item' },
    { entityId: 'acme.app:entity.legal_entity' },
  ],
  fields: [
    { fieldId: 'acme.app:field.sales_order_number' },
    { fieldId: 'acme.app:field.legal_entity_name' },
  ],
  modules: [{ moduleId: 'acme.app:module.sales' }],
  operations: [{ operationId: 'acme.app:operation.sales_order_close' }],
  package: { namespace: 'acme.app' },
  queries: [{ queryId: 'acme.app:query.sales_order_list' }],
};

const nameLawPolicy = {
  excluded: [],
  externalNames: [],
  moduleWords: ['receiving'],
  ordinaryWords: ['item', 'sales'],
  platformOwned: [{ name: 'legal_entity', reason: 'platform dimension' }],
  requiredNames: ['sales_order'],
  scope: ['packages/postgres-provider/src', 'db/migrations'],
  version: 1,
  vocabularySources: ['apps/web/release/app.authored.json'],
};

const enginesManifest = {
  engines: [
    {
      adr: null,
      businesses: ['rental', 'clinic', 'hotel'],
      files: ['packages/postgres-provider/src/booking-engine.ts'],
      id: 'booking',
      names: ['booking'],
      nameScope: 'exclusive',
    },
    {
      adr: null,
      businesses: ['rental', 'storage', 'subscription'],
      files: ['packages/postgres-provider/src/billing-engine.ts'],
      id: 'billing',
      names: ['billing'],
      nameScope: 'exclusive',
    },
    {
      adr: null,
      businesses: ['rental', 'distribution', 'clinic'],
      files: [],
      id: 'workflow',
      names: ['workflow'],
      nameScope: 'engines-only',
    },
  ],
  version: 1,
};

function nameLawFixture(
  files: Record<string, string>,
  baselineFiles: NameLawBaseline['files'] = {},
): string {
  return createArchitectureFixture({
    'apps/web/release/app.authored.json': JSON.stringify(firstPartyRelease),
    'db/migrations/0000_fixture.sql': 'SELECT 1;\n',
    'packages/postgres-provider/src/billing-engine.ts':
      'export const engine = 1;\n',
    'packages/postgres-provider/src/booking-engine.ts':
      'export const engine = 1;\n',
    'test/architecture/engines.manifest.json': JSON.stringify(enginesManifest),
    'test/architecture/first-party-names.baseline.json': JSON.stringify({
      files: baselineFiles,
      measuredOn: 'fixture',
      version: 1,
    }),
    'test/architecture/first-party-names.policy.json':
      JSON.stringify(nameLawPolicy),
    ...files,
  });
}

function nameLawViolations(
  result: ModulePressLawResult,
): ModulePressLawViolation[] {
  return result.violations.filter((violation) =>
    isNameLawRule(violation.ruleId),
  );
}

function withNameLawFixture<T>(
  files: Record<string, string>,
  observe: (result: ModulePressLawResult) => T,
  baselineFiles?: NameLawBaseline['files'],
): T {
  const root = nameLawFixture(files, baselineFiles);
  try {
    return observe(checkModulePressLaw(root));
  } finally {
    removeArchitectureFixture(root);
  }
}

const genericFile = 'packages/postgres-provider/src/generic.ts';

function nameLawRow(
  names: Record<string, number>,
): NameLawBaseline['files'][string] {
  return { cluster: 'C8', expires: '2099-01-01', names, owner: 'FIXTURE' };
}

test('GUARD-WIDEN: the real tree reads the release vocabulary and holds its baseline', () => {
  const result = checkModulePressLaw(process.cwd());
  assert.equal(result.nameLaw.active, true, 'the name law did not run');
  for (const name of [
    'purchase_order',
    'sales_order',
    'shipment',
    'stock_count',
    'customer_invoice',
    'vendor_bill',
  ]) {
    assert.ok(
      result.nameLaw.vocabulary.includes(name),
      `the release vocabulary lacks ${name}`,
    );
  }
  assert.ok(result.nameLaw.filesRead > 0, 'the name law read no files');
  assert.deepEqual(
    nameLawViolations(result).map(
      (violation) =>
        `${violation.file}:${String(violation.line)} [${violation.ruleId}] ${violation.message}`,
    ),
    [],
    'the real tree breaks the first-party name baseline; convert the code, never raise the baseline',
  );
});

test('GUARD-WIDEN red: a new first-party name in a generic file', () => {
  withNameLawFixture(
    { [genericFile]: "export const id = 'sales_order';\n" },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result),
        [
          {
            file: genericFile,
            line: 1,
            message:
              'generic code names first-party entity sales_order (name:sales_order x1, not in the baseline)',
            moduleDirectory: null,
            ruleId: 'PRESS011_FIRST_PARTY_NAME',
          },
        ],
        'a new first-party name in a generic file must be refused by PRESS011',
      );
    },
  );
});

test('GUARD-WIDEN red: a new first-party field name in a generic file', () => {
  withNameLawFixture(
    { [genericFile]: "export const column = 'sales_order_number';\n" },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result),
        [
          {
            file: genericFile,
            line: 1,
            message:
              'generic code names first-party field sales_order_number (field:sales_order_number x1, not in the baseline)',
            moduleDirectory: null,
            ruleId: 'PRESS012_FIRST_PARTY_FIELD',
          },
        ],
        'a new first-party field name in a generic file must be refused by PRESS012',
      );
    },
  );
});

test('GUARD-WIDEN red: a new import from packages/domain in a generic file', () => {
  withNameLawFixture(
    {
      [genericFile]:
        "import { terms } from '../../domain/src/widget/terms.js';\nexport const value = terms;\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result),
        [
          {
            file: genericFile,
            line: 1,
            message:
              'generic code imports terms from packages/domain/src/widget/terms (import:packages/domain/src/widget/terms#terms x1, not in the baseline)',
            moduleDirectory: null,
            ruleId: 'PRESS013_DOMAIN_IMPORT',
          },
        ],
        'a new import from packages/domain must be refused by PRESS013',
      );
    },
  );
});

test('GUARD-WIDEN red: one engine naming another', () => {
  withNameLawFixture(
    {
      'packages/postgres-provider/src/billing-engine.ts':
        "export const source = 'booking';\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result),
        [
          {
            file: 'packages/postgres-provider/src/billing-engine.ts',
            line: 1,
            message:
              'engine billing names engine booking (engine:booking x1, not in the baseline)',
            moduleDirectory: null,
            ruleId: 'PRESS014_ENGINE_NAME',
          },
        ],
        'one engine naming another must be refused by PRESS014',
      );
    },
  );
});

test('GUARD-WIDEN red: a count above its baseline allowance', () => {
  withNameLawFixture(
    {
      [genericFile]:
        "export const first = 'booking';\nexport const second = 'booking';\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result),
        [
          {
            file: genericFile,
            line: 1,
            message:
              'engine:booking rose from 1 to 2; the baseline only shrinks',
            moduleDirectory: null,
            ruleId: 'PRESS015_BASELINE_RISE',
          },
        ],
        'a count above its baseline allowance must be refused by PRESS015',
      );
    },
    { [genericFile]: nameLawRow({ 'engine:booking': 1 }) },
  );
});

test('GUARD-WIDEN red: a new kebab-named file or directory', () => {
  const probe =
    'packages/postgres-provider/src/sales-order/sales-order-probe.ts';
  withNameLawFixture({ [probe]: 'export const ok = true;\n' }, (result) => {
    assert.deepEqual(
      nameLawViolations(result),
      [
        {
          file: probe,
          line: 1,
          message:
            'generic code names first-party entity sales_order (name:sales_order x2, not in the baseline)',
          moduleDirectory: null,
          ruleId: 'PRESS011_FIRST_PARTY_NAME',
        },
      ],
      'a kebab-named file or directory must be refused by PRESS011',
    );
  });
});

test('GUARD-WIDEN red: a new kebab spelling in a string', () => {
  withNameLawFixture(
    { [genericFile]: "export const id = 'sales-order';\n" },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.message),
        [
          'generic code names first-party entity sales_order (name:sales_order x1, not in the baseline)',
        ],
        'a kebab spelling in a string must be refused by PRESS011',
      );
    },
  );
});

test('GUARD-WIDEN red: a statically concatenated first-party name', () => {
  withNameLawFixture(
    { [genericFile]: "export const id = 'sales' + '_order';\n" },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.message),
        [
          'generic code names first-party entity sales_order (name:sales_order x1, not in the baseline)',
        ],
        'a statically concatenated name must be refused by PRESS011',
      );
    },
  );
});

test('GUARD-WIDEN red: widening a baselined domain import', () => {
  withNameLawFixture(
    {
      [genericFile]:
        "import { terms, rates } from '@north-star/domain/widget/terms';\nexport const value = [terms, rates];\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.message),
        [
          'generic code imports rates from @north-star/domain/widget/terms (import:@north-star/domain/widget/terms#rates x1, not in the baseline)',
        ],
        'a binding added to a baselined domain import must be refused by PRESS013',
      );
    },
    {
      [genericFile]: nameLawRow({
        'import:@north-star/domain/widget/terms#terms': 1,
      }),
    },
  );
});

test('GUARD-WIDEN red: an unclassified source root', () => {
  withNameLawFixture(
    { 'packages/zz-new/src/index.ts': 'export const ok = true;\n' },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.message),
        [
          'packages/zz-new/src is neither in the name-law scope nor excluded; classify it in the policy',
        ],
        'a source root in neither the scope nor the excluded list must be refused by PRESS010',
      );
    },
  );
});

test('name law observes snake, camel, Pascal, plural and endsWith spellings', () => {
  withNameLawFixture(
    {
      [genericFile]: [
        "const a = operationId.endsWith(':operation.sales_order_close');",
        'const salesOrders = [];',
        'class SalesOrderReader {}',
        "const b = 'SALES_ORDER_LIST';",
      ].join('\n'),
    },
    (result) => {
      assert.deepEqual(result.nameLaw.observations, {
        [genericFile]: {
          'name:sales_order': 2,
          'name:sales_order_close': 1,
          'name:sales_order_list': 1,
        },
      });
    },
  );
});

test('name law matches an ordinary word only in ID position', () => {
  withNameLawFixture(
    {
      [genericFile]: [
        'const item = 1;',
        "const sales = 'sales';",
        "const entity = 'acme.app:entity.item';",
        "const module = 'acme.sales';",
      ].join('\n'),
    },
    (result) => {
      assert.deepEqual(result.nameLaw.observations, {
        [genericFile]: { 'name:item': 1, 'name:sales': 1 },
      });
    },
  );
});

test('name law counts a file named for a module and ignores comments', () => {
  withNameLawFixture(
    {
      'packages/postgres-provider/src/receiving-helper.ts': [
        '// sales_order is only mentioned here',
        '/* and here: sales_order_number */',
        'export const ok = true;',
      ].join('\n'),
      'db/migrations/0001_x.sql': "-- sales_order\nSELECT 'ok';\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => [
          violation.file,
          violation.line,
          violation.ruleId,
        ]),
        [
          [
            'packages/postgres-provider/src/receiving-helper.ts',
            1,
            'PRESS011_FIRST_PARTY_NAME',
          ],
        ],
      );
    },
  );
});

test('name law refuses an exclusive engine in generic code and admits an engines-only one', () => {
  withNameLawFixture(
    {
      [genericFile]:
        "export const kind = 'workflow';\nexport const charge = 'billing';\n",
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.message),
        [
          'generic code names engine billing outside its own files (engine:billing x1, not in the baseline)',
        ],
      );
    },
  );
});

test('name law leaves platform-owned vocabulary to the platform', () => {
  withNameLawFixture(
    {
      [genericFile]:
        "export const scope = 'legal_entity';\nexport const label = 'legal_entity_name';\n",
    },
    (result) => {
      assert.deepEqual(result.nameLaw.observations, {});
    },
  );
});

test('name law passes a fall and the lowering only ever lowers', () => {
  const baselineFiles = {
    [genericFile]: nameLawRow({ 'name:sales_order': 3, 'name:item': 1 }),
  };
  withNameLawFixture(
    { [genericFile]: "export const id = 'sales_order';\n" },
    (result) => {
      assert.deepEqual(nameLawViolations(result), []);
      assert.deepEqual(
        result.nameLaw.slack.map((row) => [
          row.key,
          row.baseline,
          row.observed,
        ]),
        [
          ['name:item', 1, 0],
          ['name:sales_order', 3, 1],
        ],
      );
      const baseline = {
        files: baselineFiles,
        measuredOn: 'fixture',
        version: 1 as const,
      };
      assert.deepEqual(
        lowerNameLawBaseline(baseline, result.nameLaw.observations).files,
        { [genericFile]: nameLawRow({ 'name:sales_order': 1 }) },
      );
      assert.throws(
        () =>
          lowerNameLawBaseline(baseline, {
            [genericFile]: { 'name:sales_order': 4 },
          }),
        /the baseline is never raised/u,
      );
    },
    baselineFiles,
  );
});

test('name law fails closed on a missing scope root or an empty scope', () => {
  for (const [scope, message] of [
    [
      [...nameLawPolicy.scope, 'packages/renamed/src'],
      'name-law scope root packages/renamed/src does not exist',
    ],
    [[], 'the name-law scope is empty'],
  ] as const) {
    withNameLawFixture(
      {
        'test/architecture/first-party-names.policy.json': JSON.stringify({
          ...nameLawPolicy,
          scope,
        }),
      },
      (result) => {
        assert.deepEqual(
          nameLawViolations(result).map((violation) => [
            violation.ruleId,
            violation.message,
          ]),
          [['PRESS010_NAME_LAW_INPUT', message]],
        );
      },
    );
  }
});

test('name law counts every imported binding, including backtick dynamic imports', () => {
  withNameLawFixture(
    {
      [genericFile]: [
        "import d, * as all from '../../domain/src/widget/terms.js';",
        "export * from '../../domain/src/widget/rates.js';",
        'const later = await import(`@north-star/domain/widget/terms`);',
      ].join('\n'),
    },
    (result) => {
      assert.deepEqual(result.nameLaw.observations, {
        [genericFile]: {
          'import:@north-star/domain/widget/terms#import()': 1,
          'import:packages/domain/src/widget/rates#*': 1,
          'import:packages/domain/src/widget/terms#*': 1,
          'import:packages/domain/src/widget/terms#default': 1,
        },
      });
    },
  );
});

test('name law refuses a missing input or a vocabulary without its required names', () => {
  const root = nameLawFixture({});
  try {
    rmSync(join(root, 'test/architecture/first-party-names.baseline.json'));
    assert.deepEqual(
      nameLawViolations(checkModulePressLaw(root)).map((v) => v.message),
      [
        'name law input test/architecture/first-party-names.baseline.json is missing',
      ],
    );
  } finally {
    removeArchitectureFixture(root);
  }
  withNameLawFixture(
    {
      'test/architecture/first-party-names.policy.json': JSON.stringify({
        ...nameLawPolicy,
        requiredNames: ['sales_order', 'vendor_bill'],
      }),
    },
    (result) => {
      assert.deepEqual(
        nameLawViolations(result).map((violation) => violation.ruleId),
        ['PRESS010_NAME_LAW_INPUT'],
      );
    },
  );
});

test('name law: guard:lower-baseline refuses a rise or a moved file and writes nothing, and lowers a fall', () => {
  const cli = join(
    process.cwd(),
    'packages/dev-tooling/src/lower-first-party-baseline.ts',
  );
  const baselinePath = 'test/architecture/first-party-names.baseline.json';
  const run = (root: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, '--root', root], {
      encoding: 'utf8',
    });

  const rising = nameLawFixture(
    {
      [genericFile]:
        "export const a = 'sales_order';\nexport const b = 'sales_order';\n",
    },
    { [genericFile]: nameLawRow({ 'name:sales_order': 1 }) },
  );
  try {
    const before = readFileSync(join(rising, baselinePath), 'utf8');
    const result = run(rising);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused/u);
    assert.match(result.stderr, /PRESS015_BASELINE_RISE/u);
    assert.equal(readFileSync(join(rising, baselinePath), 'utf8'), before);
  } finally {
    removeArchitectureFixture(rising);
  }

  const moved = nameLawFixture(
    {
      'scripts/moved/generic.ts': "export const a = 'sales_order';\n",
    },
    { [genericFile]: nameLawRow({ 'name:sales_order': 1 }) },
  );
  try {
    const before = readFileSync(join(moved, baselinePath), 'utf8');
    const result = run(moved);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /a move is re-measured deliberately/u);
    assert.equal(readFileSync(join(moved, baselinePath), 'utf8'), before);
  } finally {
    removeArchitectureFixture(moved);
  }

  const falling = nameLawFixture(
    { [genericFile]: "export const a = 'sales_order';\n" },
    {
      [genericFile]: nameLawRow({ 'name:sales_order': 2 }),
      'packages/postgres-provider/src/gone.ts': nameLawRow({
        'name:sales_order': 1,
      }),
    },
  );
  try {
    const result = run(falling);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(falling, baselinePath), 'utf8')),
      {
        version: 1,
        measuredOn: 'fixture',
        files: { [genericFile]: nameLawRow({ 'name:sales_order': 1 }) },
      },
    );
  } finally {
    removeArchitectureFixture(falling);
  }
});
