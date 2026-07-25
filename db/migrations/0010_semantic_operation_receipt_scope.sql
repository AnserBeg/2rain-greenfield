-- An idempotency key belongs to one tenant/environment/action, not to the
-- principal or release that first recorded it. If migration 0009 data contains
-- duplicates under that narrower identity, adding this constraint fails with a
-- unique violation. The migration runner then rolls back the whole migration:
-- no immutable receipt is edited, deleted, or silently selected as canonical.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_pkey,
  ADD CONSTRAINT semantic_operation_receipts_pkey PRIMARY KEY (
    tenant_id,
    environment_id,
    action_id,
    idempotency_key
  );

DROP POLICY semantic_operation_receipts_select_trusted_context
  ON platform.semantic_operation_receipts;
DROP POLICY semantic_operation_receipts_insert_trusted_context
  ON platform.semantic_operation_receipts;

-- Receipt visibility is intentionally tenant/environment scoped so a retry by
-- another principal finds the existing key. Application code checks the
-- recorded principal before exposing mutation_result and returns a typed
-- conflict on mismatch.
CREATE POLICY semantic_operation_receipts_select_trusted_context
  ON platform.semantic_operation_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY semantic_operation_receipts_insert_trusted_context
  ON platform.semantic_operation_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
