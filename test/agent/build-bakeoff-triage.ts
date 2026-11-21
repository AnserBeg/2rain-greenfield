/**
 * AI-BUILD-1 slice 3, phase 1: static triage of saved bake-off first drafts.
 * No model call and no database: each draft is parsed by the drafter's own
 * reader, applied to the first-party definition (plus the case's base
 * changes) the way the compiler's first stage applies it, and checked against
 * the case's hand-written expectation. Workflows are schema-checked only
 * (their compile needs the live SDK). A draft touched by the old drafter's
 * `field` key collision is excluded, never counted.
 *
 *   node --import tsx test/agent/build-bakeoff-triage.ts --drafts <file> --out <dir> [--models a,b]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import {
  applyCustomizationPatches,
  customizationTargets,
  DRAFT_CUSTOMIZATION_TOOL,
  draftPatchFromRequest,
  parseCustomizationPatch,
  slug,
  type CustomizationPatch,
  type DraftingModel,
} from '../../packages/customization/src/index.js';
import { WorkflowDraftSchema } from '../../packages/customization/src/workflow-draft.js';

import {
  BUILD_CASES,
  CAPABILITY_BUCKETS,
  type BuildCase,
  type FieldSpec,
} from './build-eval-cases.js';

export type Tier = 'simple edits' | 'modules' | 'workflows' | 'safety';

export function tierOf(c: BuildCase): Tier {
  if (c.expect.outcome === 'workflow') return 'workflows';
  if (c.expect.outcome === 'unsupported' || c.category === 'hostile')
    return 'safety';
  if (c.expect.outcome === 'module' && c.expect.types.some((t) => !t.existing))
    return 'modules';
  if (c.expect.outcome === 'module' && c.expect.types.some((t) => t.board))
    return 'modules';
  return 'simple edits';
}

/** Cases the old drafter's `field` collision touched (bake-off drafts at 53b32ef3). */
const COLLISION_CASES = new Set(['F02', 'H02', 'N06']);

type Json = Record<string, unknown>;
const matches = (aliases: readonly string[], label: string) => {
  const s = slug(label);
  return aliases.some((alias) => {
    const wanted = slug(alias);
    return (
      s === wanted ||
      s.includes(wanted) ||
      (wanted.includes(s) && s.length >= 3)
    );
  });
};

function scripted(input: unknown): DraftingModel {
  return {
    modelId: 'saved',
    next: () =>
      Promise.resolve({
        text: '',
        toolCalls: [{ id: 'saved', name: DRAFT_CUSTOMIZATION_TOOL, input }],
      }),
  };
}

function members(patch: CustomizationPatch): Json[] {
  return (patch.kind === 'changeSet' ? patch.patches : [patch]) as Json[];
}

