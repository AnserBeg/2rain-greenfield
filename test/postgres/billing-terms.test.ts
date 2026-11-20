import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { parseAuthoredApplicationPackageJson } from '../../packages/canonical-model/src/index.js';
import {
  BillingPlanSchema,
  BILLING_TERMS_CAPABILITY,
  BILLING_QUOTE_CAPABILITY,
} from '../../packages/canonical-model/src/billing.js';
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
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const id = (name: string) => 'northstar.app:' + name;
const ref = (kind: string, targetId: string) => ({
  kind,
  targetId,
  schemaVersion: 'v6' as const,
});
const quoteId = id('query.billable_quote'),
  sourceId = id('query.sales_order_get'),
  field = id('field.sales_order_notes');
const readPermission = id('permission.billing_quote'),
  publishPermission = id('permission.billing_publish_terms');
const plan = BillingPlanSchema.parse({
  schemaVersion: 'v6',
  id: 'fixed-service',
  version: '1',
  currency: 'CAD',
  serviceUnit: 'seat',
  slots: [{ kind: 'money', id: 'fee', currency: 'CAD', scale: 2 }],
  schedule: { kind: 'onServiceEnd' },
  components: [
    {
      id: 'close',
      kind: 'fixed',
      stage: 'afterCapBeforeTax',
      taxClassification: 'untaxed',
      base: 'enrollment',
      amount: 'fee',
      occurrence: { kind: 'oneOff', at: 'serviceEnd' },
    },
  ],
  bindings: {
    quoteQueryId: quoteId,
    evidenceQueryId: sourceId,
    evidenceFieldId: field,
    termsQueryId: sourceId,
    termsFieldId: field,
    publishOperationId: id('operation.billing_publish'),
    overrideOperationId: id('operation.billing_override'),
    assignmentOperationId: id('operation.billing_assign'),
  },
});
function release() {
  const p = parseAuthoredApplicationPackageJson(
    JSON.stringify(firstPartyAuthored),
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
  const input = {
    ...p,
    billingPlans: [plan],
    queries: [...p.queries, quote],
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
  const old = parseCompiledApplication(compiledApplication);
  const bytes = normalizedBytes(input),
    ack = readUnboundPermissionAcknowledgementFor(
      authoredPath,
      p.package.packageId,
    );
  const args = compilerInput(
    bytes,
    expectedActiveReleaseFrom(old.application.compiled),
  );
  const compiled = compileApplicationRelease(
    {
      ...args,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: p.languageVersion,
        normalizationProfileVersion: p.normalizationProfileVersion,
      },
    },
    {
      ...ack,
      evaluatorBindings: [
        ...ack.evaluatorBindings!,
        ...permissions.map((a) => ({
          permissionId: a.permissionId,
          resource: a.resource.targetId,
          action: a.action,
        })),
      ],
    },
  );
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
test('governed terms and scoped source facts produce a quote through the installed semantic gateways', async () => {
  await withOrderEntryFixture(
    async (f) => {
      const actor = { headers: { cookie: 'northstar-demo-actor=buyer' } };
      const ids = await f.app.runtime.entry.run(actor, async (v) => ({
        tenantId: v.tenantId,
        environmentId: v.environmentId,
        release: v.release.contentHash,
      }));
      const anchor = '2025-01-01T00:00:00.000Z',
        end = '2025-02-01T00:00:00.000Z';
      const create = (notes: unknown, recordId: string = randomUUID()) =>
        f.create(
          'sales_order',
          {
            customer_party_id: f.customer,
            order_date: anchor,
            requested_date: end,
            currency: 'CAD',
            notes: JSON.stringify(notes),
            ship_to_name: 'Service desk',
            ship_to_street: '100 Industrial Way',
            ship_to_city: 'Calgary',
            ship_to_region: 'AB',
            ship_to_postal_code: 'T2P 0A1',
            ship_to_country: 'Canada',
          },
          {},
          true,
          recordId,
        );
      const version = {
        schemaVersion: 'northstar.billing-rate-table/v1',
        version: 'base1',
        currency: 'CAD',
        selector: { kind: 'base' },
        planDigest: compileRatePlan(plan).digest,
        effectiveFrom: anchor,
        values: { fee: '31' },
      };
      const proposal = await create(version);
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
      const published = await f.invoke('billing_publish', revision, key);
      assert.equal(published.outcome, 'succeeded');
      assert.equal(
        (await f.invoke('billing_publish', revision, key)).trust?.invocationId,
        published.trust?.invocationId,
      );
      const db = await f.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SET LOCAL ROLE north_star_runtime');
        await db.query(
          "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),set_config('north_star.principal_id',$3,true)",
          [ids.tenantId, ids.environmentId, randomUUID()],
        );
        const count = async () =>
          (
            await db.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM platform.billing_rate_tables',
            )
          ).rows[0]!.n;
        assert.equal(await count(), 1);
        await db.query("SELECT set_config('north_star.tenant_id',$1,true)", [
          randomUUID(),
        ]);
        assert.equal(
          await count(),
          0,
          'another tenant read the published price',
        );
        await db.query("SELECT set_config('north_star.tenant_id',$1,true)", [
          ids.tenantId,
        ]);
        await assert.rejects(
          () =>
            db.query(
              "UPDATE platform.billing_rate_tables SET version_id='edited'",
            ),
          { code: '42501' },
          'the serving role rewrote a published price',
        );
      } finally {
        await db.query('ROLLBACK');
        db.release();
      }
      const serviceId = randomUUID();
      const facts = {
        ...ids,
        schemaVersion: 'northstar.billing-quote-evidence/v1',
        sourceQueryId: sourceId,
        sourceRevision: '1',
        cursor: '1',
        serviceId,
        companyId: f.scope,
        customerId: f.customer,
        serviceUnit: 'seat',
        currency: 'CAD',
        anchor,
        zone: 'America/Edmonton',
        asOf: end,
        periodStart: anchor,
        serviceEnd: end,
        basis: 'usageOnly',
        bands: [],
        usage: [],
        pauses: [],
      };
      const service = await create(facts, serviceId);
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
      const explain = JSON.parse(
        String(quote.records[0]!.values[id('metric.billing_explanation')]),
      ) as {
        lines: { differenceCents: string }[];
        terms: { version: string }[];
      };
      assert.equal(explain.lines[0]?.differenceCents, '3100');
      assert.equal(explain.terms[0]?.version, 'base1');
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n FROM platform.billing_rate_tables',
          )
        ).rows[0].n,
        1,
      );
      const alteredId = randomUUID();
      await create(
        { ...facts, serviceId: alteredId, tables: [{ values: { fee: '0' } }] },
        alteredId,
      );
      await assert.rejects(
        () => get(alteredId),
        /Service facts cannot supply commercial terms or allocations/,
      );
    },
    'demo',
    0,
    0,
    release(),
  );
});
