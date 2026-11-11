CREATE TABLE public.capitals (
    name text,
    population real,
    state character(2) DEFAULT 'XX'::bpchar,
    CONSTRAINT pop_check CHECK (population >= 0::double precision)
)
INHERITS (cities);
