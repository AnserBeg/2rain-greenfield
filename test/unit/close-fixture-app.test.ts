import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { closeFixtureApp } from '../helpers/close-fixture-app.js';

/**
 * CI-7 item 3. A browser fixture is stopped while its page is open. On the
 * pinned Node a plain `server.close()` does not return while a client holds a
 * socket that connected and sent nothing; `closeFixtureApp` closes the sockets
 * first and bounds the wait.
 */
async function listening(): Promise<{
  app: { readonly server: Server; close(): Promise<void> };
  port: number;
}> {
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const app = {
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  return { app, port: (server.address() as AddressInfo).port };
}

async function silentSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  // Let the server accept it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return socket;
}

test('a fixture whose page holds a silent socket still stops promptly', async () => {
  const { app, port } = await listening();
  const socket = await silentSocket(port);
  const started = Date.now();
  try {
    await closeFixtureApp(app, 'test', 5_000);
    assert.ok(Date.now() - started < 4_000, 'the stop waited on the socket');
  } finally {
    // A failing case must not leave a listening server holding the runner.
    socket.destroy();
    app.server.closeAllConnections();
    app.server.close();
  }
});

test('a stop that cannot finish fails by name at its bound instead of hanging', async () => {
  const { app } = await listening();
  const stuck = {
    server: app.server,
    close: () => new Promise<void>(() => undefined),
  };
  await assert.rejects(
    closeFixtureApp(stuck, 'stuck-fixture', 200),
    /stuck-fixture: the application did not close within 200 ms/u,
  );
  app.server.closeAllConnections();
  await app.close();
});
