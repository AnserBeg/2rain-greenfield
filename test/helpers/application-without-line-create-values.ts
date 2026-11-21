import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  DEFAULT_COMPILER_LIMITS,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

let fixture: ReturnType<typeof compileFixture> | undefined;

/** Isolate earlier surface features from the stock count editor's reader requirement. */
export function applicationWithoutLineCreateValues() {
  return (fixture ??= compileFixture());
}

function compileFixture() {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const authored = JSON.parse(readFileSync(authoredPath, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const { documentEditor } of authored.surfaces as {
    documentEditor?: { lineCreateValues?: unknown };
  }[]) {
    if (documentEditor) delete documentEditor.lineCreateValues;
  }
  // Older-reader witnesses must reach the feature they exercise.
  for (const entity of authored.entities as { reportSource?: unknown }[])
    delete entity.reportSource;
  return singleTransitionApplication(authored);
}

/** Install a test's chosen first-party source directly after the retained bootstrap. */
export function singleTransitionApplication(authored: Record<string, unknown>) {
  const authoredPath = resolve('apps/web/release/app.authored.json');
  const { bootstrap } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const normalized = normalizeApplicationPackage(authored);
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const compiled = compileApplicationRelease(
    {
      kind: 'compilerInput',
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(bootstrap.compiled),
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    readUnboundPermissionAcknowledgementFor(
      authoredPath,
      normalized.package.packageId,
    ),
  );
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.status === 'compiled' ? [] : compiled.diagnostics),
  );
  return {
    authored,
    release: {
      schemaVersion: 'northstar.web:compiled-application-release/v1',
      application: serializeRelease({ compiled, normalizedDefinitionBytes }),
      bootstrap: serializeRelease(bootstrap),
    },
  };
}
