CREATE TABLE platform.trust_immutable_write_guard (
  attempted_relation text NOT NULL,
  CONSTRAINT trust_immutable_write_guard_reject CHECK (false)
);

CREATE FUNCTION platform.trust_json_contains_exposed_classified_value(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$ DECLARE nested jsonb; BEGIN
  IF jsonb_typeof(document) = 'object' THEN
    IF document ->> 'classification' IN ('SECRET', 'SENSITIVE')
       AND document ? 'value' THEN
      RETURN true; END IF;
    FOR nested IN SELECT value FROM jsonb_each(document)
    LOOP
      IF platform.trust_json_contains_exposed_classified_value(nested) THEN
        RETURN true; END IF; END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR nested IN SELECT value FROM jsonb_array_elements(document)
    LOOP
      IF platform.trust_json_contains_exposed_classified_value(nested) THEN
        RETURN true; END IF; END LOOP; END IF;
  RETURN false; END $$;

CREATE TABLE platform.trust_action_invocations (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  invocation_id uuid NOT NULL,
  invocation_version text NOT NULL,
  request_id uuid NOT NULL,
  action_id text NOT NULL,
  channel text NOT NULL,
  outcome text NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  release_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  execution_principal_kind text NOT NULL,
  execution_principal_id uuid NOT NULL,
  subject_principal_kind text,
  subject_principal_id uuid,
  initiating_human_id uuid,
  approving_human_id uuid,
  delegation_id uuid,
  delegating_principal_kind text,
  delegating_principal_id uuid,
  delegated_to_principal_kind text,
  delegated_to_principal_id uuid,
  policy_evidence_version text NOT NULL,
  policy_decision text NOT NULL,
  policy_version text NOT NULL,
  policy_evaluator_version text NOT NULL,
  policy_inputs jsonb NOT NULL,
  metadata jsonb NOT NULL,
  failure_code text,
  change_document_id uuid,
  domain_event_id uuid,
  outbox_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, invocation_id),
  CONSTRAINT trust_action_invocations_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT trust_action_invocations_release_fkey
    FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT trust_action_invocations_outcome_identity_unique
    UNIQUE (tenant_id, environment_id, invocation_id, outcome),
  CONSTRAINT trust_action_invocations_correlation_identity_unique
    UNIQUE (
      tenant_id,
      environment_id,
      invocation_id,
      outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ),
  CONSTRAINT trust_action_invocations_version CHECK (
    invocation_version = 'northstar.action-invocation/v1'
    AND policy_evidence_version = 'northstar.policy-decision-evidence/v1'
  ),
  CONSTRAINT trust_action_invocations_text_not_blank CHECK (
    btrim(action_id) <> ''
    AND btrim(policy_version) <> ''
    AND btrim(policy_evaluator_version) <> ''
  ),
  CONSTRAINT trust_action_invocations_sha256 CHECK (
    release_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT trust_action_invocations_channel CHECK (
    channel IN ('AGENT', 'API', 'IMPORT', 'SYSTEM', 'UI', 'WORKFLOW')
  ),
  CONSTRAINT trust_action_invocations_outcome CHECK (
    outcome IN ('DENIED', 'FAILED', 'SUCCEEDED', 'TIMED_OUT')
  ),
  CONSTRAINT trust_action_invocations_actor_kind CHECK (
    execution_principal_kind IN (
      'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
    )
    AND (
      subject_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      )
      OR subject_principal_kind IS NULL
    )
  ),
  CONSTRAINT trust_action_invocations_subject_pair CHECK (
    (subject_principal_kind IS NULL) = (subject_principal_id IS NULL)
  ),
  CONSTRAINT trust_action_invocations_delegation_shape CHECK (
    (
      delegation_id IS NULL
      AND delegating_principal_kind IS NULL
      AND delegating_principal_id IS NULL
      AND delegated_to_principal_kind IS NULL
      AND delegated_to_principal_id IS NULL
    ) OR (
      delegation_id IS NOT NULL
      AND delegating_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      )
      AND delegating_principal_id IS NOT NULL
      AND delegated_to_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      )
      AND delegated_to_principal_id IS NOT NULL
      AND delegated_to_principal_kind = execution_principal_kind
      AND delegated_to_principal_id = execution_principal_id
    )
  ),
  CONSTRAINT trust_action_invocations_policy_decision CHECK (
    policy_decision IN ('ALLOW', 'DENY')
    AND (outcome <> 'DENIED' OR policy_decision = 'DENY')
    AND (outcome <> 'SUCCEEDED' OR policy_decision = 'ALLOW')
  ),
  CONSTRAINT trust_action_invocations_metadata_shape CHECK (
    jsonb_typeof(policy_inputs) = 'object'
    AND jsonb_typeof(metadata) = 'object'
    AND NOT platform.trust_json_contains_exposed_classified_value(policy_inputs)
    AND NOT platform.trust_json_contains_exposed_classified_value(metadata)
  ),
  CONSTRAINT trust_action_invocations_fact_shape CHECK (
    (
      outcome = 'SUCCEEDED'
      AND failure_code IS NULL
      AND change_document_id IS NOT NULL
      AND domain_event_id IS NOT NULL
      AND outbox_id IS NOT NULL
    ) OR (
      outcome IN ('DENIED', 'FAILED', 'TIMED_OUT')
      AND failure_code IS NOT NULL
      AND btrim(failure_code) <> ''
      AND change_document_id IS NULL
      AND domain_event_id IS NULL
      AND outbox_id IS NULL
    )
  )
);

