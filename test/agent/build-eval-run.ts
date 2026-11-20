/**
 * AI-BUILD-1: the live module-building eval. LOCAL ONLY, against a fresh copy
 * of the local demo database per request; CI runs the same core with scripted
 * models (`test/postgres/build-eval.test.ts`).
 *
 *   NORTH_STAR_AGENT_KEY_FILE=/path/.env node --import tsx test/agent/build-eval-run.ts --cap 15
 *
 * The key is read ONLY from the file named by NORTH_STAR_AGENT_KEY_FILE
 * (`CLUADE_API_KEY`); an ambient environment key is ignored. No key value or
 * line of the file is printed, logged or written: every transcript line passes
 * through `redactSecrets`, with the key itself on the list. A missing key
 * fails naming the variable. The drafting model is the one the app uses
 * (`DEFAULT_ANTHROPIC_MODEL`, effort medium, 8000 output tokens). The run
 * stops starting requests once spend reaches the cap; requests it did not
 * start are reported as not run, never as failures.
 *
 * Writes `docs/execution/evidence/<date>-build-eval-<stamp>/`: one JSONL
 * transcript per request, `results.json` and `summary.md`.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  anthropicModel,
  AGENT_KEY_FILE_VARIABLE,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';

import { withAgentWorlds } from './agent-world.js';
import { BUILD_CASES, type BuildCase } from './build-eval-cases.js';
import {
  errorText,
  redactSecrets,
  runBuildCase,
  summarize,
  type CaseResult,
} from './build-eval.js';

async function main(): Promise<void> {
  if (process.env.CI)
    throw new Error('the live eval never runs in CI; CI uses scripted models');
  const { values: args } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      cap: { type: 'string', default: '15' },
      model: { type: 'string', default: DEFAULT_ANTHROPIC_MODEL },
      effort: { type: 'string', default: 'medium' },
      // USD per million tokens, Anthropic first-party API (Opus 5.5).
      'price-input': { type: 'string', default: '4' },
      'price-output': { type: 'string', default: '20' },
      'price-cache-read': { type: 'string', default: '0.2' },
      'price-cache-write': { type: 'string', default: '5' },
      'price-source': {
        type: 'string',
        default: 'https://platform.claude.com/docs/en/about-claude/pricing',
      },
      'price-date': { type: 'string', default: '2026-11-20' },
      split: { type: 'string', default: 'all' },
      cases: { type: 'string' },
      out: { type: 'string', default: 'docs/execution/evidence' },
    },
  });
  const cap = Number(args.cap);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 50)
    throw new Error('--cap must be a positive number of USD, at most 50');
  const prices = {
    input: Number(args['price-input']),
    output: Number(args['price-output']),
    cacheRead: Number(args['price-cache-read']),
    cacheWrite: Number(args['price-cache-write']),
  };
  if (Object.values(prices).some((p) => !Number.isFinite(p) || p < 0))
    throw new Error('prices must be non-negative numbers');
  const wanted = args.cases?.split(',').map((id) => id.trim());
  const cases = BUILD_CASES.filter(
    (c) =>
      (args.split === 'all' || c.split === args.split) &&
      (!wanted || wanted.includes(c.id)),
  );
  if (!cases.length) throw new Error('no cases selected');

  // Only the file named by the variable: an ambient key does not count.
  const key = await loadModelKey('anthropic', {
    [AGENT_KEY_FILE_VARIABLE]: process.env[AGENT_KEY_FILE_VARIABLE],
  });
  const secrets = [key.reveal()];
  const model = anthropicModel({
    effort: args.effort as 'medium',
    key,
    maxTokens: 8_000,
    modelId: String(args.model),
  });
  const meter = new SpendMeter(prices, cap);

  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const directory = join(
    resolve(String(args.out)),
    `${date}-build-eval-${stamp}`,
  );
  await mkdir(directory, { recursive: true });
  const say = (line: string) =>
    process.stdout.write(`${redactSecrets(line, secrets)}\n`);

  const results: CaseResult[] = [];
  await withAgentWorlds('build-eval', async (worlds) => {
    for (const c of cases) {
      if (meter.exhausted()) {
        results.push(notRun(c));
        say(`${c.id}: not run (spend cap reached)`);
        continue;
      }
      const record = join(directory, `${c.id}.jsonl`);
      let queue = Promise.resolve();
      const log = (entry: Record<string, unknown>) => {
        const line = redactSecrets(
          JSON.stringify({ at: new Date().toISOString(), ...entry }),
          secrets,
        );
        queue = queue.then(() => appendFile(record, `${line}\n`));
      };
      say(`${c.id} (${c.split}, ${c.category}): ${c.request}`);
      const world = await worlds.fresh(`build-${c.id}`);
      try {
        const result = await runBuildCase(world, c, {
          provider: () => model,
          meter,
          log,
        });
        results.push(result);
        say(
          `  ${result.behaviour ? 'PASS' : 'FAIL'} ${result.status} · calls ${String(result.modelCalls)} · e2e ${String(result.e2e)} · ${(result.modelMs / 1000).toFixed(1)} s model / ${(result.wallMs / 1000).toFixed(1)} s wall · $${result.usd.toFixed(4)} (total $${meter.usd.toFixed(4)})${result.reasons.length ? ` · ${result.reasons.slice(0, 3).join('; ')}` : ''}`,
        );
      } catch (error) {
        say(`  HARNESS ERROR ${errorText(error, secrets)}`);
        results.push({
          ...notRun(c),
          status: 'harness-error',
          reasons: [errorText(error, secrets)],
        });
      } finally {
        await queue;
        await world.close();
      }
    }
  });

  const summary = summarize(results);
  await writeFile(
    join(directory, 'results.json'),
    redactSecrets(
      JSON.stringify(
        {
          model: model.modelId,
          effort: args.effort,
          cap,
          prices,
          summary,
          results,
        },
        null,
        2,
      ),
      secrets,
    ) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(directory, 'summary.md'),
    redactSecrets(
      report(results, summary, {
        model: model.modelId,
        effort: String(args.effort),
        cap,
        prices,
        source: String(args['price-source']),
        priceDate: String(args['price-date']),
        date,
      }),
      secrets,
    ),
    { flag: 'wx' },
  );
  say(`\n${JSON.stringify(summary)}\n${directory}`);
}

function notRun(c: BuildCase): CaseResult {
  return {
    id: c.id,
    split: c.split,
    category: c.category,
    expected: c.expect.outcome,
    status: 'not-run',
    modelCalls: 0,
    drafted: false,
    approved: false,
    activated: false,
    firstTry: false,
    afterRepair: false,
    e2e: null,
    behaviour: false,
    reasons: ['not run: spend cap reached'],
    kinds: [],
    modelMs: 0,
    wallMs: 0,
    usd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function report(
  results: readonly CaseResult[],
  summary: ReturnType<typeof summarize>,
  run: {
    model: string;
    effort: string;
    cap: number;
    prices: Record<string, number>;
    source: string;
    priceDate: string;
    date: string;
  },
): string {
  const cell = (text: string) =>
    text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const split = (name: 'dev' | 'test') =>
    summarize(results.filter((r) => r.split === name));
  const dev = split('dev');
  const test = split('test');
  const ran = results.filter((r) => r.status !== 'not-run');
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  return [
    `# AI-BUILD-1 module-building eval — ${run.date}`,
    '',
    `Model \`${run.model}\`, effort ${run.effort}, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from ${run.source}, ${run.priceDate}: ${Object.entries(
      run.prices,
    )
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}. Spend cap USD ${String(run.cap)}.`,
    '',
    '| measure | all | dev | held-out test |',
    '|---|---|---|---|',
    `| requests run | ${String(summary.ran)} | ${String(dev.ran)} | ${String(test.ran)} |`,
    `| verified first try (draftable) | ${summary.firstTry} | ${dev.firstTry} | ${test.firstTry} |`,
    `| verified after repair (draftable) | ${summary.afterRepair} | ${dev.afterRepair} | ${test.afterRepair} |`,
    `| end to end (draftable) | ${summary.e2e} | ${dev.e2e} | ${test.e2e} |`,
    `| behaviour correct (all) | ${summary.behaviour} | ${dev.behaviour} | ${test.behaviour} |`,
    `| correct refusals | ${summary.correctRefusals} | ${dev.correctRefusals} | ${test.correctRefusals} |`,
    `| refusal names the right capability | ${summary.rightReason} | ${dev.rightReason} | ${test.rightReason} |`,
    `| false refusals / false accepts | ${String(summary.falseRefusals)} / ${String(summary.falseAccepts)} | ${String(dev.falseRefusals)} / ${String(dev.falseAccepts)} | ${String(test.falseRefusals)} / ${String(test.falseAccepts)} |`,
    `| hostile probes that changed the calls | ${String(summary.injected)} | ${String(dev.injected)} | ${String(test.injected)} |`,
    `| over-granted workflows | ${String(summary.overGranted)} | ${String(dev.overGranted)} | ${String(test.overGranted)} |`,
    `| model calls | ${String(summary.modelCalls)} | ${String(dev.modelCalls)} | ${String(test.modelCalls)} |`,
    `| spend USD | ${summary.usd.toFixed(4)} | ${dev.usd.toFixed(4)} | ${test.usd.toFixed(4)} |`,
    '',
    `Median model latency per request ${(median(ran.map((r) => r.modelMs)) / 1000).toFixed(1)} s; median wall time per request (draft, compile, approve, activate, score) ${(median(ran.map((r) => r.wallMs)) / 1000).toFixed(1)} s.`,
    '',
    `Refusals by capability (correct / false): ${
      Object.entries(summary.refusalsByCapability)
        .map(([k, v]) => `${k} ${String(v.correct)}/${String(v.false)}`)
        .join('; ') || 'none'
    }.`,
    '',
    '| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.split} | ${r.category} | ${r.expected} | ${r.status}${r.missingCapability ? ` (${cell(r.missingCapability)})` : ''} | ${String(r.modelCalls)} | ${r.firstTry ? 'yes' : 'no'} | ${r.afterRepair ? 'yes' : 'no'} | ${r.e2e === null ? '—' : r.e2e ? 'yes' : 'no'} | ${r.behaviour ? 'pass' : 'fail'} | ${(r.modelMs / 1000).toFixed(1)} | ${(r.wallMs / 1000).toFixed(1)} | ${r.usd.toFixed(4)} | ${cell(r.reasons.join('; ').slice(0, 400))} |`,
    ),
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  // A missing key names the variable only (MissingModelKeyError's message).
  process.stderr.write(`BUILD_EVAL_FAILED ${errorText(error)}\n`);
  process.exitCode = 1;
});
