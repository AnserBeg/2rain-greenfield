import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import pg, { type PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

// TAX-EVIDENCE-1 slice 1: the tax catalog (Fable amendments T1-T7). Two
// companies share ONE tenant and environment; a second tenant proves the
// tenant boundary. Storage checks insert directly as the table owner inside a
// rolled-back transaction; setter checks go through platform.tax_review and
// platform.tax_confirm as north_star_runtime. The tax permissions are fixed
// platform IDs on northstar.tax:capability.catalog (no compiled release
// declares them), so their grant rows are seeded here.

const RESOURCE = 'northstar.tax:capability.catalog';
const permission = (name: string) => `northstar.tax:permission.${name}`;
const SYSTEM_PRINCIPAL = '00000000-0000-4000-8000-000000000001';
const GLOBAL_TABLES = [
  'tax_jurisdictions',
  'tax_starter_codes',
  'tax_starter_components',
  'tax_starter_rates',
];
const TENANT_TABLES = [
  'tax_components',
  'tax_catalog_receipts',
  'tax_catalog_codes',
  'tax_catalog_versions',
  'tax_catalog_version_components',
  'tax_registrations',
  'tax_catalog_reviews',
];
const RUNTIME_FUNCTIONS = [
  'platform.tax_review(uuid,bigint,text,jsonb)',
  'platform.tax_confirm(uuid,text)',
  'platform.tax_read_codes(date)',
  'platform.tax_read_code(uuid,date)',
  'platform.tax_read_registrations(uuid)',
];
const OWNER_FUNCTIONS = [
  'north_star_internal.tax_append_only()',
  'north_star_internal.tax_require_writer()',
  'north_star_internal.tax_granted(uuid,text,text)',
  'north_star_internal.tax_may_write(text,jsonb)',
  'north_star_internal.tax_company_live(uuid,boolean)',
  'north_star_internal.tax_put_code(uuid,uuid,jsonb,uuid)',
  'north_star_internal.tax_put_registration(uuid,uuid,jsonb,uuid)',
  'platform.tax_provision_starter(uuid,uuid,text[])',
];
const PROVINCES = ['ca', 'ca-bc', 'ca-sk', 'ca-mb'];
// A storage plan whose one legalEntityMaster entity is the test company table.
const STORAGE_PAYLOAD = JSON.stringify({
  kind: 'storageTargetPayload',
  entities: [
    {
      entityId: 'example.tax:entity.company',
      lifecycle: 'active',
      physicalTableName: 'test_tax_companies',
      legalEntityMaster: {
        fieldColumns: { status: 'company_status' },
        activeStatusValue: 'active',
      },
    },
  ],
});
const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const STORAGE_CHUNK = sha256(STORAGE_PAYLOAD);
const STORAGE_MANIFEST = sha256('tax-storage-target-manifest');

interface Scope {
  tenant: string;
  environment: string;
}
interface Reviewed {
  reviewId: string;
  digest: string;
}
interface CodeRow {
  code_id: string;
  code: string;
  label: string;
  version: number;
  effective_from: string;
  components: {
    componentId: string;
    jurisdictionId: string;
    ratePercent: string;
    recoverablePercent: string;
  }[];
}

const gst = (ratePercent = '5', recoverablePercent = '100') => ({
  componentId: 'ca.gst',
  jurisdictionId: 'ca',
  label: 'GST',
  ratePercent,
  recoverablePercent,
});
const codeProposal = (
  code: string,
  effectiveFrom: string | null = '2026-01-01',
  components: object[] = [gst()],
  active = true,
) => ({
  code,
  label: `Code ${code}`,
  active,
  ...(effectiveFrom === null ? {} : { version: { effectiveFrom, components } }),
});
const registration = (
  companyId: string,
  jurisdictionId = 'ca-bc',
  effectiveFrom = '2026-01-01',
) => ({
  companyId,
  jurisdictionId,
  registrationNumber: `R-${companyId.slice(0, 8)}`,
  effectiveFrom,
});

async function world(t: TestContext) {
  await withEphemeralPostgres('tax-catalog', async ({ pool, connection }) => {
    const a: Scope = { tenant: randomUUID(), environment: randomUUID() };
    const b: Scope = { tenant: randomUUID(), environment: randomUUID() };
    const releaseA = randomUUID(),
      alternateA = randomUUID(),
      releaseB = randomUUID();
    const writer = randomUUID(),
      writer2 = randomUUID(),
      revoked = randomUUID(),
      reader = randomUUID(),
      scopedA = randomUUID(),
      otherTenant = randomUUID();
    const companyA = randomUUID(),
      companyB = randomUUID(),
      companyC = randomUUID(),
      companyD = randomUUID(),
      companyE = randomUUID(),
      companyF = randomUUID(),
      companyG = randomUUID(),
      outsider = randomUUID();
    const runtime = new pg.Pool({
      ...connection,
      user: 'north_star_runtime',
      max: 3,
    });
    const admin = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
      await admin.query(
        `INSERT INTO platform.release_artifact_blobs VALUES(repeat('a',64),'releaseManifest','fixture',
           'application/vnd.northstar.canonical+json',convert_to('{}','UTF8'),2)`,
      );
      const seedTenant = async (scope: Scope, releases: string[]) => {
        const revision = randomUUID();
        await admin.query(
          'INSERT INTO platform.tenants(id,slug) VALUES ($1,$2)',
          [scope.tenant, `tax-${scope.tenant}`],
        );
        await admin.query(
          "INSERT INTO platform.environments(tenant_id,id,slug) VALUES ($1,$2,'tax')",
          [scope.tenant, scope.environment],
        );
        await admin.query(
          `INSERT INTO platform.app_package_revisions(tenant_id,revision_id,schema_version,language_version,
             normalization_profile_version,canonicalization_profile_version,hash_algorithm,content_hash,desired_state,
             provenance,created_by)
           VALUES($1,$2,'v6','v6','v1','v1','sha256',repeat('d',64),convert_to('{}','UTF8'),'firstParty',$3)`,
          [scope.tenant, revision, writer],
        );
        for (const release of releases)
          await admin.query(
            `INSERT INTO platform.tenant_releases(tenant_id,environment_id,release_id,app_package_revision_id,
               compiler_version,compiler_semantic_profile_version,output_protocol_version,content_hash,
               compiler_attestation_digest,verification_evidence_id,created_by)
             VALUES($1,$2,$3,$4,'compiler/v1','profile/v1','protocol/v1',repeat('a',64),repeat('b',64),
               gen_random_uuid(),$5)`,
            [scope.tenant, scope.environment, release, revision, writer],
          );
        // Each release's storage plan marks the company table legalEntityMaster.
        for (const release of releases) {
          await admin.query(
            `INSERT INTO platform.tenant_release_artifact_links VALUES ($1,$2,$3,$4,'projectionManifest'),($1,$2,$3,$5,'projectionChunk')`,
            [
              scope.tenant,
              scope.environment,
              release,
              STORAGE_MANIFEST,
              STORAGE_CHUNK,
            ],
          );
          await admin.query(
            `INSERT INTO platform.tenant_release_projection_links(tenant_id,environment_id,release_id,projection_instance_id,
               projection_family_id,projection_manifest_hash)
             VALUES ($1,$2,$3,'storage-target','northstar.compiler:projection-family.storage-target',$4)`,
            [scope.tenant, scope.environment, release, STORAGE_MANIFEST],
          );
          await admin.query(
            `INSERT INTO platform.tenant_release_chunk_links(tenant_id,environment_id,release_id,projection_instance_id,chunk_id,chunk_hash)
             VALUES ($1,$2,$3,'storage-target','payload',$4)`,
            [scope.tenant, scope.environment, release, STORAGE_CHUNK],
          );
        }
        await admin.query(
          'UPDATE platform.active_release_pointers SET release_id=$3,fence=fence+1 WHERE tenant_id=$1 AND environment_id=$2',
          [scope.tenant, scope.environment, releases[0]],
        );
      };
      const role = async (scope: Scope, key: string, permissions: string[]) => {
        const id = randomUUID();
        await admin.query(
          'INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,$4)',
          [scope.tenant, scope.environment, id, key],
        );
        for (const name of permissions)
          await admin.query(
            'INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES ($1,$2,$3,$4,$5)',
            [scope.tenant, scope.environment, id, permission(name), RESOURCE],
          );
        return id;
      };
      const member = (
        scope: Scope,
        principal: string,
        roleId: string,
        company: string | null,
      ) =>
        admin.query(
          'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
          [scope.tenant, scope.environment, principal, roleId, company],
        );

      await admin.query(
        `INSERT INTO platform.release_artifact_blobs VALUES
           ($1,'projectionManifest','storage-target','application/vnd.northstar.canonical+json',convert_to('{}','UTF8'),2),
           ($2,'projectionChunk','storage-target','application/vnd.northstar.canonical+json',convert_to($3::text,'UTF8'),octet_length($3::text))`,
        [STORAGE_MANIFEST, STORAGE_CHUNK, STORAGE_PAYLOAD],
      );
      await admin.query(
        `CREATE TABLE north_star_module.test_tax_companies (tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
           record_id uuid PRIMARY KEY, company_status text NOT NULL, archived_at timestamptz)`,
      );
      await seedTenant(a, [releaseA, alternateA]);
      await seedTenant(b, [releaseB]);
      const everything = [
        'catalog_read',
        'catalog_write',
        'registration_read',
        'registration_write',
      ];
      const adminRole = await role(a, 'tax-admin', everything);
      const readerRole = await role(a, 'tax-reader', [
        'catalog_read',
        'registration_read',
      ]);
      await member(a, writer, adminRole, null);
      await member(a, writer2, adminRole, null);
      await member(a, revoked, adminRole, null);
      await member(a, reader, readerRole, null);
      // Every grant, but through a membership scoped to company A only.
      await member(a, scopedA, adminRole, companyA);
      await member(
        b,
        otherTenant,
        await role(b, 'tax-admin', everything),
        null,
      );
      // A tenant-wide member whose role holds no tax grant.
      await member(a, outsider, await role(a, 'no-tax', []), null);
      for (const company of [
        companyA,
        companyB,
        companyC,
        companyD,
        companyE,
        companyF,
        companyG,
      ])
        await admin.query(
          "INSERT INTO north_star_module.test_tax_companies VALUES ($1,$2,$3,'active',NULL)",
          [a.tenant, a.environment, company],
        );

      const provision = async (scope: Scope = a) =>
        Number(
          (
            await admin.query<{ applied: number }>(
              'SELECT platform.tax_provision_starter($1,$2,$3) AS applied',
              [scope.tenant, scope.environment, PROVINCES],
            )
          ).rows[0]!.applied,
        );
      assert.equal(await provision(), 4);

      const as = async <T>(
        principal: string,
        run: (client: PoolClient) => Promise<T>,
        scope: Scope = a,
      ): Promise<T> => {
        const client = await runtime.connect();
        try {
          await client.query(
            "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
            [scope.tenant, scope.environment, principal],
          );
          return await run(client);
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      };
      const pointer = async () =>
        (
          await admin.query<{ release_id: string; fence: string }>(
            'SELECT release_id, fence FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2',
            [a.tenant, a.environment],
          )
        ).rows[0]!;
      const review = async (
        client: PoolClient,
        action: 'putCode' | 'putRegistration',
        proposal: object,
      ): Promise<Reviewed> => {
        const { release_id, fence } = await pointer();
        return (
          await client.query<{ r: Reviewed }>(
            'SELECT platform.tax_review($1,$2,$3,$4) AS r',
            [release_id, fence, action, JSON.stringify(proposal)],
          )
        ).rows[0]!.r;
      };
      const confirm = async (
        client: PoolClient,
        reviewed: Reviewed,
        digest = reviewed.digest,
      ) =>
        (
          await client.query<{ r: Record<string, unknown> }>(
            'SELECT platform.tax_confirm($1,$2) AS r',
            [reviewed.reviewId, digest],
          )
        ).rows[0]!.r;
      const change = (
        principal: string,
        action: 'putCode' | 'putRegistration',
        proposal: object,
      ) =>
        as(principal, async (client) =>
          confirm(client, await review(client, action, proposal)),
        );
      const readCodes = (day: string, principal = writer, scope = a) =>
        as(
          principal,
          async (client) =>
            (
              await client.query<CodeRow>(
                'SELECT code_id, code, label, version, effective_from::text AS effective_from, components FROM platform.tax_read_codes($1)',
                [day],
              )
            ).rows,
          scope,
        );
      const codeId = async (code: string) =>
        (
          await admin.query<{ code_id: string }>(
            'SELECT code_id FROM platform.tax_catalog_codes WHERE (tenant_id,environment_id,code)=($1,$2,$3)',
            [a.tenant, a.environment, code],
          )
        ).rows[0]!.code_id;
      /** One owner statement in its own transaction, always rolled back. */
      const owner = async (sql: string, params: unknown[] = []) => {
        await admin.query('BEGIN');
        try {
          await admin.query(sql, params);
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      const anyReceipt = async () =>
        (
          await admin.query<{ receipt_id: string }>(
            'SELECT receipt_id FROM platform.tax_catalog_receipts WHERE (tenant_id,environment_id)=($1,$2) LIMIT 1',
            [a.tenant, a.environment],
          )
        ).rows[0]!.receipt_id;
      const catalogDigest = async () =>
        (
          await admin.query<{ d: string }>(
            `SELECT md5(concat_ws('|',
               (SELECT string_agg(concat_ws(',',code,label,active,latest_version),';' ORDER BY code) FROM platform.tax_catalog_codes WHERE tenant_id=$1),
               (SELECT string_agg(concat_ws(',',code_id,version,effective_from,receipt_id),';' ORDER BY code_id,version) FROM platform.tax_catalog_versions WHERE tenant_id=$1),
               (SELECT string_agg(concat_ws(',',code_id,version,component_id,rate_percent,recoverable_percent),';' ORDER BY code_id,version,component_id) FROM platform.tax_catalog_version_components WHERE tenant_id=$1),
               (SELECT string_agg(concat_ws(',',component_id,jurisdiction_id,label),';' ORDER BY component_id) FROM platform.tax_components WHERE tenant_id=$1),
               (SELECT count(*) FROM platform.tax_catalog_receipts WHERE tenant_id=$1))) AS d`,
            [a.tenant],
          )
        ).rows[0]!.d;

      // ------------------------------------------------------------ the starter
      await t.test(
        'the starter template is the pinned Canadian table',
        async () => {
          const rates = await admin.query(
            `SELECT r.code, s.jurisdiction_id AS code_jurisdiction, r.effective_from::text AS effective_from,
                    r.component_id, k.jurisdiction_id, r.rate_percent::text AS rate, r.recoverable_percent::text AS recoverable,
                    r.verification
               FROM platform.tax_starter_rates r JOIN platform.tax_starter_codes s USING (code)
               JOIN platform.tax_starter_components k USING (component_id) ORDER BY 1,3,4`,
          );
          const row = (
            code: string,
            codeJurisdiction: string,
            from: string,
            component: string,
            jurisdiction: string,
            rate: string,
            recoverable: string,
          ) => ({
            code,
            code_jurisdiction: codeJurisdiction,
            effective_from: from,
            component_id: component,
            jurisdiction_id: jurisdiction,
            rate: `${rate}.000000`,
            recoverable: `${recoverable}.000000`,
            verification: 'pendingOwner',
          });
          assert.deepEqual(
            rates.rows,
            [
              row('GST', 'ca', '2008-01-01', 'ca.gst', 'ca', '5', '100'),
              row(
                'GST-PST-BC',
                'ca-bc',
                '2013-04-01',
                'ca-bc.pst',
                'ca-bc',
                '7',
                '0',
              ),
              row(
                'GST-PST-BC',
                'ca-bc',
                '2013-04-01',
                'ca.gst',
                'ca',
                '5',
                '100',
              ),
              row(
                'GST-PST-SK',
                'ca-sk',
                '2017-03-23',
                'ca-sk.pst',
                'ca-sk',
                '6',
                '0',
              ),
              row(
                'GST-PST-SK',
                'ca-sk',
                '2017-03-23',
                'ca.gst',
                'ca',
                '5',
                '100',
              ),
              row(
                'GST-RST-MB',
                'ca-mb',
                '2019-07-01',
                'ca-mb.rst',
                'ca-mb',
                '7',
                '0',
              ),
              row(
                'GST-RST-MB',
                'ca-mb',
                '2019-07-01',
                'ca.gst',
                'ca',
                '5',
                '100',
              ),
            ],
            'the starter rates differ from the pinned table',
          );
          const statutes = await admin.query<{ statute: string }>(
            'SELECT statute FROM platform.tax_starter_rates',
          );
          assert.ok(
            statutes.rows.every((r) => /Act/u.test(r.statute)),
            'a starter rate cites no statute',
          );
        },
      );
      await t.test(
        'provisioning copies the starter through the setter with fixed component IDs',
        async () => {
          const template = await admin.query<{
            code: string;
            effective_from: string;
            components: CodeRow['components'];
          }>(
            `SELECT r.code, r.effective_from::text AS effective_from,
                    jsonb_agg(jsonb_build_object('componentId',r.component_id,'jurisdictionId',k.jurisdiction_id,
                      'ratePercent',r.rate_percent::text,'recoverablePercent',r.recoverable_percent::text) ORDER BY r.component_id) AS components
               FROM platform.tax_starter_rates r JOIN platform.tax_starter_components k USING (component_id)
              GROUP BY r.code, r.effective_from ORDER BY r.code`,
          );
          const offered = (await readCodes('2026-11-26')).filter((row) =>
            template.rows.some((s) => s.code === row.code),
          );
          assert.deepEqual(
            offered.map(({ code, version, effective_from, components }) => ({
              code,
              version,
              effective_from,
              components,
            })),
            template.rows.map((s) => ({ ...s, version: 1 })),
          );
          const components = await admin.query(
            `SELECT component_id, jurisdiction_id FROM platform.tax_components WHERE tenant_id=$1
             EXCEPT SELECT component_id, jurisdiction_id FROM platform.tax_starter_components`,
            [a.tenant],
          );
          assert.deepEqual(components.rows, []);
          const receipts = await admin.query<{ principal_id: string }>(
            "SELECT DISTINCT principal_id FROM platform.tax_catalog_receipts WHERE tenant_id=$1 AND action='starter'",
            [a.tenant],
          );
          assert.deepEqual(
            receipts.rows.map((r) => r.principal_id),
            [SYSTEM_PRINCIPAL],
          );
        },
      );
      await t.test(
        're-applying the starter changes nothing and never overwrites an edited code',
        async () => {
          await change(writer, 'putCode', {
            code: 'GST-PST-BC',
            label: 'Edited BC label',
            active: true,
          });
          await change(writer, 'putCode', {
            code: 'GST-PST-SK',
            label: 'GST + SK PST',
            active: true,
            version: {
              effectiveFrom: '2030-01-01',
              components: [
                gst(),
                {
                  componentId: 'ca-sk.pst',
                  jurisdictionId: 'ca-sk',
                  label: 'SK PST',
                  ratePercent: '6.5',
                  recoverablePercent: '0',
                },
              ],
            },
          });
          const before = await catalogDigest();
          assert.equal(await provision(), 0);
          assert.equal(await catalogDigest(), before);
        },
      );

      // ------------------------------------------------------------- the reads
      await t.test(
        'the codes read on a day give the version in force that day',
        async () => {
          await change(writer, 'putCode', codeProposal('DATED'));
          await change(
            writer,
            'putCode',
            codeProposal('DATED', '2026-06-01', [gst('6')]),
          );
          const on = async (day: string) =>
            (await readCodes(day)).find((row) => row.code === 'DATED');
          const may = await on('2026-05-15');
          assert.equal(
            may?.version,
            1,
            'a later version answered for an earlier day',
          );
          assert.equal(may!.components[0]!.ratePercent, '5.000000');
          assert.equal((await on('2026-06-01'))?.version, 2);
          assert.equal(await on('2025-12-31'), undefined);
        },
      );
      await t.test(
        'one code read on a day gives its version in force',
        async () => {
          await change(writer, 'putCode', codeProposal('DATED2'));
          await change(
            writer,
            'putCode',
            codeProposal('DATED2', '2026-06-01', [gst('6')]),
          );
          const id = await codeId('DATED2');
          const read = (day: string) =>
            as(
              writer,
              async (client) =>
                (
                  await client.query<CodeRow>(
                    'SELECT version, effective_from::text AS effective_from FROM platform.tax_read_code($1,$2)',
                    [id, day],
                  )
                ).rows[0],
            );
          assert.equal(
            (await read('2026-05-15'))?.version,
            1,
            'a later version answered one code for an earlier day',
          );
          assert.equal((await read('2026-07-01'))?.version, 2);
          await assert.rejects(read('2025-12-31'), /tax\.noVersionInForce/u);
        },
      );
      await t.test(
        'a code with no components is offered with none',
        async () => {
          await change(
            writer,
            'putCode',
            codeProposal('EXEMPT', '2026-01-01', []),
          );
          const exempt = (await readCodes('2026-03-01')).find(
            (row) => row.code === 'EXEMPT',
          );
          assert.deepEqual(exempt?.components, []);
        },
      );
      await t.test('an inactive code is not offered', async () => {
        await change(writer, 'putCode', codeProposal('RETIRED'));
        await change(
          writer,
          'putCode',
          codeProposal('RETIRED', null, [], false),
        );
        assert.equal(
          (await readCodes('2026-03-01')).some((row) => row.code === 'RETIRED'),
          false,
          'an inactive code was offered',
        );
      });
      await t.test('an inactive code refuses an exact read', async () => {
        await change(writer, 'putCode', codeProposal('RETIRED2'));
        await change(
          writer,
          'putCode',
          codeProposal('RETIRED2', null, [], false),
        );
        const id = await codeId('RETIRED2');
        await assert.rejects(
          as(writer, (client) =>
            client.query(
              "SELECT * FROM platform.tax_read_code($1,'2026-03-01')",
              [id],
            ),
          ),
          /tax\.codeInactive/u,
          'an inactive code answered an exact read',
        );
      });
      await t.test('another tenant reads none of these codes', async () => {
        assert.deepEqual(
          await readCodes('2026-11-26', otherTenant, b),
          [],
          "another tenant read this tenant's codes",
        );
      });

      // ----------------------------------------------------- version storage
      await t.test(
        'a version on or before the latest version day is refused',
        async () => {
          await change(
            writer,
            'putCode',
            codeProposal('ORDERED', '2026-03-01'),
          );
          await assert.rejects(
            change(writer, 'putCode', codeProposal('ORDERED', '2026-02-01')),
            /tax\.versionNotAfterLatest/u,
            'an earlier version was appended',
          );
          await assert.rejects(
            change(writer, 'putCode', codeProposal('ORDERED', '2026-03-01')),
            /tax\.versionNotAfterLatest/u,
            'a same-day version was appended',
          );
        },
      );
      await t.test(
        'storage refuses two versions of one code on one day',
        async () => {
          await change(writer, 'putCode', codeProposal('ONEDAY'));
          const id = await codeId('ONEDAY');
          const receipt = await anyReceipt();
          await assert.rejects(
            owner(
              `INSERT INTO platform.tax_catalog_versions(tenant_id,environment_id,code_id,version,effective_from,receipt_id)
               VALUES ($1,$2,$3,2,'2027-01-01',$4),($1,$2,$3,3,'2027-01-01',$4)`,
              [a.tenant, a.environment, id, receipt],
            ),
            /tax_catalog_versions_one_per_day/u,
            'two versions of one code were stored on one day',
          );
        },
      );
      await t.test(
        'storage refuses changing a version, its components, a component or a receipt',
        async () => {
          for (const table of [
            'tax_catalog_versions',
            'tax_catalog_version_components',
            'tax_components',
            'tax_catalog_receipts',
          ]) {
            await assert.rejects(
              owner(`UPDATE platform.${table} SET tenant_id = tenant_id`),
              /tax\.appendOnly/u,
              `the owner updated platform.${table}`,
            );
            await assert.rejects(
              owner(`DELETE FROM platform.${table}`),
              /tax\.appendOnly/u,
              `the owner deleted from platform.${table}`,
            );
          }
        },
      );
      const storedVersion = async () => {
        const code = `R${randomUUID().slice(0, 8).toUpperCase()}`;
        await change(writer, 'putCode', codeProposal(code));
        return { code_id: await codeId(code) };
      };
      await t.test('storage refuses a rate outside 0 to 100', async () => {
        const { code_id } = await storedVersion();
        await assert.rejects(
          owner(
            `INSERT INTO platform.tax_catalog_version_components(tenant_id,environment_id,code_id,version,component_id,
               rate_percent,recoverable_percent) VALUES ($1,$2,$3,1,'ca-bc.pst',100.5,0)`,
            [a.tenant, a.environment, code_id],
          ),
          /tax_rate_range/u,
          'a rate above 100 percent was stored',
        );
      });
      await t.test(
        'storage refuses a recoverable share outside 0 to 100',
        async () => {
          const { code_id } = await storedVersion();
          await assert.rejects(
            owner(
              `INSERT INTO platform.tax_catalog_version_components(tenant_id,environment_id,code_id,version,component_id,
                 rate_percent,recoverable_percent) VALUES ($1,$2,$3,1,'ca-bc.pst',7,100.5)`,
              [a.tenant, a.environment, code_id],
            ),
            /tax_recoverable_range/u,
            'a recoverable share above 100 percent was stored',
          );
        },
      );

      // ------------------------------------------------- registration storage
      const twoRegistrations = (second: [string, string | null]) =>
        anyReceipt().then((receipt) =>
          owner(
            `INSERT INTO platform.tax_registrations(tenant_id,environment_id,registration_id,company_id,jurisdiction_id,
               registration_number,effective_from,effective_to,receipt_id)
             VALUES ($1,$2,gen_random_uuid(),$3,'ca-sk','S-1','2026-01-01',NULL,$4),
                    ($1,$2,gen_random_uuid(),$3,'ca-sk','S-2',$5,$6,$4)`,
            [a.tenant, a.environment, randomUUID(), receipt, ...second],
          ),
        );
      await t.test(
        'storage refuses overlapping registrations of one company in one jurisdiction',
        async () => {
          await assert.rejects(
            twoRegistrations(['2026-06-01', '2026-09-01']),
            /tax_registrations_no_overlap/u,
            'overlapping registrations were stored',
          );
        },
      );
      await t.test(
        'storage refuses a registration that ends on or before it starts',
        async () => {
          await assert.rejects(
            anyReceipt().then((receipt) =>
              owner(
                `INSERT INTO platform.tax_registrations(tenant_id,environment_id,registration_id,company_id,jurisdiction_id,
                   registration_number,effective_from,effective_to,receipt_id)
                 VALUES ($1,$2,gen_random_uuid(),$3,'ca-mb','M-1','2026-05-01','2026-05-01',$4)`,
                [a.tenant, a.environment, randomUUID(), receipt],
              ),
            ),
            /tax_registrations_range/u,
            'an empty registration range was stored',
          );
        },
      );

      // --------------------------------------------------- catalog privileges
      await t.test(
        'no non-owner role holds a tax table privilege and tenant tables force RLS',
        async () => {
          const { rows } = await admin.query<{ entry: string }>(
            `SELECT r.rolname || ' ' || c.relname || ' ' || p.privilege AS entry
               FROM pg_roles r CROSS JOIN pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'platform'
               CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
              WHERE c.relname = ANY($1) AND NOT r.rolsuper AND r.oid <> c.relowner
                AND (r.rolcanlogin OR r.rolname !~ '^pg_')
                AND has_table_privilege(r.oid, c.oid, p.privilege)
              ORDER BY 1`,
            [[...GLOBAL_TABLES, ...TENANT_TABLES]],
          );
          assert.deepEqual(
            rows,
            [],
            'a non-owner role holds a tax table privilege',
          );
          const rls = await admin.query<{ relname: string }>(
            `SELECT relname FROM pg_class WHERE relnamespace = 'platform'::regnamespace AND relname = ANY($1)
                AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
            [TENANT_TABLES],
          );
          assert.deepEqual(
            rls.rows.map((row) => row.relname),
            [...TENANT_TABLES].sort(),
            'a tenant tax table does not force row-level security',
          );
        },
      );
      await t.test(
        'only north_star_runtime executes the five platform functions and no one the rest',
        async () => {
          const { rows } = await admin.query<{ entry: string }>(
            `SELECT r.rolname || ' ' || f AS entry FROM pg_roles r CROSS JOIN unnest($1::text[]) f
              WHERE NOT r.rolsuper AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = f::regprocedure)
                AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') ORDER BY 1`,
            [[...RUNTIME_FUNCTIONS, ...OWNER_FUNCTIONS]],
          );
          assert.deepEqual(
            rows.map((row) => row.entry),
            RUNTIME_FUNCTIONS.map((f) => `north_star_runtime ${f}`).sort(),
            'a tax function is executable beyond its grant',
          );
        },
      );

      // ------------------------------------------------- confirmation-class
      await t.test(
        'a review does not survive a release switch and back',
        async () => {
          await assert.rejects(
            as(writer, async (client) => {
              const reviewed = await review(
                client,
                'putCode',
                codeProposal('FENCED'),
              );
              for (const target of [alternateA, releaseA])
                await admin.query(
                  'UPDATE platform.active_release_pointers SET release_id=$3,fence=fence+1 WHERE tenant_id=$1 AND environment_id=$2',
                  [a.tenant, a.environment, target],
                );
              return confirm(client, reviewed);
            }),
            /tax\.staleRelease/u,
            'a review confirmed after the release switched away and back',
          );
        },
      );
      await t.test('a confirmed review cannot be confirmed again', async () => {
        await change(writer, 'putCode', codeProposal('ONCE'));
        await assert.rejects(
          as(writer, async (client) => {
            const reviewed = await review(
              client,
              'putCode',
              codeProposal('ONCE', null, [], true),
            );
            await confirm(client, reviewed);
            return confirm(client, reviewed);
          }),
          /tax\.reviewUnavailable/u,
          'a review was confirmed twice',
        );
      });
      await t.test('a confirm with another digest is refused', async () => {
        await change(writer, 'putCode', codeProposal('DIGEST'));
        await assert.rejects(
          as(writer, async (client) =>
            confirm(
              client,
              await review(client, 'putCode', codeProposal('DIGEST', null)),
              'f'.repeat(64),
            ),
          ),
          /tax\.reviewUnavailable/u,
          'a confirm with a different digest applied the review',
        );
      });
      await t.test('another principal cannot confirm a review', async () => {
        await change(writer, 'putCode', codeProposal('MINE'));
        const reviewed = await as(writer, (client) =>
          review(client, 'putCode', codeProposal('MINE', null)),
        );
        await assert.rejects(
          as(writer2, (client) => confirm(client, reviewed)),
          /tax\.reviewUnavailable/u,
          "another principal confirmed the writer's review",
        );
      });
      await t.test('a read grant cannot confirm a code change', async () => {
        await assert.rejects(
          change(reader, 'putCode', codeProposal('READONLY')),
          /tax\.writeDenied/u,
          'a read grant changed a code',
        );
      });
      await t.test('a read grant cannot confirm a registration', async () => {
        await assert.rejects(
          change(reader, 'putRegistration', registration(companyF)),
          /tax\.writeDenied/u,
          'a read grant registered a company',
        );
      });
      await t.test(
        'a principal scoped to one company cannot change a tenant-shared code',
        async () => {
          await assert.rejects(
            change(scopedA, 'putCode', codeProposal('SCOPED')),
            /tax\.writeDenied/u,
            'a company-scoped principal changed a shared code',
          );
        },
      );
      await t.test(
        'a catalog write inside REPEATABLE READ is refused',
        async () => {
          await assert.rejects(
            as(writer, async (client) => {
              await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
              return confirm(
                client,
                await review(client, 'putCode', codeProposal('SNAPSHOT')),
              );
            }),
            /tax\.requiresReadCommitted/u,
            'a code was written inside REPEATABLE READ',
          );
        },
      );
      await t.test(
        'a registration write inside REPEATABLE READ is refused',
        async () => {
          await assert.rejects(
            as(writer, async (client) => {
              await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
              return confirm(
                client,
                await review(client, 'putRegistration', registration(companyD)),
              );
            }),
            /tax\.requiresReadCommitted/u,
            'a registration was written inside REPEATABLE READ',
          );
        },
      );

      // ------------------------------------- registrations and company isolation
      await change(writer, 'putRegistration', registration(companyA));
      await t.test(
        'a principal scoped to company A reads and registers company A',
        async () => {
          await change(
            scopedA,
            'putRegistration',
            registration(companyA, 'ca'),
          );
          const rows = await as(
            scopedA,
            async (client) =>
              (
                await client.query<{ jurisdiction_id: string }>(
                  'SELECT * FROM platform.tax_read_registrations($1)',
                  [companyA],
                )
              ).rows,
          );
          assert.deepEqual(
            rows.map((row) => row.jurisdiction_id),
            ['ca', 'ca-bc'],
          );
        },
      );
      await t.test(
        "a principal scoped to company A is refused company B's registrations",
        async () => {
          await assert.rejects(
            as(scopedA, (client) =>
              client.query(
                'SELECT * FROM platform.tax_read_registrations($1)',
                [companyB],
              ),
            ),
            /tax\.readUnavailable/u,
            "a principal scoped to company A read company B's registrations",
          );
        },
      );
      await t.test(
        'a principal scoped to company A cannot register company B',
        async () => {
          await assert.rejects(
            change(scopedA, 'putRegistration', registration(companyB)),
            /tax\.writeDenied/u,
            'a principal scoped to company A registered company B',
          );
        },
      );
      await t.test(
        'ending a registration takes its company from the stored row',
        async () => {
          const created = await change(
            writer,
            'putRegistration',
            registration(companyC, 'ca-mb'),
          );
          await assert.rejects(
            change(scopedA, 'putRegistration', {
              registrationId: created.registrationId,
              effectiveTo: '2026-12-31',
            }),
            /tax\.writeDenied/u,
            "a principal scoped to company A ended company C's registration",
          );
        },
      );
      await t.test(
        'a registration named by ID ignores a company in the proposal',
        async () => {
          const created = await change(
            writer,
            'putRegistration',
            registration(companyC, 'ca-sk'),
          );
          await assert.rejects(
            change(scopedA, 'putRegistration', {
              registrationId: created.registrationId,
              companyId: companyA,
              effectiveTo: '2026-12-31',
            }),
            /tax\.writeDenied/u,
            "a proposal's company overrode the stored registration's",
          );
        },
      );
      await t.test(
        'a grant revoked after the review refuses the confirm',
        async () => {
          await assert.rejects(
            as(revoked, async (client) => {
              const reviewed = await review(
                client,
                'putCode',
                codeProposal('REVOKED'),
              );
              await admin.query(
                'UPDATE platform.current_policy_memberships SET revoked_at = now() WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3)',
                [a.tenant, a.environment, revoked],
              );
              return confirm(client, reviewed);
            }),
            /tax\.writeDenied/u,
            'a review was confirmed after its grant was revoked',
          );
        },
      );
      await t.test('a review larger than 16 KiB is refused', async () => {
        await assert.rejects(
          as(writer, (client) =>
            review(client, 'putCode', {
              ...codeProposal('LARGE'),
              label: 'x'.repeat(20000),
            }),
          ),
          /tax\.unavailable/u,
          'an oversized proposal was reviewed',
        );
      });
      await t.test(
        'a member without the read grant is refused the codes',
        async () => {
          await assert.rejects(
            as(outsider, (client) =>
              client.query('SELECT * FROM platform.tax_read_codes($1)', [
                '2026-03-01',
              ]),
            ),
            /tax\.readUnavailable/u,
            'a member without the read grant read the codes',
          );
        },
      );
      await t.test(
        'a member without the read grant is refused one code',
        async () => {
          const id = await codeId('GST');
          await assert.rejects(
            as(outsider, (client) =>
              client.query(
                "SELECT * FROM platform.tax_read_code($1,'2026-03-01')",
                [id],
              ),
            ),
            /tax\.readUnavailable/u,
            'a member without the read grant read one code',
          );
        },
      );
      await t.test(
        'a member without the read grant is refused the registrations',
        async () => {
          await assert.rejects(
            as(outsider, (client) =>
              client.query(
                'SELECT * FROM platform.tax_read_registrations($1)',
                [companyA],
              ),
            ),
            /tax\.readUnavailable/u,
            'a member without the read grant read the registrations',
          );
        },
      );
      await t.test(
        'a registration for a company that is not a live legal entity is refused at review',
        async () => {
          await assert.rejects(
            as(writer, (client) =>
              review(client, 'putRegistration', registration(randomUUID())),
            ),
            /tax\.companyUnavailable/u,
            'a registration for an unknown company was reviewed',
          );
        },
      );
      await t.test(
        'a company archived after the review refuses the confirm',
        async () => {
          await assert.rejects(
            as(writer, async (client) => {
              const reviewed = await review(
                client,
                'putRegistration',
                registration(companyG, 'ca'),
              );
              await admin.query(
                'UPDATE north_star_module.test_tax_companies SET archived_at = now() WHERE record_id = $1',
                [companyG],
              );
              return confirm(client, reviewed);
            }),
            /tax\.companyUnavailable/u,
            'a registration for an archived company was confirmed',
          );
        },
      );
      await t.test('an end date of infinity is refused', async () => {
        const created = await change(
          writer,
          'putRegistration',
          registration(companyC, 'ca'),
        );
        await assert.rejects(
          change(writer, 'putRegistration', {
            registrationId: created.registrationId,
            effectiveTo: 'infinity',
          }),
          /tax\.invalidRegistration/u,
          'an infinite registration end was accepted',
        );
      });
      await t.test(
        'storage refuses an infinite registration date',
        async () => {
          await assert.rejects(
            anyReceipt().then((receipt) =>
              owner(
                `INSERT INTO platform.tax_registrations(tenant_id,environment_id,registration_id,company_id,jurisdiction_id,
                   registration_number,effective_from,effective_to,receipt_id)
                 VALUES ($1,$2,gen_random_uuid(),$3,'ca-mb','M-9','2026-05-01','infinity',$4)`,
                [a.tenant, a.environment, randomUUID(), receipt],
              ),
            ),
            /tax_registrations_finite/u,
            'an infinite registration date was stored',
          );
        },
      );
      await t.test('a registration ends once', async () => {
        const created = await change(
          writer,
          'putRegistration',
          registration(companyE, 'ca-sk'),
        );
        const end = (day: string) =>
          change(writer, 'putRegistration', {
            registrationId: created.registrationId,
            effectiveTo: day,
          });
        await end('2026-12-31');
        await assert.rejects(
          end('2027-06-30'),
          /tax\.registrationNotOpen/u,
          'an ended registration was ended again',
        );
      });
      await t.test(
        'another tenant reads none of these registrations',
        async () => {
          const rows = await as(
            otherTenant,
            async (client) =>
              (
                await client.query(
                  'SELECT * FROM platform.tax_read_registrations($1)',
                  [companyA],
                )
              ).rows,
            b,
          );
          assert.deepEqual(
            rows,
            [],
            "another tenant read this tenant's registrations",
          );
        },
      );
    } finally {
      admin.release();
      await runtime.end();
    }
  });
}

test('tax catalog', (t) => world(t));
