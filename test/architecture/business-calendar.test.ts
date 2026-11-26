import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// COMPANY-CALENDAR-1 slice 1. Structural pins on the calendar migration, found
// by name so the merge-time renumbering never strands them.

const read = (suffix: string): string => {
  const name = readdirSync('db/migrations').find((file) =>
    file.endsWith(suffix),
  );
  assert.ok(name, `the ${suffix} migration is missing`);
  return readFileSync(`db/migrations/${name}`, 'utf8');
};
const calendar = () => read('_business_calendar.sql');

test('ledger_business_day changes only its last line (design read C6)', () => {
  const pattern = (create: string) =>
    new RegExp(
      `${create} north_star_internal\\.ledger_business_day\\(company uuid, instant timestamptz\\) RETURNS date[\\s\\S]*?END \\$\\$;`,
      'u',
    );
  const original = pattern('CREATE FUNCTION').exec(
    read('_ledger_journal_core.sql'),
  )?.[0];
  const replaced = pattern('CREATE OR REPLACE FUNCTION').exec(calendar())?.[0];
  assert.ok(original && replaced, 'a ledger_business_day body is missing');
  assert.equal(
    replaced,
    original
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      .replace(
        'RETURN north_star_internal.inventory_business_period(t, instant); END $$;',
        () =>
          'RETURN north_star_internal.business_day(t, e, company, instant); END $$;',
      ),
    'ledger_business_day changed more than its last line',
  );
});

test('inventory_business_period keeps the 0033 signature, scope check and refusals (design read C3)', () => {
  const head = (sql: string) =>
    /CREATE OR REPLACE FUNCTION north_star_internal\.inventory_business_period\([\s\S]*?DETAIL = format\('tenantId=%s', requested_tenant_id\); END IF;/u.exec(
      sql,
    )?.[0];
  const before = head(read('_definer_search_paths.sql'));
  const after = head(calendar());
  assert.ok(before && after, 'a business-period body is missing');
  assert.equal(after, before, 'the signature or the scope check changed');
  const body = calendar();
  assert.match(
    body,
    /RAISE EXCEPTION 'INVENTORY_TENANT_CALENDAR_UNDECLARED'\n\s+USING ERRCODE = 'P0001',\n\s+DETAIL = format\('tenantId=%s', requested_tenant_id\); END IF;/u,
  );
});

test('the calendar migration changes no existing row (design read C5)', () => {
  // Function bodies run later, not at migration time.
  const statements = calendar()
    .replaceAll(/--[^\n]*/gu, '')
    .replaceAll(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gu, '');
  assert.doesNotMatch(
    statements,
    /\bUPDATE\s+platform\.|\bDELETE\s+FROM\b|\bTRUNCATE\s+(?:TABLE\s+)?platform\./iu,
  );
});
