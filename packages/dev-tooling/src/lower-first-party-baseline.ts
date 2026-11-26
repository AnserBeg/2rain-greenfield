/**
 * The reviewed way to rewrite the first-party name baseline (GUARD-WIDEN).
 *
 * It only lowers: each count drops to what the guard observes and a row
 * observed zero times disappears. When any name-law rule is red (a count rose,
 * a new file or name appeared, or an input is malformed) it refuses and writes
 * nothing, so it can never be used to admit new debt. A packet that converts a
 * cluster runs this in the same commit and the diff shows the debt it paid.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import {
  checkModulePressLaw,
  isNameLawRule,
  lowerNameLawBaseline,
  NAME_LAW_BASELINE_PATH,
  parseNameLawBaseline,
  type NameLawBaseline,
} from './module-press-law.js';

const rootArgumentIndex = process.argv.indexOf('--root');
const root = resolve(
  (rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined) ??
    process.cwd(),
);
process.exitCode = lower(root);

function lower(root: string): number {
  const result = checkModulePressLaw(root);
  if (!result.nameLaw.active) {
    console.error('guard:lower-baseline: this tree has no name-law policy');
    return 2;
  }
  const refusals = result.violations.filter((violation) =>
    isNameLawRule(violation.ruleId),
  );
  if (refusals.length > 0) {
    console.error(
      [
        `guard:lower-baseline: refused, ${String(refusals.length)} name-law violation(s); the baseline is never raised`,
        ...refusals.map(
          (violation) =>
            `${violation.file}:${String(violation.line)} [${violation.ruleId}] ${violation.message}`,
        ),
      ].join('\n'),
    );
    return 1;
  }
  const path = join(root, NAME_LAW_BASELINE_PATH);
  const before = parseNameLawBaseline(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  );
  const moved = movedBaselineFiles(root, Object.keys(before.files));
  if (moved.length > 0) {
    console.error(
      [
        'guard:lower-baseline: refused, a baselined file vanished but a file of the same name still exists; a move is re-measured deliberately, never lowered away',
        ...moved,
      ].join('\n'),
    );
    return 1;
  }
  const after = lowerNameLawBaseline(before, result.nameLaw.observations);
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  console.log(
    `guard:lower-baseline: ${String(total(before))} -> ${String(total(after))} uses, ${String(Object.keys(before.files).length)} -> ${String(Object.keys(after.files).length)} files`,
  );
  return 0;
}

function total(baseline: NameLawBaseline): number {
  let sum = 0;
  for (const row of Object.values(baseline.files)) {
    for (const count of Object.values(row.names)) sum += count;
  }
  return sum;
}

/**
 * A baselined file that no longer exists may be dropped only when its uses
 * vanished with it. If a file of the same name still exists anywhere in the
 * tree, it most likely moved (perhaps out of the scope), so refuse.
 */
function movedBaselineFiles(root: string, files: readonly string[]): string[] {
  const vanished = files.filter((file) => !existsSync(join(root, file)));
  if (vanished.length === 0) return [];
  const present = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else present.set(entry.name, relative(root, path));
    }
  };
  walk(root);
  return vanished.flatMap((file) => {
    const elsewhere = present.get(basename(file));
    return elsewhere === undefined ? [] : [`  ${file} -> ${elsewhere}`];
  });
}
