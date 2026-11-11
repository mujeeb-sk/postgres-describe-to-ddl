CREATE FOREIGN TABLE public.ft_child (
    name text,
    population real,
    extra integer,
    CONSTRAINT pop_check CHECK (population >= 0::double precision)
)
INHERITS (cities)
SERVER file_srv
OPTIONS (filename '/dev/null');
