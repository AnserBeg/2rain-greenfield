# GRANTS-GUARD — check application privileges after migrations

PostgreSQL CI compares effective grants after a clean migration replay with [one reason per exception](../../../test/postgres/application-grants.tsv). Shard 3 discovers the test through its existing glob.

## Claims and decisions

- The guard covers every login except the cluster bootstrap administrator and every application group role. PostgreSQL resolves inherited, PUBLIC and owner access for each role. Grant options and column sets have distinct entries.
- The comparison includes user-defined tables, partitions, views, materialized views and foreign tables across application schemas. A stale exception also fails CI so a later regrant cannot reuse it.
- The existing migration test checks each application SECURITY DEFINER function's own search path, with zero exceptions. Its diagnostic includes the function signature.
- On the packet base, 189 privilege rows include four open BILLING-1 debts. Runtime has INSERT and SELECT on each of platform.billing_list_assignments and platform.billing_rate_tables. Booking has no effective application table grants. Connector address_installations is absent.

## Control and gates

The focused test passed on Docker. A disposable migration grants runtime INSERT and grants a new login SELECT on one column through group membership. The control checks both diagnostics and the SECURITY DEFINER guidance. Disabling the unexpected-grant rejection at 9892593a made the control fail with “Missing expected rejection.” Restoring it passed.

## Test it yourself

Run `node --import tsx --test test/postgres/application-grants.test.ts` with Docker available. Expect the migrated baseline and its temporary-migration control to pass.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "GRANTS-GUARD",
  "base": "08edc207bcd5be1982c9c0bcf1723172df9cb7ad",
  "head": "9892593a0e1a5e089c42111826d9267dacf4ca4b",
  "changedPaths": ["test/architecture/repository-hygiene.test.ts", "test/postgres/application-grants.test.ts", "test/postgres/application-grants.tsv"],
  "symbols": [{"path": "test/postgres/application-grants.test.ts", "name": "checkApplicationGrants"}]
}
```
