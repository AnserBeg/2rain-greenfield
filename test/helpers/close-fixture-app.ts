import type { Server } from 'node:http';

const unanswered = new WeakMap<Server, Set<{ readonly line: string }>>();

/**
 * Record every request the server has received and not yet answered, from the
 * moment of the call (CI-8). Call it right after the application starts, before
 * any client has its URL. `closeFixtureApp` then prints the unanswered ones by
 * method and URL, so an idle keep-alive socket and a request the server never
 * answered are told apart.
 */
export function trackFixtureRequests(server: Server): void {
  if (unanswered.has(server)) return;
  const open = new Set<{ readonly line: string }>();
  unanswered.set(server, open);
  server.on('request', (request, response) => {
    const entry = { line: `${String(request.method)} ${String(request.url)}` };
    open.add(entry);
    const done = () => open.delete(entry);
    response.once('close', done);
    response.once('finish', done);
  });
}

function describeUnanswered(server: Server): string {
  const open = unanswered.get(server);
  if (open === undefined) return 'requests not tracked';
  const lines = [...open].map((entry) => entry.line);
  return lines.length === 0
    ? '0 unanswered request(s)'
    : `${String(lines.length)} unanswered request(s): ${lines.join('; ')}`;
}

/**
 * Stop a browser fixture's composed application without waiting on sockets.
 *
 * `server.close` calls back only once every connection is gone, and on the
 * pinned Node a socket that connected and sent nothing (a browser's
 * speculative connection, for one) is not closed by it: a bare `close` was
 * still pending after 400 s in isolation (CI-7). The page is still open when a
 * fixture is told to stop, so the sockets are closed first. The wait is bounded
 * and prints one marker per step, with the requests the server never answered
 * (see `trackFixtureRequests`), so a stall shows in the fixture output instead
 * of as a bare test timeout.
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
    `${label}: closing the application; ${String(open)} open connection(s), ${describeUnanswered(app.server)}`,
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
