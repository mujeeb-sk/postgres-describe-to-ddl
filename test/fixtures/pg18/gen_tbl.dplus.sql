CREATE TABLE public.gen_tbl (
    a integer,
    b integer GENERATED ALWAYS AS (a * 2) VIRTUAL,
    c integer GENERATED ALWAYS AS (a + 1) STORED,
    CONSTRAINT gen_chk CHECK (a > 0) NOT ENFORCED
);
