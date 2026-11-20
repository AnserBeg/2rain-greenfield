import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import { CAPABILITY_EXECUTOR_FACTORIES } from '../../apps/api/src/erp-capabilities.js';
import { createPilotApplication } from '../../apps/api/src/pilot-composition-root.js';
import {
  bootstrapStaff,
  StaffIdentity,
} from '../../apps/api/src/staff-identity.js';
import { identityHandler } from '../../apps/api/src/staff-identity-http.js';
import {
  assertPilotDatabase,
  type StaffRealm,
} from '../../apps/api/src/staff-protocol.js';
import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import {
  currentPolicyBindingsFromPermissions,
  CURRENT_POLICY_RUNTIME_BINDINGS,
} from '../../packages/postgres-provider/src/current-policy.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { parseNormalizedApplicationPackageJson } from '../../packages/canonical-model/src/index.js';
import { withEphemeralPostgres, LINEAGE_INSTALL_VOLUME } from './postgres.js';

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string')
    throw new Error('Expected loopback listener');
  return addr.port;
}
/** Start an ordinary ERP login without navigating the authenticator's page. */
export function startBrowserLogin(
  realm: StaffRealm,
  ca: Buffer,
  prior?: string,
) {
  const erp = new URL(realm.erpOrigin);
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: erp.port,
        servername: erp.hostname,
        ca,
        path: '/auth/signin',
        headers: {
          host: erp.host,
          ...(prior ? { cookie: '__Host-erp-session=' + prior } : {}),
        },
      },
      (res) => {
        res.resume();
        const cookie = res.headers['set-cookie']?.find((header) =>
          header.startsWith('__Host-erp-login='),
        );
        const verifier = cookie?.match(/^__Host-erp-login=([\w-]{43});/u)?.[1];
        if (res.statusCode === 303 && verifier) resolve(verifier);
        else reject(new Error('ERP login transaction did not start'));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export interface BrowserStaffFixture {
  realm: StaffRealm;
  pool: pg.Pool;
  identity: StaffIdentity;
  invitation: string;
  spki: string;
  ca: Buffer;
  company: string;
}
export async function withStaffBrowser<T>(
  run: (fixture: BrowserStaffFixture) => Promise<T>,
) {
  return withEphemeralPostgres(
    'staff-browser',
    async ({ pool, connection }) => {
      const db = (user: string) =>
        'postgresql://' +
        user +
        '@127.0.0.1:' +
        String(connection.port) +
        '/postgres';
      const compiled: unknown = JSON.parse(
        await readFile('apps/web/release/app.compiled.json', 'utf8'),
      );
      const app = await createComposedApplicationRuntime({
        compiledApplication: compiled,
        databaseUrl: db('postgres'),
        tenantSlug: 'staff-browser',
        migrationsDirectory: 'db/migrations',
        providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
        inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
        capabilityOperationExecutorFactories: CAPABILITY_EXECUTOR_FACTORIES,
      });
      const { tenantId, environmentId } = app.identity;
      await app.close();
      const dir = await mkdtemp(join(tmpdir(), 'staff-tls-'));
      const services: Server[] = [];
      const cleanup: Array<() => Promise<unknown>> = [];
      try {
        await promisify(execFile)('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(dir, 'key'),
          '-out',
          join(dir, 'cert'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,DNS:erp.staff.test,DNS:login.other.test',
        ]);
        const tls = {
          key: await readFile(join(dir, 'key')),
          cert: await readFile(join(dir, 'cert')),
        };
        const { X509Certificate, createHash } = await import('node:crypto');
        const spki = createHash('sha256')
          .update(
            new X509Certificate(tls.cert).publicKey.export({
              type: 'spki',
              format: 'der',
            }),
          )
          .digest('base64');
        const erp = createServer(tls),
          id = createServer(tls);
        services.push(erp, id);
        const erpPort = await listen(erp),
          idPort = await listen(id);
        const r = {
          tenantId,
          environmentId,
          erpOrigin: 'https://erp.staff.test:' + erpPort,
          identityOrigin: 'https://localhost:' + idPort,
          rpId: 'localhost',
        };
        const invitation = await bootstrapStaff(pool, r, {
          name: 'Pilot owner',
          contact: 'attended channel',
        });
        const policy = currentPolicyBindingsFromPermissions(
          parseNormalizedApplicationPackageJson(
            parseCompiledApplication(compiled).application
              .normalizedDefinitionBytes,
          ).permissions,
        );
        for (const binding of [...CURRENT_POLICY_RUNTIME_BINDINGS, ...policy])
          await pool.query(
            `INSERT INTO platform.current_policy_permission_grants
        (tenant_id,environment_id,role_id,permission_id,resource_id) SELECT tenant_id,environment_id,role_id,$3,$4 FROM platform.current_policy_roles
        WHERE tenant_id=$1 AND environment_id=$2 AND role_key='staff-owner' ON CONFLICT DO NOTHING`,
            [tenantId, environmentId, binding.permissionId, binding.resourceId],
          );
        const idPool = new pg.Pool({
          ...connection,
          user: 'north_star_identity',
        });
        cleanup.push(() => idPool.end());
        await assertPilotDatabase(idPool, 'north_star_identity', r);
        const identity = new StaffIdentity(idPool, r, randomBytes(32));
        id.on('request', identityHandler(identity));
        const instances = [];
        for (let i = 0; i < 2; i++) {
          const pilot = await createPilotApplication({
            runtimeDatabaseUrl: db('north_star_runtime'),
            realm: r,
            identityCa: tls.cert,
          });
          cleanup.push(pilot.close);
          instances.push(pilot.server);
        }
        const [primary, replica] = instances;
        let next = 0;
        erp.on('request', (req, res) => {
          if (new URL(req.url ?? '/', r.erpOrigin).pathname === '/')
            next = 1 - next;
          res.setHeader('x-test-instance', String(next));
          (next ? primary! : replica!).emit('request', req, res);
        });
        return await run({
          realm: r,
          pool,
          identity,
          invitation,
          spki,
          ca: tls.cert,
          company: COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
        });
      } finally {
        for (const server of services) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        for (const close of cleanup) await close();
        await rm(dir, { recursive: true });
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
}
