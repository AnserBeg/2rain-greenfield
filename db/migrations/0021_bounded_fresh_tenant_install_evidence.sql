CREATE TABLE platform.fresh_tenant_intermediate_release_admissions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_evidence_id uuid NOT NULL,
  install_id uuid NOT NULL,
  lineage_ordinal integer NOT NULL,
  release_root text NOT NULL,
  source_release_root text,
  evidence_version text NOT NULL,
  evidence_digest text NOT NULL,
  admitted_by uuid NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, release_id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_evidence_unique
    UNIQUE (tenant_id, environment_id, release_evidence_id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_ordinal_unique
    UNIQUE (tenant_id, environment_id, install_id, lineage_ordinal),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_binding_unique
    UNIQUE (
      tenant_id,
      environment_id,
      release_id,
      install_id,
      lineage_ordinal
    ),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_candidate_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      release_evidence_id
    ) REFERENCES platform.tenant_releases (
      tenant_id,
      environment_id,
      release_id,
      verification_evidence_id
    ),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_shape CHECK (
    evidence_version =
      'northstar.fresh-tenant-intermediate-release-admission/v1'
    AND lineage_ordinal >= 0
    AND release_root ~ '^[0-9a-f]{64}$'
    AND (
      source_release_root IS NULL
      OR source_release_root ~ '^[0-9a-f]{64}$'
    )
    AND evidence_digest ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE platform.fresh_tenant_install_evidence (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  install_id uuid NOT NULL,
  serving_release_id uuid NOT NULL,
  serving_release_root text NOT NULL,
  serving_scenario_count integer NOT NULL,
  evidence_version text NOT NULL,
  evidence_document jsonb NOT NULL,
  evidence_digest text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, install_id),
  CONSTRAINT fresh_tenant_install_evidence_serving_release_fkey
    FOREIGN KEY (tenant_id, environment_id, serving_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT fresh_tenant_install_evidence_shape CHECK (
    serving_release_root ~ '^[0-9a-f]{64}$'
    AND serving_scenario_count >= 0
    AND evidence_version = 'northstar.fresh-tenant-install-evidence/v1'
    AND evidence_digest ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(evidence_document) = 'object'
    AND evidence_document ->> 'schemaVersion' =
      'northstar.fresh-tenant-install-evidence/v1'
    AND jsonb_typeof(
      evidence_document -> 'nonServingReleasesWithoutScenarioExecution'
    ) = 'array'
    AND jsonb_typeof(evidence_document -> 'appliedTransitions') = 'array'
    AND jsonb_typeof(evidence_document -> 'servingRelease') = 'object'
    AND (evidence_document -> 'servingRelease') - ARRAY[
      'releaseId',
      'releaseRoot',
      'scenarioCount'
    ]::text[] = '{}'::jsonb
    AND evidence_document #>> '{servingRelease,releaseId}' =
      serving_release_id::text
    AND evidence_document #>> '{servingRelease,releaseRoot}' =
      serving_release_root
    AND jsonb_typeof(
      evidence_document #> '{servingRelease,scenarioCount}'
    ) = 'number'
    AND (evidence_document #>> '{servingRelease,scenarioCount}')::integer =
      serving_scenario_count
    AND evidence_document - ARRAY[
      'schemaVersion',
      'nonServingReleasesWithoutScenarioExecution',
      'appliedTransitions',
      'servingRelease'
    ]::text[] = '{}'::jsonb
  )
);

ALTER TABLE platform.release_activation_preparations
  ADD COLUMN fresh_tenant_install_id uuid,
  ADD COLUMN fresh_tenant_lineage_ordinal integer,
  ADD CONSTRAINT release_activation_preparations_fresh_install_shape CHECK (
    (
      fresh_tenant_install_id IS NULL
      AND fresh_tenant_lineage_ordinal IS NULL
    ) OR (
      fresh_tenant_install_id IS NOT NULL
      AND fresh_tenant_lineage_ordinal >= 0
    )
  ),
  ADD CONSTRAINT release_activation_preparations_fresh_install_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      target_release_id,
      fresh_tenant_install_id,
      fresh_tenant_lineage_ordinal
    ) REFERENCES platform.fresh_tenant_intermediate_release_admissions (
      tenant_id,
      environment_id,
      release_id,
      install_id,
      lineage_ordinal
    );

CREATE RULE fresh_tenant_intermediate_release_admissions_reject_update
AS ON UPDATE TO platform.fresh_tenant_intermediate_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_intermediate_release_admissions');

CREATE RULE fresh_tenant_intermediate_release_admissions_reject_delete
AS ON DELETE TO platform.fresh_tenant_intermediate_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_intermediate_release_admissions');

CREATE RULE fresh_tenant_install_evidence_reject_update
AS ON UPDATE TO platform.fresh_tenant_install_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_install_evidence');

CREATE RULE fresh_tenant_install_evidence_reject_delete
AS ON DELETE TO platform.fresh_tenant_install_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_install_evidence');

ALTER TABLE platform.fresh_tenant_intermediate_release_admissions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_intermediate_release_admissions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_install_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_install_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY fresh_tenant_intermediate_admissions_select_trusted_context
  ON platform.fresh_tenant_intermediate_release_admissions
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY fresh_tenant_intermediate_admissions_insert_trusted_context
  ON platform.fresh_tenant_intermediate_release_admissions
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND admitted_by =
      nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY fresh_tenant_install_evidence_select_trusted_context
  ON platform.fresh_tenant_install_evidence
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE FUNCTION platform.record_fresh_tenant_install_evidence(
  requested_install_id uuid,
  requested_serving_release_id uuid,
  requested_serving_release_root text,
  requested_serving_scenario_count integer,
  requested_document jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$ DECLARE
  trusted_tenant_id uuid :=
    nullif(current_setting('north_star.tenant_id', true), '')::uuid;
  trusted_environment_id uuid :=
    nullif(current_setting('north_star.environment_id', true), '')::uuid;
  trusted_principal_id uuid :=
    nullif(current_setting('north_star.principal_id', true), '')::uuid;
  intermediate_count integer;
  intermediate_chain_exact boolean;
  intermediate_activation_count integer;
  intermediate_semantic_count integer;
  serving_partition_count integer;
  expected_document jsonb;
  expected_digest text;
  stored_digest text;
  stored_document jsonb; BEGIN
  IF trusted_tenant_id IS NULL
     OR trusted_environment_id IS NULL
     OR trusted_principal_id IS NULL THEN
    RAISE EXCEPTION 'trusted fresh-tenant evidence context is required'
      USING ERRCODE = '42501'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      format(
        'northstar.fresh-tenant-install/v1:%s:%s:%s',
        trusted_tenant_id,
        trusted_environment_id,
        requested_install_id
      ),
      0
    )
  );

  WITH ordered AS (
    SELECT intermediate.*,
           row_number() OVER (ORDER BY lineage_ordinal) - 1 AS expected_ordinal,
           lag(release_id) OVER (ORDER BY lineage_ordinal) AS prior_release_id,
           lag(release_root) OVER (ORDER BY lineage_ordinal) AS prior_root
      FROM platform.fresh_tenant_intermediate_release_admissions AS intermediate
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  )
  SELECT count(*)::integer,
         coalesce(
           bool_and(
             lineage_ordinal = expected_ordinal
             AND (
               (lineage_ordinal = 0 AND source_release_root IS NULL)
               OR (
                 lineage_ordinal > 0
                 AND source_release_root = prior_root
               )
             )
           ),
           false
         ),
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM platform.release_activation_swap_receipts AS swap
              WHERE swap.tenant_id = ordered.tenant_id
                AND swap.environment_id = ordered.environment_id
                AND swap.previous_release_id IS NOT DISTINCT FROM
                    ordered.prior_release_id
                AND swap.activated_release_id = ordered.release_id
           )
         )::integer,
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM platform.tenant_release_admissions AS semantic
              WHERE semantic.tenant_id = ordered.tenant_id
                AND semantic.environment_id = ordered.environment_id
                AND semantic.release_id = ordered.release_id
           )
         )::integer
    INTO intermediate_count,
         intermediate_chain_exact,
         intermediate_activation_count,
         intermediate_semantic_count
    FROM ordered;

  IF intermediate_count = 0
     OR NOT intermediate_chain_exact
     OR intermediate_activation_count <> intermediate_count
     OR intermediate_semantic_count <> 0 THEN
    RAISE EXCEPTION 'fresh-tenant intermediate lineage is incomplete or semantically admitted'
      USING ERRCODE = '23514'; END IF;

  SELECT evidence.result_count +
         CASE
           WHEN evidence.impact_analysis_derivation IS NULL THEN 0
           ELSE jsonb_array_length(
             evidence.impact_analysis_derivation -> 'derivations'
           ) END
    INTO serving_partition_count
    FROM platform.tenant_release_admissions AS admission
    JOIN platform.release_verification_evidence AS evidence
      ON evidence.tenant_id = admission.tenant_id
     AND evidence.environment_id = admission.environment_id
     AND evidence.verification_evidence_id = admission.verification_evidence_id
    JOIN platform.tenant_releases AS release
      ON release.tenant_id = admission.tenant_id
     AND release.environment_id = admission.environment_id
     AND release.release_id = admission.release_id
    JOIN platform.active_release_pointers AS pointer
      ON pointer.tenant_id = admission.tenant_id
     AND pointer.environment_id = admission.environment_id
     AND pointer.release_id = admission.release_id
   WHERE admission.tenant_id = trusted_tenant_id
     AND admission.environment_id = trusted_environment_id
     AND admission.release_id = requested_serving_release_id
     AND release.content_hash = requested_serving_release_root
     AND evidence.release_root = requested_serving_release_root
     AND EXISTS (
       SELECT 1
         FROM platform.release_activation_swap_receipts AS swap
        WHERE swap.tenant_id = trusted_tenant_id
          AND swap.environment_id = trusted_environment_id
          AND swap.previous_release_id = (
            SELECT release_id
              FROM platform.fresh_tenant_intermediate_release_admissions
             WHERE tenant_id = trusted_tenant_id
               AND environment_id = trusted_environment_id
               AND install_id = requested_install_id
             ORDER BY lineage_ordinal DESC
             LIMIT 1
          )
          AND swap.activated_release_id = requested_serving_release_id
     );

  IF serving_partition_count IS DISTINCT FROM requested_serving_scenario_count THEN
    RAISE EXCEPTION 'fresh-tenant serving release lacks its exact semantic partition'
      USING ERRCODE = '23514'; END IF;

  WITH intermediate AS (
    SELECT *
      FROM platform.fresh_tenant_intermediate_release_admissions
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  ), transition_rows AS (
    SELECT lineage_ordinal,
           jsonb_build_object(
             'sourceReleaseRoot', source_release_root,
             'targetReleaseRoot', release_root
           ) AS transition
      FROM intermediate
     WHERE lineage_ordinal > 0
    UNION ALL
    SELECT max(lineage_ordinal) + 1,
           jsonb_build_object(
             'sourceReleaseRoot',
             (array_agg(release_root ORDER BY lineage_ordinal DESC))[1],
             'targetReleaseRoot', requested_serving_release_root
           )
      FROM intermediate
  )
  SELECT jsonb_build_object(
           'schemaVersion', 'northstar.fresh-tenant-install-evidence/v1',
           'nonServingReleasesWithoutScenarioExecution',
           (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'releaseId', release_id,
                        'releaseRoot', release_root
                      )
                      ORDER BY lineage_ordinal
                    )
               FROM intermediate
           ),
           'appliedTransitions',
           (
             SELECT jsonb_agg(transition ORDER BY lineage_ordinal)
               FROM transition_rows
           ),
           'servingRelease',
           jsonb_build_object(
             'releaseId', requested_serving_release_id,
             'releaseRoot', requested_serving_release_root,
             'scenarioCount', requested_serving_scenario_count
           )
         )
    INTO expected_document;

  IF requested_document IS DISTINCT FROM expected_document THEN
    RAISE EXCEPTION 'fresh-tenant evidence document does not equal durable install facts'
      USING ERRCODE = '23514'; END IF;

  expected_digest := encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'northstar.fresh-tenant-install-evidence/v1',
        'UTF8'
      ) || decode('00', 'hex') ||
      pg_catalog.convert_to(expected_document::text, 'UTF8')
    ),
    'hex'
  );

  INSERT INTO platform.fresh_tenant_install_evidence (
    tenant_id, environment_id, install_id, serving_release_id,
    serving_release_root, serving_scenario_count, evidence_version,
    evidence_document, evidence_digest, created_by
  ) SELECT
    trusted_tenant_id, trusted_environment_id, requested_install_id,
    requested_serving_release_id, requested_serving_release_root,
    requested_serving_scenario_count,
    'northstar.fresh-tenant-install-evidence/v1', expected_document,
    expected_digest, trusted_principal_id
  WHERE NOT EXISTS (
    SELECT 1
      FROM platform.fresh_tenant_install_evidence
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  );

  SELECT evidence_digest, evidence_document
    INTO stored_digest, stored_document
    FROM platform.fresh_tenant_install_evidence
   WHERE tenant_id = trusted_tenant_id
     AND environment_id = trusted_environment_id
     AND install_id = requested_install_id;

  IF stored_digest IS DISTINCT FROM expected_digest
     OR stored_document IS DISTINCT FROM expected_document THEN
    RAISE EXCEPTION 'stored fresh-tenant evidence differs from durable install facts'
      USING ERRCODE = '23514'; END IF;

  RETURN expected_digest; END;
$$;

REVOKE ALL ON platform.fresh_tenant_intermediate_release_admissions FROM PUBLIC;
REVOKE ALL ON platform.fresh_tenant_install_evidence FROM PUBLIC;
GRANT SELECT, INSERT ON platform.fresh_tenant_intermediate_release_admissions
  TO north_star_runtime;
GRANT SELECT ON platform.fresh_tenant_install_evidence TO north_star_runtime;
REVOKE ALL ON FUNCTION platform.record_fresh_tenant_install_evidence(
  uuid, uuid, text, integer, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_fresh_tenant_install_evidence(
  uuid, uuid, text, integer, jsonb
) TO north_star_runtime;
