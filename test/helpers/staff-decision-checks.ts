import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import {
  applyStaffDecision,
  runDecisionVerifier,
} from '../../apps/api/src/staff-decisions.js';
import { scoped, StaffIdentity } from '../../apps/api/src/staff-identity.js';
import {
  digest,
  secret,
  type StaffRealm,
} from '../../apps/api/src/staff-protocol.js';
import type { MintedUuid } from '../../packages/platform-runtime/src/index.js';
import { renderedDiffDigest } from '../../packages/customization/src/render.js';
import type { PostgresCustomizationService } from '../../packages/postgres-provider/src/customization-service.js';
import type { ReleaseDiffBinding } from '../../packages/postgres-provider/src/release-diff-binding.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import {
  staffRequestEntry,
  withActivationVerifierTransaction,
} from '../../packages/postgres-provider/src/request-context.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';

interface Fixture {
  tenantId: string;
  environmentId: string;
  principal: string;
  company: string | null;
}
type Kind = 'release' | 'customize' | 'retry';

// Use the actual identity, verifier, runtime and worker logins. The issuer's
// database boundary is tested separately from Chromium's WebAuthn ceremony.
async function withDecisionAccount<T>(
  admin: pg.Pool,
  connection: pg.PoolConfig,
  f: Fixture,
  work: (fixture: {
    realm: StaffRealm;
    identity: StaffIdentity;
    handle: string;
    erpHandle: string;
    verifier: pg.Pool;
    membership: string;
  }) => Promise<T>,
) {
  const realm = {
    tenantId: f.tenantId,
    environmentId: f.environmentId,
    identityOrigin: 'https://localhost:6100',
    erpOrigin: 'https://erp.localhost:6101',
    rpId: 'localhost',
  };
  const role = randomUUID(),
    membership = randomUUID(),
    handle = secret(),
    erpHandle = secret();
  await admin.query(
    "INSERT INTO platform.staff_accounts(tenant_id,environment_id,principal_id,user_handle,display_name,recovery_contact,status) VALUES($1,$2,$3,$4,'Approver','attended','active')",
    [f.tenantId, f.environmentId, f.principal, randomBytes(32)],
  );
  await admin.query(
    'INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES($1,$2,$3,$4)',
    [f.tenantId, f.environmentId, role, 'decision-' + role],
  );
  await admin.query(
    'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES($1,$2,$3,$4,$5,$6)',
    [f.tenantId, f.environmentId, membership, f.principal, role, f.company],
  );
  await admin.query(
    `INSERT INTO platform.staff_sessions(tenant_id,environment_id,principal_id,family_id,method,assurance,authenticated_at,last_activity,absolute_deadline,identity_digest,application_digest,handoff_deadline,browser_binding)
    VALUES($1,$2,$3,gen_random_uuid(),'webauthn','user-verified-passkey',now(),now(),now()+interval '12 hours',$4,$5,now(),$6)`,
    [
      f.tenantId,
      f.environmentId,
      f.principal,
      digest(handle),
      digest(erpHandle),
      randomBytes(32),
    ],
  );
  const identityPool = new pg.Pool({
      ...connection,
      user: 'north_star_identity',
    }),
    verifier = new pg.Pool({
      ...connection,
      user: 'north_star_activation_verifier',
    });
  try {
    return await work({
      realm,
      identity: new StaffIdentity(identityPool, realm, randomBytes(32)),
      handle,
      erpHandle,
      verifier,
      membership,
    });
  } finally {
    await Promise.all([identityPool.end(), verifier.end()]);
  }
}
type Account = Parameters<Parameters<typeof withDecisionAccount>[3]>[0];

async function issueReviewed(
  a: Account,
  f: Fixture,
  kind: Kind,
  target: MintedUuid,
  reviewed?: string,
) {
  const binding =
    reviewed ??
    (
      await a.identity.review(
        { kind, company: f.company, targets: [target] },
        a.handle,
      )
    ).digest;
  return scoped(
    a.identity.pool,
    a.realm,
    async (client) =>
      (
        await client.query<{ id: MintedUuid }>(
          `SELECT platform.staff_issue_decision($1,$2,$3,$4,$5,$6,$7,$8,
        clock_timestamp()+interval '5 minutes') AS id`,
          [
            f.tenantId,
            f.environmentId,
            digest(a.handle),
            f.principal,
            f.company,
            kind,
            [target],
            binding,
          ],
        )
      ).rows[0]!.id,
  );
}

