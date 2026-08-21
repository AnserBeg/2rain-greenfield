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
  // Under --test-name-pattern Node emits a synthetic pass whose name is the
  // file path even though no test in that file ran. It must never earn credit.
  if (sameFilesystemPath(data.name, data.file)) return undefined;
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

// Node reports `data.file` absolute and, for the synthetic pass, `data.name` as
// the path exactly as it appeared on the command line — which is normally
// RELATIVE. The earlier `isAbsolute` pair-guard returned false for that pair, so
// the synthetic pass was credited as a real result whenever the command named
// its files relatively. Measured 2026-08-21 by the expected-red gate's
// zero-matching-name-pattern control, which observed one "passing" test in a
// run that executed none. Latent for the reachability suites only because
// assertUnfilteredNodeArguments refuses --test-name-pattern outright, so they
// never reach the state that produces it.
function sameFilesystemPath(left, right) {
  if (left === right) return true;
  return resolve(left) === resolve(right);
}
