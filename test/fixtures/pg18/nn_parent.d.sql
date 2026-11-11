CREATE TABLE public.nn_parent (
    a integer NOT NULL,
    c integer NOT NULL,
    d integer NOT NULL,
    "E e" integer NOT NULL,
    id serial
);

-- Not included: child tables (1). Convert the \d+ output to get the partitions too.
-- \d+ public.nn_parent
