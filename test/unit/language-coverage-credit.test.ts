import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { creditedProducerFiles } from '../helpers/language-coverage-credit.js';
import { languageCoverageProducerFileKey } from '../helpers/language-conformance-ledger.js';
import type { ReachabilityProducer } from '../helpers/reachability-producers.js';

/**
 * CI-7 item 5. `check:language-coverage` credits the files each producer
 * executed. Evidence left by another run, or written before a producer's file
 * list changed, used to surface as `Observed argv mismatch ...`, which reads
 * like a code defect. It now fails by name, names the producer and its
 * evidence file, and says how to regenerate it.
 *
 * WHAT THIS CANNOT PROVE. That the CLI wrapper prints this message and exits 1
 * (its catch block is unchanged); the staleness classification is what is
 * pinned here.
 */
const runId = 'run-current';
const currentArgv = ['test/unit/a.test.ts', 'test/unit/b.test.ts'];

function withRepository(
  evidence: Record<string, unknown> | undefined,
  check: (repositoryRoot: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'language-coverage-credit-'));
  try {
    mkdirSync(join(root, 'test/unit'), { recursive: true });
    mkdirSync(join(root, 'test-results/reachability'), { recursive: true });
    for (const name of ['a', 'b'])
      writeFileSync(join(root, `test/unit/${name}.test.ts`), '');
    if (evidence)
      writeFileSync(
        join(root, 'test-results/reachability/fake.json'),
        JSON.stringify(evidence),
      );
    check(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const producer: ReachabilityProducer = {
  id: 'fake',
  runner: 'node:test',
  command: 'corepack pnpm test:fake',
  argv: currentArgv,
  ciJob: 'quality',
  ciInvocation: 'corepack pnpm test:fake',
  evidencePath: 'test-results/reachability/fake.json',
  implementation: {
    kind: 'script',
    manifestPath: 'package.json',
    script: 'test:fake',
  },
};

function evidenceFor(
  root: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    suiteId: 'fake',
    runId,
    argv: currentArgv,
    runner: 'node:test',
    suiteSucceeded: true,
    files: currentArgv.map((path) => ({
      path: join(root, path),
      realResultCount: 1,
    })),
    ...overrides,
  };
}

test('current evidence from this run credits every executed file', () => {
  withRepository(undefined, (repositoryRoot) => {
    writeFileSync(
      join(repositoryRoot, 'test-results/reachability/fake.json'),
      JSON.stringify(evidenceFor(repositoryRoot)),
    );
    const credited = creditedProducerFiles(repositoryRoot, runId, [producer]);
    assert.deepEqual(
      [...credited].sort(),
      currentArgv
        .map((testFile) =>
          languageCoverageProducerFileKey({ suiteId: 'fake', testFile }),
        )
        .sort(),
    );
  });
});

test('a producer with no evidence file credits nothing and is not an error', () => {
  withRepository(undefined, (repositoryRoot) => {
    assert.equal(
      creditedProducerFiles(repositoryRoot, runId, [producer]).size,
      0,
    );
  });
});

test('evidence written under an older file list is stale, named, and says how to regenerate it', () => {
  withRepository(undefined, (repositoryRoot) => {
    writeFileSync(
      join(repositoryRoot, 'test-results/reachability/fake.json'),
      JSON.stringify(
        evidenceFor(repositoryRoot, { argv: ['test/unit/a.test.ts'] }),
      ),
    );
    assert.throws(
      () => creditedProducerFiles(repositoryRoot, runId, [producer]),
      (error: Error) => {
        assert.match(
          error.message,
          /^LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: fake \(test-results\/reachability\/fake\.json\)/u,
        );
        assert.match(error.message, /Do not begin a new run/u);
        assert.match(error.message, /name different files for fake/u);
        assert.match(error.message, /corepack pnpm test:fake/u);
        // The underlying comparison stays visible for the owner.
        assert.match(error.message, /Observed argv mismatch for fake/u);
        return true;
      },
    );
  });
});

test('evidence from another run is stale in the same words', () => {
  withRepository(undefined, (repositoryRoot) => {
    writeFileSync(
      join(repositoryRoot, 'test-results/reachability/fake.json'),
      JSON.stringify(evidenceFor(repositoryRoot, { runId: 'run-earlier' })),
    );
    assert.throws(
      () => creditedProducerFiles(repositoryRoot, runId, [producer]),
      /^Error: LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: fake .*\nStale reachability evidence for fake: expected run run-current, received run-earlier/u,
    );
  });
});

test('evidence that is not stale keeps its own refusals', () => {
  withRepository(undefined, (repositoryRoot) => {
    writeFileSync(
      join(repositoryRoot, 'test-results/reachability/fake.json'),
      JSON.stringify(evidenceFor(repositoryRoot, { suiteSucceeded: false })),
    );
    assert.throws(
      () => creditedProducerFiles(repositoryRoot, runId, [producer]),
      /^Error: LANGUAGE_COVERAGE_UNSUCCESSFUL_REACHABILITY_EVIDENCE: fake$/u,
    );
    writeFileSync(
      join(repositoryRoot, 'test-results/reachability/fake.json'),
      '{ not json',
    );
    assert.throws(
      () => creditedProducerFiles(repositoryRoot, runId, [producer]),
      /Invalid reachability evidence JSON for fake/u,
    );
  });
});
