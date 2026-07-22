import { resolve } from 'node:path';

import { createSurfaceRuntimeServer } from './app-server.js';
import { createDemoRequestRuntimeEntry } from './demo-runtime.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}

const entry = createDemoRequestRuntimeEntry({
  compiledFixturePath: resolve(
    repositoryRoot,
    'apps/web/release/shell.compiled.json',
  ),
  environmentId: '20000000-0000-4000-8000-000000000002',
  pointerFence: 7,
  pointerId: '30000000-0000-4000-8000-000000000003',
  principalId: '40000000-0000-4000-8000-000000000004',
  releaseId: '50000000-0000-4000-8000-000000000005',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const server = createSurfaceRuntimeServer(entry);

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`SurfaceRuntime demo: http://127.0.0.1:${boundPort}\n`);
});

function stop(): void {
  server.close((error) => {
    if (error) throw error;
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
