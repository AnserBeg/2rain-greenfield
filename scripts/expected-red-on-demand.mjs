#!/usr/bin/env node
/**
 * The on-demand expected-red controls in CI: which controls a pull request's
 * `run-controls` label reproduces, and what each control job proved.
 *
 * WHY THIS EXISTS. `check-expected-red.sh --run` applies a mutation, runs the
 * declared test (usually a PostgreSQL suite), requires the declared red and
 * restores. On the owner's laptop that waits for memory and for the shared test
 * lock, often for hours, so `.github/workflows/evidence.yml` runs it on GitHub's
 * runners instead, one control per job.
 *
 *   select   Reads the manifests from git objects, never the working tree. A
 *            `controls: a b` line in the pull request body names exactly the
 *            controls to run. Otherwise every entry the head ADDS or CHANGES
 *            against its merge base with the pull request's base runs; an entry
 *            only moved between manifests, or only re-keyed, is unchanged.
 *   outcome  Turns one control job's log into the line a packet record cites.
 *            A control counts only when the runner printed its own markers for
 *            THAT entry (MUTATION_RED, EXPECTED_RED_RESTORED and the final OK),
 *            never on the exit code alone.
 *
 * WHAT THIS DOES NOT PROVE. Selection is a convenience, not coverage: a change
 * to the code an UNCHANGED entry mutates selects nothing, and nothing here
 * decides which controls a packet owes. The evidence is the runner's, under its
 * own rules; this file chooses names and reads the runner's markers.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const USAGE = `Usage:
  expected-red-on-demand.mjs select --base <rev> [--head <rev>] [--output <file>] [--summary <file>]
      (a "controls:" line in $PR_BODY overrides the diff)
  expected-red-on-demand.mjs outcome --name <entry> --status <exit code|none> --log <file> [--sha <sha>] [--summary <file>]`;

const MANIFEST_PATH = /^test\/evidence\/[^/]+\.expected-red\.json$/u;
const ENTRY_NAME = /^[a-z][a-z0-9-]*$/u;
const OVERRIDE_LINE = /^\s*controls:(.*)$/u;
// GitHub refuses a matrix of more than 256 jobs.
const MATRIX_LIMIT = 256;
const REASON_LIMIT = 300;

class UsageError extends Error {}

function git(...argv) {
  return execFileSync('git', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitOf(revision) {
  try {
    return git(
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${revision}^{commit}`,
    ).trim();
  } catch {
    throw new UsageError(`${revision} does not name a commit`);
  }
}

/** Every manifest entry at a commit, in manifest-path then entry order. */
function entriesAt(commit) {
  const paths = git(
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    commit,
    '--',
    'test/evidence',
  )
    .split('\0')
    .filter((path) => MANIFEST_PATH.test(path))
    .sort();
  const entries = [];
  for (const path of paths) {
    let manifest;
    try {
      manifest = JSON.parse(git('show', `${commit}:${path}`));
    } catch (error) {
      throw new UsageError(
        `${path} at ${commit.slice(0, 12)} is not readable JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    for (const entry of Array.isArray(manifest?.entries)
      ? manifest.entries
      : []) {
      if (typeof entry?.name === 'string') entries.push(entry);
    }
  }
  return entries;
}

/** Key order is formatting, not meaning. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The names on the body's one `controls:` line, or undefined without one. */
function overrideFrom(body) {
  if (typeof body !== 'string') return undefined;
  const lines = body
    .split(/\r?\n/u)
    .map((line) => OVERRIDE_LINE.exec(line))
    .filter((match) => match !== null);
  if (lines.length === 0) return undefined;
  if (lines.length > 1) {
    throw new UsageError(
      `the pull request body has ${lines.length} "controls:" lines; keep exactly one`,
    );
  }
  const names = [
    ...new Set(
      (lines[0][1] ?? '')
        .replaceAll('`', ' ')
        .split(/[\s,]+/u)
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) {
    throw new UsageError('the "controls:" line names no control');
  }
  const malformed = names.filter((name) => !ENTRY_NAME.test(name));
  if (malformed.length > 0) {
    throw new UsageError(
      `the "controls:" line holds ${malformed.map((name) => JSON.stringify(name)).join(', ')}, which is not an entry name`,
    );
  }
  return names;
}

function select({ base, head = 'HEAD', body }) {
  const headCommit = commitOf(head);
  const headEntries = entriesAt(headCommit);
  const declared = new Set(headEntries.map((entry) => entry.name));

  const override = overrideFrom(body);
  if (override !== undefined) {
    const unknown = override.filter((name) => !declared.has(name));
    if (unknown.length > 0) {
      throw new UsageError(
        `the "controls:" line names ${unknown.join(', ')}, which no test/evidence manifest declares at ${headCommit.slice(0, 12)}`,
      );
    }
    return boundedByMatrix({
      source: 'override',
      head: headCommit,
      mergeBase: null,
      names: override,
      added: [],
      changed: [],
    });
  }

  if (base === undefined) {
    throw new UsageError(
      'select needs --base <rev> when the body has no "controls:" line',
    );
  }
  const baseCommit = commitOf(base);
  let mergeBase;
  try {
    mergeBase = git('merge-base', baseCommit, headCommit).trim();
  } catch {
    throw new UsageError(
      `${baseCommit.slice(0, 12)} and ${headCommit.slice(0, 12)} share no history`,
    );
  }
  const before = new Map(
    entriesAt(mergeBase).map((entry) => [entry.name, canonical(entry)]),
  );
  const added = [];
  const changed = [];
  const seen = new Set();
  for (const entry of headEntries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const previous = before.get(entry.name);
    if (previous === undefined) added.push(entry.name);
    else if (previous !== canonical(entry)) changed.push(entry.name);
  }
  const names = [...seen].filter(
    (name) => added.includes(name) || changed.includes(name),
  );
  return boundedByMatrix({
    source: 'diff',
    head: headCommit,
    mergeBase,
    names,
    added,
    changed,
  });
}

function boundedByMatrix(selection) {
  if (selection.names.length > MATRIX_LIMIT) {
    throw new UsageError(
      `${selection.names.length} controls selected; GitHub runs at most ${MATRIX_LIMIT} jobs in one matrix, so name a subset with a "controls:" line`,
    );
  }
  return selection;
}

function selectionSummary(selection) {
  const head = `\`${selection.head.slice(0, 12)}\``;
  const lines = ['### Expected-red controls', ''];
  if (selection.source === 'override') {
    lines.push(
      `Named by the pull request body's \`controls:\` line, at ${head}:`,
      '',
      ...selection.names.map((name) => `- \`${name}\``),
    );
  } else if (selection.names.length === 0) {
    lines.push(
      `No expected-red manifest entry was added or changed at ${head} since the merge base \`${String(selection.mergeBase).slice(0, 12)}\`, so no control runs.`,
      'To run existing controls, put a line `controls: <name> <name>` in the pull request body, then remove and re-add the `run-controls` label.',
    );
  } else {
    lines.push(
      `Added or changed at ${head} since the merge base \`${String(selection.mergeBase).slice(0, 12)}\`:`,
      '',
      ...selection.names.map(
        (name) =>
          `- \`${name}\` (${selection.added.includes(name) ? 'added' : 'changed'})`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** What one control job proved, read from the runner's own markers. */
function outcome({ name, status, log, sha }) {
  const text =
    log !== undefined && existsSync(log) ? readFileSync(log, 'utf8') : '';
  const subject =
    sha === undefined ? `\`${name}\`` : `\`${name}\` at ${sha.slice(0, 12)}`;
  // `name` is kebab-case, so it carries no pattern syntax.
  const marker = (pattern) => new RegExp(pattern, 'mu').exec(text);
  const killed = marker(`^MUTATION_RED ${name} (\\d+) killed$`);
  const restored = marker(`^EXPECTED_RED_RESTORED ${name} (\\d+) passing$`);
  const finished = marker(
    '^expected-red: OK \\(1 expected red\\(s\\) reproduced and restored\\)$',
  );
  if (
    status === '0' &&
    killed !== null &&
    restored !== null &&
    finished !== null
  ) {
    return {
      passed: true,
      line: `${subject}: killed with the declared reason (${killed[1]} declared kill(s) failed as declared) and restored green (${restored[1]} passing).`,
    };
  }
  let reason;
  if (status === 'none') {
    reason =
      'the control step did not finish (it timed out or was stopped); read the job log';
  } else if (status === '0') {
    reason =
      'the runner exited 0 without printing MUTATION_RED, EXPECTED_RED_RESTORED and OK for this entry, so nothing was proven';
  } else {
    reason = failureReason(text);
  }
  return {
    passed: false,
    line: `${subject}: FAILED (exit ${status}) — ${reason}`,
  };
}

/**
 * The runner prints `expected-red: FAIL` and then the assertion that stopped
 * it; a manifest problem prints a bare code and then where it is. Anything
 * else (an unknown entry, a crash) is the last line it printed.
 */
function failureReason(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines.lastIndexOf('expected-red: FAIL');
  const after = header === -1 ? [] : lines.slice(header + 1);
  let reason;
  if (after.length > 0) {
    reason = /^[A-Z][A-Z_]+$/u.test(after[0])
      ? after.slice(0, 3).join(' ')
      : after[0];
  } else {
    reason = lines.at(-1) ?? 'the runner printed nothing';
  }
  return reason.length > REASON_LIMIT
    ? `${reason.slice(0, REASON_LIMIT - 3)}...`
    : reason;
}

function annotate(level, title, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const data = message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  process.stdout.write(`::${level} title=${title}::${data}\n`);
}

function optionsFrom(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!allowed.includes(flag) || value === undefined) {
      throw new UsageError(`unexpected argument ${flag}\n${USAGE}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'select') {
    const options = optionsFrom(rest, [
      '--base',
      '--head',
      '--output',
      '--summary',
    ]);
    const selection = select({
      base: options.base,
      head: options.head,
      body: process.env.PR_BODY,
    });
    if (options.output !== undefined) {
      appendFileSync(
        options.output,
        `names=${JSON.stringify(selection.names)}\ncount=${selection.names.length}\n`,
      );
    }
    if (options.summary !== undefined) {
      appendFileSync(options.summary, selectionSummary(selection));
    }
    process.stdout.write(
      `${JSON.stringify({ ...selection, count: selection.names.length })}\n`,
    );
    if (selection.names.length === 0) {
      annotate(
        'warning',
        'expected-red selection',
        'run-controls selected no control: no manifest entry was added or changed. Name existing ones with a "controls:" line in the pull request body.',
      );
    }
    return 0;
  }
  if (command === 'outcome') {
    const options = optionsFrom(rest, [
      '--name',
      '--status',
      '--log',
      '--sha',
      '--summary',
    ]);
    if (options.name === undefined || !ENTRY_NAME.test(options.name)) {
      throw new UsageError(`outcome needs --name <entry>\n${USAGE}`);
    }
    if (
      options.status === undefined ||
      !/^(?:\d+|none)$/u.test(options.status)
    ) {
      throw new UsageError(`outcome needs --status <exit code|none>\n${USAGE}`);
    }
    const result = outcome(options);
    process.stdout.write(`${result.line}\n`);
    if (options.summary !== undefined) {
      appendFileSync(options.summary, `${result.line}\n`);
    }
    annotate(
      result.passed ? 'notice' : 'error',
      `expected-red ${options.name}`,
      result.line,
    );
    return result.passed ? 0 : 1;
  }
  throw new UsageError(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`expected-red-on-demand: ${message}\n`);
  annotate('error', 'expected-red-on-demand', message.split('\n')[0] ?? '');
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
