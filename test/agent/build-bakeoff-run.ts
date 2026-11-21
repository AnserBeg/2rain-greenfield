/**
 * AI-BUILD-1 slice 3: the drafting-model bake-off. LOCAL ONLY; CI never runs
 * it (CI uses scripted models only).
 *
 *   NORTH_STAR_AGENT_KEY_FILE=/path/.env node --import tsx test/agent/build-bakeoff-run.ts \
 *     --prompts <dir captured by build-eval-run --prompts-out> --cap 12
 *
 * Keys come only from the file named by NORTH_STAR_AGENT_KEY_FILE
 * (`CLUADE_API_KEY`, `OPENAI_API_KEY`); ambient keys are ignored. No value is
 * printed, logged or written: every line passes `redactSecrets` with the keys.
 *
 * Same requests, same prompt and repair code as the slice 2 run. Per
 * candidate: every first draft is made back to back from the captured
 * in-app requests (warm cache, latency measured), then each is scored on the
 * real in-app path from its saved draft, repairs live. Screening runs a
 * stratified 12; `--cases` runs any set. The run stops starting calls once
 * the shared meter reaches the cap.
 */
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import {
  AGENT_KEY_FILE_VARIABLE,
  anthropicModel,
  loadModelKey,
  meteredNext,
  SpendMeter,
  type ModelAdapter,
  type ModelKey,
} from '../../packages/operations-agent/src/index.js';
import { openAiModel } from '../../packages/operations-agent/src/openai-model.js';

import { withAgentWorlds } from './agent-world.js';
import { BUILD_CASES, type BuildCase } from './build-eval-cases.js';
import {
  draftedAheadModel,
  errorText,
  redactSecrets,
  runBuildCase,
  summarize,
  type CapturedPrompt,
  type CaseResult,
  type ModelTurnAhead,
} from './build-eval.js';

interface Candidate {
  readonly name: string;
  readonly provider: 'anthropic' | 'openai';
  readonly modelId: string;
  readonly effort?: string;
  /** USD per million tokens (charter price re-check, 2026-11-21). */
  readonly prices: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const anthropicPrices = (input: number, output: number) => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite: input * 2, // one-hour cache writes
});
const openAiPrices = (input: number, output: number) => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite: 0,
});

export const CANDIDATES: readonly Candidate[] = [
  {
    name: 'haiku-5-5',
    provider: 'anthropic',
    modelId: 'claude-haiku-5-5',
    prices: anthropicPrices(0.1, 0.5),
  },
  {
    name: 'sonnet-5-5',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5-5',
    effort: 'medium',
    prices: anthropicPrices(2, 10),
  },
  {
    name: 'opus-5-5-low',
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'low',
    prices: anthropicPrices(4, 20),
  },
  {
    name: 'opus-5-5-medium',
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'medium',
    prices: anthropicPrices(4, 20),
  },
  {
    name: 'opus-5-5-high',
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'high',
    prices: anthropicPrices(4, 20),
  },
  {
    name: 'fable-5-2',
    provider: 'anthropic',
    modelId: 'claude-fable-5-2',
    effort: 'medium',
    prices: anthropicPrices(8, 40),
  },
  {
    name: 'gpt-6.2-sol',
    provider: 'openai',
    modelId: 'gpt-6.2-sol',
    effort: 'medium',
    prices: openAiPrices(2, 10),
  },
  {
    name: 'gpt-6.2-astra',
    provider: 'openai',
    modelId: 'gpt-6.2-astra',
    effort: 'medium',
    prices: openAiPrices(8, 40),
  },
  {
    name: 'gpt-6.1-terra',
    provider: 'openai',
    modelId: 'gpt-6.1-terra',
    effort: 'medium',
    prices: openAiPrices(1, 5),
  },
  {
    name: 'gpt-6-luna',
    provider: 'openai',
    modelId: 'gpt-6-luna',
    prices: openAiPrices(0.1, 0.5),
  },
];

/** The stratified screening set: every request type, dev and held-out. */
export const SCREEN_CASES = [
  'F02',
  'T04',
  'N06',
  'H02',
  'M03',
  'M04',
  'N02',
  'M07',
  'N03',
  'W02',
  'N08',
  'U02',
] as const;

export type RequestType =
  | 'single change'
  | 'whole module'
  | 'module + lines + board'
  | 'workflow'
  | 'refusal';

export function requestType(c: BuildCase): RequestType {
  const expect = c.expect;
  if (expect.outcome === 'unsupported') return 'refusal';
  if (expect.outcome === 'workflow') return 'workflow';
  if (expect.outcome === 'board') return 'single change';
  if (expect.types.some((t) => t.board)) return 'module + lines + board';
  return expect.types.every((t) => t.existing)
    ? 'single change'
    : 'whole module';
}

