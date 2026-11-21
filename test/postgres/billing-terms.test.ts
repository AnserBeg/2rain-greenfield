import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { parseAuthoredApplicationPackageJson } from '../../packages/canonical-model/src/index.js';
import {
  BillingPlanSchema,
  BILLING_TERMS_CAPABILITY,
  BILLING_QUOTE_CAPABILITY,
} from '../../packages/canonical-model/src/billing.js';
import {
  canonicalize,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/canonicalize.js';
import {
  quoteBillingService,
  replayBillingQuote,
} from '../../packages/domain/src/billing/quote.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import {
  compileApplicationRelease,
  MODULE_COMPILER_PROFILE,
  expectedActiveReleaseFrom,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { compilerInput, normalizedBytes } from '../compiler/helpers.js';
import {
  authoredPath,
  firstPartyAuthored,
  compiledApplication,
} from '../helpers/customization-fixture.js';
import { applicationWithoutLineCreateValues } from '../helpers/application-without-line-create-values.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import {
  archivedBillingMigration,
  archivedBillingQuery,
} from '../helpers/archived-billing-probes.js';

const id = (name: string) => 'northstar.app:' + name;
const ref = (kind: string, targetId: string) => ({
  kind,
  targetId,
  schemaVersion: 'v6' as const,
});
const quoteId = id('query.billable_quote'),
  sourceId = id('query.sales_order_get'),
  notesField = id('field.sales_order_notes'),
  proposalField = id('field.sales_order_billing_proposal');
const precedingIntervalReader = 'f1829ea9ce70a886a050e043dce23cb12267335d'; // 67e4efce^1
const readPermission = id('permission.billing_quote'),
  publishPermission = id('permission.billing_publish_terms');
