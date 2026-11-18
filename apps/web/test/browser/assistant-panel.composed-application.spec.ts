import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  lastToolResult,
  scriptedModel,
  type ConversationEntry,
} from '../../../../packages/operations-agent/src/index.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

/** The nth record id the first `erp_query` returned in the conversation. */
function queriedRecord(
  conversation: readonly ConversationEntry[],
  index = 0,
): string {
  for (const entry of conversation)
    if (entry.role === 'tool')
      for (const result of entry.results) {
        const content = JSON.parse(result.content) as {
          records?: { recordId: string }[];
        };
        if (content.records?.[index]) return content.records[index].recordId;
      }
  throw new Error('no record was queried');
}
const firstQueriedRecord = (conversation: readonly ConversationEntry[]) =>
  queriedRecord(conversation);

const archivePlan =
  (index: number) => (conversation: readonly ConversationEntry[]) => ({
    toolCalls: [
      {
        name: 'erp_plan',
        input: {
          intents: [
            {
              operationId: 'party_archive',
              target: queriedRecord(conversation, index),
            },
          ],
        },
      },
    ],
  });

/**
 * The assistant panel (AGENT-3 slices 2 and 3) with the scripted model only:
 * no key and no provider in CI. A read answers with a plain table. A
 * reversible in-app write runs at once and shows "Did: ..." with Undo and a
 * link to the record. A write that needs a yes shows its plan and runs only
 * after "Yes, do it". Undo takes the latest change back, verified.
 */
test('the assistant panel answers, acts then offers Undo, and asks before a consequential write', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const model = scriptedModel([
    // Turn 1: a read.
    () => ({
      toolCalls: [
        {
          name: 'erp_query',
          input: { queryId: 'party_list', arguments: {} },
        },
      ],
    }),
    () => ({
      text: 'Here is what I found:\n\n| Customer | Number |\n|---|---|\n| Lethbridge Millwork | P-2016 |',
    }),
    // Turn 2: a reversible create runs at once (no yes asked).
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
    // Turn 3: archiving needs the person's yes.
    (conversation) => ({
      toolCalls: [
        {
          name: 'erp_plan',
          input: {
            intents: [
              {
                operationId: 'party_archive',
                target: firstQueriedRecord(conversation),
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
            executionIdempotencyKey: 'panel-browser-2',
          },
        },
      ],
    }),
    () => ({ text: 'Archived.' }),
    // Turn 4 (X2): a typed "Okay, don't ship it" declines the plan; the
    // words go to the assistant as the next request.
    archivePlan(1),
    () => ({ text: 'Understood, nothing archived.' }),
    () => ({ text: 'Noted: nothing will be shipped.' }),
    // Turn 6 (X3): a card left by Stop goes dead.
    archivePlan(2),
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
        const say = async (text: string) => {
          await panel.locator('textarea').fill(text);
          await panel.locator('button[type=submit]').click();
        };
        const reply = (index: number) =>
          panel.locator('[data-assistant-reply]').nth(index);

        await say('Find our customers');
        await expect(reply(0).locator('table td').first()).toHaveText(
          'Lethbridge Millwork',
        );
        await expect(reply(0)).toContainText('USD 0.00 used');
        await expect(panel.locator('[data-assistant-status]')).toBeHidden();

        await say('Add customer P-7701, Panel Test Customer');
        await expect(reply(1)).toContainText('Done: I created customer');
        await expect(panel.locator('[data-assistant-plan]')).toHaveCount(0);
        const did = reply(1).locator('[data-assistant-did]');
        await expect(did).toContainText('Did: created party P-7701');
        const link = reply(1).locator('a', { hasText: 'Changed: P-7701' });
        const href = await link.getAttribute('href');
        expect(href).toContain('record=');

        // The link opens the record the assistant made, on its own page.
        const opened = await page.context().newPage();
        await opened.goto(`${application.baseUrl}${href!}`);
        await expect(opened.locator('main')).toContainText(
          'Panel Test Customer',
        );

        // Undo the create (the latest change made at once) before anything
        // else runs (X8: a later write could depend on it), verified: the
        // record it made is archived, so its page no longer finds it.
        await did.locator('[data-assistant-undo]').click();
        await expect(did).toContainText(
          'Undid: created party P-7701 (checked)',
        );
        await opened.reload();
        await expect(opened.locator('main')).toContainText('Record not found');

        await say('Archive the first customer');
        const plan = panel.locator('[data-assistant-plan]');
        await expect(plan).toContainText('archives one party record');
        await expect(plan).toContainText(
          "Because the operation is declared to need the person's confirmation.",
        );
        await expect(panel.locator('[data-assistant-status]')).toBeVisible();
        // LOOK-1: the panel in the Ledger look, wide and phone, light and
        // dark -- a reply's table, a change with Undo, a plan awaiting yes.
        await shootAssistant(page);
        await plan.locator('[data-assistant-yes]').click();
        await expect(reply(2)).toContainText('Archived.');

        // X2: words that are not a whole yes decline and are sent on.
        await say('Archive the second customer');
        const second = panel.locator('[data-assistant-plan]').nth(1);
        await expect(second.locator('[data-assistant-yes]')).toBeEnabled();
        await say("Okay, don't ship it");
        await expect(second).toContainText('Not done.');
        await expect(reply(4)).toContainText('Noted: nothing will be shipped.');

        // X3: Stop while a card waits leaves that card dead, so it can never
        // answer for a later plan.
        await say('Archive the third customer');
        const third = panel.locator('[data-assistant-plan]').nth(2);
        await expect(third.locator('[data-assistant-yes]')).toBeEnabled();
        await panel.locator('[data-assistant-stop]').click();
        await expect(third.locator('[data-assistant-yes]')).toBeDisabled();
        await expect(third.locator('[data-assistant-no]')).toBeDisabled();
      } finally {
        await application.close();
      }
    },
  );
});

/**
 * The panel's evidence for LOOK-1, written where the look proof writes its
 * screenshots when LOOK_EVIDENCE_OUT names a directory; otherwise nothing.
 */
async function shootAssistant(page: Page): Promise<void> {
  const out = process.env.LOOK_EVIDENCE_OUT;
  if (!out) return;
  mkdirSync(resolve(out), { recursive: true });
  const original = page.viewportSize();
  for (const scheme of ['light', 'dark'] as const)
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `${resolve(out)}/app-assistant-${String(width)}-${scheme}.png`,
      });
    }
  await page.emulateMedia({ colorScheme: 'light' });
  if (original) await page.setViewportSize(original);
}
