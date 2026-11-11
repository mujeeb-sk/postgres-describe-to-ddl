CREATE FOREIGN TABLE public.hashed_1 PARTITION OF hashed
FOR VALUES WITH (modulus 2, remainder 1)
SERVER file_srv
OPTIONS (filename '/dev/null');

ALTER FOREIGN TABLE public.hashed_1 ALTER COLUMN data OPTIONS (force_null 'true');
