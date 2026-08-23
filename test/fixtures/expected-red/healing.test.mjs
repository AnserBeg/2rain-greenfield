import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

test('a test that notices the mutation', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine');
});

// The hazard this control exists for, and it is an ordinary one: a suite that
// tidies up after itself and restores the very file under measurement before
// the runner can look at it. AGENTS.md section 6 calls this "the subject
// repaired before it is measured"; the runner's digest read-back must catch it.
after(() => {
  const pristine = spawnSync(
    'git',
    ['show', 'HEAD:test/fixtures/expected-red/subject.mjs'],
    { encoding: 'utf8' },
  );
  if (pristine.status === 0) {
    writeFileSync(
      fileURLToPath(new URL('./subject.mjs', import.meta.url)),
      pristine.stdout,
    );
  }
});