CREATE TABLE platform.trust_business_change_documents (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  change_document_id uuid NOT NULL,
  document_version text NOT NULL,
  invocation_id uuid NOT NULL,
  invocation_outcome text NOT NULL DEFAULT 'SUCCEEDED',
  request_id uuid NOT NULL,
  action_id text NOT NULL,
  correlation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL,
  changes jsonb NOT NULL,
  execution_principal_kind text NOT NULL,
  execution_principal_id uuid NOT NULL,
  subject_principal_kind text,
  subject_principal_id uuid,
  initiating_human_id uuid,
  approving_human_id uuid,
  delegation_id uuid,
  delegating_principal_kind text,
  delegating_principal_id uuid,
  delegated_to_principal_kind text,
  delegated_to_principal_id uuid,
  domain_event_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, change_document_id),
  CONSTRAINT trust_business_change_documents_invocation_unique
    UNIQUE (tenant_id, environment_id, invocation_id),
  CONSTRAINT trust_business_change_documents_link_unique
    UNIQUE (tenant_id, environment_id, change_document_id, invocation_id),
  CONSTRAINT trust_business_change_documents_invocation_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      invocation_id,
      invocation_outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) REFERENCES platform.trust_action_invocations (
      tenant_id,
      environment_id,
      invocation_id,
      outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_business_change_documents_version CHECK (
    document_version = 'northstar.business-change-document/v1'
    AND invocation_outcome = 'SUCCEEDED'
  ),
  CONSTRAINT trust_business_change_documents_identity CHECK (
    btrim(action_id) <> ''
    AND btrim(record_type) <> ''
    AND btrim(record_id) <> ''
    AND release_content_hash ~ '^[0-9a-f]{64}$'
    AND revision > 0
  ),
  CONSTRAINT trust_business_change_documents_changes CHECK (
    jsonb_typeof(changes) = 'array'
    AND jsonb_array_length(changes) > 0
    AND NOT platform.trust_json_contains_exposed_classified_value(changes)
  ),
  CONSTRAINT trust_business_change_documents_actor_kind CHECK (
    execution_principal_kind IN (
      'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
    )
    AND (
      subject_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      ) OR subject_principal_kind IS NULL
    )
  ),
  CONSTRAINT trust_business_change_documents_subject_pair CHECK (
    (subject_principal_kind IS NULL) = (subject_principal_id IS NULL)
  ),
  CONSTRAINT trust_business_change_documents_delegation_shape CHECK (
    (
      delegation_id IS NULL
      AND delegating_principal_kind IS NULL
      AND delegating_principal_id IS NULL
      AND delegated_to_principal_kind IS NULL
      AND delegated_to_principal_id IS NULL
    ) OR (
      delegation_id IS NOT NULL
      AND delegating_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      )
      AND delegating_principal_id IS NOT NULL
      AND delegated_to_principal_kind IN (
        'AGENT', 'AUTOMATION', 'HUMAN', 'SERVICE', 'SYSTEM'
      )
      AND delegated_to_principal_id IS NOT NULL
      AND delegated_to_principal_kind = execution_principal_kind
      AND delegated_to_principal_id = execution_principal_id
    )
  )
);

