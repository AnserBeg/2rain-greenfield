// The booking release and serving fixture shared by booking-serving and the
// COMPANY-CALENDAR-1 preceding-reader proof. Moved verbatim from
// test/postgres/booking-serving.test.ts.
import assert from 'node:assert/strict';
import {
  BOOKING_CAPABILITY,
  BOOKING_FULFILMENT_READER,
  BOOKING_USAGE_BINDING,
  BOOKING_USAGE_CAPABILITY,
  BOOKING_USAGE_QUERY_READER,
  parseAuthoredApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { compilerInput, normalizedBytes } from '../compiler/helpers.js';
import { authoredPath } from './customization-fixture.js';
import { startComposedApplication } from '../../apps/api/src/composition-root.js';
import { withEphemeralPostgres } from './postgres.js';
import { applicationBeforeStockCountWorkflow } from './application-before-stock-count-workflow.js';

export const item = 'northstar.app:entity.item';
export const detailQuery = 'northstar.app:query.item_get';
export const usageQuery = 'northstar.app:query.item_usage';
export const usagePermission = 'northstar.app:permission.item_usage';
export const stewardPermission = 'northstar.app:permission.item_use_steward';
export const usageField = 'northstar.app:metric.owner_usage';
export const ref = (kind: string, targetId: string) => ({
  kind,
  targetId,
  schemaVersion: 'v6',
});
export function bookingRelease(
  mode: 'operation' | 'query',
  ordinaryCorrection = false,
) {
  const source = parseAuthoredApplicationPackageJson(
    JSON.stringify(applicationBeforeStockCountWorkflow().authored),
  );
  const detail = source.queries.find((q) => q.queryId === detailQuery)!;
  assert.ok(detail.queryType === 'get');
  const read = source.permissions.find(
    (p) => p.permissionId === detail.permission.targetId,
  )!;
  const lookup = source.operations.find(
    (op) => op.operationId === 'northstar.app:operation.item_update',
  )!;
  const registered = source.operations.find(
    (op) => op.effect.kind === 'registeredCapabilityEffect',
  )!;
  const requirement = source.capabilityRequirements.find((c) =>
    c.declaredEffects.includes('appendFact'),
  )!;
  const permissions =
    mode === 'query'
      ? [{ ...read, permissionId: usagePermission }]
      : [
          {
            ...read,
            action: 'transition' as const,
            permissionId: stewardPermission,
          },
        ];
  const binding = {
    bindingVersion: 'booking.fulfilment/v1',
    declarationRevision: 'northstar.app:revision.bookable',
    slotRevision: 'northstar.app:revision.slot',
    slotId: 'northstar.app:slot.time',
    resourceEntity: item,
    ownerEntity: item,
    resourceReadPermission: read.permissionId,
    ownerReadPermission: read.permissionId,
    operation: 'correctActuals',
    kind: 'unit',
    fulfilmentMode: 'tracked',
    unit: 'each',
    scale: 0,
    maxBackdateDays: 1,
    holdSeconds: 900,
    stewardPermission,
    maxCorrectionAgeDays: 90,
  };
  const query = {
    ...detail,
    queryId: usageQuery,
    tier: 'q2',
    permission: ref('permissionReference', usagePermission),
    selections: detail.selections.map((s, i) => ({
      ...s,
      selectionId: 'northstar.app:selection.owner_usage_' + String(i),
    })),
    readModel: {
      capability: ref('capabilityReference', BOOKING_USAGE_CAPABILITY),
      binding: BOOKING_USAGE_BINDING,
      queries: { owner: ref('queryReference', detailQuery) },
      resultFields: { usage: usageField },
    },
  };
  const operation = {
    ...lookup,
    operationId: 'northstar.app:operation.correct_use',
    tier: registered.tier,
    confirmation: 'humanRequired',
    permission: ordinaryCorrection
      ? lookup.permission
      : ref('permissionReference', stewardPermission),
    precondition: {
      kind: 'booleanPredicate',
      value: true,
      schemaVersion: 'v6',
    },
    booking: binding,
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: 'v6',
      capability: ref('capabilityReference', BOOKING_CAPABILITY),
    },
  };
  const bytes = normalizedBytes({
    ...source,
    permissions: [...source.permissions, ...permissions],
    operations:
      mode === 'operation'
        ? [...source.operations, operation]
        : source.operations,
    queries: mode === 'query' ? [...source.queries, query] : source.queries,
    capabilityRequirements: [
      ...source.capabilityRequirements,
      {
        ...requirement,
        capabilityId:
          mode === 'operation' ? BOOKING_CAPABILITY : BOOKING_USAGE_CAPABILITY,
        declaredEffects: mode === 'operation' ? ['appendFact'] : ['read'],
      },
    ],
  });
  const prior = parseCompiledApplication(
    applicationBeforeStockCountWorkflow().release,
  );
  const input = compilerInput(
    bytes,
    expectedActiveReleaseFrom(prior.application.compiled),
  );
  const ack = readUnboundPermissionAcknowledgementFor(
    authoredPath,
    source.package.packageId,
  );
  const compiled = compileApplicationRelease(
    {
      ...input,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: source.languageVersion,
        normalizationProfileVersion: input.profile.normalizationProfileVersion,
      },
    },
    {
      ...ack,
      evaluatorBindings: [
        ...ack.evaluatorBindings!,
        ...permissions.map((p) => ({
          permissionId: p.permissionId,
          action: p.action,
          resource: p.resource.targetId,
        })),
      ],
    },
  );
  if (ordinaryCorrection) {
    assert.equal(compiled.status, 'failed');
    return;
  }
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.diagnostics),
  );
  assert.equal(
    compiled.bundle.releaseManifest.projections.find(
      (p) =>
        p.familyId ===
        (mode === 'operation'
          ? PROJECTION_FAMILY_IDS.operationCatalog
          : PROJECTION_FAMILY_IDS.queryCatalog),
    )?.requiredRuntimeCapability.minimumVersion,
    mode === 'operation'
      ? BOOKING_FULFILMENT_READER
      : BOOKING_USAGE_QUERY_READER,
  );
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v2',
    bootstrap: serializeRelease(prior.bootstrap),
    applications: [
      ...prior.applications.map(serializeRelease),
      serializeRelease({ compiled, normalizedDefinitionBytes: bytes }),
    ],
  };
}

// The demo seed already has a saved item. No Sales workflows are needed to serve it.
export const demoItem = '71000000-0000-4000-8000-000000000011';
export async function withBookingApplication(
  envelope: unknown,
  run: (fixture: {
    app: Awaited<ReturnType<typeof startComposedApplication>>;
    databaseUrl: string;
  }) => Promise<void>,
) {
  await withEphemeralPostgres('booking-serving', async ({ connection }) => {
    const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
    const app = await startComposedApplication({
      databaseUrl,
      port: 0,
      seedProfile: 'demo',
      tenantSlug: 'booking-serving',
      ...(envelope === undefined ? {} : { compiledApplication: envelope }),
    });
    try {
      await run({ app, databaseUrl });
    } finally {
      await app.close();
    }
  });
}
