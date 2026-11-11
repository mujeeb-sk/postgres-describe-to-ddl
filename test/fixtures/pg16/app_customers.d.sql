CREATE TABLE app.customers (
    id serial,
    email character varying(255) NOT NULL,
    name text COLLATE "C" DEFAULT 'anon'::text,
    "Display Name" text,
    "user" text,
    mood app.mood DEFAULT 'ok'::app.mood,
    score numeric(10,2),
    tags text[] DEFAULT '{}'::text[],
    created timestamp(3) with time zone DEFAULT now() NOT NULL,
    doc jsonb,
    code character(3),
    b bytea,
    note text DEFAULT 'a | b'::text,
    multi text DEFAULT 'line one
line two'::text,
    pos posint,
    CONSTRAINT customers_pkey PRIMARY KEY (id),
    CONSTRAINT customers_email_key UNIQUE (email),
    CONSTRAINT customers_score_check CHECK (score >= 0::numeric)
);

ALTER TABLE app.customers CLUSTER ON customers_pkey;
CREATE INDEX "Customers Mixed" ON app.customers USING btree ("Display Name" text_pattern_ops);
CREATE UNIQUE INDEX customers_code_uidx ON app.customers USING btree (code) INCLUDE (name) WITH (fillfactor='70');
CREATE INDEX customers_created_partial ON app.customers USING btree (created DESC NULLS LAST) WHERE score > 10::numeric;
CREATE INDEX customers_doc_gin ON app.customers USING gin (doc jsonb_path_ops);
CREATE INDEX customers_lower_name_idx ON app.customers USING btree (lower(name));

CREATE CONSTRAINT TRIGGER cust_ctrg AFTER INSERT ON app.customers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_fn();
CREATE TRIGGER cust_trg BEFORE INSERT OR UPDATE ON app.customers FOR EACH ROW EXECUTE FUNCTION trg_fn();
CREATE TRIGGER cust_trg_dis AFTER DELETE ON app.customers FOR EACH ROW WHEN (old.id > 0) EXECUTE FUNCTION trg_fn();
ALTER TABLE app.customers DISABLE TRIGGER cust_trg_dis;
CREATE TRIGGER cust_trg_always AFTER UPDATE OF email ON app.customers FOR EACH STATEMENT EXECUTE FUNCTION trg_fn();
ALTER TABLE app.customers ENABLE ALWAYS TRIGGER cust_trg_always;
CREATE TRIGGER cust_trg_replica AFTER TRUNCATE ON app.customers FOR EACH STATEMENT EXECUTE FUNCTION trg_fn();
ALTER TABLE app.customers ENABLE REPLICA TRIGGER cust_trg_replica;

CREATE RULE cust_rule AS
    ON DELETE TO app.customers
   WHERE old.id < 0 DO INSTEAD NOTHING;
CREATE RULE cust_rule_dis AS
    ON UPDATE TO app.customers
   WHERE old.id < '-10'::integer DO  INSERT INTO app.audit_log (msg)
  VALUES ('updated'::text);
ALTER TABLE app.customers DISABLE RULE cust_rule_dis;

ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "P Update" ON app.customers FOR UPDATE
    USING (
CASE
    WHEN (score > (5)::numeric) THEN true
    ELSE false
END);
CREATE POLICY p_all ON app.customers AS RESTRICTIVE
    USING (true)
    WITH CHECK (((email)::text <> ''::text));
CREATE POLICY p_sel ON app.customers FOR SELECT
    TO "Bob", alice
    USING ((score > (0)::numeric));

CREATE STATISTICS app.cust_stats (ndistinct, dependencies) ON email, name FROM app.customers;
CREATE STATISTICS app.cust_stats_all ON email, code FROM app.customers;
ALTER STATISTICS app.cust_stats_all SET STATISTICS 50;

-- Foreign keys of other tables that point at this one (recreate them with those tables):
-- ALTER TABLE events ADD CONSTRAINT events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id);
-- ALTER TABLE orders ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES app.customers(id) ON DELETE CASCADE;
-- ALTER TABLE orders ADD CONSTRAINT orders_referrer_fk FOREIGN KEY (referrer_id) REFERENCES app.customers(id) MATCH FULL ON UPDATE SET NULL;

-- Publications this table is in (the publications must exist first):
-- ALTER PUBLICATION pub1 ADD TABLE app.customers;
