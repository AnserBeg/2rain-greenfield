-- ACCOUNTING-1 slice 1a-i: the journal core (ADR-0093 sections 4, 6, 8 and 9).
-- Storage and one internal writer only. No compiled chunk, stored definition or
-- principal write path changes here; the operations arrive in slice 1a-ii.
--
-- Access. The two global catalogs (currencies, core roles) have no tenant
-- column: they change only by migration, carry no grants and are read only
-- through the definer functions below. The six tenant tables enable and force
-- row-level security with no policy, so every non-owner role is refused even
-- before the revoked privileges; only the owner-owned definer functions read or
-- write them.
--
-- The one global lock order (ADR-0093 section 6, amended 2026-11-25):
--   1. (company, record, rule) ascending          [poster, slice 1b]
--   2. the record                                 [poster, slice 1b]
--   3. the company closed-through row FOR SHARE   (ledger_companies)
--   4. the company account-map row                [slice 1a-iii]
--   5. the entry's account rows, ascending, FOR SHARE
--   6. balance rows, ascending, upserted in key order (missing rows included)
--   7. the per-company entry-number counter row, last
-- Close, books start, provisioning and an account edit each lock exactly one
-- row FOR UPDATE and nothing else, so no cycle is possible.

CREATE TABLE platform.ledger_currencies (
  currency_code text PRIMARY KEY CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4)
);
-- ISO 4217 minor-unit exponents of the stored currency list (REPORTS-1).
INSERT INTO platform.ledger_currencies (currency_code, minor_unit)
  VALUES ('CAD', 2), ('EUR', 2), ('USD', 2);

-- ADR-0093 section 3 (owner door 2, ratified 2026-11-25). A control role names
-- the subledger that alone may post it, never a module.
CREATE TABLE platform.ledger_core_roles (
  role_id text PRIMARY KEY CHECK (role_id ~ '^northstar\.ledger:role\.[a-z][a-z_]*$'),
  role_class text NOT NULL CHECK (role_class IN ('asset','liability','equity','income','expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('D','C','either')),
  control_subledger_id text CHECK (control_subledger_id IN
    ('northstar.ledger:subledger.customer','northstar.ledger:subledger.supplier')),
  UNIQUE (role_id, role_class)
);
INSERT INTO platform.ledger_core_roles (role_id, role_class, normal_balance, control_subledger_id) VALUES
  ('northstar.ledger:role.cash','asset','D',NULL),
  ('northstar.ledger:role.undeposited_funds','asset','D',NULL),
  ('northstar.ledger:role.receivable','asset','D','northstar.ledger:subledger.customer'),
  ('northstar.ledger:role.tax_recoverable','asset','D',NULL),
  ('northstar.ledger:role.prepaid_expense','asset','D',NULL),
  ('northstar.ledger:role.inventory_asset','asset','D',NULL),
  ('northstar.ledger:role.fixed_asset','asset','D',NULL),
  ('northstar.ledger:role.other_current_asset','asset','D',NULL),
  ('northstar.ledger:role.supplier_prepayments','asset','D','northstar.ledger:subledger.supplier'),
  ('northstar.ledger:role.supplier_credit','asset','D','northstar.ledger:subledger.supplier'),
  ('northstar.ledger:role.currency_clearing','asset','either',NULL),
  ('northstar.ledger:role.payable','liability','C','northstar.ledger:subledger.supplier'),
  ('northstar.ledger:role.tax_payable','liability','C',NULL),
  ('northstar.ledger:role.deferred_revenue','liability','C',NULL),
  ('northstar.ledger:role.customer_deposits','liability','C','northstar.ledger:subledger.customer'),
  ('northstar.ledger:role.customer_credit','liability','C','northstar.ledger:subledger.customer'),
  ('northstar.ledger:role.accrued_liability','liability','C',NULL),
  ('northstar.ledger:role.other_current_liability','liability','C',NULL),
  ('northstar.ledger:role.loan','liability','C',NULL),
  ('northstar.ledger:role.owner_equity','equity','C',NULL),
  ('northstar.ledger:role.retained_earnings','equity','C',NULL),
  ('northstar.ledger:role.opening_balance','equity','either',NULL),
  ('northstar.ledger:role.revenue','income','C',NULL),
  ('northstar.ledger:role.other_income','income','C',NULL),
  ('northstar.ledger:role.discounts_given','income','D',NULL),
  ('northstar.ledger:role.expense','expense','D',NULL),
  ('northstar.ledger:role.cost_of_sales','expense','D',NULL),
  ('northstar.ledger:role.other_expense','expense','D',NULL),
  ('northstar.ledger:role.bank_fees','expense','D',NULL),
  ('northstar.ledger:role.rounding_difference','expense','either',NULL);

-- The closed-through row (lock position 3). Books start and closed-through are
-- civil dates of the company's business calendar. Months and the fiscal-year
-- start are reporting-calendar data, never the lock.
CREATE TABLE platform.ledger_companies (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  books_start date CHECK (isfinite(books_start)),
  closed_through date CHECK (isfinite(closed_through)),
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  PRIMARY KEY (tenant_id, environment_id, company_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);

-- A row of its own, taken last, so writers never upgrade SHARE to UPDATE on the
-- closed-through row (two writers doing that deadlock).
CREATE TABLE platform.ledger_entry_counters (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, environment_id, company_id),
  FOREIGN KEY (tenant_id, environment_id, company_id) REFERENCES platform.ledger_companies
);

-- An account's kind is a core role and fixes its class and normal balance. The
-- label is display text only and never enters a digest.
CREATE TABLE platform.ledger_accounts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  account_code text NOT NULL CHECK (btrim(account_code) <> '' AND length(account_code) <= 32),
  kind_role_id text NOT NULL REFERENCES platform.ledger_core_roles (role_id),
  active boolean NOT NULL DEFAULT true,
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 200),
  PRIMARY KEY (tenant_id, environment_id, company_id, account_id),
  UNIQUE (tenant_id, environment_id, company_id, account_code),
  FOREIGN KEY (tenant_id, environment_id, company_id) REFERENCES platform.ledger_companies
);

