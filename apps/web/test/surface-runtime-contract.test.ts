import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REGISTERED_SURFACE_COMPONENT_IDS,
  renderRegisteredSurfaceComponent,
  surfaceHasUnsupportedComponent,
} from '../src/component-registry.js';
import { readDemoCompiledFixture } from '../src/demo-runtime.js';
import { renderSurfaceRuntime } from '../src/surface-runtime.js';
import { readCompiledSurfaceManifest } from '../src/surface-contract.js';
import { compiledFixturePath, demoEntry, webRoot } from './helpers.js';

test('checked-in shell artifact is parse-normalized deterministic compiler output', () => {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      `${webRoot}/scripts/compile-demo-release.ts`,
      '--check',
    ],
    { cwd: `${webRoot}/../..`, stdio: 'pipe' },
  );
});

test('navigation is emitted only from the compiled surface projection', async () => {
  const fixture = readDemoCompiledFixture(compiledFixturePath);
  const projection = projectionRecord(fixture, 'surface');
  const payload = record(projection.payload);
  const compiledSurfaces = arrayOfRecords(payload.surfaces);
  const compiledLabels = compiledSurfaces.map((surface) =>
    String(surface.label),
  );

  const rendererSource = readFileSync(
    `${webRoot}/src/surface-runtime.ts`,
    'utf8',
  );
  const registrySource = readFileSync(
    `${webRoot}/src/component-registry.ts`,
    'utf8',
  );
  for (const label of compiledLabels) {
    assert.equal(rendererSource.includes(`>${label}<`), false);
    assert.equal(registrySource.includes(`>${label}<`), false);
  }

  const html = await demoEntry().run(
    {},
    (view) => renderSurfaceRuntime(view, '/').html,
  );
  const positions = compiledLabels.map((label) => html.indexOf(`>${label}<`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
  );
});

test('renderer accepts one issued view and has no ambient release access', async () => {
  const view = await demoEntry().run({}, (issued) => issued);
  const manifest = readCompiledSurfaceManifest(view);
  assert.equal(manifest.surfaces.length, 4);
  assert.throws(
    () =>
      renderSurfaceRuntime(
        { ...view } as unknown as Parameters<typeof renderSurfaceRuntime>[0],
        '/',
      ),
    /must be issued/,
  );

  for (const relativePath of [
    'src/app-server.ts',
    'src/component-registry.ts',
    'src/surface-contract.ts',
    'src/surface-runtime.ts',
  ]) {
    const source = readFileSync(`${webRoot}/${relativePath}`, 'utf8');
    assert.doesNotMatch(
      source,
      /ActiveReleasePointer|releaseRepository|global[A-Z][A-Za-z]*Release|process\.env|postgres-provider|node:fs/,
    );
  }
});

test('closed registry returns diagnostics for unknown and failing components', async () => {
  assert.equal(Object.isFrozen(REGISTERED_SURFACE_COMPONENT_IDS), true);
  assert.deepEqual(REGISTERED_SURFACE_COMPONENT_IDS, [
    'northstar.shell:component.error_probe',
    'northstar.shell:component.release_summary',
    'northstar.shell:component.setup_checklist',
  ]);

  await demoEntry().run({}, (view) => {
    const surfaces = readCompiledSurfaceManifest(view).surfaces;
    const unsupported = surfaces.find(
      (surface) => surface.label === 'Unsupported component',
    );
    const failing = surfaces.find(
      (surface) => surface.label === 'Renderer error',
    );
    assert.ok(unsupported?.slots[0]);
    assert.ok(failing?.slots[0]);
    assert.equal(surfaceHasUnsupportedComponent(unsupported), true);
    assert.equal(surfaceHasUnsupportedComponent(failing), false);
    const unsupportedResult = renderRegisteredSurfaceComponent({
      slot: unsupported.slots[0],
      surface: unsupported,
      view,
    });
    const failingResult = renderRegisteredSurfaceComponent({
      slot: failing.slots[0],
      surface: failing,
      view,
    });
    assert.equal(unsupportedResult.status, 'DIAGNOSTIC');
    assert.match(unsupportedResult.html, /UNSUPPORTED_COMPONENT/);
    assert.equal(failingResult.status, 'DIAGNOSTIC');
    assert.match(failingResult.html, /COMPONENT_RENDER_FAILED/);
  });
});

test('inherited object names cannot execute as unregistered components', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'g1-p7-registry-'));
  try {
    const fixture = JSON.parse(
      readFileSync(compiledFixturePath, 'utf8'),
    ) as Record<string, unknown>;
    const surface = projectionRecord(fixture, 'surface');
    const payload = record(surface.payload);
    const firstSurface = arrayOfRecords(payload.surfaces)[0];
    assert.ok(firstSurface);
    const firstSlot = arrayOfRecords(firstSurface.slots)[0];
    assert.ok(firstSlot);
    firstSlot.contentReferenceId = 'constructor';
    const inheritedNamePath = join(temporaryDirectory, 'inherited-name.json');
    writeFileSync(inheritedNamePath, JSON.stringify(fixture));

    await demoEntry(inheritedNamePath).run({}, (view) => {
      const result = renderSurfaceRuntime(view, '/');
      assert.equal(result.statusCode, 200);
      assert.match(result.html, /UNSUPPORTED_COMPONENT/);
      assert.doesNotMatch(result.html, /\[object Object\]/);
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('unknown surface and malformed projection fail as rendered diagnostics', async () => {
  await demoEntry().run({}, (view) => {
    const unknown = renderSurfaceRuntime(view, '/?surface=not-in-release');
    assert.equal(unknown.statusCode, 404);
    assert.match(unknown.html, /UNKNOWN_SURFACE/);
  });

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'g1-p7-surface-'));
  try {
    const fixture = JSON.parse(
      readFileSync(compiledFixturePath, 'utf8'),
    ) as Record<string, unknown>;
    const surface = projectionRecord(fixture, 'surface');
    const payload = record(surface.payload);
    payload.schemaVersion = 'northstar.surface-manifest-payload/unsupported';
    const malformedPath = join(temporaryDirectory, 'malformed.json');
    writeFileSync(malformedPath, JSON.stringify(fixture));
    await demoEntry(malformedPath).run({}, (view) => {
      const malformed = renderSurfaceRuntime(view, '/');
      assert.equal(malformed.statusCode, 422);
      assert.match(malformed.html, /INVALID_SURFACE_MANIFEST/);
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

function projectionRecord(
  fixture: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  return record(record(fixture.projections)[name]);
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
