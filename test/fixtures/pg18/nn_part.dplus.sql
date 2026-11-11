CREATE TABLE public.nn_part (
    a integer CONSTRAINT par_nn NOT NULL,
    b integer NOT NULL,
    c integer
)
PARTITION BY LIST (a);

CREATE TABLE IF NOT EXISTS nn_part_1 PARTITION OF public.nn_part
FOR VALUES IN (1);
CREATE TABLE IF NOT EXISTS nn_part_2 PARTITION OF public.nn_part
FOR VALUES IN (2);
