import { assertTrustedRequestContext } from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import type { TrustedRequestContext } from '@north-star/runtime';

export class UnsafeDatabaseRoleError extends Error {
  override readonly name = 'UnsafeDatabaseRoleError';
}

export async function withTrustedRequestTransaction<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertTrustedRequestContext(context);
  const client = await pool.connect();
  let hasPrimaryError = false;
  let primaryError: unknown;
  let result: T | undefined;
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const role = await client.query<{ role: string }>(
      'SELECT current_user AS role',
    );
    if (role.rows[0]?.role !== 'north_star_runtime') {
      throw new UnsafeDatabaseRoleError(
        'trusted request transactions require the north_star_runtime database role',
      );
    }
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true),
              set_config('north_star.principal_id', $3, true),
              set_config('north_star.request_id', $4, true)`,
      [
        context.tenantId,
        context.environmentId,
        context.principalId,
        context.requestId,
      ],
    );
    result = await run(client);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        primaryError = new AggregateError(
          [error, rollbackError],
          'request transaction and rollback both failed',
        );
      }
    }
  }

  let cleanupError: unknown;
  try {
    await client.query('RESET ROLE');
    await client.query('RESET ALL');
  } catch (error) {
    cleanupError = error;
  } finally {
    client.release(cleanupError ? asError(cleanupError) : undefined);
  }

  if (hasPrimaryError) {
    if (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'request transaction and connection cleanup both failed',
      );
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return result as T;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
