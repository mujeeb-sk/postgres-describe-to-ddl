CREATE VIEW public.v_check
WITH (check_option=local)
AS
 SELECT orders.order_id,
    orders.qty
   FROM orders
  WHERE orders.qty > 1;

CREATE TRIGGER v_check_ins INSTEAD OF INSERT ON v_check FOR EACH ROW EXECUTE FUNCTION view_ins_fn();
