# CONNECT-1 — company connectors for addresses, maps and email

Slice 0 is the docs-only design amended after Fable’s read. The orchestrator authorized slice 1.
Slice 0 touched no Critical paths. The slice 1 branch changes the module materializer, release verification, and a migration with RLS and grants.

## Design claims and decisions

1. A company enables an account-scoped installation. A release binds typed operations,
   inbound mappings and health checks. Only the host resolves credentials and calls providers.
2. The trust outbox links the business commit to one delivery intent per effect. Reconciliation
   handles an unknown outcome after provider acceptance. Verified inbound events invoke
   scoped Semantic Operations under stable keys.
3. A worker can save typed address text during an outage. A later pin must match the current
   address revision. Email confirmation binds recipients and an exact DOCS-1 version.
4. Address and email each take the next implemented surface rung at merge, per DOCS-1's ruling.
   A deploy must support every patch parser and surface floor already used by a tenant.
5. The charter named ADR-0076. Main uses it for cross-field validation, CUSTOMIZE-3 uses
   ADR-0077, DOCS-1 uses ADR-0078 and UI-COMPOSE-1 uses ADR-0079. Connectors take ADR-0080.

## Slices and gates

0. Amended ADR-0080, including the sign-in gate and measured first-party and tenant absence parity.
1. Address and Maps on an office record and a tenant-authored record, including delayed
   geocoding and provider failure. CI uses deterministic fakes.
2. Email through the same contract. The document action depends on DOCS-1 and N2-03.
   N2-04 exercises retries, duplicates, bounces, secrets, replay and recovery with a fake.

Charter scope: “any record type” means any ADR-0079-eligible record type. Protected-record annotations await a separate design ruling.
Google static imagery stays disabled. A real embedded map needs browser-direct delivery and a CSP and privacy decision after sign-in.

## Test it yourself

Run `scripts/check-records.sh` at the repository root and expect exit status zero.
Open [ADR-0080](../../decisions/ADR-0080-connector-framework.md) and trace three cases.

- Save address A during an outage, edit it to B and let A's result arrive. B remains
  the saved address and only B's result can supply its pin.
- Compare the two roots in the ADR’s absence probe. The tenant release used the isolated runner.
- Stop the sender after provider acceptance. Recovery uses the original key within its
  safe window, or holds the send for reconciliation when acceptance cannot be determined.
- Deliver the same signed bounce twice. Both acknowledgements refer to one captured event
  and one scoped message transition.

## Slice 1 storage decision pending

The draft stores Address as `jsonb` under the existing storage payload version.
ADR-0011 freezes the field mapping. ADR-0027 and the posting adapter require the active
release's exact v3 storage target. An Address field on Party changes that same release target.
A versioned compound storage target therefore requires a decision on posting registration.
An alternative needs a specified lowering from a logical Address to existing scalar columns.
The branch has not merged. The older-reader, byte-parity and end-to-end demo proofs remain open.
