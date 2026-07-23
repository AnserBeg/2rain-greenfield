import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { checkUxGrammarPin } from '../../packages/dev-tooling/src/surface-runtime-seam.js';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

const requiredPaths = [
  '.agents/skills/ux-grammar/SKILL.md',
  'apps/web/src/app-server.ts',
  'apps/web/src/component-registry.ts',
  'apps/web/src/surface-contract.ts',
  'apps/web/src/surface-runtime.ts',
  'docs/greenfield-north-star-erp-platform-plan.md',
  'packages/canonical-model/src/constants.ts',
] as const;

test('ux-grammar skill is loadable and pinned to plan, canonical, and runtime vocabulary', () => {
  assert.deepEqual(checkUxGrammarPin(process.cwd()).violations, []);
});

test('an induced skill/code vocabulary mismatch fails with UX003', () => {
  const files = contractFixture();
  const skillPath = '.agents/skills/ux-grammar/SKILL.md';
  const skill = files[skillPath];
  assert.ok(skill);
  files[skillPath] = skill.replace('"task", "builder"', '"wizard", "builder"');
  assert.notEqual(files[skillPath], skill);
  const root = createArchitectureFixture(files);

  try {
    const violations = checkUxGrammarPin(root).violations;
    assert.ok(
      violations.some(
        (violation) =>
          violation.file === '.agents/skills/ux-grammar/SKILL.md' &&
          violation.ruleId === 'UX003_VOCABULARY_DRIFT' &&
          violation.message.includes('archetypes'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('an induced plan status-vocabulary mismatch fails with UX002', () => {
  const files = contractFixture();
  const planPath = 'docs/greenfield-north-star-erp-platform-plan.md';
  const plan = files[planPath];
  assert.ok(plan);
  files[planPath] = plan.replace(
    'success, attention, blocked, in progress',
    'success, warning, blocked, in progress',
  );
  assert.notEqual(files[planPath], plan);
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkUxGrammarPin(root).violations.some(
        (violation) =>
          violation.file === planPath && violation.ruleId === 'UX002_PLAN_PIN',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('an induced List-only plan slot mismatch fails with UX002', () => {
  const files = contractFixture();
  const planPath = 'docs/greenfield-north-star-erp-platform-plan.md';
  const plan = files[planPath];
  assert.ok(plan);
  files[planPath] = plan.replace(
    '| List | title, saved-view tabs,',
    '| List | heading, saved-view tabs,',
  );
  assert.notEqual(files[planPath], plan);
  assert.match(
    files[planPath],
    /\| Record \| breadcrumb; title \+ status chip;/,
  );
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkUxGrammarPin(root).violations.some(
        (violation) =>
          violation.file === planPath && violation.ruleId === 'UX002_PLAN_PIN',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('frontmatter displaced below prose fails the skill loader shape', () => {
  const files = contractFixture();
  const skillPath = '.agents/skills/ux-grammar/SKILL.md';
  const skill = files[skillPath];
  assert.ok(skill);
  files[skillPath] = `# displaced heading\n\n${skill}`;
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkUxGrammarPin(root).violations.some(
        (violation) =>
          violation.file === '.agents/skills/ux-grammar/SKILL.md' &&
          violation.ruleId === 'UX001_SKILL_SHAPE',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

function contractFixture(): Record<string, string> {
  return Object.fromEntries(
    requiredPaths.map((path) => [path, readFileSync(path, 'utf8')]),
  );
}
