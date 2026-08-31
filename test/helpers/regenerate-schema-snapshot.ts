/**
 * Writes `db/schema.snapshot.json` from the checked-in migration stream.
 *
 * `check:schema` ASSERTS the snapshot and nothing on `main` writes it, so a
 * packet that adds a migration invalidates a required artefact it has no way to
 * regenerate except by hand-editing captured catalog output. That gap is the
 * `migration-addition-has-no-registry` finding's snapshot half, and it is why
 * this file exists rather than a transcription.
 *
 * It is deliberately NOT a gate. It shares `loadMigrations`/`runMigrations`
 * with `check:schema` because those are the subject both need to observe, but
 * it never reads the existing snapshot, so it cannot repair the file that the
 * verifier then measures -- the two run in opposite directions against one
 * ephemeral database, and the verifier is the only one that compares.
 *
 * The output is run through Prettier before it is written. `pnpm format` checks
 * this file like any other, and a raw `JSON.stringify(..., 2)` does NOT agree
 * with it -- Prettier collapses single-element arrays onto one line, so an
 * unformatted regeneration reds the `format` gate with three hundred lines of
 * pure whitespace churn around the one line that actually moved. That is the
 * defect in the `packet/ps-2` prior art this file is descended from.
 *
 *   node scripts/run-with-test-lock.mjs exclusive -- \
 *     node --import tsx test/helpers/regenerate-schema-snapshot.ts
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';

import {
  captureSchemaSnapshot,
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

async function main(): Promise<void> {
  await withEphemeralPostgres('schema-snapshot', async ({ pool }) => {
    const client = await pool.connect();
    try {
      const result = await runMigrations(
        client,
        await loadMigrations(resolve('db/migrations')),
      );
      const snapshot = await captureSchemaSnapshot(client);
      const path = resolve('db/schema.snapshot.json');
      await writeFile(
        path,
        // Two-space JSON FIRST, then Prettier. Prettier preserves an
        // object's expanded form when the source already broke the line after
        // `{`, but collapses arrays regardless -- so this pair is the only one
        // that reproduces the checked-in file byte for byte. Handing Prettier
        // compact JSON instead collapses the short objects too.
        await format(JSON.stringify(snapshot, null, 2), {
          ...(await resolveConfig(path)),
          filepath: path,
        }),
        'utf8',
      );
      process.stdout.write(
        `schema-snapshot: WROTE (${String(result.applied.length)} migrations applied)\n`,
      );
    } finally {
      client.release();
    }
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
