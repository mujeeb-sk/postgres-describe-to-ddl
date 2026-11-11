CREATE TABLE public.loose (
    id integer
);

CREATE POLICY loose_p ON public.loose
    USING ((id > 0));
