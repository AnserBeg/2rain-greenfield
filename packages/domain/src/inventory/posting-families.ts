/**
 * The compiled posting-family profile.
 *
 * `PS-1` was blocked because three questions — who writes the companion, how
 * invocation identity separates from the kernel contract, and what shape the
 * dependency contract takes — turned out to be three views of one missing
 * concept. The provider had `readonly familyId: string`, an unrestricted string
 * documented as a diagnostic name, and selected authorization by comparing it to
 * a literal. A magic string decided who could post what.
 *
 * This file is that concept. One declaration per admitted posting family, and
 * every fact that a family varies by is bound **here**, in one place, rather
 * than being spread across a switch on posting role, a hard-coded companion
 * branch, a per-capability admission list and a dependency-root literal that
 * nothing ties to any of them.
 *
 * It is pinned domain policy, in the manner `INVENTORY_STORAGE_REFERENCES_V1`
 * and the authoritative dependency set already are: a closed declaration the
 * compiler validates and the provider consumes, carrying no storage schema and
 * no handler. It is not canonical syntax and it is not a language change.
 *
 * The load-bearing consequence: **`stockCount` and `goodsReceipt` are both
 * profiles.** `PS-1` gave the kernel a companion writer that ran only when a
 * foreign source port was injected, so `postStockCount` escaped it entirely —
 * which left Inventory's dependency extension empty and made the one-gate
 * reachability requirement unsatisfiable, because only one of the two companion
 * classes had a kernel writer to govern. Both classes are declared here, so the
 * gate has both to close.
 */
import type { InventoryAuthoritativeDependencyV1 } from './contracts.js';

export const INVENTORY_POSTING_FAMILY_PROFILE_VERSION =
  'northstar.inventory-posting-family-profile/v1' as const;

/**
 * Closed. This is the type that replaces `familyId: string`. An unadmitted
 * family is a type error at assembly, not a string comparison at runtime.
 */
export const INVENTORY_POSTING_FAMILY_IDS = Object.freeze([
  'adjustment',
  'goodsReceipt',
  'stockCount',
  'transfer',
] as const);

export type InventoryPostingFamilyIdV1 =
  (typeof INVENTORY_POSTING_FAMILY_IDS)[number];

/**
 * Where a transaction's identity comes from. `authored` means the user creates
 * the `inventory_transaction` and it *is* the business document — today's
 * adjustment and transfer. `companion` means the kernel mints it inside the
 * posting transaction as an implementation detail of a foreign document.
 *
 * The distinction is what makes the reachability gate expressible without
 * deleting ordinary authoring: `authored` transactions must stay reachable
 * through every generic path, and `companion` transactions must stay reachable
 * through none. A rule that only says "hide companions" passes trivially if
 * every generic path is removed, taking adjustments with it.
 */
export type InventoryTransactionOriginV1 = 'authored' | 'companion';

/** Which revision a field carries. `PS-1` let one field carry three. */
export interface InventoryPostingRevisionContractV1 {
  /**
   * The foreign source document's expected revision, or `null` for a family
   * whose source document *is* the `inventory_transaction`.
   */
  readonly foreignSourceExpectedRevision: 'required' | 'absent';
  /**
   * Who owns the companion's revision. A kernel-minted companion's revision is
   * internal — the kernel created the row and knows it — so a command that
   * carried it would be asserting a fact it cannot have observed.
   */
  readonly companionRevisionAuthority: 'kernelMinted' | 'callerSupplied';
}

/** Both identities are derived. `PS-1` derived the header's and let the caller supply the line's. */
export interface InventoryPostingIdentityContractV1 {
  readonly companionHeader: 'derivedFromSourceDocument';
  readonly companionLine: 'derivedFromSourceLine';
  readonly sourceLine: 'derivedFromSourceDocument' | 'notApplicable';
}

export interface InventoryPostingReachabilityContractV1 {
  /** create, update, archive, restore on the transaction and its lines. */
  readonly genericAuthoring: 'admitted' | 'closed';
  /** get, list, search, resolve, and every surface built on them. */
  readonly genericRead: 'admitted' | 'closed';
}

