CREATE MATERIALIZED VIEW public.mv_orders
WITH (fillfactor=90)
AS
 SELECT orders.customer_id,
    count(*) AS n,
    sum(orders.price) AS total
   FROM orders
  GROUP BY orders.customer_id;

CREATE UNIQUE INDEX mv_orders_customer ON public.mv_orders USING btree (customer_id);
