CREATE TABLE public.cities (
    name text NOT NULL,
    population real,
    CONSTRAINT pop_check CHECK (population >= 0::double precision)
);

-- Child tables (convert their own \d output):
-- capitals, ft_child, FOREIGN, towns
