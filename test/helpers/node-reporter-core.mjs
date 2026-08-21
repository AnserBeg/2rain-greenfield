import { resolve } from 'node:path';

/**
 * @param {{type: string, data: {name?: unknown, file?: unknown, skip?: unknown, todo?: unknown, details?: {type?: unknown}}}} event
 * @returns {string | undefined}
 */
export function creditableNodeResultPath(event) {
  const { data } = event;
  if (event.type !== 'test:pass' && event.type !== 'test:fail')
    return undefined;
  if (data.skip || data.todo) return undefined;
  if (data.details?.type !== 'test') return undefined;
  if (typeof data.file !== 'string' || typeof data.name !== 'string') {
    return undefined;
  }
  // NOTHING HERE ASKS THE TITLE WHETHER A RESULT IS SYNTHETIC. Two successive
  // title guards each got one case wrong: comparing the pair only when both
  // paths were absolute credited Node's synthetic pass whenever a command named
  // its files relatively, and resolving relative titles against cwd then
  // discarded a REAL test named after its own path. createNodeResultLedger
  // decides it from the event stream instead.
  return data.file;
}

/**
 * @param {readonly string[]} arguments_
 * @param {{suiteId: string, workingDirectory: string, reporterPath: string, repositoryRoot: string}} context
 */
export function assertUnfilteredNodeArguments(arguments_, context) {
  const expectedReporter = resolve(context.reporterPath);
  const expectedDestination = resolve(
    context.repositoryRoot,
    `test-results/reachability/${context.suiteId}.json`,
  );
  let sawImport = false;
  let sawTest = false;
  let sawEvidenceReporter = false;
  let sawEvidenceDestination = false;
  let sawTapReporter = false;
  let sawTapDestination = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--import' && arguments_[index + 1] === 'tsx') {
      sawImport = true;
      index += 1;
      continue;
    }
    if (argument === '--test') {
      sawTest = true;
      continue;
    }
    if (/^--test-concurrency=[1-9][0-9]*$/u.test(argument ?? '')) {
      continue;
    }
    if (argument?.startsWith('--test-reporter=')) {
      const value = argument.slice('--test-reporter='.length);
      if (value === 'tap') sawTapReporter = true;
      else if (resolve(context.workingDirectory, value) === expectedReporter) {
        sawEvidenceReporter = true;
      } else {
        throw new Error(
          `Filtered or unrecognized node:test argument: ${argument}`,
        );
      }
      continue;
    }
    if (argument?.startsWith('--test-reporter-destination=')) {
      const value = argument.slice('--test-reporter-destination='.length);
      if (value === 'stdout') sawTapDestination = true;
      else if (
        resolve(context.workingDirectory, value) === expectedDestination
      ) {
        sawEvidenceDestination = true;
      } else {
        throw new Error(
          `Filtered or unrecognized node:test argument: ${argument}`,
        );
      }
      continue;
    }
    throw new Error(`Filtered or unrecognized node:test argument: ${argument}`);
  }

  if (!sawImport) throw new Error(`${context.suiteId} is missing --import tsx`);
  if (!sawTest) throw new Error(`${context.suiteId} is missing --test`);
  if (!sawEvidenceReporter) {
    throw new Error(`${context.suiteId} is missing its evidence reporter`);
  }
  if (!sawEvidenceDestination) {
    throw new Error(`${context.suiteId} is missing its evidence destination`);
  }
  if (!sawTapReporter) {
    throw new Error(`${context.suiteId} is missing its TAP reporter`);
  }
  if (!sawTapDestination) {
    throw new Error(`${context.suiteId} is missing TAP stdout`);
  }
}


/**
 * Credit decided over a WHOLE event stream, in two phases, from provenance
 * rather than from any test's title.
 *
 * Three shapes Node emits that are not executed tests, all measured against
 * Node 22.22.2 on 2026-08-21:
 *
 *  - **The synthetic pass.** A file whose `--test-name-pattern` matched nothing
 *    emits its `test:summary` with `counts.tests: 0` and THEN a `test:pass`
 *    naming the file. A real result always arrives BEFORE its file's summary.
 *  - **The file wrapper.** A file that throws at import emits a single
 *    `test:fail` named by the file's relative path, with `details.type: "test"`,
 *    `failureType: "testCodeFailure"` and the message `"test failed"` — and NO
 *    file summary at all. It is otherwise indistinguishable from a real test
 *    named after its own path, which is exactly why the title cannot decide it.
 *  - **Cancellation.** A child left pending when its parent ends is reported as
 *    `test:fail` with `failureType: "cancelledByParent"`, and Node counts it
 *    under `counts.cancelled` rather than `counts.failed`.
 *
 * So: a result is credited only when its file reported a summary and the result
 * arrived before it. `summaries()` exposes the per-file counts so a consumer can
 * reconcile what it credited against what Node counted — the check that catches
 * an omitted or invented record without reference to any name.
 */
export function createNodeResultLedger() {
  const pending = [];
  const summaries = new Map();
  let sequence = 0;
  return {
    observe(event) {
      sequence += 1;
      if (event.type === 'test:summary') {
        const { counts, file } = event.data;
        if (typeof file === 'string') {
          summaries.set(resolve(file), { counts: counts ?? {}, sequence });
        }
        return;
      }
      const path = creditableNodeResultPath(event);
      if (path === undefined) return;
      pending.push({ event, file: resolve(path), sequence });
    },
    credited() {
      return pending.filter((record) => {
        const summary = summaries.get(record.file);
        // A file that never reported a summary did not complete its run, so its
        // only result is Node's own wrapper rather than anything that executed.
        if (summary === undefined) return false;
        // A result after its file's summary is the synthetic pass.
        return record.sequence < summary.sequence;
      });
    },
    summaries() {
      return new Map(
        [...summaries].map(([file, entry]) => [file, entry.counts]),
      );
    },
  };
}
