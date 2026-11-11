CREATE TABLE public.regions (
    code text,
    name text
)
PARTITION BY LIST (code);

CREATE TABLE IF NOT EXISTS regions_eu PARTITION OF public.regions
FOR VALUES IN ('eu', 'uk', 'it''s');
