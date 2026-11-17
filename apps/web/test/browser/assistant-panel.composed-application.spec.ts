import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  lastToolResult,
  scriptedModel,
} from '../../../../packages/operations-agent/src/index.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

/**
 * The assistant panel (AGENT-3 slice 2) with the scripted model only: no key
 * and no provider in CI. A read answers with a plain table; a write shows its
 * plan, runs only after "Yes, do it", and links the record it made, which
 * opens on its own page.
 */
test('the assistant panel answers, asks before a write, and links what it changed', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const model = scriptedModel([
    // 1: a read.
    () => ({
      toolCalls: [
        {
          name: 'erp_query',
          input: { queryId: 'party_list', arguments: { search: 'Lethbridge' } },
        },
      ],
    }),
    () => ({
      text: 'Here is what I found:\n\n| Customer | Number |\n|---|---|\n| Lethbridge Millwork | P-2016 |',
    }),
    // 2: a write, planned, approved in the panel, executed and verified.
    () => ({
      toolCalls: [
        {
          name: 'erp_plan',
          input: {
            intents: [
              {
                operationId: 'party_create',
                values: { number: 'P-7701', name: 'Panel Test Customer' },
              },
            ],
          },
        },
      ],
    }),
    (conversation) => ({
      toolCalls: [
        {
          name: 'erp_execute',
          input: {
            planId: String(lastToolResult(conversation).planId),
            executionIdempotencyKey: 'panel-browser-1',
          },
        },
      ],
    }),
    (conversation) => ({
      toolCalls: [
        {
          name: 'erp_verify',
          input: {
            operationSessionId: String(
              lastToolResult(conversation).operationSessionId,
            ),
          },
        },
      ],
    }),
    () => ({ text: 'Done: I created customer **P-7701**.' }),
  ]);
  await withEphemeralPostgres(
    'assistant-panel-browser',
    async ({ connection }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        tenantSlug: 'assistant-panel-browser',
        assistantModel: () => Promise.resolve(model),
      });
      try {
        page.setDefaultTimeout(20_000);
        await page.goto(application.baseUrl);
        const panel = page.locator('[data-assistant-panel]');
        await expect(panel).toBeHidden();
        await page.locator('[data-assistant-toggle]').click();
        await expect(panel).toBeVisible();

        await panel.locator('textarea').fill('Find Lethbridge Millwork');
        await panel.locator('button[type=submit]').click();
        const firstReply = panel.locator('[data-assistant-reply]').first();
        await expect(firstReply.locator('table td').first()).toHaveText(
          'Lethbridge Millwork',
        );
        await expect(firstReply).toContainText('USD 0.00 used');
        await expect(panel.locator('[data-assistant-status]')).toBeHidden();

        await panel
          .locator('textarea')
          .fill('Add customer P-7701, Panel Test Customer');
        await panel.locator('button[type=submit]').click();
        const plan = panel.locator('[data-assistant-plan]');
        await expect(plan).toContainText('creates one party record');
        // Nothing runs before the yes: the step label waits on the plan.
        await expect(panel.locator('[data-assistant-status]')).toBeVisible();
        await plan.locator('[data-assistant-yes]').click();
        const secondReply = panel.locator('[data-assistant-reply]').nth(1);
        await expect(secondReply).toContainText('Done: I created customer');
        const link = secondReply.locator('a', { hasText: 'Changed: P-7701' });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.locator('main')).toContainText('Panel Test Customer');
      } finally {
        await application.close();
      }
    },
  );
});
