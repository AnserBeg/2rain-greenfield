import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIVING_CAPABILITY_ID } from '../../packages/postgres-provider/src/goods-receipt.js';
import { fulfillmentTable } from '../../packages/postgres-provider/src/fulfillment.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// SPEED-1 fix read, through the composed application: a denial is committed
// by the real recorder before the page is answered, on its own connections,
// so the page still reads one snapshot, and a failed denial fails the page.
// A task step reads in one snapshot (ADR-0071, amended): a grant revoked
// between its two reads of the record discards the response; a Confirm that
// committed while the policy changed offers the session's own retry, which
// finishes with the same request keys.

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
  'SPEED-1 fix read: denials committed by the real recorder before the answer, one snapshot kept; a task step under a revocation is discarded; a Confirm under a policy change offers its own retry',
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

      // A task's steps read in one snapshot (ADR-0071, amended), so a grant
      // revoked between the step's first read of its record (to open the
      // task) and the second (to show it) is answered from the snapshot's
      // grants -- and the end-of-request epoch check discards the response:
      // the step is sent again by GET, and nothing of the order is shown.
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
        armed = true;
        const discarded = await serve(truckPage, {
          compositionAction: action,
        });
        assert.equal(armed, false, 'the order was read to open the task');
        assert.equal(discarded.status, 303, discarded.html.slice(0, 600));
        assert.equal(discarded.html, '');
        assert.ok(!discarded.html.includes(scenario.truck.number));
      } finally {
        gateway.invoke = invoke;
        await fixture.measure(
          'allow',
          undefined,
          undefined,
          'purchase_order_read',
        );
      }

      // A Confirm whose receipt commits together with a policy change: the
      // step is answered with the session's own retry, nothing of the record,
      // and the retry finishes with the same request keys -- one receipt.
      const prepareReceipt = async (packingSlip: string) => {
        const opened = await serve(truckPage, { compositionAction: action });
        const token = hidden(opened.html, 'taskToken');
        assert.ok(token, 'the task opens');
        const review = await serve(truckPage, {
          compositionAction: action,
          taskStage: 'prepare',
          taskToken: token,
          [input('receive_lines_location')]: scenario.location,
          [input('receive_lines_currency')]: 'CAD',
          [input('receive_lines_packing_slip')]: packingSlip,
          [input('receive_lines_notes')]: '',
          [`${input('receive_lines_quantity')}@${first}`]: '1',
          [`${input('receive_lines_cost')}@${first}`]: '2.40',
        });
        const prepared = hidden(review.html, 'preparedId');
        assert.ok(prepared, 'the task reviews');
        return { token, prepared };
      };
      const { token, prepared } = await prepareReceipt('PS-RECOVER');
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

      // Revoke read permission with the posting commit, after preflight. A
      // sequence witnesses the specific read-back denial even after rollback.
      const next = await prepareReceipt('PS-EVIDENCE');
      await fixture.pool.query(`
        CREATE FUNCTION public.revoke_receipt_read() RETURNS trigger
          LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
            UPDATE platform.current_policy_permission_grants SET revoked_at = now()
             WHERE tenant_id = NEW.tenant_id AND environment_id = NEW.environment_id
               AND permission_id = '${ns}:permission.goods_receipt_read' AND revoked_at IS NULL;
            RETURN NEW; END $$;
        CREATE TRIGGER revoke_receipt_read AFTER INSERT ON platform.semantic_operation_receipts
          FOR EACH ROW WHEN (NEW.action_id = '${RECEIVING_CAPABILITY_ID}')
          EXECUTE FUNCTION public.revoke_receipt_read();
        CREATE SEQUENCE public.receipt_denial_attempt;
        CREATE FUNCTION public.refuse_receipt_denial() RETURNS trigger
          LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
            PERFORM nextval('public.receipt_denial_attempt');
            RAISE EXCEPTION 'receipt denial evidence refused'; END $$;
        CREATE TRIGGER refuse_receipt_denial BEFORE INSERT ON platform.trust_action_invocations
          FOR EACH ROW WHEN (NEW.outcome = 'DENIED' AND NEW.action_id = '${ns}:query.goods_receipt_get')
          EXECUTE FUNCTION public.refuse_receipt_denial()`);
      const postCount = async () =>
        (
          await fixture.pool.query<{ count: number }>(
            'SELECT count(*)::int FROM platform.semantic_operation_receipts WHERE action_id = $1',
            [RECEIVING_CAPABILITY_ID],
          )
        ).rows[0]!.count;
      const before = await postCount();
      const failed = await serve(truckPage, {
        compositionAction: action,
        preparedId: next.prepared,
        taskStage: 'confirm',
        taskToken: next.token,
      });
      assert.equal(
        await postCount(),
        before + 1,
        'Confirm committed the posting',
      );
      assert.equal(
        (
          await fixture.pool.query(
            'SELECT is_called FROM public.receipt_denial_attempt',
          )
        ).rows[0]?.is_called,
        true,
        'the read-back denial write was attempted',
      );
      assert.equal(
        failed.status,
        500,
        'missing denial evidence must fail Confirm',
      );
      assert.doesNotMatch(failed.html, /data-task-recovery/u);
    });
  },
);
