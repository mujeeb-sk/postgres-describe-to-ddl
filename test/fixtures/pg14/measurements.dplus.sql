CREATE TABLE public.measurements (
    id bigint NOT NULL,
    logdate date NOT NULL,
    region text,
    val integer DEFAULT 0,
    CONSTRAINT measurements_pkey PRIMARY KEY (id, logdate)
)
PARTITION BY RANGE (logdate);

CREATE INDEX measurements_region_idx ON public.measurements USING btree (region);

CREATE TABLE IF NOT EXISTS measurements_2024 PARTITION OF public.measurements
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE IF NOT EXISTS measurements_def PARTITION OF public.measurements
DEFAULT;

-- Partitions that are partitioned themselves: convert their own \d+ output for PARTITION BY and their partitions.
-- CREATE TABLE IF NOT EXISTS measurements_2025 PARTITION OF public.measurements
-- FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
