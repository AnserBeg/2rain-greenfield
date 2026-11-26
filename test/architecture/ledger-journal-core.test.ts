import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// ACCOUNTING-1 slices 1a-i and 1a-ii. Structural pins on every ledger
// migration, found by name so the merge-time renumbering never strands them.
// A later ledger migration replaces functions of an earlier one, so the pins
// read all of them, in order.

const migrationNames = readdirSync('db/migrations')
  .filter((name) => /^\d{4}_ledger_[a-z_]+\.sql$/u.test(name))
  .sort();
const migrations = (): string[] => {
  assert.ok(
    migrationNames.some((name) => name.endsWith('_ledger_journal_core.sql')),
    'the ledger journal-core migration is missing',
  );
  return migrationNames.map((name) =>
    readFileSync(`db/migrations/${name}`, 'utf8'),
  );
};
/** The SQL with comments removed, so prose never satisfies or trips a pin. */
const code = (): string =>
  migrations()
    .map((sql) => sql.replaceAll(/--[^\n]*/gu, ''))
    .join('\n');

test('the core role list is pinned to ADR-0093 section 3 and never renamed or reclassed', () => {
  const adr = readFileSync(
    'docs/decisions/ADR-0093-ledger-and-posting-rules.md',
    'utf8',
  );
  const classes: Record<string, string> = {
    Asset: 'asset',
    Liability: 'liability',
    Equity: 'equity',
    Income: 'income',
    Expense: 'expense',
  };
  const pinned: string[] = [];
  for (const row of adr.matchAll(
    /^\| (Asset|Liability|Equity|Income|Expense) \| (.+) \|$/gmu,
  )) {
    for (const item of row[2]!.split(/,(?![^(]*\))/u)) {
      const role = /^\s*([a-z_]+)(\*)? \(([^;)]+)/u.exec(item);
      assert.ok(role, `unreadable ADR role entry: ${item}`);
      const side = role[3]!.trim();
      const normal = side.startsWith('either')
        ? 'either'
        : side.startsWith('Dr')
          ? 'D'
          : 'C';
      pinned.push(
        `${role[1]} ${classes[row[1]!]} ${normal} ${role[2] ? 'control' : '-'}`,
      );
    }
  }
  assert.equal(
    pinned.length,
    30,
    'ADR-0093 section 3 no longer lists 30 roles',
  );
  const seeded = [
    ...code().matchAll(
      /\('northstar\.ledger:role\.([a-z_]+)','(asset|liability|equity|income|expense)','(D|C|either)',(NULL|'northstar\.ledger:subledger\.(?:customer|supplier)')\)/gu,
    ),
  ].map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4] === 'NULL' ? '-' : 'control'}`);
  assert.deepEqual(
    seeded,
    pinned,
    'the seeded core roles differ from ADR-0093 section 3',
  );
  const counts = Object.values(classes).map(
    (name) => pinned.filter((entry) => entry.split(' ')[1] === name).length,
  );
  assert.deepEqual(counts, [11, 8, 3, 3, 5]);
});

test('accounting dates come only from the company business-day resolver', () => {
  const sql = code();
  const resolver =
    /CREATE FUNCTION north_star_internal\.ledger_business_day\(company uuid, instant timestamptz\) RETURNS date[\s\S]*?END \$\$;/u.exec(
      sql,
    );
  assert.ok(
    resolver,
    'the resolver signature ledger_business_day(company, instant) changed',
  );
  const outside = sql.replace(resolver[0], '');
  for (const [pattern, meaning] of [
    [/AT\s+TIME\s+ZONE/iu, 'a zone conversion'],
    [/::\s*date\b/iu, 'a cast to date'],
    [/\bCAST\s*\([\s\S]*?\bAS\s+date\s*\)/iu, 'a CAST to date'],
    [/\bdate\s*\(/iu, 'a call of the date function'],
    [/\bcurrent_date\b|\blocaltimestamp\b|\bnow\(\)/iu, 'a server-clock date'],
    [
      /inventory_business_period|inventory_tenant_calendars/u,
      'a calendar read',
    ],
    [/session_replication_role/u, 'a replication-role switch'],
  ] as const)
    assert.doesNotMatch(
      outside,
      pattern,
      `ledger SQL outside the resolver contains ${meaning}`,
    );
  assert.doesNotMatch(
    resolver[0],
    /AT\s+TIME\s+ZONE|::\s*date\b|\bCAST\s*\(|\bdate\s*\(/iu,
    'the resolver converts by itself instead of the business-period arithmetic',
  );
  assert.match(resolver[0], /inventory_business_period\(t, instant\)/u);
  // The writer in force is the last one defined.
  const writer = [
    ...sql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION north_star_internal\.ledger_write_entry\([\s\S]*?END \$\$;/gu,
    ),
  ].at(-1);
  assert.ok(writer, 'the entry writer is missing');
  assert.match(
    writer[0],
    /date_basis \? 'instant' THEN\s+entry_day := north_star_internal\.ledger_business_day\(company,/u,
    'the writer dates an instant without the resolver',
  );
});
