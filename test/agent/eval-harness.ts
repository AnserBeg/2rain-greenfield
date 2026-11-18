/**
 * The on-demand eval: the ten pre-registered tasks with a real model.
 *
 *   NORTH_STAR_AGENT_KEY_FILE=/path/.env corepack pnpm agent:eval -- \
 *     --price-input 4 --price-output 20 --price-cache-read 0.4 \
 *     --price-cache-write 5 --price-source <url> --price-date 2026-11-17
 *
 * Prices are USD per million tokens and must be read from the provider's
 * current price list at run time: the harness refuses to run without them,
 * because cost per completed task is only as true as its prices. One attempt
 * per task, each on a fresh, uniquely named database; the harness grants
 * confirmation and records that it did; pass or fail is the task's end-state
 * check, never the model's word. The run aborts before any model call once
 * total spend reaches the cap (USD 20 unless --cap says otherwise).
 *
 * Writes `docs/execution/evidence/<run timestamp>-agent-eval.md` (created
 * exclusively: a rerun, even of one task, never overwrites an earlier result)
 * and, per task, an append-only JSONL run record (one line per model call or
 * tool call, appended in call order).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  agentPreamble,
  anthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  OperationsAgentSession,
  runOperationsAgent,
  SpendMeter,
  type AgentRunResult,
} from '../../packages/operations-agent/src/index.js';

import { BUSINESS_CALENDAR, COMPANY, withAgentWorlds } from './agent-world.js';
import { snapshot } from './arrange.js';
import { attemptsFor, DEV_TASKS, type DevTask } from './dev-tasks.js';

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    // `pnpm agent:eval -- --flag` may pass the separator through.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      model: { type: 'string', default: DEFAULT_ANTHROPIC_MODEL },
      effort: { type: 'string', default: 'high' },
      'price-input': { type: 'string' },
      'price-output': { type: 'string' },
      'price-cache-read': { type: 'string' },
      'price-cache-write': { type: 'string' },
      'price-source': { type: 'string' },
      'price-date': { type: 'string' },
      cap: { type: 'string', default: '20' },
      // `ten`: the pre-registered ten, one attempt each; `dev`: the AGENT-3
      // development set, three attempts per write task.
      set: { type: 'string', default: 'ten' },
      tasks: { type: 'string' },
      out: { type: 'string', default: 'docs/execution/evidence' },
      // `off` runs without the business map (the pre-AGENT-3 start).
      preamble: { type: 'string', default: 'on' },
    },
  });

  const price = (name: string): number => {
    const value = Number(args[name as keyof typeof args]);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        `--${name} is required: USD per million tokens from the provider's current price list`,
      );
    return value;
  };
  const prices = {
    input: price('price-input'),
    output: price('price-output'),
    cacheRead: price('price-cache-read'),
    cacheWrite: price('price-cache-write'),
  };
  if (!args['price-source'] || !args['price-date'])
    throw new Error('--price-source and --price-date are required');
  const cap = Number(args.cap);
  const dev = args.set === 'dev';
  const selected = new Set(
    (
      args.tasks ??
      (dev ? DEV_TASKS : DEV_TASKS.slice(0, 10))
        .map((task) => task.id)
        .join(',')
    )
      .split(',')
      .map(Number),
  );
  const attempts = (task: DevTask) => (dev ? attemptsFor(task) : 1);
  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const outDirectory = resolve(String(args.out));
  const runDirectory = join(outDirectory, `${date}-agent-eval-runs-${stamp}`);
  await mkdir(runDirectory, { recursive: true });

  const key = await loadModelKey('anthropic');
  const model = anthropicModel({
    key,
    modelId: String(args.model),
    effort: args.effort as 'high',
  });
  const meter = new SpendMeter(prices, cap);

  interface Row {
    task: number;
    attempt: number;
    kind: string;
    title: string;
    pass: boolean;
    reason: string;
    stop: AgentRunResult['stop'] | 'not-run' | 'harness-error';
    toolCalls: number;
    approvals: number;
    tokensIn: number;
    cacheRead: number;
    cacheWrite: number;
    tokensOut: number;
    usd: number;
    seconds: number;
    calls: Record<string, number>;
    answer: string;
    record: string;
  }
  const rows: Row[] = [];
  const log = (line: string) => process.stdout.write(`${line}\n`);

  await withAgentWorlds('agent-eval', async (worlds) => {
    for (const task of DEV_TASKS.filter((candidate) =>
      selected.has(candidate.id),
    ))
      for (let attempt = 1; attempt <= attempts(task); attempt += 1) {
        const record = join(
          runDirectory,
          `task-${String(task.id).padStart(2, '0')}${attempts(task) > 1 ? `-a${String(attempt)}` : ''}.jsonl`,
        );
        // Appends are queued so lines land in call order; `at` is read when the
        // event happens, not when its write runs.
        let queue: Promise<void> = Promise.resolve();
        const append = (entry: Record<string, unknown>): Promise<void> => {
          const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
          queue = queue.then(() => appendFile(record, line));
          return queue;
        };
        if (meter.exhausted()) {
          rows.push({
            task: task.id,
            attempt,
            kind: task.kind,
            title: task.title,
            pass: false,
            reason: 'not run: spend cap reached',
            stop: 'not-run',
            toolCalls: 0,
            approvals: 0,
            tokensIn: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tokensOut: 0,
            usd: 0,
            seconds: 0,
            calls: {},
            answer: '',
            record,
          });
          continue;
        }
        log(
          `task ${String(task.id)}${attempts(task) > 1 ? ` attempt ${String(attempt)}` : ''}: ${task.title}`,
        );
        const world = await worlds.fresh(
          `eval-${String(task.id)}-${String(attempt)}`,
        );
        try {
          const context = await task.arrange(world);
          const before = await snapshot(world);
          const request = task.request(context);
          await append({
            kind: 'task',
            task: task.id,
            request,
            attempt,
            actor: task.actor ?? 'buyer',
            database: world.databaseName,
            model: model.modelId,
          });
          const session = new OperationsAgentSession({
            runtime: world.runtime,
            personHeaders: {
              cookie: `northstar-demo-actor=${task.actor ?? 'buyer'}`,
            },
            companyId: COMPANY,
            businessCalendar: BUSINESS_CALENDAR,
            approve: async (plan) => {
              await append({
                kind: 'approval',
                granted: true,
                by: 'harness',
                planId: plan.planId,
                steps: plan.steps.map((step) => step.operationId),
              });
              return true;
            },
          });
          const calls: Record<string, number> = {};
          const run = await runOperationsAgent({
            model,
            session,
            request,
            meter,
            ...(args.preamble === 'off'
              ? {}
              : { preamble: await agentPreamble(session) }),
            onEvent: (event) => {
              if (event.kind === 'model')
                void append({
                  kind: 'model',
                  messages: event.messages,
                  stop: event.stop,
                  tokensIn: event.usage.inputTokens,
                  cacheRead: event.usage.cacheReadTokens,
                  cacheWrite: event.usage.cacheWriteTokens,
                  tokensOut: event.usage.outputTokens,
                  usd: event.usd,
                });
              if (event.kind === 'tool') {
                const name = callName(event.name, event.input);
                calls[name] = (calls[name] ?? 0) + 1;
              }
              if (event.kind === 'tool')
                void append({
                  kind: 'tool',
                  tool: event.name,
                  arguments: loggedArguments(event.input),
                });
              if (event.kind === 'result')
                void append({
                  kind: 'tool-result',
                  tool: event.name,
                  status: event.isError ? 'refused' : 'ok',
                  result: event.content,
                });
            },
          });
          await queue;
          const verdict = await task.check(world, context, before, run);
          await append({
            kind: 'verdict',
            pass: verdict.pass,
            reason: verdict.reason,
            stop: run.stop,
            answer: run.answer,
            ...(run.error ? { error: run.error } : {}),
          });
          rows.push({
            task: task.id,
            attempt,
            kind: task.kind,
            title: task.title,
            pass: verdict.pass,
            reason: verdict.reason,
            stop: run.stop,
            toolCalls: run.toolCalls,
            approvals: session.approvals.length,
            tokensIn: run.usage.inputTokens,
            cacheRead: run.usage.cacheReadTokens,
            cacheWrite: run.usage.cacheWriteTokens,
            tokensOut: run.usage.outputTokens,
            usd: run.usd,
            seconds: run.seconds,
            calls,
            answer: run.answer,
            record,
          });
          log(
            `  ${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.reason} · ${String(run.toolCalls)} tool calls (${String(discoveryCalls(calls))} discovery) · ${run.seconds.toFixed(1)} s · $${run.usd.toFixed(4)} (total $${meter.usd.toFixed(4)})`,
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          await append({ kind: 'harness-error', error: message });
          rows.push({
            task: task.id,
            attempt,
            kind: task.kind,
            title: task.title,
            pass: false,
            reason: `harness error: ${message}`,
            stop: 'harness-error',
            toolCalls: 0,
            approvals: 0,
            tokensIn: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tokensOut: 0,
            usd: 0,
            seconds: 0,
            calls: {},
            answer: '',
            record,
          });
          log(`  HARNESS ERROR ${message}`);
        } finally {
          await world.close();
        }
      }
  });

  const passed = rows.filter((row) => row.pass).length;
  const byTask = new Map<number, Row[]>();
  for (const row of rows)
    byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);
  const everyTime = [...byTask.values()].filter((runs) =>
    runs.every((row) => row.pass),
  ).length;
  const atLeastOnce = [...byTask.values()].filter((runs) =>
    runs.some((row) => row.pass),
  ).length;
  const maxAttempts = Math.max(...rows.map((row) => row.attempt));
  const perAttempt = Array.from({ length: maxAttempts }, (_, index) => {
    const runs = rows.filter((row) => row.attempt === index + 1);
    return `attempt ${String(index + 1)}: ${String(runs.filter((row) => row.pass).length)}/${String(runs.length)}`;
  });
  const total = meter.usd;
  const relative = (path: string) => path.slice(outDirectory.length + 1);
  const cell = (text: string) =>
    text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const ran = rows.filter((row) => row.stop !== 'not-run');
  const report = [
    `# Agent eval — ${date}`,
    '',
    `Model \`${model.modelId}\` (effort ${String(args.effort)}), acting as the demo buyer (task 34: the manager) on channel AGENT, business map ${args.preamble === 'off' ? 'off' : 'on'}, task set ${dev ? 'dev (AGENT-3 development set; write, multi-step and customized tasks three attempts)' : 'ten (one attempt per task)'}. Each attempt on a fresh database; the harness granted every confirmation it was asked for and recorded it. Seconds are the agent run on a monotonic clock (arrangement excluded).`,
    `Prices (USD per million tokens) from ${String(args['price-source'])}, read ${String(args['price-date'])}: input ${String(prices.input)}, output ${String(prices.output)}, cache read ${String(prices.cacheRead)}, cache write ${String(prices.cacheWrite)}. Spend cap USD ${String(cap)}.`,
    '',
    '| task | kind | attempt | result | stop | tool calls | approvals | tokens in (uncached / cache read / cache write) | tokens out | USD | reason |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${String(row.task)}. ${row.title} | ${row.kind} | ${String(row.attempt)} | ${row.pass ? 'pass' : 'fail'} | ${row.stop} | ${String(row.toolCalls)} | ${String(row.approvals)} | ${String(row.tokensIn)} / ${String(row.cacheRead)} / ${String(row.cacheWrite)} | ${String(row.tokensOut)} | ${row.usd.toFixed(4)} | ${cell(row.reason)} |`,
    ),
    '',
    `**Success rate:** ${String(passed)} of ${String(rows.length)} runs.${maxAttempts > 1 ? ` **Tasks passing every time:** ${String(everyTime)} of ${String(byTask.size)}; **at least once:** ${String(atLeastOnce)} of ${String(byTask.size)}. **By attempt:** ${perAttempt.join(', ')}.` : ''}`,
    `**Median discovery calls per task** (every erp_discover call): ${String(median(ran.map((row) => discoveryCalls(row.calls))))}. **Median seconds per task:** ${median(ran.map((row) => row.seconds)).toFixed(1)}. **Median tool calls per task:** ${String(median(ran.map((row) => row.toolCalls)))}.`,
    `**Total spend:** USD ${total.toFixed(4)}.`,
    `**Cost per completed task:** ${passed > 0 ? `USD ${(total / passed).toFixed(4)}` : 'undefined (no task passed)'}.`,
    '',
    '## Tool calls by tool and mode',
    '',
    '| task | attempt | seconds | calls by tool and mode |',
    '|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${String(row.task)} | ${String(row.attempt)} | ${row.seconds.toFixed(1)} | ${Object.entries(
          row.calls,
        )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => `${name} ${String(count)}`)
          .join(', ')} |`,
    ),
    '',
    '## Final answers',
    '',
    ...rows.map(
      (row) =>
        `- **${String(row.task)}${row.attempt > 1 ? ` (attempt ${String(row.attempt)})` : ''}.** ${cell(row.answer || '(none)')} — run record \`${relative(row.record)}\``,
    ),
    '',
  ].join('\n');
  const reportPath = join(outDirectory, `${stamp}-agent-eval.md`);
  await writeFile(reportPath, report, { flag: 'wx' });
  log(
    `\n${String(passed)}/${String(rows.length)} passed · USD ${total.toFixed(4)} · ${reportPath}`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `AGENT_EVAL_FAILED ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});

/**
 * Tool arguments as the run record keeps them. The model's own
 * `executionIdempotencyKey` is a label, not a credential, but a secret
 * scanner reads any `...Key` with an opaque value as one; the record keeps
 * that a key was given, not its text.
 */
function loggedArguments(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) =>
      /key$/iu.test(name) ? [name, '[given]'] : [name, value],
    ),
  );
}

/** `erp_discover:search`, `erp_query`, ...: a call named by tool and mode. */
export function callName(tool: string, input: unknown): string {
  const mode =
    tool === 'erp_discover' &&
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { mode?: unknown }).mode === 'string'
      ? (input as { mode: string }).mode
      : null;
  return mode ? `${tool}:${mode}` : tool;
}

function discoveryCalls(calls: Record<string, number>): number {
  return Object.entries(calls)
    .filter(([name]) => name.startsWith('erp_discover'))
    .reduce((sum, [, count]) => sum + count, 0);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
