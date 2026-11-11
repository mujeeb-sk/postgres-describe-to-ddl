CREATE TABLE public.regions_eu PARTITION OF regions
FOR VALUES IN ('eu', 'uk', 'it''s');
