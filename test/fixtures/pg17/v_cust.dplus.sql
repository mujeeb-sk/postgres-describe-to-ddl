CREATE VIEW public.v_cust
WITH (security_barrier=true)
AS
 SELECT customers.id,
    customers.email
   FROM app.customers
  WHERE customers.score > 0::numeric
UNION ALL
 SELECT 0 AS id,
    'none'::character varying AS email;

COMMENT ON COLUMN public.v_cust.email IS 'view column comment';
