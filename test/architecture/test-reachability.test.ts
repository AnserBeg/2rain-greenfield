import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  aggregateEvidence,
  findUnreachableTests,
  type SuiteEvidence,
} from '../helpers/reachability-evidence.js';
import {
  assertUnfilteredNodeArguments,
  creditableNodeResultPath,
} from '../helpers/node-reporter-core.mjs';
import {
  getReachabilityProducer,
  reachabilityProducers,
  type ReachabilityProducer,
} from '../helpers/reachability-producers.js';
import {
  beginReachabilityRun,
  reachabilityRunIdPath,
} from '../helpers/reachability-run.mjs';
import { assertUnfilteredPlaywrightRun } from '../helpers/playwright-unfiltered-reporter.js';

const workflowPath = '.github/workflows/ci.yml';
const rootScriptCiAllowlist = {
  'check:boundaries':
    'transitively enforced by test/architecture/dependency-boundaries.test.ts',
  test: 'developer aggregate for running the CI test commands locally',
} as const;
const nodeSelectionArguments =
  /--test-(?:name-pattern|only|rerun-failures|shard|skip-pattern)(?:=|\s|$)/u;
const playwrightSelectionArguments =
  /--(?:grep|grep-invert|last-failed|only-changed|project|shard)(?:=|\s|$)/u;

test('node reporter credits only real non-skip non-todo results', () => {
  const file = resolve('test/example.test.ts');
  assert.equal(
    creditableNodeResultPath(nodeResult(file, file)),
    undefined,
    'a synthetic file-level pass must not receive credit',
  );
  assert.equal(
    creditableNodeResultPath(nodeResult('real test', file, { skip: true })),
    undefined,
  );
  assert.equal(
    creditableNodeResultPath(nodeResult('real test', file, { todo: true })),
    undefined,
  );
  assert.equal(creditableNodeResultPath(nodeResult('real test', file)), file);
});

test('filtered commands cannot produce evidence', () => {
  const producer = getReachabilityProducer('unit');
  assert.throws(
    () =>
      assertUnfilteredNodeArguments(
        [
          '--import',
          'tsx',
          '--test',
          '--test-name-pattern=only-one-test',
          '--test-reporter=./test/helpers/node-test-evidence-reporter.mjs',
          '--test-reporter-destination=test-results/reachability/unit.json',
          '--test-reporter=tap',
          '--test-reporter-destination=stdout',
        ],
        {
          suiteId: producer.id,
          workingDirectory: process.cwd(),
          reporterPath: resolve('test/helpers/node-test-evidence-reporter.mjs'),
          repositoryRoot: process.cwd(),
        },
      ),
    /Filtered or unrecognized node:test argument: --test-name-pattern/u,
  );

  const scripts = loadScripts('package.json');
  assert.ok(!reachabilityProducers.some(({ id }) => id === 'locale'));
  assert.match(scripts['test:locale'] ?? '', /--test-name-pattern/u);
  assert.doesNotMatch(
    scripts['test:locale'] ?? '',
    /node-test-evidence-reporter|REACHABILITY_SUITE_ID/u,
  );

  const unfilteredConfig = {
    grep: /.*/,
    grepInvert: null,
    projects: [{ grep: /.*/, grepInvert: null, name: '' }],
    shard: null,
  } as Parameters<typeof assertUnfilteredPlaywrightRun>[1];
  assert.throws(
    () =>
      assertUnfilteredPlaywrightRun(
        [
          'test',
          '--config',
          'apps/web/playwright.config.ts',
          '--grep=only-one-test',
        ],
        unfilteredConfig,
      ),
    /Filtered or unrecognized Playwright arguments/u,
  );
  assert.throws(
    () =>
      assertUnfilteredPlaywrightRun(
        ['test', '--config', 'apps/web/playwright.config.ts'],
        { ...unfilteredConfig, grep: /only-one-test/ },
      ),
    /Filtered Playwright configuration is not evidence-producing/u,
  );
});

