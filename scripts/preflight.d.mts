export interface PreflightStep {
  id: string;
  title: string;
  remedy: string;
  skip?: boolean;
  command?: string[];
  check?: () => { ok: boolean; output: string };
  namedFailures?: boolean;
}
export function changedFiles(): {
  base: string;
  files: string[];
  all: string[];
};
export function migrationSnapshotProblem(changed: string[]): string | undefined;
export function replaySnapshotWarning(changed: string[]): string | undefined;
export function failedTestNames(output: string): string[];
export function steps(changed: {
  base: string;
  files: string[];
  all: string[];
}): PreflightStep[];
