CREATE TABLE public.secrets (
    id integer,
    secret text
);

ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secrets FORCE ROW LEVEL SECURITY;
