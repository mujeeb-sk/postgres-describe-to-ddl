CREATE TABLE public.measurements_def PARTITION OF measurements (
    region WITH OPTIONS NOT NULL,
    val WITH OPTIONS DEFAULT 42
)
DEFAULT;

-- IF NOT EXISTS skips the indexes PARTITION OF already made from the parent table's indexes.
CREATE INDEX IF NOT EXISTS measurements_def_region_idx ON public.measurements_def USING btree (region);

-- Constraints that come from the parent table are created by PARTITION OF.
-- Uncomment any that were added to this partition only.
-- ALTER TABLE public.measurements_def ADD CONSTRAINT measurements_def_pkey PRIMARY KEY (id, logdate);
