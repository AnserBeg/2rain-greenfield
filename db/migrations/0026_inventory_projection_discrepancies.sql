-- Preserve the observed projection before a rebuild replaces derived values.
-- This is evidence, not a second inventory authority.
CREATE TABLE north_star_internal.inventory_projection_discrepancies (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  discrepancy_id uuid NOT NULL DEFAULT gen_random_uuid(),
  projection_entity_id text NOT NULL,
  subject_identity jsonb NOT NULL,
  stored_row jsonb,
  recomputed_row jsonb,
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, discrepancy_id),
  CHECK (stored_row IS NOT NULL OR recomputed_row IS NOT NULL)
);

ALTER TABLE north_star_internal.inventory_projection_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE north_star_internal.inventory_projection_discrepancies FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_projection_discrepancies_scope
  ON north_star_internal.inventory_projection_discrepancies
  FOR SELECT TO north_star_module_runtime, north_star_module_materializer
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_projection_discrepancies_capture
  ON north_star_internal.inventory_projection_discrepancies
  FOR INSERT TO north_star_module_materializer
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
REVOKE ALL ON north_star_internal.inventory_projection_discrepancies FROM PUBLIC;
GRANT SELECT ON north_star_internal.inventory_projection_discrepancies TO north_star_module_runtime;
GRANT SELECT, INSERT ON north_star_internal.inventory_projection_discrepancies TO north_star_module_materializer;

CREATE RULE inventory_projection_discrepancies_reject_update
AS ON UPDATE TO north_star_internal.inventory_projection_discrepancies
DO INSTEAD INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
VALUES ('inventory_projection_discrepancies');
CREATE RULE inventory_projection_discrepancies_reject_delete
AS ON DELETE TO north_star_internal.inventory_projection_discrepancies
DO INSTEAD INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
VALUES ('inventory_projection_discrepancies');
