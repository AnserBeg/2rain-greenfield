-- PUR-2a. Stock-count posting commands no longer carry a caller-authored
-- transaction id or per-line transaction line id: the kernel derives both from
-- the source record ids and writes them inside the posting transaction. That
-- changes the DIGEST INPUT, and 0016 states the governing rule in its own text
-- -- a writer "retains the v1 default until their own digest input changes
-- under a versioned migration." This is that migration.
--
-- Version 3 is retained, not replaced. A receipt written before this change
-- decodes by its stored version and is never recomputed under version 4; the
-- posting service refuses to re-derive a version-3 stock-count digest from the
-- derived-companion command shape rather than producing a value that would
-- silently disagree with what is stored.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;

ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4));
