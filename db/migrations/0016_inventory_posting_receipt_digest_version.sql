-- Existing semantic-operation receipts keep their byte-identical v1 digest.
-- Inventory posting writes v2 explicitly; other receipt writers retain the v1
-- default until their own digest input changes under a versioned migration.
ALTER TABLE platform.semantic_operation_receipts
  ADD COLUMN input_digest_version smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
    CHECK (input_digest_version IN (1, 2));
