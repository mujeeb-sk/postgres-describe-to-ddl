CREATE UNLOGGED TABLE public.cache_tbl (
    k text NOT NULL,
    v text,
    expires timestamp with time zone,
    parent text,
    CONSTRAINT cache_tbl_pkey PRIMARY KEY (k)
);

ALTER TABLE public.cache_tbl ADD CONSTRAINT cache_tbl_parent_fkey FOREIGN KEY (parent) REFERENCES cache_tbl(k);
