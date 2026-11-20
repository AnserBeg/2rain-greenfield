import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { CDPSession, Page } from '@playwright/test';
import { StaffIdentity } from '../../apps/api/src/staff-identity.js';
import { digest, secret } from '../../apps/api/src/staff-protocol.js';

type Reply = Parameters<StaffIdentity['finish']>[1];

export async function signChallenge(
  page: Page,
  rpId: string,
  key: string,
  challenge: string,
  uv: UserVerificationRequirement = 'required',
) {
  const reply = await page.evaluate(
    async ({ challenge, key, rpId, uv }) => {
      const c = (await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({
          challenge,
          rpId,
          userVerification: uv,
          allowCredentials: [{ type: 'public-key', id: key }],
        }),
        signal: AbortSignal.timeout(5000),
      })) as PublicKeyCredential;
      return c.toJSON();
    },
    { challenge, key, rpId, uv },
  );
  return reply as Reply;
}

/** Exercise the real browser authenticator and the same verifier used by the HTTPS service. */
export async function passkeyChecks(
  page: Page,
  device: CDPSession,
  authenticatorId: string,
  issuer: StaffIdentity,
  key: string,
  login: (prior?: string) => Promise<string>,
  admin: Pool,
) {
  const realm = issuer.realm;
  const verifier = await login();
  const start = async (binding = verifier, prior?: string) => {
    const flow = secret();
    const options = await issuer.begin(
      flow,
      {
        action: 'signin',
        binding: digest(binding).toString('base64url'),
      },
      prior,
    );
    return { flow, challenge: options.challenge };
  };
  const assertion = (
    challenge: string,
    uv: UserVerificationRequirement = 'required',
  ) => signChallenge(page, realm.rpId, key, challenge, uv);
  await page.goto(realm.identityOrigin);
  for (const [changed, expected] of [
    [{ identityOrigin: 'https://login.other.test' }, /origin/i],
    [{ rpId: 'other.test' }, /RP ID/i],
  ] as const) {
    const { flow, challenge } = await start();
    const reply = await assertion(challenge);
    const other = new StaffIdentity(
      issuer.pool,
      { ...realm, ...changed },
      randomBytes(32),
    );
    await assert.rejects(other.finish(flow, reply), expected);
  }
  const first = await start(),
    second = await start();
  const a = await assertion(first.challenge);
  await assert.rejects(issuer.finish(second.flow, a), /challenge/i);
  await device.send('WebAuthn.setUserVerified', {
    authenticatorId,
    isUserVerified: false,
  });
  try {
    const { flow, challenge } = await start();
    await assert.rejects(
      issuer.finish(flow, await assertion(challenge, 'discouraged')),
      /verif/i,
    );
  } finally {
    await device.send('WebAuthn.setUserVerified', {
      authenticatorId,
      isUserVerified: true,
    });
  }
  const accepted = await issuer.finish(first.flow, a);
  assert.ok('identity' in accepted && accepted.identity && accepted.handoff);
  await assert.rejects(issuer.finish(first.flow, a));
  await assert.rejects(issuer.redeem(accepted.handoff, secret()));
  const handle = await issuer.redeem(accepted.handoff, verifier);
  await assert.rejects(issuer.redeem(accepted.handoff, verifier));
  const family = async (id: string) =>
    (
      await admin.query<{ family_id: string; deadline: string }>(
        'SELECT family_id,absolute_deadline::text AS deadline FROM platform.staff_sessions WHERE identity_digest=$1',
        [digest(id)],
      )
    ).rows[0];
  const original = await family(accepted.identity);
  assert.ok(original);
  const rotation = await login(handle);
  const prior = accepted.identity;
  const left = await start(rotation, prior),
    right = await start(rotation, prior),
    late = await start(rotation, prior);
  const assertions = [
    await assertion(left.challenge),
    await assertion(right.challenge),
  ];
  const completions = await Promise.allSettled(
    [left, right].map((flow, i) =>
      issuer.finish(flow.flow, assertions[i]!, prior),
    ),
  );
  const winners = completions.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  assert.equal(winners.length, 1, 'one completion may rotate a family');
  const replacement = winners[0]!;
  assert.ok(
    'identity' in replacement && replacement.identity && replacement.handoff,
  );
  assert.deepEqual(
    await family(replacement.identity),
    original,
    'rotation preserves the family and exact first deadline',
  );
  // This outstanding ceremony gets a fresh assertion counter after the winner.
  // Its sole obsolete input is the superseded identity handle.
  await assert.rejects(
    issuer.finish(late.flow, await assertion(late.challenge), prior),
    /Staff access could not be verified/u,
  );
  const rotated = await issuer.redeem(replacement.handoff, rotation, handle);
  assert.ok(handle !== rotated);
  await assert.rejects(issuer.account(accepted.identity));
  await assert.rejects(issuer.signout(handle, false, 'erp'));
  await issuer.signout(rotated, false, 'erp');
}
