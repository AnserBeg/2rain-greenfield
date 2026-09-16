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
  'apps/web/src/document-editor.ts',
  'apps/web/src/surface-runtime.ts',
  'apps/web/src/workspace-entry.ts',
] as const;

test('G1 browser surfaces have one compiled issued-view SurfaceRuntime seam', () => {
  assert.deepEqual(checkSurfaceRuntimeSeam(process.cwd()).violations, []);
});

test('an induced hardcoded screen outside SurfaceRuntime fails with SURF001', () => {
  const files = seamFixture();
  files['apps/web/src/hardcoded-screen.ts'] =
    "export const hardcodedScreen = () => '<html><body><header><h1>Orders</h1></header><form><button>Post</button></form></body></html>';";
  const appServerPath = 'apps/web/src/app-server.ts';
  const appServer = files[appServerPath];
  assert.ok(appServer);
  files[appServerPath] = [
    "import { hardcodedScreen } from './hardcoded-screen.js';",
    appServer.replace(
      "  if (url.pathname !== '/') {",
      [
        "  if (url.pathname === '/orders') {",
        '    response.end(hardcodedScreen());',
        '    return;',
        '  }',
        '',
        "  if (url.pathname !== '/') {",
      ].join('\n'),
    ),
  ].join('\n');
  assert.notEqual(files[appServerPath], appServer);
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

test('an induced computed registry key fails closed with SURF002', () => {
  const files = seamFixture();
  const registryPath = 'apps/web/src/component-registry.ts';
  const registry = files[registryPath];
  assert.ok(registry);
  files[registryPath] = registry
    .replace(
      'type SurfaceComponentRenderer =',
      "const bespokeComponentId = 'northstar.shell:component.bespoke_screen';\n\ntype SurfaceComponentRenderer =",
    )
    .replace(
      "    'northstar.shell:component.error_probe': renderBoundaryProbe,",
      [
        '    [bespokeComponentId]: renderBoundaryProbe,',
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

test('application-domain selection in generic SurfaceRuntime fails with SURF001', () => {
  const files = seamFixture();
  const runtimePath = 'apps/web/src/surface-runtime.ts';
  files[runtimePath] +=
    "\nconst domainBranch = ':surface.goods_receipt_detail';\n";
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkSurfaceRuntimeSeam(root).violations.some(
        (violation) =>
          violation.file === runtimePath &&
          violation.ruleId === 'SURF001_RUNTIME_BYPASS' &&
          violation.message.includes('application-domain'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('the generic document editor may consume SurfaceRuntime types only', () => {
  const files = seamFixture();
  const editorPath = 'apps/web/src/document-editor.ts';
  const editor = files[editorPath];
  assert.ok(editor);
  files[editorPath] = editor.replace(
    'import type {\n  SurfaceRuntimeGateways,',
    'import {\n  SurfaceRuntimeGateways,',
  );
  assert.notEqual(files[editorPath], editor);
  const root = createArchitectureFixture(files);

  try {
    assert.ok(
      checkSurfaceRuntimeSeam(root).violations.some(
        (violation) =>
          violation.file === editorPath &&
          violation.ruleId === 'SURF001_RUNTIME_BYPASS' &&
          violation.message.includes('issued-view app server'),
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

test('the composition interpreter cannot be called directly by the app server', () => {
  const files = seamFixture();
  files['apps/web/src/app-server.ts'] =
    "import {submitCompositionAction} from './surface-composition.js';\n" +
    files['apps/web/src/app-server.ts'];
  const root = createArchitectureFixture(files);
  try {
    assert.ok(
      checkSurfaceRuntimeSeam(root).violations.some(
        (violation) =>
          violation.ruleId === 'SURF001_RUNTIME_BYPASS' &&
          violation.message.includes('delegate'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});
