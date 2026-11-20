import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const allowlist = 'test/postgres/application-grants.tsv';

async function checkApplicationGrants(client: PoolClient): Promise<void> {
  // has_*_privilege accounts for ownership, PUBLIC and inherited memberships.
  // Check SET ROLE targets in their own right too. The bootstrap administrator
  // (OID 10) and PostgreSQL's predefined non-login roles are infrastructure.
  const { rows } = await client.query<{ entry: string }>(`
    WITH roles AS (
      SELECT oid, rolname FROM pg_roles
      WHERE oid <> 10 AND (rolcanlogin OR rolname !~ '^pg_')
    ), tables AS (
      SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS qualified_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
        AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ), privileges AS (
      SELECT privilege_type, privilege_type || suffix AS permission
      FROM aclexplode(acldefault('r', 10))
      CROSS JOIN (VALUES (''), (' WITH GRANT OPTION')) AS options(suffix)
    ), checks AS MATERIALIZED (
      SELECT r.oid AS role_id, r.rolname, t.oid AS relation_id, t.qualified_name,
             p.privilege_type, p.permission,
             has_table_privilege(r.oid, t.oid, p.permission) AS whole_table
      FROM roles r CROSS JOIN tables t CROSS JOIN privileges p
    ), grants AS (
      SELECT rolname, qualified_name, permission, '*' AS columns FROM checks WHERE whole_table
      UNION ALL
      SELECT c.rolname, c.qualified_name, c.permission,
             string_agg(quote_ident(a.attname), ',' ORDER BY a.attname COLLATE "C")
      FROM checks c JOIN pg_attribute a ON a.attrelid = c.relation_id
      WHERE NOT c.whole_table AND NOT a.attisdropped
        AND CASE WHEN c.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                 THEN has_column_privilege(c.role_id, c.relation_id, a.attnum, c.permission)
                 ELSE false END
      GROUP BY c.rolname, c.qualified_name, c.permission
    )
    SELECT format('%I', rolname) || chr(9) || qualified_name || chr(9) ||
           permission || chr(9) || columns AS entry FROM grants ORDER BY entry
  `);
  const allowed = new Set<string>();
  const file = await readFile(allowlist, 'utf8');
  for (const line of file.trimEnd().split('\n').slice(1)) {
    const fields = line.split('\t');
    assert.ok(
      fields.length === 5 && fields[4]?.trim(),
      `Invalid allowlist row: ${line}`,
    );
    const entry = fields.slice(0, 4).join('\t');
    assert.ok(!allowed.has(entry), `Duplicate allowlist row: ${entry}`);
    allowed.add(entry);
  }

  const unexpected = rows.filter(({ entry }) => !allowed.delete(entry));
  if (unexpected.length > 0) {
    assert.fail(
      `Unexpected application privileges. Use a SECURITY DEFINER function instead:\n${unexpected.map(({ entry }) => entry).join('\n')}`,
    );
  }
  assert.deepEqual(
    [...allowed],
    [],
    'Remove stale application privilege exceptions',
  );
}

test('effective application grants match the reviewed allowlist', async (t) => {
  await withEphemeralPostgres('application-grants', async ({ pool }) => {
    const client = await pool.connect();
    try {
      const migrations = await loadMigrations('db/migrations');
      await runMigrations(client, migrations);
      await checkApplicationGrants(client);

      await t.test(
        'a temporary migration cannot widen table or inherited column access',
        async () => {
          const sql = `
          CREATE TABLE platform.grant_probe (enabled boolean, private_value text);
          GRANT INSERT ON platform.grant_probe TO north_star_runtime;
          CREATE ROLE grant_probe_reader NOLOGIN;
          CREATE ROLE grant_probe_login LOGIN INHERIT IN ROLE grant_probe_reader;
          GRANT SELECT (enabled) ON platform.grant_probe TO grant_probe_reader;
        `;
          await runMigrations(client, [
            ...migrations,
            {
              name: 'grant-probe.sql',
              sql,
              checksum: createHash('sha256').update(sql).digest('hex'),
            },
          ]);
          await assert.rejects(
            checkApplicationGrants(client),
            (error: Error) => {
              assert.match(
                error.message,
                /Use a SECURITY DEFINER function instead/,
              );
              assert.match(
                error.message,
                /^north_star_runtime\tplatform\.grant_probe\tINSERT\t\*$/m,
              );
              assert.match(
                error.message,
                /^grant_probe_login\tplatform\.grant_probe\tSELECT\tenabled$/m,
              );
              return true;
            },
          );
        },
      );
    } finally {
      client.release();
    }
  });
});