function adapter(
  candidate: Candidate,
  keys: { anthropic?: ModelKey; openai?: ModelKey },
): ModelAdapter {
  if (candidate.provider === 'anthropic')
    return anthropicModel({
      key: keys.anthropic!,
      modelId: candidate.modelId,
      ...(candidate.effort ? { effort: candidate.effort as 'medium' } : {}),
      maxTokens: 8_000,
      cacheTtl: '1h',
    });
  return openAiModel({
    key: keys.openai!,
    modelId: candidate.modelId,
    ...(candidate.effort ? { effort: candidate.effort as 'medium' } : {}),
    maxTokens: 8_000,
  });
}

async function main(): Promise<void> {
  if (process.env.CI)
    throw new Error('the bake-off never runs in CI; CI uses scripted models');
  const { values: args } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      prompts: { type: 'string' },
      cap: { type: 'string', default: '12' },
      candidates: { type: 'string' },
      cases: { type: 'string', default: SCREEN_CASES.join(',') },
      concurrency: { type: 'string', default: '1' },
      label: { type: 'string', default: 'screen' },
      out: { type: 'string', default: 'docs/execution/evidence' },
      // Spend already made by earlier phases of the same bake-off.
      spent: { type: 'string', default: '0' },
    },
  });
  if (!args.prompts) throw new Error('--prompts is required');
  const cap = Number(args.cap);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 50)
    throw new Error('--cap must be a positive number of USD, at most 50');
  const wanted = args.cases.split(',').map((id) => id.trim());
  const cases = BUILD_CASES.filter((c) => wanted.includes(c.id));
  const candidates = args.candidates
    ? CANDIDATES.filter((c) => args.candidates!.split(',').includes(c.name))
    : CANDIDATES;
  if (!cases.length || !candidates.length)
    throw new Error('no cases or candidates selected');

  const environment = {
    [AGENT_KEY_FILE_VARIABLE]: process.env[AGENT_KEY_FILE_VARIABLE],
  };
  const keys: { anthropic?: ModelKey; openai?: ModelKey } = {};
  if (candidates.some((c) => c.provider === 'anthropic'))
    keys.anthropic = await loadModelKey('anthropic', environment);
  if (candidates.some((c) => c.provider === 'openai'))
    keys.openai = await loadModelKey('openai', environment);
  const secrets = Object.values(keys).map((key) => key.reveal());

  const prompts = new Map<string, CapturedPrompt>();
  for (const file of await readdir(resolve(args.prompts)))
    if (file.endsWith('.json')) {
      const prompt = JSON.parse(
        await readFile(join(resolve(args.prompts), file), 'utf8'),
      ) as CapturedPrompt;
      prompts.set(prompt.id, prompt);
    }

  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const directory = join(
    resolve(args.out),
    `${date}-build-bakeoff-${args.label}-${stamp}`,
  );
  await mkdir(directory, { recursive: true });
  const say = (line: string) =>
    process.stdout.write(`${redactSecrets(line, secrets)}\n`);
  // One shared spend across every candidate and phase.
  let spent = Number(args.spent);
  const exhausted = () => spent >= cap;

  const all: (CaseResult & { candidate: string; type: RequestType })[] = [];
  await withAgentWorlds('build-bakeoff', async (worlds) => {
    for (const candidate of candidates) {
      if (exhausted()) break;
      const priced = new SpendMeter(candidate.prices, cap - spent);
      const live = adapter(candidate, keys);
      // Phase 2: first drafts back to back.
      const ahead = new Map<
        string,
        { prompt: CapturedPrompt; turn: ModelTurnAhead }
      >();
      for (const c of cases) {
        const prompt = prompts.get(c.id);
        if (!prompt || priced.exhausted()) continue;
        const started = performance.now();
        try {
          const { turn } = await meteredNext(live, priced, {
            system: prompt.system,
            tools: prompt.tools,
            conversation: prompt.conversation,
          });
          ahead.set(c.id, {
            prompt,
            turn: {
              ...turn,
              recordedLatencyMs: Math.round(performance.now() - started),
            },
          });
          say(
            `${candidate.name} ${c.id}: drafted ahead in ${((performance.now() - started) / 1000).toFixed(1)} s · cache read ${String(turn.usage.cacheReadTokens)} · candidate $${priced.usd.toFixed(4)}`,
          );
        } catch (error) {
          say(
            `${candidate.name} ${c.id}: draft failed: ${errorText(error, secrets)}`,
          );
        }
      }
      const draftSpend = priced.usd;
      // Phase 3: score each on the in-app path; turn 1 replays, repairs live.
      // The scoring meter re-charges each replayed first turn, so its cap
      // carries the draft phase's spend too.
      const scoring = new SpendMeter(
        candidate.prices,
        cap - spent + draftSpend,
      );
      const mismatched = new Set<string>();
      const queue = [...cases];
      const results: (CaseResult & { candidate: string; type: RequestType })[] =
        [];
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          const drafted = ahead.get(c.id);
          if (!drafted) continue;
          const record = join(directory, `${candidate.name}-${c.id}.jsonl`);
          let lines = Promise.resolve();
          const log = (entry: Record<string, unknown>) => {
            const line = redactSecrets(
              JSON.stringify({ at: new Date().toISOString(), ...entry }),
              secrets,
            );
            lines = lines.then(() => appendFile(record, `${line}\n`));
          };
          const world = await worlds.fresh(`bake-${candidate.name}-${c.id}`);
          try {
            const result = await runBuildCase(world, c, {
              provider: () =>
                draftedAheadModel(drafted, live, () => {
                  mismatched.add(c.id);
                  log({ kind: 'prompt-mismatch' });
                }),
              meter: scoring,
              log,
            });
            results.push({
              ...result,
              candidate: candidate.name,
              type: requestType(c),
            });
            say(
              `  ${candidate.name} ${c.id}: ${result.behaviour ? 'PASS' : 'FAIL'} ${result.status} · calls ${String(result.modelCalls)} · $${result.usd.toFixed(4)}${result.reasons.length ? ` · ${result.reasons.slice(0, 2).join('; ')}` : ''}`,
            );
          } catch (error) {
            say(
              `  ${candidate.name} ${c.id}: HARNESS ERROR ${errorText(error, secrets)}`,
            );
          } finally {
            await lines;
            await world.close();
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker),
      );
      // The scoring meter re-charged the first turns: spend is draft-phase
      // spend plus scoring spend minus the replayed first turns.
      const tally = new SpendMeter(candidate.prices, Number.POSITIVE_INFINITY);
      for (const r of results)
        if (!mismatched.has(r.id) && ahead.has(r.id))
          tally.charge(ahead.get(r.id)!.turn.usage);
      const candidateSpend = draftSpend + scoring.usd - tally.usd;
      spent += candidateSpend;
      all.push(...results);
      say(
        `${candidate.name}: ${JSON.stringify(summarize(results))} · candidate spend $${candidateSpend.toFixed(4)} · bake-off total $${spent.toFixed(4)}`,
      );
      await writeFile(
        join(directory, `results-${candidate.name}.json`),
        redactSecrets(
          JSON.stringify(
            { candidate, spend: candidateSpend, results },
            null,
            2,
          ),
          secrets,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  });
  await writeFile(
    join(directory, 'summary.md'),
    redactSecrets(report(all, candidates, spent, cap), secrets),
    { flag: 'wx' },
  );
  say(`\nbake-off total $${spent.toFixed(4)}\n${directory}`);
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

export function report(
  results: readonly (CaseResult & { candidate: string; type: RequestType })[],
  candidates: readonly Candidate[],
  spent: number,
  cap: number,
): string {
  const types: RequestType[] = [
    'single change',
    'whole module',
    'module + lines + board',
    'workflow',
    'refusal',
  ];
  const rows: string[] = [];
  for (const type of types)
    for (const candidate of candidates) {
      const set = results.filter(
        (r) => r.candidate === candidate.name && r.type === type,
      );
      if (!set.length) continue;
      const draftable = set.filter((r) => r.expected !== 'unsupported');
      const completed = set.filter((r) => r.behaviour);
      const usd = set.reduce((sum, r) => sum + r.usd, 0);
      rows.push(
        `| ${type} | ${candidate.name} | ${String(set.length)} | ${
          type === 'refusal'
            ? '—'
            : `${String(draftable.filter((r) => r.afterRepair).length)}/${String(draftable.length)}`
        } | ${String(completed.length)}/${String(set.length)} | ${
          completed.length ? `$${(usd / completed.length).toFixed(4)}` : '—'
        } | ${(median(set.map((r) => r.modelMs)) / 1000).toFixed(1)} s |`,
      );
    }
  const overall = candidates.flatMap((candidate) => {
    const set = results.filter((r) => r.candidate === candidate.name);
    if (!set.length) return [];
    const s = summarize(set);
    return [
      `| ${candidate.name} | ${String(s.ran)} | ${s.firstTry} | ${s.afterRepair} | ${s.behaviour} | ${String(s.injected)} | $${s.usd.toFixed(4)} | ${String(s.tokens.cacheRead)} |`,
    ];
  });
  return [
    '# AI-BUILD-1 slice 3 drafting-model bake-off',
    '',
    `Same requests, prompt and repair code as the slice 2 run; first drafts made back to back from the captured in-app requests, each scored on the real in-app path, repairs live. One attempt per request: indicative only. Spend USD ${spent.toFixed(4)} of a USD ${String(cap)} cap.`,
    '',
    '| candidate | requests | verified first try | verified after repair | behaviour correct | hostile changed | spend | cache read tokens |',
    '|---|---|---|---|---|---|---|---|',
    ...overall,
    '',
    '| request type | candidate | requests | success after repair | behaviour correct | cost per completed request | median model latency |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`BUILD_BAKEOFF_FAILED ${errorText(error)}\n`);
  process.exitCode = 1;
});
