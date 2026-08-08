import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { STATUS_ROLES } from '@north-star/canonical-model';

import * as listBehavior from '../../../packages/runtime/src/list-behavior/index.js';
import * as resolveByName from '../../../packages/runtime/src/resolve-by-name.js';
import * as operationGateway from '../../../packages/runtime/src/semantic-operation-gateway.js';
import * as queryGateway from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  MAPPED_OPERATION_ERROR_NAMES,
  MAPPED_QUERY_ERROR_NAMES,
} from '../src/gateway-error-codes.js';
import {
  MESSAGE_PLACEMENTS,
  OPERATION_DIAGNOSTIC_CODES,
  QUERY_DIAGNOSTIC_CODES,
  REFUSED_MESSAGE_PLACEMENTS,
  SURFACE_MESSAGE_CATALOG,
  SURFACE_MESSAGE_CODES,
  messageStatusRole,
} from '../src/message-catalog.js';
import {
  REGISTERED_SURFACE_COMPONENT_IDS,
  SURFACE_SLOT_RESOLUTION_STATES,
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
  assert.deepEqual(SURFACE_SLOT_RESOLUTION_STATES, [
    'pending',
    'ready',
    'empty',
    'failed',
  ]);
  assert.equal(Object.isFrozen(SURFACE_SLOT_RESOLUTION_STATES), true);
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
    assert.equal(unsupportedResult.state, 'failed');
    assert.match(unsupportedResult.html, /data-slot-state="failed"/);
    assert.match(unsupportedResult.html, /UNSUPPORTED_COMPONENT/);
    assert.equal(failingResult.state, 'failed');
    assert.match(failingResult.html, /data-slot-state="failed"/);
    assert.match(failingResult.html, /COMPONENT_RENDER_FAILED/);
  });
});

