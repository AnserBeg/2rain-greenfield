/**
 * The PostgreSQL shard time budget (CI-9). A shard job runs its files back to
 * back, so its wall time is about the sum of its files' times. The estimates
 * are recorded in postgres-shard-estimates.json; this reads them and names every
 * shard whose sum passes the budget, so a packet that adds a heavy file to a
 * full shard fails here (and in `pnpm preflight`) instead of timing out on CI.
 */
export interface ShardEstimates {
  readonly budgetSeconds: number;
  /**
   * CI-10: a shard that runs one file cannot be split further by moving files,
   * so it is held to this ceiling instead of budgetSeconds.
   */
  readonly singleFileShardCeilingSeconds: number;
  readonly unrecordedFileSeconds: number;
  readonly files: Readonly<Record<string, number>>;
}

export interface ShardEstimate {
  readonly id: string;
  readonly fileCount: number;
  readonly seconds: number;
  readonly heaviest: readonly string[];
}

export function estimateShards(
  layout: ReadonlyMap<string, readonly string[]>,
  estimates: ShardEstimates,
): ShardEstimate[] {
  return [...layout].map(([id, files]) => {
    const timed = files.map(
      (file) =>
        [
          file,
          estimates.files[file] ?? estimates.unrecordedFileSeconds,
        ] as const,
    );
    return {
      id,
      fileCount: files.length,
      seconds: timed.reduce((sum, [, seconds]) => sum + seconds, 0),
      heaviest: [...timed]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([file, seconds]) => `${file} ${String(seconds)} s`),
    };
  });
}

/** One line per shard over the budget; empty when every shard fits. */
export function shardsOverBudget(
  layout: ReadonlyMap<string, readonly string[]>,
  estimates: ShardEstimates,
): string[] {
  for (const bound of [
    estimates.budgetSeconds,
    estimates.singleFileShardCeilingSeconds,
  ]) {
    // A missing bound would compare false and refuse nothing.
    if (!Number.isFinite(bound)) {
      throw new Error(`A shard time bound is not a number: ${String(bound)}`);
    }
  }
  return estimateShards(layout, estimates)
    .filter(({ seconds }) => seconds > estimates.budgetSeconds)
    .filter(
      ({ fileCount, seconds }) =>
        fileCount !== 1 || seconds > estimates.singleFileShardCeilingSeconds,
    )
    .map(
      ({ id, fileCount, seconds, heaviest }) =>
        `${id} is estimated at ${String(seconds)} s, over the ${String(estimates.budgetSeconds)} s budget${fileCount === 1 ? ` and the ${String(estimates.singleFileShardCeilingSeconds)} s single-file ceiling` : ''} (heaviest: ${heaviest.join(', ')}). Move a file to a lighter shard in package.json and test/helpers/reachability-producers.ts, identically, and update the catch-all exclusion list if it moves out of postgres-3; record its seconds in test/helpers/postgres-shard-estimates.json.`,
    );
}
