import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

import {
  DatabaseStatistics,
  invoiceAndPay,
  LoopScorecard,
  walkToShipped,
  writeScorecard,
} from './loop-scorecard.js';

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * LOOP-1's scorecard: an office person walks the purchase order -> inventory
 * -> sales order loop in the composed application on a fresh distributor
 * seed, and every click, page load, typed field and raw code is counted per
 * step. The table is printed (LOOP_SCORECARD ...) and, when
 * LOOP_SCORECARD_OUT names a path, written there.
 */
test('LOOP-1 scorecard: purchase order to stock to a shipped, invoiced and paid sales order', async ({
  page,
}) => {
  test.setTimeout(1_200_000);
  await withEphemeralPostgres(
    'loop-scorecard-browser',
    async ({ connection, pool }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        seedProfile: 'distributor',
        tenantSlug: 'loop-scorecard-browser',
      });
      // Each request's database work comes from the server's Server-Timing
      // header; per step, the database's own count is read beside it.
      const statisticsClient = await pool.connect();
      const card = new LoopScorecard(page, {
        statistics: new DatabaseStatistics(statisticsClient),
      });
      try {
        await walkToShipped(card, application.baseUrl);
        const receipt = card.steps.find(
          ({ name }) => name === LOOP_STEPS.receive,
        );
        const shipment = card.steps.find(
          ({ name }) => name === LOOP_STEPS.ship,
        );
        expect(receipt?.clicks).toBe(2);
        expect(receipt?.loads).toBeLessThanOrEqual(2);
        expect(shipment?.clicks).toBeLessThanOrEqual(4);
        expect(shipment?.loads).toBeLessThanOrEqual(2);
        // Slice 2: once invoiced, the order offers the payment as its next
        // action (until then it was recorded on the invoice's page).
        expect(
          await invoiceAndPay(card),
          "payment recorded as the order's next action",
        ).toBe(true);
        // The memo slice: once the home page has read the release, no request
        // of the loop parses the operation catalog or surface manifest again.
        expect(
          card.requests
            .filter((request) => request.step !== '(start)')
            .filter(
              (request) =>
                request.parses.operationCatalog +
                  request.parses.surfaceManifest >
                0,
            )
            .map((request) => request.page),
        ).toEqual([]);
      } finally {
        card.abandon('not reached');
        const table = writeScorecard(
          card,
          process.env.LOOP_SCORECARD_OUT,
          `Loop scorecard — ${new Date().toISOString().slice(0, 10)}`,
        );
        console.log(`LOOP_SCORECARD\n${table}`);
        statisticsClient.release();
        await application.close();
      }
    },
  );
});
