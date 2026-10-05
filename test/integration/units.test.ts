import assert from 'node:assert/strict';
import test from 'node:test';
import {
  governedStorageTarget,
  governedProjection,
} from '../helpers/governed-storage-target.js';
import { parsePinnedOperationCatalog } from '../../packages/runtime/src/semantic-operation-gateway.js';

test('compiled unit setup reaches storage, policy-scoped query and ordinary mutation contracts', async () => {
  const storage = await governedStorageTarget();
  const units = storage.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.unit',
  )!;
  const conversions = storage.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.unit_conversion',
  )!;
  assert.ok(units);
  assert.ok(conversions);
  assert.equal(units.legalEntity, undefined);
  assert.equal(conversions.legalEntity?.familyClassification, 'entityOwned');
  assert.equal(
    conversions.columns.find((column) =>
      column.canonicalFieldId.endsWith('unit_conversion_denominator'),
    )?.postgresqlType,
    'numeric(38,0)',
  );
  const itemRelation = storage.relations.find(
    (relation) =>
      relation.relationId === 'northstar.app:relation.unit_conversion_item',
  )!;
  assert.equal(itemRelation.foreignKey.onDelete, 'restrict');
  assert.equal(itemRelation.foreignKey.onUpdate, 'restrict');
  const operations = parsePinnedOperationCatalog(
    (
      await governedProjection(
        'northstar.compiler:projection-family.operation-catalog',
      )
    ).payload,
  );
  const create = operations.find(
    (operation) =>
      operation.operationId ===
      'northstar.app:operation.unit_conversion_create',
  )!;
  assert.equal(create.inputContract?.systemInput?.argumentKey, 'legalEntityId');
  assert.equal(
    create.inputContract?.relationInputs.find((relation) =>
      relation.relationId.endsWith('unit_conversion_item'),
    )?.required,
    false,
  );
  const queries = (
    await governedProjection<{
      queries: Array<{
        queryId: string;
        legalEntityScope?: { cardinality: string };
        selections: Array<{ fieldId: string }>;
      }>;
    }>('northstar.compiler:projection-family.query-catalog')
  ).payload.queries;
  const list = queries.find(
    (query) => query.queryId === 'northstar.app:query.unit_conversion_list',
  )!;
  assert.equal(list.legalEntityScope?.cardinality, 'exactlyOne');
  assert.ok(
    list.selections.some(
      (selection) =>
        selection.fieldId === 'northstar.app:field.unit_conversion_numerator',
    ),
  );
});
