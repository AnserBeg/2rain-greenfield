# 5g3-freshtenant — bounded fresh-tenant install

Status: implementation candidate; Critical review round 1 addressed, new matrix pending

Tier: Critical

Base: `eff663f`

Authority: [ADR-0040](../../decisions/ADR-0040-bounded-fresh-tenant-install.md)

## Outcome

A fresh tenant still stages the complete immutable lineage and applies every
pairwise storage transition in order through the existing exact-transition,
preparation, materialization, approval, and activation path. Only the serving
release receives semantic verification admission. Each non-serving release
instead receives a distinct immutable transition-only admission scoped to the
exact tenant, environment, deterministic install ID, release identity, release
root, source root, and lineage ordinal. A partial install can resume only from
an intermediate release admitted by that exact incomplete install.
Transition-only admission expires when completed-install evidence exists; a
historical release selected to serve later must first gain ordinary semantic
verification admission.

Request entry independently refuses an active release carrying live
transition-only authority unless it also has ordinary semantic admission. An
intermediate pointer therefore remains transition authority for the installer
but cannot serve another request during the install window.
Every transition-only activation preparation also persists the exact install ID
and lineage ordinal under a foreign key to its intermediate admission; the
activation kernel rechecks both fields.

Completion persists `northstar.fresh-tenant-install-evidence/v1`. Its closed
document contains exactly:

- `schemaVersion`;
- `nonServingReleasesWithoutScenarioExecution`, with the tenant release ID and
  immutable root of every and only pre-head release;
- `appliedTransitions`, with every ordered source/target release-root pair; and
- `servingRelease`, with its tenant release ID, immutable root, and exact
  scenario count.

The runtime role has no direct INSERT privilege on the completed-evidence
table. Its only writer is `platform.record_fresh_tenant_install_evidence`, which
derives the expected document from the exact ordered intermediate admissions,
activation receipts, active serving pointer, and serving semantic partition;
requires byte-equivalent JSONB; derives the digest itself; and only then closes
the install.

The current document names these non-serving roots, in order:

```text
7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55
a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486
ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05
bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783
a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420
6bf235d970f0ffb12c676d5925dc18aa01f1ef04ea864f2c1c04aa60712325a1
57f2649094526e0f7cad7ddca275537b2e41089c90755529bf95914d5a379699
575ee2c33421dcdded6efba646f41695168e76acc5cabd3895abeb8a8989d66f
```

The serving root is
`9e3f36df340bc3db500929ca90f14a93238e0027799bcf782a9da6abda27d58d`
and its scenario count remains exactly 168. Tenant release IDs are minted per
install and are stored verbatim beside these stable roots.

## Controls

- **Measured effect.** The inherited parent exceeded 300 seconds and filled its
  256 MiB PostgreSQL tmpfs. With the bound in place, a quiet single fresh
  install took 17,424.0 ms. The unchanged two-tenant parent took 54,594.5 ms and
  peaked at 52,739,850 bytes (50.30 MiB) in PostgreSQL data. The tmpfs and test
  timeout were unchanged.
- **Same final schema.** A one-time oracle advanced a fresh database through the
  eight historical application heads via the real runtime and captured the
  resulting `north_star_module` catalog. Bounded replay is deep-compared with
  that checked-in snapshot. Changing one captured column name made the parent
  fail at this assertion; restoring it passes.
- **Every intermediate transition remains binding.** A control swaps two
  historical intermediate releases and requires the exact transition refusal.
  Restricting the preflight to the head made the control fail by reaching the
  deliberately unavailable database instead; restoring all-pair validation
  passes.
- **Serving verification is complete.** Durable semantic admissions contain
  only the serving root, and its executed-plus-derived partition equals both
  the compiled plan and the exact pre-bound count of 168. A follow-on rollback
  control makes the immediate historical release serve and observes that it
  gains normal semantic admission rather than reusing expired transition-only
  evidence.
- **Intermediate releases cannot serve.** A deterministic observation seam
  pauses after each real intermediate pointer swap. A separate real request
  loader refuses every one with `ACTIVE_RELEASE_NOT_ADMITTED`; the observed
  roots equal every and only pre-head lineage root.
- **Install binding remains load-bearing.** The control joins every
  transition-only preparation back to its admission and observes exact install
  ID and ordinal equality. The database foreign key and activation kernel use
  those same fields, while ordinary semantic preparations require both null.
- **Completed evidence has one closed writer.** Direct INSERT as
  `north_star_runtime` is refused with SQLSTATE 42501. Calling the sole recorder
  with empty release/transition arrays and an empty serving object is refused
  with SQLSTATE 23514; the valid immutable row remains unchanged.
- **Skipped-release evidence is exact.** The control derives the expected set
  independently from the entire compiled lineage, observes the persisted JSON
  document, and compares exact roots and transition pairs. Deliberately omitting
  the last non-serving release made the control fail on that precise root.

No scenario is marked derived by this install-path change. Normal upgrades and
rollbacks retain their prior per-target verification behavior.

The first repository matrix passed on the pre-review executable candidate at
`05cd790ba99b72564d337994b86421161cf0f539` with
`FULL_MATRIX_PASS_SHA=05cd790ba99b72564d337994b86421161cf0f539`.
Critical Codex review round 1 at
`778055c2e87fa056e8ac3553b7b151b350ecb32b` returned REVISE. Three findings
were accepted and fixed: the intermediate serving window, missing
install/ordinal consumption, and a durable completion boundary that trusted row
existence more strongly than its shape constraint. Its fourth finding was
dismissed: ADR-0020 defines complete semantic verification as the exact,
disjoint executed-plus-structural-derivation partition; this packet neither
creates nor reclassifies a derivation. Any executable fix invalidates the first
matrix and review. The corrected executable candidate
`5b2900874bad6e98b7b15028bb6b29b47604a599` passed the full repository matrix
with
`FULL_MATRIX_PASS_SHA=5b2900874bad6e98b7b15028bb6b29b47604a599`; its unchanged two-tenant parent
completed in 53,531.2 ms during that run. Critical review round 2 is performed
against the final narrative-only descendant of that executable tree.

## Artifact events

- `db/schema.snapshot.json` was regenerated from all 21 ordered migrations to
  record the two new immutable, tenant-scoped evidence relations.
- `test/postgres/fresh-tenant-full-replay-schema.snapshot.json` was generated by
  running the real composed runtime once per historical application head in a
  fresh database, then calling the repository's `captureSchemaSnapshot` over
  `north_star_module`. It is the independent full-replay oracle for Control B,
  not hand-maintained expected DDL.

## Load-bearing revisit

ADR-0040 §3 depends on releases and verification probes being tenant-invariant.
Tenant-specific compiled release divergence at G6 breaks that premise. The
revisit is recorded permanently as item 31 in
`docs/execution/stage-cut-inputs.md`; G6 must restore per-tenant verification for
divergent releases or prove a replacement before customization ships.
