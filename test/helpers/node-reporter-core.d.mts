export interface NodeResultEvent {
  readonly type: string;
  readonly data: {
    readonly name?: unknown;
    readonly file?: unknown;
    readonly skip?: unknown;
    readonly todo?: unknown;
    readonly details?: { readonly type?: unknown };
  };
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