test('node reachability accepts positive scheduling concurrency without accepting filters', () => {
  const producer = getReachabilityProducer('unit');
  const context = {
    suiteId: producer.id,
    workingDirectory: process.cwd(),
    reporterPath: resolve('test/helpers/node-test-evidence-reporter.mjs'),
    repositoryRoot: process.cwd(),
  };
  const argumentsWith = (...additionalArguments: string[]) => [
    '--import',
    'tsx',
    '--test',
    ...additionalArguments,
    '--test-reporter=./test/helpers/node-test-evidence-reporter.mjs',
    '--test-reporter-destination=test-results/reachability/unit.json',
    '--test-reporter=tap',
    '--test-reporter-destination=stdout',
  ];

  assert.doesNotThrow(() =>
    assertUnfilteredNodeArguments(
      argumentsWith('--test-concurrency=1'),
      context,
    ),
  );
  for (const invalid of [
    '--test-concurrency',
    '--test-concurrency=0',
    '--test-concurrency=-1',
    '--test-concurrency=all',
    '--test-concurrency=1x',
  ]) {
    assert.throws(
      () => assertUnfilteredNodeArguments(argumentsWith(invalid), context),
      new RegExp(`Filtered or unrecognized node:test argument: ${invalid}`),
    );
  }
  assert.throws(
    () =>
      assertUnfilteredNodeArguments(
        argumentsWith('--test-concurrency=1', '--test-name-pattern=x'),
        context,
      ),
    /Filtered or unrecognized node:test argument: --test-name-pattern=x/u,
  );
});

test('comparison canary reports exactly an unreachable synthetic test', () => {
  const unreachable = findUnreachableTests(
    new Set(['test/reachable.test.ts', 'test/orphan-demo/orphan.test.ts']),
    new Set(['test/reachable.test.ts']),
  );
  assert.deepEqual(unreachable, ['test/orphan-demo/orphan.test.ts']);
});

test('aggregator fails closed on incomplete or invalid evidence', () => {
  withFixtureRepository((root, producer, evidence) => {
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Missing reachability evidence for synthetic/u,
    );

    writeFileSync(resolve(root, producer.evidencePath), '');
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Empty reachability evidence for synthetic/u,
    );

    writeRawEvidence(root, producer, { ...evidence, runId: undefined });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Missing reachability run token from synthetic/u,
    );

    writeEvidence(root, producer, { ...evidence, runId: 'previous-run' });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Stale reachability evidence for synthetic: expected run fixture-run, received previous-run/u,
    );

    writeEvidence(root, producer, {
      ...evidence,
      argv: ['test/a-different-file.test.ts'],
    });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Observed argv mismatch for synthetic/u,
    );

    writeEvidence(root, producer, { ...evidence, files: [] });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Evidence producer executed zero test files: synthetic/u,
    );

    writeEvidence(root, producer, { ...evidence, suiteSucceeded: false });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Evidence producer did not succeed: synthetic/u,
    );

    writeEvidence(root, producer, {
      ...evidence,
      files: [{ path: '/outside/repository.test.ts', realResultCount: 1 }],
    });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Unnormalizable executed-file path: \/outside\/repository\.test\.ts/u,
    );

    const undiscovered = resolve(root, 'test/not-a-test.ts');
    writeFileSync(undiscovered, 'export {};\n');
    writeEvidence(root, producer, {
      ...evidence,
      files: [{ path: undiscovered, realResultCount: 1 }],
    });
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Executed file is outside repository test discovery: test\/not-a-test\.ts/u,
    );

    writeEvidence(root, producer, evidence);
    rmSync(resolve(root, reachabilityRunIdPath));
    assert.throws(
      () => aggregateEvidence(root, [producer], { environment: {} }),
      /Unresolvable reachability run token/u,
    );
  });

  const emptyRoot = mkdtempSync(join(tmpdir(), 'reachability-empty-'));
  try {
    assert.throws(
      () => aggregateEvidence(emptyRoot, [], { environment: {} }),
      /Repository test discovery returned zero files/u,
    );
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('declared unfiltered producers are wired to CI and their evidence paths', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const rootScripts = loadScripts('package.json');
  const webScripts = loadScripts('apps/web/package.json');
  assert.match(
    workflow,
    /^ {2}REACHABILITY_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/mu,
  );

  for (const producer of reachabilityProducers) {
    const job = extractWorkflowJob(workflow, producer.ciJob);
    assert.ok(
      job.includes(producer.ciInvocation),
      `${producer.id} is absent from CI job ${producer.ciJob}`,
    );
    assert.ok(
      job.includes(producer.evidencePath),
      `${producer.id} evidence path is absent from CI job ${producer.ciJob}`,
    );
    assert.match(job, /test\/helpers\/begin-reachability-run\.ts/u);

    const body = loadProducerImplementation(producer, rootScripts, webScripts);
    if (producer.runner === 'node:test') {
      if (producer.implementation.kind === 'script') {
        assert.match(
          body,
          new RegExp(`REACHABILITY_SUITE_ID=${producer.id}(?:\\s|$)`, 'u'),
        );
      } else {
        assert.match(
          body,
          new RegExp(`getReachabilityProducer\\('${producer.id}'\\)`, 'u'),
        );
        assert.match(body, /REACHABILITY_SUITE_ID:\s*producer\.id/u);
      }
      assert.match(body, /node-test-evidence-reporter\.mjs/u);
      assert.ok(
        body.includes(`${producer.id}.json`) ||
          body.includes('producer.evidencePath'),
        `${producer.id} implementation lacks its declared evidence path`,
      );
      assert.doesNotMatch(body, nodeSelectionArguments);
    } else {
      assert.doesNotMatch(body, playwrightSelectionArguments);
    }
  }
});

