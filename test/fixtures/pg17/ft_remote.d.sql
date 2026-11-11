CREATE FOREIGN TABLE public.ft_remote (
    a integer,
    b text OPTIONS (column_name 'B col')
)
SERVER "Remote Srv"
OPTIONS (schema_name 'public', table_name 'remote t');

CREATE TRIGGER ft_trg BEFORE INSERT ON ft_remote FOR EACH ROW EXECUTE FUNCTION trg_fn();
