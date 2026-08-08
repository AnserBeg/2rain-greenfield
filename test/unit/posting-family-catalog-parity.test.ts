/**
 * PS-2. The gate that keeps the posting-family catalog from becoming a third
 * instance of this repository's recorded drift class.
 *
 * The values are authored in `@north-star/domain` and consumed by the provider,
 * which cannot import domain — it is a generic storage adapter and inverting
 * that layering would be worse than the duplication. The correct joint is a
 * compiled projection read through `context.projection(...)`, exactly as
 * `storageTarget` arrives; `PUR-2` owes it, and adding a projection family is a
 * compiler event under ADR-0047 rather than something this probe may invent.
 *
 * So the two copies exist on purpose, for one packet, **behind this test**.
 * ADR-0049 records two prior duplications that nothing checked: the authority
 * literal at `contracts.ts:200-207` repeated at `conformance.ts:3215-3222`, and
 * `reBaseline` present in `INVENTORY_POSTING_ROLES` and absent from
 * `InventoryPostingRoleV1` — where, in its own words, "nothing fails." The
 * difference between debt and a defect is whether something fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { inventoryPostingFamilyCatalogPayload } from '../../packages/domain/src/inventory/posting-families.js';
import {
  INVENTORY_POSTING_FAMILY_CATALOG_V1,
  dependencyExtensionRootFor,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(
            ([left], [right]) => left.localeCompare(right),
          ),
        )
      : inner,
  );

test('the provider posting-family catalog is identical to the authored one', () => {
  const authored = inventoryPostingFamilyCatalogPayload();
  const provider = INVENTORY_POSTING_FAMILY_CATALOG_V1;

  assert.equal(
    provider.schemaVersion,
    authored.schemaVersion,
    'catalog schema versions diverged',
  );
  assert.deepEqual(
    provider.profiles.map((profile) => profile.familyId).toSorted(),
    authored.profiles.map((profile) => profile.familyId).toSorted(),
    'the two catalogs declare different families',
  );

  // Field-by-field, so a failure names the profile and the fact that moved
  // rather than printing two large objects. `dependencyExtension` is compared
  // as a **set**: it is one semantically, and `dependencyExtensionRootFor`
  // sorts and dedupes before hashing, so declaration order carries no meaning
  // and pinning it would fail for a difference that does not exist.
  const normalize = (
    profile: (typeof authored.profiles)[number],
  ): Record<string, unknown> => ({
    ...JSON.parse(canonical(profile)),
    dependencyExtension: profile.dependencyExtension
      .map(
        (entry) => `${entry.access}\0${entry.authority}\0${entry.dependencyId}`,
      )
      .toSorted(),
  });

  for (const expected of authored.profiles) {
    const actual = provider.profiles.find(
      (candidate) => candidate.familyId === expected.familyId,
    );
    assert.ok(actual, `provider catalog is missing ${expected.familyId}`);
    assert.deepEqual(
      normalize(actual as (typeof authored.profiles)[number]),
      normalize(expected),
      `posting family ${expected.familyId} differs between domain and provider`,
    );
  }

  // The value that actually reaches the kernel: the per-capability extension
  // root. If these agree, the compiled projection PUR-2 lands cannot disagree
  // with what the kernel admits today.
  for (const capabilityId of [
    'northstar.inventory:capability.posting',
    'northstar.purchasing:capability.receipt_posting',
  ]) {
    assert.equal(
      dependencyExtensionRootFor(provider, capabilityId),
      dependencyExtensionRootFor(
        authored as unknown as Parameters<typeof dependencyExtensionRootFor>[0],
        capabilityId,
      ),
      `dependency extension root diverged for ${capabilityId}`,
    );
  }
});

test('every companion-origin family is written by the kernel and generically closed', () => {
  for (const profile of inventoryPostingFamilyCatalogPayload().profiles) {
    const isCompanion = profile.companion.origin === 'companion';
    assert.equal(
      profile.companion.createdByKernel,
      isCompanion,
      `${profile.familyId}: a companion must have a kernel writer and an authored document must not`,
    );
    // The positive half of the reachability gate. Without it, deleting every
    // generic transaction path would satisfy "companions are unreachable" while
    // silently removing ordinary adjustment authoring.
    const expected = isCompanion ? 'closed' : 'admitted';
    assert.equal(profile.reachability.genericAuthoring, expected);
    assert.equal(profile.reachability.genericRead, expected);
    // A kernel-minted companion's revision is internal, so the command carries
    // only the foreign document's.
    assert.equal(
      profile.revisions.companionRevisionAuthority,
      isCompanion ? 'kernelMinted' : 'callerSupplied',
    );
  }
});

test('both companion classes exist, so the reachability gate has both to close', () => {
  const companions = inventoryPostingFamilyCatalogPayload()
    .profiles.filter((profile) => profile.companion.origin === 'companion')
    .map((profile) => profile.familyId)
    .toSorted();
  // PS-1 gave the kernel a writer that ran only when a foreign port was
  // injected, so `postStockCount` escaped it — which left Inventory's extension
  // empty and made a one-gate rule unsatisfiable.
  assert.deepEqual(companions, ['goodsReceipt', 'stockCount']);
});
