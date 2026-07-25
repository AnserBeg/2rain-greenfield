export const reachabilityRunIdPath: string;

export interface ReachabilityRunContext {
  readonly repositoryRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly generateRunId?: () => string;
}

export function beginReachabilityRun(context: ReachabilityRunContext): string;
export function ensureReachabilityRun(context: ReachabilityRunContext): string;
export function resolveReachabilityRunId(
  context: Omit<ReachabilityRunContext, 'generateRunId'>,
): string;
export function validateReachabilityRunId(runId: string): string;
