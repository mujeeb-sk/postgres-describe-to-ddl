CREATE TABLE public.orders (
    order_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    customer_id integer NOT NULL,
    qty integer DEFAULT 1 NOT NULL,
    price numeric NOT NULL,
    total numeric GENERATED ALWAYS AS (qty::numeric * price) STORED,
    during tstzrange,
    referrer_id integer,
    CONSTRAINT orders_pkey PRIMARY KEY (order_id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT no_overlap EXCLUDE USING gist (customer_id WITH =, during WITH &&),
    CONSTRAINT orders_case_check CHECK (
CASE
    WHEN qty > 10 THEN price < 100::numeric
    ELSE true
END),
    CONSTRAINT orders_qty_check CHECK (qty > 0) NO INHERIT
);

ALTER TABLE public.orders ADD CONSTRAINT price_pos CHECK (price > 0::numeric) NOT VALID;

ALTER TABLE public.orders REPLICA IDENTITY FULL;

ALTER TABLE public.orders ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id) ON DELETE CASCADE;
ALTER TABLE public.orders ADD CONSTRAINT orders_referrer_fk FOREIGN KEY (referrer_id) REFERENCES app.customers(id) MATCH FULL ON UPDATE SET NULL;
