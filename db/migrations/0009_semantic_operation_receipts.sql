CREATE TABLE platform.semantic_operation_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_content_hash text NOT NULL,
  action_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  input_digest text NOT NULL,
  mutation_result jsonb NOT NULL,
  invocation_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  change_document_id uuid NOT NULL,
  domain_event_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    environment_id,
    principal_id,
    release_id,
    release_content_hash,
    action_id,
    idempotency_key
  ),
  CONSTRAINT semantic_operation_receipts_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT semantic_operation_receipts_release_fkey
    FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT semantic_operation_receipts_invocation_fkey
    FOREIGN KEY (tenant_id, environment_id, invocation_id)
    REFERENCES platform.trust_action_invocations (
      tenant_id,
      environment_id,
      invocation_id
    ),
  CONSTRAINT semantic_operation_receipts_identity CHECK (
    btrim(action_id) <> ''
    AND release_content_hash ~ '^[0-9a-f]{64}$'
    AND input_digest ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(mutation_result) = 'object'
  )
);

CREATE RULE semantic_operation_receipts_reject_update
AS ON UPDATE TO platform.semantic_operation_receipts
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_operation_receipts');

CREATE RULE semantic_operation_receipts_reject_delete
AS ON DELETE TO platform.semantic_operation_receipts
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('semantic_operation_receipts');

ALTER TABLE platform.semantic_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.semantic_operation_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY semantic_operation_receipts_select_trusted_context
  ON platform.semantic_operation_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY semantic_operation_receipts_insert_trusted_context
  ON platform.semantic_operation_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

REVOKE ALL ON platform.semantic_operation_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON platform.semantic_operation_receipts TO north_star_runtime;
