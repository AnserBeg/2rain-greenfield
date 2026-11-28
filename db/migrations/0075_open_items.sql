-- OPEN-ITEM-1 slice 1: the open-item core's storage (design note v2 sections 3
-- and 5, with its binding read's amendments 6 and 8). Three tables and three
-- functions, all general: they name no record type, field or module. The
-- core's business work (locks, sums, state, balances) runs in TypeScript over
-- the release's generated tables; only the grant and the number live here.
--
-- Lock order of one core operation (amendment 9): the grant (position 0, in
-- open_item_consume_grant), the counterparty advisory lock, every touched
-- item row sorted by record ID, and the number counter LAST (an issue only).

-- An attested human confirmation, consumed once by the matching operation.
-- The ledger's grant shape (0074) in the core's own table (rule 19: one engine
-- never names another's tables), plus the transaction that consumed it, which
-- binds a number allocation to that one confirmed issue. One shared grant
-- table for every engine is HARDENING-PASS debt (the third copy, rule 17).
-- Rows are kept forever as the record of what a person confirmed.
CREATE TABLE platform.open_item_approval_grants (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  capability_id text NOT NULL CHECK (capability_id ~ '^northstar\.openitem:capability\.[a-z][a-z0-9_]*$'),
  principal_id uuid NOT NULL,
  human_id uuid NOT NULL,
  release_id uuid NOT NULL,
  fence bigint NOT NULL,
  operation_id text NOT NULL,
  request_key uuid NOT NULL,
  input jsonb NOT NULL,
  channel text NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  invocation_id uuid,
  consumed_xact xid8,
  PRIMARY KEY (tenant_id, environment_id, grant_id),
  UNIQUE (grant_id),
  CHECK ((consumed_at IS NULL) = (invocation_id IS NULL) AND (consumed_at IS NULL) = (consumed_xact IS NULL)),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
CREATE FUNCTION north_star_internal.open_item_grant_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'openItem.grantImmutable'; END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR (to_jsonb(NEW) - 'consumed_at' - 'invocation_id' - 'consumed_xact')
        <> (to_jsonb(OLD) - 'consumed_at' - 'invocation_id' - 'consumed_xact') THEN
    RAISE EXCEPTION 'openItem.grantImmutable'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER open_item_approval_grants_immutable BEFORE UPDATE OR DELETE ON platform.open_item_approval_grants
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.open_item_grant_immutable();
CREATE TRIGGER open_item_approval_grants_no_truncate BEFORE TRUNCATE ON platform.open_item_approval_grants
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.open_item_grant_immutable();

-- The receipt, verified at commit (0074's rule): the consumed grant's
-- invocation is a successful trust invocation of the same operation,
-- principal, release and channel, approved by the same human, whose change
-- document is of the record the person confirmed (an issue's item, an apply's
-- source item). Definer, because a deferred trigger runs as the role current
-- at COMMIT.
CREATE FUNCTION north_star_internal.open_item_grant_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NEW.invocation_id IS NOT NULL AND NOT EXISTS (SELECT FROM platform.trust_action_invocations i
      JOIN platform.trust_business_change_documents d
        ON (d.tenant_id, d.environment_id, d.change_document_id, d.invocation_id) =
           (i.tenant_id, i.environment_id, i.change_document_id, i.invocation_id)
      WHERE (i.tenant_id, i.environment_id, i.invocation_id) = (NEW.tenant_id, NEW.environment_id, NEW.invocation_id)
        AND i.action_id = NEW.operation_id
        AND i.execution_principal_id = NEW.principal_id
        AND i.release_id = NEW.release_id AND i.outcome = 'SUCCEEDED'
        AND i.channel = NEW.channel
        AND NEW.human_id = coalesce(i.approving_human_id,
              CASE WHEN i.execution_principal_kind = 'HUMAN' THEN i.execution_principal_id END)
        AND d.record_id = NEW.input->>'recordId') THEN
    RAISE EXCEPTION 'openItem.receiptUnverified'; END IF;
  RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER open_item_approval_grants_receipt AFTER UPDATE ON platform.open_item_approval_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION north_star_internal.open_item_grant_receipt();

-- Attestation, by the approval-issuer role only, after the executor verified
-- the gateway's confirmation grant.
CREATE FUNCTION platform.open_item_attest_approval(grant_key uuid, capability text, t uuid, e uuid, principal uuid,
  human uuid, released uuid, fence bigint, operation text, request_key uuid, input jsonb, channel text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO platform.open_item_approval_grants (tenant_id, environment_id, grant_id, capability_id, principal_id,
      human_id, release_id, fence, operation_id, request_key, input, channel)
    VALUES (t, e, grant_key, capability, principal, human, released, fence, operation, request_key, input, channel)
    ON CONFLICT (grant_id) DO NOTHING
$$;

-- Consume the grant that matches this exact request, once: lock position 0.
-- The scope is the trusted request context, never an argument. The release
-- the person confirmed under is still the active one (held FOR SHARE until
-- commit). One comparison per line, each with its own refusal. An unconsumed
-- grant is usable for 15 minutes after its attestation (0074's bound).
CREATE FUNCTION platform.open_item_consume_grant(grant_key uuid, capability text, released uuid,
  expected_fence bigint, operation text, request_key uuid, input jsonb, channel text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g platform.open_item_approval_grants; invocation uuid := gen_random_uuid();
  tenant uuid := north_star_internal.trusted_tenant_id(); environment uuid := north_star_internal.trusted_environment_id(); BEGIN
  SELECT * INTO g FROM platform.open_item_approval_grants a
    WHERE (a.tenant_id, a.environment_id, a.grant_id) = (tenant, environment, grant_key) FOR UPDATE;
  IF NOT FOUND
     OR g.capability_id IS DISTINCT FROM capability
     OR g.principal_id IS DISTINCT FROM nullif(current_setting('north_star.principal_id', true), '')::uuid
     OR g.release_id IS DISTINCT FROM released
     OR g.fence IS DISTINCT FROM expected_fence
     OR g.operation_id IS DISTINCT FROM operation
     OR g.request_key IS DISTINCT FROM request_key
     OR g.channel IS DISTINCT FROM channel
     OR g.input IS DISTINCT FROM input THEN
    RAISE EXCEPTION 'openItem.approvalRequired'; END IF;
  IF g.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'openItem.approvalSpent'; END IF;
  IF g.attested_at < clock_timestamp() - interval '15 minutes' THEN RAISE EXCEPTION 'openItem.approvalExpired'; END IF;
  PERFORM FROM platform.active_release_pointers p
    WHERE (p.tenant_id, p.environment_id, p.release_id, p.fence) = (tenant, environment, released, expected_fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'openItem.staleRelease'; END IF;
  UPDATE platform.open_item_approval_grants a
     SET consumed_at = clock_timestamp(), invocation_id = invocation, consumed_xact = pg_current_xact_id()
    WHERE (a.tenant_id, a.environment_id, a.grant_id) = (g.tenant_id, g.environment_id, g.grant_id);
  RETURN invocation; END $$;

-- The number series: one counter per company and series, taken FOR UPDATE
-- (an upsert's row lock) and moved by one in the issuing transaction, so a
-- rollback returns the number and issued numbers are gap-free per company per
-- series. A void or archived item keeps its number; nothing is deleted.
CREATE TABLE platform.open_item_number_counters (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  sequence_id text NOT NULL CHECK (length(sequence_id) BETWEEN 1 AND 180),
  last_value bigint NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id, sequence_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
-- Every number ever issued, unique per company and series: the backstop the
-- record type's own storage cannot be (an issue-assigned number carries no
-- tenant-wide key, so two companies may each issue PREFIX-000001).
CREATE TABLE platform.open_item_issued_numbers (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  sequence_id text NOT NULL,
  value bigint NOT NULL CHECK (value >= 1),
  number text NOT NULL,
  record_id uuid NOT NULL,
  invocation_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id, sequence_id, value),
  UNIQUE (tenant_id, environment_id, legal_entity_id, sequence_id, number),
  UNIQUE (tenant_id, environment_id, sequence_id, record_id),
  FOREIGN KEY (tenant_id, environment_id, legal_entity_id, sequence_id)
    REFERENCES platform.open_item_number_counters (tenant_id, environment_id, legal_entity_id, sequence_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
CREATE FUNCTION north_star_internal.open_item_number_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF TG_TABLE_NAME = 'open_item_number_counters' AND TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.environment_id, NEW.legal_entity_id, NEW.sequence_id)
         = (OLD.tenant_id, OLD.environment_id, OLD.legal_entity_id, OLD.sequence_id)
     AND NEW.last_value = OLD.last_value + 1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'openItem.numberImmutable'; END $$;
CREATE TRIGGER open_item_number_counters_forward BEFORE UPDATE OR DELETE ON platform.open_item_number_counters
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.open_item_number_immutable();
CREATE TRIGGER open_item_number_counters_no_truncate BEFORE TRUNCATE ON platform.open_item_number_counters
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.open_item_number_immutable();
CREATE TRIGGER open_item_issued_numbers_immutable BEFORE UPDATE OR DELETE ON platform.open_item_issued_numbers
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.open_item_number_immutable();
CREATE TRIGGER open_item_issued_numbers_no_truncate BEFORE TRUNCATE ON platform.open_item_issued_numbers
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.open_item_number_immutable();

-- The next number of one series for one company, for one record. Only an
-- issue confirmed in THIS transaction for THIS record may draw one (its grant
-- consumed here, by the same transaction), so no other caller of the runtime
-- role can burn a number and open a gap. Counter last in the lock order. The
-- company is the item's stored company, read by the core under its row lock.
CREATE FUNCTION platform.open_item_allocate_number(grant_key uuid, company uuid, record uuid, sequence text,
  prefix text, digits integer, first_value bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE tenant uuid := north_star_internal.trusted_tenant_id(); environment uuid := north_star_internal.trusted_environment_id();
  g platform.open_item_approval_grants; next_value bigint; issued text; BEGIN
  SELECT * INTO g FROM platform.open_item_approval_grants a
    WHERE (a.tenant_id, a.environment_id, a.grant_id) = (tenant, environment, grant_key);
  IF NOT FOUND OR g.consumed_xact IS DISTINCT FROM pg_current_xact_id()
     OR g.capability_id <> 'northstar.openitem:capability.open_item_issue'
     OR g.input->>'recordId' IS DISTINCT FROM record::text
     OR company IS NULL OR sequence IS NULL OR prefix !~ '^[A-Z][A-Z0-9]{0,7}$'
     OR digits NOT BETWEEN 1 AND 12 OR first_value NOT BETWEEN 1 AND 1000000000 THEN
    RAISE EXCEPTION 'openItem.numberUnbound'; END IF;
  INSERT INTO platform.open_item_number_counters AS c (tenant_id, environment_id, legal_entity_id, sequence_id, last_value)
    VALUES (tenant, environment, company, sequence, first_value)
    ON CONFLICT (tenant_id, environment_id, legal_entity_id, sequence_id)
    DO UPDATE SET last_value = c.last_value + 1
    RETURNING c.last_value INTO next_value;
  issued := prefix || '-' || lpad(next_value::text, greatest(digits, length(next_value::text)), '0'); BEGIN
    INSERT INTO platform.open_item_issued_numbers (tenant_id, environment_id, legal_entity_id, sequence_id, value,
        number, record_id, invocation_id)
      VALUES (tenant, environment, company, sequence, next_value, issued, record, g.invocation_id);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'openItem.alreadyNumbered'; END;
  RETURN issued; END $$;

DO $access$ DECLARE routine text; BEGIN
  REVOKE ALL ON platform.open_item_approval_grants FROM PUBLIC;
  REVOKE ALL ON platform.open_item_number_counters FROM PUBLIC;
  REVOKE ALL ON platform.open_item_issued_numbers FROM PUBLIC;
  ALTER TABLE platform.open_item_approval_grants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform.open_item_approval_grants FORCE ROW LEVEL SECURITY;
  ALTER TABLE platform.open_item_number_counters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform.open_item_number_counters FORCE ROW LEVEL SECURITY;
  ALTER TABLE platform.open_item_issued_numbers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform.open_item_issued_numbers FORCE ROW LEVEL SECURITY;
  FOREACH routine IN ARRAY ARRAY[
      'north_star_internal.open_item_grant_immutable()', 'north_star_internal.open_item_grant_receipt()',
      'north_star_internal.open_item_number_immutable()',
      'platform.open_item_attest_approval(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
      'platform.open_item_consume_grant(uuid,text,uuid,bigint,text,uuid,jsonb,text)',
      'platform.open_item_allocate_number(uuid,uuid,uuid,text,text,integer,bigint)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.open_item_attest_approval(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)
  TO north_star_approval_issuer;
GRANT EXECUTE ON FUNCTION platform.open_item_consume_grant(uuid,text,uuid,bigint,text,uuid,jsonb,text)
  TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.open_item_allocate_number(uuid,uuid,uuid,text,text,integer,bigint)
  TO north_star_runtime;
