-- Persist the failure count a claim was written at, so a restart can tell a
-- claim that never reported back (count still at the claim value) from one
-- whose pass ran and failed again (count moved past it). NULL records that no
-- claim ever wrote the value.
ALTER TABLE transcriptions ADD COLUMN post_process_edit_retry_claim_count INTEGER;
