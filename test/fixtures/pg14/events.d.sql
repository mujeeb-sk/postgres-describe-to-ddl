CREATE TABLE public.events (
    id integer NOT NULL,
    customer_id integer,
    at date NOT NULL
)
PARTITION BY RANGE (at);

ALTER TABLE public.events ADD CONSTRAINT events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id);

CREATE TRIGGER events_trg AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION trg_fn();

-- Not included: partitions (1). Convert the \d+ output to get the partitions too.
-- \d+ public.events
