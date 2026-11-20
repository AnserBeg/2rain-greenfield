import assert from 'node:assert/strict';
import { request } from 'node:https';
import { chromium } from '@playwright/test';
import {
  startBrowserLogin,
  withStaffBrowser,
} from './staff-browser-fixture.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { passkeyChecks, signChallenge } from './staff-passkey-checks.js';
import { secret, digest, csrf } from '../../apps/api/src/staff-protocol.js';

async function journey() {
  await withStaffBrowser(
    async ({ realm: r, invitation, spki, ca, company, pool, identity }) => {
      const browser = await chromium.launch({
        args: [
          '--no-proxy-server',
          '--host-resolver-rules=MAP erp.staff.test 127.0.0.1, MAP login.other.test 127.0.0.1',
          '--ignore-certificate-errors-spki-list=' + spki,
        ],
      });
      try {
        const ctx = await browser.newContext(),
          page = await ctx.newPage();
        page.setDefaultTimeout(15000);
        const devtools = await ctx.newCDPSession(page);
        await devtools.send('WebAuthn.enable');
        const addKey = () =>
          devtools.send('WebAuthn.addVirtualAuthenticator', {
            options: {
              protocol: 'ctap2',
              transport: 'internal',
              hasResidentKey: true,
              hasUserVerification: true,
              isUserVerified: true,
              automaticPresenceSimulation: true,
            },
          });
        const { authenticatorId } = await addKey();
        const enroll = async (token: string) => {
          await page.goto(r.identityOrigin + '/enroll#invite=' + token);
          const finish = page.waitForResponse(
            (res) => res.url() === r.identityOrigin + '/finish',
          );
          await page.getByRole('button', { name: 'Create a passkey' }).click();
          assert.equal(
            (await finish).status(),
            200,
            'the registration did not commit',
          );
          await page
            .getByRole('link', { name: 'Sign in to the ERP' })
            .waitFor();
        };
        await enroll(invitation);
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.staff_credentials WHERE revoked_at IS NULL',
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (await pool.query('SELECT FROM platform.staff_sessions')).rowCount,
          0,
        );
        // The stored invite has already been spent, even with a new browser transaction.
        await assert.rejects(identity.begin(secret(), { invite: invitation }));
        await page.getByRole('link', { name: 'Sign in to the ERP' }).click();
        const startLogin = page.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            res.url() === r.erpOrigin + '/auth/signin',
        );
        await page
          .getByRole('button', { name: 'Continue to staff sign-in' })
          .click();
        assert.equal(
          (await startLogin).status(),
          303,
          'the ERP login POST must redirect',
        );
        const button = page.getByRole('button', {
          name: 'Sign in with a passkey',
        });
        await button.waitFor();
        const pre = (await ctx.cookies(r.erpOrigin)).find(
          (c) => c.name === '__Host-erp-login',
        );
        assert.ok(pre);
        let handoff = '';
        page.on('framenavigated', (frame) => {
          if (frame.url().startsWith(r.erpOrigin + '/auth/callback#'))
            handoff = frame.url().split('#')[1]!;
        });
        await button.click();
        await page.waitForURL(
          (url) => url.origin === r.erpOrigin && url.pathname === '/',
        );
        await page
          .getByRole('navigation', { name: 'Release navigation' })
          .waitFor();
        const session = (await ctx.cookies(r.erpOrigin)).find(
          (c) => c.name === '__Host-erp-session',
        );
        assert.ok(session);
        assert.ok(
          session.secure &&
            session.httpOnly &&
            session.sameSite === 'Lax' &&
            session.path === '/' &&
            session.domain === 'erp.staff.test',
        );
        assert.ok(
          session.value !== pre.value &&
            !(await ctx.cookies(r.erpOrigin)).some((c) => c.name === pre.name),
        );
        for (const [name, value] of [
          ['origin', 'https://login.other.test'],
          ['sec-fetch-site', 'cross-site'],
          ['host', 'wrong.test'],
        ] as const) {
          const url = new URL(r.erpOrigin);
          const status = await new Promise<number | undefined>(
            (resolve, reject) => {
              const call = request(
                {
                  hostname: '127.0.0.1',
                  port: url.port,
                  servername: url.hostname,
                  ca,
                  path: '/auth/signout',
                  method: 'POST',
                  headers: {
                    host: url.host,
                    origin: r.erpOrigin,
                    'sec-fetch-site': 'same-origin',
                    cookie: session.name + '=' + session.value,
                    'content-type': 'application/x-www-form-urlencoded',
                    [name]: value,
                  },
                },
                (res) => {
                  res.resume();
                  res.once('end', () => resolve(res.statusCode));
                },
              );
              call.once('error', reject);
              call.end(
                new URLSearchParams({ _csrf: csrf(session.value) }).toString(),
              );
            },
          );
          assert.equal(status, 403);
        }
        const unsigned = await browser.newContext();
        await unsigned.addCookies([{ ...session, value: pre.value }]);
        assert.equal(
          (await (await unsigned.newPage()).goto(r.erpOrigin))?.status(),
          401,
        );
        await unsigned.close();
        assert.ok(handoff);
        await assert.rejects(identity.redeem(handoff, pre.value));
        assert.equal(
          await page.getByText('Switch person', { exact: true }).count(),
          0,
        );
        const outside = await page.evaluate(async () =>
          Promise.all(
            [
              fetch('/?principal_id=unchosen'),
              fetch('/documents?mode=upload', {
                method: 'POST',
                body: 'without a session synchronizer',
              }),
              fetch('/', { headers: { 'x-principal-id': 'unchosen' } }),
              fetch('/', {
                method: 'POST',
                body: new URLSearchParams({
                  localDemoActAs: 'manager',
                  _csrf: document.querySelector<HTMLMetaElement>(
                    'meta[name=erp-csrf]',
                  )!.content,
                }),
              }),
              fetch('/', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-erp-csrf': document.querySelector<HTMLMetaElement>(
                    'meta[name=erp-csrf]',
                  )!.content,
                },
                body: JSON.stringify({ principalId: 'alternative' }),
              }),
              fetch('/', { method: 'POST', body: new URLSearchParams({}) }),
            ].map(async (request) => (await request).status),
          ),
        );
        assert.ok(outside.every((code) => code === 403 || code === 400));
        const total = async (event: string) =>
          (
            await pool.query(
              'SELECT FROM platform.staff_authentication_audit WHERE event_type=$1',
              [event],
            )
          ).rowCount;
        assert.equal(await total('signin'), 1);
        // A different HTTPS site submits a normal browser form. No business effect or sign-out follows.
        await page.route('https://login.other.test/', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<body>Contact origin</body>',
          }),
        );
        await page.goto('https://login.other.test/');
        const refused = page.waitForResponse(
          (response) => response.url() === r.erpOrigin + '/auth/signout',
        );
        await page.evaluate((origin) => {
          const f = document.createElement('form');
          f.method = 'post';
          f.action = origin + '/auth/signout';
          document.body.append(f);
          f.submit();
        }, r.erpOrigin);
        assert.equal((await refused).status(), 403);
        await page.waitForURL(r.erpOrigin + '/auth/signout');
        assert.equal(await total('signout'), 0);
        await page.goto(r.erpOrigin);
        const list =
          r.erpOrigin +
          '/?' +
          new URLSearchParams({
            surface: 'northstar.app:surface.purchase_order_list',
            'northstar.app:parameter.commercial_purchase_order_list_legal_entity_scope':
              company,
          });
        await page.goto(list);
        await page.goto(list);
        await pool.query(
          "UPDATE platform.staff_sessions SET authenticated_at=now()-interval '3 minutes',last_activity=now()-interval '2 minutes',absolute_deadline=now()+interval '1 hour'",
        );
        const res = await page.goto(list);
        assert.equal(res?.status(), 200);
        await page
          .getByRole('heading', { name: /^purchase orders$/iu })
          .first()
          .waitFor();
        assert.equal(
          (
            await pool.query(
              "SELECT FROM platform.staff_sessions WHERE last_activity>now()-interval '1 minute' AND application_digest IS NOT NULL",
            )
          ).rowCount,
          1,
        );
        const timing = parseServerTiming(
          res!.headers()['server-timing'] ?? null,
        );
        assert.ok(
          timing && timing.transactions <= 3 && timing.statements <= 40,
          JSON.stringify(timing),
        );
        process.stdout.write(
          'Signed-in purchase-order list used ' +
            timing.transactions +
            ' transactions and ' +
            timing.statements +
            ' statements.\n',
        );
        await page.goto(r.identityOrigin + '/staff');
        await page
          .getByLabel('Staff name', { exact: true })
          .fill('Pilot member');
        await page
          .getByLabel('Verified recovery contact')
          .fill('attended handoff');
        await page.getByRole('button', { name: 'Invite staff member' }).click();
        const out = page.getByLabel('Enrollment link');
        await out.waitFor();
        const memberToken = (await out.inputValue()).split('#invite=')[1]!;
        await enroll(memberToken);
        const member = (
          await pool.query<{ principal_id: string }>(
            "SELECT principal_id FROM platform.staff_accounts WHERE display_name='Pilot member'",
          )
        ).rows[0]!.principal_id;
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.current_policy_memberships WHERE principal_id=$1 AND revoked_at IS NULL',
              [member],
            )
          ).rowCount,
          1,
        );
        // Leave only the owner's resident key on this authenticator when acting as owner.
        const memberCredential = (
          await pool.query(
            'SELECT credential_id FROM platform.staff_credentials WHERE principal_id=$1',
            [member],
          )
        ).rows[0].credential_id as string;
        const owner = (
          await pool.query(
            "SELECT principal_id FROM platform.staff_accounts WHERE display_name='Pilot owner'",
          )
        ).rows[0].principal_id as string;
        const sign = async (
          key: string,
          input: Record<string, unknown>,
          prior?: string,
        ) => {
          const flow = secret();
          const options = await identity.begin(flow, input, prior);
          return identity.finish(
            flow,
            await signChallenge(page, r.rpId, key, options.challenge),
            prior,
          );
        };
        const ownerKey = (
          await pool.query(
            'SELECT credential_id FROM platform.staff_credentials WHERE principal_id=$1 AND revoked_at IS NULL',
            [owner],
          )
        ).rows[0].credential_id as string;
        const ownerSession = (await ctx.cookies(r.identityOrigin)).find(
          (c) => c.name === '__Host-identity-session',
        );
        assert.ok(ownerSession);
        // An owner needs the member's live business authority to recover that account.
        await pool.query(
          `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
           SELECT tenant_id,environment_id,role_id,'northstar.test:approve','northstar.test:request'
           FROM platform.current_policy_roles WHERE tenant_id=$1 AND environment_id=$2 AND role_key='staff-member'`,
          [r.tenantId, r.environmentId],
        );
        await pool.query(
          `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
           SELECT tenant_id,environment_id,role_id,'northstar.test:approve','northstar.test:invoice'
           FROM platform.current_policy_roles WHERE tenant_id=$1 AND environment_id=$2 AND role_key='staff-owner'`,
          [r.tenantId, r.environmentId],
        );
        const refuseRecovery = (reason: string) =>
          assert.rejects(
            sign(
              ownerKey,
              { action: 'recover', subject: member, reason: 'attended test' },
              ownerSession.value,
            ),
            /Staff access could not be verified/,
            reason,
          );
        await refuseRecovery('recovery must match the permission resource');
        assert.equal(
          (
            await pool.query(
              `SELECT FROM platform.staff_invitations WHERE principal_id=$1 AND kind='recover'`,
              [member],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.staff_credentials WHERE principal_id=$1 AND revoked_at IS NULL',
              [member],
            )
          ).rowCount,
          1,
        );
        await pool.query(
          "UPDATE platform.current_policy_permission_grants SET revoked_at=now() WHERE tenant_id=$1 AND environment_id=$2 AND permission_id='northstar.test:approve'",
          [r.tenantId, r.environmentId],
        );
        for (const change of [
          'set_release_approver_eligibility',
          'set_release_executor_authority',
        ]) {
          const setMember = (enabled: boolean) =>
            pool.query(
              `SELECT platform.${change}($1,$2,$3,$4,gen_random_uuid())`,
              [r.tenantId, member, enabled, owner],
            );
          await setMember(true);
          await refuseRecovery('recovery must cover ' + change);
          await setMember(false);
        }
        const memberVerifier = await startBrowserLogin(r, ca);
        const memberLogin = await sign(memberCredential, {
          action: 'signin',
          binding: digest(memberVerifier).toString('base64url'),
        });
        assert.ok(
          'identity' in memberLogin &&
            memberLogin.identity &&
            memberLogin.handoff,
        );
        const memberHandle = await identity.redeem(
          memberLogin.handoff,
          memberVerifier,
        );
        await assert.rejects(
          sign(
            memberCredential,
            { action: 'recover', subject: owner, reason: 'attended test' },
            memberLogin.identity,
          ),
        );
        await devtools.send('WebAuthn.removeCredential', {
          authenticatorId,
          credentialId: Buffer.from(memberCredential, 'base64url').toString(
            'base64',
          ),
        });
        await page.goto(r.identityOrigin + '/staff');
        await page.getByLabel('Staff ID', { exact: true }).fill(member);
        await page
          .getByLabel('Reason and attended notice reference')
          .fill('Verified in person. Both parties notified.');
        await page
          .getByRole('button', { name: 'Recover staff account' })
          .click();
        await out.waitFor();
        const recovered = (await out.inputValue()).split('#invite=')[1]!;
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.staff_credentials WHERE principal_id=$1 AND revoked_at IS NULL',
              [member],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT FROM platform.staff_accounts WHERE principal_id=$1 AND decisions_after>now()+interval '23 hours'",
              [member],
            )
          ).rowCount,
          1,
        );
        await assert.rejects(identity.account(memberLogin.identity));
        await assert.rejects(identity.signout(memberHandle, false, 'erp'));
        const recoveryFlow = secret();
        const recoveryOptions = await identity.begin(recoveryFlow, {
          invite: recovered,
        });
        assert.ok('rp' in recoveryOptions);
        const registration = await page.evaluate(async (json) => {
          const credential = (await navigator.credentials.create({
            publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
              JSON.parse(json),
            ),
          })) as PublicKeyCredential;
          return credential.toJSON();
        }, JSON.stringify(recoveryOptions));
        // Authority changes after the invitation and valid registration challenge were issued.
        const ownerMembership = (
          await pool.query<{ membership_id: string }>(
            `UPDATE platform.current_policy_memberships m SET revoked_at=now() FROM platform.current_policy_roles r
           WHERE m.tenant_id=r.tenant_id AND m.environment_id=r.environment_id AND m.role_id=r.role_id
             AND m.principal_id=$1 AND r.role_key='staff-owner' AND m.revoked_at IS NULL RETURNING m.membership_id`,
            [owner],
          )
        ).rows;
        assert.equal(ownerMembership.length, 1);
        await assert.rejects(
          identity.finish(
            recoveryFlow,
            registration as Parameters<typeof identity.finish>[1],
          ),
          /Staff access could not be verified/,
          'recovery enrollment must recheck issuer authority',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.staff_credentials WHERE principal_id=$1 AND revoked_at IS NULL',
              [member],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT FROM platform.staff_invitations WHERE token_digest=$1 AND retired_at IS NULL',
              [digest(recovered)],
            )
          ).rowCount,
          1,
        );
        await pool.query(
          'UPDATE platform.current_policy_memberships SET revoked_at=NULL WHERE membership_id=$1',
          [ownerMembership[0]!.membership_id],
        );
        await enroll(recovered);
        await sign(
          ownerKey,
          { action: 'deactivate', subject: member, reason: 'attended test' },
          ownerSession.value,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT FROM platform.staff_accounts WHERE principal_id=$1 AND status='inactive'",
              [member],
            )
          ).rowCount,
          1,
        );
        const spare = await sign(
          ownerKey,
          { action: 'spare' },
          ownerSession.value,
        );
        assert.ok('invite' in spare && spare.invite);
        // A key created on the second loopback RP cannot enroll this invitation.
        await page.goto('https://login.other.test/');
        const otherFlow = secret();
        const creation = await identity.begin(otherFlow, {
          invite: spare.invite,
        });
        assert.ok('rp' in creation);
        const otherRegistration = await page.evaluate(async (json) => {
          const options = PublicKeyCredential.parseCreationOptionsFromJSON(
            JSON.parse(json),
          );
          options.rp.id = 'other.test';
          const key = (await navigator.credentials.create({
            publicKey: options,
          })) as PublicKeyCredential;
          return key.toJSON();
        }, JSON.stringify(creation));
        await assert.rejects(
          identity.finish(
            otherFlow,
            otherRegistration as Parameters<typeof identity.finish>[1],
          ),
          /origin/i,
        );
        await devtools.send('WebAuthn.removeVirtualAuthenticator', {
          authenticatorId,
        });
        const spareAuthenticator = await addKey();
        await enroll(spare.invite);
        const spareKey = (
          await pool.query(
            'SELECT credential_id FROM platform.staff_credentials WHERE principal_id=$1 AND credential_id<>$2 AND revoked_at IS NULL',
            [owner, ownerKey],
          )
        ).rows[0].credential_id as string;
        await page.goto(r.identityOrigin + '/account');
        await page.getByRole('button', { name: 'Sign out everywhere' }).click();
        await page
          .getByRole('status')
          .filter({ hasText: 'Signed out.' })
          .waitFor();
        assert.equal(await total('signout-everywhere'), 1);
        const firstRefusal = await page.goto(list);
        assert.equal(firstRefusal?.status(), 401);
        const other = await browser.newContext();
        await other.addCookies([session]);
        const another = await other.newPage();
        const secondRefusal = await another.goto(list);
        assert.equal(secondRefusal?.status(), 401);
        assert.notEqual(
          firstRefusal?.headers()['x-test-instance'],
          secondRefusal?.headers()['x-test-instance'],
        );
        await other.close();
        await passkeyChecks(
          page,
          devtools,
          spareAuthenticator.authenticatorId,
          identity,
          spareKey,
          (prior) => startBrowserLogin(r, ca, prior),
          pool,
        );
      } finally {
        await browser.close();
      }
    },
  );
}
void journey().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Staff journey failed';
  const frame =
    error instanceof Error
      ? error.stack?.match(
          /staff-(?:browser-journey|passkey-checks)\.ts:\d+:\d+/u,
        )?.[0]
      : undefined;
  process.stderr.write(
    (frame ? frame + ' ' : '') +
      message
        .replace(/https?:\/\/[^\s"]+/gu, (value) => {
          try {
            const u = new URL(value);
            return u.origin + u.pathname;
          } catch {
            return '[url]';
          }
        })
        .replace(/[\w-]{40,}/gu, '[redacted]') +
      '\n',
  );
  process.exitCode = 1;
});
