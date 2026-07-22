import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  ObservabilityMetrics,
  StructuredLogger,
} from '../../packages/observability/src/index.js';
import { createPostgresReadinessProbe } from '../../packages/postgres-provider/src/readiness.js';

import { createHealthServer } from '../../apps/web/observability/health-server.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const execFileAsync = promisify(execFile);
const correlationId = 'g0-p5-evidence-correlation';
const traceId = '33333333333333333333333333333333';
const traceParent = `00-${traceId}-4444444444444444-01`;

test('health stays live while readiness turns red when PostgreSQL stops', async () => {
  await withEphemeralPostgres(
    'observability-readiness',
    async ({ connection, containerName }) => {
      const lines: string[] = [];
      const metrics = new ObservabilityMetrics();
      const logger = new StructuredLogger({
        clock: () => new Date('2026-07-21T12:00:00.000Z'),
        sink: (line) => lines.push(line),
      });
      const postgres = createPostgresReadinessProbe({
        connectionString: `postgresql://postgres@127.0.0.1:${String(connection.port)}/postgres`,
      });
      const server = createHealthServer({ logger, metrics, postgres });

      try {
        await listen(server);
        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${String(address.port)}`;
        const headers = {
          traceparent: traceParent,
          'x-correlation-id': correlationId,
        };

        const liveBefore = await fetch(`${baseUrl}/healthz`, { headers });
        assert.equal(liveBefore.status, 200);
        assert.deepEqual(await liveBefore.json(), { status: 'ok' });
        assertPropagation(liveBefore);

        const readyBefore = await fetch(`${baseUrl}/readyz`, { headers });
        assert.equal(readyBefore.status, 200);
        assert.deepEqual(await readyBefore.json(), {
          checks: { postgres: 'up' },
          status: 'ready',
        });
        assertPropagation(readyBefore);

        await execFileAsync('docker', ['stop', '--time', '1', containerName]);

        const readyAfter = await fetch(`${baseUrl}/readyz`, { headers });
        assert.equal(readyAfter.status, 503);
        assert.deepEqual(await readyAfter.json(), {
          checks: { postgres: 'down' },
          status: 'not_ready',
        });
        assertPropagation(readyAfter);

        const liveAfter = await fetch(`${baseUrl}/healthz`, { headers });
        assert.equal(liveAfter.status, 200);
        assert.deepEqual(await liveAfter.json(), { status: 'ok' });

        const metricResponse = await fetch(`${baseUrl}/metrics`, { headers });
        assert.equal(metricResponse.status, 200);
        const metricEvidence = await metricResponse.text();
        assert.match(
          metricEvidence,
          /north_star_readiness_checks_total\{dependency="postgres",result="ready"\} 1/u,
        );
        assert.match(
          metricEvidence,
          /north_star_readiness_checks_total\{dependency="postgres",result="not_ready"\} 1/u,
        );
        assert.match(
          metricEvidence,
          /north_star_errors_total\{code="readiness\.postgres_unavailable"\} 1/u,
        );

        const records = lines.map(
          (line) => JSON.parse(line) as Record<string, unknown>,
        );
        assert.ok(records.length >= 5);
        assert.ok(
          records.every(
            (record) =>
              record.correlationId === correlationId &&
              record.traceId === traceId,
          ),
        );
        const errorRecord = records.find(
          (record) => record.event === 'readiness.check.failed',
        );
        assert.deepEqual(errorRecord?.error, {
          code: 'readiness.postgres_unavailable',
          type: 'Error',
        });
        assert.equal(JSON.stringify(errorRecord).includes('password'), false);

        await writeEvidenceIfRequested({
          health: {
            correlationId,
            healthAfterPostgresStop: 200,
            healthBeforePostgresStop: 200,
            readyAfterPostgresStop: 503,
            readyBeforePostgresStop: 200,
            traceId,
          },
          lines,
          metricEvidence,
        });
      } finally {
        await close(server);
        await postgres.close();
      }
    },
  );
});

function assertPropagation(response: Response): void {
  assert.equal(response.headers.get('x-correlation-id'), correlationId);
  assert.equal(response.headers.get('traceparent'), traceParent);
}

async function listen(
  server: ReturnType<typeof createHealthServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function close(
  server: ReturnType<typeof createHealthServer>,
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function writeEvidenceIfRequested(evidence: {
  health: Readonly<Record<string, number | string>>;
  lines: readonly string[];
  metricEvidence: string;
}): Promise<void> {
  const directory = process.env.OBSERVABILITY_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      `${directory}/health-evidence.json`,
      `${JSON.stringify(evidence.health, null, 2)}\n`,
    ),
    writeFile(
      `${directory}/structured-logs.ndjson`,
      `${evidence.lines.join('\n')}\n`,
    ),
    writeFile(`${directory}/metrics.prom`, evidence.metricEvidence),
  ]);
}
