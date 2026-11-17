/**
 * `corepack pnpm agent "<request>"` -- the operations agent in a terminal,
 * against the database a running `pnpm dev` installed and seeded.
 *
 * It opens its own runtime on that database (no seed, no listener): a
 * confirmation grant is signed by the mediation authority of the process that
 * issues it, so the agent's writes must be issued here. The person is asked
 * to approve every plan; without an interactive terminal nothing is approved.
 */
import { createInterface } from 'node:readline/promises';

import {
  anthropicModel,
  agentPreamble,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  OperationsAgentSession,
  runOperationsAgent,
  SpendMeter,
  type PlanForApproval,
} from '@north-star/operations-agent';

import {
  checkTerminalRelease,
  compiledReleaseRoot,
} from './agent-release-guard.js';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openComposedApplicationRuntime,
  readCompiledApplication,
} from './composition-root.js';

const request = process.argv.slice(2).join(' ').trim();
if (!request) {
  process.stderr.write('usage: corepack pnpm agent "<request>"\n');
  process.exit(2);
}
const actor =
  process.env.NORTH_STAR_AGENT_ACTOR === 'manager' ? 'manager' : 'buyer';
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${process.env.NORTH_STAR_DATABASE_PORT ?? '55432'}/postgres`;

const out = (line: string) => process.stdout.write(`${line}\n`);

async function approveAtTerminal(plan: PlanForApproval): Promise<boolean> {
  out('');
  out(`Plan ${plan.planId} — ${plan.summary}`);
  for (const step of plan.steps) {
    out(
      `  ${String(step.step)}. ${step.operationId.split(':operation.')[1] ?? step.operationId}: ${step.effect}`,
    );
    out(`     target: ${step.target}`);
    for (const [kind, bag] of Object.entries(step.inputs))
      out(`     ${kind}: ${JSON.stringify(bag)}`);
  }
  if (!process.stdin.isTTY) {
    out('Not an interactive terminal: the plan is not approved.');
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question('Approve this plan? [y/N] ');
    return /^y(?:es)?$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

const tenantSlug =
  process.env.NORTH_STAR_TENANT_SLUG ?? 'local-composed-application';
const compiledApplication = await readCompiledApplication();
const release = await checkTerminalRelease({
  databaseUrl,
  tenantSlug,
  compiledRoot: compiledReleaseRoot(compiledApplication),
});
if (release.kind !== 'match') {
  process.stderr.write(`${release.message}\n`);
  process.exit(1);
}
const key = await loadModelKey('anthropic');
const runtime = await openComposedApplicationRuntime({
  compiledApplication,
  databaseUrl,
  tenantSlug,
});
try {
  const session = new OperationsAgentSession({
    runtime,
    personHeaders: { cookie: `northstar-demo-actor=${actor}` },
    companyId: COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
    businessCalendar: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    approve: approveAtTerminal,
  });
  const model = anthropicModel({
    key,
    modelId: process.env.NORTH_STAR_AGENT_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
  });
  out(`Agent (${model.modelId}) acting as the demo ${actor}, channel AGENT.`);
  const result = await runOperationsAgent({
    model,
    session,
    request,
    preamble: await agentPreamble(session),
    meter: new SpendMeter(null, Number.POSITIVE_INFINITY),
    onEvent: (event) => {
      if (event.kind === 'tool') out(`  · ${event.name}`);
      if (event.kind === 'result' && event.isError)
        out('    (refused — see the answer)');
    },
  });
  out('');
  out(result.answer || '(no answer)');
  out('');
  out(
    `${result.stop} · ${String(result.toolCalls)} tool calls · tokens in ${String(result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens)} (cached ${String(result.usage.cacheReadTokens)}) out ${String(result.usage.outputTokens)}`,
  );
  if (result.error) out(`error: ${result.error}`);
} finally {
  await runtime.close();
}
