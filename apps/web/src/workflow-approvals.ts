import type { TrustedRequestContext } from '@north-star/runtime/request-context';
import type { SurfaceMessageRef } from './message-render.js';

export const WORKFLOW_APPROVALS_HREF = '/?approvals';

interface ApprovalSelection {
  readonly runId: string;
  readonly cursor: number;
  readonly fence: string;
  readonly digest: string;
}

export interface ApprovalPlan extends ApprovalSelection {
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

export async function loadWorkflowApprovals(
  actor: TrustedRequestContext,
  service: WorkflowApprovalsService,
  submission: Readonly<Record<string, string>> | null,
) {
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
  return { worklist, message, results };
}

export type WorkflowApprovalsData = Awaited<
  ReturnType<typeof loadWorkflowApprovals>
>;
