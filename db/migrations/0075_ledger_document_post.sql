-- DOCUMENT-POSTING slice 1 (ADR-0093 sections 4 and 6): the ledger posts a
-- staged manual journal through the general document-posting binding. The
-- number is provisional (WORKFLOW-3 takes 0075 in TRAIN-Y; renumbered at merge).
--
-- A person enters a draft and its lines through the generic press, marks it
-- Ready (a declared transition that bumps the header revision and freezes the
-- lines: every line write takes its parent FOR SHARE and applies the header's
-- update guard, which refuses every state but Draft), then confirms Post. The
-- gateway's humanRequired grant binds the exact input -- the draft and the
-- Ready revision the person saw. The ledger executor attests that grant as in
-- slice 1a-ii and calls `platform.ledger_apply_document_post`, which:
--   1. requires READ COMMITTED (the one read below must see every line
--      committed before its header lock was granted);
--   2. consumes the grant once under its own capability constant
--      (general_ledger) and mints the trust invocation ID;
--   3. holds the release pointer and the policy epoch FOR SHARE;
--   4. resolves the binding from THAT release's operation catalog by
--      operation ID and engine, and every table and column from that
--      release's storage plan by canonical ID: no caller name, no suffix;
--   5. locks the draft header FOR NO KEY UPDATE, which conflicts with a line
--      writer's parent FOR SHARE, so the line set is fixed until commit; then
--      checks journal_post for the header's stored company and holds that
--      company's master row FOR SHARE;
--   6. reads the header and its live lines in ONE statement issued after the
--      lock (READ COMMITTED takes its snapshot per statement), refusing unless
--      the state is Ready and the revision is the one confirmed;
--   7. converts: account code to account within the company, side option to
--      D/C, amount to whole minor units through one exact function;
--   8. writes one manual entry through the journal writer with the draft as
--      its provenance;
--   9. moves the draft to Posted (exactly one row, pinned by record, company,
--      revision, state and liveness);
--  10. a unique index on the draft's record ID backs the state field: a draft
--      forced back to Ready cannot post twice.
--
-- Global lock order (ADR-0093 section 6, amended 2026-11-28; 0074's order
-- comment cannot be edited, the runner checks applied checksums): the grant
-- row FOR UPDATE; the active release pointer FOR SHARE; the policy epoch FOR
-- SHARE; the posted record's header FOR NO KEY UPDATE; the company's
-- legal-entity master row FOR SHARE; then the journal order (company row,
-- accounts ascending, balances, counter last). No writer takes a master row
-- and then a draft header: the generic press locks a draft line's parent
-- FOR SHARE and reads its company without locking the master.
--
-- Isolation (G1): the definer's owner is the migration role, which bypasses
-- the module tables' forced row security. So every dynamic statement over
-- north_star_module names tenant_id, environment_id and the company itself.

