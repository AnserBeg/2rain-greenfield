import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { checkSurfaceRuntimeSeam } from '../../packages/dev-tooling/src/surface-runtime-seam.js';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

const seamPaths = [
  '.agents/skills/ux-grammar/SKILL.md',
  'apps/web/src/app-server.ts',
  'apps/web/src/component-registry.ts',
  'apps/web/src/surface-runtime.ts',
] as const;

test('G1 browser surfaces have one compiled issued-view SurfaceRuntime seam', () => {
  assert.deepEqual(checkSurfaceRuntimeSeam(process.cwd()).violations, []);
});

test('an induced hardcoded screen outside SurfaceRuntime fails with SURF001', () => {
  const files = seamFixture();
  files['apps/web/src/hardcoded-screen.ts'] =
    "export const hardcodedScreen = '<main><section>Bypass</section></main>';";
  const root = createArchitectureFixture(files);

  try {
    const violations = checkSurfaceRuntimeSeam(root).violations;
    assert.ok(
      violations.some(
        (violation) =>
          violation.file === 'apps/web/src/hardcoded-screen.ts' &&
          violation.ruleId === 'SURF001_RUNTIME_BYPASS',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('an induced out-of-vocabulary registry entry fails with SURF002', () => {
  const files = seamFixture();
  const registryPath = 'apps/web/src/component-registry.ts';
  const registry = files[registryPath];
  assert.ok(registry);
  files[registryPath] = registry.replace(
    "    'northstar.shell:component.error_probe': renderBoundaryProbe,",
    [
      "    'northstar.shell:component.bespoke_screen': renderBoundaryProbe,",
      "    'northstar.shell:component.error_probe': renderBoundaryProbe,",
    ].join('\n'),
  );
  assert.notEqual(files[registryPath], registry);
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkSurfaceRuntimeSeam(root).violations.some(
        (violation) =>
          violation.file === registryPath &&
          violation.ruleId === 'SURF002_COMPONENT_VOCABULARY',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

function seamFixture(): Record<string, string> {
  return Object.fromEntries(
    seamPaths.map((path) => [path, readFileSync(path, 'utf8')]),
  );
}
