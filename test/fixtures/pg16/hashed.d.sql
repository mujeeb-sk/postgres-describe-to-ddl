CREATE TABLE public.hashed (
    id integer,
    data text
)
PARTITION BY HASH (id);

-- Not included: partitions (2). Convert the \d+ output to get the partitions too.
-- \d+ public.hashed
