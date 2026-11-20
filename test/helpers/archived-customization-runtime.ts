import assert from 'node:assert/strict';
import {
  canonicalize,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  compileInSandbox,
  parseCustomizationPatch,
  parseSerializedRelease,
} from '../../packages/customization/src/index.js';

import type { ArchivedRunner } from './archived-runtime-process.js';
export {
  archivedRuntimeRead,
  archivedServingRead,
  withArchivedCustomizationRuntime,
} from './archived-runtime-process.js';

export async function assertArchivedTenantEnvelope(run: ArchivedRunner) {
  const patch = parseCustomizationPatch({
    kind: 'addField',
    entity: 'northstar.app:entity.item',
    field: { label: 'Inspection notes', type: 'text' },
  });
  assert.ok(patch.status === 'parsed');
  // The historical runner supplies both compilers with the same base, policy,
  // and parent bytes independently of changes to the current lineage.
  const { request, release: historical } = (await run(
    `
import { readFile } from 'node:fs/promises';
import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { compileInSandbox } from './packages/customization/src/sandbox.ts';
import { serializeRelease } from './packages/customization/src/release-envelope.ts';
const path = 'apps/web/release/app.authored.json';
const compiled = parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json', 'utf8')));
const request = {
  acknowledgement: readUnboundPermissionAcknowledgementFor(path, 'northstar.app:package.application'),
  base: JSON.parse(await readFile(path, 'utf8')),
  chain: [JSON.parse(await readFile(process.argv[2], 'utf8'))],
  tip: serializeRelease(compiled.applications.at(-1) ?? compiled.bootstrap),
};
const result = await compileInSandbox(request);
if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ request, release: result.steps[0].release }));
`,
    patch.patch,
  )) as {
    request: Parameters<typeof compileInSandbox>[0];
    release: unknown;
  };
  const current = await compileInSandbox(request);
  assert.ok(current.status === 'compiled', JSON.stringify(current));
  const envelope = current.steps[0]?.release;
  assert.ok(envelope);
  const compiled = parseSerializedRelease(envelope);
  assert.equal(
    parseNormalizedApplicationPackageJson(compiled.normalizedDefinitionBytes)
      .package.provenance,
    'tenantAuthored',
  );
  assert.equal(
    canonicalize(envelope),
    canonicalize(historical),
    'both tenant runners reproduce the entire v6 envelope with the optional declaration absent',
  );
}