async function consume(
  client: pg.PoolClient,
  f: Fixture,
  kind: Kind,
  proof: MintedUuid,
) {
  return client.query(
    'SELECT platform.staff_consume_decision($1,$2,$3,$4,$5,$6) AS facts',
    [f.tenantId, f.environmentId, f.company, kind, proof, randomUUID()],
  );
}

async function exerciseProof(
  admin: pg.Pool,
  a: Account,
  f: Fixture,
  kind: Kind,
  target: string,
) {
  const choice = { kind, company: f.company, targets: [target] };
  assert.ok(
    (await a.identity.choices(a.handle)).some(
      (row) =>
        row.target === target && row.kind === kind && row.company === f.company,
    ),
  );
  const review = () => a.identity.review(choice, a.handle);
  const { terms, digest: binding } = await review();
  assert.equal((terms as { company: string | null }).company, f.company);
  await assert.rejects(
    issueReviewed(a, f, kind, target as MintedUuid, '00'.repeat(32)),
    /reviewed decision changed/,
  );
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = key.publicKey.export({ format: 'jwk' });
  // COSE EC2, ES256, P-256, followed by the two 32-byte coordinates.
  const cose = Buffer.concat([
    Buffer.from('a5010203262001215820', 'hex'),
    Buffer.from(point.x!, 'base64url'),
    Buffer.from('225820', 'hex'),
    Buffer.from(point.y!, 'base64url'),
  ]);
  const credential = secret();
  const account = await admin.query<{ user_handle: Buffer }>(
    'SELECT user_handle FROM platform.staff_accounts WHERE principal_id=$1',
    [f.principal],
  );
  await admin.query(
    `INSERT INTO platform.staff_credentials(tenant_id,environment_id,principal_id,method,credential_id,public_key,sign_count,backup_eligible,backed_up,transports)
    VALUES($1,$2,$3,'webauthn',$4,$5,0,false,false,'{}')`,
    [f.tenantId, f.environmentId, f.principal, credential, cose],
  );
  const flow = secret();
  const options = await a.identity.begin(
    flow,
    { ...choice, action: 'decision', reviewed: binding },
    a.handle,
  );
  const clientData = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      origin: a.realm.identityOrigin,
      challenge: options.challenge,
    }),
  );
  const authenticator = Buffer.concat([
    digest(a.realm.rpId),
    Buffer.from([5, 0, 0, 0, 1]),
  ]);
  const reply = {
    id: credential,
    rawId: credential,
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authenticator.toString('base64url'),
      userHandle: account.rows[0]!.user_handle.toString('base64url'),
      signature: sign(
        'sha256',
        Buffer.concat([authenticator, digest(clientData.toString())]),
        key.privateKey,
      ).toString('base64url'),
    },
  };
  const confirmed = await a.identity.finish(flow, reply, a.handle);
  assert.ok('proof' in confirmed && confirmed.proof);
  const proof = confirmed.proof as MintedUuid;
  const pending = {
    decision_kind: kind,
    proof_id: proof,
    company_id: f.company,
  };
  const apply = () => applyStaffDecision(a.verifier, a.realm, pending);
  await assert.rejects(
    applyStaffDecision(a.verifier, a.realm, {
      ...pending,
      company_id: randomUUID(),
    }),
    /decision proof scope changed/,
  );
  for (const realm of [
    { ...a.realm, tenantId: randomUUID() },
    { ...a.realm, environmentId: randomUUID() },
  ]) {
    await assert.rejects(
      applyStaffDecision(a.verifier, realm, pending),
      /decision proof scope changed/,
    );
  }
  const eligibility = (live: boolean) =>
    admin.query(
      'UPDATE platform.current_policy_memberships SET revoked_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE membership_id=$1',
      [a.membership, live],
    );
  await eligibility(false);
  try {
    await assert.rejects(apply(), /decision authority refused/);
  } finally {
    await eligibility(true);
  }
  assert.equal(
    (
      await admin.query(
        'SELECT FROM platform.staff_decision_receipts WHERE proof_id=$1',
        [proof],
      )
    ).rowCount,
    0,
  );
  const [attempts, repeatedAttempts] = await Promise.all([apply(), apply()]);
  assert.deepEqual(repeatedAttempts, attempts);
  const receipt = (await a.identity.receipt(proof, a.handle)) as {
    attempts: string[];
    decidedAt: string;
    request: string;
  };
  const replay = await scoped(a.verifier, a.realm, (client) =>
    consume(client, f, kind, proof),
  );
  assert.deepEqual(replay.rows[0]?.facts, {
    receipt: {
      reference: proof,
      request: receipt.request,
      decidedAt: receipt.decidedAt,
      attempts,
    },
  });
  assert.deepEqual(receipt.attempts, attempts);
  assert.ok(receipt.decidedAt);
  const audit = await admin.query(
    `SELECT p.principal_id,p.method,p.assurance,p.actor_type,p.company_id,p.decision_kind,p.terms,
      d.decided_at>=p.authenticated_at AS ordered FROM platform.staff_decision_proofs p JOIN platform.staff_decision_receipts d USING(proof_id) WHERE p.proof_id=$1`,
    [proof],
  );
  assert.deepEqual(audit.rows, [
    {
      principal_id: f.principal,
      method: 'webauthn',
      assurance: 'user-verified-passkey',
      actor_type: 'staff',
      company_id: f.company,
      decision_kind: kind,
      terms,
      ordered: true,
    },
  ]);
  return { attempts, proof };
}

