// Each row binds the verification to the swap that produced this generation.
// Reusing a release ID at a later fence never reuses its verification.
export const verifiedGenerationsSql = `(
  SELECT swap.*
    FROM platform.release_activation_swap_receipts AS swap
    JOIN platform.release_activation_verification_receipts AS verification
      USING (tenant_id, environment_id, activation_attempt_id, pointer_id, activated_release_id, fence)
   WHERE verification.status = 'SWAPPED_VERIFIED'
)`;

// The physical pointer remains the CAS authority. Requests can see its newest
// verified generation while verification of a later swap is still pending.
export const servingPointersSql = `(
  SELECT physical.tenant_id, physical.environment_id, physical.pointer_id,
         physical.release_id AS physical_release_id, physical.fence AS physical_fence,
         serving.activated_release_id AS release_id, serving.fence
    FROM platform.active_release_pointers AS physical
    LEFT JOIN LATERAL (
      SELECT generation.activated_release_id, generation.fence
        FROM ${verifiedGenerationsSql} AS generation
       WHERE generation.tenant_id = physical.tenant_id
         AND generation.environment_id = physical.environment_id
         AND generation.pointer_id = physical.pointer_id
         AND physical.release_id IS NOT NULL
         AND (generation.fence < physical.fence OR
              (generation.fence = physical.fence AND generation.activated_release_id = physical.release_id))
       ORDER BY generation.fence DESC LIMIT 1
    ) AS serving ON true
)`;
