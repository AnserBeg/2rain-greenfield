# 5g3-restorenull — restore records with unset optional relations

Status: candidate

Tier: Critical

Base: `84ce920c75b9218a984e6a5efc3d3b6656d5dd7d`

## Outcome

Restore now reads each `restrict` relation's foreign key from the already
locked source record before it validates a target. An SQL null means that no
target exists to constrain recovery and is left unset. Every non-null value
continues through the existing target lookup, row lock, and archive check, so
an archived target still refuses with `MODULE_RELATION_VIOLATION` and an absent
target is still named `MODULE_RELATION_TARGET_NOT_FOUND`.

The implementation deliberately does not use an outer join. An outer join
would collapse an unset foreign key and a non-null foreign key whose target is
absent into one nullable target projection. The two-stage read preserves all
four states: unset, active, archived, and absent.

No relation declaration, archive behavior, module definition, migration,
tmpfs, budget, timeout, or baseline changed.

## Controls and negative directions

- **Unset optional target succeeds.** A generic fixture materializes an
  optional self-relation with `archiveBehavior: 'restrict'`, creates a record
  without that input, directly observes the physical foreign-key column as
  null, archives it, restores it, and observes the column still null. On the
  unfixed interpreter the real restore operation failed with
  `MODULE_RELATION_VIOLATION` at `assertRestorableRelations`; the control passes
  after the repair.
- **Archived target still refuses.** The same generic shape creates an explicit
  target and source, archives both, then requires source restore to refuse with
  `MODULE_RELATION_VIOLATION` and the exact relation ID. The control passed on
  the unfixed code. With only the archived-target predicate temporarily
  disabled, it failed with `Missing expected rejection`; restoring the
  predicate makes it pass again.
- **Generic recovery verification reaches the repair.** The unset-relation arm
  executes the complete candidate verification plan through
  `PostgresReleaseVerificationService` and the real interpreter, and observes
  an executed result for the entity's declared recovery scenario.

The controls reuse `test/postgres/module-runtime.test.ts`; no test-file
inventory changed.

## Dangling targets

The fixture queries the materialized PostgreSQL catalog and observes exactly
one relation foreign key with `convalidated = true`, `condeferrable = false`,
`confdeltype = 'r'`, and `confupdtype = 'r'`. The real create operation also
refuses a supplied unknown target with `MODULE_RELATION_TARGET_NOT_FOUND`.
Consequently, a non-null foreign key whose target row is absent is unreachable
through admitted product writes: creation is checked, PostgreSQL enforces the
validated constraint, target deletion is restricted, and business records have
no hard-delete path. The existing named absent-target refusal remains as
defence in depth, but bypassing those authorities to force it would not be a
production control.

## Sibling-path scan

The sibling create and parent-guard path is sound. `insertRecord` validates
only relation inputs that were supplied; `requireExistingParentGuards` reads
the source foreign key, explicitly continues for a nullable null, and sends
only a non-null UUID to `requireRelationTarget`. The archive-side dependent
check compares the foreign key directly, so a null cannot match a target.
The interpreter's remaining relation join is a list projection `LEFT JOIN`; it
does not infer a lifecycle verdict from row absence. No third relation or
lifecycle check with the defective nullable-inner-join shape was found.

## Gate evidence

Typecheck passes. Both focused PostgreSQL controls pass together after the
repair, including the generic recovery verification scenario, and the complete
PostgreSQL gate passes 151/151. The frozen full-matrix verdict is reported in
the writer handoff so measurement does not change the tested SHA.
