export const archivedBillingQuery = `
import { readFile } from 'node:fs/promises';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { ObservabilityMetrics } from './packages/observability/src/metrics.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';

const { databaseUrl, identity, item } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = rolePool(databaseUrl, 'north_star_runtime', 2);
try {
  const context = await trustedContext(identity);
  const loader = new PostgresRequestRuntimeViewService(pool);
  const definitions = await loader.load(context);
  const serving = await loadServingRelease(pool, context, definitions.release.releaseId);
  const { policy, queryGateway } = composeServingGateways(pool, pool, context, serving,
    new ObservabilityMetrics(), { providerErrorMappings: [] });
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async () => identity), loader, policy);
  const result = await entry.run({}, (view) => queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: 'northstar.app:query.item_get',
    arguments: { recordId: item },
  }));
  console.log(JSON.stringify({ outcome: result.outcome, recordIds: result.records.map((row) => row.recordId) }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'refused', code: error.code, message: error.message }));
} finally {
  await pool.end();
}
`;

export const archivedBillingMigration = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
import { compileApplicationRelease, MODULE_COMPILER_PROFILE, expectedActiveReleaseFrom } from './packages/compiler/src/index.ts';
import { parseNormalizedApplicationPackageJson } from './packages/canonical-model/src/index.ts';
import { serializeRelease } from './packages/customization/src/index.ts';
import { compileRatePlan } from './packages/domain/src/billing/terms.ts';
import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { loadMigrations, runMigrations } from './packages/postgres-provider/src/migrations.ts';
import { compilerInput } from './test/compiler/helpers.ts';
import { withOrderEntryFixture } from './test/helpers/order-entry-fixture.ts';

const { definition, permissions, migrationDirectory } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bytes = Buffer.from(definition, 'utf8');
const old = parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json', 'utf8')));
const args = compilerInput(bytes, expectedActiveReleaseFrom(old.application.compiled));
const ack = readUnboundPermissionAcknowledgementFor('apps/web/release/app.authored.json', 'northstar.app:package.application');
const compiled = compileApplicationRelease({ ...args, profile: { ...MODULE_COMPILER_PROFILE, languageVersion: 'v6', normalizationProfileVersion: args.profile.normalizationProfileVersion } }, {
  ...ack, evaluatorBindings: [...ack.evaluatorBindings, ...permissions],
});
assert.equal(compiled.status, 'compiled', JSON.stringify(compiled.diagnostics));
const application = {
  schemaVersion: 'northstar.web:compiled-application-release/v2',
  bootstrap: serializeRelease(old.bootstrap),
  applications: [...old.applications.map(serializeRelease), serializeRelease({ compiled, normalizedDefinitionBytes: bytes })],
};
const { billingPlans } = parseNormalizedApplicationPackageJson(bytes);
const effectiveFrom = '2025-01-01T00:00:00.000Z';

await withOrderEntryFixture(async (f) => {
  const publish = async (action, body) => {
    const proposal = await f.create('sales_order', {
      customer_party_id: f.customer, order_date: effectiveFrom, requested_date: '2025-01-09T00:00:00.000Z',
      currency: 'CAD', billing_proposal: JSON.stringify(body), ship_to_name: 'Service desk',
      ship_to_street: '100 Industrial Way', ship_to_city: 'Calgary', ship_to_region: 'AB',
      ship_to_postal_code: 'T2P 0A1', ship_to_country: 'Canada',
    });
    const result = await f.invoke(action, { recordId: proposal.recordId, expectedRevision: proposal.revision });
    assert.equal(result.outcome, 'succeeded');
    assert.ok(result.trust);
    return result.trust.invocationId;
  };
  const rateInvocation = await publish('billing_publish', {
    schemaVersion: 'northstar.billing-rate-table/v1', version: 'legacy-rate', currency: 'CAD',
    selector: { kind: 'base' }, planDigest: compileRatePlan(billingPlans[0]).digest,
    effectiveFrom, values: { daily: '30', weekly: '100' },
  });
  const assignmentInvocation = await publish('billing_assign', {
    schemaVersion: 'northstar.billing-list-assignment/v1', customerId: f.customer,
    listId: 'standard', revision: 'legacy-assignment', priority: 1, effectiveFrom,
  });
  const tables = [
    ['billing_rate_tables', rateInvocation], ['billing_list_assignments', assignmentInvocation],
  ];
  const before = [];
  for (const [table, invocation] of tables) {
    const source = await f.pool.query('SELECT to_jsonb(b) AS row FROM platform.' + table + ' b');
    const audit = await f.pool.query('SELECT recorded_at FROM platform.trust_action_invocations WHERE invocation_id=$1', [invocation]);
    assert.equal(source.rowCount, 1);
    assert.equal(audit.rowCount, 1);
    before.push({ row: source.rows[0].row, invocation_id: invocation, published_at: audit.rows[0].recorded_at });
  }
  const admin = await f.pool.connect();
  try {
    const migrations = await loadMigrations(migrationDirectory);
    const result = await runMigrations(admin, migrations);
    assert.ok(result.applied.includes('0057_billing_publication.sql'));
    assert.ok(result.applied.some((name) => name.endsWith('_billing_publication_xid.sql')));
    const after = [];
    for (const [table] of tables) {
      const stored = await admin.query("SELECT to_jsonb(b) - ARRAY['invocation_id','published_at'] AS row, invocation_id, published_at FROM platform." + table + ' b');
      assert.equal(stored.rowCount, 1);
      after.push(stored.rows[0]);
    }
    assert.deepEqual(after, before);
  } finally {
    admin.release();
  }
}, 'demo', 0, 0, application);
console.log(JSON.stringify({ outcome: 'upgraded' }));
`;
