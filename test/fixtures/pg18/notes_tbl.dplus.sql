CREATE TABLE public.notes_tbl (
    id integer,
    body text,
    "a rather long column name" text DEFAULT 'a default that is long enough to be wrapped'::text
);

COMMENT ON COLUMN public.notes_tbl.id IS 'first line

  indented third line';
COMMENT ON COLUMN public.notes_tbl.body IS 'Ends with a full stop.';
