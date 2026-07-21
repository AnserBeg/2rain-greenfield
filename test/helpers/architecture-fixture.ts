import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function createArchitectureFixture(
  files: Record<string, string>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'north-star-boundaries-'));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

export function removeArchitectureFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function packageManifest(name: string, dependencies = {}): string {
  return JSON.stringify(
    { name, private: true, version: '0.0.0', dependencies },
    null,
    2,
  );
}