CREATE TABLE platform.ledger_entries (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  company_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES platform.ledger_currencies (currency_code),
  accounting_date date NOT NULL CHECK (isfinite(accounting_date)),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
  entry_kind text NOT NULL CHECK (entry_kind IN ('posting','recognition','repost','reclass','opening','manual')),
  source_type_id text,
  record_id uuid,
  source_header_revision bigint,
  source_line_set_version bigint,
  rule_id text,
  rule_version integer,
  map_version bigint,
  recognized_through date,
  operation_receipt_id uuid,
  entry_ordinal integer CHECK (entry_ordinal >= 1),
  reason_code text,
  entry_number bigint NOT NULL CHECK (entry_number >= 1),
  inputs_digest text NOT NULL CHECK (inputs_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, environment_id, entry_id),
  UNIQUE (tenant_id, environment_id, entry_id, company_id, currency_code),
  UNIQUE (tenant_id, environment_id, company_id, entry_number),
  FOREIGN KEY (tenant_id, environment_id, company_id) REFERENCES platform.ledger_companies,
  CONSTRAINT ledger_entries_kind_shape CHECK (
    (entry_kind IN ('posting','recognition') AND source_type_id IS NOT NULL AND record_id IS NOT NULL
      AND source_header_revision IS NOT NULL AND source_line_set_version IS NOT NULL
      AND rule_id IS NOT NULL AND rule_version IS NOT NULL
      AND operation_receipt_id IS NULL AND entry_ordinal IS NULL)
    OR (entry_kind IN ('repost','reclass','opening','manual')
      AND operation_receipt_id IS NOT NULL AND entry_ordinal IS NOT NULL)),
  CONSTRAINT ledger_entries_recognition_shape CHECK ((entry_kind = 'recognition') = (recognized_through IS NOT NULL))
);
-- Both keys of ADR-0093 section 6, tenant and environment leading. Each is a
-- partial index (ADR section 4 implementation note) so that one kind's null
-- columns never collide under NULLS NOT DISTINCT on the other kind's key.
CREATE UNIQUE INDEX ledger_entries_posting_key ON platform.ledger_entries
  (tenant_id, environment_id, company_id, record_id, rule_id, rule_version, source_header_revision,
   source_line_set_version, currency_code, accounting_date, recognized_through, entry_kind)
  NULLS NOT DISTINCT WHERE entry_kind IN ('posting','recognition');
