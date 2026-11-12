/**
 * Local preview of the purchasing workspace — no database required.
 *
 * Serves the real SurfaceRuntime and the real compiled release over the
 * in-memory fixture in `purchasing-fixture.ts`, seeded with a small book of
 * orders. Data lives in memory: anything you create or release is gone when
 * the process stops, and receipts cannot be posted (see the fixture's header).
 *
 *   node --import tsx apps/web/test/purchasing-preview.ts
 *
 * Set PORT to listen somewhere other than 4190.
 */
import { createSurfaceRuntimeServer } from '../src/app-server.js';
import {
  createPurchasingFixture,
  seedPurchasing,
} from './purchasing-fixture.js';

const port = Number.parseInt(process.env.PORT ?? '4190', 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}

const fixture = createPurchasingFixture();
const seeded = seedPurchasing(fixture.executor, new Date());
const server = createSurfaceRuntimeServer(fixture.entry, fixture.gateways);

server.listen(port, '127.0.0.1', () => {
  const page = (
    surface: string,
    parameters?: Readonly<Record<string, string>>,
  ): string =>
    `http://127.0.0.1:${String(port)}${fixture.url(surface, parameters)}`;
  const order = (recordId: string): string =>
    page('purchase_order_detail', { record: recordId });
  process.stdout.write(
    [
      '',
      'Purchasing preview is running (in-memory data). Ctrl+C stops it.',
      '',
      `  Purchase order list      ${page('purchase_order_list')}`,
      `  New purchase order       ${page('purchase_order_form')}`,
      `  New order line           ${page('purchase_order_line_form')}`,
      '',
      `  Draft order   PO-2041    ${order(seeded.draftOrderId)}`,
      `  Empty draft   PO-2042    ${order(seeded.emptyDraftOrderId)}`,
      `  Released      PO-2038    ${order(seeded.releasedOrderId)}`,
      `  Overdue       PO-2031    ${order(seeded.overdueOrderId)}`,
      `  Closed        PO-2017    ${order(seeded.closedOrderId)}`,
      `  Cancelled     PO-2009    ${order(seeded.cancelledOrderId)}`,
      '',
    ].join('\n'),
  );
});

function stop(): void {
  server.close(() => process.exit(0));
  // Open keep-alive connections would otherwise hold the process open.
  server.closeAllConnections();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
