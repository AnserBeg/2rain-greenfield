import assert from 'node:assert/strict';
import test from 'node:test';

import { startFixtureProcess } from '../../apps/web/test/browser/fixture-process.js';

/**
 * CI-7 item 3. The fixture child of `meta-sales.spec.ts` is started and
 * stopped through `startFixtureProcess`, whose waits are bounded and whose
 * failures carry the child's output. These cases run real child processes.
 *
 * WHAT THIS CANNOT PROVE. That the CI flake had one of these two stalls: the
 * flake was seen three times and not reproduced. It proves the next occurrence
 * fails in about two minutes, names its stage and prints the child's output,
 * instead of reading "Test timeout of 480000ms exceeded" alone.
 */
const options = (script: string, overrides = {}) => ({
  command: process.execPath,
  args: ['-e', script],
  cwd: process.cwd(),
  readyPattern: /READY=(.*)/u,
  startupMilliseconds: 5_000,
  stopMilliseconds: 5_000,
  ...overrides,
});

test('a fixture that prints its URL and exits on SIGTERM starts and stops cleanly', async () => {
  const fixture = await startFixtureProcess(
    options(
      `process.on('SIGTERM', () => { console.log('DONE'); process.exit(0); }); console.log('READY=http://127.0.0.1:1/'); setInterval(() => {}, 1000);`,
    ),
  );
  assert.equal(fixture.url, 'http://127.0.0.1:1/');
  const stopped = await fixture.stop();
  assert.equal(stopped.exited, true);
  assert.match(stopped.output, /DONE/u);
});

// The handler is installed before the URL is printed: the parent kills the
// child the moment it reads the URL, on another core.
test('a fixture that never prints its URL fails at the deadline with its output', async () => {
  const started = Date.now();
  await assert.rejects(
    startFixtureProcess(
      options(`console.log('booting'); setInterval(() => {}, 1000);`, {
        startupMilliseconds: 3_000,
      }),
    ),
    /printed no URL within 3000 ms; output so far:\nbooting/u,
  );
  assert.ok(Date.now() - started < 12_000, 'the failure was not immediate');
});

test('a fixture that exits before it is ready fails with its output', async () => {
  await assert.rejects(
    startFixtureProcess(options(`console.error('boom'); process.exit(3);`)),
    /exited before it was ready:\nboom/u,
  );
});

test('a fixture that ignores SIGTERM is reported as not exited and is killed', async () => {
  const fixture = await startFixtureProcess(
    options(
      `process.on('SIGTERM', () => {}); console.log('READY=u'); setInterval(() => {}, 1000);`,
      { stopMilliseconds: 300 },
    ),
  );
  const started = Date.now();
  const stopped = await fixture.stop();
  assert.equal(stopped.exited, false);
  assert.ok(Date.now() - started < 4_000, 'stop waited far past its deadline');
  // A second stop finds nothing left to wait for.
  assert.equal((await fixture.stop()).exited, true);
});
