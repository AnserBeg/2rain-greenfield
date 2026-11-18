import assert from 'node:assert/strict';
import test from 'node:test';

import { fulfillmentTable } from '../../packages/postgres-provider/src/fulfillment.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// SPEED-1 fix read, through the composed application: a denial is committed
// by the real recorder before the page is answered, on its own connections,
// so the page still reads one snapshot, and a failed denial fails the page;
// a Confirm that committed while the policy changed offers the session's own
// retry, which finishes with the same request keys.

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
  'SPEED-1 fix read: denials committed by the real recorder before the answer, one snapshot kept; a Confirm under a policy change offers its own retry',
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

      // A Confirm whose receipt commits together with a policy change: the
      // step is answered with the session's own retry, nothing of the record,
      // and the retry finishes with the same request keys -- one receipt.
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
      await fixture.pool.query(
        `CREATE FUNCTION public.speed_bump_policy() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
             UPDATE platform.current_policy_roles SET role_key = role_key
              WHERE tenant_id = NEW.tenant_id;
             RETURN NEW; END $$;
         CREATE TRIGGER speed_bump_policy AFTER INSERT ON ${fulfillmentTable(receipt)}
           FOR EACH ROW EXECUTE FUNCTION public.speed_bump_policy()`,
      );
      let notice: Awaited<ReturnType<typeof serve>>;
      try {
        notice = await serve(truckPage, {
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
      assert.equal(notice.status, 409, notice.html.slice(0, 600));
      assert.match(notice.html, /data-task-recovery/u);
      assert.equal(hidden(notice.html, 'taskToken'), token);
      assert.ok(!notice.html.includes(scenario.truck.number));
      const receipts = async () =>
        Number(
          (
            await fixture.pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${fulfillmentTable(receipt)}
                WHERE archived_at IS NULL`,
            )
          ).rows[0]!.n,
        );
      const committed = await receipts();
      const retried = await serve(truckPage, {
        compositionAction: action,
        taskStage: 'retry',
        taskToken: token,
      });
      assert.match(retried.html, /Receive: done/u);
      assert.equal(await receipts(), committed, 'the retry reuses its keys');
    });
  },
);
