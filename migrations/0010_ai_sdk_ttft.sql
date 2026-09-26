-- Recompute stored TTFT for existing data as well as future writes. Explicit
-- TTFT retains precedence; AI SDK streaming attributes are already milliseconds.
-- Replacing the column supports PostgreSQL 16 and rewrites each table once.
-- No raw attributes are changed, and dashboard reads still use the stored fact.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['traces','spans'] LOOP
 EXECUTE format('ALTER TABLE %I
 DROP COLUMN ttft_ms,
 ADD COLUMN ttft_ms double precision GENERATED ALWAYS AS (coalesce(
   datool_number(attributes_json,''ttft.ms''),
   datool_number(attributes_json,''latency.ttft_ms''),
   datool_number(attributes_json,''gen_ai.latency.time_to_first_token'')*1000,
   datool_number(attributes_json,''ai.response.msToFirstChunk''),
   datool_number(attributes_json,''ai.stream.msToFirstChunk'')
 )) STORED',t);
 END LOOP;
END $$;
