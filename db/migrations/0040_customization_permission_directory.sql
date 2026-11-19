-- An environment-wide Customize author can discover active role keys and labels.
-- The ordinary role, membership and grant policies stay membership-scoped.
CREATE FUNCTION platform.customization_permission_roles()
RETURNS TABLE (role_key text, label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $customization_permission_roles$
  WITH caller AS (
    SELECT
      nullif(current_setting('north_star.tenant_id', true), '')::uuid AS tenant_id,
      nullif(current_setting('north_star.environment_id', true), '')::uuid AS environment_id,
      nullif(current_setting('north_star.principal_id', true), '')::uuid AS principal_id
  )
  SELECT role.role_key, initcap(translate(role.role_key, '_-', '  '))
    FROM caller
    JOIN platform.current_policy_roles AS role
      ON role.tenant_id = caller.tenant_id
     AND role.environment_id = caller.environment_id
     AND role.revoked_at IS NULL
   WHERE EXISTS (
     SELECT 1
       FROM platform.current_policy_memberships AS membership
       JOIN platform.current_policy_roles AS author_role
         ON author_role.tenant_id = membership.tenant_id
        AND author_role.environment_id = membership.environment_id
        AND author_role.role_id = membership.role_id
        AND author_role.revoked_at IS NULL
       JOIN platform.current_policy_permission_grants AS author_grant
         ON author_grant.tenant_id = membership.tenant_id
        AND author_grant.environment_id = membership.environment_id
        AND author_grant.role_id = membership.role_id
        AND author_grant.revoked_at IS NULL
      WHERE membership.tenant_id = caller.tenant_id
        AND membership.environment_id = caller.environment_id
        AND membership.principal_id = caller.principal_id
        AND membership.legal_entity_id IS NULL
        AND membership.revoked_at IS NULL
        AND author_grant.permission_id = 'northstar.runtime:permission.customize_author'
        AND author_grant.resource_id = 'northstar.runtime:customization.application'
   )
   ORDER BY role.role_key;
$customization_permission_roles$;

REVOKE ALL ON FUNCTION platform.customization_permission_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.customization_permission_roles() TO north_star_runtime;

-- Both patches publish immutable revisions. Removing a restriction restores
-- evaluation against current policy, with no new grant.
ALTER TABLE platform.customization_patches
  DROP CONSTRAINT customization_patches_shape,
  ADD CONSTRAINT customization_patches_shape CHECK (
    patch_version = 'northstar.customization-patch/v1'
    AND patch_kind IN (
      'addRecordType', 'addField', 'addChoice', 'arrangeLayout',
      'saveListView', 'addValidation', 'addCalculatedDisplayField',
      'narrowPermission', 'addMetricCard', 'unNarrowPermission'
    )
    AND octet_length(payload) BETWEEN 2 AND 65536
    AND payload_digest = encode(sha256(payload), 'hex')
    AND channel IN (
      'firstPartyAuthoring',
      'visualBuilder',
      'conversationalAi',
      'importTemplate',
      'declarativeEditor'
    )
    AND btrim(base_package_id) <> ''
    AND base_package_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    AND base_release_root ~ '^[0-9a-f]{64}$'
    AND parent_revision_id <> resulting_revision_id
    AND btrim(language_version) <> ''
    AND btrim(normalization_profile_version) <> ''
  );
