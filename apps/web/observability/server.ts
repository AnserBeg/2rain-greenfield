import { createHealthServer } from './health-server.js';
import {
  ObservabilityMetrics,
  StructuredLogger,
} from '@north-star/observability';
import { createPostgresReadinessProbe } from '@north-star/postgres-provider/readiness';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the observability health host');
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}

const postgres = createPostgresReadinessProbe({
  connectionString: databaseUrl,
});
const server = createHealthServer({
  logger: new StructuredLogger(),
  metrics: new ObservabilityMetrics(),
  postgres,
});

server.listen(port, '127.0.0.1');

async function stop(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await postgres.close();
}

process.once('SIGINT', () => {
  void stop().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
