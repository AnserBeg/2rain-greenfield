import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

type Value = Readonly<Record<string, unknown>>;

function record(value: unknown): asserts value is Value {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
}

function expectedInventoryWorkspace(namespace: string, surface: Value): Value {
  const surfaceId = String(surface.surfaceId);
  const local = surfaceId.split(':surface.')[1];
  assert.ok(local, `inventory surface must have a local ID: ${surfaceId}`);
  const document = local.replace(/_(list|detail|form)$/, '');
  const membership =
    surface.surfaceRole === 'list'
      ? document === 'posted_stock_balance'
        ? 'operational'
        : 'setup'
      : 'contextual';
  return {
    membership,
    ...(document === 'posted_stock_balance'
      ? {
          entry: {
            companyQueryId: `${namespace}:query.legal_entity_list`,
            companyNameFieldId: `${namespace}:field.legal_entity_name`,
            companyStateFieldId: `${namespace}:field.legal_entity_status`,
            activeStateId: `${namespace}:option.legal_entity_status_active`,
            policy: 'authorizedSingleOrPreference',
            authorizationQueryId: `${namespace}:query.posted_stock_balance_list`,
          },
        }
      : {}),
  };
}

/**
 * Composition may add only the independently pinned workspace declaration to
 * inventory surfaces. Identity/count and every original binding stay exact.
 */
export function assertComposedInventoryCollection(
  collection: string,
  composed: readonly unknown[],
  inventory: readonly unknown[],
  namespace: string,
): void {
  for (const source of inventory) {
    if (collection !== 'surfaces') {
      assert.equal(
        composed.filter((candidate) => isDeepStrictEqual(candidate, source))
          .length,
        1,
        `composed application must contain each inventory ${collection} entry exactly once`,
      );
      continue;
    }
    record(source);
    assert.equal(typeof source.surfaceId, 'string');
    const matches = composed.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        (candidate as Value).surfaceId === source.surfaceId,
    );
    assert.equal(
      matches.length,
      1,
      `composed application must contain inventory surface ${String(source.surfaceId)} exactly once`,
    );
    const candidate = matches[0];
    record(candidate);
    const { workspace, ...protectedSurface } = candidate;
    assert.deepEqual(
      protectedSurface,
      source,
      `composition altered protected bindings for ${String(source.surfaceId)}`,
    );
    assert.deepEqual(
      workspace,
      expectedInventoryWorkspace(namespace, source),
      `composition added an unauthorized workspace for ${String(source.surfaceId)}`,
    );
  }
}