export async function checkReleaseDecisions(
  test: TestContext,
  admin: pg.Pool,
  connection: pg.PoolConfig,
  f: Fixture,
  prepare: (diff?: ReleaseDiffBinding) => Promise<MintedUuid>,
  binding: ReleaseDiffBinding,
  source: string,
  candidate: MintedUuid,
) {
  const prep = await prepare();
  const otherPrep = await prepare();
  const text = 'Install the reviewed package revision.';
  const unfaithfulPrep = await prepare({
    ...binding,
    renderedText: text,
    renderedDigest: renderedDiffDigest(text),
  });
  await admin.query("SELECT platform.claim_staff_store_mode('pilot')");
  await admin.query(
    "INSERT INTO platform.staff_relying_parties VALUES($1,$2,'localhost','https://localhost:6100','https://erp.localhost:6101')",
    [f.tenantId, f.environmentId],
  );
  for (const role of ['north_star_runtime', 'north_star_workflow_worker']) {
    const pool = new pg.Pool({ ...connection, user: role });
    try {
      for (const tbl of [
        'release_approvals',
        'release_activation_verification_receipts',
        'release_activation_swap_receipts',
        'staff_decision_proofs',
        'staff_decision_receipts',
      ]) {
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege(current_user,$1,'INSERT') AS allowed",
              ['platform.' + tbl],
            )
          ).rows[0].allowed,
          false,
          tbl,
        );
      }
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege(current_user,'platform.active_release_pointers','UPDATE') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await pool.end();
    }
  }
  await withDecisionAccount(admin, connection, f, async (a) => {
    await test.test(
      'company-scoped membership cannot approve an environment release',
      async () => {
        await admin.query(
          'UPDATE platform.current_policy_memberships SET legal_entity_id=$2 WHERE membership_id=$1',
          [a.membership, randomUUID()],
        );
        try {
          await assert.rejects(
            a.identity.review(
              { kind: 'release', targets: [prep], company: null },
              a.handle,
            ),
            /decision authority refused/,
          );
        } finally {
          await admin.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=NULL WHERE membership_id=$1',
            [a.membership],
          );
        }
      },
    );
    const actor = await new AuthenticatedRequestEntryAdapter(async () => ({
      tenantId: f.tenantId,
      environmentId: f.environmentId,
      principalId: f.principal,
    })).enter({});
    const approval = (
      client: pg.PoolClient,
      preparationId: MintedUuid,
      proof?: MintedUuid,
    ) =>
      new PostgresReleaseApprovalService(a.verifier).createApprovalOnClient(
        client,
        actor,
        {
          approvalId: randomUUID() as MintedUuid,
          activationAttemptId: randomUUID() as MintedUuid,
          approvingHumanId: f.principal,
          issuingActorId: f.principal,
          initiatingHumanId: maker,
          sourceDecisionId: proof ?? (randomUUID() as MintedUuid),
          ...(proof ? { staffProofId: proof } : {}),
          preparationId,
          targetReleaseId: candidate,
        },
      );
    const {
      rows: [{ created_by: maker }],
    } = (await admin.query<{ created_by: string }>(
      'SELECT created_by FROM platform.tenant_releases WHERE release_id=$1',
      [candidate],
    )) as { rows: [{ created_by: string }] };
    const asVerifier = <T>(work: (client: pg.PoolClient) => Promise<T>) =>
      withActivationVerifierTransaction(a.verifier, actor, work);
    await test.test('approval binding refuses a missing proof', async () => {
      await assert.rejects(
        asVerifier((client) => approval(client, prep)),
        { code: 'P0002' },
      );
    });
    await test.test(
      'approval binding refuses a receipt from a prior transaction',
      async () => {
        const earlier = await issueReviewed(a, f, 'release', prep);
        await asVerifier((client) => consume(client, f, 'release', earlier));
        await assert.rejects(
          asVerifier((client) => approval(client, prep, earlier)),
          { code: 'P0002' },
        );
      },
    );
    await test.test(
      'approval binding refuses a proof for another preparation',
      async () => {
        const different = await issueReviewed(a, f, 'release', otherPrep);
        await assert.rejects(
          asVerifier(async (client) => {
            await consume(client, f, 'release', different);
            await approval(client, prep, different);
          }),
          { code: 'P0002' },
        );
      },
    );
    await test.test(
      'verifier refuses reviewed text that differs from the release diff',
      async () => {
        const misleading = await issueReviewed(a, f, 'release', unfaithfulPrep);
        await assert.rejects(
          applyStaffDecision(a.verifier, a.realm, {
            proof_id: misleading,
            decision_kind: 'release',
            company_id: null,
          }),
          { code: 'REVIEWED_DIFF_MISMATCH' },
        );
        const receipt = await admin.query(
          'SELECT FROM platform.staff_decision_receipts WHERE proof_id=$1',
          [misleading],
        );
        assert.equal(receipt.rowCount, 0);
      },
    );

    const pending = await issueReviewed(a, f, 'release', prep);
    for (const [name, change, message] of [
      [
        'proof refuses a source release restored at a new fence',
        async (client: pg.PoolClient) => {
          for (const releaseId of [candidate, source]) {
            await client.query(
              `UPDATE platform.active_release_pointers SET release_id=$3, fence=fence+1
              WHERE (tenant_id,environment_id)=($1,$2)`,
              [f.tenantId, f.environmentId, releaseId],
            );
          }
        },
        /decision target unavailable/,
      ],
      [
        'proof expires while its session remains live',
        async (client: pg.PoolClient) => {
          const {
            rows: [row],
          } = await client.query<{ expired_epoch: string }>(
            `SELECT extract(epoch FROM expires_at + interval '1 second') AS expired_epoch FROM platform.staff_decision_proofs WHERE proof_id=$1`,
            [pending],
          );
          const epoch = Number(row?.expired_epoch);
          assert.ok(Number.isFinite(epoch));
          // Inject the clock in this transaction only, past proof expiry and within the session idle window.
          await client.query(`CREATE OR REPLACE FUNCTION platform.staff_observed_time() RETURNS timestamptz
          LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
            SELECT to_timestamp(${epoch})
          $$`);
        },
        /decision proof expired/,
      ],
      [
        'proof refuses a revoked session',
        async (client: pg.PoolClient) => {
          await client.query(
            'UPDATE platform.staff_sessions SET revoked_at=now() WHERE identity_digest=$1',
            [digest(a.handle)],
          );
        },
        /decision session unavailable/,
      ],
    ] as const) {
      await test.test(name, async () => {
        const client = await admin.connect();
        try {
          await client.query('BEGIN');
          await change(client);
          await client.query('SET LOCAL ROLE north_star_activation_verifier');
          await client.query(
            "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true)",
            [f.tenantId, f.environmentId],
          );
          await assert.rejects(consume(client, f, 'release', pending), message);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });
    }
    const release = await exerciseProof(admin, a, f, 'release', prep);
    assert.equal(release.attempts.length, 1);
    const patch = async (label: string) => {
      const author = randomUUID();
      await withDecisionAccount(
        admin,
        connection,
        { ...f, principal: author },
        async (maker) => {
          const profile = (
            await admin.query(
              `SELECT jsonb_build_object('patch_version','northstar.customization-patch/v1','patch_kind','addField',
          'payload',$3::bytea,'payload_digest',encode(sha256($3),'hex'),'channel','visualBuilder','authored_by',$4::uuid,
          'base_package_id','example','base_package_version','1.0.0','base_revision_id',s.app_package_revision_id,'base_release_root',s.content_hash,
          'parent_revision_id',s.app_package_revision_id,'resulting_revision_id',r.app_package_revision_id,'resulting_release_id',r.release_id,
          'language_version','v1','normalization_profile_version','v1') AS proposal FROM platform.tenant_releases s
          JOIN platform.tenant_releases r ON r.release_id=$2 WHERE s.release_id=$1`,
              [
                source,
                candidate,
                Buffer.from(JSON.stringify({ kind: 'addField', label })),
                f.principal,
              ],
            )
          ).rows[0].proposal;
          const runtime = new pg.Pool({
            ...connection,
            user: 'north_star_runtime',
          });
          try {
            const submit = () =>
              scoped(
                runtime,
                a.realm,
                async (c) =>
                  (
                    await c.query<{ id: string }>(
                      'SELECT platform.staff_propose_customization($1,$2,$3,$4) AS id',
                      [
                        f.tenantId,
                        f.environmentId,
                        digest(maker.erpHandle),
                        profile,
                      ],
                    )
                  ).rows[0]!.id,
              );
            await assert.rejects(
              submit(),
              /customization author grant required/,
            );
            await admin.query(
              `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
            SELECT tenant_id,environment_id,role_id,'northstar.runtime:permission.customize_author','northstar.runtime:customization.application'
            FROM platform.current_policy_memberships WHERE membership_id=$1`,
              [maker.membership],
            );
            const patchId = await submit();
            assert.equal(
              (
                await admin.query(
                  'SELECT authored_by FROM platform.customization_patches WHERE patch_id=$1',
                  [patchId],
                )
              ).rows[0]?.authored_by,
              author,
            );
          } finally {
            await runtime.end();
          }
        },
      );
    };
    await patch('Reference');
    const selection = { kind: 'customize', company: null, targets: [prep] };
    const review = await a.identity.review(selection, a.handle);
    const stale = await scoped(
      a.identity.pool,
      a.realm,
      async (c) =>
        (
          await c.query<{ id: MintedUuid }>(
            "SELECT platform.staff_issue_decision($1,$2,$3,$4,NULL,'customize',$5,$6,clock_timestamp()+interval '5 minutes') AS id",
            [
              f.tenantId,
              f.environmentId,
              digest(a.handle),
              f.principal,
              [prep],
              review.digest,
            ],
          )
        ).rows[0]!.id,
    );
    await patch('Delivery note');
    await assert.rejects(
      applyStaffDecision(a.verifier, a.realm, {
        proof_id: stale,
        decision_kind: 'customize',
        company_id: null,
      }),
      /reviewed decision changed/,
    );
    const custom = await exerciseProof(admin, a, f, 'customize', prep);
    assert.equal(custom.attempts.length, 1);
    await admin.query(
      'UPDATE platform.current_policy_memberships SET revoked_at=now() WHERE membership_id=$1',
      [a.membership],
    );
    const refused = await runDecisionVerifier(
      a.verifier,
      a.realm,
      release.attempts[0],
    );
    assert.equal(refused[0]?.status, 'NO_SWAP_TERMINAL');
    assert.equal(
      (
        await admin.query(
          'SELECT outcome_code FROM platform.release_activation_attempt_outcomes WHERE activation_attempt_id=$1',
          [release.attempts[0]],
        )
      ).rows[0]?.outcome_code,
      'APPROVER_REVOCATION',
    );
    await admin.query(
      'UPDATE platform.current_policy_memberships SET revoked_at=NULL WHERE membership_id=$1',
      [a.membership],
    );
    const results = await runDecisionVerifier(
      a.verifier,
      a.realm,
      custom.attempts[0],
    );
    assert.equal(results[0]?.status, 'SWAPPED_VERIFIED');
    assert.equal(
      (
        await admin.query(
          `SELECT v.verifier_login FROM platform.release_activation_verification_receipts v JOIN platform.release_approvals a
      USING(tenant_id,environment_id,activation_attempt_id) WHERE a.staff_proof_id=$1 AND v.status='SWAPPED_VERIFIED'`,
          [custom.proof],
        )
      ).rows[0]?.verifier_login,
      'north_star_activation_verifier',
    );
  });
}

