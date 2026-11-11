CREATE TABLE public.wide_chars (
    id integer,
    "名前" text DEFAULT 'x|y'::text,
    "数量" integer NOT NULL,
    note text DEFAULT '日本|語'::text,
    face text DEFAULT '😀|x'::text
);

COMMENT ON COLUMN public.wide_chars."数量" IS '数|量';
