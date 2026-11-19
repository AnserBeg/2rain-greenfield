-- A failed generation can subsequently earn one successful verification.
-- Preserve the original failure and keep workflow activation tied to success.
ALTER TABLE platform.workflow_activation_watermarks
  DROP CONSTRAINT workflow_activation_watermark_tenant_id_environment_id_act_fkey,
  ADD COLUMN verification_status text GENERATED ALWAYS AS ('SWAPPED_VERIFIED'::text) STORED;
ALTER TABLE platform.release_activation_verification_receipts
  DROP CONSTRAINT release_activation_verification_receipts_pkey,
  ADD PRIMARY KEY (tenant_id, environment_id, activation_attempt_id, status),
  ADD COLUMN retry_of_status text,
  ADD CHECK (retry_of_status IS NULL OR
    (retry_of_status = 'SWAPPED_VERIFICATION_FAILED' AND status = 'SWAPPED_VERIFIED')),
  ADD FOREIGN KEY (tenant_id, environment_id, activation_attempt_id, retry_of_status)
    REFERENCES platform.release_activation_verification_receipts
    (tenant_id, environment_id, activation_attempt_id, status);
CREATE UNIQUE INDEX release_activation_verification_first_receipt
  ON platform.release_activation_verification_receipts (tenant_id, environment_id, activation_attempt_id)
  WHERE retry_of_status IS NULL;
ALTER TABLE platform.workflow_activation_watermarks
  ADD CONSTRAINT workflow_activation_watermark_verified_attempt_fkey
  FOREIGN KEY (tenant_id, environment_id, activation_attempt_id, verification_status)
  REFERENCES platform.release_activation_verification_receipts
    (tenant_id, environment_id, activation_attempt_id, status);

-- Only explicit recovery approvals name the failed swap being reversed.
ALTER TABLE platform.release_approvals
  ADD COLUMN recovery_of_attempt_id uuid,
  ADD FOREIGN KEY (tenant_id, environment_id, recovery_of_attempt_id)
  REFERENCES platform.release_activation_swap_receipts (tenant_id, environment_id, activation_attempt_id);
