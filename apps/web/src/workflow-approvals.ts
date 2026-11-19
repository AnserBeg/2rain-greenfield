import type { TrustedRequestContext } from '@north-star/runtime/request-context';
import {
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import { escapeHtml } from './html.js';
import {
  messageAttributes,
  messageBody,
  type SurfaceMessageRef,
} from './message-render.js';
import {
  renderWorkspaceWorklist,
  type SurfaceRuntimeResponse,
  type SurfaceRuntimeSubmission,
} from './surface-runtime.js';

export const WORKFLOW_APPROVALS_HREF = '/?approvals';

interface ApprovalSelection {
  readonly runId: string;
  readonly cursor: number;
  readonly fence: string;
  readonly digest: string;
}

interface ApprovalPlan extends ApprovalSelection {
  readonly companyId: string;
  readonly operationId: string;
  readonly summary: string;
  readonly input: unknown;
}

export interface WorkflowApprovalsService {
  worklist(actor: TrustedRequestContext): Promise<{
    readonly approvals: readonly ApprovalPlan[];
    readonly suspended: readonly {
      readonly runId: string;
      readonly workflowId: string;
      readonly reason: string;
    }[];
  }>;
  decide(
    actor: TrustedRequestContext,
    selection: ApprovalSelection,
    decision: 'APPROVED' | 'DECLINED',
  ): Promise<boolean>;
  remedy(
    actor: TrustedRequestContext,
    runIds: readonly string[],
    action: 'retry' | 'cancel',
  ): Promise<
    readonly { readonly runId: string; readonly outcome: string }[] | null
  >;
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

export async function renderWorkflowApprovals(
  view: RequestRuntimeView,
  service: WorkflowApprovalsService,
  submission: SurfaceRuntimeSubmission | null,
): Promise<SurfaceRuntimeResponse> {
  const actor = trustedContextForRequestRuntimeView(view);
  let message: SurfaceMessageRef | null = null;
  let results: Awaited<ReturnType<WorkflowApprovalsService['remedy']>> = null;
  if (submission) {
    const { action, runId, digest, cursor, fence } = submission;
    if (
      (action === 'approve' || action === 'decline') &&
      runId &&
      uuid.test(runId) &&
      cursor &&
      /^(?:[0-9]|[1-5][0-9]|6[0-3])$/u.test(cursor) &&
      fence &&
      /^[1-9][0-9]{0,18}$/u.test(fence) &&
      BigInt(fence) <= 9223372036854775807n &&
      digest &&
      /^[0-9a-f]{64}$/u.test(digest)
    ) {
      const decided = await service.decide(
        actor,
        { runId, cursor: Number(cursor), fence, digest },
        action === 'approve' ? 'APPROVED' : 'DECLINED',
      );
      message = {
        code: decided
          ? 'WORKFLOW_APPROVAL_DECIDED'
          : 'WORKFLOW_APPROVAL_REFUSED',
      };
    } else if (action === 'retry' || action === 'cancel') {
      const runIds = Object.keys(submission)
        .filter((name) => name.startsWith('run-'))
        .map((name) => name.slice(4));
      if (
        runIds.length &&
        runIds.length <= 100 &&
        runIds.every((id) => uuid.test(id))
      )
        results = await service.remedy(actor, runIds, action);
      if (!results) message = { code: 'WORKFLOW_REMEDY_REFUSED' };
    } else {
      message = { code: 'WORKFLOW_APPROVAL_REFUSED' };
    }
  }
  const worklist = await service.worklist(actor);
  const plans = worklist.approvals.map(renderApprovalPlan).join('');
  const runs = worklist.suspended
    .map(
      ({ runId, workflowId, reason }) =>
        `<li><label><input name="run-${escapeHtml(runId)}" type="checkbox"> ${escapeHtml(workflowId)} · <code>${escapeHtml(runId)}</code></label> <span>${escapeHtml(reason)}</span></li>`,
    )
    .join('');
  const notice = message
    ? `<section class="panel" role="status" ${messageAttributes(message)}>${messageBody(message, '', 'h2')}</section>`
    : '';
  const outcome = results
    ? `<section class="panel" role="status"><h2>Run results</h2><ul>${results
        .map(
          ({ runId, outcome }) =>
            `<li><code>${escapeHtml(runId)}</code> · ${escapeHtml(outcome)}</li>`,
        )
        .join('')}</ul></section>`
    : '';
  return renderWorkspaceWorklist(
    view,
    'Approvals',
    `<div data-workflow-approvals>${notice}${outcome}
    <section class="panel"><h2>Pending plans</h2>
      ${plans || empty('WORKFLOW_APPROVALS_EMPTY')}
    </section>
    <section class="panel"><h2>Suspended runs</h2>
      ${
        runs
          ? `<form action="${WORKFLOW_APPROVALS_HREF}" method="post">
        <ul>${runs}</ul>
        <button name="action" value="retry">Retry selected</button>
        <button name="action" value="cancel">Cancel selected</button>
      </form>`
          : empty('WORKFLOW_SUSPENDED_EMPTY')
      }
    </section></div>
  `,
  );
}

function renderApprovalPlan(plan: ApprovalPlan): string {
  const identity = {
    runId: plan.runId,
    cursor: String(plan.cursor),
    fence: plan.fence,
    digest: plan.digest,
  };
  return `<article class="panel" data-workflow-approval>
    <h3>${escapeHtml(plan.summary)}</h3>
    <dl><dt>Company</dt><dd><code>${escapeHtml(plan.companyId)}</code></dd>
        <dt>Operation</dt><dd><code>${escapeHtml(plan.operationId)}</code></dd></dl>
    <h4>Exact inputs</h4>
    <pre class="workflow-plan-input"><code>${escapeHtml(JSON.stringify(plan.input, null, 2))}</code></pre>
    <form action="${WORKFLOW_APPROVALS_HREF}" method="post">
      ${Object.entries(identity)
        .map(
          ([key, value]) =>
            `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`,
        )
        .join('')}
      <button name="action" value="approve">Approve</button>
      <button name="action" value="decline">Decline</button>
    </form>
  </article>`;
}

function empty(
  code: 'WORKFLOW_APPROVALS_EMPTY' | 'WORKFLOW_SUSPENDED_EMPTY',
): string {
  const ref = { code };
  return `<div ${messageAttributes(ref)}>${messageBody(ref, '', 'h2')}</div>`;
}
