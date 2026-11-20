import {
  StaffAccessRefused,
  attemptBucket,
  check,
  opaque,
  digest,
  secret,
  type StaffRealm,
} from './staff-protocol.js';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type pg from 'pg';

function field(value: unknown, limit: number): string {
  check(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= limit,
  );
  return value.trim();
}
export async function scoped<T>(
  pool: pg.Pool,
  realm: StaffRealm,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('north_star.tenant_id',$1,true), set_config('north_star.environment_id',$2,true)",
      [realm.tenantId, realm.environmentId],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Action =
  'signin' | 'invite' | 'recover' | 'deactivate' | 'spare' | 'revoke-key';
interface Intent {
  action: Action;
  sessionDigest?: string;
  name?: string;
  contact?: string;
  subject?: string;
  reason?: string;
}
function intentFrom(input: Record<string, unknown>): Intent {
  switch (input.action) {
    case 'signin':
    case 'spare':
      return { action: input.action };
    case 'invite':
      return {
        action: 'invite',
        name: field(input.name, 120),
        contact: field(input.contact, 200),
      };
    case 'recover':
    case 'deactivate':
      return {
        action: input.action,
        subject: field(input.subject, 36),
        reason: field(input.reason, 200),
      };
    case 'revoke-key':
      return { action: 'revoke-key', subject: field(input.subject, 1400) };
    default:
      throw new StaffAccessRefused();
  }
}
interface Invitation {
  principal_id: string;
  issuer_id: string | null;
  kind: string;
  display_name: string;
  user_handle: Buffer;
}
async function invitation(
  client: pg.PoolClient,
  key: Buffer,
): Promise<Invitation> {
  const result = await client.query<Invitation>(
    `SELECT i.principal_id,i.issuer_id,i.kind,a.display_name,a.user_handle
    FROM platform.staff_invitations i JOIN platform.staff_accounts a USING(tenant_id,environment_id,principal_id)
    WHERE token_digest=$1 AND expires_at>clock_timestamp() AND retired_at IS NULL AND a.status <> 'inactive'`,
    [key],
  );
  const row = result.rows[0];
  check(row);
  if (row.issuer_id && ['invite', 'recover'].includes(row.kind)) {
    check(
      (
        await client.query(
          `SELECT CASE WHEN kind='recover' THEN platform.staff_can_manage(tenant_id,environment_id,issuer_id,principal_id)
             ELSE platform.staff_has_role(tenant_id,environment_id,issuer_id,'staff-owner') END AS allowed
             FROM platform.staff_invitations WHERE token_digest=$1`,
          [key],
        )
      ).rows[0]?.allowed,
    );
  }
  return row;
}
async function lockAccount(client: pg.PoolClient, p: string) {
  const row = await client.query<{ status: string }>(
    `SELECT status FROM platform.staff_accounts WHERE principal_id=$1 FOR UPDATE`,
    [p],
  );
  check(row.rows[0]);
  return row.rows[0];
}
function audit(
  client: pg.PoolClient,
  r: StaffRealm,
  event: string,
  actor: string | null,
  subject: string,
  reason: string | null = null,
  attended = false,
) {
  return client.query(
    `INSERT INTO platform.staff_authentication_audit
    (tenant_id,environment_id,event_type,actor_id,subject_id,method,assurance,reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      r.tenantId,
      r.environmentId,
      event,
      actor,
      subject,
      attended ? 'attended-installation' : 'webauthn',
      attended ? 'attended' : 'user-verified-passkey',
      reason,
    ],
  );
}
async function issueInvite(
  client: pg.PoolClient,
  r: StaffRealm,
  subject: string,
  issuer: string | null,
  kind: string,
) {
  const token = secret();
  await client.query(
    `INSERT INTO platform.staff_invitations
    (tenant_id,environment_id,principal_id,issuer_id,token_digest,kind,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+ CASE WHEN $6='invite' THEN interval '24 hours' ELSE interval '15 minutes' END)`,
    [r.tenantId, r.environmentId, subject, issuer, digest(token), kind],
  );
  return token;
}
async function newAccount(
  c: pg.PoolClient,
  r: StaffRealm,
  name: string,
  contact: string,
) {
  const p = randomUUID();
  await c.query(
    `INSERT INTO platform.staff_accounts
    (tenant_id,environment_id,principal_id,user_handle,display_name,recovery_contact,status)
    VALUES($1,$2,$3,$4,$5,$6,'pending')`,
    [
      r.tenantId,
      r.environmentId,
      p,
      randomBytes(32),
      field(name, 120),
      field(contact, 200),
    ],
  );
  return p;
}

// Installer-only command. The environment row serializes first-owner bootstrap.
// It also fences the attended recovery of the sole owner.
export async function bootstrapStaff(
  pool: pg.Pool,
  r: StaffRealm,
  details: { name: string; contact: string; recover?: string; reason?: string },
) {
  return scoped(pool, r, async (c) => {
    await c.query("SELECT platform.claim_staff_store_mode('pilot')");
    check(
      (
        await c.query(
          `SELECT FROM platform.environments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [r.tenantId, r.environmentId],
        )
      ).rowCount,
    );
    check(
      !(
        await c.query(
          "SELECT FROM pg_roles WHERE rolname='north_star_fixture_proof_issuer'",
        )
      ).rowCount,
    );
    const args = [r.tenantId, r.environmentId];
    check(
      !(
        await c.query(
          'SELECT FROM platform.staff_relying_parties WHERE rp_id<>$1 OR identity_origin<>$2 LIMIT 1',
          [r.rpId, r.identityOrigin],
        )
      ).rowCount,
    );
    await c.query(
      'INSERT INTO platform.staff_relying_parties(tenant_id,environment_id,rp_id,identity_origin,application_origin) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [...args, r.rpId, r.identityOrigin, r.erpOrigin],
    );
    check(
      (
        await c.query(
          'SELECT platform.staff_realm_configured($1,$2,$3,$4,$5) AS ok',
          [...args, r.rpId, r.identityOrigin, r.erpOrigin],
        )
      ).rows[0]?.ok,
    );
    check(
      !(
        await c.query(
          `SELECT FROM platform.current_policy_roles WHERE tenant_id=$1 AND environment_id=$2 AND role_key LIKE 'local-demo-%'`,
          args,
        )
      ).rowCount,
    );
    if (details.recover) {
      check(
        (
          await c.query(
            'SELECT FROM platform.current_policy_epochs WHERE tenant_id=$1 AND environment_id=$2 FOR UPDATE',
            args,
          )
        ).rowCount,
      );
      const owner = await c.query(
        `SELECT a.principal_id FROM platform.staff_accounts a JOIN platform.current_policy_memberships m
        USING(tenant_id,environment_id,principal_id) JOIN platform.current_policy_roles r USING(tenant_id,environment_id,role_id)
        WHERE a.tenant_id=$1 AND a.environment_id=$2 AND r.role_key='staff-owner' AND m.revoked_at IS NULL AND r.revoked_at IS NULL
        AND a.status<>'inactive' FOR UPDATE OF a`,
        args,
      );
      check(
        owner.rowCount === 1 && owner.rows[0]?.principal_id === details.recover,
      );
      check(
        (
          await c.query(
            `SELECT FROM platform.staff_accounts WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND recovery_contact=$4`,
            [...args, details.recover, details.contact],
          )
        ).rowCount,
      );
      await retireAccess(c, r, details.recover, true);
      await audit(
        c,
        r,
        'recover',
        null,
        details.recover,
        field(details.reason, 200),
        true,
      );
      return issueInvite(c, r, details.recover, null, 'recover');
    }
    check(
      !(
        await c.query(
          'SELECT FROM platform.staff_accounts WHERE tenant_id=$1 AND environment_id=$2',
          args,
        )
      ).rowCount,
    );
    const p = await newAccount(c, r, details.name, details.contact);
    for (const role of ['staff-owner', 'staff-member'])
      await c.query(
        `INSERT INTO platform.current_policy_roles
      (tenant_id,environment_id,role_id,role_key) VALUES($1,$2,gen_random_uuid(),$3)
      ON CONFLICT (tenant_id,environment_id,role_key) DO NOTHING`,
        [...args, role],
      );
    check(
      (
        await c.query(
          `INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,principal_id,membership_id,role_id)
      SELECT $1,$2,$3,gen_random_uuid(),role_id FROM platform.current_policy_roles WHERE tenant_id=$1 AND environment_id=$2
      AND role_key='staff-owner' AND revoked_at IS NULL`,
          [...args, p],
        )
      ).rowCount,
    );
    await audit(c, r, 'bootstrap', null, p, null, true);
    return issueInvite(c, r, p, null, 'bootstrap');
  });
}
async function retireAccess(
  c: pg.PoolClient,
  r: StaffRealm,
  p: string,
  recover: boolean,
) {
  const args = [r.tenantId, r.environmentId, p];
  for (const [table, stamp] of [
    ['staff_sessions', 'revoked_at'],
    ['staff_credentials', 'revoked_at'],
    ['staff_invitations', 'retired_at'],
  ] as const)
    await c.query(
      `UPDATE platform.${table} SET ${stamp}=clock_timestamp()
      WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND ${stamp} IS NULL`,
      args,
    );
  await c.query(
    `UPDATE platform.staff_accounts SET status=$4, decisions_after=clock_timestamp()+interval '24 hours'
    WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3`,
    [...args, recover ? 'pending' : 'inactive'],
  );
}

