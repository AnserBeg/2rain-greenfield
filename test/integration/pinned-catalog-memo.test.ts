import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATION_CATALOG_PAYLOAD_VERSION,
  parsePinnedOperationCatalog,
  pinnedOperationCatalogParseCount,
} from '../../packages/runtime/src/semantic-operation-gateway.js';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) frozen(entry);
    Object.freeze(value);
  }
  return value;
}

const catalog = () => ({
  kind: 'operationCatalogPayload',
  operations: [],
  schemaVersion: OPERATION_CATALOG_PAYLOAD_VERSION,
});

test('LOOP-1 memo: a frozen pinned catalog is parsed once per content, a refused one every time, an unfrozen one every time', () => {
  // A content no other test in this process parses, so the count is ours.
  const payload = frozen({ ...catalog(), operations: [] as unknown[] });
  const first = pinnedOperationCatalogParseCount();
  const parsed = parsePinnedOperationCatalog(payload);
  assert.equal(pinnedOperationCatalogParseCount(), first + 1);
  assert.equal(parsePinnedOperationCatalog(payload), parsed);
  // A request view's fresh clone of the same release: same content, no parse.
  assert.equal(parsePinnedOperationCatalog(frozen(catalog())), parsed);
  assert.equal(pinnedOperationCatalogParseCount(), first + 1);

  // Refused content is never published: it refuses, and parses, every time.
  const refused = frozen({ ...catalog(), extra: true });
  assert.throws(() => parsePinnedOperationCatalog(refused));
  assert.throws(() => parsePinnedOperationCatalog(refused));
  assert.equal(pinnedOperationCatalogParseCount(), first + 3);

  // A payload that is not frozen can still change, so it is never reused.
  const open = catalog();
  parsePinnedOperationCatalog(open);
  parsePinnedOperationCatalog(open);
  assert.equal(pinnedOperationCatalogParseCount(), first + 5);
});
