CREATE TABLE public.regions (
    code text,
    name text
)
PARTITION BY LIST (code);

-- Not included: partitions (1). Convert the \d+ output to get the partitions too.
-- \d+ public.regions
