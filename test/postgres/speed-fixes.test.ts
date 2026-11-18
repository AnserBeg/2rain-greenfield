import assert from 'node:assert/strict';
import test from 'node:test';

import { fulfillmentTable } from '../../packages/postgres-provider/src/fulfillment.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// SPEED-1 fix read, through the composed application: a denial is committed
// by the real recorder before the page is answered, on its own connections,
// so the page still reads one snapshot, and a failed denial fails the page.
// A task's steps (POSTs) read live: a grant revoked between a step's two
// reads of its record is refused and recorded at the second (the memo read's
// finding), and a Confirm under a policy change finishes.

const ns = 'northstar.app';
type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];
interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly invoice: { number: string; recordId: string };
  readonly location: string;
}

function pageUrl(
  fixture: Fixture,
  surface: string,
  scopeQuery: string,
  parameters: Record<string, string>,
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  target.searchParams.set(
    `${ns}:parameter.${scopeQuery}_legal_entity_scope`,
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
          body: new URLSearchParams(form).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          redirect: 'manual',
        }
      : { redirect: 'manual' },
  );
  return {
    html: await response.text(),
    status: response.status,
    work: parseServerTiming(response.headers.get('server-timing')),
  };
}

const hidden = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]+)"`, 'u').exec(html)?.[1] ?? null;

