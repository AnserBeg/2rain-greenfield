import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseServerTiming,
  type RequestWorkCounts,
} from '../../packages/postgres-provider/src/request-work-meter.js';
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

const ns = 'northstar.app';
type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];
interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly delivered: { number: string; recordId: string; lines: string[] };
  readonly short: { number: string; recordId: string; lines: string[] };
  readonly location: string;
}
interface Served {
  readonly counts: RequestWorkCounts & { readonly milliseconds: number };
  readonly html: string;
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
  const counts = parseServerTiming(response.headers.get('server-timing'));
  assert.ok(counts, `${target} carried no Server-Timing work counts`);
  return { counts, html, status: response.status } satisfies Served;
}

function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]+)"`, 'u').exec(
    html,
  )?.[1];
  assert.ok(value, `no ${name}`);
  return value;
}

test(
  'SPEED-1 page budget: each page and task step stays within its database work ceilings',
  { timeout: 900_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'order_pages',
      )) as unknown as Scenario;
      const measured = new Map<PageBudgetName, Served['counts']>();

      /** Three loads; the third, warm, is the measured one. */
      const page = async (
        name: PageBudgetName,
        target: string,
        rendered: (html: string) => void,
      ) => {
        let last: Served | undefined;
        for (let load = 0; load < 3; load += 1) {
          last = await serve(target);
          assert.equal(last.status, 200, `${name}: ${last.html.slice(0, 600)}`);
          rendered(last.html);
        }
        measured.set(name, last!.counts);
        return last!;
      };
      const contains =
        (...texts: string[]) =>
        (html: string) => {
          for (const text of texts) assert.ok(html.includes(text), text);
        };

      await page(
        'home',
        `${fixture.app.baseUrl}/`,
        contains('Purchase orders'),
      );
      const list = await page(
        'purchase order list',
        pageUrl(
          fixture,
          'purchase_order_list',
          'commercial_purchase_order_list',
        ),
        contains(scenario.truck.number, scenario.delivered.number),
      );
      await page(
        'purchase order detail',
        pageUrl(
          fixture,
          'purchase_order_detail',
          'commercial_purchase_order_get',
          { record: scenario.delivered.recordId },
        ),
        contains(scenario.delivered.number, ...scenario.delivered.lines),
      );
      const newHref = /<a class="primary-action" href="([^"]+)">New<\/a>/u.exec(
        list.html,
      )?.[1];
      assert.ok(newHref, 'the purchase order list offers New');
      await page(
        'new purchase order',
        new URL(newHref.replaceAll('&amp;', '&'), fixture.app.baseUrl).href,
        contains('<form'),
      );
      await page(
        'stock by item',
        pageUrl(fixture, 'item_stock_list', 'item_stock_list'),
        contains('Field notebook', 'data-list-total='),
      );
      await page(
        'sales order detail',
        pageUrl(fixture, 'sales_order_detail', 'commercial_order_get', {
          record: scenario.short.recordId,
        }),
        contains(scenario.short.number, ...scenario.short.lines),
      );

      // One task step on a warm detail page: open, Review, Confirm.
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
      assert.equal(opened.status, 200, opened.html.slice(0, 2000));
      measured.set('task: open', opened.counts);
      const token = hidden(opened.html, 'taskToken');
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
      assert.match(review.html, /name="preparedId"/u, review.html.slice(-4000));
      measured.set('task: review', review.counts);
      const done = await serve(truckPage, {
        taskToken: token,
        compositionAction: action,
        taskStage: 'confirm',
        preparedId: hidden(review.html, 'preparedId'),
      });
      assert.match(done.html, /Receive lines with actual cost: done/u);
      measured.set('task: confirm', done.counts);

      const keys = [
        'transactions',
        'statements',
        'authorization',
        'repeats',
      ] as const;
      const table = [
        `| page | ${keys.join(' | ')} | ms |`,
        `| --- | ${keys.map(() => '---').join(' | ')} | --- |`,
        ...PAGE_BUDGET_NAMES.map((name) => {
          const counts = measured.get(name)!;
          return `| ${name} | ${keys
            .map((key) => {
              const ceiling = PAGE_BUDGETS[name][key];
              return `${String(counts[key])} / ${ceiling === null ? '—' : String(ceiling)}`;
            })
            .join(' | ')} | ${counts.milliseconds.toFixed(0)} |`;
        }),
      ].join('\n');
      console.log(`PAGE_BUDGET (measured / ceiling)\n${table}`);

      const over: string[] = [];
      for (const name of PAGE_BUDGET_NAMES) {
        const counts = measured.get(name);
        assert.ok(counts, `${name} was not measured`);
        for (const key of keys) {
          const ceiling = PAGE_BUDGETS[name][key];
          if (ceiling === null)
            over.push(`${name}: ${key} ${String(counts[key])} is not pinned`);
          else if (counts[key] > ceiling)
            over.push(
              `${name}: ${key} ${String(counts[key])} exceeds ${String(ceiling)}`,
            );
        }
      }
      assert.deepEqual(over, [], over.join('\n'));
    });
  },
);