const plan = BillingPlanSchema.parse({
  schemaVersion: 'v6',
  id: 'capacity',
  version: '1',
  currency: 'CAD',
  serviceUnit: 'seat',
  slots: ['daily', 'weekly'].map((id) => ({
    kind: 'money',
    id,
    currency: 'CAD',
    scale: 2,
  })),
  schedule: { kind: 'onServiceEnd' },
  components: [
    {
      id: 'time',
      kind: 'time',
      stage: 'beforeMinimum',
      taxClassification: 'untaxed',
      base: 'serviceInterval',
      rates: { day: 'daily', week: 'weekly' },
    },
  ],
  bindings: {
    quoteQueryId: quoteId,
    evidenceQueryId: sourceId,
    agreedInterval: {
      customerFieldId: id('field.sales_order_customer_party_id'),
      currencyFieldId: id('field.sales_order_currency'),
      startFieldId: id('field.sales_order_order_date'),
      endFieldId: id('field.sales_order_requested_date'),
      zone: 'UTC',
    },
    termsQueryId: sourceId,
    termsFieldId: proposalField,
    publishOperationId: id('operation.billing_publish'),
    overrideOperationId: id('operation.billing_override'),
    assignmentOperationId: id('operation.billing_assign'),
  },
});
function billingFixture(mode: 'bound' | 'legacy' | 'declaration') {
  const compatibility =
    mode === 'declaration' ? applicationWithoutLineCreateValues() : undefined;
  const p = parseAuthoredApplicationPackageJson(
    JSON.stringify(compatibility?.authored ?? firstPartyAuthored),
  );
  const source = p.queries.find((q) => q.queryId === sourceId)!;
  if (source.queryType !== 'get')
    throw new Error('Expected an exact fixture query');
  const op = p.operations.find(
    (o) => o.operationId === id('operation.sales_order_release'),
  )!;
  const sourcePermission = p.permissions.find(
    (a) => a.permissionId === source.permission.targetId,
  )!;
  const writePermission = p.permissions.find(
    (a) => a.permissionId === op.permission.targetId,
  )!;
  const requirement = p.capabilityRequirements.find(
    (c) => c.capabilityId === 'northstar.sales:capability.fulfillment',
  )!;
  const quote = {
    ...source,
    queryId: quoteId,
    permission: ref('permissionReference', readPermission),
    selections: source.selections.map((s, i) => ({
      ...s,
      selectionId: id('selection.billing_quote_' + String(i)),
    })),
    readModel: {
      capability: ref('capabilityReference', BILLING_QUOTE_CAPABILITY),
      binding: 'northstar.billing:read_model.quote',
      queries: { evidence: ref('queryReference', sourceId) },
      resultFields: { explanation: id('metric.billing_explanation') },
    },
  };
  const permissions = [
    { ...sourcePermission, permissionId: readPermission },
    { ...writePermission, permissionId: publishPermission },
  ];
  const b = plan.bindings!;
  const notes = p.fields.find((f) => f.fieldId === notesField)!;
  const termsSource = {
    ...source,
    selections: [
      ...source.selections,
      {
        ...source.selections[0]!,
        field: ref('fieldReference', proposalField),
        selectionId: id('selection.sales_order_get_billing_proposal'),
        orderKey: 10000,
      },
    ],
  };
  const boundInput = {
    ...p,
    billingPlans: [plan],
    fields: [
      ...p.fields,
      {
        ...notes,
        fieldId: proposalField,
        label: 'Billing proposal',
        orderKey: 10000,
      },
    ],
    queries: [
      ...p.queries.filter((q) => q.queryId !== sourceId),
      termsSource,
      quote,
    ],
    permissions: [...p.permissions, ...permissions],
    operations: [
      ...p.operations,
      ...[
        b.publishOperationId,
        b.overrideOperationId,
        b.assignmentOperationId,
      ].map((operationId) => ({
        ...op,
        operationId,
        permission: ref('permissionReference', publishPermission),
        readBack: ref('queryReference', sourceId),
        effect: {
          kind: 'registeredCapabilityEffect',
          schemaVersion: 'v6',
          capability: ref('capabilityReference', BILLING_TERMS_CAPABILITY),
        },
      })),
    ],
    capabilityRequirements: [
      ...p.capabilityRequirements,
      { ...requirement, capabilityId: BILLING_TERMS_CAPABILITY },
      {
        ...requirement,
        capabilityId: BILLING_QUOTE_CAPABILITY,
        declaredEffects: ['read'],
      },
    ],
  };
  const input =
    mode === 'declaration'
      ? { ...p, billingPlans: [{ ...plan, bindings: undefined }] }
      : mode === 'legacy'
        ? {
            ...boundInput,
            billingPlans: [
              {
                ...plan,
                bindings: {
                  ...b,
                  agreedInterval: undefined,
                  evidenceFieldId: notesField,
                },
              },
            ],
          }
        : boundInput;
  const old = parseCompiledApplication(
    compatibility?.release ?? compiledApplication,
  );
  const bytes = normalizedBytes(JSON.parse(JSON.stringify(input))),
    ack = readUnboundPermissionAcknowledgementFor(
      authoredPath,
      p.package.packageId,
    );
  return { bytes, old, permissions, ack, languageVersion: p.languageVersion };
}

function release(mode: 'bound' | 'legacy' | 'declaration' = 'bound') {
  const { bytes, old, permissions, ack, languageVersion } =
    billingFixture(mode);
  const args = compilerInput(
    bytes,
    expectedActiveReleaseFrom(old.application.compiled),
  );
  const compiled = compileApplicationRelease(
    {
      ...args,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion,
        normalizationProfileVersion: args.profile.normalizationProfileVersion,
      },
    },
    {
      ...ack,
      evaluatorBindings: [
        ...ack.evaluatorBindings!,
        ...(mode === 'declaration' ? [] : permissions).map((a) => ({
          permissionId: a.permissionId,
          resource: a.resource.targetId,
          action: a.action,
        })),
      ],
    },
  );
  if (mode === 'legacy') {
    assert.ok(
      compiled.status !== 'compiled' &&
        compiled.diagnostics.some(
          (d) => d.rule === 'BILLING_SOURCE_FIELDS_REQUIRED',
        ),
      'notes binding escaped compilation',
    );
    return;
  }
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.diagnostics),
  );
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v2',
    bootstrap: serializeRelease(old.bootstrap),
    applications: [
      ...old.applications.map(serializeRelease),
      serializeRelease({ compiled, normalizedDefinitionBytes: bytes }),
    ],
  };
}
test('the serving role has no direct billing table privileges', async () => {
  await withEphemeralPostgres('billing-privileges', async ({ pool }) => {
    const admin = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
      for (const table of ['billing_rate_tables', 'billing_list_assignments']) {
        const grants = await admin.query(
          "SELECT has_table_privilege('north_star_runtime',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS direct",
          ['platform.' + table],
        );
        assert.equal(
          grants.rows[0].direct,
          false,
          'direct billing privilege on ' + table,
        );
      }
    } finally {
      admin.release();
    }
  });
});