-- One projection of a given release, for the trusted tenant: the operation
-- catalog or the storage plan the post resolves its binding from. Keyed by the
-- release the gateway decided under, never the pointer's current one (the
-- caller holds that pointer FOR SHARE and compares the fence).
CREATE FUNCTION north_star_internal.ledger_release_projection(released uuid, family text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb
  FROM platform.tenant_release_projection_links projection
  JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
  JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
    AND blob.artifact_kind = 'projectionChunk'
  WHERE (projection.tenant_id, projection.environment_id, projection.release_id) =
        (north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id(), released)
    AND projection.projection_family_id = family
$$;

-- A whole count of the currency's minor unit, from a staged exact decimal
-- (ADR-0093 section 4, door 1). Numeric arithmetic only; never rounds.
CREATE FUNCTION north_star_internal.ledger_minor_units(amount numeric, exponent smallint) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE scaled numeric; BEGIN
  IF amount IS NULL OR exponent IS NULL OR exponent < 0 OR exponent > 4 THEN
    RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
  IF amount <= 0 THEN RAISE EXCEPTION 'ledger.amountNotPositive'; END IF;
  IF amount <> trunc(amount, exponent) THEN RAISE EXCEPTION 'ledger.unrepresentableAmount'; END IF;
  scaled := amount * (10::numeric ^ exponent);
  IF scaled > 9223372036854775807::numeric THEN RAISE EXCEPTION 'ledger.amountTooLarge'; END IF;
  RETURN scaled::bigint; END $$;

-- A field's physical column on a released storage entity, by canonical ID.
CREATE FUNCTION north_star_internal.ledger_bound_column(entity jsonb, field text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE physical text; BEGIN
  SELECT c->>'physicalName' INTO STRICT physical FROM jsonb_array_elements(entity->'columns') c
    WHERE c->>'canonicalFieldId' = field;
  RETURN physical;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'ledger.bindingUnavailable'; END $$;

-- The released document-posting binding of one general_ledger operation, and
-- its header entity, line relation and line entity from the same release's
-- storage plan. Both ends must be company-owned and the relation a
-- parent-scoped child of the header. Anything else refuses by name.
CREATE FUNCTION north_star_internal.ledger_document_binding(released uuid, operation text,
  OUT binding jsonb, OUT header jsonb, OUT relation jsonb, OUT line jsonb)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE catalog jsonb; storage jsonb; BEGIN
  catalog := north_star_internal.ledger_release_projection(released, 'northstar.compiler:projection-family.operation-catalog');
  storage := north_star_internal.ledger_release_projection(released, 'northstar.compiler:projection-family.storage-target');
  <<lookup>> BEGIN
    SELECT o->'documentPosting' INTO STRICT binding FROM jsonb_array_elements(catalog->'operations') o
      WHERE o->>'operationId' = operation AND o->>'lifecycle' = 'active'
        AND o#>>'{effect,kind}' = 'registeredCapabilityEffect'
        AND o#>>'{effect,capability,targetId}' = 'northstar.ledger:capability.general_ledger'
        AND o#>>'{documentPosting,engine}' = 'northstar.ledger:capability.general_ledger'
        AND o#>>'{documentPosting,bindingVersion}' = 'documentPosting/v1';
    SELECT v INTO STRICT header FROM jsonb_array_elements(storage->'entities') v
      WHERE v->>'entityId' = binding#>>'{header,entity}' AND v ? 'legalEntity';
    SELECT r INTO STRICT relation FROM jsonb_array_elements(storage->'relations') r
      WHERE r->>'relationId' = binding#>>'{lines,relation}' AND r->>'targetEntityId' = header->>'entityId'
        AND r->>'ownership' = 'parentScopedChild' AND r->>'sourceEntityId' <> header->>'entityId';
    SELECT v INTO STRICT line FROM jsonb_array_elements(storage->'entities') v
      WHERE v->>'entityId' = relation->>'sourceEntityId' AND v ? 'legalEntity';
  EXCEPTION WHEN no_data_found OR too_many_rows OR null_value_not_allowed THEN
    RAISE EXCEPTION 'ledger.bindingUnavailable'; END;
  IF binding IS NULL OR header IS NULL OR relation IS NULL OR line IS NULL THEN
    RAISE EXCEPTION 'ledger.bindingUnavailable'; END IF; END $$;

-- The preparation read: the stored company of a live draft of the trusted
-- tenant, for the gateway's policy scope. Missing, archived and another
-- tenant's draft are one answer (null), which the executor refuses as
-- ledger.unavailable. The apply re-derives the company under the lock.
CREATE FUNCTION platform.ledger_document_company(released uuid, operation text, draft uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; company uuid; BEGIN
  IF draft IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO b FROM north_star_internal.ledger_document_binding(released, operation);
  EXECUTE format('SELECT legal_entity_id FROM north_star_module.%I WHERE tenant_id = $1 AND environment_id = $2'
      ' AND %I = $3 AND %I IS NULL',
      b.header->>'physicalTableName', b.header#>>'{recordIdentity,column}', b.header#>>'{archive,archivedAtColumn}')
    INTO company USING north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id(), draft;
  RETURN company;
EXCEPTION WHEN raise_exception THEN RETURN NULL; END $$;

-- Post a staged journal: see the header. `policy_version` is the version the
-- gateway decided under; the apply refuses unless it is the epoch it holds.
-- The person's expectedRevision is compared with the draft header under its
-- lock: the Ready transition bumped it, so a reopen, edit and Ready again
-- refuses a confirmation of the earlier document. The result carries the
-- draft's state and the entry number with old and new values read under the
-- locks, the locked policy version and the draft's new revision.
CREATE FUNCTION platform.ledger_apply_document_post(grant_key uuid, released uuid, expected_fence bigint,
  operation text, request_key uuid, channel text, policy_version text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE tenant uuid := north_star_internal.trusted_tenant_id(); environment uuid := north_star_internal.trusted_environment_id();
  draft_id uuid; invocation uuid; locked text; b record; company uuid; doc record; minor smallint;
  line jsonb; account uuid; side text; lines jsonb := '[]'; entry uuid; entry_no bigint; changed integer;
  violated text;
  state_col text; revision_col text; archived_col text; identity_col text; parent_col text; BEGIN
  PERFORM north_star_internal.ledger_require_writer();
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR input - 'recordId' - 'expectedRevision' - 'arguments' <> '{}'
     OR coalesce(input->>'recordId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(input->'expectedRevision') IS DISTINCT FROM 'number'
     OR (input->>'expectedRevision') !~ '^[1-9][0-9]{0,17}$'
     OR (input ? 'arguments' AND input->'arguments' <> '{}') THEN
    RAISE EXCEPTION 'ledger.invalidOperation'; END IF;
  draft_id := (input->>'recordId')::uuid;
  invocation := north_star_internal.ledger_consume_grant(grant_key, 'northstar.ledger:capability.general_ledger',
    released, expected_fence, operation, request_key, input, channel);
  -- Lock 1 and 2: the pointer and the policy epoch.
  PERFORM FROM platform.active_release_pointers p
    WHERE (p.tenant_id, p.environment_id, p.release_id, p.fence) = (tenant, environment, released, expected_fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.staleRelease'; END IF;
  locked := platform.lock_current_policy_epoch(tenant, environment);
  IF policy_version IS DISTINCT FROM 'northstar.current-policy/' || locked THEN
    RAISE EXCEPTION 'ledger.stalePolicy'; END IF;
  SELECT * INTO b FROM north_star_internal.ledger_document_binding(released, operation);
  identity_col := b.header#>>'{recordIdentity,column}';
  revision_col := b.header#>>'{optimisticRevision,column}';
  archived_col := b.header#>>'{archive,archivedAtColumn}';
  state_col := north_star_internal.ledger_bound_column(b.header, b.binding#>>'{state,field}');
  parent_col := b.relation#>>'{relationColumn,physicalName}';
  -- Lock 3: the posted record's header. A line writer holds it FOR SHARE.
  EXECUTE format('SELECT legal_entity_id FROM north_star_module.%I WHERE tenant_id = $1 AND environment_id = $2'
      ' AND %I = $3 AND %I IS NULL FOR NO KEY UPDATE',
      b.header->>'physicalTableName', identity_col, archived_col)
    INTO company USING tenant, environment, draft_id;
  IF company IS NULL THEN RAISE EXCEPTION 'ledger.unavailable'; END IF;
  -- Lock 4: authority for the header's stored company, then its master row.
  IF NOT north_star_internal.ledger_may(company, 'northstar.ledger:permission.journal_post', 'northstar.ledger:capability.journal')
    THEN RAISE EXCEPTION 'ledger.unavailable'; END IF;
  IF north_star_internal.ledger_company_live(company, true) IS NULL THEN RAISE EXCEPTION 'ledger.unavailable'; END IF;
  -- The one read, a statement of its own after the lock: the header and its
  -- live lines in line-number order.
  EXECUTE format(
    'SELECT h.%1$I AS revision, h.%2$I AS state, h.%3$I AS kind, h.%4$I AS currency,'
    ' to_char(h.%5$I, ''YYYY-MM-DD'') AS civil, (SELECT coalesce(jsonb_agg(jsonb_build_object(''number'', l.%6$I,'
    ' ''account'', l.%7$I, ''side'', l.%8$I, ''amount'', l.%9$I) ORDER BY l.%6$I), ''[]'') FROM north_star_module.%10$I l'
    ' WHERE l.tenant_id = $1 AND l.environment_id = $2 AND l.legal_entity_id = $4 AND l.%11$I = $3 AND l.%12$I IS NULL) AS lines'
    ' FROM north_star_module.%13$I h WHERE h.tenant_id = $1 AND h.environment_id = $2 AND h.legal_entity_id = $4'
    ' AND h.%14$I = $3 AND h.%15$I IS NULL',
    revision_col, state_col,
    north_star_internal.ledger_bound_column(b.header, b.binding#>>'{roles,kind}'),
    north_star_internal.ledger_bound_column(b.header, b.binding#>>'{roles,currency}'),
    north_star_internal.ledger_bound_column(b.header, b.binding#>>'{roles,date}'),
    north_star_internal.ledger_bound_column(b.line, b.binding#>>'{roles,number}'),
    north_star_internal.ledger_bound_column(b.line, b.binding#>>'{roles,account}'),
    north_star_internal.ledger_bound_column(b.line, b.binding#>>'{roles,side}'),
    north_star_internal.ledger_bound_column(b.line, b.binding#>>'{roles,amount}'),
    b.line->>'physicalTableName', parent_col, b.line#>>'{archive,archivedAtColumn}',
    b.header->>'physicalTableName', identity_col, archived_col)
    INTO doc USING tenant, environment, draft_id, company;
  IF doc.state IS DISTINCT FROM b.binding#>>'{state,from}' THEN RAISE EXCEPTION 'ledger.notReady'; END IF;
  IF doc.revision IS DISTINCT FROM (input->>'expectedRevision')::bigint THEN
    RAISE EXCEPTION 'ledger.staleRevision'; END IF;
  IF doc.kind = b.binding#>>'{options,opening}' THEN RAISE EXCEPTION 'ledger.openingNotYet'; END IF;
  IF doc.kind IS DISTINCT FROM b.binding#>>'{options,manual}' THEN RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
  SELECT c.minor_unit INTO minor FROM platform.ledger_currencies c WHERE c.currency_code = doc.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger.unknownCurrency'; END IF;
  IF jsonb_array_length(doc.lines) < 2 OR jsonb_array_length(doc.lines) > 200 THEN
    RAISE EXCEPTION 'ledger.lineCount'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(doc.lines) LOOP
    SELECT a.account_id INTO account FROM platform.ledger_accounts a
      WHERE (a.tenant_id, a.environment_id, a.company_id, a.account_code) = (tenant, environment, company, line->>'account');
    IF NOT FOUND THEN RAISE EXCEPTION 'ledger.accountUnavailable'; END IF;
    side := CASE line->>'side' WHEN b.binding#>>'{options,debit}' THEN 'D'
      WHEN b.binding#>>'{options,credit}' THEN 'C' END;
    IF side IS NULL THEN RAISE EXCEPTION 'ledger.invalidEntry'; END IF;
    lines := lines || jsonb_build_array(jsonb_build_object('accountId', account, 'side', side,
      'amount', north_star_internal.ledger_minor_units((line->>'amount')::numeric, minor))); END LOOP;
  <<journal>> BEGIN
    entry := north_star_internal.ledger_write_entry(company, 'manual', jsonb_build_object('civil', doc.civil),
      doc.currency, lines, jsonb_build_object('operationReceiptId', invocation, 'entryOrdinal', 1,
        'sourceTypeId', b.header->>'entityId', 'recordId', draft_id, 'sourceHeaderRevision', doc.revision));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated = 'ledger_entries_document_key' THEN RAISE EXCEPTION 'ledger.documentPosted'; END IF;
    RAISE; END;
  -- The state flip: exactly one row, pinned by record, company, revision,
  -- state and liveness.
  EXECUTE format('UPDATE north_star_module.%I SET %I = $5, %I = %I + 1 WHERE tenant_id = $1 AND environment_id = $2'
      ' AND legal_entity_id = $4 AND %I = $3 AND %I = $6 AND %I = $7 AND %I IS NULL',
      b.header->>'physicalTableName', state_col, revision_col, revision_col, identity_col, revision_col, state_col,
      archived_col)
    USING tenant, environment, draft_id, company, b.binding#>>'{state,to}', doc.revision, doc.state;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'ledger.documentChanged'; END IF;
  SELECT x.entry_number INTO entry_no FROM platform.ledger_entries x
    WHERE (x.tenant_id, x.environment_id, x.entry_id) = (tenant, environment, entry);
  RETURN jsonb_build_object('invocationId', invocation, 'policyVersion', 'northstar.current-policy/' || locked,
    'revision', doc.revision + 1, 'changes', jsonb_build_array(
      jsonb_build_object('fact', 'state', 'old', doc.state, 'new', b.binding#>>'{state,to}'),
      jsonb_build_object('fact', 'entryNumber', 'old', NULL, 'new', entry_no::text))); END $$;

-- Backstop (delta amendment 5, design amendment 8): one manual or opening
-- entry per document and ordinal. The operation key cannot stop a second post
-- (each invocation has its own receipt), so the stored record ID does, if the
-- state field is ever forced back. entry_ordinal is kept in the key so an
-- opening document may later make one entry per currency (slice 2). ADR-0093
-- section 4 said record_id is null for these kinds; this overrides it (dated
-- ADR line, 2026-11-28).
CREATE UNIQUE INDEX ledger_entries_document_key ON platform.ledger_entries
  (tenant_id, environment_id, company_id, source_type_id, record_id, entry_ordinal)
  WHERE entry_kind IN ('manual', 'opening') AND record_id IS NOT NULL;

DO $access$ DECLARE routine text; BEGIN
  FOREACH routine IN ARRAY ARRAY[
      'north_star_internal.ledger_release_projection(uuid,text)',
      'north_star_internal.ledger_minor_units(numeric,smallint)',
      'north_star_internal.ledger_bound_column(jsonb,text)',
      'north_star_internal.ledger_document_binding(uuid,text)',
      'platform.ledger_document_company(uuid,text,uuid)',
      'platform.ledger_apply_document_post(uuid,uuid,bigint,text,uuid,text,text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.ledger_document_company(uuid,text,uuid) TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.ledger_apply_document_post(uuid,uuid,bigint,text,uuid,text,text,jsonb)
  TO north_star_runtime;