export interface InventoryPostingFamilyProfileV1 {
  /** Which capability may invoke this family. Authorization, not diagnostics. */
  readonly capabilityId: string;
  readonly commandSchema: string;
  readonly companion: {
    /**
     * Whether `#post` mints the `inventory_transaction`. `false` means the user
     * authored it and it is the business document itself.
     */
    readonly createdByKernel: boolean;
    readonly identity: InventoryPostingIdentityContractV1;
    readonly origin: InventoryTransactionOriginV1;
    /**
     * Immutable provenance. The companion header's `source_type` is this exact
     * literal, selected by the kernel from the profile, never from the command
     * and never from the port. It is what makes a header incapable of claiming
     * an origin its movements do not have.
     */
    readonly sourceTypeLiteral: string;
    /**
     * The compiled `inventory_transaction_type` option this family's companion
     * carries. `PS-1` left this bound to posting role through a switch, so a
     * receipt posted through `postAdjustment` got `type = adjustment` while its
     * `source_type` said `goodsReceipt` — the precise pair it claimed to forbid.
     */
    readonly transactionTypeLocalId: string;
  };
  readonly dependencyExtension: readonly InventoryAuthoritativeDependencyV1[];
  readonly familyId: InventoryPostingFamilyIdV1;
  /** The movement's posting role. A receipt is not an adjustment. */
  readonly postingRole: string;
  readonly reachability: InventoryPostingReachabilityContractV1;
  readonly revisions: InventoryPostingRevisionContractV1;
  /**
   * Who locks and transitions the source document. `inventoryInternal` means the
   * source is inside the Inventory family and the kernel handles it; `foreignPort`
   * means a cross-domain port is invoked at the fixed positions.
   */
  readonly sourceStep: 'foreignPort' | 'inventoryInternal';
}

const dependency = (
  dependencyId: string,
  access: InventoryAuthoritativeDependencyV1['access'],
  authority: InventoryAuthoritativeDependencyV1['authority'],
): InventoryAuthoritativeDependencyV1 => ({ access, authority, dependencyId });

/**
 * The two companion appends. They are the same two for every companion-creating
 * family, which is why they sit in a shared constant rather than being repeated:
 * repeating them is the drift class this repository has already recorded twice.
 */
const COMPANION_APPENDS = Object.freeze([
  dependency('northstar.inventory:transaction', 'append', 'inventory'),
  dependency('northstar.inventory:transaction_line', 'append', 'inventory'),
]);

export const INVENTORY_POSTING_FAMILY_PROFILES = Object.freeze({
  /**
   * The user authors an `inventory_transaction` and posts it. There is no
   * companion — this transaction *is* the document. Its generic paths stay
   * **admitted**, and that is a requirement rather than an omission: it is the
   * positive half of the reachability gate.
   */
  adjustment: Object.freeze({
    capabilityId: 'northstar.inventory:capability.posting',
    commandSchema: 'northstar.inventory-adjustment-posting-command/v1',
    companion: Object.freeze({
      createdByKernel: false,
      identity: Object.freeze({
        companionHeader: 'derivedFromSourceDocument',
        companionLine: 'derivedFromSourceLine',
        sourceLine: 'notApplicable',
      }),
      origin: 'authored',
      sourceTypeLiteral: 'adjustment',
      transactionTypeLocalId: 'inventory_transaction_type_adjustment',
    }),
    dependencyExtension: Object.freeze([]),
    familyId: 'adjustment',
    postingRole: 'adjustment',
    reachability: Object.freeze({
      genericAuthoring: 'admitted',
      genericRead: 'admitted',
    }),
    revisions: Object.freeze({
      companionRevisionAuthority: 'callerSupplied',
      foreignSourceExpectedRevision: 'absent',
    }),
    sourceStep: 'inventoryInternal',
  }),

  /**
   * A goods receipt is a foreign document. The kernel mints its companion, the
   * companion carries `goodsReceipt` provenance and a `goodsReceipt` transaction
   * type, and the movement posts under a `receipt` role — none of which is an
   * adjustment. Every generic path is closed.
   */
  goodsReceipt: Object.freeze({
    capabilityId: 'northstar.purchasing:capability.receipt_posting',
    commandSchema: 'northstar.inventory-goods-receipt-posting-command/v1',
    companion: Object.freeze({
      createdByKernel: true,
      identity: Object.freeze({
        companionHeader: 'derivedFromSourceDocument',
        companionLine: 'derivedFromSourceLine',
        sourceLine: 'derivedFromSourceDocument',
      }),
      origin: 'companion',
      sourceTypeLiteral: 'goodsReceipt',
      transactionTypeLocalId: 'inventory_transaction_type_goods_receipt',
    }),
    dependencyExtension: Object.freeze([
      dependency('northstar.purchasing:purchase_order', 'read', 'inventory'),
      dependency(
        'northstar.purchasing:purchase_order_line',
        'read',
        'inventory',
      ),
      dependency('northstar.purchasing:goods_receipt', 'read', 'inventory'),
      dependency(
        'northstar.purchasing:goods_receipt_line',
        'read',
        'inventory',
      ),
      dependency(
        'northstar.purchasing:goods_receipt.state',
        'transition',
        'inventory',
      ),
      // NOT a `purchase_order_line.received_quantity` transition. The stored
      // counter that entry described is withdrawn: received quantity is derived
      // from posted movements, so what this family reads is the movement
      // history it already declares below, under lock.
      ...COMPANION_APPENDS,
    ]),
    familyId: 'goodsReceipt',
    postingRole: 'receipt',
    reachability: Object.freeze({
      genericAuthoring: 'closed',
      genericRead: 'closed',
    }),
    revisions: Object.freeze({
      // The receipt's own revision, separate from the companion's. The kernel
      // mints the companion, so nothing outside may assert its revision.
      companionRevisionAuthority: 'kernelMinted',
      foreignSourceExpectedRevision: 'required',
    }),
    sourceStep: 'foreignPort',
  }),

  /**
   * A stock count is also a foreign document — foreign to the transaction, not
   * to Inventory. It has always needed a companion and has never had a writer
   * for one. Declaring it here is what gives Inventory a non-empty extension and
   * gives the reachability gate its second class.
   */
  stockCount: Object.freeze({
    capabilityId: 'northstar.inventory:capability.posting',
    commandSchema: 'northstar.inventory-stock-count-posting-command/v1',
    companion: Object.freeze({
      createdByKernel: true,
      identity: Object.freeze({
        companionHeader: 'derivedFromSourceDocument',
        companionLine: 'derivedFromSourceLine',
        sourceLine: 'derivedFromSourceDocument',
      }),
      origin: 'companion',
      sourceTypeLiteral: 'stockCount',
      transactionTypeLocalId: 'inventory_transaction_type_count_correction',
    }),
    dependencyExtension: Object.freeze([...COMPANION_APPENDS]),
    familyId: 'stockCount',
    postingRole: 'count',
    reachability: Object.freeze({
      genericAuthoring: 'closed',
      genericRead: 'closed',
    }),
    revisions: Object.freeze({
      companionRevisionAuthority: 'kernelMinted',
      foreignSourceExpectedRevision: 'required',
    }),
    sourceStep: 'inventoryInternal',
  }),

  /** Authored, like adjustment. Kept explicit so the set is exhaustive. */
  transfer: Object.freeze({
    capabilityId: 'northstar.inventory:capability.posting',
    commandSchema: 'northstar.inventory-transfer-posting-command/v1',
    companion: Object.freeze({
      createdByKernel: false,
      identity: Object.freeze({
        companionHeader: 'derivedFromSourceDocument',
        companionLine: 'derivedFromSourceLine',
        sourceLine: 'notApplicable',
      }),
      origin: 'authored',
      sourceTypeLiteral: 'transfer',
      transactionTypeLocalId: 'inventory_transaction_type_transfer',
    }),
    dependencyExtension: Object.freeze([]),
    familyId: 'transfer',
    postingRole: 'transfer',
    reachability: Object.freeze({
      genericAuthoring: 'admitted',
      genericRead: 'admitted',
    }),
    revisions: Object.freeze({
      companionRevisionAuthority: 'callerSupplied',
      foreignSourceExpectedRevision: 'absent',
    }),
    sourceStep: 'inventoryInternal',
  }),
} as const satisfies Record<
  InventoryPostingFamilyIdV1,
  InventoryPostingFamilyProfileV1
>);