export async function checkRetryDecision(
  test: TestContext,
  admin: pg.Pool,
  connection: pg.PoolConfig,
  f: Fixture,
  run: string,
  company: string,
) {
  const outsider = randomUUID();
  await admin.query(
    'SELECT platform.set_release_approver_eligibility($1,$2,true,$3,$4)',
    [f.tenantId, outsider, f.principal, randomUUID()],
  );

  // The surrounding workflow test uses demo approvals. Commit the mode claim so
  // the actual runtime, identity and verifier connections all see pilot.
  await admin.query(`DO $$ BEGIN
    TRUNCATE north_star_internal.staff_store_mode;
    PERFORM platform.claim_staff_store_mode('pilot');
  END $$`);
  try {
    await withDecisionAccount(
      admin,
      connection,
      { ...f, principal: outsider, company },
      async (account) => {
        const selection = { kind: 'retry', targets: [run], company: f.company };
        await test.test(
          'company membership refuses the correctly scoped Retry in another company',
          async () => {
            await assert.rejects(
              account.identity.review(selection, account.handle),
              /decision authority refused/,
            );
          },
        );
        await test.test(
          'Retry terms refuse a run whose recorded company differs',
          async () => {
            await assert.rejects(
              account.identity.review(
                { ...selection, company },
                account.handle,
              ),
              /decision target unavailable/,
            );
          },
        );
      },
    );
    await withDecisionAccount(admin, connection, f, async (account) => {
      const runtime = new pg.Pool({
        ...connection,
        user: 'north_star_runtime',
      });
      const {
        rows: [pin],
      } = await admin.query<{ previous: string; fence: string; count: number }>(
        `SELECT r.execution_fence AS previous, p.fence,
                (SELECT count(*)::int FROM platform.workflow_journal j
                 WHERE j.run_id=r.run_id AND j.kind IN ('REQUEST','RESULT')) AS count
           FROM platform.workflow_runs r JOIN platform.active_release_pointers p USING (tenant_id,environment_id,pointer_id)
          WHERE r.run_id=$1`,
        [run],
      );
      await test.test(
        'pilot Retry evidence requires a current proof',
        async () => {
          try {
            await assert.rejects(
              scoped(runtime, account.realm, async (client) => {
                await client.query(
                  "SELECT set_config('north_star.principal_id',$1,true),set_config('north_star.request_id',$2,true)",
                  [f.principal, randomUUID()],
                );
                await client.query(
                  "SELECT platform.workflow_apply_remedy($1,$2,$3,'retry',$4)",
                  [run, pin!.previous, pin!.fence, pin!.count],
                );
                throw new Error('proofless workflow Retry returned');
              }),
              /workflow Retry requires its current staff decision/,
            );
          } finally {
            await runtime.end();
          }
        },
      );
      await test.test(
        'pilot run guard independently refuses a proofless advance',
        async () => {
          const direct = await admin.connect();
          try {
            await direct.query('BEGIN');
            await assert.rejects(
              direct.query(
                `UPDATE platform.workflow_runs SET status='RUNNABLE', reason=NULL, execution_fence=$2
              WHERE run_id=$1`,
                [run, pin!.fence],
              ),
              /workflow run advance requires its current staff Retry decision/,
            );
          } finally {
            await direct.query('ROLLBACK');
            direct.release();
          }
        },
      );
      const result = await exerciseProof(admin, account, f, 'retry', run);
      assert.deepEqual(result.attempts, []);
      const records = await scoped(
        account.verifier,
        account.realm,
        async (client) =>
          (
            await client.query(
              'SELECT * FROM platform.staff_retry_decision_record($1,$2,$3)',
              [f.tenantId, f.environmentId, result.proof],
            )
          ).rows,
      );
      assert.equal(records.length, 1);
      assert.equal(records[0]?.run_id, run);
      assert.equal(records[0]?.decided_by, f.principal);
      assert.equal(records[0]?.company_id, f.company);
      assert.equal(records[0]?.proof_id, result.proof);
      assert.ok(BigInt(records[0].fence) > BigInt(records[0].previous_fence));
      const state = await admin.query(
        `SELECT r.status, r.execution_fence = d.fence AS restored,
              d.staff_proof_id = receipt.proof_id AND d.decided_by = $2 AND
              d.request_id = receipt.request_id AND d.decided_at = receipt.decided_at AS bound
         FROM platform.workflow_runs r JOIN platform.workflow_retry_decisions d USING (tenant_id,environment_id,run_id)
         JOIN platform.staff_decision_receipts receipt ON receipt.proof_id=d.staff_proof_id
        WHERE r.run_id=$1 AND receipt.proof_id=$3`,
        [run, f.principal, result.proof],
      );
      assert.deepEqual(state.rows, [
        { status: 'RUNNABLE', restored: true, bound: true },
      ]);
    });
  } finally {
    const rows = await readFile(
      'test/postgres/application-grants-by-mode.tsv',
      'utf8',
    );
    const statements = rows
      .trimEnd()
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        const [mode, action, role, relation, permission, columns] =
          line.split('\t');
        if (mode !== 'pilot') return [];
        const privilege =
          columns === '*' ? permission : `${permission} (${columns})`;
        return action === 'remove'
          ? [`GRANT ${privilege} ON ${relation} TO ${role}`]
          : [`REVOKE ${privilege} ON ${relation} FROM ${role}`];
      });
    await admin.query(`DO $$ BEGIN
      ${statements.join(';\n')};
      GRANT EXECUTE ON FUNCTION platform.workflow_decide_approval(uuid,integer,bigint,text,text) TO north_star_runtime;
      TRUNCATE north_star_internal.staff_store_mode;
      PERFORM platform.claim_staff_store_mode('demo');
    END $$`);
  }
}

