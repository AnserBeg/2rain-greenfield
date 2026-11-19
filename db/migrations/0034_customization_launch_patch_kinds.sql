-- Extend the closed patch vocabulary for the launch customization set.
-- Replace the check atomically with the same checks and the added kinds.
ALTER TABLE platform.customization_patches
  DROP CONSTRAINT customization_patches_shape,
  ADD CONSTRAINT customization_patches_shape CHECK (
    patch_version = 'northstar.customization-patch/v1'
    AND patch_kind IN (
      'addRecordType', 'addField', 'addChoice', 'arrangeLayout',
      'saveListView', 'addValidation', 'addCalculatedDisplayField',
      'narrowPermission', 'addMetricCard'
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
