# RELATION-INSTALL — owner-run online review, round 1

Repository: `AnserBeg/2rain-greenfield`.
Branch: `packet/RELATION-INSTALL`; PR base: `packet/PAYABLES`.
Base SHA: `96ac234122322b2cbe18349299664f56c8f5190a`.
Frozen executable SHA: `76a3628c3e43a7512258f005083040e29e5add52`.
Executable commits: `fc4d68d298f8fbab88000f4f7808db7e848f4961`, `a87e719d0c02907132a7accb843f6b82ce9061b6`, `e1e8c70f6692ffd11d4b270a2cc8bc8e70d192d3`, `f62caa5273271c7dcf41914cdc865addc1768767`, `d59e1d4a1c2b5183067dd36d5eb5680f19fcb23d`.
Base integration commit: `76a3628c3e43a7512258f005083040e29e5add52`.
Narrative commit before this executable SHA: `d0ba97178d2e9ebb93c9beb828860548c1472a5c`.
Critical path changed: `packages/postgres-provider/src/module-storage-materializer.ts`.
Function changed: `locateColumn` adds a declared-relation lookup keyed by relation ID and physical column name, returns relation-column storage attributes and resolves its source entity.
Functions unchanged but used by this path: `applyDdlElement` (`addColumn`, `addForeignKey`, `createIndex`), `createManagedTable`, `entityOwnedMutableColumnNames`.
Test changed: `test/postgres/composed-application.test.ts`, `relationInstallBase`, `appendRelationSuccessor`, `copyRelationFixtureRow`, synthetic initial release and relation successor on one tenant, catalog/privilege assertions, gateway create and foreign-company writes; preparation codes included in failure messages.
Controls: `test/evidence/RELATION-INSTALL.expected-red.json`, three entries.
App definition and release lineage: no changed paths.
Reading inputs: `docs/architecture/posting-kernel-guarantees.md` and the Critical-path diff from the base SHA to the frozen executable SHA.

1. For a release adding an optional declared relation to an existing table, is there a production defect in relation-target lookup or nullable preparation?
2. Can the installed FK/index differ from the pinned relation's names or scoped columns, or can a foreign-company target become linked through this path?
3. Does the existing add-column grant handling give this relation column different privileges from a creation-time relation column, broaden table UPDATE, or prevent a governed write?
4. Does this prompt steer your review? Say plainly if it does.