test('CI aggregates only after every evidence-producing job succeeds', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const job = extractWorkflowJob(workflow, 'reachability');
  for (const producerJob of new Set(
    reachabilityProducers.map(({ ciJob }) => ciJob),
  )) {
    assert.match(job, new RegExp(`^ {6}- ${producerJob}$`, 'mu'));
  }
  assert.match(job, /run: corepack pnpm check:reachability/u);
  assert.match(job, /test\/helpers\/begin-reachability-run\.ts/u);
  assert.match(job, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(job, /if:\s*always\(\)/u);
});

test('every root test/check script is CI-invoked or explicitly justified', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const scripts = loadScripts('package.json');
  const ciScripts = new Set(
    [...workflow.matchAll(/run:\s+corepack pnpm ([\w:-]+)/gu)].map(
      (match) => match[1] ?? '',
    ),
  );
  const governedScripts = Object.keys(scripts)
    .filter(
      (script) =>
        script === 'test' ||
        script.startsWith('test:') ||
        script.startsWith('check:'),
    )
    .sort();
  const scriptsOutsideCi = governedScripts
    .filter((script) => !ciScripts.has(script))
    .sort();

  assert.deepEqual(scriptsOutsideCi, Object.keys(rootScriptCiAllowlist).sort());
  for (const [script, justification] of Object.entries(rootScriptCiAllowlist)) {
    assert.ok(scripts[script], `allowlisted script is absent: ${script}`);
    assert.ok(
      justification.length > 0,
      `allowlisted script lacks a reason: ${script}`,
    );
  }
});

test('root test aggregate includes every CI-invoked test command and reachability checks', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const scripts = loadScripts('package.json');
  const ciScripts = new Set(
    [...workflow.matchAll(/run:\s+corepack pnpm ([\w:-]+)/gu)].map(
      (match) => match[1] ?? '',
    ),
  );
  const requiredAggregateScripts = [...ciScripts]
    .filter(
      (script) =>
        script.startsWith('test:') ||
        script === 'check:app-release' ||
        script === 'check:demo-release' ||
        script === 'check:language-coverage' ||
        script === 'check:reachability',
    )
    .sort();
  const aggregate = scripts.test;
  assert.ok(aggregate, 'package.json is missing the root test aggregate');

  assert.deepEqual(parseAggregateScripts(aggregate), requiredAggregateScripts);
  assert.deepEqual(
    parseAggregateScripts(
      'echo corepack pnpm test:compiler && corepack pnpm test:unit',
    ),
    ['test:unit'],
    'aggregate discovery matches whole command segments, not substrings',
  );
  // The aggregate does real work before its first suite — it mints the run
  // token, then compiles and checks two releases — and none of that was leased.
  // Its children coordinating afterwards is not the same as the aggregate
  // coordinating: one outer exclusive lease is, and the nested shared and
  // exclusive scripts already accept inherited exclusive access.
  assert.match(
    aggregate,
    /^node scripts\/run-with-test-lock\.mjs exclusive -- bash -c 'node --import tsx test\/helpers\/begin-reachability-run\.ts &&/u,
    'the aggregate must mint its run token inside one exclusive lease',
  );
  assert.match(aggregate, /test\/helpers\/run-observability-producer\.ts/u);
});

