-- 0035 copied candidate-pair matches into approvals. The pair is shared by
-- ordinary patches and upgrades. Only an original decision identifying the
-- upgrade can substantiate an inferred binding.
ALTER TABLE platform.release_approvals
  ADD COLUMN customization_reconciliation_required boolean NOT NULL DEFAULT false;
ALTER TABLE platform.release_approvals DISABLE RULE release_approvals_reject_update;
UPDATE platform.release_approvals
   SET customization_upgrade_id = NULL, customization_reconciliation_required = true
 WHERE customization_upgrade_id IS NOT NULL
   AND source_decision_id IS DISTINCT FROM customization_upgrade_id;
ALTER TABLE platform.release_approvals ENABLE RULE release_approvals_reject_update;

-- These immutable inputs belong to the original compile. An older action
-- without a pin remains readable and its replay must request reconciliation.
ALTER TABLE platform.customization_patches ADD COLUMN compiler_acknowledgement jsonb;
ALTER TABLE platform.customization_upgrades ADD COLUMN compiler_acknowledgement jsonb;

-- Compare text to canonical scoped UUIDs so even a legacy non-UUID value can
-- be inspected without casting it. The payload retains its original order.
CREATE FUNCTION platform.customization_patch_refs_valid(tenant uuid, environment uuid, payload bytea)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) > 0 AND count(*) = count(DISTINCT ref.value) AND count(*) = count(patch.patch_id)
    FROM jsonb_array_elements(convert_from(payload, 'UTF8')::jsonb -> 'patchIds') AS ref(value)
    LEFT JOIN platform.customization_patches AS patch
      ON patch.tenant_id = tenant AND patch.environment_id = environment
     AND to_jsonb(patch.patch_id) = ref.value
$$;
-- A CHECK using a scoped lookup runs before RLS. Use the same invoker AFTER
-- INSERT boundary as the existing release binding and keep old rows readable.
CREATE FUNCTION platform.check_customization_patch_refs()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT platform.customization_patch_refs_valid(NEW.tenant_id, NEW.environment_id, NEW.payload) THEN
    RAISE EXCEPTION 'invalid customization patch references' USING ERRCODE = '23514'; END IF;
  RETURN NULL; END
$$;
CREATE TRIGGER customization_upgrade_patch_refs AFTER INSERT ON platform.customization_upgrades
FOR EACH ROW EXECUTE FUNCTION platform.check_customization_patch_refs();