test(
  'SPEED-1 fix read: denials committed by the real recorder before the answer, one snapshot kept; a task step reads live, its second read refused and recorded',
  { timeout: 900_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'order_pages',
      )) as unknown as Scenario;
      const denials = async () =>
        Number(
          (
            await fixture.pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM platform.trust_action_invocations
                WHERE outcome = 'DENIED'`,
            )
          ).rows[0]!.n,
        );

      // The invoice names its order; without order read the reference is
      // withheld and the denial is evidence, committed before the answer.
      const invoicePage = pageUrl(
        fixture,
        'customer_invoice_detail',
        'customer_invoice_get',
        { record: scenario.invoice.recordId },
      );
      await serve(invoicePage);
      await fixture.measure('deny', undefined, undefined, 'sales_order_read');
      try {
        const before = await denials();
        const withheld = await serve(invoicePage);
        assert.equal(withheld.status, 200);
        assert.ok(withheld.html.includes(scenario.invoice.number));
        const recorded = (await denials()) - before;
        assert.ok(recorded >= 1, 'the denial is recorded before the answer');
        // One snapshot for the reads, the live epoch check, and one
        // transaction per denial on the evidence connections: no reopen.
        assert.equal(withheld.work?.transactions, 2 + recorded);

        // A queue the person cannot open (To ship, without order read) is
        // neither shown nor counted, on any page or on Today's own tiles, and
        // asking writes no denial: eligibility is checked without one.
        const quiet = await denials();
        const orderPage = await serve(
          pageUrl(
            fixture,
            'purchase_order_detail',
            'commercial_purchase_order_get',
            { record: scenario.truck.recordId },
          ),
        );
        assert.equal(orderPage.status, 200);
        assert.match(
          orderPage.html,
          /today_receive"[^>]*>[^]*?<span>To receive<\/span><span class="queue-count">\d+<\/span>/u,
        );
        assert.doesNotMatch(orderPage.html, /today_ship"/u);
        const today = await fetch(`${fixture.app.baseUrl}/`);
        const todayHtml = await today.text();
        assert.equal(today.status, 200);
        assert.match(todayHtml, /data-launcher-tile="[^"]*today_receive"/u);
        assert.doesNotMatch(todayHtml, /today_ship"/u);
        assert.equal(await denials(), quiet, 'no queue writes a denial');

        // A denial that cannot be recorded fails the page.
        await fixture.pool.query(
          `CREATE FUNCTION public.speed_refuse_denial() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN
               RAISE EXCEPTION 'denial evidence refused'; END $$;
           CREATE TRIGGER speed_refuse_denial
             BEFORE INSERT ON platform.trust_action_invocations
             FOR EACH ROW WHEN (NEW.outcome = 'DENIED')
             EXECUTE FUNCTION public.speed_refuse_denial()`,
        );
        try {
          const failed = await serve(invoicePage);
          assert.notEqual(failed.status, 200);
          assert.ok(!failed.html.includes(scenario.invoice.number));
        } finally {
          await fixture.pool.query(
            `DROP TRIGGER speed_refuse_denial ON platform.trust_action_invocations;
             DROP FUNCTION public.speed_refuse_denial()`,
          );
        }
      } finally {
        await fixture.measure(
          'allow',
          undefined,
          undefined,
          'sales_order_read',
        );
      }

      const target = await governedStorageTarget();
      const receipt = target.entities.find(
        (entity) => entity.entityId === `${ns}:entity.goods_receipt`,
      )!;
      const truckPage = pageUrl(
        fixture,
        'purchase_order_detail',
        'commercial_purchase_order_get',
        { record: scenario.truck.recordId },
      );
      const action = `${ns}:action.receive_lines_known`;
      const input = (local: string) => `${ns}:input.${local}`;
      const [first] = scenario.truck.lines as [string];

      // A task's steps read live, never in a GET's snapshot (ADR-0071): a
      // grant revoked between the step's first read of its record (to open
      // the task) and the second (to show it) is refused at the second, and
      // the refusal is recorded -- nothing of the record is shown.
      const orderGet = `${ns}:query.commercial_purchase_order_get`;
      const gateway = fixture.app.runtime.queryGateway;
      const invoke = gateway.invoke.bind(gateway);
      let armed = false;
      gateway.invoke = async (view, request, context) => {
        const result = await invoke(view, request, context);
        if (
          armed &&
          (request as { queryId?: unknown } | null)?.queryId === orderGet
        ) {
          armed = false;
          await fixture.measure(
            'deny',
            undefined,
            undefined,
            'purchase_order_read',
          );
        }
        return result;
      };
      try {
        const before = await denials();
        armed = true;
        const refused = await serve(truckPage, { compositionAction: action });
        assert.equal(armed, false, 'the order was read to open the task');
        assert.notEqual(refused.status, 200, refused.html.slice(0, 600));
        assert.ok(!refused.html.includes(scenario.truck.number));
        assert.ok(
          (await denials()) > before,
          "the step's second read is refused and recorded",
        );
      } finally {
        gateway.invoke = invoke;
        await fixture.measure(
          'allow',
          undefined,
          undefined,
          'purchase_order_read',
        );
      }

      // A Confirm whose receipt commits together with a policy change
      // finishes: each of its decisions was live, so nothing is discarded,
      // and it commits one receipt.
      const opened = await serve(truckPage, { compositionAction: action });
      const token = hidden(opened.html, 'taskToken');
      assert.ok(token, 'the task opens');
      const review = await serve(truckPage, {
        compositionAction: action,
        taskStage: 'prepare',
        taskToken: token,
        [input('receive_lines_location')]: scenario.location,
        [input('receive_lines_currency')]: 'CAD',
        [input('receive_lines_packing_slip')]: 'PS-RECOVER',
        [input('receive_lines_notes')]: '',
        [`${input('receive_lines_quantity')}@${first}`]: '1',
        [`${input('receive_lines_cost')}@${first}`]: '2.40',
      });
      const prepared = hidden(review.html, 'preparedId');
      assert.ok(prepared, 'the task reviews');
      const receipts = async () =>
        Number(
          (
            await fixture.pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${fulfillmentTable(receipt)}
                WHERE archived_at IS NULL`,
            )
          ).rows[0]!.n,
        );
      const before = await receipts();
      await fixture.pool.query(
        `CREATE FUNCTION public.speed_bump_policy() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
             UPDATE platform.current_policy_roles SET role_key = role_key
              WHERE tenant_id = NEW.tenant_id;
             RETURN NEW; END $$;
         CREATE TRIGGER speed_bump_policy AFTER INSERT ON ${fulfillmentTable(receipt)}
           FOR EACH ROW EXECUTE FUNCTION public.speed_bump_policy()`,
      );
      let confirmed: Awaited<ReturnType<typeof serve>>;
      try {
        confirmed = await serve(truckPage, {
          compositionAction: action,
          preparedId: prepared,
          taskStage: 'confirm',
          taskToken: token,
        });
      } finally {
        await fixture.pool.query(
          `DROP TRIGGER speed_bump_policy ON ${fulfillmentTable(receipt)};
           DROP FUNCTION public.speed_bump_policy()`,
        );
      }
      assert.equal(confirmed.status, 200, confirmed.html.slice(0, 600));
      assert.match(confirmed.html, /Receive: done/u);
      assert.equal(await receipts(), before + 1);
    });
  },
);
