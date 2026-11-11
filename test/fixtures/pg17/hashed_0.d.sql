CREATE TABLE public.hashed_0 PARTITION OF hashed
FOR VALUES WITH (modulus 2, remainder 0);
