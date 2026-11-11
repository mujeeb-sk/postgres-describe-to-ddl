CREATE TABLE public.measurements_2025_h1 PARTITION OF measurements_2025 (
    val WITH OPTIONS DEFAULT 0
)
FOR VALUES FROM ('2025-01-01') TO ('2025-07-01');

-- IF NOT EXISTS skips the indexes PARTITION OF already made from the parent table's indexes.
CREATE INDEX IF NOT EXISTS measurements_2025_h1_region_idx ON public.measurements_2025_h1 USING btree (region);

-- Constraints that come from the parent table are created by PARTITION OF.
-- Uncomment any that were added to this partition only.
-- ALTER TABLE public.measurements_2025_h1 ADD CONSTRAINT measurements_2025_h1_pkey PRIMARY KEY (id, logdate);
