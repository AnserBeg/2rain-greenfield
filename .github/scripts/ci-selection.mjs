import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

// Audited leaf-to-test map. Every unlisted source, including new siblings,
// selects full until its coverage has been reviewed.
const billingQuote = [
  'test/integration/billing-quote.test.ts',
  'test/postgres/billing-terms.test.ts',
];
export const sourceCoverage = new Map([
  ...['calendar', 'cover', 'fraction', 'occurrences', 'quote', 'terms'].map(
    (name) => [`packages/domain/src/billing/${name}.ts`, billingQuote],
  ),
  [
    'packages/postgres-provider/src/commercial-amounts.ts',
    [
      'test/unit/commercial-amounts.test.ts',
      'test/postgres/payables.test.ts',
      'test/postgres/receivables.test.ts',
      'test/postgres/commercial-totals.test.ts',
    ],
  ],
  [
    'packages/domain/src/inventory/valuation.ts',
    [
      'test/unit/inventory-valuation.test.ts',
      'test/postgres/inventory-valuation.test.ts',
      'apps/web/test/browser/inventory-valuation.spec.ts',
    ],
  ],
]);

const shared =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|fixtures?|helpers?|[^/]*[-.]fixture(?:\.[^/]*)?|[^/]*gateway[^/]*\.ts)(?:\/|$)|^(?:\.github|db|scripts|packages\/(?:canonical-model|compiler|runtime))\//u;
const nodeFile =
  /^test\/(?:architecture|unit|compiler|agent|integration|postgres)\/(?:[\w-]+\/)*[\w-]+\.test\.ts$/u;
const browserFile =
  /^apps\/web\/test\/browser\/(?:[\w-]+\/)*[\w.-]+\.spec\.ts$/u;
const performance = 'test/compiler/performance-budget.test.ts';
export function selectPaths(changes) {
  const files = new Set();
  for (const { path, status } of changes) {
    if (
      !['A', 'M'].includes(status) ||
      shared.test(path) ||
      path === performance
    )
      return { tier: 'full', reason: path };
    if (sourceCoverage.has(path)) {
      for (const test of sourceCoverage.get(path)) files.add(test);
    } else if (
      nodeFile.test(path) ||
      browserFile.test(path) ||
      path === 'apps/web/test/surface-runtime-contract.test.ts'
    ) {
      files.add(path);
    } else if (
      !/^docs\/(?:[\w.-]+\/)*[\w.-]+\.md$/u.test(path) &&
      !['README.md', 'learnings.md'].includes(path)
    ) {
      return { tier: 'full', reason: path };
    }
  }
  return { tier: 'quick', files: [...files].sort() };
}

export const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export function criticalDiff(base, tip) {
  // Read the definition at the accepted base, including when the packet edits it.
  const doctrine = git('show', `${base}:AGENTS.md`);
  const rules = doctrine.match(
    /<!-- critical-pathspecs -->\n([\s\S]+?)\n<!-- end-critical-pathspecs -->/u,
  )?.[1];
  if (!rules) return true; // Includes the CI-3 bootstrap from the prose-only definition.
  const paths = [...rules.matchAll(/^`([^`\n]+)`$/gmu)].map(
    (match) => match[1],
  );
  if (!paths.length || paths.length !== rules.trim().split('\n').length)
    throw new Error('Malformed Critical pathspecs in AGENTS.md');
  if (
    git('diff', '--no-renames', '--name-only', '-z', base, tip, '--', ...paths)
  )
    return true;
  // RLS/grant SQL can also be embedded in executable source. Search both sides
  // of changed files so a split-line statement or an edited grantee is covered.
  const sql =
    /\b(?:grant\s+(?:all|select|insert|update|delete|truncate|references|trigger|usage|execute|create|connect|temporary|[\w"]+\s+to\b)|revoke\s+\w+|(?:create|alter|drop)\s+policy|row\s+level\s+security)\b/iu;
  for (const path of git(
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    base,
    tip,
    '--',
    'packages',
    'apps',
    'db',
    'scripts',
    '*.sql',
  )
    .split('\0')
    .filter(Boolean)) {
    for (const rev of [base, tip]) {
      if (
        git('ls-tree', '-z', rev, '--', `:(literal)${path}`) &&
        sql.test(git('show', `${rev}:${path}`))
      )
        return true;
    }
  }
  return false;
}

export function selectRange(base, tip) {
  const fields = git(
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    base,
    tip,
  ).split('\0');
  const changes = [];
  for (let i = 0; i < fields.length - 1; i += 2)
    changes.push({ status: fields[i], path: fields[i + 1] });
  const plan = selectPaths(changes);
  if (plan.tier === 'quick' && criticalDiff(base, tip))
    return { tier: 'full', reason: 'Critical diff' };
  if (plan.tier === 'quick') {
    for (const path of [
      ...changes.map((change) => change.path),
      ...plan.files,
    ]) {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isFile())
        return { tier: 'full', reason: path };
    }
  }
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const head = git('rev-parse', 'HEAD').trim();
  const forced =
    process.env.GITHUB_REF === 'refs/heads/main' ||
    event.inputs?.tier === 'full' ||
    (pr && pr.head.repo.full_name !== process.env.GITHUB_REPOSITORY);
  if (
    event.inputs?.expected_head &&
    event.inputs.expected_head !== process.env.GITHUB_SHA
  )
    throw new Error('The packet moved before the requested run started');
  if (
    event.inputs?.merge_sha &&
    (!forced ||
      !/^[0-9a-f]{40}$/u.test(event.inputs.merge_sha) ||
      git('rev-parse', 'HEAD^2').trim() !== process.env.GITHUB_SHA)
  )
    throw new Error(
      'The requested PR merge must have the dispatched head as its second parent',
    );
  const plan = forced
    ? { tier: 'full', reason: 'full requested' }
    : selectRange(
        pr?.base.sha ?? git('merge-base', 'origin/main', head).trim(),
        head,
      );
  const promote = !forced && plan.tier === 'full';
  const files = plan.files ?? [];
  console.log(JSON.stringify({ ...plan, head, promote }));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tier=${plan.tier}\npromote=${Boolean(promote)}\nfiles=${JSON.stringify(files)}\nbrowser=${files.some((path) => browserFile.test(path))}\n`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `CI **${plan.tier}** at \`${head}\`\n\n${JSON.stringify(plan)}\n`,
  );
}
