CREATE TABLE platform.semantic_aggregate_anchors (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  cache_key text NOT NULL,
  query_id text NOT NULL,
  principal_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  legal_entity_ids uuid[] NOT NULL,
  parameter_values jsonb NOT NULL,
  temporal_horizons jsonb NOT NULL,
  filter_plan_digest text NOT NULL,
  result_kind text NOT NULL,
  selection_id text NOT NULL,
  balance_value text NOT NULL,
  result_precision smallint NOT NULL,
  result_scale smallint NOT NULL,
  base_unit_id text,
  anchor_digest text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, cache_key),
  CONSTRAINT semantic_aggregate_anchors_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_aggregate_anchors_shape CHECK (
    cache_key ~ '^[0-9a-f]{64}$'
    AND query_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(\.[a-z0-9_-]+)*$'
    AND release_content_hash ~ '^[0-9a-f]{64}$'
    AND cardinality(legal_entity_ids) BETWEEN 1 AND 64
    AND NOT ('00000000-0000-0000-0000-000000000000'::uuid = ANY(legal_entity_ids))
    AND jsonb_typeof(parameter_values) = 'object'
    AND jsonb_typeof(temporal_horizons) = 'object'
    AND filter_plan_digest ~ '^[0-9a-f]{64}$'
    AND result_kind IN ('exactDecimalResult', 'quantityResult')
    AND selection_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(\.[a-z0-9_-]+)*$'
    AND balance_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    AND balance_value <> '-0'
    AND result_precision = 38
    AND result_scale BETWEEN 0 AND 18
    AND (
      (result_kind = 'exactDecimalResult' AND base_unit_id IS NULL)
      OR (
        result_kind = 'quantityResult'
        AND base_unit_id IS NOT NULL
        AND btrim(base_unit_id) <> ''
      )
    )
    AND anchor_digest ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE platform.semantic_aggregate_anchor_discrepancies (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  discrepancy_id uuid NOT NULL,
  cache_key text NOT NULL,
  stored_anchor_digest text NOT NULL,
  expected_anchor_digest text NOT NULL,
  cached_balance_value text NOT NULL,
  recomputed_balance_value text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, discrepancy_id),
  CONSTRAINT semantic_aggregate_anchor_discrepancies_anchor_fkey
    FOREIGN KEY (tenant_id, environment_id, cache_key)
    REFERENCES platform.semantic_aggregate_anchors (
      tenant_id,
      environment_id,
      cache_key
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_aggregate_anchor_discrepancies_shape CHECK (
    cache_key ~ '^[0-9a-f]{64}$'
    AND stored_anchor_digest ~ '^[0-9a-f]{64}$'
    AND expected_anchor_digest ~ '^[0-9a-f]{64}$'
    AND cached_balance_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    AND recomputed_balance_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    AND cached_balance_value <> '-0'
    AND recomputed_balance_value <> '-0'
  )
);

CREATE RULE semantic_aggregate_anchors_reject_update
AS ON UPDATE TO platform.semantic_aggregate_anchors
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_aggregate_anchors');

CREATE RULE semantic_aggregate_anchors_reject_delete
AS ON DELETE TO platform.semantic_aggregate_anchors
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_aggregate_anchors');

CREATE RULE semantic_aggregate_anchor_discrepancies_reject_update
AS ON UPDATE TO platform.semantic_aggregate_anchor_discrepancies
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_aggregate_anchor_discrepancies');

CREATE RULE semantic_aggregate_anchor_discrepancies_reject_delete
AS ON DELETE TO platform.semantic_aggregate_anchor_discrepancies
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_aggregate_anchor_discrepancies');

ALTER TABLE platform.semantic_aggregate_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.semantic_aggregate_anchors FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.semantic_aggregate_anchor_discrepancies
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.semantic_aggregate_anchor_discrepancies
  FORCE ROW LEVEL SECURITY;

CREATE POLICY semantic_aggregate_anchors_select_trusted_context
  ON platform.semantic_aggregate_anchors
  AS PERMISSIVE
  FOR SELECT
  TO north_star_module_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY semantic_aggregate_anchors_insert_trusted_context
  ON platform.semantic_aggregate_anchors
  AS PERMISSIVE
  FOR INSERT
  TO north_star_module_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY semantic_aggregate_anchor_discrepancies_select_trusted_context
  ON platform.semantic_aggregate_anchor_discrepancies
  AS PERMISSIVE
  FOR SELECT
  TO north_star_module_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY semantic_aggregate_anchor_discrepancies_insert_trusted_context
  ON platform.semantic_aggregate_anchor_discrepancies
  AS PERMISSIVE
  FOR INSERT
  TO north_star_module_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

REVOKE ALL ON platform.semantic_aggregate_anchors FROM PUBLIC;
REVOKE ALL ON platform.semantic_aggregate_anchor_discrepancies FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO north_star_module_runtime;
GRANT SELECT, INSERT ON platform.semantic_aggregate_anchors
  TO north_star_module_runtime;
GRANT SELECT, INSERT ON platform.semantic_aggregate_anchor_discrepancies
  TO north_star_module_runtime;