CREATE TABLE platform.trust_domain_events (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  domain_event_id uuid NOT NULL,
  domain_event_version text NOT NULL,
  invocation_id uuid NOT NULL,
  invocation_outcome text NOT NULL DEFAULT 'SUCCEEDED',
  change_document_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action_id text NOT NULL,
  correlation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  event_type text NOT NULL,
  event_schema_version text NOT NULL,
  payload jsonb NOT NULL,
  outbox_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, domain_event_id),
  CONSTRAINT trust_domain_events_invocation_unique
    UNIQUE (tenant_id, environment_id, invocation_id),
  CONSTRAINT trust_domain_events_link_unique
    UNIQUE (tenant_id, environment_id, domain_event_id, invocation_id),
  CONSTRAINT trust_domain_events_invocation_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      invocation_id,
      invocation_outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) REFERENCES platform.trust_action_invocations (
      tenant_id,
      environment_id,
      invocation_id,
      outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_domain_events_change_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      change_document_id,
      invocation_id
    ) REFERENCES platform.trust_business_change_documents (
      tenant_id,
      environment_id,
      change_document_id,
      invocation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_domain_events_version CHECK (
    domain_event_version = 'northstar.trust-domain-event/v1'
    AND invocation_outcome = 'SUCCEEDED'
  ),
  CONSTRAINT trust_domain_events_identity CHECK (
    btrim(action_id) <> ''
    AND btrim(event_type) <> ''
    AND btrim(event_schema_version) <> ''
    AND release_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT trust_domain_events_payload CHECK (
    jsonb_typeof(payload) = 'object'
    AND NOT platform.trust_json_contains_exposed_classified_value(payload)
  )
);

CREATE TABLE platform.trust_outbox (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  outbox_version text NOT NULL,
  invocation_id uuid NOT NULL,
  invocation_outcome text NOT NULL DEFAULT 'SUCCEEDED',
  change_document_id uuid NOT NULL,
  domain_event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action_id text NOT NULL,
  correlation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  event_type text NOT NULL,
  event_schema_version text NOT NULL,
  deduplication_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, outbox_id),
  CONSTRAINT trust_outbox_invocation_unique
    UNIQUE (tenant_id, environment_id, invocation_id),
  CONSTRAINT trust_outbox_link_unique
    UNIQUE (tenant_id, environment_id, outbox_id, invocation_id),
  CONSTRAINT trust_outbox_deduplication_unique
    UNIQUE (tenant_id, environment_id, deduplication_key),
  CONSTRAINT trust_outbox_invocation_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      invocation_id,
      invocation_outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) REFERENCES platform.trust_action_invocations (
      tenant_id,
      environment_id,
      invocation_id,
      outcome,
      request_id,
      action_id,
      correlation_id,
      release_id,
      release_content_hash
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_outbox_change_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      change_document_id,
      invocation_id
    ) REFERENCES platform.trust_business_change_documents (
      tenant_id,
      environment_id,
      change_document_id,
      invocation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_outbox_event_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      domain_event_id,
      invocation_id
    ) REFERENCES platform.trust_domain_events (
      tenant_id,
      environment_id,
      domain_event_id,
      invocation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT trust_outbox_version CHECK (
    outbox_version = 'northstar.trust-outbox/v1'
    AND invocation_outcome = 'SUCCEEDED'
  ),
  CONSTRAINT trust_outbox_identity CHECK (
    btrim(action_id) <> ''
    AND btrim(event_type) <> ''
    AND btrim(event_schema_version) <> ''
    AND btrim(deduplication_key) <> ''
    AND release_content_hash ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE platform.trust_action_invocations
  ADD CONSTRAINT trust_action_invocations_change_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    change_document_id,
    invocation_id
  ) REFERENCES platform.trust_business_change_documents (
    tenant_id,
    environment_id,
    change_document_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT trust_action_invocations_event_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    domain_event_id,
    invocation_id
  ) REFERENCES platform.trust_domain_events (
    tenant_id,
    environment_id,
    domain_event_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT trust_action_invocations_outbox_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) REFERENCES platform.trust_outbox (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE platform.trust_business_change_documents
  ADD CONSTRAINT trust_business_change_documents_event_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    domain_event_id,
    invocation_id
  ) REFERENCES platform.trust_domain_events (
    tenant_id,
    environment_id,
    domain_event_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT trust_business_change_documents_outbox_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) REFERENCES platform.trust_outbox (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE platform.trust_domain_events
  ADD CONSTRAINT trust_domain_events_outbox_fkey
  FOREIGN KEY (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) REFERENCES platform.trust_outbox (
    tenant_id,
    environment_id,
    outbox_id,
    invocation_id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE RULE trust_action_invocations_reject_update
AS ON UPDATE TO platform.trust_action_invocations
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_action_invocations');

CREATE RULE trust_action_invocations_reject_delete
AS ON DELETE TO platform.trust_action_invocations
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_action_invocations');

CREATE RULE trust_business_change_documents_reject_update
AS ON UPDATE TO platform.trust_business_change_documents
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_business_change_documents');

CREATE RULE trust_business_change_documents_reject_delete
AS ON DELETE TO platform.trust_business_change_documents
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_business_change_documents');

CREATE RULE trust_domain_events_reject_update
AS ON UPDATE TO platform.trust_domain_events
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_domain_events');

CREATE RULE trust_domain_events_reject_delete
AS ON DELETE TO platform.trust_domain_events
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_domain_events');

CREATE RULE trust_outbox_reject_update
AS ON UPDATE TO platform.trust_outbox
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_outbox');

CREATE RULE trust_outbox_reject_delete
AS ON DELETE TO platform.trust_outbox
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('trust_outbox');

ALTER TABLE platform.trust_action_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_action_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_business_change_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_business_change_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_domain_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.trust_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY trust_action_invocations_select_trusted_context
  ON platform.trust_action_invocations
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY trust_action_invocations_insert_trusted_context
  ON platform.trust_action_invocations
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND execution_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
    AND request_id = nullif(current_setting('north_star.request_id', true), '')::uuid
  );

CREATE POLICY trust_business_change_documents_select_trusted_context
  ON platform.trust_business_change_documents
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY trust_business_change_documents_insert_trusted_context
  ON platform.trust_business_change_documents
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND execution_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
    AND request_id = nullif(current_setting('north_star.request_id', true), '')::uuid
  );

CREATE POLICY trust_domain_events_select_trusted_context
  ON platform.trust_domain_events
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY trust_domain_events_insert_trusted_context
  ON platform.trust_domain_events
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND request_id = nullif(current_setting('north_star.request_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY trust_outbox_select_trusted_context
  ON platform.trust_outbox
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY trust_outbox_insert_trusted_context
  ON platform.trust_outbox
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND request_id = nullif(current_setting('north_star.request_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

REVOKE ALL ON platform.trust_immutable_write_guard FROM PUBLIC;
REVOKE ALL ON platform.trust_action_invocations FROM PUBLIC;
REVOKE ALL ON platform.trust_business_change_documents FROM PUBLIC;
REVOKE ALL ON platform.trust_domain_events FROM PUBLIC;
REVOKE ALL ON platform.trust_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.trust_json_contains_exposed_classified_value(jsonb)
  FROM PUBLIC;

GRANT SELECT, INSERT ON platform.trust_action_invocations TO north_star_runtime;
GRANT SELECT, INSERT ON platform.trust_business_change_documents TO north_star_runtime;
GRANT SELECT, INSERT ON platform.trust_domain_events TO north_star_runtime;
GRANT SELECT, INSERT ON platform.trust_outbox TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.trust_json_contains_exposed_classified_value(jsonb)
  TO north_star_runtime;
