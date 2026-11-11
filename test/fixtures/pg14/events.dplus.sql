CREATE TABLE public.events (
    id integer NOT NULL,
    customer_id integer,
    at date NOT NULL
)
PARTITION BY RANGE (at);

ALTER TABLE public.events ADD CONSTRAINT events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id);

CREATE TRIGGER events_trg AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION trg_fn();

CREATE TABLE IF NOT EXISTS events_2024 PARTITION OF public.events
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
