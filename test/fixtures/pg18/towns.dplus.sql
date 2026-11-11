CREATE TABLE public.towns (
    name text,
    population real,
    msg text,
    mayor text,
    CONSTRAINT pop_check CHECK (population >= 0::double precision)
)
INHERITS (cities, app.audit_log);
