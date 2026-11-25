import type { Server } from 'node:http';

/**
 * Stop a browser fixture's composed application without waiting on sockets.
 *
 * `server.close` calls back only once every connection is gone, and on the
 * pinned Node a socket that connected and sent nothing (a browser's
 * speculative connection, for one) is not closed by it: a bare `close` was
 * still pending after 400 s in isolation (CI-7). The page is still open when a
 * fixture is told to stop, so the sockets are closed first. The wait is bounded
 * and prints one marker per step, so a request the server never answered shows
 * in the fixture output instead of as a bare test timeout.
 */
export async function closeFixtureApp(
  app: { readonly server: Server; close(): Promise<void> },
  label: string,
  boundMilliseconds = 60_000,
): Promise<void> {
  const open = await new Promise<number>((resolve) => {
    app.server.getConnections((_error, count) => resolve(count ?? 0));
  });
  console.error(
    `${label}: closing the application; ${String(open)} open connection(s)`,
  );
  app.server.closeAllConnections();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), boundMilliseconds);
  });
  try {
    const result = await Promise.race([
      app.close().then(() => 'closed' as const),
      late,
    ]);
    if (result === 'late') {
      throw new Error(
        `${label}: the application did not close within ${String(boundMilliseconds)} ms`,
      );
    }
    console.error(`${label}: application closed`);
  } finally {
    clearTimeout(timer);
  }
}
