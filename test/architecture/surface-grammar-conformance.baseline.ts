import type { ProductSurfaceGrammarBaselineEntry } from '../../packages/dev-tooling/src/surface-grammar-conformance/index.js';

/**
 * Deliberately reviewed debt for compiled production modules. A count change in
 * either direction requires this artifact to move in the same commit.
 */
export const PRODUCT_SURFACE_GRAMMAR_BASELINE = Object.freeze([
  Object.freeze({
    moduleId: 'northstar.catalog:module.catalog',
    packageId: 'northstar.catalog:package.catalog',
    sourceDirectory: 'catalog',
    violationCount: 13,
  }),
  Object.freeze({
    moduleId: 'northstar.inventory:module.inventory',
    packageId: 'northstar.inventory:package.inventory',
    sourceDirectory: 'inventory',
    // G3-P6a moved Inventory from 103 to 127. The Record archetype dropped
    // `commandBar` so archive and restore cannot render, and the structurally
    // required Forms dropped `commandBar`/`sections` for a single `activity`
    // slot whose component this runtime deliberately does not register. Seven
    // Record surfaces each report one more missing `commandBar` (+14 across
    // SG003 and SG009) and five Form surfaces each trade one missing
    // `activity` for a missing `commandBar` and `sections` (+10). G3-P6b-2's
    // complete on-hand Task closes the one missing-archetype violation.
    // 5g3-postroute then supplies inventory_transaction_detail's commandBar,
    // closing that surface's SG003_REQUIRED_SLOT and SG009_COMPACT_SLOT:
    // 126 - 2 = 124. The remaining anatomy debt is unchanged.
    violationCount: 124,
  }),
  Object.freeze({
    moduleId: 'northstar.location:module.location',
    packageId: 'northstar.location:package.location',
    sourceDirectory: 'location',
    violationCount: 13,
  }),
  Object.freeze({
    moduleId: 'northstar.party:module.party',
    packageId: 'northstar.party:package.party',
    sourceDirectory: 'party',
    violationCount: 23,
  }),
  Object.freeze({
    moduleId: 'northstar.platform:module.saved_filters',
    packageId: 'northstar.platform:package.platform',
    sourceDirectory: 'platform',
    violationCount: 33,
  }),
] as const satisfies readonly ProductSurfaceGrammarBaselineEntry[]);
