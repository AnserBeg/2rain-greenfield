export interface ScheduledWorker {
  poll(): Promise<void>;
}

/** Run one pass at a time, and drain the current pass on shutdown. */
export function superviseWorkerPolls(
  workers: readonly ScheduledWorker[],
  reportFailure: () => void,
  interval = 1_000,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll(): Promise<void> {
    try {
      for (const worker of workers) {
        try {
          await worker.poll();
        } catch {
          reportFailure();
        }
      }
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          active = poll();
        }, interval).unref();
    }
  }
  let active = poll();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
