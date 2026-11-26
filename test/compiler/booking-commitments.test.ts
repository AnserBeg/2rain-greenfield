import assert from 'node:assert/strict';
import test from 'node:test';
import * as customization from '../../packages/customization/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { RECORD_TEMPLATE_OPERATION_READER } from '../../packages/canonical-model/src/record-template.js';
import {
  BOOKING_CAPABILITY,
  BOOKING_OPERATION_READER,
} from '../../packages/canonical-model/src/booking.js';
import {
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  withArchivedCustomizationRuntime,
  assertArchivedTenantEnvelope,
} from '../helpers/archived-customization-runtime.js';

import { assertPinnedOperationDefinition } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  compilerInput,
  normalizedBytes,
  mustCompile,
  projectionPayload,
} from './helpers.js';

test(
  'both tenant runners reproduce the pre-booking v6 release without booking declarations',
  { skip: !process.env.CI },
  () =>
    withArchivedCustomizationRuntime(
      '47594bc60c4349d9a8b76dcdefe81503119aeaf8',
      assertArchivedTenantEnvelope,
    ),
);

function bookingSource() {
  const source = composedApplicationDefinition();
  const ops = source.operations as Record<string, unknown>[];
  const capabilityRequirements = source.capabilityRequirements as Record<
    string,
    unknown
  >[];
  const registered = ops.find(
    (op) =>
      (op.effect as { kind: string }).kind === 'registeredCapabilityEffect',
  )!;
  const owner = ops.find(
    (op) => op.operationId === 'northstar.app:operation.item_update',
  )!;
  const capability = capabilityRequirements.find((cap) =>
    (cap.declaredEffects as string[]).includes('appendFact'),
  )!;
  const effect = registered.effect as { capability: Record<string, unknown> };
  const operationId = 'northstar.app:operation.commit_time';
  const entity = 'northstar.app:entity.item';
  const queries = source.queries as {
    queryId: string;
    permission: { targetId: string };
  }[];
  const read = queries.find(
    (q) => q.queryId === (owner.readBack as { targetId: string }).targetId,
  )!.permission.targetId;
  const binding = {
    bindingVersion: 'booking.commitment/v1',
    declarationRevision: 'northstar.app:revision.unit',
    slotRevision: 'northstar.app:revision.appointment',
    slotId: 'northstar.app:slot.time',
    resourceEntity: entity,
    ownerEntity: entity,
    resourceReadPermission: read,
    ownerReadPermission: read,
    operation: 'confirm',
    kind: 'unit',
    fulfilmentMode: 'scheduled',
    maxBackdateDays: 0,
    holdSeconds: 60,
    unit: 'each',
    scale: 0,
  };
  const operation = {
    ...owner,
    operationId,
    tier: registered.tier,
    confirmation: 'humanRequired',
    precondition: {
      kind: 'booleanPredicate',
      schemaVersion: owner.schemaVersion,
      value: true,
    },
    effect: {
      ...effect,
      capability: { ...effect.capability, targetId: BOOKING_CAPABILITY },
    },
    booking: binding,
  };
  return {
    source,
    ops,
    capabilityRequirements,
    capability,
    owner,
    read,
    operation,
    operationId,
    binding,
  };
}

test('an authored booking operation compiles to the pinned gateway contract and demands its operation reader', () => {
  const {
    source,
    ops,
    capabilityRequirements,
    capability,
    owner,
    read,
    operation,
    operationId,
    binding,
  } = bookingSource();
  const input = (op: typeof operation & { permission?: unknown }) =>
    compilerInput(
      normalizedBytes({
        ...source,
        capabilityRequirements: [
          ...capabilityRequirements,
          { ...capability, capabilityId: BOOKING_CAPABILITY },
        ],
        operations: [...ops, op],
      }),
    );
  assert.equal(
    compileApplication(
      input({
        ...operation,
        permission: { ...(owner.permission as object), targetId: read },
      }),
    ).status,
    'failed',
    'booking commands require a write permission on the owner',
  );
  const compiled = mustCompile(input(operation));
  const family = PROJECTION_FAMILY_IDS.operationCatalog;
  const payload = projectionPayload<{
    operations: {
      operationId: string;
      booking?: unknown;
      inputContract?: { closedArgumentKeys: string[] };
    }[];
  }>(compiled, family);
  const declared = payload.operations.find(
    (op) => op.operationId === operationId,
  )!;
  assert.deepEqual(declared.booking, binding);
  assertPinnedOperationDefinition(declared);
  assert.ok(declared.inputContract?.closedArgumentKeys.includes('arguments'));
  const ref = compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === family,
  )!;
  assert.equal(
    ref.requiredRuntimeCapability.minimumVersion,
    BOOKING_OPERATION_READER,
  );
  assert.equal(
    compileApplication(input({ ...operation, confirmation: 'none' })).status,
    'failed',
  );
});

test('a record template binding compiles beside a booking operation at the template operation reader', () => {
  const { source, ops, capabilityRequirements, capability, operation } =
    bookingSource();
  const booked = {
    ...source,
    capabilityRequirements: [
      ...capabilityRequirements,
      { ...capability, capabilityId: BOOKING_CAPABILITY },
    ],
    operations: [...ops, operation],
  } as Record<string, unknown>;
  const changes = (base: Record<string, unknown>, list: unknown[]) => {
    const result = customization.applyCustomizationPatches(
      base,
      list.map((c) => customization.CustomizationPatchSchema.parse(c)),
    );
    assert.ok(result.status === 'applied', JSON.stringify(result));
    return result.authored as Record<string, unknown>;
  };
  const entity = 'northstar.app:entity.custom_inspection';
  const withLines = changes(booked, [
    {
      kind: 'addRecordType',
      label: 'Inspection',
      companyOwnership: 'entityOwned',
      fields: [{ label: 'Name', type: 'text', required: true }],
    },
    {
      kind: 'addLineTable',
      entity,
      label: 'Steps',
      fields: [{ label: 'Step', type: 'text' }],
    },
  ]);
  const offer = customization
    .customizationTargets(normalizeApplicationPackage(withLines))
    .templateBindings!.find((o) => o.frame.entityId === entity)!;
  const bound = changes(withLines, [
    customization.draftTemplateBinding([offer], {
      formId: offer.frame.formId,
      lifecycle: 'active',
      required: false,
      contextId: null,
      fields: offer.columns.map((c) => ({
        fieldId: c.fieldId,
        copyEligible: true,
      })),
    }),
  ]);
  // Compiled directly as a first-party package: the floor check is the subject,
  // not the tenant sandbox gate.
  const firstParty = {
    ...bound,
    package: {
      ...(bound.package as object),
      provenance: (booked.package as { provenance: unknown }).provenance,
    },
  };
  const compiled = mustCompile(compilerInput(normalizedBytes(firstParty)));
  const ref = compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.operationCatalog,
  )!;
  assert.equal(
    ref.requiredRuntimeCapability.minimumVersion,
    RECORD_TEMPLATE_OPERATION_READER,
  );
  assert.ok(
    projectionPayload<{ operations: { booking?: unknown }[] }>(
      compiled,
      PROJECTION_FAMILY_IDS.operationCatalog,
    ).operations.some((op) => op.booking),
    'the booking operation is still in the catalog',
  );
});
