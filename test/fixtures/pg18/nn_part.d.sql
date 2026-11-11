CREATE TABLE public.nn_part (
    a integer NOT NULL,
    b integer NOT NULL,
    c integer
)
PARTITION BY LIST (a);

-- Not included: partitions (2). Convert the \d+ output to get the partitions too.
-- \d+ public.nn_part
