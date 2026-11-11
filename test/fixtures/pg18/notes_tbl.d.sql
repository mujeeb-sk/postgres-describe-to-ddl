CREATE TABLE public.notes_tbl (
    id integer,
    body text,
    "a rather long column name" text DEFAULT 'a default that is long enough to be wrapped'::text
);
