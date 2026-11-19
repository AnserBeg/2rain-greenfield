import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CustomizationServiceRefusal,
  type DraftOutcome,
} from '@north-star/postgres-provider/customization-service';

import { openCustomizeService } from '../src/composition-root.js';

/**
 * `corepack pnpm customize <command>` -- the command-line channel of tenant
 * customization (the advanced declarative editor of plan §5.6) against the
 * database a running or previously started `corepack pnpm dev` uses.
 *
 *   customize draft <patch.json>   store the change and print its plain diff
 *   customize ask "<request>"      draft a change from plain English (model key)
 *   customize approve <change-id>  approve a drafted change (shows the diff again)
 *   customize activate <change-id> make an approved change live; no restart
 *   customize rollback             hide the live change again; its records stay
 *   customize recover              verify an interrupted activation and reconcile scopes
 *   customize status               the active release and every drafted change
 */
const usage = [
  'usage: corepack pnpm customize <command>',
  '  draft <patch.json>     record a change and print what it would do',
  '  ask "<request>"        draft a change from plain English',
  '  approve <change-id>    approve a drafted change',
  '  activate <change-id>   make an approved change live (no restart)',
  '  rollback               hide the live change; its records are kept',
  '  recover                verify the live activation and reconcile scopes',
  '  status                 show the active release and every recorded change',
].join('\n');

const commands = [
  'draft',
  'ask',
  'approve',
  'activate',
  'rollback',
  'recover',
  'status',
];
const [command, ...rest] = process.argv.slice(2);
const argument = command === 'ask' ? rest.join(' ').trim() : rest[0];
if (
  !command ||
  !commands.includes(command) ||
  (['draft', 'ask', 'approve', 'activate'].includes(command) && !argument)
) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${process.env.NORTH_STAR_DATABASE_PORT ?? '55432'}/postgres`;
const opened = await openCustomizeService({
  databaseUrl,
  tenantSlug:
    process.env.NORTH_STAR_TENANT_SLUG ?? 'local-composed-application',
});

let exitCode = 0;
try {
  if (command === 'draft') {
    const patch = JSON.parse(
      await readFile(
        resolve(process.env.INIT_CWD ?? process.cwd(), argument!),
        'utf8',
      ),
    ) as unknown;
    exitCode = report(await opened.service.draft(patch, 'declarativeEditor'));
  } else if (command === 'ask') {
    exitCode = report(await opened.service.draftFromRequest(argument!));
  } else if (command === 'approve') {
    const approved = await opened.service.approve(argument!);
    process.stdout.write(
      [
        `Approved change ${argument!}:`,
        '',
        approved.renderedDiff,
        '',
        `Make it live with: corepack pnpm customize activate ${argument!}`,
        '',
      ].join('\n'),
    );
  } else if (command === 'activate') {
    const activated = await opened.service.activate(argument!);
    process.stdout.write(
      `Live: release ${activated.releaseRoot.slice(0, 12)}. A running corepack pnpm dev shows it on the next page load.\n`,
    );
  } else if (command === 'recover') {
    const recovered = await opened.service.recover();
    process.stdout.write(
      `Recovered live release ${recovered.releaseRoot.slice(0, 12)}. Its activation is verified and inventory scopes are reconciled.\n`,
    );
  } else if (command === 'rollback') {
    const rolledBack = await opened.service.rollback();
    process.stdout.write(
      `Rolled back to release ${rolledBack.releaseRoot.slice(0, 12)}. The change is hidden; every record entered under it is kept.\n`,
    );
  } else {
    const status = await opened.service.status();
    const lines = [
      `Active release ${status.activeReleaseRoot.slice(0, 12)} (${status.historyUnavailable ? 'customization history unavailable' : status.activeChain.length === 0 ? 'the standard application' : `${String(status.activeChain.length)} change${status.activeChain.length === 1 ? '' : 's'} applied`})`,
      '',
      ...(status.upgradeRefusal
        ? [
            `Platform upgrade refused: ${status.upgradeRefusal.code} — ${status.upgradeRefusal.message}`,
            ...(status.upgradeRefusal.issues ?? []),
          ]
        : []),
      status.historyUnavailable
        ? 'Recorded changes are unavailable.'
        : status.patches.length === 0
          ? 'No changes recorded yet.'
          : 'Recorded changes:',
      ...status.upgrades.map(
        (upgrade) =>
          `  ${upgrade.upgradeId}  platform upgrade  (${upgrade.state})`,
      ),
      ...status.patches.map(
        (patch) =>
          `  ${patch.patchId}  ${patch.kind.padEnd(14)} ${patch.displayLabel ?? ''}${
            status.activeChain.some(
              (active) => active.patchId === patch.patchId,
            )
              ? '  (active)'
              : ''
          }`,
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
} catch (error) {
  if (error instanceof CustomizationServiceRefusal) {
    process.stderr.write(`REFUSED ${error.code}: ${error.message}\n`);
    exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await opened.close();
}
process.exit(exitCode);

function report(outcome: DraftOutcome): number {
  if (outcome.status === 'drafted') {
    process.stdout.write(
      [
        `Drafted change ${outcome.patchId}${outcome.reused ? ' (already drafted; nothing new recorded)' : ''}`,
        '',
        outcome.renderedDiff,
        '',
        `Release ${outcome.releaseRoot.slice(0, 12)} is ready for approval. Nothing is live yet.`,
        '',
      ].join('\n'),
    );
    return 0;
  }
  process.stderr.write(
    [
      `${outcome.status.toUpperCase()}${outcome.code ? ` ${outcome.code}` : ''}${
        outcome.missingCapability
          ? ` (missing capability: ${outcome.missingCapability})`
          : ''
      }: ${outcome.message}`,
      ...(outcome.issues ?? []).map((issue) => `  - ${issue}`),
      'Nothing was recorded.',
      '',
    ].join('\n'),
  );
  return 1;
}
