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
    const role = await client.query<{
      bypass_rls: boolean;
      can_login: boolean;
      create_database: boolean;
      create_role: boolean;
      inherits_privileges: boolean;
      replication: boolean;
      role: string;
      session_role: string;
      superuser: boolean;
    }>(`
      SELECT current_user AS role,
             session_user AS session_role,
             r.rolbypassrls AS bypass_rls,
             r.rolcanlogin AS can_login,
             r.rolcreatedb AS create_database,
             r.rolcreaterole AS create_role,
             r.rolinherit AS inherits_privileges,
             r.rolreplication AS replication,
             r.rolsuper AS superuser
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user
    `);
    const runtimeRole = role.rows[0];
    if (
      runtimeRole?.role !== 'north_star_runtime' ||
      runtimeRole.session_role !== 'north_star_runtime' ||
      runtimeRole.bypass_rls ||
      !runtimeRole.can_login ||
      runtimeRole.create_database ||
      runtimeRole.create_role ||
      runtimeRole.inherits_privileges ||
      runtimeRole.replication ||
      runtimeRole.superuser
    ) {
      throw new UnsafeDatabaseRoleError(
        'trusted request transactions require the unprivileged north_star_runtime login role',
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
