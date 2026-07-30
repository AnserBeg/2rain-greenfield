import assert from 'node:assert/strict';
import test from 'node:test';

import { platformContract } from '../../packages/canonical-model/src/index.js';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import {
  legalEntityReadScopeRequirement,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';

test('the scaffold exposes a canonical workspace contract', () => {
  assert.deepEqual(platformContract, {
    authority: 'canonical-model',
    product: 'greenfield-north-star-erp',
  });
});

test('legal-entity read scope dispatches only from compiler-owned storage metadata', () => {
  type StorageEntity = StorageTargetPayloadV1['entities'][number];
  const syntheticEntityOwned = {
    entityId: 'northstar.synthetic:entity.unrelated_fact',
    legalEntity: {
      column: 'legal_entity_id',
      familyClassification: 'entityOwned',
      immutableAfterCreate: true,
      nullable: false,
      postgresqlType: 'uuid',
      referencedFamilyId: 'legal_entity',
    },
  } as unknown as StorageEntity;
  const syntheticTenantShared = {
    entityId: 'northstar.synthetic:entity.shared_reference',
  } as unknown as StorageEntity;

  assert.deepEqual(legalEntityReadScopeRequirement(syntheticEntityOwned), {
    column: 'legal_entity_id',
    kind: 'legalEntity',
  });
  assert.equal(legalEntityReadScopeRequirement(syntheticTenantShared), null);
});