test('the compiler refuses an editable notes source', () => {
  release('legacy');
});

test('the archived serving reader refuses the declaring capacity release', async () => {
  await withOrderEntryFixture(
    async (f) => {
      const { host, port, database, user } = f.pool.options;
      await withArchivedCustomizationRuntime(
        'f25df5af44df132045c67ba29eb9aebe1084dcc7',
        async (run) => {
          const result = await archivedRuntimeRead(run, {
            databaseUrl: `postgresql://${user}@${host}:${port}/${database}`,
            identity: f.app.runtime.identity,
          });
          assert.equal(result.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
          assert.match(
            result.message ?? '',
            /surface-manifest requires version 30/,
          );
        },
      );
    },
    'demo',
    0,
    0,
    release('declaration'),
  );
});

test('reader 35 answers a stored query and refuses the bound interval release by name', async () => {
  await withArchivedCustomizationRuntime(
    precedingIntervalReader,
    async (run) => {
      const probe = async (
        f: Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0],
      ) => {
        const { host, port, database, user } = f.pool.options;
        const stored = () =>
          f.pool.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)) FROM platform.active_release_pointers p) AS pointers,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)) FROM platform.tenant_releases r) AS releases,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)) FROM platform.tenant_release_projection_links p) AS projections,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)) FROM platform.tenant_release_chunk_links c) AS chunks,
        (SELECT jsonb_agg(to_jsonb(r) - 'desired_state' || jsonb_build_object('desired_state', encode(sha256(desired_state), 'hex')) ORDER BY to_jsonb(r)) FROM platform.app_package_revisions r) AS revisions,
        (SELECT jsonb_agg(to_jsonb(b) - 'canonical_bytes' || jsonb_build_object('canonical_bytes', encode(sha256(canonical_bytes), 'hex')) ORDER BY b.content_hash, b.artifact_kind) FROM platform.release_artifact_blobs b) AS artifacts`);
        const before = (await stored()).rows;
        const result = (await run(archivedBillingQuery, {
          databaseUrl: `postgresql://${user}@${host}:${port}/${database}`,
          identity: f.app.runtime.identity,
          item: f.item,
        })) as {
          outcome: string;
          code?: string;
          message?: string;
          recordIds?: string[];
        };
        assert.deepEqual(
          (await stored()).rows,
          before,
          'the archived probe changed stored release bytes',
        );
        return result;
      };
      await withOrderEntryFixture(async (f) => {
        assert.deepEqual(await probe(f), {
          outcome: 'exact',
          recordIds: [f.item],
        });
      });
      await withOrderEntryFixture(
        async (f) => {
          const result = await probe(f);
          assert.equal(result.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
          assert.match(
            result.message ?? '',
            /surface-manifest requires version 36 and this runtime supports 35/,
          );
        },
        'demo',
        0,
        0,
        release(),
      );
    },
  );
});

test('the billing migrations preserve rates and assignments published by the preceding runtime', async () => {
  const { bytes, permissions } = billingFixture('legacy');
  await withArchivedCustomizationRuntime(
    precedingIntervalReader,
    async (run) => {
      assert.deepEqual(
        await run(archivedBillingMigration, {
          definition: Buffer.from(bytes).toString('utf8'),
          permissions: permissions.map((p) => ({
            permissionId: p.permissionId,
            resource: p.resource.targetId,
            action: p.action,
          })),
          migrationDirectory: resolve('db/migrations'),
        }),
        { outcome: 'upgraded' },
      );
    },
  );
});

