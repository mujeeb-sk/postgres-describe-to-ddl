CREATE TABLE public.measurements_2024 PARTITION OF measurements (
    id WITH OPTIONS NOT NULL,
    logdate WITH OPTIONS NOT NULL,
    val WITH OPTIONS DEFAULT 0
)
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- IF NOT EXISTS skips the indexes PARTITION OF already made from the parent table's indexes.
CREATE INDEX IF NOT EXISTS measurements_2024_region_idx ON public.measurements_2024 USING btree (region);
CREATE INDEX IF NOT EXISTS measurements_2024_val_idx ON public.measurements_2024 USING btree (val);

COMMENT ON COLUMN public.measurements_2024.val IS 'partition comment';

-- Constraints that come from the parent table are created by PARTITION OF.
-- Uncomment any that were added to this partition only.
-- ALTER TABLE public.measurements_2024 ADD CONSTRAINT measurements_2024_pkey PRIMARY KEY (id, logdate);
