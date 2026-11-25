import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  closeFixtureApp,
  trackFixtureRequests,
} from '../helpers/close-fixture-app.js';

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

// CI-8: an idle keep-alive socket and a request the server never answered
// print differently, and the unanswered one is named by method and URL.
test('the stop tells an unanswered request from an idle socket', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/never') return; // never answered
    response.end('ok');
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  trackFixtureRequests(server);
  const app = {
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  const port = (server.address() as AddressInfo).port;
  const idle = await silentSocket(port);
  const hung = connect(port, '127.0.0.1');
  hung.on('error', () => undefined);
  hung.write('GET /never HTTP/1.1\r\nHost: x\r\n\r\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const printed: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    printed.push(parts.join(' '));
  };
  try {
    await closeFixtureApp(app, 'probe', 5_000);
  } finally {
    console.error = original;
    idle.destroy();
    hung.destroy();
  }
  assert.match(
    printed[0] ?? '',
    /2 open connection\(s\), 1 unanswered request\(s\): GET \/never/u,
  );
});

test('a server whose requests are not tracked says so', async () => {
  const { app } = await listening();
  const printed: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    printed.push(parts.join(' '));
  };
  try {
    await closeFixtureApp(app, 'untracked', 5_000);
  } finally {
    console.error = original;
  }
  assert.match(printed[0] ?? '', /requests not tracked/u);
});

// CI-8: a serve child that hits the bound error must exit, not set a code and
// stay alive on stdin; the other two fixtures exit through an unhandled
// rejection.
test('the planner-map child exits after a bound error', () => {
  const source = readFileSync('test/helpers/planner-map-fixture.ts', 'utf8');
  assert.match(
    source,
    /console\.error\(error\);\n\s*(?:\/\/.*\n\s*)*process\.exit\(1\);/u,
  );
  assert.doesNotMatch(source, /process\.exitCode/u);
});
