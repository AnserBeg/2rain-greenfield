import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import pg from 'pg';
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
import {
  SYSTEM_EXECUTION_PRINCIPAL,
  type MintedUuid,
} from '../../packages/platform-runtime/src/index.js';
import { renderedDiffDigest } from '../../packages/customization/src/render.js';

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
  const issue = (bound: string) =>
    scoped(
      a.identity.pool,
      a.realm,
      async (c) =>
        (
          await c.query<{ id: MintedUuid }>(
            "SELECT platform.staff_issue_decision($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes') AS id",
            [
              f.tenantId,
              f.environmentId,
              digest(a.handle),
              f.principal,
              f.company,
              kind,
              [target],
              bound,
            ],
          )
        ).rows[0]!.id,
    );
  await assert.rejects(issue('00'.repeat(32)), /reviewed decision changed/);
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
  // Disposable control checkout. Each probe runs inside a rollback-only verifier transaction.
  const fresh=await issue(binding);
  const consume=async(id:string,company:string|null=f.company)=>{
    const c=await a.verifier.connect(), request=randomUUID();
    try{await c.query('BEGIN');await c.query("SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),set_config('north_star.request_id',$3,true)",[f.tenantId,f.environmentId,request]);
      await c.query('SELECT platform.staff_consume_decision($1,$2,$3,$4,$5,$6)',[f.tenantId,f.environmentId,company,kind,id,request]);
    }finally{await c.query('ROLLBACK');c.release();}
  };
  const red=async(name:string,check:()=>Promise<unknown>)=>{
    await assert.rejects(check,{code:'ERR_ASSERTION',operator:'rejects',message:/Missing expected rejection/});
    console.log('EXPECTED RED',kind,name);
  };
  const mutate=async(fn:string,from:RegExp,replacement:string,check:()=>Promise<unknown>)=>{
    const original=(await admin.query('SELECT pg_get_functiondef($1::regproc) AS body',[fn])).rows[0].body;
    const change=original.replace(from,replacement);
    assert.notEqual(change,original);
    try{await admin.query(change);await check();}finally{await admin.query(original);}
  };
  await mutate('platform.staff_issue_decision',/IF encode\(binding,'hex'\) IS DISTINCT FROM reviewed THEN/,'IF false THEN',()=>
    red('exact reviewed digest',()=>assert.rejects(issue('00'.repeat(32)),/reviewed decision changed/)));
  await mutate('platform.staff_consume_decision',/IF \(proof.tenant_id,proof.environment_id,proof.company_id,proof.decision_kind\) IS DISTINCT FROM \(t,e,company,kind\)/,'IF false',()=>
    red('decision scope',()=>assert.rejects(consume(fresh,randomUUID()),/decision proof scope changed/)));
  await eligibility(false);
  try{await mutate('north_star_internal.staff_require_decision_authority',/IF NOT EXISTS \(SELECT FROM platform\.current_policy_memberships m JOIN platform\.current_policy_roles role[\s\S]*?m\.legal_entity_id=company\)\)/,'IF false',()=>
    red('live company membership',()=>assert.rejects(consume(fresh),/decision authority refused/)));}
  finally{await eligibility(true);}
  await admin.query('INSERT INTO platform.staff_decision_receipts VALUES ($1,$2,$3,$4,clock_timestamp())', [f.tenantId,f.environmentId,fresh,randomUUID()]);
  await admin.query('ALTER TABLE platform.staff_decision_receipts DROP CONSTRAINT staff_decision_receipts_pkey');
  try{await red('single use',()=>assert.rejects(consume(fresh),{code:'23505',constraint:'staff_decision_receipts_pkey'}));}
  finally{await admin.query('ALTER TABLE platform.staff_decision_receipts ADD PRIMARY KEY(proof_id)');}
  const attempts = await apply();
  await assert.rejects(apply(), {
    code: '23505',
    constraint: 'staff_decision_receipts_pkey',
  });
  const receipt = (await a.identity.receipt(proof, a.handle)) as {
    attempts: string[];
    decidedAt: string;
  };
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
  admin: pg.Pool,
  connection: pg.PoolConfig,
  f: Fixture,
  initial: string,
  source: string,
  candidate: string,
) {
  const prep = randomUUID(),
    text = 'Install the reviewed package revision.';
  await admin.query(
    `INSERT INTO platform.release_activation_preparations SELECT (jsonb_populate_record(old,jsonb_build_object(
    'preparation_id',$2::uuid,'verification_evidence_digest',decode(v.result_set_digest,'hex'),'verification_evidence_version',v.evidence_version,
    'reviewed_diff',$3::text,'rendered_diff_evidence_digest',decode($4,'hex')))).*
    FROM platform.release_activation_preparations old JOIN platform.release_verification_evidence v USING (tenant_id,environment_id,verification_evidence_id)
    WHERE old.preparation_id=$1`,
    [initial, prep, text, renderedDiffDigest(text)],
  );
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
      'SELECT platform.set_release_executor_authority($1,$2,true,$3,$4)',
      [
        f.tenantId,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
        randomUUID(),
        randomUUID(),
      ],
    );
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
  admin: pg.Pool,
  connection: pg.PoolConfig,
  f: Fixture,
  run: string,
) {
  await withDecisionAccount(admin, connection, f, async (account) => {
    const direct = await admin.connect();
    try {
      await direct.query('BEGIN');
      // Use the real pilot grants for this check, then return the shared demo fixture to its original mode.
      await direct.query('TRUNCATE north_star_internal.staff_store_mode');
      await direct.query("SELECT platform.claim_staff_store_mode('pilot')");
      const {
        rows: [pin],
      } = await direct.query(
        `SELECT r.execution_fence AS previous, p.fence,
                (SELECT count(*)::int FROM platform.workflow_journal j
                 WHERE j.run_id=r.run_id AND j.kind IN ('REQUEST','RESULT')) AS count
           FROM platform.workflow_runs r JOIN platform.active_release_pointers p USING (tenant_id,environment_id,pointer_id)
          WHERE r.run_id=$1`,
        [run],
      );
      await direct.query('SET LOCAL ROLE north_star_runtime');
      await direct.query(
        `SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),
                set_config('north_star.principal_id',$3,true),set_config('north_star.request_id',$4,true)`,
        [f.tenantId, f.environmentId, f.principal, randomUUID()],
      );
      await assert.rejects(
        direct.query(
          "SELECT platform.workflow_apply_remedy($1,$2,$3,'retry',$4)",
          [run, pin.previous, pin.fence, pin.count],
        ),
        /workflow Retry requires its current staff decision/,
      );
    } finally {
      await direct.query('ROLLBACK');
      direct.release();
    }
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
}
