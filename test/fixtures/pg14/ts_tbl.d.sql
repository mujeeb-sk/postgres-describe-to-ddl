CREATE TABLE public.ts_tbl (
    a integer,
    b text NOT NULL,
    c tstzrange,
    CONSTRAINT ts_tbl_pkey PRIMARY KEY (b) USING INDEX TABLESPACE "Fast Space",
    CONSTRAINT ts_tbl_excl EXCLUDE USING gist (c WITH &&) USING INDEX TABLESPACE "Fast Space" WHERE (a > 10)
)
TABLESPACE "Fast Space";

CREATE INDEX ts_tbl_a_idx ON public.ts_tbl USING btree (a) TABLESPACE "Fast Space" WHERE a > 0;
CREATE INDEX ts_tbl_b_idx ON public.ts_tbl USING btree (b) TABLESPACE "Fast Space";
ALTER TABLE public.ts_tbl CLUSTER ON ts_tbl_b_idx;
