CREATE TABLE public.measurements_2025 PARTITION OF measurements (
    val WITH OPTIONS DEFAULT 0
)
FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')
PARTITION BY RANGE (logdate);

-- IF NOT EXISTS skips the indexes PARTITION OF already made from the parent table's indexes.
CREATE INDEX IF NOT EXISTS measurements_2025_region_idx ON public.measurements_2025 USING btree (region);

CREATE TABLE IF NOT EXISTS measurements_2025_h1 PARTITION OF public.measurements_2025
FOR VALUES FROM ('2025-01-01') TO ('2025-07-01');

-- Constraints that come from the parent table are created by PARTITION OF.
-- Uncomment any that were added to this partition only.
-- ALTER TABLE public.measurements_2025 ADD CONSTRAINT measurements_2025_pkey PRIMARY KEY (id, logdate);
