import { isAbsolute, resolve } from 'node:path';

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

// Restored to the absolute-only pair after the 2026-08-21 review: resolving a
// relative title against cwd made a REAL test whose title happens to equal its
// own relative path indistinguishable from the synthetic pass, so a genuinely
// executed file could be dropped. Title text cannot carry this rule at all —
// createNodeResultLedger below decides it structurally instead.
function sameFilesystemPath(left, right) {
  if (left === right) return true;
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  return resolve(left) === resolve(right);
}

/**
 * Stateful credit over a whole event stream.
 *
 * WHY THIS EXISTS RATHER THAN A TITLE TEST. When `--test-name-pattern` selects
 * nothing in a file, Node emits a `test:summary` for that file reporting
 * `counts.tests: 0` and THEN a synthetic `test:pass` naming the file. A real
 * result always arrives BEFORE its file's summary. That ordering is the fact;
 * the title's shape is a coincidence that a real test can reproduce.
 *
 * Measured 2026-08-21 against Node's own event stream, after a title-based
 * guard was found to reject a real test named after its own path — and, before
 * that, to credit the synthetic pass whenever the command named files
 * relatively. Both defects came from asking the title a question only the
 * stream can answer.
 */
export function createNodeResultLedger() {
  const filesThatExecutedNothing = new Set();
  return {
    /** @returns {string | undefined} the creditable file path, if any */
    observe(event) {
      if (event.type === 'test:summary') {
        const { counts, file } = event.data;
        if (typeof file === 'string' && counts?.tests === 0) {
          filesThatExecutedNothing.add(resolve(file));
        }
        return undefined;
      }
      const path = creditableNodeResultPath(event);
      if (path === undefined) return undefined;
      return filesThatExecutedNothing.has(resolve(path)) ? undefined : path;
    },
  };
}
