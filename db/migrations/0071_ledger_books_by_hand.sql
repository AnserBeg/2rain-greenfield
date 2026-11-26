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

-- Review R2. The writer as in the journal-core migration, plus one refusal: an
-- instant must be RFC 3339 text with Z or a numeric offset. Text without one
-- is read in the session time zone, a hidden zone input; a zone name or a
-- special value such as 'now' is refused too.
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
