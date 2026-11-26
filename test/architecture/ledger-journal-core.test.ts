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

// Slice 1a-ii: the person's form for books start is a Task on the company's
// record page, and only a Task that binds `arguments` admits them into the
// operation's compiled contract (the gateway refuses any other key).
test('the released books-start Task binds the operation arguments its contract admits', () => {
  const release = JSON.parse(
    readFileSync('apps/web/release/app.compiled.json', 'utf8'),
  ) as {
    applications: {
      artifacts: { domainTag: string; canonicalBytesBase64: string }[];
    }[];
  };
  const chunks = release.applications
    .at(-1)!
    .artifacts.map(
      (artifact) =>
        [
          artifact.domainTag,
          JSON.parse(
            Buffer.from(artifact.canonicalBytesBase64, 'base64').toString(),
          ) as Record<string, unknown>,
        ] as const,
    );
  const operation = 'northstar.app:operation.bookkeeping_books_start_set';
  const declared = chunks
    .filter(([tag]) => tag.endsWith('projection-family.operation-catalog'))
    .flatMap(
      ([, chunk]) =>
        (chunk.operations ?? []) as {
          operationId: string;
          confirmation: string;
          inputContract: { closedArgumentKeys: string[] };
        }[],
    )
    .find((candidate) => candidate.operationId === operation);
  assert.ok(declared, 'books start is not in the released operation catalog');
  assert.equal(declared.confirmation, 'humanRequired');
  assert.deepEqual(declared.inputContract.closedArgumentKeys, [
    'arguments',
    'expectedRevision',
    'recordId',
  ]);
  const page = chunks
    .filter(([tag]) => tag.endsWith('projection-family.surface-manifest'))
    .flatMap(
      ([, chunk]) =>
        (chunk.surfaces ?? []) as {
          surfaceId: string;
          composition?: {
            actions: {
              steps: {
                operation: { targetId: string };
                bindings: { path: string[] }[];
              }[];
            }[];
          };
        }[],
    )
    .find(
      (surface) =>
        surface.surfaceId === 'northstar.app:surface.legal_entity_detail',
    );
  const step = page?.composition?.actions
    .flatMap((action) => action.steps)
    .find((candidate) => candidate.operation.targetId === operation);
  assert.ok(step, 'the company page offers no books-start Task');
  assert.deepEqual(
    step.bindings.map((binding) => binding.path.join('.')).sort(),
    [
      'arguments.date',
      'arguments.expectedPrior',
      'expectedRevision',
      'recordId',
    ],
  );
  // Putting an account: the same contract, its six arguments bound by its Task.
  const accountPut = 'northstar.app:operation.bookkeeping_account_put';
  const putDeclared = chunks
    .filter(([tag]) => tag.endsWith('projection-family.operation-catalog'))
    .flatMap(
      ([, chunk]) =>
        (chunk.operations ?? []) as {
          operationId: string;
          confirmation: string;
          inputContract: { closedArgumentKeys: string[] };
        }[],
    )
    .find((candidate) => candidate.operationId === accountPut);
  assert.ok(
    putDeclared,
    'account put is not in the released operation catalog',
  );
  assert.equal(putDeclared.confirmation, 'humanRequired');
  assert.deepEqual(putDeclared.inputContract.closedArgumentKeys, [
    'arguments',
    'expectedRevision',
    'recordId',
  ]);
  const putStep = page?.composition?.actions
    .flatMap((action) => action.steps)
    .find((candidate) => candidate.operation.targetId === accountPut);
  assert.ok(putStep, 'the company page offers no account-put Task');
  assert.deepEqual(
    putStep.bindings.map((binding) => binding.path.join('.')).sort(),
    [
      'arguments.active',
      'arguments.code',
      'arguments.expectedActive',
      'arguments.expectedLabel',
      'arguments.kind',
      'arguments.label',
      'expectedRevision',
      'recordId',
    ],
  );
});
