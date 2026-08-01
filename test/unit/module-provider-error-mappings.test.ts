import assert from 'node:assert/strict';
import test from 'node:test';
import { format } from 'node:util';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import {
  ModuleRuntimeInterpreterError,
  translateModuleProviderError,
  type ModuleProviderErrorMapping,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';

const entityId = 'northstar.control:entity.subject';
const storage = {
  entities: [
    {
      entityId,
      indexes: [],
      physicalTableName: 'nsm_t_control_subject',
      uniqueKeys: [],
    },
  ],
  relations: [],
} as unknown as StorageTargetPayloadV1;

test('a second module can register a typed mapping for the same SQLSTATE', () => {
  const secondModuleMapping = Object.freeze({
    providerMessage: 'PARTY_REFERENCE_IMMUTABLE',
    sqlstate: 'P0001',
    translate(input) {
      const match = /^partyId=(\S+)$/u.exec(input.detail ?? '');
      if (!match?.[1]) return null;
      return Object.freeze({
        code: 'PARTY_REFERENCE_IMMUTABLE',
        details: Object.freeze({ partyId: match[1] }),
        message: 'party reference cannot change',
        subjectId: input.subjectId,
      });
    },
  } satisfies ModuleProviderErrorMapping);

  const translated = translateModuleProviderError(
    {
      code: 'P0001',
      detail: 'partyId=party-control-17',
      message: 'PARTY_REFERENCE_IMMUTABLE',
    },
    storage,
    entityId,
    [...INVENTORY_PROVIDER_ERROR_MAPPINGS, secondModuleMapping],
  );

  assert.equal(translated.code, 'PARTY_REFERENCE_IMMUTABLE');
  assert.equal(translated.subjectId, entityId);
  assert.deepEqual(translated.details, { partyId: 'party-control-17' });
  assert.equal(translated.providerMetadata, null);
});

test('an unregistered provider failure keeps only exact schema metadata', () => {
  const rowValue = 'Customer Rowan / account 8472';
  const parameterValue = 'private-parameter-9921';
  const translated = translateModuleProviderError(
    {
      code: 'P7701',
      column: 'nsm_c_control_column',
      constraint: 'nsm_k_control_constraint',
      detail: `Key (customer_name)=(${rowValue}) was rejected`,
      message: `provider rejected row ${rowValue}`,
      parameters: [parameterValue],
      query: `UPDATE control SET value = '${parameterValue}'`,
      table: 'nsm_t_control_relation',
    },
    storage,
    entityId,
    INVENTORY_PROVIDER_ERROR_MAPPINGS,
  );

  assert.ok(translated instanceof ModuleRuntimeInterpreterError);
  assert.equal(translated.code, 'MODULE_PROVIDER_FAILURE');
  assert.equal(translated.subjectId, entityId);
  assert.equal(
    translated.message,
    'module provider rejected the operation (sqlstate=P7701 relation=nsm_t_control_relation constraint=nsm_k_control_constraint column=nsm_c_control_column)',
  );
  assert.deepEqual(translated.details, {});
  assert.deepEqual(translated.providerMetadata, {
    columnName: 'nsm_c_control_column',
    constraintName: 'nsm_k_control_constraint',
    relationName: 'nsm_t_control_relation',
    sqlstate: 'P7701',
  });
  assert.equal(Object.hasOwn(translated, 'cause'), false);
  const renderedError = [
    translated.message,
    JSON.stringify(translated),
    format('%o', translated),
  ].join('\n');
  assert.doesNotMatch(renderedError, /Customer Rowan|account 8472/u);
  assert.doesNotMatch(renderedError, /private-parameter-9921/u);
  assert.doesNotMatch(renderedError, /customer_name/u);
  assert.doesNotMatch(renderedError, /UPDATE control/u);
});
