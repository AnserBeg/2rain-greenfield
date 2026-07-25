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
      () => aggregateEvidence(root, [producer]),
      /Missing reachability evidence for synthetic/u,
    );

    writeFileSync(resolve(root, producer.evidencePath), '');
    assert.throws(
      () => aggregateEvidence(root, [producer]),
      /Empty reachability evidence for synthetic/u,
    );

    writeEvidence(root, producer, { ...evidence, files: [] });
    assert.throws(
      () => aggregateEvidence(root, [producer]),
      /Evidence producer executed zero test files: synthetic/u,
    );

    writeEvidence(root, producer, { ...evidence, suiteSucceeded: false });
    assert.throws(
      () => aggregateEvidence(root, [producer]),
      /Evidence producer did not succeed: synthetic/u,
    );

    writeEvidence(root, producer, {
      ...evidence,
      files: [{ path: '/outside/repository.test.ts', realResultCount: 1 }],
    });
    assert.throws(
      () => aggregateEvidence(root, [producer]),
      /Unnormalizable executed-file path: \/outside\/repository\.test\.ts/u,
    );

    const undiscovered = resolve(root, 'test/not-a-test.ts');
    writeFileSync(undiscovered, 'export {};\n');
    writeEvidence(root, producer, {
      ...evidence,
      files: [{ path: undiscovered, realResultCount: 1 }],
    });
    assert.throws(
      () => aggregateEvidence(root, [producer]),
      /Executed file is outside repository test discovery: test\/not-a-test\.ts/u,
    );
  });

  const emptyRoot = mkdtempSync(join(tmpdir(), 'reachability-empty-'));
  try {
    assert.throws(
      () => aggregateEvidence(emptyRoot, []),
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

    if (producer.id === 'observability') {
      assert.doesNotMatch(job, nodeSelectionArguments);
      continue;
    }
    const scriptName = producer.command.replace('corepack pnpm ', '');
    const body =
      producer.id === 'contracts'
        ? webScripts[scriptName]
        : rootScripts[scriptName];
    assert.ok(body, `missing declared producer script: ${scriptName}`);
    if (producer.runner === 'node:test') {
      assert.match(
        body,
        new RegExp(`REACHABILITY_SUITE_ID=${producer.id}`, 'u'),
      );
      assert.match(body, /node-test-evidence-reporter\.mjs/u);
      assert.match(body, new RegExp(`${producer.id}\\.json`, 'u'));
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
        script === 'check:demo-release' ||
        script === 'check:reachability',
    )
    .sort();
  const aggregate = scripts.test;
  assert.ok(aggregate, 'package.json is missing the root test aggregate');

  assert.deepEqual(parseAggregateScripts(aggregate), requiredAggregateScripts);
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
      ciJob: 'synthetic',
      ciInvocation: 'synthetic command',
      evidencePath: 'test-results/reachability/synthetic.json',
    };
    const evidence: SuiteEvidence = {
      version: 1,
      suiteId: producer.id,
      command: producer.command,
      runner: producer.runner,
      suiteSucceeded: true,
      files: [{ path: testFile, realResultCount: 1 }],
    };
    callback(root, producer, evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  return [...command.matchAll(/corepack pnpm ([\w:-]+)/gu)]
    .map((match) => match[1] ?? '')
    .sort();
}
