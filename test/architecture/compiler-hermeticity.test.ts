import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import { fixtureBytes } from '../compiler/helpers.js';

test('compiler core is hermetic and contains no ambient coordinator inputs', () => {
  const root = resolve('.');
  const files = readdirSync(resolve(root, 'packages/compiler/src'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `packages/compiler/src/${file}`)
    .sort();
  assert.ok(files.length >= 6);
  const violations: string[] = [];
  const bannedImports =
    /(?:from\s+|import\s*\()['"](?:node:)?(?:fs|path|os|http|https|net|dns|tls|dgram|child_process|worker_threads|cluster|sqlite|pg|postgres|kysely|knex|typeorm|sequelize|drizzle-orm|@prisma\/)/g;
  const bannedAmbient = [
    /\bprocess\s*\./g,
    /\bDate\.now\s*\(/g,
    /\bnew\s+Date\s*\(/g,
    /\bMath\.random\s*\(/g,
    /\bperformance\.now\s*\(/g,
    /\brandomUUID\s*\(/g,
    /\bfetch\s*\(/g,
    /\blocaleCompare\s*\(/g,
    /\bIntl\s*\./g,
  ];
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8');
    if (bannedImports.test(source)) violations.push(`${file}: banned import`);
    for (const pattern of bannedAmbient) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) {
        violations.push(`${file}: ${pattern.source}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('compiler boundary and deterministic output are process-serializable data', () => {
  const input = {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput' as const,
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: fixtureBytes('bootstrap'),
    profile: { ...DEFAULT_COMPILER_PROFILE },
  };
  const clonedInput = structuredClone(input);
  const result = compileApplication(clonedInput);
  assert.equal(result.status, 'compiled');
  const clonedOutput = structuredClone(result);
  assert.deepEqual(clonedOutput, result);
  assert.equal(hasFunction(clonedOutput), false);

  const invalid = compileApplication({
    ...input,
    dependencies: [(() => undefined) as never],
  });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.diagnostics[0]?.code, 'COMPILER_INPUT_NOT_SERIALIZABLE');
});

function hasFunction(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => hasFunction(entry, seen));
}
