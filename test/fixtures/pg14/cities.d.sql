CREATE TABLE public.cities (
    name text NOT NULL,
    population real,
    CONSTRAINT pop_check CHECK (population >= 0::double precision)
);

-- Not included: child tables (3). Convert the \d+ output to get the partitions too.
-- \d+ public.cities
