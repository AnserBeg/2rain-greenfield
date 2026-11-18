import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseServerTiming,
  type RequestWorkCounts,
} from '../../packages/postgres-provider/src/request-work-meter.js';
import { catalogParseCount } from '../../packages/runtime/src/catalog-parse-count.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import {
  PAGE_BUDGET_NAMES,
  PAGE_BUDGETS,
  type PageBudgetName,
} from './page-budgets.js';

// SPEED-1 slice 1: every page in the budget file is served by the composed
// application on the order-pages fixture and its database work is read from
// the response's Server-Timing header. A page must render its real content
// to be measured: a cheap error page never passes a budget.
//
// Timing is not budgeted here (CI runners vary). The PO detail's wall and CPU
// time are measured the same way under tsx and compiled by
// `apps/api/src/measure-page.ts` (compiled: `corepack pnpm build`, then
// `node scripts/start-production.mjs dist/apps/api/src/measure-page.js`).
// 2026-11-17, one laptop: charter base 16.3 s wall / 12.4 s CPU per request;
// after SPEED-1 about 140-190 ms wall / 120-170 ms CPU, tsx and compiled alike.

const ns = 'northstar.app';
type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];
interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly delivered: { number: string; recordId: string; lines: string[] };
  readonly short: { number: string; recordId: string; lines: string[] };
  readonly location: string;
}
interface Served {
  readonly counts: { -readonly [K in keyof RequestWorkCounts]: number } & {
    milliseconds: number;
    operationCatalogParses: number;
    queryCatalogParses: number;
    surfaceBindingParses: number;
    surfaceManifestParses: number;
  };
  readonly html: string;
  readonly location: string | null;
  readonly status: number;
}

function pageUrl(
  fixture: Fixture,
  surface: string,
  scopeParameter: string,
  parameters: Record<string, string> = {},
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  target.searchParams.set(
    `${ns}:parameter.${scopeParameter}_legal_entity_scope`,
    fixture.scope,
  );
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}

async function serve(target: string, form?: Record<string, string>) {
  // The server runs in this process: its catalog parses are read around the
  // request (LOOP-1's counter; requests here are sequential).
  const parsedBefore = catalogParseCount();
  const response = await fetch(
    target,
    form
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
          redirect: 'manual',
        }
      : { redirect: 'manual' },
  );
  const html = await response.text();
  const parsedAfter = catalogParseCount();
  const work = parseServerTiming(response.headers.get('server-timing'));
  assert.ok(work, `${target} carried no Server-Timing work counts`);
  const counts = {
    ...work,
    operationCatalogParses:
      parsedAfter.operationCatalog - parsedBefore.operationCatalog,
    queryCatalogParses: parsedAfter.queryCatalog - parsedBefore.queryCatalog,
    surfaceBindingParses:
      parsedAfter.surfaceBinding - parsedBefore.surfaceBinding,
    surfaceManifestParses:
      parsedAfter.surfaceManifest - parsedBefore.surfaceManifest,
  };
  return {
    counts,
    html,
    location: response.headers.get('location'),
    status: response.status,
  } satisfies Served;
}

function hiddenValue(html: string, name: string): string | null {
  return (
    new RegExp(`name="${name}" value="([^"]+)"`, 'u').exec(html)?.[1] ?? null
  );
}

test(
  'SPEED-1 page budget: each page and task step stays within its database work ceilings',
  { timeout: 900_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'order_pages',
      )) as unknown as Scenario;
      const measured = new Map<PageBudgetName, Counts>();
      /** Load 2 of each page, beside the measured load 3: warm stability. */
      const second = new Map<PageBudgetName, Counts>();
      // Every problem is collected, so one CI run reports the whole table.
      const problems: string[] = [];

      /** Three loads; the third, warm, is the measured one. */
      const page = async (
        name: PageBudgetName,
        target: string,
        markers: readonly (string | RegExp)[],
      ): Promise<string | null> => {
        let html: string | null = null;
        for (let load = 1; load <= 3; load += 1) {
          const served = await serveFollowing(target);
          if (served.status !== 200) {
            problems.push(
              `${name}: status ${String(served.status)} ${served.html.slice(0, 300)}`,
            );
            return null;
          }
          // style-src 'self': a rendered page carries no inline style.
          if (/<style\b|\sstyle=/u.test(served.html))
            problems.push(`${name}: carries an inline style`);
          const missing = markers.filter((marker) =>
            typeof marker === 'string'
              ? !served.html.includes(marker)
              : !marker.test(served.html),
          );
          if (missing.length) {
            problems.push(`${name}: did not render ${missing.join(', ')}`);
            return null;
          }
          if (load === 2) second.set(name, served.counts);
          if (load === 3) measured.set(name, served.counts);
          html = served.html;
        }
        return html;
      };

      try {
        await page('home', `${fixture.app.baseUrl}/`, [
          /<nav[\s>]/u,
          'Purchase orders',
        ]);
        const list = await page(
          'purchase order list',
          pageUrl(
            fixture,
            'purchase_order_list',
            'commercial_purchase_order_list',
          ),
          [scenario.truck.number, scenario.delivered.number],
        );
        await page(
          'purchase order detail',
          pageUrl(
            fixture,
            'purchase_order_detail',
            'commercial_purchase_order_get',
            { record: scenario.delivered.recordId },
          ),
          [scenario.delivered.number, ...scenario.delivered.lines],
        );
        const newHref =
          list &&
          /<a class="(?:primary|secondary)-action" href="([^"]+)">New<\/a>/u.exec(
            list,
          )?.[1];
        if (newHref)
          await page(
            'new purchase order',
            new URL(newHref.replaceAll('&amp;', '&'), fixture.app.baseUrl).href,
            [/<h1>New /u],
          );
        else problems.push('new purchase order: the list offers no New');
        await page(
          'stock by item',
          pageUrl(fixture, 'item_stock_list', 'item_stock_list'),
          ['Field notebook', 'data-list-total='],
        );
        await page(
          'sales order detail',
          pageUrl(fixture, 'sales_order_detail', 'commercial_order_get', {
            record: scenario.short.recordId,
          }),
          [scenario.short.number, ...scenario.short.lines],
        );
        await taskStep(fixture, scenario, measured, problems);
      } finally {
        console.log(
          `PAGE_BUDGET (measured / ceiling; load 2 in brackets)\n${table(measured, second)}`,
        );
      }

      for (const name of PAGE_BUDGET_NAMES) {
        const counts = measured.get(name);
        if (!counts) {
          problems.push(`${name}: not measured`);
          continue;
        }
        for (const key of KEYS) {
          const ceiling = PAGE_BUDGETS[name][key];
          if (ceiling === null)
            problems.push(
              `${name}: ${key} ${String(counts[key])} is not pinned`,
            );
          else if (counts[key] > ceiling)
            problems.push(
              `${name}: ${key} ${String(counts[key])} exceeds ${String(ceiling)}`,
            );
        }
      }
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  },
);

