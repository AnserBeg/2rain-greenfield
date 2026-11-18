import type { Server } from 'node:http';

/**
 * Close a per-test HTTP server without waiting on idle or in-flight sockets.
 * `server.close` only calls back once every connection is gone; a page that is
 * still open holds keep-alive sockets (stylesheet, lazily requested fonts), so
 * a bare `close` can hang until the test timeout.
 */
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
