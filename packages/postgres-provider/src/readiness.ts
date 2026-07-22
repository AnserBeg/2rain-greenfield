import pg from 'pg';

export interface PostgresReadinessProbe {
  readonly check: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface PostgresReadinessConfig {
  readonly connectionString: string;
  readonly connectionTimeoutMillis?: number;
}

export function createPostgresReadinessProbe(
  config: PostgresReadinessConfig,
): PostgresReadinessProbe {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 500,
    max: 1,
  });
  let closed = false;

  pool.on('error', () => {
    // A dependency loss is reported by the next explicit readiness check.
  });

  return Object.freeze({
    check: async () => {
      if (closed) throw new Error('PostgreSQL readiness probe is closed');
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  });
}