/** Static behaviour against the expectation; returns the reasons it falls short. */
function staticBehaviour(c: BuildCase, patch: CustomizationPatch): string[] {
  const expect = c.expect;
  if (expect.outcome !== 'module') return [];
  const reasons: string[] = [];
  const list = members(patch);
  const kinds = list.map((m) => String(m.kind));
  for (const kind of kinds)
    if (!expect.allowedKinds.includes(kind) && kind !== 'changeSet')
      reasons.push(`kind outside the request: ${kind}`);
  for (const kind of expect.requiredKinds ?? [])
    if (!kinds.includes(kind)) reasons.push(`no ${kind}`);
  for (const spec of expect.types) {
    let entity: string | undefined;
    let fields: { label: string; type: string; options?: string[] }[] = [];
    if (spec.existing) entity = `northstar.app:entity.${spec.existing}`;
    else {
      const created = list.find(
        (m) =>
          m.kind === 'addRecordType' && matches(spec.names, String(m.label)),
      );
      if (!created) {
        reasons.push(`no record type ${spec.names[0]!}`);
        continue;
      }
      entity = `northstar.app:entity.custom_${slug(String(created.label))}`;
      fields = (created.fields as typeof fields) ?? [];
    }
    for (const m of list)
      if (m.kind === 'addField' && m.entity === entity)
        fields.push(m.field as (typeof fields)[number]);
    const typeOk = (want: FieldSpec, got: { type: string }) =>
      want.type === got.type;
    for (const want of spec.fields) {
      if (want.type === 'address') {
        if (
          !list.some(
            (m) =>
              m.kind === 'addAddressField' &&
              matches(want.names, String(m.label)),
          )
        )
          reasons.push(`${spec.names[0]!}: no address field ${want.names[0]!}`);
        continue;
      }
      const got = fields.find((f) => matches(want.names, f.label));
      if (!got)
        reasons.push(`${spec.names[0]!}: field "${want.names[0]!}" missing`);
      else if (!typeOk(want, got))
        reasons.push(`${spec.names[0]!}: "${want.names[0]!}" is ${got.type}`);
      else
        for (const option of want.options ?? [])
          if (!(got.options ?? []).some((o) => matches(option, o)))
            reasons.push(
              `${spec.names[0]!}: "${want.names[0]!}" lacks ${option[0]!}`,
            );
    }
    for (const names of spec.files ?? [])
      if (
        !list.some(
          (m) =>
            m.kind === 'addDocumentField' && matches(names, String(m.label)),
        )
      )
        reasons.push(`${spec.names[0]!}: no files field ${names[0]!}`);
    if (spec.lifecycle) {
      const life = list.find(
        (m) => m.kind === 'declareLifecycle' && m.entity === entity,
      );
      if (!life) reasons.push(`${spec.names[0]!}: no lifecycle`);
      else {
        const states = (life.states as { label: string }[]).map((s) => s.label);
        for (const step of spec.lifecycle)
          if (!states.some((label) => matches(step, label)))
            reasons.push(`${spec.names[0]!}: no state ${step[0]!}`);
        if (
          spec.lifecycle[0] &&
          !matches(spec.lifecycle[0], String(life.initial))
        )
          reasons.push(`${spec.names[0]!}: starts in ${String(life.initial)}`);
      }
    }
    if (spec.lines) {
      const lines = list.find(
        (m) => m.kind === 'addLineTable' && m.entity === entity,
      );
      if (!lines) reasons.push(`${spec.names[0]!}: no line table`);
      else
        for (const want of spec.lines.fields)
          if (
            !(lines.fields as { label: string }[]).some((f) =>
              matches(want.names, f.label),
            )
          )
            reasons.push(
              `${spec.names[0]!}: line field ${want.names[0]!} missing`,
            );
    }
    for (const link of spec.links ?? []) {
      const target = link.startsWith('type:')
        ? null
        : `northstar.app:entity.${link}`;
      if (
        !list.some(
          (m) =>
            m.kind === 'addLink' &&
            m.entity === entity &&
            (target
              ? m.target === target
              : matches(
                  [link.slice(5)],
                  String(m.target).split('.').pop() ?? '',
                )),
        )
      )
        reasons.push(`${spec.names[0]!}: link to ${link} missing`);
    }
    if (spec.board && !list.some((m) => m.kind === 'addBoardViewRevision'))
      reasons.push(`${spec.names[0]!}: no board`);
  }
  return reasons;
}

