-- Each replay is identified by its source/base pair. A tenant override can
-- erase the only difference between two bases and yield the same candidate.
ALTER TABLE platform.customization_upgrades
  DROP CONSTRAINT customization_upgrades_one_per_candidate,
  ADD CONSTRAINT customization_upgrades_approval_binding
    UNIQUE (tenant_id, environment_id, upgrade_id, source_release_id, candidate_release_id);

CREATE FUNCTION platform.check_customization_upgrade_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.tenant_releases AS candidate
    JOIN platform.app_package_revisions AS revision
      ON revision.tenant_id = candidate.tenant_id AND revision.revision_id = candidate.app_package_revision_id
    JOIN platform.tenant_releases AS source
      ON source.tenant_id = candidate.tenant_id AND source.environment_id = candidate.environment_id
      AND source.release_id = NEW.source_release_id AND source.app_package_revision_id = revision.parent_revision_id
    JOIN platform.tenant_releases AS base
      ON base.tenant_id = candidate.tenant_id AND base.environment_id = candidate.environment_id
      AND base.release_id = NEW.base_release_id
    JOIN platform.app_package_revisions AS base_revision
      ON base_revision.tenant_id = base.tenant_id AND base_revision.revision_id = base.app_package_revision_id
    WHERE candidate.tenant_id = NEW.tenant_id AND candidate.environment_id = NEW.environment_id
      AND candidate.release_id = NEW.candidate_release_id AND revision.revision_id = NEW.candidate_revision_id
      AND revision.provenance = 'tenantAuthored' AND base_revision.provenance = 'firstParty'
  ) THEN
    RAISE EXCEPTION 'customization upgrade release binding is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NULL; END
$$;
-- AFTER INSERT lets RLS and the payload checks run first.
CREATE TRIGGER customization_upgrade_release_binding
AFTER INSERT ON platform.customization_upgrades
FOR EACH ROW EXECUTE FUNCTION platform.check_customization_upgrade_binding();

ALTER TABLE platform.release_approvals
  ADD COLUMN customization_upgrade_id uuid,
  ADD CONSTRAINT release_approvals_upgrade_source CHECK (
    customization_upgrade_id IS NULL OR expected_release_id IS NOT NULL
  ),
  ADD CONSTRAINT release_approvals_upgrade_fkey FOREIGN KEY
    (tenant_id, environment_id, customization_upgrade_id, expected_release_id, target_release_id)
    REFERENCES platform.customization_upgrades
    (tenant_id, environment_id, upgrade_id, source_release_id, candidate_release_id);

-- Before this migration there was at most one replay per candidate revision.
ALTER TABLE platform.release_approvals DISABLE RULE release_approvals_reject_update;
UPDATE platform.release_approvals AS a SET customization_upgrade_id = u.upgrade_id
FROM platform.customization_upgrades AS u
WHERE a.tenant_id = u.tenant_id AND a.environment_id = u.environment_id
  AND a.expected_release_id = u.source_release_id AND a.target_release_id = u.candidate_release_id;
ALTER TABLE platform.release_approvals ENABLE RULE release_approvals_reject_update;

-- Keep the review label independent of the installed patch parser. Unknown
-- and malformed historical payloads still have their durable kind and id.
ALTER TABLE platform.customization_patches ADD COLUMN display_label text;
ALTER TABLE platform.customization_patches DISABLE RULE customization_patches_reject_update;
DO $$
DECLARE
  p record;
  body jsonb; BEGIN
  FOR p IN SELECT patch_id, payload FROM platform.customization_patches LOOP BEGIN
      body := convert_from(p.payload, 'UTF8')::jsonb;
    EXCEPTION WHEN data_exception THEN CONTINUE; END;
    UPDATE platform.customization_patches SET display_label =
      CASE patch_kind WHEN 'addRecordType' THEN body->>'label' WHEN 'saveListView' THEN body->>'label'
        WHEN 'addField' THEN body#>>'{field,label}' WHEN 'addChoice' THEN body->>'option'
        WHEN 'arrangeLayout' THEN CASE WHEN body ? 'upFront' THEN 'form' ELSE 'list' END END
      WHERE patch_id = p.patch_id; END LOOP; END
$$;
ALTER TABLE platform.customization_patches ENABLE RULE customization_patches_reject_update;

CREATE TABLE platform.customization_upgrade_refusals (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  source_release_id uuid NOT NULL,
  base_root text NOT NULL CHECK (base_root ~ '^[0-9a-f]{64}$'),
  diagnostic jsonb NOT NULL CHECK ((jsonb_typeof(diagnostic->'code') = 'string') IS TRUE),
  resolved boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, source_release_id, base_root),
  FOREIGN KEY (tenant_id, environment_id, source_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id)
);
ALTER TABLE platform.customization_upgrade_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.customization_upgrade_refusals FORCE ROW LEVEL SECURITY;
CREATE POLICY customization_upgrade_refusals_scope ON platform.customization_upgrade_refusals
  TO north_star_runtime USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '') IS NOT NULL
  );
GRANT SELECT, INSERT, UPDATE (diagnostic, recorded_at, resolved)
  ON platform.customization_upgrade_refusals TO north_star_runtime;
