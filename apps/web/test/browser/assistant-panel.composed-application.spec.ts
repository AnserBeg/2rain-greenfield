import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  lastToolResult,
  scriptedModel,
  type ConversationEntry,
  type ModelAdapter,
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
              {
                operationId: 'party_role_create',
                values: { kind: 'customer', status: 'active' },
                relations: { party: { fromStep: 1 } },
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
        // X16: no spend line under a reply; the foot shows spend only once
        // it is not zero (the scripted model costs nothing).
        await expect(reply(0)).not.toContainText('USD');
        await expect(panel.locator('[data-assistant-spend]')).toBeHidden();
        await expect(panel.locator('[data-assistant-status]')).toBeHidden();

        await say('Add customer P-7701, Panel Test Customer');
        await expect(reply(1)).toContainText('Done: I created customer');
        await expect(panel.locator('[data-assistant-plan]')).toHaveCount(0);
        const did = reply(1).locator('[data-assistant-did]');
        // X16: the record's role and name, never "party"; the Did row links
        // the record and there is no separate "Changed" line.
        await expect(did).toContainText(
          'Did: created customer Panel Test Customer.',
        );
        await expect(reply(1)).not.toContainText('Changed:');
        const link = did.locator('a', { hasText: 'Open' });
        const href = await link.getAttribute('href');
        expect(href).toContain('record=');

        // The link opens the record the assistant made, on its own page.
        const opened = await page.context().newPage();
        await opened.goto(`${application.baseUrl}${href!}`);
        await expect(opened.locator('main')).toContainText(
          'Panel Test Customer',
        );

        await link.click();
        await expect(panel).toBeVisible();
        await expect(reply(0).locator('table')).toContainText(
          'Lethbridge Millwork',
        );
        await expect(did.locator('[data-assistant-undo]')).toBeEnabled();

        // Undo the create (the latest change made at once) before anything
        // else runs (X8: a later write could depend on it), verified: the
        // record it made is archived, so its page no longer finds it.
        await did.locator('[data-assistant-undo]').click();
        await expect(did).toContainText(
          'Undid: created customer Panel Test Customer (checked)',
        );
        await opened.reload();
        await expect(opened.locator('main')).toContainText('Record not found');

        await say('Archive the first customer');
        const plan = panel.locator('[data-assistant-plan]');
        // X16: P-1001, the first party listed, holds no role in the demo
        // seed, so it is "this record", never "party" (a customer reads
        // "this customer": test/agent/business-map.test.ts X16).
        await expect(plan).toContainText(
          'Archives this record (it leaves the lists; nothing is deleted)',
        );
        await expect(plan).not.toContainText(/party/iu);
        // X9: the yes names the company the page proved.
        await expect(plan.locator('p.assistant-muted').first()).toHaveText(
          /^In \S.*\.$/u,
        );
        await expect(plan).toContainText('This change needs your OK.');
        await expect(panel.locator('[data-assistant-status]')).toBeVisible();
        // LOOK-1: the panel in the Ledger look, wide and phone, light and
        // dark -- a reply's table, a change with Undo, a plan awaiting yes.
        await page.reload();
        await expect(plan.locator('[data-assistant-yes]')).toBeEnabled();
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

test('a resized assistant follows the person onto the new PO and finishes a detached reply', async ({
  page,
}) => {
  test.setTimeout(300_000);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script = scriptedModel([
    () => ({ text: 'First answer.' }),
    () => ({ text: 'Slow reply finished.' }),
  ]);
  let calls = 0;
  const model: ModelAdapter = {
    modelId: script.modelId,
    async next(request) {
      if (++calls === 2) {
        request.onText?.('Working on the slow reply');
        await hold;
      }
      return script.next(request);
    },
  };
  await withEphemeralPostgres('panel-navigation', async ({ connection }) => {
    const app = await startComposedApplication({
      databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
      port: 0,
      tenantSlug: 'panel-navigation',
      assistantModel: async () => model,
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(app.baseUrl);
      const panel = page.locator('[data-assistant-panel]');
      const toggle = page.getByRole('button', {
        name: 'Assistant',
        exact: true,
      });
      await toggle.click();
      await panel.locator('textarea').fill('First question');
      await panel.getByRole('button', { name: 'Send' }).click();
      await expect(panel).toContainText('First answer.');
      const separator = panel.getByRole('separator');
      const before = (await panel.boundingBox())!;
      const handle = (await separator.boundingBox())!;
      const x = handle.x + handle.width / 2;
      await page.mouse.move(x, handle.y + 90);
      await page.mouse.down();
      await page.mouse.move(x - 70, handle.y + 90);
      await page.mouse.up();
      await expect(separator).toHaveAttribute(
        'aria-valuenow',
        String(before.width + 70),
      );
      await separator.focus();
      await separator.press('ArrowRight');
      const width = before.width + 54;
      await expect(separator).toHaveAttribute('aria-valuenow', String(width));
      await page
        .getByRole('navigation', { name: 'Release navigation' })
        .getByRole('link', { name: 'Purchase orders', exact: true })
        .click();
      await expect(panel).toBeVisible();
      await expect(panel.locator('[data-assistant-said]')).toHaveText(
        'First question',
      );
      await expect(panel.locator('[data-assistant-reply]')).toHaveText(
        'First answer.',
      );
      expect((await panel.boundingBox())!.width).toBe(width);
      await panel.locator('textarea').fill('Take your time');
      await panel.getByRole('button', { name: 'Send' }).click();
      await expect(panel).toContainText('Working on the slow reply');
      await page.getByRole('link', { name: 'New', exact: true }).click();
      await expect(panel.locator('[data-assistant-step]')).toHaveText(
        'Thinking',
      );
      await expect(panel.locator('[data-assistant-status]')).toBeVisible();
      release();
      await expect(panel).toContainText('Slow reply finished.');
      const save = page.getByRole('button', {
        name: 'Save draft',
        exact: true,
      });
      await save.click({ trial: true });
      const dock = (await panel.boundingBox())!;
      const button = (await save.boundingBox())!;
      expect(button.x + button.width).toBeLessThanOrEqual(dock.x);
      expect(
        await page
          .locator('main')
          .evaluate((el) => el.getBoundingClientRect().right),
      ).toBeLessThanOrEqual(dock.x);
      expect(
        await page
          .locator('.topbar')
          .evaluate((el) => el.getBoundingClientRect().right),
      ).toBe(1440);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          if (viewport.width === 390)
            expect(await panel.boundingBox()).toEqual({
              x: 0,
              y: 0,
              ...viewport,
            });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(viewport.width);
          if (process.env.LOOK_EVIDENCE_OUT) {
            const out = resolve(process.env.LOOK_EVIDENCE_OUT, 'panel-2');
            mkdirSync(out, { recursive: true });
            await page.screenshot({
              path: resolve(out, `po-${String(viewport.width)}-${scheme}.png`),
            });
          }
        }
      }
      await panel.getByRole('button', { name: 'Close the assistant' }).click();
      await page.goto(app.baseUrl);
      await expect(panel).toBeHidden();
      await toggle.click();
      await expect(panel).toContainText('Slow reply finished.');
      await panel.getByRole('button', { name: 'New conversation' }).click();
      await page.reload();
      await expect(panel).toBeVisible();
      await expect(panel.locator('[data-assistant-log]')).toBeEmpty();
    } finally {
      release();
      await app.close();
    }
  });
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
      // Reduced motion: no colour transition is caught half-way through
      // the change of theme (LOOK-1).
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      await page.screenshot({
        path: `${resolve(out)}/app-assistant-${String(width)}-${scheme}.png`,
      });
    }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: null });
  if (original) await page.setViewportSize(original);
}
