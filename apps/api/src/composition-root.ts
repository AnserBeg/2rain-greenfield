import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import {
  createComposedApplicationRuntime,
  type ComposedApplicationRuntime,
} from '@north-star/postgres-provider/composed-application-runtime';
import { createSurfaceRuntimeServer } from '@north-star/web/app-server';

export interface ComposedApplicationServerOptions {
  readonly databaseUrl: string;
  readonly host?: string;
  readonly port?: number;
  readonly tenantSlug?: string;
}

export interface RunningComposedApplication {
  readonly baseUrl: string;
  readonly runtime: ComposedApplicationRuntime;
  readonly server: Server;
  close(): Promise<void>;
}

/** Thin transport root: provider assembly owns persistence and runtime wiring. */
export async function startComposedApplication(
  options: ComposedApplicationServerOptions,
): Promise<RunningComposedApplication> {
  const compiledApplication = JSON.parse(
    await readFile(
      new URL('../../web/release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as unknown;
  const runtime = await createComposedApplicationRuntime({
    compiledApplication,
    databaseUrl: options.databaseUrl,
    migrationsDirectory: new URL('../../../db/migrations/', import.meta.url)
      .pathname,
    tenantSlug: options.tenantSlug ?? 'local-composed-application',
  });
  const server = createSurfaceRuntimeServer(runtime.entry, {
    operationGateway: runtime.operationGateway,
    operationMediation: runtime.operationMediation,
    queryGateway: runtime.queryGateway,
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4174, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await runtime.close();
    throw new Error('composed application server has no TCP address');
  }
  let closed = false;
  return Object.freeze({
    baseUrl: `http://${host}:${String(address.port)}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await runtime.close();
    },
    runtime,
    server,
  });
}
