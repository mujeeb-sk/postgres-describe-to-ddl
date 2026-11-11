CREATE MATERIALIZED VIEW public.mv_orders
WITH (fillfactor=90)
AS
 SELECT customer_id,
    count(*) AS n,
    sum(price) AS total
   FROM orders
  GROUP BY customer_id;

CREATE UNIQUE INDEX mv_orders_customer ON public.mv_orders USING btree (customer_id);
