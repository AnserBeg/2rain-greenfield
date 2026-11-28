import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import type { QueryResult } from 'pg';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import {
  readUnboundPermissionAcknowledgementFor,
  type UnboundPermissionAcknowledgementInput,
} from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  CanonicalIdSchema,
  parseAuthoredApplicationPackageJson,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import { billingBindingProblem } from '../../packages/compiler/src/billing.js';
import {
  BillingPlanSchema,
  BILLING_ALLOCATION_READER,
  BILLING_ARREARS_READER,
  BILLING_CALCULATION_VERSION,
  BILLING_CYCLE_CALCULATION,
  BILLING_TERMS_CAPABILITY,
  BILLING_QUOTE_CAPABILITY,
  BILLING_RULES_CALCULATION,
  BILLING_RULES_READER,
} from '../../packages/canonical-model/src/billing.js';
import { SERVICE_USE_PROTOCOL } from '../../packages/canonical-model/src/service-evidence.js';
import {
  BOOKING_CAPABILITY,
  BOOKING_USAGE_BINDING,
  BOOKING_USAGE_CAPABILITY,
} from '../../packages/canonical-model/src/booking.js';
import {
  canonicalize,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/canonicalize.js';
import {
  quoteBillingService,
  replayBillingQuote,
} from '../../packages/domain/src/billing/quote.js';
import {
  type ArchivedRunner,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-runtime-process.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import {
  compileApplicationRelease,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  expectedActiveReleaseFrom,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  compilerInput,
  normalizedBytes,
  projectionPayload,
} from '../compiler/helpers.js';
import {
  authoredPath,
  firstPartyAuthored,
  compiledApplication,
} from '../helpers/customization-fixture.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import { DECLARED_REPORT_READER } from '../../packages/canonical-model/src/declared-report.js';
import { truncateBookingInstant } from '../../packages/canonical-model/src/booking.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import {
  archivedBillingBase,
  archivedBillingReleaseBytes,
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
const precedingDeclarationReader = 'f25df5af44df132045c67ba29eb9aebe1084dcc7';
const precedingPublicationWriter = 'f1829ea9ce70a886a050e043dce23cb12267335d';
const precedingAllocationReader = '7046abc74feacc8943874f1ced6d4674ddcb7548';
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
type BillingFixtureBase = {
  authored: unknown;
  release: unknown;
  ack: UnboundPermissionAcknowledgementInput;
};
const currentBase: BillingFixtureBase = {
  authored: firstPartyAuthored,
  release: compiledApplication,
  ack: readUnboundPermissionAcknowledgementFor(
    authoredPath,
    id('package.application'),
  ),
};

async function archivedBase(run: ArchivedRunner): Promise<BillingFixtureBase> {
  return (await run(archivedBillingBase, null)) as BillingFixtureBase;
}

const meterUnit = 'northstar.app:capability.unit_copy';
const openingReading = id('field.sales_order_opening_reading');
const closingReading = id('field.sales_order_closing_reading');
const meterPlan = BillingPlanSchema.parse({
  ...plan,
  id: 'period-usage',
  serviceUnit: 'subscription',
  schedule: { kind: 'anniversary', months: 1 },
  slots: [
    { kind: 'money', id: 'rate', currency: 'CAD', scale: 2 },
    { kind: 'quantity', id: 'included', unit: meterUnit, scale: 2 },
  ],
  components: [
    {
      id: 'overage',
      kind: 'meter',
      stage: 'afterCapBeforeTax',
      taxClassification: 'untaxed',
      streamId: 'copies',
      unit: meterUnit,
      overageRate: 'rate',
      allowanceProration: 'none',
      allowanceBasis: { kind: 'perCycle', quantity: 'included' },
    },
  ],
  bindings: {
    ...plan.bindings,
    arrearsSource: {
      kind: 'periodMeter',
      unit: meterUnit,
      streamId: 'copies',
      openingReadingFieldId: openingReading,
      closingReadingFieldId: closingReading,
      openingInstantFieldId: plan.bindings!.agreedInterval!.startFieldId,
      closingInstantFieldId: plan.bindings!.agreedInterval!.endFieldId,
    },
  },
});
const usageQuery = id('query.billing_usage');
const trackedSlot = id('slot.service_equipment');
type FixtureMode =
  | 'bound'
  | 'legacy'
  | 'declaration'
  | 'arrears'
  | 'interval'
  | 'booking'
  | 'evidence'
  | 'wrongSlot';
function billingFixture(
  mode: FixtureMode,
  base: BillingFixtureBase = currentBase,
) {
  const p = parseAuthoredApplicationPackageJson(JSON.stringify(base.authored));
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
  const booking =
    mode === 'booking' || mode === 'wrongSlot' || mode === 'evidence';
  const usagePermission = id('permission.read_service_usage');
  const usage = {
    ...source,
    tier: 'q2',
    queryId: usageQuery,
    permission: ref('permissionReference', usagePermission),
    selections: source.selections.map((selection, i) => ({
      ...selection,
      selectionId: id('selection.service_usage_' + i),
    })),
    readModel: {
      capability: ref('capabilityReference', BOOKING_USAGE_CAPABILITY),
      binding: BOOKING_USAGE_BINDING,
      queries: { owner: ref('queryReference', sourceId) },
      resultFields: { usage: id('metric.service_usage') },
    },
  };
  const hold = {
    ...op,
    operationId: id('operation.hold_service'),
    readBack: ref('queryReference', sourceId),
    precondition: {
      kind: 'booleanPredicate',
      schemaVersion: 'v6',
      value: true,
    },
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: 'v6',
      capability: ref('capabilityReference', BOOKING_CAPABILITY),
    },
    booking: {
      bindingVersion: 'booking.commitment/v1',
      declarationRevision: id('revision.service'),
      slotRevision: id('revision.equipment'),
      slotId: trackedSlot,
      ownerEntity: source.sourceEntity.targetId,
      resourceEntity: source.sourceEntity.targetId,
      resourceReadPermission: sourcePermission.permissionId,
      ownerReadPermission: sourcePermission.permissionId,
      operation: 'hold',
      kind: 'unit',
      fulfilmentMode: 'tracked',
      unit: plan.serviceUnit,
      scale: 0,
      maxBackdateDays: 1,
      holdSeconds: 900,
    },
  };
  // Confirm, start and return complete a tracked hire. Start and return take
  // Booking's own decision clock whenever no effective instant is entered.
  const stewardPermission = id('permission.service_booking_steward');
  const lifecycle = (['confirm', 'start', 'return'] as const).map((verb) => ({
    ...hold,
    operationId: id(`operation.${verb}_service`),
    confirmation: 'humanRequired' as const,
    booking: {
      ...hold.booking,
      operation: verb,
      ...(verb === 'confirm'
        ? {}
        : {
            bindingVersion: 'booking.fulfilment/v1',
            stewardPermission,
            maxCorrectionAgeDays: 90,
          }),
    },
  }));
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
      queries: {
        evidence: ref('queryReference', sourceId),
      },
      resultFields: { explanation: id('metric.billing_explanation') },
    },
  };
  const permissions = [
    ...(booking
      ? [
          { ...sourcePermission, permissionId: usagePermission },
          {
            ...writePermission,
            action: 'transition' as const,
            permissionId: stewardPermission,
          },
        ]
      : []),
    { ...sourcePermission, permissionId: readPermission },
    { ...writePermission, permissionId: publishPermission },
  ];
  const b = plan.bindings!;
  const notes = p.fields.find((f) => f.fieldId === notesField)!;
  const termsSource = {
    ...source,
    selections: [
      ...source.selections,
      ...(mode === 'arrears'
        ? [openingReading, closingReading].map((field, index) => ({
            ...source.selections[0]!,
            field: ref('fieldReference', field),
            selectionId: id('selection.billing_meter_' + index),
            orderKey: 10001 + index,
          }))
        : []),
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
    billingPlans: [
      mode === 'arrears'
        ? meterPlan
        : mode === 'interval'
          ? {
              ...plan,
              bindings: { ...b, arrearsSource: { kind: 'agreedInterval' } },
            }
          : mode === 'evidence'
            ? {
                ...plan,
                bindings: {
                  ...b,
                  arrearsSource: {
                    kind: 'evidenceQuery',
                    queryId: usageQuery,
                    protocol: SERVICE_USE_PROTOCOL,
                    subjectId: trackedSlot,
                  },
                },
              }
            : booking
              ? {
                  ...plan,
                  bindings: {
                    ...b,
                    arrearsSource: {
                      kind: 'bookingActuals',
                      queryId: usageQuery,
                      slotId:
                        mode === 'wrongSlot' ? id('slot.other') : trackedSlot,
                    },
                  },
                }
              : plan,
    ],
    fields: [
      ...p.fields,
      ...(mode === 'arrears'
        ? [openingReading, closingReading].map((field, index) => ({
            ...notes,
            fieldId: field,
            label: index ? 'Closing reading' : 'Opening reading',
            orderKey: 10001 + index,
            fieldType: {
              kind: 'quantityFieldType',
              schemaVersion: 'v6',
              representation: 'canonicalString',
              precision: 20,
              scale: 2,
              baseUnit: ref('unitReference', meterUnit),
            },
          }))
        : []),
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
      ...(booking ? [usage] : []),
      quote,
    ],
    permissions: [...p.permissions, ...permissions],
    operations: [
      ...p.operations,
      ...(booking ? [hold, ...lifecycle] : []),
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
      ...(booking
        ? [
            {
              ...requirement,
              capabilityId: BOOKING_USAGE_CAPABILITY,
              declaredEffects: ['read'],
            },
            {
              ...requirement,
              capabilityId: BOOKING_CAPABILITY,
              declaredEffects: ['appendFact'],
            },
          ]
        : []),
      ...(mode === 'arrears'
        ? [
            {
              ...requirement,
              capabilityId: meterUnit,
              declaredEffects: ['read'],
            },
          ]
        : []),
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
  const old = parseCompiledApplication(base.release);
  const bytes = normalizedBytes(JSON.parse(JSON.stringify(input)));
  return {
    bytes,
    old,
    permissions,
    ack: base.ack,
    languageVersion: p.languageVersion,
  };
}

function compileBillingFixture(mode: FixtureMode, base?: BillingFixtureBase) {
  const { bytes, old, permissions, ack, languageVersion } = billingFixture(
    mode,
    base,
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
  return { compiled, bytes, old };
}

function release(mode: FixtureMode = 'bound', base?: BillingFixtureBase) {
  const { compiled, bytes, old } = compileBillingFixture(mode, base);
  if (mode === 'wrongSlot') {
    assert.ok(
      compiled.status !== 'compiled' &&
        compiled.diagnostics.some(
          (d) => d.rule === 'BILLING_EVIDENCE_SOURCE_REQUIRED',
        ),
      JSON.stringify(compiled.diagnostics),
    );
    return;
  }
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
test('period meter bindings require distinct selected boundaries, canonical units and a single stream', () => {
  const { bytes } = billingFixture('arrears');
  const pkg = parseNormalizedApplicationPackageJson(bytes);
  assert.ok(pkg.languageVersion === 'v6');
  const rate = pkg.billingPlans![0]!;
  const bindings = rate.bindings!;
  const meter = bindings.arrearsSource;
  assert.ok(meter?.kind === 'periodMeter');
  assert.equal(billingBindingProblem(pkg), undefined);
  const selected = pkg.fields.find(
    (f) => f.fieldId === meter.closingReadingFieldId,
  )!;
  const quantity = selected.fieldType;
  assert.ok(quantity.kind === 'quantityFieldType');
  for (const fieldType of [
    {
      ...quantity,
      baseUnit: {
        ...quantity.baseUnit,
        targetId: CanonicalIdSchema.parse(id('capability.other_unit')),
      },
    },
    { ...quantity, scale: 10 },
    { ...quantity, precision: 21 },
  ]) {
    assert.equal(
      billingBindingProblem({
        ...pkg,
        fields: pkg.fields.map((f) =>
          f.fieldId === selected.fieldId ? { ...f, fieldType } : f,
        ),
      }),
      'BILLING_METER_SOURCE_REQUIRED',
    );
  }
  // A meter source rates usage only: no time component, and its allowance is
  // granted per invoice cycle (BILLING-1.md finding 3).
  const [overage] = rate.components;
  assert.ok(overage?.kind === 'meter');
  for (const [reason, components] of [
    [
      'a meter source has no time component',
      [
        overage,
        {
          id: 'time',
          kind: 'time',
          stage: 'beforeMinimum',
          taxClassification: 'untaxed',
          base: 'serviceInterval',
          rates: { day: 'rate' },
          minimumScope: 'perEnrollment',
          partialTime: 'wholeStarted',
        },
      ],
    ],
    [
      'a meter source has no per-quantity fee',
      [
        overage,
        {
          id: 'seat_fee',
          kind: 'fixed',
          base: 'enrollment',
          stage: 'afterCapBeforeTax',
          taxClassification: 'untaxed',
          amount: 'included',
          perQuantity: true,
          occurrence: { kind: 'oneOff', at: 'serviceStart' },
        },
      ],
    ],
    [
      'a meter source uses a per-cycle allowance',
      [
        {
          ...overage,
          allowanceBasis: { kind: 'perPricingWindow', quantity: 'included' },
        },
      ],
    ],
  ] as const)
    assert.equal(
      billingBindingProblem({
        ...pkg,
        billingPlans: [
          {
            ...rate,
            components: components as unknown as typeof rate.components,
          },
        ],
      }),
      'BILLING_METER_SOURCE_REQUIRED',
      reason,
    );
  for (const wrong of [
    { openingReadingFieldId: meter.closingReadingFieldId },
    { closingReadingFieldId: notesField },
    { closingInstantFieldId: proposalField },
    { unit: 'other' },
    { streamId: 'other' },
  ]) {
    const declared: typeof rate = {
      ...rate,
      bindings: { ...bindings, arrearsSource: { ...meter, ...wrong } },
    };
    assert.equal(
      billingBindingProblem({ ...pkg, billingPlans: [declared] }),
      'BILLING_METER_SOURCE_REQUIRED',
    );
  }
});

test('each arrears source kind compiles at the arrears reader with the cycle calculation, and absence keeps the allocation reader', () => {
  const family = PROJECTION_FAMILY_IDS.surfaceManifest;
  const surface = (mode: FixtureMode) => {
    const { compiled } = compileBillingFixture(mode);
    assert.ok(
      compiled.status === 'compiled',
      JSON.stringify(compiled.diagnostics),
    );
    return {
      reader: compiled.bundle.releaseManifest.projections.find(
        (p) => p.familyId === family,
      )!.requiredRuntimeCapability.minimumVersion,
      calculation: projectionPayload<{ billingCalculationVersion?: string }>(
        compiled,
        family,
      ).billingCalculationVersion,
    };
  };
  // The first-party base carries its own surface floor (main's company access
  // and report readers). An unsourced plan raises it to no more than the
  // allocation reader; every arrears source raises it to the arrears reader.
  const baseFloor = surface('declaration').reader;
  assert.ok(baseFloor < BILLING_ARREARS_READER);
  assert.deepEqual(surface('bound'), {
    reader: Math.max(BILLING_ALLOCATION_READER, baseFloor),
    calculation: BILLING_CALCULATION_VERSION,
  });
  // The reader-45 Booking declaration keeps its reader and calculation
  // through the replay rule; the protocol form takes the rules reader.
  for (const mode of ['interval', 'arrears', 'booking'] as const) {
    assert.deepEqual(
      surface(mode),
      {
        reader: BILLING_ARREARS_READER,
        calculation: BILLING_CYCLE_CALCULATION,
      },
      mode,
    );
  }
  assert.deepEqual(surface('evidence'), {
    reader: BILLING_RULES_READER,
    calculation: BILLING_RULES_CALCULATION,
  });
  const pkg = parseNormalizedApplicationPackageJson(
    billingFixture('interval').bytes,
  );
  assert.ok(pkg.languageVersion === 'v6');
  const rate = pkg.billingPlans![0]!;
  assert.deepEqual(rate.bindings!.arrearsSource, { kind: 'agreedInterval' });
  assert.equal(billingBindingProblem(pkg), undefined);
  const metered: typeof rate = {
    ...rate,
    components: [
      ...rate.components,
      {
        id: 'overage',
        kind: 'meter',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        streamId: 'copies',
        unit: 'copy',
        overageRate: 'daily',
        allowanceProration: 'none',
        allowanceBasis: { kind: 'perCycle', quantity: 'daily' },
      },
    ],
  };
  assert.equal(
    billingBindingProblem({ ...pkg, billingPlans: [metered] }),
    'BILLING_SOURCE_FIELDS_REQUIRED',
  );
  assert.ok(BillingPlanSchema.safeParse(plan).success);
  for (const arrearsSource of [
    { kind: 'advance' },
    { kind: 'agreedInterval', queryId: usageQuery },
  ]) {
    assert.equal(
      BillingPlanSchema.safeParse({
        ...plan,
        bindings: { ...plan.bindings, arrearsSource },
      }).success,
      false,
      JSON.stringify(arrearsSource),
    );
  }
});

test('the plan binds its customer and currency by declared role, not by field name', () => {
  const pkg = parseNormalizedApplicationPackageJson(
    billingFixture('bound').bytes,
  );
  assert.ok(pkg.languageVersion === 'v6');
  assert.equal(billingBindingProblem(pkg), undefined);
  // A second business names the same roles differently.
  const holder = id('field.sales_order_account_holder');
  const billed = id('field.sales_order_billing_currency');
  const renamed = JSON.parse(
    JSON.stringify(pkg)
      .replaceAll(
        `"${id('field.sales_order_customer_party_id')}"`,
        `"${holder}"`,
      )
      .replaceAll(`"${id('field.sales_order_currency')}"`, `"${billed}"`),
  ) as typeof pkg;
  const rate = renamed.billingPlans![0]!;
  assert.equal(rate.bindings!.agreedInterval!.customerFieldId, holder);
  assert.equal(rate.bindings!.agreedInterval!.currencyFieldId, billed);
  assert.equal(billingBindingProblem(renamed), undefined);
  const bind = (roles: {
    customerFieldId?: string;
    currencyFieldId?: string;
  }) =>
    billingBindingProblem({
      ...renamed,
      billingPlans: [
        {
          ...rate,
          bindings: {
            ...rate.bindings!,
            agreedInterval: { ...rate.bindings!.agreedInterval!, ...roles },
          },
        },
      ],
    });
  // Optional free text cannot carry either role, a currency holds one ISO
  // code, and one field cannot carry both roles.
  for (const [reason, roles] of [
    ['optional notes cannot be the customer', { customerFieldId: notesField }],
    ['optional notes cannot be the currency', { currencyFieldId: notesField }],
    [
      'a currency holds one three-letter code',
      { customerFieldId: billed, currencyFieldId: holder },
    ],
    [
      'one field cannot carry both roles',
      { customerFieldId: billed, currencyFieldId: billed },
    ],
  ] as const)
    assert.equal(bind(roles), 'BILLING_SOURCE_FIELDS_REQUIRED', reason);
  // The refusal of notes is its optional declaration: the same selected field
  // declared required would carry the customer role.
  const declaredRequired = {
    ...renamed,
    fields: renamed.fields.map((f) =>
      f.fieldId === notesField ? { ...f, presence: 'required' as const } : f,
    ),
    billingPlans: [
      {
        ...rate,
        bindings: {
          ...rate.bindings!,
          agreedInterval: {
            ...rate.bindings!.agreedInterval!,
            customerFieldId: notesField,
          },
        },
      },
    ],
  };
  assert.equal(billingBindingProblem(declaredRequired), undefined);
});

test('a released tracked slot and its scoped usage query must agree with the billing plan', () => {
  assert.ok(release('booking'));
  release('wrongSlot');
});

test('any read model implementing the service-use protocol is an evidence source, and its provider checks the subject', () => {
  for (const mode of ['evidence', 'booking'] as const) {
    const pkg = parseNormalizedApplicationPackageJson(
      billingFixture(mode).bytes,
    );
    assert.ok(pkg.languageVersion === 'v6');
    assert.equal(billingBindingProblem(pkg), undefined, mode);
    const usage = pkg.queries.find((q) => q.queryId === usageQuery)!;
    assert.ok(usage.queryType === 'get' && usage.readModel);
    const model = usage.readModel;
    const withQuery = (change: Partial<typeof usage>) =>
      billingBindingProblem({
        ...pkg,
        queries: pkg.queries.map((q) =>
          q.queryId === usageQuery ? ({ ...usage, ...change } as typeof q) : q,
        ),
      });
    const withSlot = (change: Record<string, unknown>) =>
      billingBindingProblem({
        ...pkg,
        operations: pkg.operations.map((o) =>
          'booking' in o && o.booking
            ? ({ ...o, booking: { ...o.booking, ...change } } as typeof o)
            : o,
        ),
      });
    const refusals: [string, string | undefined][] = [
      // The declared protocol: a binding no provider implements is refused.
      [
        'the query implements the service-use protocol',
        withQuery({
          readModel: {
            ...model,
            binding: CanonicalIdSchema.parse(id('protocol.unregistered')),
          },
        }),
      ],
      [
        'the usage query is scoped to one company',
        withQuery({ legalEntityScope: undefined }),
      ],
      [
        'the usage query reads the billing owner query',
        withQuery({
          readModel: {
            ...model,
            queries: {
              owner: {
                ...model.queries.owner!,
                targetId: CanonicalIdSchema.parse(quoteId),
              },
            },
          },
        }),
      ],
      [
        'the slot owner is the billing entity',
        withSlot({ ownerEntity: id('entity.other') }),
      ],
      ['the slot is tracked', withSlot({ fulfilmentMode: 'scheduled' })],
    ];
    for (const [reason, problem] of refusals)
      assert.equal(
        problem,
        'BILLING_EVIDENCE_SOURCE_REQUIRED',
        `${mode}: ${reason}`,
      );
  }
});

test('a bound record quantity is a required exact number on the billed record', () => {
  const load = (mode: FixtureMode) => {
    const loaded = parseNormalizedApplicationPackageJson(
      billingFixture(mode).bytes,
    );
    assert.ok(loaded.languageVersion === 'v6');
    return loaded;
  };
  const pkg = load('bound');
  const source = pkg.queries.find((q) => q.queryId === sourceId)!;
  assert.ok(source.queryType === 'get');
  const notes = pkg.fields.find((f) => f.fieldId === notesField)!;
  const seats = CanonicalIdSchema.parse(id('field.sales_order_seats'));
  const withSeats = (
    fieldType: (typeof notes)['fieldType'],
    presence: 'required' | 'optional' = 'required',
    base: typeof pkg = pkg,
  ) => {
    const rate = base.billingPlans![0]!;
    return billingBindingProblem({
      ...base,
      fields: [
        ...base.fields,
        { ...notes, fieldId: seats, presence, fieldType },
      ],
      queries: base.queries.map((q) =>
        q.queryId === sourceId && q.queryType === 'get'
          ? {
              ...q,
              selections: [
                ...q.selections,
                {
                  ...q.selections[0]!,
                  field: { ...q.selections[0]!.field, targetId: seats },
                  selectionId: CanonicalIdSchema.parse(
                    id('selection.sales_order_seats'),
                  ),
                },
              ],
            }
          : q,
      ),
      billingPlans: [
        {
          ...rate,
          bindings: {
            ...rate.bindings!,
            agreedInterval: {
              ...rate.bindings!.agreedInterval!,
              quantityFieldId: seats,
            },
          },
        },
      ],
    });
  };
  const integer = {
    kind: 'integerFieldType',
    representation: 'canonicalString',
    schemaVersion: 'v6',
  } as (typeof notes)['fieldType'];
  assert.equal(withSeats(integer), undefined);
  assert.equal(
    withSeats(integer, 'optional'),
    'BILLING_SOURCE_FIELDS_REQUIRED',
    'an optional quantity cannot bind',
  );
  assert.equal(
    withSeats(notes.fieldType),
    'BILLING_SOURCE_FIELDS_REQUIRED',
    'free text cannot be a quantity',
  );
  // Only the agreed band reads the record quantity. Beside an evidence source
  // (its legs carry the quantity) or a meter (readings) it is refused.
  assert.equal(
    withSeats(integer, 'required', load('interval')),
    undefined,
    'an agreed-interval source reads the record quantity',
  );
  for (const [mode, reason] of [
    ['evidence', 'an evidence source rates its legs, not a record quantity'],
    ['arrears', 'a meter source rates readings, not a record quantity'],
  ] as const) {
    assert.equal(billingBindingProblem(load(mode)), undefined, mode);
    assert.equal(
      withSeats(integer, 'required', load(mode)),
      'BILLING_SOURCE_FIELDS_REQUIRED',
      reason,
    );
  }
});

test('the quote and terms permissions are bound by their declared role, not by name', () => {
  const pkg = parseNormalizedApplicationPackageJson(
    billingFixture('bound').bytes,
  );
  assert.ok(pkg.languageVersion === 'v6');
  assert.equal(billingBindingProblem(pkg), undefined);
  const refused =
    'Billing requires distinct registered operations and exact scoped source, terms and explanation queries under the Billing grants.';
  // Another business names both grants differently.
  const renamed = JSON.parse(
    JSON.stringify(pkg)
      .replaceAll(`"${readPermission}"`, `"${id('permission.see_charges')}"`)
      .replaceAll(`"${publishPermission}"`, `"${id('permission.set_prices')}"`),
  ) as typeof pkg;
  assert.equal(billingBindingProblem(renamed), undefined);
  const withPermission = (permissionId: string, change: object) =>
    billingBindingProblem({
      ...pkg,
      permissions: pkg.permissions.map((a) =>
        a.permissionId === permissionId ? { ...a, ...change } : a,
      ),
    });
  const source = pkg.queries.find((q) => q.queryId === sourceId)!;
  for (const [reason, problem] of [
    [
      'the quote grant is a read',
      withPermission(readPermission, { action: 'update' }),
    ],
    [
      'the quote grant reads the billed record type',
      withPermission(readPermission, {
        resource: { ...source.sourceEntity, targetId: id('entity.other') },
      }),
    ],
    [
      'the terms grant is a write',
      withPermission(publishPermission, { action: 'read' }),
    ],
    [
      'no other query reads under the quote grant',
      billingBindingProblem({
        ...pkg,
        queries: [
          ...pkg.queries,
          {
            ...source,
            queryId: CanonicalIdSchema.parse(id('query.other_reader')),
            permission: {
              ...source.permission,
              targetId: CanonicalIdSchema.parse(readPermission),
            },
          },
        ],
      }),
    ],
    [
      'no operation outside the terms writes holds the terms grant',
      billingBindingProblem({
        ...pkg,
        operations: pkg.operations.map((o) =>
          o.operationId === id('operation.sales_order_release')
            ? {
                ...o,
                permission: {
                  ...o.permission,
                  targetId: CanonicalIdSchema.parse(publishPermission),
                },
              }
            : o,
        ),
      }),
    ],
    [
      'the quote has its own grant, not the source query grant',
      billingBindingProblem({
        ...pkg,
        queries: pkg.queries.map((q) =>
          q.queryId === quoteId ? { ...q, permission: source.permission } : q,
        ),
      }),
    ],
  ] as const)
    assert.equal(problem, refused, reason);
  // Two bound plans on one record type share the grant pair: each plan's
  // quote and terms writes are inside the grants, not "another" reader.
  const rate = pkg.billingPlans![0]!;
  const bound = rate.bindings!;
  const second = (local: string) => CanonicalIdSchema.parse(id(local));
  const copied = {
    [bound.publishOperationId]: second('operation.second_publish_terms'),
    [bound.overrideOperationId]: second('operation.second_override_terms'),
    [bound.assignmentOperationId]: second('operation.second_assign_list'),
  };
  const quote = pkg.queries.find((q) => q.queryId === quoteId)!;
  assert.equal(
    billingBindingProblem({
      ...pkg,
      queries: [
        ...pkg.queries,
        { ...quote, queryId: second('query.second_billable_quote') },
      ],
      operations: [
        ...pkg.operations,
        ...pkg.operations.flatMap((o) =>
          copied[o.operationId]
            ? [{ ...o, operationId: copied[o.operationId]! }]
            : [],
        ),
      ],
      billingPlans: [
        rate,
        {
          ...rate,
          id: 'second_plan',
          bindings: {
            ...bound,
            quoteQueryId: second('query.second_billable_quote'),
            publishOperationId: copied[bound.publishOperationId]!,
            overrideOperationId: copied[bound.overrideOperationId]!,
            assignmentOperationId: copied[bound.assignmentOperationId]!,
          },
        },
      ],
    }),
    undefined,
    'two bound plans share the quote and terms grants',
  );
});

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

test('billing publication compares receipt xmin after the transaction ID wraps', async () => {
  await withEphemeralPostgres('billing-publication-xid', async ({ pool }) => {
    const admin = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
      const functionDefinition = await admin.query<{ definition: string }>(
        "SELECT pg_get_functiondef('platform.billing_publish(text,uuid,text,text)'::regprocedure) AS definition",
      );
      const cast = /r\.xmin=pg_current_xact_id\(\)((?:::[a-z0-9]+)+)/u.exec(
        functionDefinition.rows[0]!.definition,
      );
      assert.ok(
        cast,
        'publication must compare the active transaction ID to receipt xmin',
      );
      // Exercise the installed conversion with an xid8 past the first wrap.
      const converted = await admin.query(
        'SELECT ($1::xid8)' + cast[1] + '::text AS xid',
        ['4294967338'],
      );
      assert.deepEqual(converted.rows, [{ xid: '42' }]);
    } finally {
      admin.release();
    }
  });
});

test('the compiler refuses an editable notes source', () => {
  release('legacy');
});

async function probeArchivedBilling(
  run: ArchivedRunner,
  f: Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0],
) {
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
}

test('the archived serving reader refuses the declaring capacity release', async () => {
  await withArchivedCustomizationRuntime(
    precedingDeclarationReader,
    async (run) => {
      const base = await archivedBase(run);
      await withOrderEntryFixture(
        async (f) => {
          assert.deepEqual(await probeArchivedBilling(run, f), {
            outcome: 'exact',
            recordIds: [f.item],
          });
        },
        'demo',
        0,
        0,
        base.release,
      );
      await withOrderEntryFixture(
        async (f) => {
          assert.deepEqual(await probeArchivedBilling(run, f), {
            outcome: 'refused',
            code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
            message:
              'runtime capability northstar.runtime:capability.surface-manifest requires version 30 and this runtime supports 29',
          });
        },
        'demo',
        0,
        0,
        release('declaration', base),
      );
    },
  );
});

test('the preceding serving reader answers a stored query and refuses first-allocation billing by name', async () => {
  await withArchivedCustomizationRuntime(
    precedingAllocationReader,
    async (run) => {
      const base = await archivedBase(run);
      await withOrderEntryFixture(
        async (f) => {
          assert.deepEqual(await probeArchivedBilling(run, f), {
            outcome: 'exact',
            recordIds: [f.item],
          });
        },
        'demo',
        0,
        0,
        base.release,
      );
      await withOrderEntryFixture(
        async (f) => {
          assert.deepEqual(await probeArchivedBilling(run, f), {
            outcome: 'refused',
            code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
            message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${BILLING_ALLOCATION_READER} and this runtime supports 40`,
          });
        },
        'demo',
        0,
        0,
        release('bound', base),
      );
    },
  );
});

test('the billing migrations preserve rates and assignments published by the preceding runtime', async () => {
  await withArchivedCustomizationRuntime(
    precedingPublicationWriter,
    async (run) => {
      const { bytes, permissions } = billingFixture(
        'legacy',
        await archivedBase(run),
      );
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
      const propose = (body: unknown, company: string = f.scope) =>
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
        { code: 'BILLING_TERMS_INVALID' },
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
          const cloned: QueryResult = await db.query(
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

test('a period meter reviews the first earned cycle through its company-scoped gateway', async () => {
  const anchor = '2025-01-31T00:00:00.000Z';
  const end = '2025-02-28T00:00:00.000Z';
  const preceding = '1092e14d22890d172ac8e68099fdd78093898339';
  await withOrderEntryFixture(
    async (f) => {
      const version = {
        schemaVersion: 'northstar.billing-rate-table/v1',
        version: 'first',
        currency: 'CAD',
        selector: { kind: 'base' },
        planDigest: compileRatePlan(meterPlan).digest,
        effectiveFrom: anchor,
        values: { rate: '1.50', included: '10' },
      };
      const values = {
        customer_party_id: f.customer,
        currency: 'CAD',
        order_date: anchor,
        requested_date: end,
        opening_reading: '100',
        closing_reading: '115.5',
        billing_proposal: JSON.stringify(version),
        ship_to_name: 'Service desk',
        ship_to_street: 'Main',
        ship_to_city: 'Calgary',
        ship_to_region: 'AB',
        ship_to_postal_code: 'T2P 0A1',
        ship_to_country: 'Canada',
      };
      const record = await f.create('sales_order', values);
      assert.equal(
        (
          await f.invoke('billing_publish', {
            recordId: record.recordId,
            expectedRevision: record.revision,
          })
        ).outcome,
        'succeeded',
      );
      const read = (company: string, recordId = record.recordId) =>
        f.app.runtime.entry.run(
          { headers: { cookie: 'northstar-demo-actor=buyer' } },
          (v) =>
            f.app.runtime.queryGateway.invoke(v, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: quoteId,
              arguments: {
                recordId,
                [id('parameter.sales_order_get_legal_entity_scope')]: company,
              },
            }),
        );
      const result = await read(f.scope);
      assert.equal(result.outcome, 'exact');
      const review = JSON.parse(
        String(result.records[0]!.values[id('metric.billing_explanation')]),
      );
      assert.deepEqual(review.cycle, { start: anchor, end });
      assert.equal(review.quote.lines[0].differenceCents, '825');
      assert.equal(review.quote.inputs.evidence.companyId, f.scope);
      assert.equal(
        replayBillingQuote(review.quote).resultDigest,
        review.quote.resultDigest,
      );
      const other = await f.create(
        'legal_entity',
        {
          code: 'AR-B',
          name: 'Company B',
          status: id('option.legal_entity_status_active'),
          is_default: false,
        },
        {},
        false,
      );
      assert.equal((await read(other.recordId)).records.length, 0);
      const pending = await f.create('sales_order', {
        ...values,
        closing_reading: null,
      });
      const incomplete = await read(f.scope, pending.recordId);
      assert.deepEqual(
        JSON.parse(
          String(
            incomplete.records[0]!.values[id('metric.billing_explanation')],
          ),
        ),
        {
          status: 'pendingReadings',
          cycle: { start: anchor, end },
          missing: [closingReading],
        },
      );
      const recordB = await f.create(
        'sales_order',
        values,
        {},
        true,
        randomUUID(),
        other.recordId,
      );
      assert.equal(
        (
          await f.invoke('billing_publish', {
            recordId: recordB.recordId,
            expectedRevision: recordB.revision,
          })
        ).outcome,
        'succeeded',
      );
      const inB = await read(other.recordId, recordB.recordId);
      assert.equal(
        JSON.parse(
          String(inB.records[0]!.values[id('metric.billing_explanation')]),
        ).quote.inputs.evidence.companyId,
        other.recordId,
      );
      const principal = await f.app.runtime.entry.run(
        { headers: { cookie: 'northstar-demo-actor=buyer' } },
        async (v) => [v.tenantId, v.environmentId, v.principalId, f.scope],
      );
      await f.pool.query(
        'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
        principal,
      );
      assert.equal((await read(f.scope)).records[0]!.recordId, record.recordId);
      await assert.rejects(() => read(other.recordId, recordB.recordId), {
        code: 'SEMANTIC_QUERY_POLICY_DENIED',
      });
      await withArchivedCustomizationRuntime(preceding, async (run) => {
        assert.deepEqual(await probeArchivedBilling(run, f), {
          outcome: 'refused',
          code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
          message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${BILLING_ARREARS_READER} and this runtime supports ${DECLARED_REPORT_READER}`,
        });
      });
    },
    'demo',
    0,
    0,
    release('arrears'),
  );
});

type JourneyFixture = Parameters<
  Parameters<typeof withOrderEntryFixture>[0]
>[0];
const buyer = { headers: { cookie: 'northstar-demo-actor=buyer' } };
const scopeParameter = id('parameter.sales_order_get_legal_entity_scope');
// Reads the released quote query as the buyer for one company.
const readQuote = (f: JourneyFixture, company: string, recordId: string) =>
  f.app.runtime.entry.run(buyer, (v) =>
    f.app.runtime.queryGateway.invoke(v, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: quoteId,
      arguments: { recordId, [scopeParameter]: company },
    }),
  );
const explanation = (result: Awaited<ReturnType<typeof readQuote>>) =>
  JSON.parse(
    String(result.records[0]!.values[id('metric.billing_explanation')]),
  );
const serviceValues = (
  f: JourneyFixture,
  anchor: string,
  end: string,
  version: unknown,
) => ({
  customer_party_id: f.customer,
  currency: 'CAD',
  order_date: anchor,
  requested_date: end,
  billing_proposal: JSON.stringify(version),
  ship_to_name: 'Service desk',
  ship_to_street: 'Main',
  ship_to_city: 'Calgary',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T2P 0A1',
  ship_to_country: 'Canada',
});
const termsFor = (ratePlan: unknown, anchor: string) => ({
  schemaVersion: 'northstar.billing-rate-table/v1',
  version: 'first',
  currency: 'CAD',
  selector: { kind: 'base' },
  planDigest: compileRatePlan(ratePlan as typeof plan).digest,
  effectiveFrom: anchor,
  values: { daily: '30', weekly: '100' },
});
async function publishTerms(
  f: JourneyFixture,
  record: { recordId: string; revision: number },
) {
  assert.equal(
    (
      await f.invoke('billing_publish', {
        recordId: record.recordId,
        expectedRevision: record.revision,
      })
    ).outcome,
    'succeeded',
  );
}
// Company B is a second legal entity in the SAME tenant and environment.
async function assertCompanyBRefused(f: JourneyFixture, recordId: string) {
  const other = await f.create(
    'legal_entity',
    {
      code: 'AR-B',
      name: 'Company B',
      status: id('option.legal_entity_status_active'),
      is_default: false,
    },
    {},
    false,
  );
  assert.equal(
    (await readQuote(f, other.recordId, recordId)).records.length,
    0,
  );
  const principal = await f.app.runtime.entry.run(buyer, async (v) => [
    v.tenantId,
    v.environmentId,
    v.principalId,
    f.scope,
  ]);
  await f.pool.query(
    'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
    principal,
  );
  assert.equal(
    (await readQuote(f, f.scope, recordId)).records[0]!.recordId,
    recordId,
  );
  await assert.rejects(() => readQuote(f, other.recordId, recordId), {
    code: 'SEMANTIC_QUERY_POLICY_DENIED',
  });
}

test('an agreed-interval contract reviews its closed cycle through the released quote query', async () => {
  const anchor = '2025-01-01T00:00:00.000Z';
  const end = '2025-01-09T00:00:00.000Z';
  const intervalPlan = {
    ...plan,
    bindings: { ...plan.bindings!, arrearsSource: { kind: 'agreedInterval' } },
  };
  await withOrderEntryFixture(
    async (f) => {
      const record = await f.create(
        'sales_order',
        serviceValues(f, anchor, end, termsFor(intervalPlan, anchor)),
      );
      await publishTerms(f, record);
      const review = explanation(await readQuote(f, f.scope, record.recordId));
      assert.equal(review.status, 'due');
      assert.deepEqual(review.cycle, { start: anchor, end });
      assert.equal(review.quote.inputs.evidence.companyId, f.scope);
      assert.equal(review.quote.inputs.evidence.basis, 'agreed');
      assert.deepEqual(
        review.quote.lines.map(
          (l: { differenceCents: string }) => l.differenceCents,
        ),
        ['13000'],
      );
      assert.equal(
        replayBillingQuote(review.quote).resultDigest,
        review.quote.resultDigest,
      );
      await assertCompanyBRefused(f, record.recordId);
    },
    'demo',
    0,
    0,
    release('interval'),
  );
});

test('an equipment hire reviews possession Booking stamped on its production clock through the released quote query', async () => {
  const bookingPlan = {
    ...plan,
    bindings: {
      ...plan.bindings!,
      arrearsSource: {
        kind: 'bookingActuals',
        queryId: usageQuery,
        slotId: trackedSlot,
      },
    },
  };
  // The billed agreement has already ended; the equipment is still out.
  const second = (offset: number) =>
    new Date(Math.floor((Date.now() + offset) / 1000) * 1000).toISOString();
  const anchor = second(-2 * 3_600_000);
  const agreedEnd = second(-3_600_000);
  await withOrderEntryFixture(
    async (f) => {
      const values = serviceValues(
        f,
        anchor,
        agreedEnd,
        termsFor(bookingPlan, anchor),
      );
      const hire = await f.create('sales_order', values);
      await publishTerms(f, hire);
      const equipment = await f.create('sales_order', values);
      const revision = async () =>
        (
          await f.app.runtime.entry.run(buyer, (v) =>
            f.app.runtime.queryGateway.invoke(v, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: sourceId,
              arguments: { recordId: hire.recordId, [scopeParameter]: f.scope },
            }),
          )
        ).records[0]!.revision;
      const book = async (
        verb: string,
        args: Record<string, ImmutableJsonValue>,
      ) => {
        const result = await f.invoke(`${verb}_service`, {
          recordId: hire.recordId,
          expectedRevision: await revision(),
          arguments: args,
        });
        assert.equal(result.outcome, 'succeeded', verb);
        return result.capabilityResult as {
          bookingId: string;
          revision: number;
          state: string;
        };
      };
      const until = new Date(Date.now() + 2 * 86_400_000)
        .toISOString()
        .slice(0, 16);
      const held = await book('hold', {
        resourceId: equipment.recordId,
        quantity: '1',
        interval: { kind: 'now', end: until },
      });
      const step = (b: { bookingId: string; revision: number }) => ({
        bookingId: b.bookingId,
        bookingRevision: b.revision,
      });
      const confirmed = await book('confirm', step(held));
      // No effective instant is entered: Booking stamps clock_timestamp().
      const started = await book('start', step(confirmed));
      assert.equal(started.state, 'inUse');
      const live = explanation(await readQuote(f, f.scope, hire.recordId));
      assert.equal(live.status, 'notDue', 'a live hire past its end is open');
      const returned = await book('return', step(started));
      assert.equal(returned.state, 'returned');
      const stored = await f.pool.query<{ start: string; end: string }>(
        `SELECT to_jsonb(effective_start)#>>'{}' AS start, to_jsonb(effective_end)#>>'{}' AS end
           FROM platform.booking_use_revisions WHERE booking_id=$1 ORDER BY revision DESC LIMIT 1`,
        [held.bookingId],
      );
      const leg = stored.rows[0]!;
      const review = explanation(await readQuote(f, f.scope, hire.recordId));
      assert.equal(review.status, 'due', JSON.stringify(review));
      const evidence = review.quote.inputs.evidence;
      assert.deepEqual(
        evidence.bands[0].intervals.map((i: { start: string; end: string }) => [
          i.start,
          i.end,
        ]),
        [[truncateBookingInstant(leg.start), truncateBookingInstant(leg.end)]],
      );
      // Possession ran past the agreed end, so the service ends at the return.
      assert.equal(evidence.serviceEnd, truncateBookingInstant(leg.end));
      assert.deepEqual(review.cycle, {
        start: anchor,
        end: truncateBookingInstant(leg.end),
      });
      assert.equal(evidence.basis, 'actual');
      assert.equal(evidence.companyId, f.scope);
      assert.equal(
        replayBillingQuote(review.quote).resultDigest,
        review.quote.resultDigest,
      );
      await assertCompanyBRefused(f, hire.recordId);
    },
    'demo',
    0,
    0,
    release('booking'),
  );
});

test('the preceding cycle reader answers an item query on the persisted release without arrears', async () => {
  await withArchivedCustomizationRuntime(
    '1092e14d22890d172ac8e68099fdd78093898339',
    async (run) => {
      const base = await archivedBase(run);
      const application = release('bound', base)!;
      const { bytes, permissions } = billingFixture('bound', base);
      const oldDigest = await run(archivedBillingReleaseBytes, {
        definition: Buffer.from(bytes).toString('utf8'),
        permissions: permissions.map((p) => ({
          permissionId: p.permissionId,
          resource: p.resource.targetId,
          action: p.action,
        })),
      });
      assert.equal(
        canonicalizeAndHash(application.applications.at(-1)!).contentHash,
        oldDigest,
      );
      await withOrderEntryFixture(
        async (f) => {
          assert.deepEqual(await probeArchivedBilling(run, f), {
            outcome: 'exact',
            recordIds: [f.item],
          });
        },
        'demo',
        0,
        0,
        application,
      );
    },
  );
});
