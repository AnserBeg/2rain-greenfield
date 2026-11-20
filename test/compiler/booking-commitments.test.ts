import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOKING_CAPABILITY,
  BOOKING_OPERATION_READER,
} from '../../packages/canonical-model/src/booking.js';
import {
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { assertPinnedOperationDefinition } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  compilerInput,
  normalizedBytes,
  mustCompile,
  projectionPayload,
} from './helpers.js';

test('an authored booking operation compiles to the pinned gateway contract and demands its operation reader', () => {
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
  const input = (op: typeof operation) =>
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
