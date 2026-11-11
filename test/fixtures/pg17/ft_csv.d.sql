CREATE FOREIGN TABLE public.ft_csv (
    id integer OPTIONS (force_not_null 'true') NOT NULL,
    "name|x" text,
    note text COLLATE "C" DEFAULT 'x|y'::text,
    CONSTRAINT ft_chk CHECK (id > 0)
)
SERVER file_srv
OPTIONS (filename '/tmp/x.csv', format 'csv', delimiter '|', header 'true');