export interface TriageRow {
  model: string;
  id: string;
  tier: Tier;
  outcome: 'excluded' | 'pass' | 'fail';
  stage: string;
  reasons: string[];
  latencyMs: number;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      drafts: { type: 'string' },
      out: { type: 'string' },
      models: { type: 'string' },
    },
  });
  if (!args.drafts || !args.out) throw new Error('--drafts and --out');
  const saved = JSON.parse(await readFile(resolve(args.drafts), 'utf8')) as {
    drafts: Record<
      string,
      Record<
        string,
        { turn: { toolCalls: { input: unknown }[]; recordedLatencyMs: number } }
      >
    >;
  };
  const application = normalizeApplicationPackage(
    JSON.parse(
      await readFile('apps/web/release/app.authored.json', 'utf8'),
    ) as unknown,
  ) as unknown as Json;
  const models = args.models
    ? args.models.split(',')
    : Object.keys(saved.drafts);
  const rows: TriageRow[] = [];
  for (const model of models)
    for (const [id, draft] of Object.entries(saved.drafts[model] ?? {})) {
      const c = BUILD_CASES.find((x) => x.id === id)!;
      const tier = tierOf(c);
      const row = (
        outcome: TriageRow['outcome'],
        stage: string,
        reasons: string[] = [],
      ) =>
        rows.push({
          model,
          id,
          tier,
          outcome,
          stage,
          reasons,
          latencyMs: draft.turn.recordedLatencyMs,
        });
      const calls = draft.turn.toolCalls;
      const input = calls[0]?.input as Json | undefined;
      const stringField = JSON.stringify(calls).includes('"field":"{');
      if (COLLISION_CASES.has(id) || stringField) {
        row('excluded', 'old drafter key collision');
        continue;
      }
      if (calls.length !== 1 || !input) {
        row('fail', 'tool call', ['no single drafting call']);
        continue;
      }
      if (input.kind === 'unsupported') {
        const text = String(input.missingCapability ?? '');
        if (c.expect.outcome !== 'unsupported')
          row('fail', 'refusal', [`false refusal: ${text}`]);
        else {
          const right = c.expect.capabilities.some((b) =>
            CAPABILITY_BUCKETS[b].test(text),
          );
          row(
            right ? 'pass' : 'fail',
            'refusal',
            right ? [] : [`wrong capability: ${text}`],
          );
        }
        continue;
      }
      if (c.expect.outcome === 'unsupported') {
        row('fail', 'refusal', ['false accept']);
        continue;
      }
      if (input.kind === 'saveWorkflow') {
        const parsed = WorkflowDraftSchema.safeParse(input);
        const reasons: string[] = [];
        if (!parsed.success)
          reasons.push(
            ...parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`),
          );
        else {
          const body = parsed.data.body;
          if (/\bexport\b|^\s*function\s+run\b/mu.test(body))
            reasons.push('body is not a function body');
          if (c.expect.outcome === 'workflow') {
            const granted = parsed.data.workflow.grants.operations
              .map((o) => o.split(':operation.')[1])
              .sort();
            if (
              JSON.stringify(granted) !==
              JSON.stringify([...c.expect.operations].sort())
            )
              reasons.push(`grants ${granted.join(', ')}`);
          }
          for (const fixture of parsed.data.fixtures)
            for (const effect of fixture.effects) {
              const call = effect.call as Json;
              if (call.kind === 'requestApproval' && !('operationId' in call))
                reasons.push('approval fixture lacks operationId');
            }
        }
        row(reasons.length ? 'fail' : 'pass', 'workflow schema (static)', [
          ...new Set(reasons),
        ]);
        continue;
      }
      // Base changes first, then the draft through the drafter's own reader.
      let base = application;
      const baseApplied = applyCustomizationPatches(
        application,
        (c.base ?? []).map((change) => {
          const parsed = parseCustomizationPatch(change);
          if (parsed.status !== 'parsed')
            throw new Error(`${id}: base does not parse`);
          return parsed.patch;
        }),
      );
      if (baseApplied.status === 'applied') base = baseApplied.authored;
      const targets = customizationTargets(base as never);
      const read = await draftPatchFromRequest(
        scripted(input),
        c.request,
        targets,
        {
          definition: base,
          maximumRepairs: 0,
        },
      );
      if (read.status !== 'parsed') {
        row(
          'fail',
          'parse',
          read.status === 'invalid' ? read.issues.slice(0, 3) : [read.status],
        );
        continue;
      }
      const applied = applyCustomizationPatches(base, [read.patch]);
      if (applied.status !== 'applied') {
        row('fail', 'apply', [
          applied.status === 'refused'
            ? applied.message
            : `unsupported: ${applied.missingCapability}`,
        ]);
        continue;
      }
      const reasons = staticBehaviour(c, read.patch);
      row(reasons.length ? 'fail' : 'pass', 'static behaviour', reasons);
    }
  const tiers: Tier[] = ['simple edits', 'modules', 'workflows', 'safety'];
  const table = models.flatMap((model) =>
    tiers.map((tier) => {
      const set = rows.filter(
        (r) => r.model === model && r.tier === tier && r.outcome !== 'excluded',
      );
      const pass = set.filter((r) => r.outcome === 'pass').length;
      return {
        model,
        tier,
        pass,
        n: set.length,
        excluded: rows.filter(
          (r) =>
            r.model === model && r.tier === tier && r.outcome === 'excluded',
        ).length,
      };
    }),
  );
  const md = [
    '# AI-BUILD-1 slice 3 phase 1 — static triage of saved bake-off first drafts',
    '',
    'No model call and no database. Drafts were made against the drafter at `53b32ef3` (before the `field` key-collision fix); drafts the collision touched are excluded. A pass here means: one drafting call, read by the drafter, applied cleanly to the first-party definition plus the case base, and the expected record types, fields, lifecycle, lines, links, board and refusal capability are present. Workflows are schema-checked only. It is triage, not a score: activation and end-to-end behaviour are not run.',
    '',
    '| model | simple edits | modules | workflows | safety |',
    '|---|---|---|---|---|',
    ...models.map(
      (model) =>
        `| ${model} | ${tiers
          .map((tier) => {
            const t = table.find((x) => x.model === model && x.tier === tier)!;
            return `${String(t.pass)}/${String(t.n)}${t.excluded ? ` (+${String(t.excluded)} excluded)` : ''}`;
          })
          .join(' | ')} |`,
    ),
    '',
    '| model | case | tier | outcome | stage | reasons | first-draft latency s |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.model} | ${r.id} | ${r.tier} | ${r.outcome} | ${r.stage} | ${r.reasons.join('; ').replaceAll('|', '\\|').slice(0, 200)} | ${(r.latencyMs / 1000).toFixed(1)} |`,
    ),
    '',
  ].join('\n');
  await mkdir(resolve(args.out), { recursive: true });
  await writeFile(
    join(resolve(args.out), 'triage.json'),
    JSON.stringify({ table, rows }, null, 2) + '\n',
  );
  await writeFile(join(resolve(args.out), 'triage.md'), md);
  process.stdout.write(md.split('\n').slice(0, 12).join('\n') + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`BUILD_BAKEOFF_TRIAGE_FAILED ${String(error)}\n`);
  process.exitCode = 1;
});