const KEYS = [
  'transactions',
  'statements',
  'authorization',
  'repeats',
  'operationCatalogParses',
  'queryCatalogParses',
  'surfaceManifestParses',
  'surfaceBindingParses',
] as const;
type Counts = Served['counts'];

/** A page as a person reaches it: a workspace entry's redirect is part of it. */
async function serveFollowing(target: string): Promise<Served> {
  const first = await serve(target);
  if (first.status !== 303 || !first.location) return first;
  const landed = await serve(new URL(first.location, target).href);
  const counts = { ...landed.counts };
  for (const key of KEYS) counts[key] += first.counts[key];
  counts.milliseconds += first.counts.milliseconds;
  return { ...landed, counts };
}

/** One task step on a warm detail page: open, Review, Confirm. */
async function taskStep(
  fixture: Fixture,
  scenario: Scenario,
  measured: Map<PageBudgetName, Counts>,
  problems: string[],
): Promise<void> {
  const truckPage = pageUrl(
    fixture,
    'purchase_order_detail',
    'commercial_purchase_order_get',
    { record: scenario.truck.recordId },
  );
  await serve(truckPage);
  const action = `${ns}:action.receive_lines_known`;
  const input = (local: string) => `${ns}:input.${local}`;
  const [first] = scenario.truck.lines as [string];
  const opened = await serve(truckPage, { compositionAction: action });
  const token = hiddenValue(opened.html, 'taskToken');
  if (opened.status !== 200 || !token) {
    problems.push(`task: open: status ${String(opened.status)}, no task token`);
    return;
  }
  measured.set('task: open', opened.counts);
  const review = await serve(truckPage, {
    taskToken: token,
    compositionAction: action,
    taskStage: 'prepare',
    [input('receive_lines_location')]: scenario.location,
    [input('receive_lines_currency')]: 'CAD',
    [input('receive_lines_packing_slip')]: 'PS-BUDGET',
    [input('receive_lines_notes')]: '',
    [`${input('receive_lines_quantity')}@${first}`]: '5',
    [`${input('receive_lines_cost')}@${first}`]: '2.40',
  });
  const prepared = hiddenValue(review.html, 'preparedId');
  if (!prepared) {
    problems.push(`task: review: no prepared id ${review.html.slice(-600)}`);
    return;
  }
  measured.set('task: review', review.counts);
  const done = await serve(truckPage, {
    taskToken: token,
    compositionAction: action,
    taskStage: 'confirm',
    preparedId: prepared,
  });
  if (!/Receive lines with actual cost: done/u.test(done.html)) {
    problems.push(`task: confirm: not done ${done.html.slice(-600)}`);
    return;
  }
  measured.set('task: confirm', done.counts);
}

function table(
  measured: ReadonlyMap<PageBudgetName, Counts>,
  second: ReadonlyMap<PageBudgetName, Counts>,
): string {
  return [
    `| page | ${KEYS.join(' | ')} | ms |`,
    `| --- | ${KEYS.map(() => '---').join(' | ')} | --- |`,
    ...PAGE_BUDGET_NAMES.map((name) => {
      const counts = measured.get(name);
      if (!counts)
        return `| ${name} | ${KEYS.map(() => '—').join(' | ')} | — |`;
      const before = second.get(name);
      return `| ${name} | ${KEYS.map((key) => {
        const ceiling = PAGE_BUDGETS[name][key];
        const warm = before ? ` [${String(before[key])}]` : '';
        return `${String(counts[key])}${warm} / ${ceiling === null ? '—' : String(ceiling)}`;
      }).join(' | ')} | ${counts.milliseconds.toFixed(0)} |`;
    }),
  ].join('\n');
}
