/**
 * SPEED-1 page budgets: the most database work each page may cause, counted
 * by the request work meter (`packages/postgres-provider/src/request-work-meter.ts`)
 * on the order-pages fixture, warm (the third load of a page; a task step's
 * one request). `test/performance/page-budget.test.ts` fails when a page
 * exceeds any ceiling.
 *
 * A ceiling only ever moves down. Lower it in the commit that earns it; never
 * raise it to admit a regression. `null` is not measured yet: the test prints
 * the measured value and fails until it is pinned.
 *
 * Targets at the end of SPEED-1: PO detail and PO list ≤ 3 transactions,
 * ≤ 40 statements, 0 repeats; a task step the same for its read, plus one
 * write transaction that re-authorizes.
 */
export interface PageBudget {
  readonly authorization: number | null;
  readonly repeats: number | null;
  readonly statements: number | null;
  readonly transactions: number | null;
}

export const PAGE_BUDGET_NAMES = [
  'home',
  'purchase order list',
  'purchase order detail',
  'new purchase order',
  'stock by item',
  'sales order detail',
  'task: open',
  'task: review',
  'task: confirm',
] as const;

export type PageBudgetName = (typeof PAGE_BUDGET_NAMES)[number];

const unpinned: PageBudget = Object.freeze({
  authorization: null,
  repeats: null,
  statements: null,
  transactions: null,
});

export const PAGE_BUDGETS: Readonly<Record<PageBudgetName, PageBudget>> =
  Object.freeze({
    home: unpinned,
    'purchase order list': unpinned,
    'purchase order detail': unpinned,
    'new purchase order': unpinned,
    'stock by item': unpinned,
    'sales order detail': unpinned,
    'task: open': unpinned,
    'task: review': unpinned,
    'task: confirm': unpinned,
  });
