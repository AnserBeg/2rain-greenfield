import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const scannerDigest =
  'sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
const syntheticRuleId = 'north-star-synthetic-test-secret';

test('CI runs dependency and secret gates and always retains their evidence', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /^ {2}security:$/mu);
  assert.ok(workflow.includes('.github/scripts/run-security-scans.sh'));
  assert.ok(workflow.includes('SECURITY_EVIDENCE_DIR'));
  assert.ok(workflow.includes('name: security-evidence-${{ github.sha }}'));
  assert.ok(workflow.includes('path: test-results/security/'));
  assert.match(
    workflow,
    /- name: Retain security evidence\n {8}if: always\(\)/u,
  );
});

test('scan runner pins the scanner and exercises a real negative Git fixture', () => {
  const runnerPath = '.github/scripts/run-security-scans.sh';
  const runner = readFileSync(runnerPath, 'utf8');
  const config = readFileSync('.github/security/gitleaks.toml', 'utf8');

  assert.notEqual(statSync(runnerPath).mode & 0o111, 0);
  assert.ok(runner.includes(`@${scannerDigest}`));
  assert.ok(runner.includes('corepack pnpm audit --audit-level=high --json'));
  assert.ok(runner.includes('git -C "$negative_fixture" commit'));
  assert.ok(runner.includes('negative_status -ne 1'));
  assert.ok(runner.includes('dependency_status -ne 0'));
  assert.ok(runner.includes('clean_status -ne 0'));
  assert.ok(runner.includes(syntheticRuleId));
  assert.ok(config.includes(`id = "${syntheticRuleId}"`));
  assert.ok(config.includes('useDefault = true'));
});
