CREATE VIEW public.v_check
WITH (check_option=local)
AS
 SELECT order_id,
    qty
   FROM orders
  WHERE qty > 1;

CREATE TRIGGER v_check_ins INSTEAD OF INSERT ON v_check FOR EACH ROW EXECUTE FUNCTION view_ins_fn();
