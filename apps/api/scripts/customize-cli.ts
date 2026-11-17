import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CustomizationServiceRefusal,
  openCustomizationService,
  type DraftOutcome,
} from '@north-star/postgres-provider/customization-service';

import { readUnboundPermissionAcknowledgementFor } from '../../web/scripts/unbound-permission-acknowledgement.js';

/**
 * `corepack pnpm customize <command>` -- the command-line channel of tenant
 * customization (the advanced declarative editor of plan §5.6) against the
 * database a running or previously started `corepack pnpm dev` uses.
 *
 *   customize draft <patch.json>   store the change and print its plain diff
 *   customize status               the active release and every drafted change
 */
const root = resolve(import.meta.dirname, '../../..');
const authoredPath = resolve(root, 'apps/web/release/app.authored.json');
const usage = [
  'usage: corepack pnpm customize <command>',
  '  draft <patch.json>   record a change and print what it would do',
  '  status               show the active release and every recorded change',
].join('\n');

const [command, argument] = process.argv.slice(2);
if (command !== 'draft' && command !== 'status') {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
if (command === 'draft' && !argument) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${process.env.NORTH_STAR_DATABASE_PORT ?? '55432'}/postgres`;
const firstPartyAuthored = JSON.parse(
  await readFile(authoredPath, 'utf8'),
) as Record<string, unknown>;
const opened = await openCustomizationService({
  acknowledgement: readUnboundPermissionAcknowledgementFor(
    authoredPath,
    String((firstPartyAuthored.package as Record<string, unknown>).packageId),
  ),
  compiledApplication: JSON.parse(
    await readFile(resolve(root, 'apps/web/release/app.compiled.json'), 'utf8'),
  ) as unknown,
  databaseUrl,
  firstPartyAuthored,
  migrationsDirectory: resolve(root, 'db/migrations'),
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
  } else {
    const status = await opened.service.status();
    const lines = [
      `Active release ${status.activeReleaseRoot.slice(0, 12)} (${status.activeChain.length === 0 ? 'the standard application' : `${String(status.activeChain.length)} change${status.activeChain.length === 1 ? '' : 's'} applied`})`,
      '',
      status.patches.length === 0
        ? 'No changes recorded yet.'
        : 'Recorded changes:',
      ...status.patches.map(
        (patch) =>
          `  ${patch.patchId}  ${patch.kind.padEnd(14)} ${summary(patch.patch)}${
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

function summary(patch: Record<string, unknown>): string {
  if (typeof patch.label === 'string') return `"${patch.label}"`;
  if (typeof patch.option === 'string') return `"${patch.option}"`;
  const field = patch.field as Record<string, unknown> | undefined;
  if (field && typeof field.label === 'string') return `"${field.label}"`;
  return String(patch.surface ?? '');
}
