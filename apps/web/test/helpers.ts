import { resolve } from 'node:path';

import { createDemoRequestRuntimeEntry } from '../src/demo-runtime.js';

export const webRoot = resolve(import.meta.dirname, '..');
export const compiledFixturePath = resolve(
  webRoot,
  'release/shell.compiled.json',
);

export function demoEntry(fixturePath = compiledFixturePath) {
  return createDemoRequestRuntimeEntry({
    compiledFixturePath: fixturePath,
    environmentId: '20000000-0000-4000-8000-000000000002',
    pointerFence: 7,
    pointerId: '30000000-0000-4000-8000-000000000003',
    principalId: '40000000-0000-4000-8000-000000000004',
    releaseId: '50000000-0000-4000-8000-000000000005',
    tenantId: '10000000-0000-4000-8000-000000000001',
  });
}
