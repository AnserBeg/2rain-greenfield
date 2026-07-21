import assert from 'node:assert/strict';
import test from 'node:test';

import { platformContract } from '../../packages/canonical-model/src/index.js';

test('the scaffold exposes a canonical workspace contract', () => {
  assert.deepEqual(platformContract, {
    authority: 'canonical-model',
    product: 'greenfield-north-star-erp',
  });
});
