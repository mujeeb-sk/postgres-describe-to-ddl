CREATE TABLE public.gen_ref (
    a integer
);

ALTER TABLE public.gen_ref ADD CONSTRAINT gen_ref_fk FOREIGN KEY (a) REFERENCES app.customers(id) NOT ENFORCED;