function nodeResult(
  name: string,
  file: string,
  flags: { readonly skip?: boolean; readonly todo?: boolean } = {},
) {
  return {
    type: 'test:pass' as const,
    data: {
      name,
      file,
      details: { type: 'test' },
      ...flags,
    },
  };
}

function withFixtureRepository(
  callback: (
    root: string,
    producer: ReachabilityProducer,
    evidence: SuiteEvidence,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'reachability-fixture-'));
  try {
    const testFile = resolve(root, 'test/example.test.ts');
    mkdirSync(resolve(root, 'test-results/reachability'), { recursive: true });
    mkdirSync(resolve(root, 'test'), { recursive: true });
    writeFileSync(testFile, 'export {};\n');
    const producer: ReachabilityProducer = {
      id: 'synthetic',
      runner: 'node:test',
      command: 'synthetic command',
      argv: ['test/example.test.ts'],
      ciJob: 'synthetic',
      ciInvocation: 'synthetic command',
      evidencePath: 'test-results/reachability/synthetic.json',
      implementation: {
        kind: 'helper',
        sourcePath: 'test/helpers/synthetic.ts',
      },
    };
    beginReachabilityRun({
      repositoryRoot: root,
      environment: {},
      generateRunId: () => 'fixture-run',
    });
    const evidence: SuiteEvidence = {
      version: 2,
      suiteId: producer.id,
      runId: 'fixture-run',
      argv: producer.argv,
      runner: producer.runner,
      suiteSucceeded: true,
      files: [{ path: testFile, realResultCount: 1 }],
    };
    callback(root, producer, evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRawEvidence(
  root: string,
  producer: ReachabilityProducer,
  evidence: unknown,
): void {
  writeFileSync(
    resolve(root, producer.evidencePath),
    `${JSON.stringify(evidence)}\n`,
  );
}

function writeEvidence(
  root: string,
  producer: ReachabilityProducer,
  evidence: SuiteEvidence,
): void {
  writeFileSync(
    resolve(root, producer.evidencePath),
    `${JSON.stringify(evidence)}\n`,
  );
}

function loadScripts(path: string): Readonly<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.ok(manifest.scripts, `${path} is missing scripts`);
  return manifest.scripts;
}

function loadProducerImplementation(
  producer: ReachabilityProducer,
  rootScripts: Readonly<Record<string, string>>,
  webScripts: Readonly<Record<string, string>>,
): string {
  if (producer.implementation.kind === 'helper') {
    return readFileSync(producer.implementation.sourcePath, 'utf8');
  }
  const scripts =
    producer.implementation.manifestPath === 'package.json'
      ? rootScripts
      : webScripts;
  const body = scripts[producer.implementation.script];
  assert.ok(
    body,
    `missing declared producer script: ${producer.implementation.script}`,
  );
  return body;
}

function extractWorkflowJob(workflow: string, jobName: string): string {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `CI is missing job: ${jobName}`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}\w[\w-]*:$/u.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function parseAggregateScripts(command: string): string[] {
  return command
    .split(/\s*&&\s*/u)
    .map((segment) => /^corepack pnpm ([\w:-]+)$/u.exec(segment.trim())?.[1])
    .filter((script): script is string => script !== undefined)
    .sort();
}
