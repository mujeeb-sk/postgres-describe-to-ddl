CREATE TABLE public.measurements (
    id bigint NOT NULL,
    logdate date NOT NULL,
    region text,
    val integer DEFAULT 0,
    CONSTRAINT measurements_pkey PRIMARY KEY (id, logdate)
)
PARTITION BY RANGE (logdate);

CREATE INDEX measurements_region_idx ON public.measurements USING btree (region);

-- Not included: partitions (3). Convert the \d+ output to get the partitions too.
-- \d+ public.measurements
