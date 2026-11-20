import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  SYSTEM_EXECUTION_PRINCIPAL,
  type MintedUuid,
} from '../../../packages/platform-runtime/src/index.js';
import { PostgresReleaseApprovalService } from '@north-star/postgres-provider/release-approval-service';
import { PostgresReleaseActivationService } from '@north-star/postgres-provider/release-activation-service';
import { withActivationVerifierTransaction } from '@north-star/postgres-provider/request-context';
import { AuthenticatedRequestEntryAdapter } from '../../../packages/runtime/src/request-context.js';
import {
  assertPilotDatabase,
  check,
  type StaffRealm,
} from './staff-protocol.js';

interface ReleaseDecision {
  candidate: MintedUuid;
  maker: string;
  preparation: MintedUuid;
  upgrade: MintedUuid | null;
}
interface PendingDecision {
  proof_id: MintedUuid;
  decision_kind: 'release' | 'customize' | 'retry';
  company_id: string | null;
}
function contextFor(realm: StaffRealm, principalId: string) {
  return new AuthenticatedRequestEntryAdapter(async () => ({
    tenantId: realm.tenantId,
    environmentId: realm.environmentId,
    principalId,
  })).enter({});
}

// The verifier process holds this login. The service starts from a durable proof
// reference. Its caller cannot supply an actor, an approval row or release facts.
export async function applyStaffDecision(
  pool: pg.Pool,
  realm: StaffRealm,
  pending: PendingDecision,
) {
  const system = await contextFor(
    realm,
    SYSTEM_EXECUTION_PRINCIPAL.principalId,
  );
  return withActivationVerifierTransaction(pool, system, async (client) => {
    const { rows } = await client.query<{
      facts: { principal: string; targets: ReleaseDecision[] };
    }>('SELECT platform.staff_consume_decision($1,$2,$3,$4,$5,$6) AS facts', [
      realm.tenantId,
      realm.environmentId,
      pending.company_id,
      pending.decision_kind,
      pending.proof_id,
      system.requestId,
    ]);
    const facts = rows[0]!.facts;
    // Until the same-pin writer joins, the receipt records the human decision.
    // No scheduler or run transition is enabled by recording it.
    if (pending.decision_kind === 'retry') return [];
    const actor = await contextFor(realm, facts.principal);
    await client.query("SELECT set_config('north_star.principal_id',$1,true)", [
      actor.principalId,
    ]);
    const approvals = new PostgresReleaseApprovalService(pool);
    const attempts: MintedUuid[] = [];
    for (const target of facts.targets) {
      const created = await approvals.createApprovalOnClient(client, actor, {
        approvingHumanId: actor.principalId,
        issuingActorId: actor.principalId,
        initiatingHumanId: target.maker,
        sourceDecisionId: target.upgrade ?? pending.proof_id,
        staffProofId: pending.proof_id,
        preparationId: target.preparation,
        targetReleaseId: target.candidate,
        approvalId: randomUUID() as MintedUuid,
        activationAttemptId: randomUUID() as MintedUuid,
        ...(target.upgrade ? { customizationUpgradeId: target.upgrade } : {}),
      });
      attempts.push(created.attempt.activationAttemptId);
    }
    return attempts;
  });
}

export async function runDecisionVerifier(
  pool: pg.Pool,
  realm: StaffRealm,
  attempt?: string,
) {
  await assertPilotDatabase(pool, 'north_star_activation_verifier', realm);
  const system = await contextFor(
    realm,
    SYSTEM_EXECUTION_PRINCIPAL.principalId,
  );
  if (attempt) {
    check(/^[0-9a-f-]{36}$/iu.test(attempt));
    const kernel = new PostgresReleaseActivationService(pool, {
      transaction: withActivationVerifierTransaction,
    });
    const result = await kernel.activate(system, {
      activationAttemptId: attempt as MintedUuid,
    });
    return [{ attempt, status: result.status }];
  }
  const pending = await withActivationVerifierTransaction(
    pool,
    system,
    async (client) =>
      (
        await client.query<PendingDecision>(
          'SELECT * FROM platform.staff_pending_decisions($1,$2)',
          [realm.tenantId, realm.environmentId],
        )
      ).rows,
  );
  const results = [];
  for (const decision of pending) {
    try {
      results.push({
        proof: decision.proof_id,
        attempts: await applyStaffDecision(pool, realm, decision),
        status: 'recorded',
      });
    } catch {
      results.push({ proof: decision.proof_id, status: 'refused' });
    }
  }
  return results;
}