CREATE UNIQUE INDEX ledger_entries_operation_key ON platform.ledger_entries
  (tenant_id, environment_id, company_id, operation_receipt_id, entry_ordinal)
  NULLS NOT DISTINCT WHERE entry_kind IN ('repost','reclass','manual','opening');

-- Door 1 (ratified 2026-11-25): a positive bigint count of the currency's minor
-- unit with a side. One currency per entry and the entry's own company are
-- foreign keys; positivity and the reserved columns are checks.
CREATE TABLE platform.ledger_lines (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  role_id text NOT NULL CHECK (btrim(role_id) <> ''),
  qualifier text,
  side text NOT NULL CHECK (side IN ('D','C')),
  currency_code text NOT NULL,
  amount bigint NOT NULL,
  counterparty_party_id uuid,
  dimension_set_id uuid,
  PRIMARY KEY (tenant_id, environment_id, entry_id, line_number),
  CONSTRAINT ledger_lines_amount_positive CHECK (amount > 0),
  CONSTRAINT ledger_lines_counterparty_reserved CHECK (counterparty_party_id IS NULL),
  CONSTRAINT ledger_lines_dimension_set_reserved CHECK (dimension_set_id IS NULL),
  CONSTRAINT ledger_lines_entry_currency FOREIGN KEY (tenant_id, environment_id, entry_id, company_id, currency_code)
    REFERENCES platform.ledger_entries (tenant_id, environment_id, entry_id, company_id, currency_code),
  CONSTRAINT ledger_lines_account_company FOREIGN KEY (tenant_id, environment_id, company_id, account_id)
    REFERENCES platform.ledger_accounts (tenant_id, environment_id, company_id, account_id)
);
CREATE INDEX ledger_lines_account ON platform.ledger_lines
  (tenant_id, environment_id, company_id, account_id, currency_code);

-- The balance projection (ADR-0093 section 9): one row per company, account,
-- currency and accounting month, a rebuildable sum of lines with its own
-- recordedAt horizon (ADR-0057 amendment 2026-09-01): the greatest recorded_at
-- over the entries it sums.
CREATE TABLE platform.ledger_balances (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES platform.ledger_currencies (currency_code),
  accounting_month date NOT NULL CHECK (isfinite(accounting_month) AND extract(day FROM accounting_month) = 1),
  debit_total bigint NOT NULL CHECK (debit_total >= 0),
  credit_total bigint NOT NULL CHECK (credit_total >= 0),
  recorded_horizon timestamptz NOT NULL CHECK (isfinite(recorded_horizon)),
  PRIMARY KEY (tenant_id, environment_id, company_id, account_id, currency_code, accounting_month),
  FOREIGN KEY (tenant_id, environment_id, company_id, account_id) REFERENCES platform.ledger_accounts
);

-- Entries and lines are append-only for every role, the owner included.
CREATE FUNCTION north_star_internal.ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'ledger.appendOnly'; END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.ledger_append_only();
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.ledger_lines
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.ledger_append_only();

-- Checked before commit: at least two lines and debits equal credits. The entry
-- side catches an entry with no lines, where no line trigger ever fires.
CREATE FUNCTION north_star_internal.ledger_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE line_count bigint; debits numeric; credits numeric; BEGIN
  SELECT count(*), coalesce(sum(amount) FILTER (WHERE side = 'D'), 0), coalesce(sum(amount) FILTER (WHERE side = 'C'), 0)
    INTO line_count, debits, credits FROM platform.ledger_lines
    WHERE (tenant_id, environment_id, entry_id) = (NEW.tenant_id, NEW.environment_id, NEW.entry_id);
  IF line_count < 2 THEN RAISE EXCEPTION 'ledger.tooFewLines'; END IF;
  IF debits <> credits THEN RAISE EXCEPTION 'ledger.unbalanced'; END IF;
  RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON platform.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION north_star_internal.ledger_entry_balanced();
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON platform.ledger_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION north_star_internal.ledger_entry_balanced();

-- Writers and setters rely on READ COMMITTED: a lock wait re-reads the row it
-- waited for. Read functions do not carry this guard.
CREATE FUNCTION north_star_internal.ledger_require_writer() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ledger.requiresReadCommitted'; END IF; END $$;

