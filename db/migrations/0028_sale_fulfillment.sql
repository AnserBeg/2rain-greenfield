-- Fulfillment is a companion posting family. Digest version 6 covers caller
-- shipment input while excluding the kernel-derived companion identities.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;
ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4, 5, 6));

CREATE ROLE north_star_fulfillment_projection_writer NOLOGIN INHERIT;
GRANT north_star_module_runtime TO north_star_fulfillment_projection_writer;
GRANT north_star_fulfillment_projection_writer TO north_star_runtime;
