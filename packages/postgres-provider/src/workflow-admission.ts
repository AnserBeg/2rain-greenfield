import { canonicalize } from '@north-star/canonical-model';
import type { CompileSuccess } from '@north-star/compiler';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type { PoolClient } from 'pg';

import type { WorkflowDefinition } from '../../canonical-model/src/schemas.js';
import { readWorkflowBundle, verifyWorkflowBundle } from './workflow-bundle.js';
import { RECEIPT_POSTED_TYPE } from './workflow-consumer.js';
import {
  sha256,
  WORKFLOW_ENGINE_BUILD,
  WORKFLOW_HOST_VERSION,
  WORKFLOW_SDK_VERSION,
} from './workflow-execution.js';
import { recordVerifiedWorkflow } from './workflow-verification.js';

export type WorkflowBinding = WorkflowDefinition & {
  readonly sdkDigest: string;
};

export interface WorkflowAdmissionCandidate {
  readonly compiledRelease: CompileSuccess;
  readonly releaseId: MintedUuid;
  readonly evidenceId: MintedUuid;
}

export function workflowAutomationPrincipal(
  tenantId: string,
  environmentId: string,
  workflowId: string,
): string {
  const digest = sha256(
    canonicalize([
      'northstar.workflow-principal/v1',
      tenantId,
      environmentId,
      workflowId,
    ]),
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function verifyWorkflowDefinitions(
  client: PoolClient,
  context: TrustedRequestContext,
  view: RequestRuntimeView,
  bindings: readonly WorkflowBinding[],
) {
  const verified = [];
  for (const binding of bindings) {
    const bundle = await readWorkflowBundle(
      client,
      context,
      binding.bodyDigest,
    );
    const compiled = await verifyWorkflowBundle(view, binding.grants, bundle);
    if (compiled.executable !== bundle.executable)
      throw new Error('Workflow executable does not match the pinned bundle');
    verified.push({
      binding,
      author: bundle.authoredBy,
      executable: Buffer.from(compiled.executable),
      sdkDeclarationDigest: sha256(compiled.sdk.declarations),
    });
  }
  return verified;
}

type VerifiedDefinition = Awaited<
  ReturnType<typeof verifyWorkflowDefinitions>
>[number];

export async function persistWorkflowDefinitions(
  client: PoolClient,
  context: TrustedRequestContext,
  candidate: WorkflowAdmissionCandidate,
  verified: readonly VerifiedDefinition[],
): Promise<void> {
  const scope = [
    context.tenantId,
    context.environmentId,
    candidate.releaseId,
  ] as const;
  for (const {
    binding,
    author,
    executable,
    sdkDeclarationDigest,
  } of verified) {
    const executableDigest = sha256(executable);
    const principal = workflowAutomationPrincipal(
      context.tenantId,
      context.environmentId,
      binding.workflowId,
    );
    await client.query(
      `INSERT INTO platform.workflow_definitions (
        tenant_id, environment_id, release_id, workflow_id, event_type,
        body_digest, executable, executable_digest, sdk_digest, engine_build,
        host_version, sdk_version, automation_principal_id, authored_by, grants
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT DO NOTHING`,
      [
        ...scope,
        binding.workflowId,
        RECEIPT_POSTED_TYPE,
        binding.bodyDigest,
        executable,
        executableDigest,
        sdkDeclarationDigest,
        WORKFLOW_ENGINE_BUILD,
        WORKFLOW_HOST_VERSION,
        WORKFLOW_SDK_VERSION,
        principal,
        author,
        JSON.stringify(binding.grants),
      ],
    );
    const { rows } = await client.query<{ digest: string }>(
      `SELECT platform.workflow_definition_digest(d) AS digest
        FROM platform.workflow_definitions AS d
       WHERE (tenant_id, environment_id, release_id, workflow_id) = ($1, $2, $3, $4)
         AND (event_type, body_digest, executable_digest, sdk_digest, engine_build, host_version, sdk_version, automation_principal_id, authored_by, grants) =
             ($5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [
        ...scope,
        binding.workflowId,
        RECEIPT_POSTED_TYPE,
        binding.bodyDigest,
        executableDigest,
        sdkDeclarationDigest,
        WORKFLOW_ENGINE_BUILD,
        WORKFLOW_HOST_VERSION,
        WORKFLOW_SDK_VERSION,
        principal,
        author,
        JSON.stringify(binding.grants),
      ],
    );
    if (!rows[0])
      throw new Error(
        'The persisted workflow definition disagrees with verified code',
      );
    const bindingDigest = rows[0].digest;
    await client.query('SET LOCAL ROLE north_star_workflow_verifier');
    await recordVerifiedWorkflow(
      client,
      {
        artifacts: candidate.compiledRelease.bundle.artifacts,
        release: {
          tenantId: context.tenantId,
          environmentId: context.environmentId,
          releaseId: candidate.releaseId,
          verificationEvidenceId: candidate.evidenceId,
          contentHash: candidate.compiledRelease.releaseRoot,
        },
      },
      { id: binding.workflowId, digest: bindingDigest, grants: binding.grants },
      workflowEvidenceBytes(binding, executableDigest, sdkDeclarationDigest),
    );
    await client.query('RESET ROLE');
  }
}

function workflowEvidenceBytes(
  binding: WorkflowBinding,
  executableDigest: string,
  sdkDeclarationDigest: string,
): Buffer {
  return Buffer.from(
    canonicalize({
      kind: 'workflowReplayPassed',
      binding,
      executableDigest,
      sdkDeclarationDigest,
    }),
  );
}

export async function assertWorkflowEvidence(
  client: PoolClient,
  context: TrustedRequestContext,
  evidenceId: MintedUuid,
  releaseRoot: string,
  bindings: readonly WorkflowBinding[],
): Promise<void> {
  const { rows } = await client.query<{
    workflow_id: string;
    event_type: string;
    body_digest: string;
    executable_digest: string;
    sdk_digest: string;
    grants: unknown;
    result_bytes: Buffer;
    matches: boolean;
  }>(
    `SELECT e.workflow_id, d.body_digest, d.event_type, d.executable_digest, d.sdk_digest, d.grants,
       e.result_bytes, e.binding_digest = platform.workflow_definition_digest(d) AS matches
     FROM platform.workflow_verification_evidence e
     JOIN platform.workflow_definitions d
       ON (d.tenant_id, d.environment_id, d.release_id, d.workflow_id) =
          (e.tenant_id, e.environment_id, e.verified_release_id, e.workflow_id)
    WHERE (e.tenant_id, e.environment_id, e.verification_evidence_id, e.verified_release_root) = ($1, $2, $3, $4)`,
    [context.tenantId, context.environmentId, evidenceId, releaseRoot],
  );
  const byId = new Map(rows.map((row) => [row.workflow_id, row]));
  if (
    rows.length !== bindings.length ||
    bindings.some((binding) => {
      const row = byId.get(binding.workflowId);
      return (
        !row?.matches ||
        row.body_digest !== binding.bodyDigest ||
        row.event_type !== RECEIPT_POSTED_TYPE ||
        canonicalize(row.grants) !== canonicalize(binding.grants) ||
        !row.result_bytes.equals(
          workflowEvidenceBytes(binding, row.executable_digest, row.sdk_digest),
        )
      );
    })
  )
    throw new Error(
      'Workflow verification evidence is incomplete or does not match the candidate',
    );
}
