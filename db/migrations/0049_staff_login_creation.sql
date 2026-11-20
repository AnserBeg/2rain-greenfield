-- The identity service spends attempts under its existing scoped table grants.
-- Login creation calls the same counter at a fixed limit inside its own write.
CREATE FUNCTION platform.staff_spend_attempt(t uuid,e uuid,b bytea,allowance integer) RETURNS boolean
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  WITH spent AS (
    INSERT INTO platform.staff_attempts AS a (tenant_id,environment_id,bucket,window_start,attempts)
      VALUES(t,e,b,statement_timestamp(),1)
    ON CONFLICT (tenant_id,environment_id,bucket) DO UPDATE SET
      window_start=CASE WHEN a.window_start + interval '15 minutes' <= statement_timestamp()
                        THEN statement_timestamp() ELSE a.window_start END,
      attempts=CASE WHEN a.window_start + interval '15 minutes' <= statement_timestamp() THEN 1 ELSE a.attempts+1 END
      WHERE a.window_start + interval '15 minutes' <= statement_timestamp() OR a.attempts < allowance
    RETURNING 1
  ) SELECT EXISTS (SELECT FROM spent)
$$;
REVOKE ALL ON FUNCTION platform.staff_spend_attempt(uuid,uuid,bytea,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_spend_attempt(uuid,uuid,bytea,integer) TO north_star_identity;

CREATE INDEX staff_login_expiry ON platform.staff_login_transactions (tenant_id,environment_id,expires_at);
CREATE INDEX staff_login_consumed ON platform.staff_login_transactions (tenant_id,environment_id) WHERE consumed_at IS NOT NULL;

REVOKE EXECUTE ON FUNCTION platform.staff_start_login(uuid,uuid,bytea,bytea) FROM north_star_runtime;
CREATE FUNCTION platform.staff_start_login(t uuid,e uuid,b bytea,prior bytea,source_bucket bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF source_bucket IS NULL OR octet_length(source_bucket) <> 32
      OR NOT platform.staff_spend_attempt(t,e,source_bucket,30) THEN
    RAISE EXCEPTION 'staff login unavailable'; END IF;
  -- Only transient browser transactions are collected. Skip a row being redeemed.
  DELETE FROM platform.staff_login_transactions WHERE binding IN (
    SELECT binding FROM platform.staff_login_transactions WHERE tenant_id=t AND environment_id=e
      AND (expires_at <= statement_timestamp() OR consumed_at IS NOT NULL) FOR UPDATE SKIP LOCKED);
  RETURN platform.staff_start_login(t,e,b,prior); END $$;
REVOKE ALL ON FUNCTION platform.staff_start_login(uuid,uuid,bytea,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_start_login(uuid,uuid,bytea,bytea,bytea) TO north_star_runtime;
