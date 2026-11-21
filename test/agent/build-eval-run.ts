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
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import {
  anthropicModel,
  AGENT_KEY_FILE_VARIABLE,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  meteredNext,
  scriptedModel,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';

import { withAgentWorlds } from './agent-world.js';
import { BUILD_CASES, type BuildCase } from './build-eval-cases.js';
import {
  capturePrompt,
  draftedAheadModel,
  errorText,
  redactSecrets,
  runBuildCase,
  summarize,
  type CapturedPrompt,
  type CaseResult,
  type ModelTurnAhead,
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
      // The eval's cache lifetime (slice 2 cost cuts): the shared prefix must
      // survive the 4-5 minute compiles between requests. The app keeps 5m.
      'cache-ttl': { type: 'string', default: '1h' },
      // USD per million tokens, Anthropic first-party API (Opus 5.5).
      'price-input': { type: 'string', default: '4' },
      'price-output': { type: 'string', default: '20' },
      'price-cache-read': { type: 'string', default: '0.2' },
      // Default: 1.25x input for a 5-minute write, 2x for a 1-hour write.
      'price-cache-write': { type: 'string', default: '' },
      'price-source': {
        type: 'string',
        default: 'https://platform.claude.com/docs/en/about-claude/pricing',
      },
      'price-date': { type: 'string', default: '2026-11-20' },
      split: { type: 'string', default: 'all' },
      cases: { type: 'string' },
      out: { type: 'string', default: 'docs/execution/evidence' },
      // Rescore: replay the drafts recorded in an earlier run's transcripts
      // through a scripted model, so only the scorer runs again. No key.
      replay: { type: 'string' },
      // Draft first (slice 2 cost cuts): capture every case's first request,
      // draft them back to back while the prompt cache is warm, then compile,
      // verify, activate and score each from its saved draft. Repair turns
      // need the compile result, so they stay inline with the 1-hour cache.
      'draft-first': { type: 'boolean', default: true },
      // Where the captured prompts go (scratch, never committed), so a later
      // bake-off sends exactly the in-app requests.
      'prompts-out': { type: 'string' },
      // The isolated compile's bound for this run: a loaded host must not
      // score a slow compile as a failed draft. 0 keeps the app's default.
      'sandbox-ms': { type: 'string', default: '600000' },
    },
  });
  const cap = Number(args.cap);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 50)
    throw new Error('--cap must be a positive number of USD, at most 50');
  const prices = {
    input: Number(args['price-input']),
    output: Number(args['price-output']),
    cacheRead: Number(args['price-cache-read']),
    cacheWrite: args['price-cache-write']
      ? Number(args['price-cache-write'])
      : Number(args['price-input']) * (args['cache-ttl'] === '5m' ? 1.25 : 2),
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

  // `--replay A[,B]`: results come from A; a case's draft from the last of
  // the directories whose transcript recorded a model turn for it.
  const replays = args.replay?.split(',').map((dir) => resolve(dir));
  const replay = replays?.[0];
  if (replay && !wanted) throw new Error('--replay needs --cases');
  const earlier = replay
    ? (JSON.parse(await readFile(join(replay, 'results.json'), 'utf8')) as {
        model: string;
        results: CaseResult[];
      })
    : undefined;
  // Only the file named by the variable: an ambient key does not count.
  const key = replay
    ? undefined
    : await loadModelKey('anthropic', {
        [AGENT_KEY_FILE_VARIABLE]: process.env[AGENT_KEY_FILE_VARIABLE],
      });
  const secrets = key ? [key.reveal()] : [];
  const model = key
    ? anthropicModel({
        effort: args.effort as 'medium',
        key,
        maxTokens: 8_000,
        modelId: String(args.model),
        cacheTtl: args['cache-ttl'] === '5m' ? '5m' : '1h',
      })
    : undefined;
  const meter = new SpendMeter(prices, cap);
  const sandboxMs = Number(args['sandbox-ms']) || undefined;

  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const directory = join(
    resolve(String(args.out)),
    `${date}-build-eval-${replay ? 'rescore-' : ''}${stamp}`,
  );
  await mkdir(directory, { recursive: true });
  const say = (line: string) =>
    process.stdout.write(`${redactSecrets(line, secrets)}\n`);

  const results: CaseResult[] = [];
  const mismatched: string[] = [];
  await withAgentWorlds('build-eval', async (worlds) => {
    const ahead = new Map<
      string,
      { prompt: CapturedPrompt; turn: ModelTurnAhead }
    >();
    if (model && args['draft-first']) {
      const prompts: CapturedPrompt[] = [];
      for (const c of cases) {
        const world = await worlds.fresh(`capture-${c.id}`);
        try {
          prompts.push(await capturePrompt(world, c, sandboxMs));
          say(`${c.id}: prompt captured`);
        } catch (error) {
          say(`${c.id}: prompt not captured: ${errorText(error, secrets)}`);
        } finally {
          await world.close();
        }
      }
      const promptsOut = args['prompts-out'];
      if (promptsOut) {
        await mkdir(resolve(promptsOut), { recursive: true });
        for (const prompt of prompts)
          await writeFile(
            join(resolve(promptsOut), `${prompt.id}.json`),
            redactSecrets(JSON.stringify(prompt), secrets),
          );
      }
      // The drafts, back to back. Charged here only to keep the cap; the
      // scoring phase charges the same turn to the run's meter.
      const draftMeter = new SpendMeter(prices, cap);
      for (const prompt of prompts) {
        if (draftMeter.exhausted()) break;
        const started = performance.now();
        try {
          const { turn } = await meteredNext(model, draftMeter, {
            system: prompt.system,
            tools: prompt.tools,
            conversation: prompt.conversation,
          });
          ahead.set(prompt.id, {
            prompt,
            turn: {
              ...turn,
              recordedLatencyMs: Math.round(performance.now() - started),
            },
          });
          say(
            `${prompt.id}: drafted ahead · cache read ${String(turn.usage.cacheReadTokens)} · total $${draftMeter.usd.toFixed(4)}`,
          );
        } catch (error) {
          say(`${prompt.id}: not drafted ahead: ${errorText(error, secrets)}`);
        }
      }
    }
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
        const recorded = replays
          ? await recordedTurns(replays, c.id)
          : undefined;
        const drafted = ahead.get(c.id);
        const result = await runBuildCase(world, c, {
          provider: () =>
            model && drafted
              ? draftedAheadModel(drafted, model, () => mismatched.push(c.id))
              : (model ??
                scriptedModel(recorded!.turns.map((turn) => () => turn))),
          ...(model ? { meter } : {}),
          ...(sandboxMs ? { sandboxWallClockMilliseconds: sandboxMs } : {}),
          log,
        });
        if (recorded) {
          // The model's own cost and time are the recorded run's.
          Object.assign(result, recorded.model);
          log({ kind: 'replayed', from: replays, model: recorded.model });
        }
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

  if (earlier)
    results.splice(
      0,
      results.length,
      ...earlier.results.map(
        (row) => results.find((r) => r.id === row.id) ?? row,
      ),
    );
  const modelId = model?.modelId ?? earlier!.model;
  const summary = summarize(results);
  await writeFile(
    join(directory, 'results.json'),
    redactSecrets(
      JSON.stringify(
        {
          model: modelId,
          effort: args.effort,
          ...(replay ? { rescoredFrom: replay, rescored: wanted } : {}),
          draftFirst: !!(model && args['draft-first']),
          // Cases whose in-app first request differed from the captured one
          // (their first turn was then drafted live, not ahead).
          promptMismatches: mismatched,
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
        model: modelId,
        effort: String(args.effort),
        rescored: replay ? wanted : undefined,
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

/** The tool calls an earlier run's model made for one case, turn by turn. */
async function recordedTurns(directories: readonly string[], id: string) {
  let text = '';
  for (const directory of directories)
    try {
      const candidate = await readFile(join(directory, `${id}.jsonl`), 'utf8');
      if (candidate.includes('"kind":"model"')) text = candidate;
    } catch {
      // Not recorded in this directory.
    }
  const lines = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const turns = lines
    .filter((line) => line.kind === 'model')
    .map((line) => ({
      text: String(line.text ?? ''),
      toolCalls: (line.toolCalls as { name: string; input: unknown }[]).map(
        ({ name, input }) => ({ name, input }),
      ),
    }));
  const verdict = lines.find((line) => line.kind === 'verdict') as
    CaseResult | undefined;
  if (!turns.length || !verdict) throw new Error(`no recorded draft for ${id}`);
  const { modelCalls, modelMs, usd, tokens } = verdict;
  return { turns, model: { modelCalls, modelMs, usd, tokens } };
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
    repairTurns: null,
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
    rescored?: readonly string[] | undefined;
  },
): string {
  const cell = (text: string) =>
    text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const split = (name: 'dev' | 'test') =>
    summarize(results.filter((r) => r.split === name));
  const dev = split('dev');
  const test = split('test');
  const added = new Set(
    BUILD_CASES.filter((c) => c.added === 'slice2').map((c) => c.id),
  );
  const slice1 = summarize(results.filter((r) => !added.has(r.id)));
  const slice2 = summarize(results.filter((r) => added.has(r.id)));
  const ran = results.filter((r) => r.status !== 'not-run');
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  return [
    `# AI-BUILD-1 module-building eval — ${run.date}`,
    '',
    ...(run.rescored
      ? [
          `Rescored ${run.rescored.join(', ')} by replaying the drafts recorded in the live run through a scripted model, after a scorer fix; their model calls, time and spend are the live run's.`,
          '',
        ]
      : []),
    `Model \`${run.model}\`, effort ${run.effort}, 8000 output tokens: the in-app drafting settings. Real in-app path per request on a fresh copy of the distributor demo database: draftFromRequest → approve → activate, then create, transition and list. One attempt per request; indicative only. Workflows are scored on the goods-receipt trigger only (the only trigger today). Prices (USD/MTok) from ${run.source}, ${run.priceDate}: ${Object.entries(
      run.prices,
    )
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}. Spend cap USD ${String(run.cap)}.`,
    '',
    '| measure | all | dev | held-out test | slice 1 set (30) | slice 2 additions |',
    '|---|---|---|---|---|---|',
    ...(
      [
        ['requests run', (x) => String(x.ran)],
        ['verified first try (draftable)', (x) => x.firstTry],
        ['verified after repair (draftable)', (x) => x.afterRepair],
        [
          'rescued by repair turn 1 / turn 2',
          (x) =>
            `${String(x.repairedAfterOne)} / ${String(x.repairedAfterTwo)}`,
        ],
        ['end to end (draftable)', (x) => x.e2e],
        ['behaviour correct (all)', (x) => x.behaviour],
        ['correct refusals', (x) => x.correctRefusals],
        ['refusal names the right capability', (x) => x.rightReason],
        [
          'false refusals / false accepts',
          (x) => `${String(x.falseRefusals)} / ${String(x.falseAccepts)}`,
        ],
        ['hostile probes that changed the calls', (x) => String(x.injected)],
        ['over-granted workflows', (x) => String(x.overGranted)],
        ['model calls', (x) => String(x.modelCalls)],
        ['spend USD', (x) => x.usd.toFixed(4)],
        [
          'tokens in / out / cache read / cache write',
          (x) =>
            `${String(x.tokens.input)} / ${String(x.tokens.output)} / ${String(x.tokens.cacheRead)} / ${String(x.tokens.cacheWrite)}`,
        ],
      ] as [string, (x: typeof summary) => string][]
    ).map(
      ([name, cellOf]) =>
        `| ${name} | ${cellOf(summary)} | ${cellOf(dev)} | ${cellOf(test)} | ${cellOf(slice1)} | ${cellOf(slice2)} |`,
    ),
    '',
    `Median model latency per request ${(median(ran.map((r) => r.modelMs)) / 1000).toFixed(1)} s; median wall time per request (draft, compile, approve, activate, score) ${(median(ran.map((r) => r.wallMs)) / 1000).toFixed(1)} s.`,
    '',
    `Refusals by capability (correct / false): ${
      Object.entries(summary.refusalsByCapability)
        .map(([k, v]) => `${k} ${String(v.correct)}/${String(v.false)}`)
        .join('; ') || 'none'
    }.`,
    '',
    '| id | split | category | expected | status | calls | first try | after repair | e2e | behaviour | model s | wall s | USD | cache read | reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.split} | ${r.category} | ${r.expected} | ${r.status}${r.missingCapability ? ` (${cell(r.missingCapability)})` : ''} | ${String(r.modelCalls)} | ${r.firstTry ? 'yes' : 'no'} | ${r.afterRepair ? 'yes' : 'no'} | ${r.e2e === null ? '—' : r.e2e ? 'yes' : 'no'} | ${r.behaviour ? 'pass' : 'fail'} | ${(r.modelMs / 1000).toFixed(1)} | ${(r.wallMs / 1000).toFixed(1)} | ${r.usd.toFixed(4)} | ${String(r.tokens.cacheRead)} | ${cell(r.reasons.join('; ').slice(0, 400))} |`,
    ),
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  // A missing key names the variable only (MissingModelKeyError's message).
  process.stderr.write(`BUILD_EVAL_FAILED ${errorText(error)}\n`);
  process.exitCode = 1;
});
