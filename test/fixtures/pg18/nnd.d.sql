CREATE TABLE public.nnd (
    a integer,
    b integer,
    c integer,
    CONSTRAINT nnd_a_key UNIQUE NULLS NOT DISTINCT (a) INCLUDE (b)
);

CREATE UNIQUE INDEX nnd_b_idx ON public.nnd USING btree (b) NULLS NOT DISTINCT;

-- Publications this table is in (the publications must exist first):
-- ALTER PUBLICATION pub2 ADD TABLE public.nnd (a, b) WHERE (a > 0);
