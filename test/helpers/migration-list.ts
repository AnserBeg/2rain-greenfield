import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildModeSwitch } from '../../scripts/build-mode.mjs';

/**
 * BUILD-MODE-1, switch `migrationListByGlob`: the expected checked-in migration
 * stream, in order.
 *
 * Strict (build mode off): exactly the names in test/helpers/migration-pin.json,
 * so adding a migration fails every test that compares against this list until
 * the pin is edited -- the old behaviour, in one file instead of five.
 *
 * Build mode: the names on disk (db/migrations/*.sql, sorted), after checking
 * that the stream is contiguous (0001, 0002, ... with no gap or duplicate) and
 * append-only (the pinned list is an unchanged prefix: nothing pinned was
 * renamed, removed or reordered). The migration runner still refuses an edited
 * applied migration by checksum; this only stops pinning the newest name.
 */
export function expectedMigrationNames(
  options: {
    readonly buildMode?: boolean;
    readonly directory?: string;
    readonly pinned?: readonly string[];
  } = {},
): string[] {
  const directory = options.directory ?? resolve('db/migrations');
  const pinned = options.pinned ?? pinnedMigrationNames();
  const buildMode = options.buildMode ?? buildModeSwitch('migrationListByGlob');
  if (!buildMode) return [...pinned];
  const onDisk = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  onDisk.forEach((name, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (!name.startsWith(`${expected}_`)) {
      throw new Error(
        `migration stream must be contiguous: position ${String(index + 1)} is ${name}, expected ${expected}_*.sql`,
      );
    }
  });
  pinned.forEach((name, index) => {
    if (onDisk[index] !== name) {
      throw new Error(
        `migrations are append-only: pinned ${name} is ${onDisk[index] === undefined ? 'missing' : `now ${onDisk[index]}`} at position ${String(index + 1)}`,
      );
    }
  });
  return onDisk;
}

export function pinnedMigrationNames(
  path = resolve('test/helpers/migration-pin.json'),
): string[] {
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    migrations?: unknown;
  };
  if (
    !Array.isArray(document.migrations) ||
    document.migrations.some((name) => typeof name !== 'string')
  ) {
    throw new Error(`${path}: migrations must be a list of file names`);
  }
  return document.migrations as string[];
}
