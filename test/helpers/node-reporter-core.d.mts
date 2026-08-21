export interface NodeResultEvent {
  readonly type: string;
  readonly data: {
    readonly name?: unknown;
    readonly file?: unknown;
    readonly skip?: unknown;
    readonly todo?: unknown;
    readonly counts?: { readonly tests?: unknown };
    readonly details?: {
      readonly type?: unknown;
      readonly error?: {
        readonly failureType?: unknown;
        readonly message?: unknown;
      };
    };
  };
}

export interface NodeResultCounts {
  readonly passed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface NodeResultLedger {
  observe(event: NodeResultEvent): void;
  /** Results whose file completed, taken before that file reported its summary. */
  credited(): ReadonlyArray<{
    readonly event: NodeResultEvent;
    readonly file: string;
  }>;
  /** Per-file counts Node itself reported, for reconciliation. */
  summaries(): ReadonlyMap<string, Partial<NodeResultCounts>>;
}

export interface NodeReporterContext {
  readonly suiteId: string;
  readonly workingDirectory: string;
  readonly reporterPath: string;
  readonly repositoryRoot: string;
}

export function creditableNodeResultPath(
  event: NodeResultEvent,
): string | undefined;

export function assertUnfilteredNodeArguments(
  arguments_: readonly string[],
  context: NodeReporterContext,
): void;

export function createNodeResultLedger(): NodeResultLedger;
