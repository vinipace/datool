-- Durable scheduler jobs for procedure wait continuations.  Waits use the
-- existing channel job lease/idempotency machinery so a worker restart can
-- reclaim a due continuation without creating a second turn or delivery.
ALTER TABLE build_channel_job
  DROP CONSTRAINT IF EXISTS build_channel_job_kind_check;

ALTER TABLE build_channel_job
  ADD CONSTRAINT build_channel_job_kind_check
  CHECK (kind IN ('process_inbound','deliver_outbound','telegram_poll','resume_wait'));
