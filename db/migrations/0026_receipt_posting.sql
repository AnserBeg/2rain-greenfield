-- Receipt is a new command family. Its digest covers caller input, excluding
-- derived companion identities. Existing receipt versions remain readable.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;
ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4, 5));

CREATE ROLE north_star_receipt_projection_writer NOLOGIN INHERIT;
GRANT north_star_module_runtime TO north_star_receipt_projection_writer;
GRANT north_star_receipt_projection_writer TO north_star_runtime;
