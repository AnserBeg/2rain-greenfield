import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

/**
 * 0x4e535354 is the ASCII tag "NSST" (North Star stock).
 *
 * PostgreSQL keeps the two-integer advisory-lock family in a key space that is
 * disjoint from the one-bigint family used by migration locks. The existing
 * materializer generation lock is also two-integer: its first key is
 * hashtext('north-star:module-storage-generation:v1'), observed and pinned by
 * provider controls as -1322922032. NSST is 1314083668, so the namespaces are
 * distinct. Within the two-integer family NSST is reserved exclusively for
 * stock identities.
 */
export const STOCK_IDENTITY_LOCK_NAMESPACE = 0x4e535354;

const lockDerivationVersion = 'northstar.stock-identity-lock/v1';
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const transactionContractSavepoint =
  'north_star_stock_identity_serializer_contract';

/**
 * The ratified v1 stock tuple qualified by its database tenancy scope.
 * Tenant and environment do not add stock dimensions; they prevent unrelated
 * scopes whose UUID values happen to match from contending on one global
 * PostgreSQL advisory lock.
 */
export interface ScopedStockIdentityV1 {
  readonly environmentId: string;
  readonly itemId: string;
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly tenantId: string;
}

export interface StockIdentityLockTargetV1 {
  readonly identity: ScopedStockIdentityV1;
  readonly identityKey: number;
}

/**
 * Establishes the one allowed acquisition order for multi-identity postings:
 * ascending signed PostgreSQL identity key, then ascending canonical lowercase
 * UUID tuple as a collision tie-breaker. Ordering the physical keys first keeps
 * the order total even if distinct identities derive the same int4 key. Exact
 * identity duplicates are removed.
 */
export function planStockIdentityLocks(
  identities: readonly ScopedStockIdentityV1[],
): readonly StockIdentityLockTargetV1[] {
  const byCanonicalTuple = new Map<string, ScopedStockIdentityV1>();
  for (const identity of identities) {
    const canonical = validateAndCopyIdentity(identity);
    byCanonicalTuple.set(canonicalTuple(canonical), canonical);
  }

  return Object.freeze(
    [...byCanonicalTuple.entries()]
      .map(([canonical, identity]) => ({
        canonical,
        identity,
        identityKey: deriveIdentityKey(identity),
      }))
      .sort((left, right) =>
        left.identityKey === right.identityKey
          ? compareCodeUnits(left.canonical, right.canonical)
          : compareIntegers(left.identityKey, right.identityKey),
      )
      .map(({ identity, identityKey }) =>
        Object.freeze({
          identity,
          identityKey,
        }),
      ),
  );
}

/**
 * Acquires every affected stock identity inside the caller's open posting
 * transaction. The function never starts, commits, retries, or probes a lock.
 * Blocking is the concurrency contract; transaction completion releases every
 * acquired lock.
 *
 * A SAVEPOINT is deliberately used as a transaction-contract assertion.
 * PostgreSQL rejects it in autocommit mode, preventing a transaction-scoped
 * lock from becoming a statement-scoped silent no-op. It is not a business
 * preflight and reads no posting state.
 */
export async function acquireStockIdentityLocks(
  transaction: PoolClient,
  identities: readonly ScopedStockIdentityV1[],
): Promise<readonly StockIdentityLockTargetV1[]> {
  const targets = planStockIdentityLocks(identities);
  if (targets.length === 0) {
    throw new TypeError('at least one stock identity is required');
  }

  await transaction.query(`SAVEPOINT ${transactionContractSavepoint}`);
  await transaction.query(`RELEASE SAVEPOINT ${transactionContractSavepoint}`);
  for (const target of targets) {
    await transaction.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [STOCK_IDENTITY_LOCK_NAMESPACE, target.identityKey],
    );
  }
  return targets;
}

function validateAndCopyIdentity(
  identity: ScopedStockIdentityV1,
): ScopedStockIdentityV1 {
  const copy = Object.freeze({
    environmentId: canonicalUuid(identity.environmentId, 'environmentId'),
    itemId: canonicalUuid(identity.itemId, 'itemId'),
    legalEntityId: canonicalUuid(identity.legalEntityId, 'legalEntityId'),
    locationId: canonicalUuid(identity.locationId, 'locationId'),
    tenantId: canonicalUuid(identity.tenantId, 'tenantId'),
  });
  return copy;
}

function canonicalUuid(value: string, field: string): string {
  if (!canonicalUuidPattern.test(value)) {
    throw new TypeError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function canonicalTuple(identity: ScopedStockIdentityV1): string {
  return [
    identity.tenantId,
    identity.environmentId,
    identity.legalEntityId,
    identity.itemId,
    identity.locationId,
  ].join('\0');
}

function deriveIdentityKey(identity: ScopedStockIdentityV1): number {
  const digest = createHash('sha256')
    .update(lockDerivationVersion)
    .update('\0')
    .update(canonicalTuple(identity))
    .digest();
  // PostgreSQL's second key is int4. A collision conservatively serializes two
  // unrelated identities; it cannot let equal identities bypass each other.
  return digest.readInt32BE(0);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIntegers(left: number, right: number): number {
  return left < right ? -1 : 1;
}