-- THE only path from an instant to an accounting date. It takes the entry's
-- stored company so that COMPANY-CALENDAR-1's per-company override replaces the
-- tenant default here without a signature change. It reuses the inventory
-- business-period arithmetic (zone and day boundary), the calendar the reports
-- horizon reads, and refuses an undeclared calendar.
CREATE FUNCTION north_star_internal.ledger_business_day(company uuid, instant timestamptz) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF instant IS NULL OR NOT isfinite(instant) OR NOT EXISTS (SELECT FROM platform.ledger_companies
      WHERE (tenant_id, environment_id, company_id) = (t, e, company)) THEN
    RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  RETURN north_star_internal.inventory_business_period(t, instant); END $$;

CREATE FUNCTION north_star_internal.ledger_provision_company(company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  IF t IS NULL OR e IS NULL OR company IS NULL THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  INSERT INTO platform.ledger_companies (tenant_id, environment_id, company_id) VALUES (t, e, company)
    ON CONFLICT DO NOTHING;
  INSERT INTO platform.ledger_entry_counters (tenant_id, environment_id, company_id) VALUES (t, e, company)
    ON CONFLICT DO NOTHING; END $$;

-- Slice 1a-ii wraps this in the confirmation-class books-start operation.
CREATE FUNCTION north_star_internal.ledger_set_books_start(company uuid, day date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  PERFORM FROM platform.ledger_companies WHERE (tenant_id, environment_id, company_id) = (t, e, company) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  UPDATE platform.ledger_companies SET books_start = day
    WHERE (tenant_id, environment_id, company_id) = (t, e, company); END $$;

-- Slice 2 wraps this in close and reopen. It takes only the closed-through row.
CREATE FUNCTION north_star_internal.ledger_set_closed_through(company uuid, day date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  PERFORM FROM platform.ledger_companies WHERE (tenant_id, environment_id, company_id) = (t, e, company) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  UPDATE platform.ledger_companies SET closed_through = day
    WHERE (tenant_id, environment_id, company_id) = (t, e, company); END $$;

-- Slice 1a-ii wraps this in the chart operation. A kind never changes.
CREATE FUNCTION north_star_internal.ledger_put_account(
  company uuid, account uuid, code text, kind text, account_label text, is_active boolean
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  prior platform.ledger_accounts; BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  SELECT * INTO prior FROM platform.ledger_accounts
    WHERE (tenant_id, environment_id, company_id, account_id) = (t, e, company, account) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO platform.ledger_accounts (tenant_id, environment_id, company_id, account_id, account_code, kind_role_id, active, label)
      VALUES (t, e, company, account, code, kind, is_active, account_label);
    RETURN; END IF;
  IF prior.kind_role_id IS DISTINCT FROM kind THEN RAISE EXCEPTION 'ledger.accountKindFixed'; END IF;
  UPDATE platform.ledger_accounts SET account_code = code, active = is_active, label = account_label
    WHERE (tenant_id, environment_id, company_id, account_id) = (t, e, company, account); END $$;

-- A civil date typed as YYYY-MM-DD, read without any zone conversion.
CREATE FUNCTION north_star_internal.ledger_civil_date(civil text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF civil IS NULL THEN RETURN NULL; END IF;
  IF civil !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
  RETURN make_date(substr(civil, 1, 4)::integer, substr(civil, 6, 2)::integer, substr(civil, 9, 2)::integer); END $$;

-- THE entry writer, used by every operation and by the poster. It takes the
-- tenant and environment from the trusted context, the company from its caller
-- (an owner-owned definer that authorized it), and every line's role for a
-- person-entered kind from the stored account, never from caller input.
-- date_basis is {"instant": <timestamptz>} or, for manual and opening entries
-- only, {"civil": "YYYY-MM-DD"} typed by a person in the company calendar.
CREATE FUNCTION north_star_internal.ledger_write_entry(
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
  IF kind IS NULL OR kind NOT IN ('posting','recognition','repost','reclass','opening','manual')
     OR jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_typeof(date_basis) IS DISTINCT FROM 'object'
     OR jsonb_typeof(coalesce(provenance, '{}')) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(date_basis)) <> 1 THEN
    RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
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
      WHERE (a.tenant_id, a.environment_id, a.company_id, a.account_id) = (t, e, company, account);
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

-- Company-scoped reads, the only principal path in this slice. The principal
-- comes from the trusted context and needs journal_read on the journal
-- resource through a membership that is unscoped or scoped to this company.
CREATE FUNCTION north_star_internal.ledger_may_read(company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id, environment_id, role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id, environment_id, role_id)
    WHERE (m.tenant_id, m.environment_id, m.principal_id) = (north_star_internal.trusted_tenant_id(),
        north_star_internal.trusted_environment_id(), nullif(current_setting('north_star.principal_id', true), '')::uuid)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id = company)
      AND (g.permission_id, g.resource_id) = ('northstar.ledger:permission.journal_read', 'northstar.ledger:capability.journal'))
$$;

-- One keyset page of a company's lines, ordered by entry and line number. A
-- page holds at most 500 lines, below the report fact ceiling.
CREATE FUNCTION platform.ledger_read_lines(
  company uuid, from_date date, to_date date, after_entry bigint, after_line integer, page_size integer
) RETURNS TABLE (entry_number bigint, entry_id uuid, accounting_date date, entry_kind text, line_number integer,
  account_id uuid, role_id text, qualifier text, side text, currency_code text, amount bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF NOT north_star_internal.ledger_may_read(company) THEN RAISE EXCEPTION 'ledger.readUnavailable'; END IF;
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'ledger.pageSize'; END IF;
  RETURN QUERY SELECT x.entry_number, x.entry_id, x.accounting_date, x.entry_kind, l.line_number, l.account_id, l.role_id,
      l.qualifier, l.side, l.currency_code, l.amount
    FROM platform.ledger_entries x JOIN platform.ledger_lines l USING (tenant_id, environment_id, entry_id)
    WHERE (x.tenant_id, x.environment_id, x.company_id) = (t, e, company)
      AND x.accounting_date BETWEEN from_date AND to_date
      AND (x.entry_number, l.line_number) > (coalesce(after_entry, 0), coalesce(after_line, 0))
    ORDER BY x.entry_number, l.line_number
    LIMIT page_size; END $$;

CREATE FUNCTION platform.ledger_read_balances(company uuid, from_month date, through_month date)
RETURNS TABLE (account_id uuid, currency_code text, accounting_month date, debit_total bigint, credit_total bigint,
  recorded_horizon timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF NOT north_star_internal.ledger_may_read(company) THEN RAISE EXCEPTION 'ledger.readUnavailable'; END IF;
  RETURN QUERY SELECT b.account_id, b.currency_code, b.accounting_month, b.debit_total, b.credit_total, b.recorded_horizon
    FROM platform.ledger_balances b
    WHERE (b.tenant_id, b.environment_id, b.company_id) = (t, e, company)
      AND b.accounting_month BETWEEN from_month AND through_month
    ORDER BY b.account_id, b.currency_code, b.accounting_month; END $$;

DO $access$ DECLARE tab text; routine text; BEGIN
  FOREACH tab IN ARRAY ARRAY['ledger_currencies','ledger_core_roles','ledger_companies','ledger_entry_counters',
      'ledger_accounts','ledger_entries','ledger_lines','ledger_balances'] LOOP
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC', tab); END LOOP;
  FOREACH tab IN ARRAY ARRAY['ledger_companies','ledger_entry_counters','ledger_accounts','ledger_entries',
      'ledger_lines','ledger_balances'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', tab); END LOOP;
  FOREACH routine IN ARRAY ARRAY[
      'north_star_internal.ledger_append_only()', 'north_star_internal.ledger_entry_balanced()',
      'north_star_internal.ledger_require_writer()', 'north_star_internal.ledger_business_day(uuid,timestamptz)',
      'north_star_internal.ledger_provision_company(uuid)', 'north_star_internal.ledger_set_books_start(uuid,date)',
      'north_star_internal.ledger_set_closed_through(uuid,date)',
      'north_star_internal.ledger_put_account(uuid,uuid,text,text,text,boolean)',
      'north_star_internal.ledger_civil_date(text)',
      'north_star_internal.ledger_write_entry(uuid,text,jsonb,text,jsonb,jsonb)',
      'north_star_internal.ledger_may_read(uuid)',
      'platform.ledger_read_lines(uuid,date,date,bigint,integer,integer)',
      'platform.ledger_read_balances(uuid,date,date)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.ledger_read_lines(uuid,date,date,bigint,integer,integer),
  platform.ledger_read_balances(uuid,date,date) TO north_star_runtime;
