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
 * Writes `docs/execution/evidence/<date>-agent-eval.md` and, per task, an
 * append-only JSONL run record (one line per model call or tool call).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  anthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  OperationsAgentSession,
  runOperationsAgent,
  SpendMeter,
  type AgentRunResult,
} from '../../packages/operations-agent/src/index.js';

import { COMPANY, withAgentWorlds } from './agent-world.js';
import { snapshot } from './arrange.js';
import { TASKS } from './tasks.js';

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
      tasks: { type: 'string', default: '1,2,3,4,5,6,7,8,9,10' },
      out: { type: 'string', default: 'docs/execution/evidence' },
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
  const selected = new Set(String(args.tasks).split(',').map(Number));
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
    answer: string;
    record: string;
  }
  const rows: Row[] = [];
  const log = (line: string) => process.stdout.write(`${line}\n`);

  await withAgentWorlds('agent-eval', async (worlds) => {
    for (const task of TASKS.filter((candidate) =>
      selected.has(candidate.id),
    )) {
      const record = join(
        runDirectory,
        `task-${String(task.id).padStart(2, '0')}.jsonl`,
      );
      const append = (entry: Record<string, unknown>) =>
        appendFile(
          record,
          `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        );
      if (meter.exhausted()) {
        rows.push({
          task: task.id,
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
          answer: '',
          record,
        });
        continue;
      }
      log(`task ${String(task.id)}: ${task.title}`);
      const world = await worlds.fresh(`eval-${String(task.id)}`);
      try {
        const context = await task.arrange(world);
        const before = await snapshot(world);
        const request = task.request(context);
        await append({
          kind: 'task',
          task: task.id,
          request,
          database: world.databaseName,
          model: model.modelId,
        });
        const pending: Promise<void>[] = [];
        const session = new OperationsAgentSession({
          runtime: world.runtime,
          personHeaders: { cookie: 'northstar-demo-actor=buyer' },
          companyId: COMPANY,
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
        const run = await runOperationsAgent({
          model,
          session,
          request,
          meter,
          onEvent: (event) => {
            if (event.kind === 'model')
              pending.push(
                append({
                  kind: 'model',
                  messages: event.messages,
                  stop: event.stop,
                  tokensIn: event.usage.inputTokens,
                  cacheRead: event.usage.cacheReadTokens,
                  cacheWrite: event.usage.cacheWriteTokens,
                  tokensOut: event.usage.outputTokens,
                  usd: event.usd,
                }),
              );
            if (event.kind === 'tool')
              pending.push(
                append({
                  kind: 'tool',
                  tool: event.name,
                  arguments: loggedArguments(event.input),
                }),
              );
            if (event.kind === 'result')
              pending.push(
                append({
                  kind: 'tool-result',
                  tool: event.name,
                  status: event.isError ? 'refused' : 'ok',
                  result: event.content,
                }),
              );
          },
        });
        await Promise.all(pending);
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
          answer: run.answer,
          record,
        });
        log(
          `  ${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.reason} · ${String(run.toolCalls)} tool calls · $${run.usd.toFixed(4)} (total $${meter.usd.toFixed(4)})`,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        await append({ kind: 'harness-error', error: message });
        rows.push({
          task: task.id,
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
  const total = meter.usd;
  const relative = (path: string) => path.slice(outDirectory.length + 1);
  const cell = (text: string) =>
    text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const report = [
    `# Agent eval — ${date}`,
    '',
    `Model \`${model.modelId}\` (effort ${String(args.effort)}), acting as the demo buyer on channel AGENT. One attempt per task, each on a fresh database; the harness granted every confirmation it was asked for and recorded it.`,
    `Prices (USD per million tokens) from ${String(args['price-source'])}, read ${String(args['price-date'])}: input ${String(prices.input)}, output ${String(prices.output)}, cache read ${String(prices.cacheRead)}, cache write ${String(prices.cacheWrite)}. Spend cap USD ${String(cap)}.`,
    '',
    '| task | result | stop | tool calls | approvals | tokens in (uncached / cache read / cache write) | tokens out | USD | reason |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${String(row.task)}. ${row.title} | ${row.pass ? 'pass' : 'fail'} | ${row.stop} | ${String(row.toolCalls)} | ${String(row.approvals)} | ${String(row.tokensIn)} / ${String(row.cacheRead)} / ${String(row.cacheWrite)} | ${String(row.tokensOut)} | ${row.usd.toFixed(4)} | ${cell(row.reason)} |`,
    ),
    '',
    `**Success rate:** ${String(passed)} of ${String(rows.length)}.`,
    `**Total spend:** USD ${total.toFixed(4)}.`,
    `**Cost per completed task:** ${passed > 0 ? `USD ${(total / passed).toFixed(4)}` : 'undefined (no task passed)'}.`,
    '',
    '## Final answers',
    '',
    ...rows.map(
      (row) =>
        `- **${String(row.task)}.** ${cell(row.answer || '(none)')} — run record \`${relative(row.record)}\``,
    ),
    '',
  ].join('\n');
  const reportPath = join(outDirectory, `${date}-agent-eval.md`);
  await writeFile(reportPath, report);
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
