-- PS-2 PROBE ONLY -- NOT FOR MERGE.
-- The goods-receipt command family digests at version 4. Migration 0017 is the
-- template ADR-0049 section 5 named, and this is that six-line change measured
-- rather than estimated: without it the FIRST receipt posting refuses, because
-- `digestCommand` has no arm admitting the `receipt` posting role at any
-- existing version.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;

ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4));
