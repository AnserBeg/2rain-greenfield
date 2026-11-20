import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
      const bytes = (value: string) =>
        Uint8Array.from(
          atob(value.replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0),
        );
      const c = (await navigator.credentials.get({
        publicKey: {
          challenge: bytes(challenge),
          rpId,
          userVerification: uv,
          allowCredentials: [{ type: 'public-key', id: bytes(key) }],
        },
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
) {
  const realm = issuer.realm;
  const verifier = secret();
  const start = async () => {
    const flow = secret();
    const options = await issuer.begin(flow, {
      action: 'signin',
      binding: digest(verifier).toString('base64url'),
    });
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
  const next = await start();
  const replacement = await issuer.finish(
    next.flow,
    await assertion(next.challenge),
    accepted.identity,
  );
  assert.ok(
    'identity' in replacement && replacement.identity && replacement.handoff,
  );
  const rotated = await issuer.redeem(replacement.handoff, verifier, handle);
  assert.ok(handle !== rotated);
  await assert.rejects(issuer.account(accepted.identity));
  await assert.rejects(issuer.signout(handle, false, 'erp'));
  await issuer.signout(rotated, false, 'erp');
}
