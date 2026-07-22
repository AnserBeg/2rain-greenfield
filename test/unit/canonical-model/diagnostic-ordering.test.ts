import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  diagnostic,
} from '../../../packages/canonical-model/src/diagnostics.js';

test('diagnostic ordering uses structural coordinates and never prose', () => {
  const first = new CanonicalModelError([
    diagnostic(
      'CANON_SCHEMA_INVALID',
      '$.fields[0]',
      'copy beginning with a sorts first under the old defect',
      'alternative beginning with a',
      'northstar.example:field.name',
      'schemaCheck',
      1,
    ),
    diagnostic(
      'CANON_SCHEMA_INVALID',
      '$.fields[0]',
      'copy beginning with z sorts last under the old defect',
      'alternative beginning with z',
      'northstar.example:field.name',
      'schemaCheck',
      0,
    ),
  ]);

  const second = new CanonicalModelError([
    diagnostic(
      'CANON_SCHEMA_INVALID',
      '$.fields[0]',
      'completely different prose',
      'completely different alternative',
      'northstar.example:field.name',
      'schemaCheck',
      1,
    ),
    diagnostic(
      'CANON_SCHEMA_INVALID',
      '$.fields[0]',
      'another copy edit',
      'another alternative',
      'northstar.example:field.name',
      'schemaCheck',
      0,
    ),
  ]);

  assert.deepEqual(
    first.diagnostics.map((entry) => entry.occurrenceIndex),
    [0, 1],
  );
  assert.deepEqual(
    second.diagnostics.map((entry) => entry.occurrenceIndex),
    [0, 1],
  );
  assert.deepEqual(
    first.diagnostics.map(
      ({ code, objectId, occurrenceIndex, path, phase }) => ({
        code,
        objectId,
        occurrenceIndex,
        path,
        phase,
      }),
    ),
    second.diagnostics.map(
      ({ code, objectId, occurrenceIndex, path, phase }) => ({
        code,
        objectId,
        occurrenceIndex,
        path,
        phase,
      }),
    ),
  );
});