test('governed terms and scoped source facts produce a quote through the installed semantic gateways', async () => {
  await withOrderEntryFixture(
    async (f) => {
      const actor = { headers: { cookie: 'northstar-demo-actor=buyer' } };
      const ids = await f.app.runtime.entry.run(actor, async (v) => ({
        tenantId: v.tenantId,
        environmentId: v.environmentId,
        principalId: v.principalId,
        releaseId: v.release.releaseId,
        release: v.release.contentHash,
      }));
      const anchor = '2025-01-01T00:00:00.000Z',
        end = '2025-01-09T00:00:00.000Z';
      const create = async (
        notes: unknown,
        recordId: string = randomUUID(),
        currency = 'CAD',
        company: string = f.scope,
        proposal?: unknown,
      ) => {
        const values = {
          customer_party_id: f.customer,
          order_date: anchor,
          requested_date: end,
          currency,
          notes: JSON.stringify(notes),
          ...(proposal === undefined
            ? {}
            : { billing_proposal: JSON.stringify(proposal) }),
          ship_to_name: 'Service desk',
          ship_to_street: '100 Industrial Way',
          ship_to_city: 'Calgary',
          ship_to_region: 'AB',
          ship_to_postal_code: 'T2P 0A1',
          ship_to_country: 'Canada',
        };
        const created = await f.invoke('sales_order_create', {
          recordId,
          legalEntityId: company,
          relations: {},
          values: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              id('field.sales_order_' + key),
              value,
            ]),
          ),
        });
        assert.ok(created.readBack);
        return created.readBack;
      };
      const version = {
        schemaVersion: 'northstar.billing-rate-table/v1',
        version: 'base1',
        currency: 'CAD',
        selector: { kind: 'base' },
        planDigest: compileRatePlan(plan).digest,
        effectiveFrom: anchor,
        values: { daily: '30', weekly: '100' },
      };
      const propose = (body: unknown, company = f.scope) =>
        create(
          { ...version, values: { daily: '1', weekly: '5' } },
          randomUUID(),
          'CAD',
          company,
          body,
        );
      const proposal = await propose(version);
      const revision = {
          recordId: proposal.recordId,
          expectedRevision: proposal.revision,
        },
        key = randomUUID();
      await f.measure('deny', undefined, undefined, 'billing_publish_terms');
      await assert.rejects(() => f.invoke('billing_publish', revision, key));
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n FROM platform.billing_rate_tables',
          )
        ).rows[0].n,
        0,
      );
      await f.measure('allow', undefined, undefined, 'billing_publish_terms');
      const notesOnly = await create(version);
      await assert.rejects(
        () =>
          f.invoke('billing_publish', {
            recordId: notesOnly.recordId,
            expectedRevision: notesOnly.revision,
          }),
        /BILLING_TERMS_INVALID/,
      );
      const published = await f.invoke('billing_publish', revision, key);
      assert.equal(published.outcome, 'succeeded');
      const receipt = published.trust;
      assert.ok(receipt);
      const storedReceipt = await f.pool.query(
        `SELECT outbox_id FROM platform.trust_outbox
         WHERE tenant_id=$1 AND environment_id=$2 AND invocation_id=$3
           AND change_document_id=$4 AND domain_event_id=$5 AND outbox_id=$6`,
        [
          ids.tenantId,
          ids.environmentId,
          receipt.invocationId,
          receipt.changeDocumentId,
          receipt.domainEventId,
          receipt.outboxId,
        ],
      );
      assert.equal(storedReceipt.rowCount, 1);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT body FROM platform.billing_rate_tables WHERE invocation_id=$1',
            [receipt.invocationId],
          )
        ).rows,
        [{ body: version }],
      );
      assert.equal(
        (await f.invoke('billing_publish', revision, key)).trust?.invocationId,
        receipt.invocationId,
      );
      const archived = await f.invoke('sales_order_archive', revision);
      assert.equal(archived.outcome, 'succeeded');
      assert.deepEqual(
        (await f.invoke('billing_publish', revision, key)).trust,
        receipt,
        'exact retry after archive lost its receipt',
      );
      await f.measure('deny', undefined, undefined, 'billing_publish_terms');
      await assert.rejects(() => f.invoke('billing_publish', revision, key));
      await f.measure('allow', undefined, undefined, 'billing_publish_terms');
      const companyB = (
        await f.create(
          'legal_entity',
          {
            code: 'BILL-B',
            name: 'Second company',
            status: id('option.legal_entity_status_active'),
            is_default: false,
          },
          {},
          false,
        )
      ).recordId;
      const bProposal = await propose(version, companyB);
      const bRevision = {
        recordId: bProposal.recordId,
        expectedRevision: bProposal.revision,
      };
      const bPublished = await f.invoke('billing_publish', bRevision);
      assert.equal(bPublished.outcome, 'succeeded');
      assert.ok(bPublished.trust);
      const bBody = { ...version, version: 'baseB2' };
      const bSuccessor = await propose(bBody, companyB);
      await f.pool.query(
        'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
        [ids.tenantId, ids.environmentId, ids.principalId, f.scope],
      );
      await assert.rejects(
        () =>
          f.invoke('billing_publish', {
            recordId: bSuccessor.recordId,
            expectedRevision: bSuccessor.revision,
          }),
        { code: 'SEMANTIC_OPERATION_POLICY_DENIED' },
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM platform.billing_rate_tables WHERE company_id=$1',
            [companyB],
          )
        ).rows[0].n,
        1,
      );
      const db = await f.pool.connect();
      try {
        await db.query('BEGIN');
        // Copy the accepted trust chain for a new exact proposal in company B.
        // The function's receipt check requires it to be written in this transaction.
        const headers = {
          invocation_id: randomUUID(),
          change_document_id: randomUUID(),
          domain_event_id: randomUUID(),
          outbox_id: randomUUID(),
          correlation_id: randomUUID(),
        };
        const requestKey = randomUUID();
        const tableDigest = canonicalizeAndHash(bBody).contentHash;
        const metadata = {
          companyId: { classification: 'INTERNAL', value: companyB },
          tableDigest: { classification: 'INTERNAL', value: tableDigest },
        };
        for (const [table, patch] of [
          ['trust_action_invocations', { metadata, policy_inputs: metadata }],
          [
            'trust_business_change_documents',
            { record_id: bSuccessor.recordId, revision: bSuccessor.revision },
          ],
          ['trust_domain_events', { payload: metadata }],
          ['trust_outbox', { deduplication_key: requestKey }],
          [
            'semantic_operation_receipts',
            {
              idempotency_key: requestKey,
              mutation_result: {
                recordId: bSuccessor.recordId,
                planDigest: bBody.planDigest,
              },
            },
          ],
        ] as const) {
          const cloned = await db.query(
            `INSERT INTO platform.${table}
            SELECT (jsonb_populate_record(NULL::platform.${table}, to_jsonb(s) || $2::jsonb)).*
            FROM platform.${table} s WHERE s.invocation_id=$1`,
            [
              bPublished.trust.invocationId,
              JSON.stringify({ ...headers, ...patch }),
            ],
          );
          assert.equal(cloned.rowCount, 1);
        }
        await db.query('SET LOCAL ROLE north_star_runtime');
        await db.query(
          "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),set_config('north_star.principal_id',$3,true)",
          [ids.tenantId, ids.environmentId, ids.principalId],
        );
        const denied = async (sql: string, params: unknown[] = []) => {
          await db.query('SAVEPOINT denied');
          await assert.rejects(() => db.query(sql, params), { code: '42501' });
          await db.query('ROLLBACK TO SAVEPOINT denied');
        };
        for (const table of [
          'billing_rate_tables',
          'billing_list_assignments',
        ]) {
          await denied('SELECT 1 FROM platform.' + table + ' LIMIT 0');
          await denied('INSERT INTO platform.' + table + ' DEFAULT VALUES');
        }
        const query = 'SELECT * FROM platform.billing_quote_terms($1,$2,$3,$4)';
        const readArgs = [
          ids.releaseId,
          f.scope,
          canonicalize(compileRatePlan(plan).plan),
          f.customer,
        ];
        assert.equal(
          (await db.query(query, readArgs)).rows[0].tables.length,
          1,
        );
        await denied(query, [ids.releaseId, companyB, ...readArgs.slice(2)]);
        const publishSql = 'SELECT platform.billing_publish($1,$2,$3,$4)';
        const publishArgs = [
          id('operation.billing_publish'),
          requestKey,
          canonicalize(bBody),
          readArgs[2],
        ];
        await denied(publishSql, publishArgs);
        // Restore the grant and run the identical SQL to prove every other check accepts it.
        await db.query('RESET ROLE');
        await db.query(
          'UPDATE platform.current_policy_memberships SET legal_entity_id=NULL WHERE (tenant_id,environment_id,principal_id,legal_entity_id)=($1,$2,$3,$4)',
          [ids.tenantId, ids.environmentId, ids.principalId, f.scope],
        );
        await db.query('SET LOCAL ROLE north_star_runtime');
        await db.query(publishSql, publishArgs);
        await db.query("SELECT set_config('north_star.tenant_id',$1,true)", [
          randomUUID(),
        ]);
        await denied(query, readArgs);
      } finally {
        await db.query('ROLLBACK');
        db.release();
      }
      await f.pool.query(
        'UPDATE platform.current_policy_memberships SET legal_entity_id=NULL WHERE (tenant_id,environment_id,principal_id,legal_entity_id)=($1,$2,$3,$4)',
        [ids.tenantId, ids.environmentId, ids.principalId, f.scope],
      );
      const otherCustomer = randomUUID();
      const override = await propose({
        ...version,
        version: 'other-customer',
        selector: { kind: 'customer', customerId: otherCustomer },
        values: { daily: '1', weekly: '5' },
      });
      const applied = await f.invoke('billing_override', {
        recordId: override.recordId,
        expectedRevision: override.revision,
      });
      assert.ok(applied.trust);
      const assignment = await propose({
        schemaVersion: 'northstar.billing-list-assignment/v1',
        customerId: f.customer,
        listId: 'standard',
        priority: 1,
        revision: '1',
        effectiveFrom: anchor,
      });
      assert.equal(
        (
          await f.invoke('billing_assign', {
            recordId: assignment.recordId,
            expectedRevision: assignment.revision,
          })
        ).outcome,
        'succeeded',
      );
      const notes = {
        customerId: otherCustomer,
        currency: 'CAD',
        companyId: randomUUID(),
      };
      const service = await create(notes);
      const get = (recordId: string) =>
        f.app.runtime.entry.run(actor, (v) =>
          f.app.runtime.queryGateway.invoke(v, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: quoteId,
            arguments: {
              recordId,
              [id('parameter.sales_order_get_legal_entity_scope')]: f.scope,
            },
          }),
        );
      const quote = await get(service.recordId);
      assert.equal(quote.outcome, 'exact');
      const saved = JSON.parse(
        String(quote.records[0]!.values[id('metric.billing_explanation')]),
      ) as ReturnType<typeof quoteBillingService>;
      assert.equal(saved.inputs.evidence.customerId, f.customer);
      assert.equal(saved.inputs.evidence.companyId, f.scope);
      assert.equal(saved.lines[0]!.differenceCents, '13000');
      const first = quoteBillingService(saved.inputs.plan, {
        ...saved.inputs.evidence,
        serviceEnd: '2025-01-05T00:00:00.000Z',
      });
      assert.equal(first.lines[0]!.entitlementCents, '10000');
      const usd = await create(notes, randomUUID(), 'USD');
      await assert.rejects(
        () => get(usd.recordId),
        /source identity, currency or interval disagrees/,
      );
      const successor = await propose({
        ...version,
        version: 'base2',
        values: { daily: '10', weekly: '50' },
      });
      await f.invoke('billing_publish', {
        recordId: successor.recordId,
        expectedRevision: successor.revision,
      });
      assert.equal(replayBillingQuote(saved).resultDigest, saved.resultDigest);
      const next = await get(service.recordId);
      const later = JSON.parse(
        String(next.records[0]!.values[id('metric.billing_explanation')]),
      ) as typeof saved;
      assert.equal(later.inputs.evidence.tables.length, 2);
      assert.equal(later.lines[0]!.entitlementCents, '6000');
      const difference = quoteBillingService(later.inputs.plan, {
        ...later.inputs.evidence,
        periodStart: '2025-01-05T00:00:00.000Z',
        termPins: first.terms,
        allocations: [
          {
            componentId: first.lines[0]!.componentId,
            occurrence: first.lines[0]!.occurrence,
            allocatedCents: first.lines[0]!.entitlementCents,
            reservedCents: '0',
          },
        ],
      });
      assert.equal(difference.lines[0]!.differenceCents, '3000');
    },
    'demo',
    0,
    0,
    release(),
  );
});
