ALTER TABLE platform.release_verification_evidence
  DROP CONSTRAINT release_verification_evidence_version,
  DROP CONSTRAINT release_verification_evidence_full_execution;

ALTER TABLE platform.release_verification_evidence
  ADD CONSTRAINT release_verification_evidence_version CHECK (
    evidence_version IN (
      'northstar.verification-result-set/v1',
      'northstar.verification-result-set/v2'
    )
  ),
  ADD CONSTRAINT release_verification_evidence_exact_partition CHECK (
    result_count >= 0
    AND provider = 'realPostgresql'
    AND btrim(provider_run_id) <> ''
    AND executed_evidence_id IS NOT NULL
    AND skipped_scenario_ids = '[]'::jsonb
    AND (
      (
        evidence_version = 'northstar.verification-result-set/v1'
        AND execution_scope = 'FULL'
        AND impact_analysis_derivation IS NULL
      )
      OR
      (
        evidence_version = 'northstar.verification-result-set/v2'
        AND execution_scope = 'EXACT_PARTITION'
        AND jsonb_typeof(impact_analysis_derivation) = 'object'
        AND impact_analysis_derivation ? 'schemaVersion'
        AND impact_analysis_derivation ? 'derivations'
        AND impact_analysis_derivation - 'schemaVersion' - 'derivations' =
          '{}'::jsonb
        AND impact_analysis_derivation ->> 'schemaVersion' =
          'northstar.verification-impact-analysis/v1'
        AND jsonb_typeof(
          impact_analysis_derivation -> 'derivations'
        ) = 'array'
        AND jsonb_array_length(
          impact_analysis_derivation -> 'derivations'
        ) > 0
      )
    )
  );
