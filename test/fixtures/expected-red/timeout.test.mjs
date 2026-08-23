import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONTROL_SENTINEL } from './subject.mjs';

// A mutation-induced timeout. Node reports it as `test:fail` with
// `failureType: "testTimeoutFailure"` and counts it under `counts.cancelled`,
// not `counts.failed` — measured on 22.22.2. It never reached an assertion, so
// it is not an executed failure and cannot satisfy a declared kill.
test('a test that times out under the mutation', { timeout: 50 }, async () => {
  if (CONTROL_SENTINEL !== 'pristine') await sleep(10_000);
});