test('unbound slots authorize no default loading treatment', async () => {
  await demoEntry().run({}, (view) => {
    const exemplar = readCompiledSurfaceManifest(view).surfaces[0];
    assert.ok(exemplar?.slots[0]);
    const dataGrid = {
      ...exemplar.slots[0],
      slot: 'dataGrid',
    };
    const surface = {
      ...exemplar,
      archetype: 'list' as const,
      slots: [dataGrid],
      surfaceRole: 'list' as const,
    };
    const result = renderRegisteredSurfaceComponent({
      data: { status: 'UNBOUND' },
      slot: dataGrid,
      surface,
      view,
    });
    assert.equal(result.state, 'pending');
    assert.match(result.html, /data-slot-state="pending"/);
    assert.doesNotMatch(result.html, /spinner|skeleton|loading/i);

    const titleStatus = {
      ...exemplar.slots[0],
      slot: 'titleStatus',
    };
    const recordSurface = {
      ...exemplar,
      archetype: 'record' as const,
      slots: [titleStatus],
      statusRoles: [],
      surfaceRole: 'record' as const,
    };
    const titleResult = renderRegisteredSurfaceComponent({
      data: { status: 'UNBOUND' },
      slot: titleStatus,
      surface: recordSurface,
      view,
    });
    assert.equal(titleResult.state, 'ready');
    assert.match(titleResult.html, /data-slot-state="ready"/);
    assert.doesNotMatch(titleResult.html, /spinner|skeleton|loading/i);
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

/**
 * ADR-0048 §§2-4. Every claim the catalog makes about itself, asserted rather
 * than commented.
 */
test('the message catalog honours the vocabulary it declares', () => {
  assert.equal(Object.isFrozen(SURFACE_MESSAGE_CATALOG), true);
  assert.equal(SURFACE_MESSAGE_CODES.length, 27);

  for (const code of SURFACE_MESSAGE_CODES) {
    const entry = SURFACE_MESSAGE_CATALOG[code];
    const where = `${code}: `;
    assert.ok(entry.sentence.length > 0, `${where}empty sentence`);
    assert.ok(entry.detail.length > 0, `${where}empty detail`);

    // A sentence is a headline, not a paragraph, and never a template.
    assert.doesNotMatch(
      entry.sentence,
      /[.]$/u,
      `${where}sentence ends in a period`,
    );
    for (const field of [
      entry.sentence,
      entry.detail,
      entry.nextAction ?? '',
    ]) {
      assert.doesNotMatch(field, /\$\{|%s|\{\d?\}/u, `${where}template hole`);
    }

    // §3: colour resolves through the pinned roles and adds no hue.
    assert.ok(
      (STATUS_ROLES as readonly string[]).includes(messageStatusRole(code)),
      `${where}status role is outside the pinned vocabulary`,
    );

    // §4: admissible placements, and the two refused spellings never appear.
    assert.ok(entry.placements.length > 0, `${where}no admissible placement`);
    for (const placement of entry.placements) {
      assert.ok(
        (MESSAGE_PLACEMENTS as readonly string[]).includes(placement),
        `${where}unknown placement ${placement}`,
      );
      assert.equal(
        (REFUSED_MESSAGE_PLACEMENTS as readonly string[]).includes(placement),
        false,
        `${where}refused placement ${placement}`,
      );
    }

    // An advisory message claims the user can act now, so it owes an action.
    // The converse does not hold: a blocking message may still offer one.
    if (entry.consequence === 'advisory') {
      assert.notEqual(
        entry.nextAction,
        null,
        `${where}advisory with no action`,
      );
    }
  }

  for (const code of QUERY_DIAGNOSTIC_CODES) {
    assert.ok(SURFACE_MESSAGE_CATALOG[code].placements.includes('slot'));
  }
  for (const code of OPERATION_DIAGNOSTIC_CODES) {
    assert.ok(SURFACE_MESSAGE_CATALOG[code].placements.includes('page'));
  }
});

/**
 * The structural companion ADR-0048 §5 asks for, in the shape this file already
 * uses for compiled navigation labels at the top: a sentence that reached the
 * user must have come from the catalog, so no other source file may contain one.
 *
 * This is a **source scan, and therefore a proxy** — it observes that the string
 * is not written elsewhere, not that the renderer read it from here. The browser
 * gate observes the latter. Neither is sufficient alone: the scan cannot see a
 * sentence composed at runtime, and the browser gate cannot see a hardcoded
 * sentence on a path no fixture drives.
 */
test('no user-facing sentence is written outside the catalog', () => {
  const sources = [
    'app-server.ts',
    'component-registry.ts',
    'demo-runtime.ts',
    'html.ts',
    'list-runtime.ts',
    'message-render.ts',
    'surface-contract.ts',
    'surface-runtime.ts',
  ];
  const contents = new Map(
    sources.map((name) => [
      name,
      readFileSync(`${webRoot}/src/${name}`, 'utf8'),
    ]),
  );

  for (const code of SURFACE_MESSAGE_CODES) {
    const entry = SURFACE_MESSAGE_CATALOG[code];
    for (const copy of [entry.sentence, entry.detail, entry.nextAction ?? '']) {
      if (copy === '') continue;
      const offenders = sources.filter((name) =>
        contents.get(name)!.includes(copy),
      );
      assert.deepEqual(
        offenders,
        [],
        `${code}: "${copy}" is written in ${offenders.join(', ')} as well as the catalog`,
      );
    }
  }
});

/**
 * ADR-0048 §2's *registered but never raised* direction, which `keyof typeof`
 * does not close. A code with no raise site is an entry the user can never see,
 * and it would sit in the catalog looking exactly like a working one.
 *
 * A source-literal scan is a proxy for reachability; the browser gate's 13
 * real-path drivers are the observation. The two are reported separately rather
 * than as one number.
 */
test('every registered code has a raise site outside the catalog', () => {
  const sources = [
    'app-server.ts',
    'component-registry.ts',
    'gateway-error-codes.ts',
    'surface-contract.ts',
    'surface-runtime.ts',
  ].map((name) =>
    stripComments(readFileSync(`${webRoot}/src/${name}`, 'utf8')),
  );

  const unraised = SURFACE_MESSAGE_CODES.filter(
    (code) => !sources.some((source) => source.includes(`'${code}'`)),
  );
  assert.deepEqual(unraised, []);
});

test('raise-site red: a code named only in a comment does not count as raised', () => {
  const commented = stripComments(
    `// UNKNOWN_SURFACE lives here\n/* 'NO_ACTIVE_SURFACE' too */\nconst x = 'ROUTE_NOT_FOUND';\n`,
  );
  assert.equal(commented.includes(`'NO_ACTIVE_SURFACE'`), false);
  assert.equal(commented.includes('UNKNOWN_SURFACE'), false);
  assert.equal(commented.includes(`'ROUTE_NOT_FOUND'`), true);
});

/**
 * **What this scan cannot prove, stated rather than implied** (AGENTS.md §6).
 * Stripping comments closes the commented-out hole outright. It does **not**
 * close the dead-branch hole: a code named in unreachable code still counts as
 * raised. `INVALID_SURFACE_BINDING` is the live proof — it satisfies this scan
 * and no request can produce it, which is why it is declared in the browser
 * gate's shortfall rather than left to this check. The 13 executed real-path
 * drivers are the observation; this is the proxy that covers the rest.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/\/\/[^\n]*/gu, '');
}

/**
 * The half `Record<union, …>` exhaustiveness cannot reach: a gateway error class
 * added in `packages/runtime` cannot fail a compile in `apps/web`. This reads
 * the loaded module objects and compares their actual exported error classes
 * against the mapping's declared names — an observation of the module, not a
 * parse of its source.
 */
test('the gateway error mapping covers every error class the gateways export', () => {
  /**
   * **Runtime `.name`, not the export key.** Dispatch reads `error.name`
   * (`gateway-error-codes.ts`), and `name` is an instance field rather than a
   * prototype property, so it can only be read by constructing one. Comparing
   * export keys let a class exported as `FooError` carrying
   * `name = 'BarError'` satisfy this test and fall through to the residual at
   * runtime. Not a live misclassification — the invariant was the weak part.
   *
   * Construction is attempted with progressively wider stub arguments and a
   * failure is **reported**, never skipped: a class this cannot instantiate is
   * a class whose dispatch name is unverified.
   */
  assert.deepEqual(
    [
      ...instanceNames(queryGateway),
      ...instanceNames(listBehavior),
      ...instanceNames(resolveByName),
    ].sort(),
    [...MAPPED_QUERY_ERROR_NAMES].sort(),
  );
  assert.deepEqual(
    instanceNames(operationGateway),
    [...MAPPED_OPERATION_ERROR_NAMES].sort(),
  );
});

/**
 * The vector this closes cannot be produced from the tree: it needs an error
 * class whose export key and runtime `name` disagree, and every such class
 * lives in `packages/runtime`, outside this packet's lease. So the red is
 * in-process against a synthetic module, the same way
 * `surface-grammar-conformance.test.ts` perturbs a fixture rather than the
 * product. What it demonstrates is exact: the comparison that shipped in round
 * one would have accepted this module, and this one does not.
 */
test('mapping red: an export key and a runtime name that disagree are observed', () => {
  const misnamed = {
    FooError: class extends Error {
      override readonly name = 'BarError';
    },
  };
  assert.deepEqual(Object.keys(misnamed), ['FooError']);
  assert.deepEqual(instanceNames(misnamed), ['BarError']);

  const unconstructible = {
    HostileError: class extends Error {
      constructor() {
        super();
        throw new TypeError('refuses every argument list');
      }
    },
  };
  assert.throws(
    () => instanceNames(unconstructible),
    /could not be constructed, so its dispatch name is unverified/,
  );
});

/** Runtime `.name` is an instance field, so reading it means constructing one. */
function instanceNames(namespace: Readonly<Record<string, unknown>>): string[] {
  {
    const stub = {
      release: { contentHash: 'stub', releaseId: 'stub' },
    } as never;
    return Object.entries(namespace)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          (value as { prototype?: unknown }).prototype instanceof Error,
      )
      .map(([exportKey, value]) => {
        const Constructor = value as new (...args: never[]) => Error;
        for (const argumentList of [
          [],
          ['stub'],
          ['stub', stub],
          ['stub', stub, stub],
        ]) {
          try {
            const instance = new Constructor(...(argumentList as never[]));
            assert.equal(
              typeof instance.name,
              'string',
              `${exportKey} has no runtime name`,
            );
            return instance.name;
          } catch {
            continue;
          }
        }
        assert.fail(
          `${exportKey} could not be constructed, so its dispatch name is unverified`,
        );
      })
      .sort();
  }
}

/**
 * ADR-0048 §5's last control, made structural: a gate that asked the renderer
 * what it should have rendered would agree with itself no matter what either
 * one did.
 */
test('the rendered-text gate never obtains its expected string from the renderer', () => {
  // Comments are stripped first: the gate's own header explains which helpers
  // it abstains from, and a scan that read prose would fail on the explanation
  // rather than on the behaviour.
  const gate = stripComments(
    readFileSync(`${webRoot}/test/browser/message-catalog.spec.ts`, 'utf8'),
  );
  for (const forbidden of [
    'messageBody',
    'messageAttributes',
    'surfaceMessage',
    'messageStatusRole',
    'message-render',
  ]) {
    assert.equal(
      gate.includes(forbidden),
      false,
      `the gate imports or calls ${forbidden}`,
    );
  }
  assert.ok(gate.includes('SURFACE_MESSAGE_CATALOG'));
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
