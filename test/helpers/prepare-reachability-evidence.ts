import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getReachabilityProducer } from './reachability-producers.js';
import { ensureReachabilityRun } from './reachability-run.mjs';

const suiteId = process.argv[2];
if (!suiteId)
  throw new Error('Usage: prepare-reachability-evidence.ts <suite-id>');
const producer = getReachabilityProducer(suiteId);
const repositoryRoot = findRepositoryRoot(process.cwd());
ensureReachabilityRun({ repositoryRoot });

for (const path of [
  producer.evidencePath,
  producer.rawEvidencePath,
  producer.invocationEvidencePath,
]) {
  if (!path) continue;
  const absolute = resolve(repositoryRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  rmSync(absolute, { force: true });
}

function findRepositoryRoot(start: string): string {
  let candidate = resolve(start);
  for (;;) {
    if (existsSync(resolve(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate repository root from ${start}`);
    }
    candidate = parent;
  }
}
