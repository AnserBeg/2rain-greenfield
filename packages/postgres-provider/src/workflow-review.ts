import { createHash } from 'node:crypto';
import { canonicalize } from '@north-star/canonical-model';
import type { WorkflowDefinition } from '../../canonical-model/src/schemas.js';
import type { verifyWorkflowBundle } from './workflow-bundle.js';
import type { WorkflowCall } from './workflow-sdk.js';

type Verification = Awaited<ReturnType<typeof verifyWorkflowBundle>>;

function duration(ms: number) {
  for (const [unit, size] of [
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ] as const)
    if (ms > 0 && ms % size === 0)
      return `${ms / size} ${unit}${ms === size ? '' : 's'}`;
  return `${ms} ms`;
}

export function renderWorkflowReview(
  workflow: WorkflowDefinition,
  source: string,
  verification: Pick<Verification, 'sites' | 'journals' | 'coverage'>,
  labels: ReadonlyMap<string, string>,
  unattended: ReadonlySet<string>,
) {
  const label = (id: string) => labels.get(id) ?? id;
  const { sites, coverage, journals } = verification;
  if (!journals.length || coverage.length !== journals.length)
    throw new Error('Workflow review is missing a fixture');
  const seen = new Set(coverage.flat());
  function step(encoded: string, index: number) {
    const call = JSON.parse(encoded) as WorkflowCall;
    const site = sites[index];
    const target =
      'id' in call ? call.id : 'operationId' in call ? call.operationId : null;
    if (!site || site.method !== call.kind || site.target !== target)
      throw new Error('Workflow sample disagrees with its call site');
    switch (call.kind) {
      case 'now':
        return 'Reads the current time without asking.';
      case 'sleep':
        return `Waits ${duration(call.milliseconds)} without asking.`;
      case 'query':
        return `Reads ${label(call.id)} without asking.`;
      case 'operation':
        return unattended.has(call.id)
          ? `Runs ${label(call.id)} without asking.`
          : `Requests ${label(call.id)}. This action requires human approval.`;
      case 'requestApproval':
        return `Asks a person to approve “${call.summary}”${target ? ' (' + label(target) + ')' : ''}.`;
      case 'waitForEvent':
        return 'Waits for a receipt event without asking.';
    }
  }
  const lines = [
    'Sample runs from the tests the drafter wrote, with made-up values. Each shows what the script does in that case, not every case.',
    ...coverage.slice(0, 5).flatMap((indices, i) => {
      const journal = journals[i]!;
      if (indices.length !== journal.length)
        throw new Error('Workflow sample is incomplete');
      return [
        `Test ${i + 1}`,
        ...(journal.length
          ? journal.map(({ request }, n) => step(request, indices[n]!))
          : ['Finishes without making a call.']),
      ];
    }),
    'Calls in the script',
    ...sites.map(
      (site, i) =>
        `Line ${site.line}: ${site.method}${site.target ? ' — ' + label(site.target) : ''}${site.branch ? ' (conditional)' : ''}${site.loop ? ' (in a loop)' : ''}${site.fields.length ? ' · inputs: ' + site.fields.map(label).join(', ') : ''}${seen.has(i) ? '' : ' · not shown in any test'}`,
    ),
    ...[...workflow.grants.operations, ...workflow.grants.queries]
      .filter((id) => !sites.some((site) => site.target === id))
      .map((id) => `${label(id)} — declared but never called`),
    'Body digest ' + workflow.bodyDigest,
    'Source',
    source,
  ];
  const text = lines.join('\n');
  const digest = createHash('sha256')
    .update(
      canonicalize(['northstar.workflow-review/v1', workflow.bodyDigest, text]),
    )
    .digest('hex');
  return { text, digest };
}

export function workflowReviewDecision(
  patchId: string,
  renderedDigest: string,
  pointer: {
    readonly releaseId: string | null;
    readonly pointerId: string;
    readonly fence: number;
  },
) {
  return createHash('sha256')
    .update(
      canonicalize([
        'northstar.workflow-review-decision/v1',
        patchId,
        renderedDigest,
        pointer.releaseId,
        pointer.pointerId,
        pointer.fence,
      ]),
    )
    .digest('hex');
}
