import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

/**
 * The untrusted-definition release gate has one door. Only the isolated
 * worker declares the sandbox attestation the compiler admits tenant-authored
 * input under; the compiler names it to check it. Any other production file
 * that spells the attestation would be a second, unbounded way in.
 */
test('only the isolated worker declares the untrusted-definition sandbox attestation', () => {
  const root = resolve('.');
  const declaring = productionFiles(root)
    .filter((file) =>
      readFileSync(file, 'utf8').includes("'processIsolatedCompile'"),
    )
    .map((file) => relative(root, file))
    .sort();
  assert.deepEqual(declaring, [
    'packages/compiler/src/compiler.ts',
    'packages/compiler/src/protocol.ts',
    'packages/customization/src/sandbox-worker.ts',
  ]);
});

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const top of ['apps', 'packages']) {
    walk(join(root, top), files);
  }
  return files;
}

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith('.ts')) files.push(path);
  }
}
