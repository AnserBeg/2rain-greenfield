# 2026-11-17 — CUSTOMIZE week-6 rehearsal: a new record type live from a plain-English request

Packet: [CUSTOMIZE](../packets/CUSTOMIZE.md). Source: CI run 44077868142 (PR #50, `packet/CUSTOMIZE-s5` at `1f95ed0d`), job "PostgreSQL schema and isolation", `test/postgres/customization-world.test.ts`; every CI job green in that run.

## What ran

On the `distributor` seed `pnpm dev` serves, one runtime opened as `pnpm dev` opens it and never restarted:

1. The request, in plain English: "Add an Equipment record with a name, serial number, purchase date and a status of in service, under repair or retired". CI holds no model key (charter), so the drafting model is scripted to propose the patch; the real model proposed the same kind of patch locally on 2026-11-17 in 2.4 s, Zod-valid on its first turn (record, Decisions).
2. Draft: the patch record, the tenant revision, the isolated-worker compile, the plain diff.
3. Approve: the storage plan prepared, the candidate verified, the approval binding the canonical and rendered diff digests.
4. Activate: the CAS swap with verification; the inventory scope advanced to the new release.
5. A first Equipment record created through the same runtime, with no restart.
6. First-party work under the live customization: the AGENT harness's "Reserve and ship from stock" and "Receive a placed purchase order in full" pass their own end-state checks.
7. Roll back in one step; then "Create and confirm a sales order" and "Invoice a shipped order and record full payment" pass.

## Result (CI runner)

| step | ms |
|---|---|
| draft (request to plain diff) | 4,910 |
| approve | 39,676 |
| activate | 1,150 |
| first record on the live record type | 862 |
| **request to live record** | **46,599** (bound 600,000) |
| roll back | 3,021 |

The same run's `customization.test.ts`: a drafted change is not served; an activation is served by the never-restarted runtime; a second runtime opening the database (the agent terminal's case) serves it and moves no pointer; a rollback hides it and keeps its rows; re-approval and activation show them again; a restart serves the customization.

## Not shown here

- The Customize screen (slice 3) is stopped for a ux-grammar seam ruling. Its browser journey (`apps/web/test/browser/customize.composed-application.spec.ts`, branch `packet/CUSTOMIZE-s3`) is not in this run. What was rehearsed is the service path the screen and `customize ask` share.
- A real-model drafting run in CI (no key in CI by charter).
