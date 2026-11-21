/**
 * AI-BUILD-1: one scorecard from several live-eval directories of the SAME
 * drafter and first drafts (a scoring process that stopped part-way and its
 * resume). Later directories win for a case scored in both. No model call.
 *
 *   node --import tsx test/agent/build-eval-combine.ts --inputs A,B --out C
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BUILD_CASES } from './build-eval-cases.js';
import { summarize, type CaseResult } from './build-eval.js';

async function load(directory: string) {
  for (const name of ['results.json', 'results.partial.json'])
    try {
      const parsed = JSON.parse(
        await readFile(join(directory, name), 'utf8'),
      ) as { head?: string; results: CaseResult[] };
      return { file: name, ...parsed };
    } catch {
      // Try the next name.
    }
  throw new Error(`no results in ${directory}`);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      inputs: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!args.inputs || !args.out) throw new Error('--inputs and --out');
  const byId = new Map<string, CaseResult & { from: string }>();
  const heads = new Set<string>();
  for (const directory of args.inputs.split(',').map((d) => resolve(d))) {
    const loaded = await load(directory);
    if (loaded.head) heads.add(loaded.head);
    for (const result of loaded.results)
      if (result.status !== 'not-run')
        byId.set(result.id, { ...result, from: directory });
  }
  const order = BUILD_CASES.map((c) => c.id);
  const results = [...byId.values()].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );
  const added = new Set(
    BUILD_CASES.filter((c) => c.added === 'slice2').map((c) => c.id),
  );
  const sets: [string, CaseResult[]][] = [
    ['all', results],
    ['dev', results.filter((r) => r.split === 'dev')],
    ['held-out', results.filter((r) => r.split === 'test')],
    ['slice 1 set', results.filter((r) => !added.has(r.id))],
    ['slice 2 additions', results.filter((r) => added.has(r.id))],
  ];
  const summaries = sets.map(([name, set]) => [name, summarize(set)] as const);
  const cell = (text: string) =>
    text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows: [string, (s: ReturnType<typeof summarize>) => string][] = [
    ['requests scored', (s) => String(s.ran)],
    ['verified first try (draftable)', (s) => s.firstTry],
    ['verified after repair (draftable)', (s) => s.afterRepair],
    ['end to end (draftable)', (s) => s.e2e],
    ['behaviour correct (all)', (s) => s.behaviour],
    ['correct refusals', (s) => s.correctRefusals],
    ['refusal names the right capability', (s) => s.rightReason],
    [
      'false refusals / false accepts',
      (s) => `${String(s.falseRefusals)} / ${String(s.falseAccepts)}`,
    ],
    ['hostile probes that changed the calls', (s) => String(s.injected)],
    ['over-granted workflows', (s) => String(s.overGranted)],
    ['model calls', (s) => String(s.modelCalls)],
    ['spend USD (scored cases)', (s) => s.usd.toFixed(4)],
    [
      'cache read / cache write tokens',
      (s) => `${String(s.tokens.cacheRead)} / ${String(s.tokens.cacheWrite)}`,
    ],
  ];
  const summary = [
    '# AI-BUILD-1 slice 2 live eval — combined scorecard',
    '',
    `Drafter at ${[...heads].map((h) => `\`${h}\``).join(', ')}; one scoring pass that stopped when its database container exited, and its resume, both from the same saved first drafts. Inputs: ${args.inputs}.`,
    '',
    `| measure | ${summaries.map(([name]) => name).join(' | ')} |`,
    `|---|${summaries.map(() => '---').join('|')}|`,
    ...rows.map(
      ([name, of]) =>
        `| ${name} | ${summaries.map(([, s]) => of(s)).join(' | ')} |`,
    ),
    '',
    '| id | split | category | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.split} | ${r.category} | ${r.status}${r.missingCapability ? ` (${cell(r.missingCapability)})` : ''} | ${String(r.modelCalls)} | ${r.firstTry ? 'yes' : 'no'} | ${r.afterRepair ? 'yes' : 'no'} | ${r.e2e === null ? '—' : r.e2e ? 'yes' : 'no'} | ${r.behaviour ? 'pass' : 'fail'} | ${(r.modelMs / 1000).toFixed(1)} | ${(r.wallMs / 1000).toFixed(1)} | ${r.usd.toFixed(4)} | ${cell(r.reasons.join('; ').slice(0, 300))} |`,
    ),
    '',
  ].join('\n');
  await mkdir(resolve(args.out), { recursive: true });
  await writeFile(
    join(resolve(args.out), 'combined-results.json'),
    JSON.stringify(
      { heads: [...heads], summary: Object.fromEntries(summaries), results },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(resolve(args.out), 'combined-summary.md'), summary);
  process.stdout.write(`${summary.split('\n').slice(0, 20).join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`BUILD_EVAL_COMBINE_FAILED ${String(error)}\n`);
  process.exitCode = 1;
});