interface Ceremony {
  kind: string;
  challenge: string;
  invitation: Buffer | null;
  application_binding: Buffer | null;
  intent: Intent;
  expires_at: Date;
}
export class StaffIdentity {
  constructor(
    readonly pool: pg.Pool,
    readonly realm: StaffRealm,
    private readonly rateKey: Buffer,
  ) {
    check(rateKey.length >= 32);
  }
  private scoped<T>(work: (c: pg.PoolClient) => Promise<T>) {
    return scoped(this.pool, this.realm, work);
  }
  async spend(category: string, identifier: string, limit: number) {
    const key = attemptBucket(this.rateKey, category, identifier);
    const result = await this.scoped((c) =>
      c.query('SELECT platform.staff_spend_attempt($1,$2,$3,$4) AS allowed', [
        this.realm.tenantId,
        this.realm.environmentId,
        key,
        limit,
      ]),
    );
    check(result.rows[0]?.allowed);
  }
  async begin(
    browser: string,
    input: Record<string, unknown>,
    identity?: string,
  ) {
    const token = input.invite ? digest(opaque(input.invite)) : null;
    const intent: Intent = token
      ? { action: 'signin' as const }
      : intentFrom(input);
    if (!token && (intent.action !== 'signin' || identity)) {
      check(identity);
      await this.account(identity);
      intent.sessionDigest = digest(identity).toString('hex');
    }
    const binding =
      intent.action === 'signin' && !token
        ? Buffer.from(opaque(input.binding), 'base64url')
        : null;
    return this.scoped(async (c) => {
      if (binding)
        check(
          (
            await c.query(
              'SELECT FROM platform.staff_login_transactions WHERE binding=$1 AND consumed_at IS NULL AND expires_at>platform.staff_observed_time()',
              [binding],
            )
          ).rowCount,
        );
      const subject = token ? await invitation(c, token) : null;
      const options = subject
        ? await generateRegistrationOptions({
            rpID: this.realm.rpId,
            rpName: '2rain',
            userName: subject.display_name,
            userID: new Uint8Array(subject.user_handle),
            attestationType: 'none',
            excludeCredentials: (
              await c.query<{ credential_id: string }>(
                "SELECT credential_id FROM platform.staff_credentials WHERE principal_id=$1 AND method='webauthn' AND revoked_at IS NULL",
                [subject.principal_id],
              )
            ).rows.map((row) => ({ id: row.credential_id })),
            authenticatorSelection: {
              residentKey: 'required',
              userVerification: 'required',
            },
            timeout: 300000,
          })
        : await generateAuthenticationOptions({
            rpID: this.realm.rpId,
            userVerification: 'required',
            timeout: 300000,
          });
      await c.query(
        `INSERT INTO platform.staff_ceremonies(tenant_id,environment_id,browser_digest,kind,challenge,expires_at,invitation,application_binding,intent)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes',$6,$7,$8)
        ON CONFLICT(browser_digest) DO UPDATE SET kind=excluded.kind,challenge=excluded.challenge,expires_at=excluded.expires_at,
          invitation=excluded.invitation,application_binding=excluded.application_binding,intent=excluded.intent,consumed_at=NULL`,
        [
          this.realm.tenantId,
          this.realm.environmentId,
          digest(browser),
          token ? 'registration' : 'authentication',
          options.challenge,
          token,
          binding,
          intent,
        ],
      );
      return options;
    });
  }
  async finish(
    browser: string,
    reply: RegistrationResponseJSON | AuthenticationResponseJSON,
    oldIdentity?: string,
  ) {
    check(reply && typeof reply.id === 'string' && reply.id.length <= 1400);
    const consumed = await this.scoped((c) =>
      c.query<Ceremony>(
        `UPDATE platform.staff_ceremonies SET consumed_at=clock_timestamp()
      WHERE browser_digest=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`,
        [digest(browser)],
      ),
    );
    const tx = consumed.rows[0];
    check(tx);
    const account = tx.invitation
      ? null
      : await this.scoped((c) =>
          c.query<{ principal_id: string }>(
            "SELECT principal_id FROM platform.staff_credentials WHERE method='webauthn' AND credential_id=$1",
            [reply.id],
          ),
        );
    const limitKey =
      tx.invitation?.toString('hex') ??
      account?.rows[0]?.principal_id ??
      reply.id;
    await this.spend('completion', limitKey, 5);
    const expected = {
      expectedChallenge: tx.challenge,
      expectedOrigin: this.realm.identityOrigin,
      expectedRPID: this.realm.rpId,
      requireUserVerification: true,
    };
    const result = await this.scoped(async (c) => {
      if (tx.kind === 'registration') {
        check(tx.invitation);
        const first = await invitation(c, tx.invitation);
        await lockAccount(c, first.principal_id);
        const i = await invitation(c, tx.invitation);
        const proof = await verifyRegistrationResponse({
          ...expected,
          response: reply as RegistrationResponseJSON,
          requireUserPresence: true,
        });
        check(proof.verified && proof.registrationInfo);
        const { credential, credentialBackedUp, credentialDeviceType } =
          proof.registrationInfo;
        if (i.kind === 'invite')
          await c.query('SELECT platform.staff_assign_member($1,$2,$3,$4)', [
            this.realm.tenantId,
            this.realm.environmentId,
            i.principal_id,
            i.issuer_id,
          ]);
        check(
          (
            await c.query('SELECT clock_timestamp() < $1 AS current', [
              tx.expires_at,
            ])
          ).rows[0]?.current,
        );
        const enrollment = await c.query(
          `INSERT INTO platform.staff_credentials(tenant_id,environment_id,principal_id,method,credential_id,public_key,sign_count,backup_eligible,backed_up,transports)
          VALUES($1,$2,$3,'webauthn',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [
            this.realm.tenantId,
            this.realm.environmentId,
            i.principal_id,
            credential.id,
            Buffer.from(credential.publicKey),
            credential.counter,
            credentialDeviceType === 'multiDevice',
            credentialBackedUp,
            credential.transports ?? [],
          ],
        );
        check(enrollment.rowCount === 1);
        await c.query(
          "UPDATE platform.staff_accounts SET status='active' WHERE principal_id=$1",
          [i.principal_id],
        );
        check(
          (
            await c.query(
              'UPDATE platform.staff_invitations SET retired_at=clock_timestamp() WHERE token_digest=$1 AND retired_at IS NULL AND expires_at>clock_timestamp()',
              [tx.invitation],
            )
          ).rowCount,
        );
        await audit(c, this.realm, 'enroll', i.principal_id, i.principal_id);
        return { enrolled: true };
      }
      const lookup = await c.query<{ principal_id: string }>(
        "SELECT principal_id FROM platform.staff_credentials WHERE method='webauthn' AND credential_id=$1",
        [reply.id],
      );
      const actor = lookup.rows[0]?.principal_id;
      check(actor);
      check((await lockAccount(c, actor)).status === 'active');
      const stored = (
        await c.query<{
          public_key: Buffer;
          sign_count: string;
          user_handle: Buffer;
          backup_eligible: boolean;
        }>(
          `SELECT k.public_key,k.sign_count,a.user_handle,k.backup_eligible
        FROM platform.staff_credentials k JOIN platform.staff_accounts a USING(tenant_id,environment_id,principal_id)
        WHERE method='webauthn' AND credential_id=$1 AND revoked_at IS NULL
          AND platform.staff_has_role(a.tenant_id,a.environment_id,a.principal_id,NULL)`,
          [reply.id],
        )
      ).rows[0];
      const assertion = reply as AuthenticationResponseJSON;
      check(
        stored &&
          assertion.response.userHandle ===
            stored.user_handle.toString('base64url'),
      );
      const proof = await verifyAuthenticationResponse({
        ...expected,
        response: assertion,
        credential: {
          id: reply.id,
          publicKey: new Uint8Array(stored.public_key),
          counter: Number(stored.sign_count),
        },
      });
      check(
        proof.verified &&
          stored.backup_eligible ===
            (proof.authenticationInfo.credentialDeviceType === 'multiDevice'),
      );
      check(
        (
          await c.query('SELECT clock_timestamp() < $1 AS current', [
            tx.expires_at,
          ])
        ).rows[0]?.current,
      );
      await c.query(
        "UPDATE platform.staff_credentials SET sign_count=$2,backed_up=$3 WHERE method='webauthn' AND credential_id=$1",
        [
          reply.id,
          proof.authenticationInfo.newCounter,
          proof.authenticationInfo.credentialBackedUp,
        ],
      );
      check(
        (oldIdentity ? digest(oldIdentity).toString('hex') : undefined) ===
          tx.intent.sessionDigest,
      );
      if (tx.intent.action !== 'signin') {
        check(oldIdentity);
        check(
          (
            await c.query(
              `SELECT FROM platform.staff_sessions WHERE principal_id=$1 AND identity_digest=$2 AND revoked_at IS NULL
               AND platform.staff_observed_time() >= last_activity
               AND platform.staff_observed_time()<LEAST(absolute_deadline,last_activity+interval '30 minutes') FOR UPDATE`,
              [actor, digest(oldIdentity)],
            )
          ).rowCount,
        );
        return this.manage(c, actor, reply.id, tx.intent);
      }
      check(tx.application_binding);
      const login = (
        await c.query<{ prior_application_digest: Buffer | null }>(
          `SELECT prior_application_digest FROM platform.staff_login_transactions
         WHERE binding=$1 AND consumed_at IS NULL AND expires_at>platform.staff_observed_time() FOR UPDATE`,
          [tx.application_binding],
        )
      ).rows[0];
      check(login);
      const identity = secret(),
        handoff = secret();
      const handles = [
        digest(identity),
        digest(handoff),
        tx.application_binding,
      ];
      if (oldIdentity || login.prior_application_digest) {
        // The account is already locked. Rotate the one matching family in place.
        // Concurrent completions recheck the original handles after the lock.
        const rotated = await c.query(
          `WITH instant AS MATERIALIZED (SELECT platform.staff_observed_time() AS at)
           UPDATE platform.staff_sessions s SET identity_digest=$1,handoff_digest=$2,browser_binding=$3,
             application_digest=NULL,authenticated_at=instant.at,last_activity=instant.at,
             handoff_deadline=instant.at+interval '1 minute'
           FROM instant WHERE s.principal_id=$4 AND s.revoked_at IS NULL
             AND ($5::bytea IS NULL OR s.identity_digest=$5) AND ($6::bytea IS NULL OR s.application_digest=$6)
             AND instant.at>=s.last_activity AND instant.at<LEAST(s.absolute_deadline,s.last_activity+interval '30 minutes')`,
          [
            ...handles,
            actor,
            oldIdentity ? digest(oldIdentity) : null,
            login.prior_application_digest,
          ],
        );
        check(rotated.rowCount === 1);
      } else {
        await c.query(
          `WITH instant AS MATERIALIZED (SELECT platform.staff_observed_time() AS at)
           INSERT INTO platform.staff_sessions(tenant_id,environment_id,principal_id,family_id,method,assurance,authenticated_at,last_activity,
             absolute_deadline,identity_digest,handoff_digest,handoff_deadline,browser_binding)
           SELECT $4,$5,$6,gen_random_uuid(),'webauthn','user-verified-passkey',at,at,
             at+interval '12 hours',$1,$2,at+interval '1 minute',$3 FROM instant`,
          [...handles, this.realm.tenantId, this.realm.environmentId, actor],
        );
      }
      await audit(c, this.realm, 'signin', actor, actor);
      return { identity, handoff };
    });
    // Only failures count against the credential/invitation allowance.
    await this.scoped((c) =>
      c.query(
        `UPDATE platform.staff_attempts SET attempts=GREATEST(1,attempts-1),window_start=
      CASE WHEN attempts=1 THEN '-infinity' ELSE window_start END WHERE bucket=$1`,
        [attemptBucket(this.rateKey, 'completion', limitKey)],
      ),
    );
    return result;
  }
  private async manage(
    c: pg.PoolClient,
    actor: string,
    currentKey: string,
    intent: Intent,
  ) {
    const r = this.realm;
    if (intent.action === 'spare') {
      await audit(c, r, 'spare', actor, actor);
      return { invite: await issueInvite(c, r, actor, actor, 'spare') };
    }
    if (intent.action === 'revoke-key') {
      check(
        (
          await c.query(
            `UPDATE platform.staff_credentials SET revoked_at=clock_timestamp() WHERE
        principal_id=$1 AND method='webauthn' AND key_ref=$2 AND credential_id<>$3 AND revoked_at IS NULL`,
            [actor, intent.subject, currentKey],
          )
        ).rowCount,
      );
      await audit(c, r, 'revoke-key', actor, actor);
      return { done: true };
    }
    check(
      (
        await c.query(
          "SELECT platform.staff_has_role($1,$2,$3,'staff-owner') AS allowed",
          [r.tenantId, r.environmentId, actor],
        )
      ).rows[0]?.allowed,
    );
    check(
      (
        await c.query(
          'SELECT FROM platform.staff_accounts WHERE principal_id=$1 AND (decisions_after IS NULL OR decisions_after<=clock_timestamp())',
          [actor],
        )
      ).rowCount,
    );
    if (intent.action === 'invite') {
      const subject = await newAccount(c, r, intent.name!, intent.contact!);
      await audit(c, r, 'invite', actor, subject);
      return {
        subject,
        invite: await issueInvite(c, r, subject, actor, 'invite'),
      };
    }
    const subject = intent.subject!;
    check(subject !== actor);
    check((await lockAccount(c, subject)).status === 'active');
    check(
      (
        await c.query(
          'SELECT platform.staff_can_manage($1,$2,$3,$4) AS allowed',
          [r.tenantId, r.environmentId, actor, subject],
        )
      ).rows[0]?.allowed,
    );
    if (intent.action === 'deactivate')
      await c.query('SELECT platform.staff_disable_memberships($1,$2,$3,$4)', [
        r.tenantId,
        r.environmentId,
        subject,
        actor,
      ]);
    await retireAccess(c, r, subject, intent.action === 'recover');
    await audit(c, r, intent.action, actor, subject, intent.reason);
    return intent.action === 'recover'
      ? { subject, invite: await issueInvite(c, r, subject, actor, 'recover') }
      : { done: true };
  }
  async account(identity: string, foreground = false) {
    return this.scoped(async (c) => {
      const session = await c.query<{ principal_id: string }>(
        `SELECT a.principal_id FROM platform.staff_sessions s JOIN platform.staff_accounts a USING(tenant_id,environment_id,principal_id)
        CROSS JOIN (SELECT platform.staff_observed_time() AS observed) instant
        WHERE identity_digest=$1 AND platform.staff_has_role(a.tenant_id,a.environment_id,a.principal_id,NULL) AND revoked_at IS NULL AND last_activity<=observed
        AND observed<LEAST(absolute_deadline,last_activity+interval '30 minutes')`,
        [digest(identity)],
      );
      const p = session.rows[0]?.principal_id;
      check(p);
      if (foreground)
        await c.query(
          `UPDATE platform.staff_sessions SET last_activity=observed FROM (SELECT platform.staff_observed_time() AS observed) instant
        WHERE identity_digest=$1 AND revoked_at IS NULL AND observed>=last_activity+interval '1 minute'
        AND observed<LEAST(absolute_deadline,last_activity+interval '30 minutes')`,
          [digest(identity)],
        );
      const owner =
        (
          await c.query(
            "SELECT platform.staff_has_role($1,$2,$3,'staff-owner') AS allowed",
            [this.realm.tenantId, this.realm.environmentId, p],
          )
        ).rows[0]?.allowed === true;
      const keys = await c.query<{ key_ref: string }>(
        'SELECT key_ref FROM platform.staff_credentials WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY key_ref',
        [p],
      );
      const recovery = await c.query<{ subject_id: string; occurred_at: Date }>(
        `SELECT subject_id,occurred_at FROM platform.staff_authentication_audit
        WHERE event_type='recover' AND (subject_id=$1 OR $2) ORDER BY occurred_at DESC LIMIT 10`,
        [p, owner],
      );
      return {
        principal: p,
        owner,
        keys: keys.rows.map((row) => row.key_ref),
        recovery: recovery.rows,
      };
    });
  }
  async redeem(handoff: string, verifier: string, oldErp?: string) {
    const handle = secret();
    return this.scoped(async (c) => {
      const found = await c.query<{ principal_id: string }>(
        'SELECT principal_id FROM platform.staff_sessions WHERE handoff_digest=$1 AND platform.staff_has_role(tenant_id,environment_id,principal_id,NULL)',
        [digest(handoff)],
      );
      const subject = found.rows[0]?.principal_id;
      check(subject && (await lockAccount(c, subject)).status === 'active');
      const binding = digest(verifier);
      check(
        (
          await c.query(
            `UPDATE platform.staff_login_transactions SET consumed_at=observed
         FROM (SELECT platform.staff_observed_time() AS observed) instant WHERE binding=$1
          AND prior_application_digest IS NOT DISTINCT FROM $2::bytea AND consumed_at IS NULL AND expires_at>observed`,
            [binding, oldErp ? digest(oldErp) : null],
          )
        ).rowCount === 1,
      );
      check(
        (
          await c.query(
            `UPDATE platform.staff_sessions SET handoff_digest=NULL,application_digest=$3
         FROM (SELECT platform.staff_observed_time() AS observed) instant
         WHERE handoff_digest=$1 AND browser_binding=$2 AND revoked_at IS NULL AND observed>=last_activity
          AND observed<LEAST(handoff_deadline,absolute_deadline,last_activity+interval '30 minutes')`,
            [digest(handoff), binding, digest(handle)],
          )
        ).rowCount === 1,
      );
      return handle;
    });
  }
  async signout(
    identity: string,
    everywhere: boolean,
    audience: 'identity' | 'erp' = 'identity',
  ) {
    const column =
      audience === 'erp' ? 'application_digest' : 'identity_digest';
    await this.scoped(async (c) => {
      const found = await c.query<{ principal_id: string }>(
        `SELECT principal_id FROM platform.staff_sessions WHERE ${column}=$1`,
        [digest(identity)],
      );
      const subject = found.rows[0]?.principal_id;
      check(subject);
      await lockAccount(c, subject);
      check(
        (
          await c.query(
            `SELECT FROM platform.staff_sessions WHERE ${column}=$1 AND revoked_at IS NULL
        AND platform.staff_observed_time()>=last_activity AND LEAST(last_activity+interval '30 minutes',absolute_deadline)>platform.staff_observed_time()`,
            [digest(identity)],
          )
        ).rowCount,
      );
      await c.query(
        `UPDATE platform.staff_sessions SET revoked_at=clock_timestamp() WHERE principal_id=$1 AND
        ($3 OR ${column}=$2) AND revoked_at IS NULL`,
        [subject, digest(identity), everywhere],
      );
      await audit(
        c,
        this.realm,
        everywhere ? 'signout-everywhere' : 'signout',
        subject,
        subject,
      );
    });
  }
}
