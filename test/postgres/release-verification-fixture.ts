import assert from 'node:assert/strict';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import type { CompileSuccess } from '../../packages/compiler/src/index.js';
import type { RegisterTenantReleaseCommand } from '../../packages/platform-runtime/src/index.js';
import type { TrustedRequestContext } from '../../packages/runtime/src/request-context.js';
import type pg from 'pg';

import type { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';

export async function admitEmptyPlanRelease(
  pool: pg.Pool,
  repository: PostgresImmutableReleaseRepository,
  context: TrustedRequestContext,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
) {
  assert.equal(
    releaseVerificationBinding(command.compiledRelease).plan.scenarios.length,
    0,
    'this fixture helper is restricted to genuinely empty verification plans',
  );
  const staged = await repository.stageTenantReleaseCandidate(context, {
    appPackageRevisionId: command.appPackageRevisionId,
    compiledRelease: command.compiledRelease,
    createdBy: command.createdBy,
    environmentId: command.environmentId,
    releaseId: command.releaseId,
    tenantId: command.tenantId,
  });
  assert.equal(staged.verificationEvidenceId, command.verificationEvidenceId);
  await new PostgresReleaseVerificationService(
    pool,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: command.compiledRelease,
    evidenceId: staged.verificationEvidenceId,
    providerRunId: `postgres-fixture:${command.releaseId}`,
    releaseId: command.releaseId,
  });
  return repository.registerTenantRelease(context, command);
}

export function definitionWithoutAssertions(
  bytes: Uint8Array,
  version: string,
): Uint8Array {
  const definition = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  definition.assertions = [];
  if (typeof definition.package !== 'object' || definition.package === null) {
    throw new TypeError('fixture package definition is missing');
  }
  (definition.package as Record<string, unknown>).version = version;
  return new TextEncoder().encode(canonicalize(definition));
}
