CREATE TABLE public.events_2024 PARTITION OF events (
    id WITH OPTIONS NOT NULL,
    at WITH OPTIONS NOT NULL
)
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Foreign keys inherited from the parent table (created by PARTITION OF):
-- ALTER TABLE public.events_2024 ADD CONSTRAINT events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id);

-- Triggers that come from the parent table (created by PARTITION OF):
-- CREATE TRIGGER events_trg AFTER INSERT ON events_2024 FOR EACH ROW EXECUTE FUNCTION trg_fn();
