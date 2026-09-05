-- Admit `widenEnumDomain` to the storage transition element vocabulary.
--
-- `north_star_internal.module_storage_elements_shape` enumerates every element
-- kind the compiler may register as a text array, so a kind the compiler can
-- now emit is rejected by the CHECK until this migration lands. The constraint
-- is not visible to TypeScript, so nothing in the compiler build observes the
-- gap; `registerElement` fails at PREPARE time against a live tenant instead.
-- Migration 0022 recorded exactly this failure mode when it admitted
-- `relaxNotNull`, and this is the same rewrite shape.
--
-- `widenEnumDomain` replaces a released enum-domain CHECK with a superset of
-- itself, NOT VALID before and after, in one ALTER TABLE statement. It is the
-- transition `PUR-2c` measured as missing: a widened option list compiled,
-- prepared and activated with zero elements while the live CHECK kept
-- refusing the option the release advertised.
--
-- The list below is the full vocabulary, re-stated rather than appended to,
-- because the constraint holds one expression and Postgres has no ADD-to-array
-- form for it.
ALTER TABLE north_star_internal.module_storage_elements
  DROP CONSTRAINT module_storage_elements_shape;
ALTER TABLE north_star_internal.module_storage_elements
  ADD CONSTRAINT module_storage_elements_shape CHECK (
    btrim(element_id) <> ''
    AND element_kind IN (
      'addAbiFunctionCheck',
      'addColumn',
      'addForeignKey',
      'addNotValidConstraint',
      'backfill',
      'createCompanionTable',
      'createIndex',
      'createPartition',
      'createRejectMutationTrigger',
      'createTable',
      'duplicateScan',
      'relaxNotNull',
      'tightenNotNull',
      'validateConstraint',
      'widenEnumDomain'
    )
    AND btrim(physical_object_name) <> ''
    AND shape_fingerprint ~ '^[0-9a-f]{64}$'
  );