export async function checkStaffCustomizationWriter(
  admin: pg.Pool,
  connection: pg.PoolConfig,
  scope: Pick<Fixture, 'tenantId' | 'environmentId'>,
  service: PostgresCustomizationService,
  patch: unknown,
) {
  const f = { ...scope, principal: randomUUID(), company: null };
  await admin.query(`DO $$ BEGIN
    TRUNCATE north_star_internal.staff_store_mode;
    PERFORM platform.claim_staff_store_mode('pilot');
  END $$`);
  await withDecisionAccount(admin, connection, f, async (account) => {
    const runtime = new pg.Pool({ ...connection, user: 'north_star_runtime' });
    try {
      const context = await staffRequestEntry(runtime, () => ({
        ...scope,
        digest: digest(account.erpHandle),
        foreground: false,
      })).enter({});
      const draft = () =>
        service.draft(patch, 'visualBuilder', undefined, context);
      await assert.rejects(draft(), /customization author grant required/);
      await admin.query(
        `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
           SELECT tenant_id,environment_id,role_id,'northstar.runtime:permission.customize_author','northstar.runtime:customization.application'
           FROM platform.current_policy_memberships WHERE membership_id=$1`,
        [account.membership],
      );
      const result = await draft();
      assert.equal(result.status, 'drafted');
      if (result.status !== 'drafted') return;
      const {
        rows: [row],
      } = await admin.query(
        'SELECT authored_by, resulting_release_id FROM platform.customization_patches WHERE patch_id=$1',
        [result.patchId],
      );
      assert.deepEqual(row, {
        authored_by: context.principalId,
        resulting_release_id: result.releaseId,
      });
      assert.deepEqual(await draft(), { ...result, reused: true });
    } finally {
      await runtime.end();
    }
  });
}
