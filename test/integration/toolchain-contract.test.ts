import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the scaffold declares one pinned package manager', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(packageJson.packageManager, 'pnpm@11.9.0');
  assert.equal(packageJson.engines.node, '22.22.2');
});
