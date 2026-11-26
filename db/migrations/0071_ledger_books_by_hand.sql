-- ACCOUNTING-1 slice 1a-ii: books by hand (ADR-0093 sections 2, 4, 6 and 8).
-- It opens with the 1a-i review's ride-alongs (Fable, 2026-11-26). The
-- journal-core migration is applied as written and never edited (the runner
-- checks every applied file's checksum), so its corrections live here.
--
-- Review R4, a correction to the journal-core lock-order note. Its closing
-- claim, "so no cycle is possible", holds only for ONE writer call per
-- transaction. "Counter last" is per call, not per transaction: a transaction
-- that has written one entry holds the company's counter row; if it then asks
-- for a balance row that another transaction holds while that one waits on the
-- counter, the two deadlock. The order is acyclic only for a transaction that
-- makes at most one ledger_write_entry call. Slice 1a-i makes none; until the
-- fix lands (ADR-0093 section 6, amendment 2026-11-26; due before slice 1b, the
-- first multi-entry writer), no caller may make two writer calls in one
-- transaction.

-- Review R5. The deferred balance trigger fires at COMMIT, and before
-- PostgreSQL 18 (the pinned image is 16) it runs as the role current at COMMIT,
-- not as the definer that inserted the rows. A runtime-originated write commits
-- as north_star_runtime, which holds no privilege on ledger_lines, so every such
-- commit would be refused. The check now runs as its owner, like the writer.
ALTER FUNCTION north_star_internal.ledger_entry_balanced() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The writer as in the journal-core migration, with three changes.
-- Review R2: an instant must be RFC 3339 text with Z or a numeric offset. Text
-- without one is read in the session time zone, a hidden zone input; a zone
-- name or a special value such as 'now' is refused too.
-- Review R6: the per-line account read takes the row FOR SHARE, so an account
-- created and committed after the ascending account lock is held too, and a
-- deactivation cannot commit under this writer. Share locks form no cycle.
-- Review R4 tripwire: a second writer call in one transaction refuses by name
-- (ledger.oneEntryPerTransaction). The marker is a transaction-local setting;
-- the function's own SET clause saves and restores only search_path, so the
-- marker outlives the call, and a savepoint rollback clears it together with
-- the locks taken after the savepoint. Any role can reset a placeholder
-- setting, the same trust level as north_star.tenant_id; a deadlock aborts a
-- transaction and never writes wrong money, so a tripwire is proportionate.
-- The real protection: the writer is granted to no one and every operation
-- makes one call.
CREATE OR REPLACE FUNCTION north_star_internal.ledger_write_entry(
  company uuid, kind text, date_basis jsonb, currency text, lines jsonb, provenance jsonb
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  recorded timestamptz := clock_timestamp();
  entry uuid := gen_random_uuid();
  period platform.ledger_companies;
  entry_day date; entry_month date; entry_no bigint; digest text;
  line jsonb; n bigint; account uuid; line_role text; line_class text; acct record; accepted jsonb := '[]'; BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  -- R4 tripwire, before lock 3: one writer call per transaction (see header).
  IF current_setting('north_star.ledger_entry_written', true) = 'yes' THEN
    RAISE EXCEPTION 'ledger.oneEntryPerTransaction'; END IF;
  PERFORM set_config('north_star.ledger_entry_written', 'yes', true);
  IF kind IS NULL OR kind NOT IN ('posting','recognition','repost','reclass','opening','manual')
     OR jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_typeof(date_basis) IS DISTINCT FROM 'object'
     OR jsonb_typeof(coalesce(provenance, '{}')) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(date_basis)) <> 1 THEN
    RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
  IF date_basis ? 'instant' AND (jsonb_typeof(date_basis->'instant') IS DISTINCT FROM 'string'
     OR date_basis->>'instant' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$') THEN
    RAISE EXCEPTION 'ledger.instantWithoutOffset'; END IF;
  -- Lock 3: the company closed-through row.
  SELECT * INTO period FROM platform.ledger_companies
    WHERE (tenant_id, environment_id, company_id) = (t, e, company) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  IF date_basis ? 'instant' THEN
    entry_day := north_star_internal.ledger_business_day(company, (date_basis->>'instant')::timestamptz);
  ELSIF date_basis ? 'civil' AND kind IN ('manual','opening') THEN
    entry_day := north_star_internal.ledger_civil_date(date_basis->>'civil');
  ELSE
    RAISE EXCEPTION 'ledger.dateBasisRefused'; END IF;
  IF entry_day IS NULL THEN RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
  IF period.books_start IS NULL THEN RAISE EXCEPTION 'ledger.booksNotStarted'; END IF;
  IF period.closed_through IS NOT NULL AND entry_day <= period.closed_through THEN RAISE EXCEPTION 'ledger.closedBooks'; END IF;
  IF entry_day < period.books_start AND kind <> 'opening' THEN RAISE EXCEPTION 'ledger.beforeBooksStart'; END IF;
  entry_month := entry_day - (extract(day FROM entry_day)::integer - 1);
  -- Lock 5: the entry's accounts, ascending. Lock 4 (the map row) joins in 1a-iii.
  PERFORM FROM platform.ledger_accounts a
    WHERE (a.tenant_id, a.environment_id, a.company_id) = (t, e, company)
      AND a.account_id IN (SELECT (l->>'accountId')::uuid FROM jsonb_array_elements(lines) l)
    ORDER BY a.account_id FOR SHARE;
  FOR line, n IN SELECT value, ordinality FROM jsonb_array_elements(lines) WITH ORDINALITY LOOP
    account := (line->>'accountId')::uuid;
    SELECT a.kind_role_id, a.active, r.role_class, r.control_subledger_id INTO acct
      FROM platform.ledger_accounts a JOIN platform.ledger_core_roles r ON r.role_id = a.kind_role_id
      WHERE (a.tenant_id, a.environment_id, a.company_id, a.account_id) = (t, e, company, account)
      FOR SHARE OF a;
    IF NOT FOUND THEN RAISE EXCEPTION 'ledger.accountUnavailable'; END IF;
    IF NOT acct.active THEN RAISE EXCEPTION 'ledger.accountInactive'; END IF;
    IF kind IN ('manual','opening') THEN
      IF acct.control_subledger_id IS NOT NULL THEN RAISE EXCEPTION 'ledger.controlRoleRefused'; END IF;
      line_role := acct.kind_role_id;
    ELSE
      line_role := line->>'roleId';
      SELECT r.role_class INTO line_class FROM platform.ledger_core_roles r WHERE r.role_id = line_role;
      IF line_class IS DISTINCT FROM acct.role_class THEN RAISE EXCEPTION 'ledger.roleMisfit'; END IF; END IF;
    accepted := accepted || jsonb_build_array(jsonb_build_object('n', n, 'accountId', account, 'roleId', line_role,
      'qualifier', line->'qualifier', 'side', line->>'side', 'amount', (line->>'amount')::bigint)); END LOOP;
  -- Lock 6: balance rows, ascending, missing rows included.
  INSERT INTO platform.ledger_balances AS b (tenant_id, environment_id, company_id, account_id, currency_code,
      accounting_month, debit_total, credit_total, recorded_horizon)
    SELECT t, e, company, (a->>'accountId')::uuid, currency, entry_month,
      coalesce(sum((a->>'amount')::bigint) FILTER (WHERE a->>'side' = 'D'), 0),
      coalesce(sum((a->>'amount')::bigint) FILTER (WHERE a->>'side' = 'C'), 0), recorded
      FROM jsonb_array_elements(accepted) a GROUP BY (a->>'accountId')::uuid
      ORDER BY (a->>'accountId')::uuid
    ON CONFLICT (tenant_id, environment_id, company_id, account_id, currency_code, accounting_month) DO UPDATE
      SET debit_total = b.debit_total + EXCLUDED.debit_total, credit_total = b.credit_total + EXCLUDED.credit_total,
          recorded_horizon = greatest(b.recorded_horizon, EXCLUDED.recorded_horizon);
  -- Lock 7: the per-company entry-number counter, last.
  UPDATE platform.ledger_entry_counters SET last_number = last_number + 1
    WHERE (tenant_id, environment_id, company_id) = (t, e, company) RETURNING last_number INTO entry_no;
  IF entry_no IS NULL THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  -- IDs and amounts only: labels never enter the digest.
  digest := encode(sha256(convert_to(jsonb_build_object('company', company, 'kind', kind, 'currency', currency,
    'accountingDate', to_char(entry_day, 'YYYY-MM-DD'), 'lines', accepted,
    'provenance', coalesce(provenance, '{}'))::text, 'UTF8')), 'hex');
  INSERT INTO platform.ledger_entries (tenant_id, environment_id, entry_id, company_id, currency_code, accounting_date,
      recorded_at, entry_kind, source_type_id, record_id, source_header_revision, source_line_set_version, rule_id,
      rule_version, map_version, recognized_through, operation_receipt_id, entry_ordinal, reason_code, entry_number, inputs_digest)
    VALUES (t, e, entry, company, currency, entry_day, recorded, kind, provenance->>'sourceTypeId',
      (provenance->>'recordId')::uuid, (provenance->>'sourceHeaderRevision')::bigint,
      (provenance->>'sourceLineSetVersion')::bigint, provenance->>'ruleId', (provenance->>'ruleVersion')::integer,
      (provenance->>'mapVersion')::bigint, north_star_internal.ledger_civil_date(provenance->>'recognizedThrough'),
      (provenance->>'operationReceiptId')::uuid, (provenance->>'entryOrdinal')::integer, provenance->>'reasonCode',
      entry_no, digest);
  INSERT INTO platform.ledger_lines (tenant_id, environment_id, entry_id, line_number, company_id, account_id, role_id,
      qualifier, side, currency_code, amount)
    SELECT t, e, entry, (a->>'n')::integer, company, (a->>'accountId')::uuid, a->>'roleId', a->>'qualifier', a->>'side',
      currency, (a->>'amount')::bigint FROM jsonb_array_elements(accepted) a;
  -- The projection equals the sum of lines and their greatest recorded_at,
  -- recomputed in this transaction for every row this entry touched.
  IF EXISTS (SELECT FROM platform.ledger_balances b
      WHERE (b.tenant_id, b.environment_id, b.company_id, b.currency_code, b.accounting_month) =
            (t, e, company, currency, entry_month)
        AND b.account_id IN (SELECT (a->>'accountId')::uuid FROM jsonb_array_elements(accepted) a)
        AND NOT EXISTS (SELECT FROM (
          SELECT coalesce(sum(l.amount) FILTER (WHERE l.side = 'D'), 0) AS debits,
                 coalesce(sum(l.amount) FILTER (WHERE l.side = 'C'), 0) AS credits, max(x.recorded_at) AS horizon
            FROM platform.ledger_lines l JOIN platform.ledger_entries x USING (tenant_id, environment_id, entry_id)
            WHERE (l.tenant_id, l.environment_id, l.company_id, l.account_id, l.currency_code) =
                  (b.tenant_id, b.environment_id, b.company_id, b.account_id, b.currency_code)
              AND x.accounting_date >= b.accounting_month
              AND x.accounting_date < b.accounting_month + interval '1 month') summed
          WHERE (summed.debits, summed.credits, summed.horizon) IS NOT DISTINCT FROM
                (b.debit_total, b.credit_total, b.recorded_horizon))) THEN
    RAISE EXCEPTION 'ledger.projectionMismatch'; END IF;
  RETURN entry; END $$;

-- Review note: a books-start move once entries exist would re-date nothing and
-- strand earlier entries before the start. The setter refuses it after its own
-- FOR UPDATE on the company row, so no first writer slips between check and
-- update (a writer holds the row FOR SHARE until it commits).
CREATE OR REPLACE FUNCTION north_star_internal.ledger_set_books_start(company uuid, day date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  PERFORM FROM platform.ledger_companies WHERE (tenant_id, environment_id, company_id) = (t, e, company) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  IF EXISTS (SELECT FROM platform.ledger_entries x WHERE (x.tenant_id, x.environment_id, x.company_id) = (t, e, company)) THEN
    RAISE EXCEPTION 'ledger.booksStartLocked'; END IF;
  UPDATE platform.ledger_companies SET books_start = day
    WHERE (tenant_id, environment_id, company_id) = (t, e, company); END $$;

-- ---------------------------------------------------------------------------
-- Slice 1a-ii: the confirmation-class ledger operations (ruling A, 2026-11-26).
-- A person confirms through the Semantic Operation gateway. Its humanRequired
-- grant binds the exact input, release, fence, principal, target record and
-- expected revision. The executor verifies that grant and attests it here
-- through the approval-issuer role. Each apply definer then consumes the
-- matching grant once, in its own transaction, and mints the trust invocation
-- ID that the general trust writer records in the same transaction. A deferred
-- check verifies that receipt at commit.
-- Lock order, ahead of the journal order (ADR-0093 section 6): the grant row
-- FOR UPDATE; the active release pointer FOR SHARE; the policy epoch FOR SHARE;
-- the company's legal-entity master row FOR SHARE; then lock 3, the company row
-- (FOR UPDATE for books start only, FOR SHARE otherwise); then account rows in
-- account-code order, so two charts cannot cycle on the code index.

-- The starter chart as data (ADR-0093 section 3, owner N2). A row carries an
-- ISO 3166 jurisdiction tag (a country, or a subdivision such as CA-BC), so a
-- new country or province is rows, not a schema change. Changed only by
-- migration, no grants, read only by the definer functions below.
CREATE TABLE platform.ledger_chart_starter_accounts (
  starter_id text NOT NULL CHECK (starter_id ~ '^northstar\.ledger:starter\.[a-z][a-z0-9_]*$'),
  starter_version integer NOT NULL CHECK (starter_version >= 1),
  account_code text NOT NULL CHECK (btrim(account_code) <> '' AND length(account_code) <= 32),
  kind_role_id text NOT NULL REFERENCES platform.ledger_core_roles (role_id),
  default_label text NOT NULL CHECK (btrim(default_label) <> '' AND length(default_label) <= 200),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  PRIMARY KEY (starter_id, starter_version, account_code)
);
-- Canada, GST plus PST (BC, SK) and RST (MB). Rates and recoverability are
-- tax-lane data; a company relabels, adds or deactivates accounts afterwards.
INSERT INTO platform.ledger_chart_starter_accounts
    (starter_id, starter_version, account_code, kind_role_id, default_label, jurisdiction) VALUES
  ('northstar.ledger:starter.canada', 1, '1000', 'northstar.ledger:role.cash', 'Cash', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1010', 'northstar.ledger:role.cash', 'Bank account', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1050', 'northstar.ledger:role.undeposited_funds', 'Undeposited funds', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1200', 'northstar.ledger:role.receivable', 'Accounts receivable', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1300', 'northstar.ledger:role.tax_recoverable', 'GST recoverable (input tax credits)', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1400', 'northstar.ledger:role.prepaid_expense', 'Prepaid expenses', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1500', 'northstar.ledger:role.inventory_asset', 'Inventory', 'CA'),
  ('northstar.ledger:starter.canada', 1, '1700', 'northstar.ledger:role.fixed_asset', 'Equipment', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2000', 'northstar.ledger:role.payable', 'Accounts payable', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2100', 'northstar.ledger:role.accrued_liability', 'Accrued liabilities', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2200', 'northstar.ledger:role.tax_payable', 'GST payable', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2210', 'northstar.ledger:role.tax_payable', 'PST payable (British Columbia)', 'CA-BC'),
  ('northstar.ledger:starter.canada', 1, '2220', 'northstar.ledger:role.tax_payable', 'PST payable (Saskatchewan)', 'CA-SK'),
  ('northstar.ledger:starter.canada', 1, '2230', 'northstar.ledger:role.tax_payable', 'RST payable (Manitoba)', 'CA-MB'),
  ('northstar.ledger:starter.canada', 1, '2300', 'northstar.ledger:role.customer_deposits', 'Customer deposits', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2400', 'northstar.ledger:role.deferred_revenue', 'Deferred revenue', 'CA'),
  ('northstar.ledger:starter.canada', 1, '2700', 'northstar.ledger:role.loan', 'Loans payable', 'CA'),
  ('northstar.ledger:starter.canada', 1, '3000', 'northstar.ledger:role.owner_equity', 'Owner''s equity', 'CA'),
  ('northstar.ledger:starter.canada', 1, '3100', 'northstar.ledger:role.retained_earnings', 'Retained earnings', 'CA'),
  ('northstar.ledger:starter.canada', 1, '3900', 'northstar.ledger:role.opening_balance', 'Opening balance equity', 'CA'),
  ('northstar.ledger:starter.canada', 1, '4000', 'northstar.ledger:role.revenue', 'Sales revenue', 'CA'),
  ('northstar.ledger:starter.canada', 1, '4500', 'northstar.ledger:role.other_income', 'Other income', 'CA'),
  ('northstar.ledger:starter.canada', 1, '4900', 'northstar.ledger:role.discounts_given', 'Sales discounts', 'CA'),
  ('northstar.ledger:starter.canada', 1, '5000', 'northstar.ledger:role.cost_of_sales', 'Cost of sales', 'CA'),
  ('northstar.ledger:starter.canada', 1, '6000', 'northstar.ledger:role.expense', 'General expenses', 'CA'),
  ('northstar.ledger:starter.canada', 1, '6100', 'northstar.ledger:role.bank_fees', 'Bank fees', 'CA'),
  ('northstar.ledger:starter.canada', 1, '6900', 'northstar.ledger:role.other_expense', 'Other expenses', 'CA'),
  ('northstar.ledger:starter.canada', 1, '6950', 'northstar.ledger:role.rounding_difference', 'Rounding differences', 'CA');

-- An attested human confirmation, consumed once by the matching apply. The
-- same match columns as the booking engine's grants, in the ledger's own table
-- (rule 19). Immutable except the one consumption, which records the minted
-- trust invocation ID.
CREATE TABLE platform.ledger_approval_grants (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  grant_id uuid NOT NULL,
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
  PRIMARY KEY (tenant_id, environment_id, grant_id),
  UNIQUE (grant_id),
  CHECK ((consumed_at IS NULL) = (invocation_id IS NULL)),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
CREATE FUNCTION north_star_internal.ledger_grant_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'ledger.grantImmutable'; END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR (to_jsonb(NEW) - 'consumed_at' - 'invocation_id') <> (to_jsonb(OLD) - 'consumed_at' - 'invocation_id') THEN
    RAISE EXCEPTION 'ledger.grantImmutable'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER ledger_approval_grants_immutable BEFORE UPDATE OR DELETE ON platform.ledger_approval_grants
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.ledger_grant_immutable();
CREATE TRIGGER ledger_approval_grants_no_truncate BEFORE TRUNCATE ON platform.ledger_approval_grants
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.ledger_grant_immutable();

-- The receipt, verified in SQL at commit: the consumed grant's invocation is a
-- successful trust invocation of the same operation, principal and release.
-- Definer, because a deferred trigger runs as the role current at COMMIT.
CREATE FUNCTION north_star_internal.ledger_grant_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NEW.invocation_id IS NOT NULL AND NOT EXISTS (SELECT FROM platform.trust_action_invocations i
      WHERE (i.tenant_id, i.environment_id, i.invocation_id) = (NEW.tenant_id, NEW.environment_id, NEW.invocation_id)
        AND i.action_id = NEW.operation_id AND i.execution_principal_id = NEW.principal_id
        AND i.release_id = NEW.release_id AND i.outcome = 'SUCCEEDED') THEN
    RAISE EXCEPTION 'ledger.receiptUnverified'; END IF;
  RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER ledger_approval_grants_receipt AFTER UPDATE ON platform.ledger_approval_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION north_star_internal.ledger_grant_receipt();

-- Attestation, by the approval-issuer role only, after the executor verified
-- the gateway's confirmation grant. The issuer pool has no request context, so
-- the scope comes as arguments; the apply re-checks it against the trusted one.
CREATE FUNCTION platform.ledger_attest_approval(grant_key uuid, t uuid, e uuid, principal uuid, human uuid,
  released uuid, fence bigint, operation text, request_key uuid, input jsonb, channel text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO platform.ledger_approval_grants (tenant_id, environment_id, grant_id, principal_id, human_id, release_id,
      fence, operation_id, request_key, input, channel)
    VALUES (t, e, grant_key, principal, human, released, fence, operation, request_key, input, channel)
    ON CONFLICT (grant_id) DO NOTHING
$$;

-- Consume the grant that matches this exact request, once. Lock position 0.
CREATE FUNCTION north_star_internal.ledger_consume_grant(grant_key uuid, released uuid, expected_fence bigint,
  operation text, request_key uuid, input jsonb, channel text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE g platform.ledger_approval_grants; invocation uuid := gen_random_uuid(); BEGIN
  SELECT * INTO g FROM platform.ledger_approval_grants a
    WHERE (a.tenant_id, a.environment_id, a.grant_id) =
          (north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id(), grant_key) FOR UPDATE;
  IF NOT FOUND
     OR g.principal_id IS DISTINCT FROM nullif(current_setting('north_star.principal_id', true), '')::uuid
     OR (g.release_id, g.fence, g.operation_id, g.request_key, g.channel) IS DISTINCT FROM
        (released, expected_fence, operation, request_key, channel)
     OR g.input IS DISTINCT FROM input THEN
    RAISE EXCEPTION 'ledger.approvalRequired'; END IF;
  IF g.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ledger.approvalSpent'; END IF;
  UPDATE platform.ledger_approval_grants a SET consumed_at = clock_timestamp(), invocation_id = invocation
    WHERE (a.tenant_id, a.environment_id, a.grant_id) = (g.tenant_id, g.environment_id, g.grant_id);
  RETURN invocation; END $$;

-- The released storage plan of the active pointer: a ledger-owned reader of the
-- same chunk other engines read, so ledger SQL names no other engine (rule 19).
CREATE FUNCTION north_star_internal.ledger_release_storage() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb
  FROM platform.active_release_pointers p
  JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
  JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
  JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
    AND blob.artifact_kind = 'projectionChunk'
  WHERE (p.tenant_id, p.environment_id) =
        (north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id())
    AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
$$;

-- A company is a live record of the released legal-entity master (ADR-0015),
-- found by its storage-plan marker, never by an entity name: unarchived, in the
-- declared active status, FOR SHARE when the caller writes. A release without
-- the master refuses by name (fail closed).
CREATE FUNCTION north_star_internal.ledger_company_live(company uuid, locking boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE master jsonb; stored uuid; BEGIN
  IF company IS NULL THEN RETURN false; END IF; BEGIN
    SELECT v INTO STRICT master FROM jsonb_array_elements(north_star_internal.ledger_release_storage()->'entities') v
      WHERE v ? 'legalEntityMaster';
  EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'ledger.companyRegistryUnavailable'; END;
  EXECUTE format('SELECT record_id FROM north_star_module.%I WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3'
      ' AND archived_at IS NULL AND %I = $4 %s',
      master->>'physicalTableName', master#>>'{legalEntityMaster,fieldColumns,status}',
      CASE WHEN locking THEN 'FOR SHARE' ELSE '' END)
    INTO stored USING north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id(), company,
      master#>>'{legalEntityMaster,activeStatusValue}';
  RETURN stored IS NOT NULL; END $$;

-- The ledger-owned permission predicate: the trusted principal holds the
-- permission on the resource through a live membership that is unscoped or
-- scoped to this company. The same join as the journal read; a general policy
-- predicate shared by every engine is a GENERALIZE candidate.
CREATE FUNCTION north_star_internal.ledger_may(company uuid, permission text, resource text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT company IS NOT NULL AND EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id, environment_id, role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id, environment_id, role_id)
    WHERE (m.tenant_id, m.environment_id, m.principal_id) = (north_star_internal.trusted_tenant_id(),
        north_star_internal.trusted_environment_id(), nullif(current_setting('north_star.principal_id', true), '')::uuid)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id = company)
      AND (g.permission_id, g.resource_id) = (permission, resource))
$$;

-- Fence, then authority, then the company: "not yours" and "not there" are one
-- refusal (ledger.unavailable). Writing holds the pointer, the epoch and the
-- master row FOR SHARE until commit.
CREATE FUNCTION north_star_internal.ledger_operation_access(company uuid, released uuid, expected_fence bigint, writing boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE tenant uuid := north_star_internal.trusted_tenant_id(); environment uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF writing THEN
    PERFORM FROM platform.active_release_pointers p
      WHERE (p.tenant_id, p.environment_id, p.release_id, p.fence) = (tenant, environment, released, expected_fence) FOR SHARE;
  ELSE
    PERFORM FROM platform.active_release_pointers p
      WHERE (p.tenant_id, p.environment_id, p.release_id, p.fence) = (tenant, environment, released, expected_fence); END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.staleRelease'; END IF;
  IF writing THEN PERFORM platform.lock_current_policy_epoch(tenant, environment); END IF;
  IF NOT north_star_internal.ledger_may(company, 'northstar.ledger:permission.books_configure', 'northstar.ledger:capability.books')
    THEN RAISE EXCEPTION 'ledger.unavailable'; END IF;
  IF NOT north_star_internal.ledger_company_live(company, writing) THEN RAISE EXCEPTION 'ledger.unavailable'; END IF; END $$;

-- Books start, on the company's legal-entity record. The arguments carry the
-- date and the books start the person expects to replace (expectedPrior, null
-- before the first); a different stored value refuses by name. The company row
-- is provisioned only here, after the master check.
CREATE FUNCTION platform.ledger_apply_books_start(grant_key uuid, released uuid, expected_fence bigint,
  operation text, request_key uuid, channel text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE tenant uuid := north_star_internal.trusted_tenant_id(); environment uuid := north_star_internal.trusted_environment_id();
  args jsonb := input->'arguments'; company uuid; day date; prior date; invocation uuid; BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR input - 'recordId' - 'expectedRevision' - 'arguments' <> '{}'
     OR coalesce(input->>'recordId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(args) IS DISTINCT FROM 'object' OR args - 'date' - 'expectedPrior' <> '{}' OR NOT args ? 'expectedPrior'
     OR jsonb_typeof(args->'expectedPrior') NOT IN ('null', 'string') THEN
    RAISE EXCEPTION 'ledger.invalidOperation'; END IF;
  company := (input->>'recordId')::uuid;
  day := north_star_internal.ledger_civil_date(args->>'date');
  IF day IS NULL THEN RAISE EXCEPTION 'ledger.invalidOperation'; END IF;
  invocation := north_star_internal.ledger_consume_grant(grant_key, released, expected_fence, operation, request_key, input, channel);
  PERFORM north_star_internal.ledger_operation_access(company, released, expected_fence, true);
  PERFORM north_star_internal.ledger_provision_company(company);
  -- Lock 3, FOR UPDATE: the books-start setter takes the same row again.
  SELECT c.books_start INTO prior FROM platform.ledger_companies c
    WHERE (c.tenant_id, c.environment_id, c.company_id) = (tenant, environment, company) FOR UPDATE;
  IF coalesce(to_jsonb(to_char(prior, 'YYYY-MM-DD')), 'null'::jsonb) IS DISTINCT FROM args->'expectedPrior' THEN
    RAISE EXCEPTION 'ledger.priorChanged'; END IF;
  PERFORM north_star_internal.ledger_set_books_start(company, day);
  RETURN jsonb_build_object('invocationId', invocation, 'company', company, 'booksStart', to_char(day, 'YYYY-MM-DD'),
    'prior', to_char(prior, 'YYYY-MM-DD')); END $$;

DO $access$ DECLARE routine text; BEGIN
  REVOKE ALL ON platform.ledger_chart_starter_accounts FROM PUBLIC;
  REVOKE ALL ON platform.ledger_approval_grants FROM PUBLIC;
  ALTER TABLE platform.ledger_approval_grants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform.ledger_approval_grants FORCE ROW LEVEL SECURITY;
  FOREACH routine IN ARRAY ARRAY[
      'north_star_internal.ledger_grant_immutable()', 'north_star_internal.ledger_grant_receipt()',
      'north_star_internal.ledger_release_storage()', 'north_star_internal.ledger_company_live(uuid,boolean)',
      'north_star_internal.ledger_may(uuid,text,text)',
      'north_star_internal.ledger_operation_access(uuid,uuid,bigint,boolean)',
      'north_star_internal.ledger_consume_grant(uuid,uuid,bigint,text,uuid,jsonb,text)',
      'platform.ledger_attest_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
      'platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.ledger_attest_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)
  TO north_star_approval_issuer;
GRANT EXECUTE ON FUNCTION platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,jsonb)
  TO north_star_runtime;
