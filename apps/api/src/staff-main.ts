import { readFile, open } from 'node:fs/promises';
import { createServer } from 'node:https';
import pg from 'pg';
import {
  assertPilotDatabase,
  check,
  validateRealm,
  type StaffRealm,
} from './staff-protocol.js';

function setting(name: string) {
  const value = process.env[name];
  check(value && value.trim());
  return value;
}

async function main() {
  const mode = process.argv[2];
  const realm: StaffRealm = {
    tenantId: setting('STAFF_TENANT_ID'),
    environmentId: setting('STAFF_ENVIRONMENT_ID'),
    erpOrigin: setting('STAFF_ERP_ORIGIN'),
    identityOrigin: setting('STAFF_IDENTITY_ORIGIN'),
    rpId: setting('STAFF_RP_ID'),
  };
  validateRealm(realm);
  check(!process.env.NORTH_STAR_LOCAL_DEMO_IDENTITY);
  if (mode === 'bootstrap' || mode === 'recover-owner') {
    const { bootstrapStaff } = await import('./staff-identity.js');
    const name = setting('STAFF_OWNER_NAME'),
      contact = setting('STAFF_VERIFIED_RECOVERY_CONTACT');
    const recovery =
      mode === 'recover-owner'
        ? {
            recover: setting('STAFF_OWNER_PRINCIPAL'),
            reason: setting('STAFF_RECOVERY_REASON'),
          }
        : undefined;
    const pool = new pg.Pool({
      connectionString: setting('STAFF_INSTALLER_DATABASE_URL'),
      max: 1,
    });
    const file = await open(setting('STAFF_INVITATION_FILE'), 'wx', 0o600);
    try {
      const token = await bootstrapStaff(pool, realm, {
        name,
        contact,
        ...recovery,
      });
      await file.writeFile(
        realm.identityOrigin + '/enroll#invite=' + token + '\n',
      );
      await file.sync();
    } finally {
      await file.close();
      await pool.end();
    }
    process.stdout.write(
      'Enrollment invitation saved for attended delivery.\n',
    );
    return;
  }
  const tls = {
    key: await readFile(setting('STAFF_TLS_KEY_FILE')),
    cert: await readFile(setting('STAFF_TLS_CERT_FILE')),
  };
  const origin = new URL(
    mode === 'erp' ? realm.erpOrigin : realm.identityOrigin,
  );
  const rateKey = await readFile(setting('STAFF_RATE_KEY_FILE'));
  const trustedIngress = process.env.STAFF_TRUSTED_INGRESS_ADDRESSES?.split(
    ',',
  ).map((address) => address.trim());
  let server, close: () => Promise<unknown>;
  if (mode === 'erp') {
    const { createPilotApplication } =
      await import('./pilot-composition-root.js');
    const app = await createPilotApplication({
      realm,
      rateKey,
      ...(trustedIngress ? { trustedIngress } : {}),
      ...(process.env.STAFF_APPROVAL_DATABASE_URL
        ? { approvalDatabaseUrl: process.env.STAFF_APPROVAL_DATABASE_URL }
        : {}),
      runtimeDatabaseUrl: setting('STAFF_RUNTIME_DATABASE_URL'),
      ...(process.env.STAFF_IDENTITY_CA_FILE
        ? { identityCa: await readFile(process.env.STAFF_IDENTITY_CA_FILE) }
        : {}),
    });
    server = createServer(tls, (req, res) => {
      app.server.emit('request', req, res);
    });
    close = app.close;
  } else {
    check(mode === 'identity');
    const pool = new pg.Pool({
      connectionString: setting('STAFF_IDENTITY_DATABASE_URL'),
      max: 6,
    });
    try {
      await assertPilotDatabase(pool, 'north_star_identity', realm);
      const { identityHandler } = await import('./staff-identity-http.js');
      const { StaffIdentity } = await import('./staff-identity.js');
      const identity = new StaffIdentity(pool, realm, rateKey);
      server = createServer(tls, identityHandler(identity, trustedIngress));
      close = () => pool.end();
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  server.requestTimeout = 15000;
  server.listen(
    Number(origin.port || 443),
    process.env.STAFF_BIND_ADDRESS ?? '127.0.0.1',
  );
  server.once('error', () => {
    process.stderr.write('Staff listener unavailable.\n');
    process.exitCode = 1;
    void close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () =>
      server.close(() => {
        void close();
      }),
    );
}
void main().catch(() => {
  process.stderr.write(
    'Staff service setup refused. Check the configured realm, database role and protected files.\n',
  );
  process.exitCode = 1;
});