/**
 * Which capability may execute which families, derived from the profiles rather
 * than declared beside them. `PS-1` kept an admission list next to an extension
 * root and asserted they could not drift; deriving one from the other is what
 * makes that true instead of asserted.
 */
export function admittedFamiliesFor(
  capabilityId: string,
): readonly InventoryPostingFamilyIdV1[] {
  return Object.values(INVENTORY_POSTING_FAMILY_PROFILES)
    .filter((profile) => profile.capabilityId === capabilityId)
    .map((profile) => profile.familyId)
    .toSorted();
}

/**
 * The per-capability dependency extension, derived by unioning the extensions of
 * exactly the families that capability may execute. The kernel baseline is not
 * included and does not move.
 */
export function dependencyExtensionFor(
  capabilityId: string,
): readonly InventoryAuthoritativeDependencyV1[] {
  const seen = new Set<string>();
  const entries: InventoryAuthoritativeDependencyV1[] = [];
  for (const familyId of admittedFamiliesFor(capabilityId)) {
    for (const entry of INVENTORY_POSTING_FAMILY_PROFILES[familyId]
      .dependencyExtension) {
      const key = `${entry.access}\0${entry.authority}\0${entry.dependencyId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry });
    }
  }
  return Object.freeze(
    entries.toSorted((left, right) =>
      `${left.access}\0${left.authority}\0${left.dependencyId}`.localeCompare(
        `${right.access}\0${right.authority}\0${right.dependencyId}`,
      ),
    ),
  );
}

/**
 * The catalog payload, in the shape the provider consumes. `PUR-2` replaces this
 * function with a compiled projection; until then it is the same values reaching
 * the kernel by the same route `storageTarget` already uses.
 */
export function inventoryPostingFamilyCatalogPayload(): {
  readonly profiles: readonly InventoryPostingFamilyProfileV1[];
  readonly schemaVersion: typeof INVENTORY_POSTING_FAMILY_PROFILE_VERSION;
} {
  return Object.freeze({
    profiles: Object.freeze(
      INVENTORY_POSTING_FAMILY_IDS.map(
        (familyId) => INVENTORY_POSTING_FAMILY_PROFILES[familyId],
      ),
    ),
    schemaVersion: INVENTORY_POSTING_FAMILY_PROFILE_VERSION,
  });
}
