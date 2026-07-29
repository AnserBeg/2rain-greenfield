import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STORAGE_TARGET_PAYLOAD_VERSION,
  SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS,
} from '../../packages/compiler/src/index.js';
import {
  STORAGE_TARGET_PAYLOAD_V2_VERSION,
  STORAGE_TARGET_PAYLOAD_V3_VERSION,
} from '../../packages/compiler/src/protocol.js';
import {
  assertSupportedStorageTargetArtifactVersions,
  ModuleRuntimeInterpreterError,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';

test('the runtime admits the compiler-owned storage payload family and rejects unknown versions', () => {
  assert.deepEqual(SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS, [
    STORAGE_TARGET_PAYLOAD_VERSION,
    STORAGE_TARGET_PAYLOAD_V2_VERSION,
    STORAGE_TARGET_PAYLOAD_V3_VERSION,
  ]);

  for (const version of SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS) {
    assert.doesNotThrow(() =>
      assertSupportedStorageTargetArtifactVersions({
        projectionPayloadSchemaVersion: version,
        referencePayloadSchemaVersion: version,
        targetSchemaVersion: version,
      }),
    );
  }

  assert.throws(
    () =>
      assertSupportedStorageTargetArtifactVersions({
        projectionPayloadSchemaVersion: 'northstar.storage-target-payload/v999',
        referencePayloadSchemaVersion: 'northstar.storage-target-payload/v999',
        targetSchemaVersion: 'northstar.storage-target-payload/v999',
      }),
    (error: unknown) =>
      assertModuleRuntimeError(error, 'MODULE_STORAGE_PROJECTION_MISSING'),
  );

  assert.throws(
    () =>
      assertSupportedStorageTargetArtifactVersions({
        projectionPayloadSchemaVersion: STORAGE_TARGET_PAYLOAD_V2_VERSION,
        referencePayloadSchemaVersion: STORAGE_TARGET_PAYLOAD_VERSION,
        targetSchemaVersion: STORAGE_TARGET_PAYLOAD_VERSION,
      }),
    (error: unknown) =>
      assertModuleRuntimeError(error, 'MODULE_STORAGE_PROJECTION_MALFORMED'),
  );

  assert.throws(
    () =>
      assertSupportedStorageTargetArtifactVersions({
        projectionPayloadSchemaVersion: STORAGE_TARGET_PAYLOAD_VERSION,
        referencePayloadSchemaVersion: STORAGE_TARGET_PAYLOAD_VERSION,
        targetSchemaVersion: STORAGE_TARGET_PAYLOAD_V2_VERSION,
      }),
    (error: unknown) =>
      assertModuleRuntimeError(error, 'MODULE_STORAGE_TARGET_MALFORMED'),
  );
});

function assertModuleRuntimeError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ModuleRuntimeInterpreterError);
  assert.equal(error.code, code);
  return true;
}
