/**
 * The reviewed way to rewrite the first-party name baseline (GUARD-WIDEN).
 *
 * It only lowers: each count drops to what the guard observes and a row
 * observed zero times disappears. When any name-law rule is red (a count rose,
 * a new file or name appeared, or an input is malformed) it refuses and writes
 * nothing, so it can never be used to admit new debt. A packet that converts a
 * cluster runs this in the same commit and the diff shows the debt it paid.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
const result = checkModulePressLaw(root);
const refusals = result.violations.filter((violation) =>
  isNameLawRule(violation.ruleId),
);
if (!result.nameLaw.active) {
  console.error('guard:lower-baseline: this tree has no name-law policy');
  process.exitCode = 2;
} else if (refusals.length > 0) {
  console.error(
    [
      `guard:lower-baseline: refused, ${String(refusals.length)} name-law violation(s); the baseline is never raised`,
      ...refusals.map(
        (violation) =>
          `${violation.file}:${String(violation.line)} [${violation.ruleId}] ${violation.message}`,
      ),
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  const path = join(root, NAME_LAW_BASELINE_PATH);
  const before = parseNameLawBaseline(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  );
  const after = lowerNameLawBaseline(before, result.nameLaw.observations);
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  console.log(
    `guard:lower-baseline: ${String(total(before))} -> ${String(total(after))} uses, ${String(Object.keys(before.files).length)} -> ${String(Object.keys(after.files).length)} files`,
  );
}

function total(baseline: NameLawBaseline): number {
  let sum = 0;
  for (const row of Object.values(baseline.files)) {
    for (const count of Object.values(row.names)) sum += count;
  }
  return sum;
}
