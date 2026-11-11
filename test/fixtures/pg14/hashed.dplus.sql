CREATE TABLE public.hashed (
    id integer,
    data text
)
PARTITION BY HASH (id);

CREATE TABLE IF NOT EXISTS hashed_0 PARTITION OF public.hashed
FOR VALUES WITH (modulus 2, remainder 0);
CREATE TABLE IF NOT EXISTS hashed_1 PARTITION OF public.hashed
FOR VALUES WITH (modulus 2, remainder 1);
