/**
 * The dev entry point's shutdown, extracted so its failure branches can be
 * driven from a test instead of only from a live Docker daemon.
 *
 * Two properties are load-bearing and neither is obvious from the call site:
 *
 * 1. **An in-flight container create/start is settled BEFORE the stop runs.**
 *    Without that, a signal arriving while `docker run --detach` is still
 *    executing exits the process before the container exists, and the Docker
 *    child then finishes creating it — an orphan with no owner left to reap
 *    it. Recording ownership before issuing the command does not fix this on
 *    its own: the stop would simply run first and the creation would complete
 *    afterwards. The command has to be waited out.
 *
 * 2. **Every step runs even when an earlier one fails.** The previous shape
 *    skipped `docker stop` whenever closing the application rejected, and then
 *    exited 0 — reporting success while leaking the container.
 */

export interface ShutdownSteps {
  /** Closes the HTTP server and runtime pools, when one was ever started. */
  readonly closeApplication?: (() => Promise<void>) | undefined;
  /**
   * Waits for any in-flight `docker run` / `docker start` to settle. Its
   * rejection is not a shutdown failure — the command failing is precisely a
   * case where cleanup must still be attempted.
   */
  readonly settleContainerCommand?: (() => Promise<void>) | undefined;
  /** Stops the container, when one was ever attempted. */
  readonly stopContainer?: (() => Promise<void>) | undefined;
}

export interface ShutdownOutcome {
  readonly failures: readonly unknown[];
  /** The order steps actually ran in, so a test can assert the sequencing. */
  readonly ran: readonly string[];
}

export async function runShutdown(
  steps: ShutdownSteps,
): Promise<ShutdownOutcome> {
  const failures: unknown[] = [];
  const ran: string[] = [];
  if (steps.closeApplication) {
    ran.push('closeApplication');
    try {
      await steps.closeApplication();
    } catch (error) {
      failures.push(error);
    }
  }
  if (steps.stopContainer) {
    if (steps.settleContainerCommand) {
      ran.push('settleContainerCommand');
      try {
        await steps.settleContainerCommand();
      } catch {
        // Deliberately swallowed: a failed create is a reason to clean up, not
        // a reason to skip cleanup or to report a shutdown failure.
      }
    }
    ran.push('stopContainer');
    try {
      await steps.stopContainer();
    } catch (error) {
      failures.push(error);
    }
  }
  return { failures, ran };
}
