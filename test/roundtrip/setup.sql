-- Things the fixture tables depend on. Run in both the source and the target database.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS file_fdw;
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER file_srv FOREIGN DATA WRAPPER file_fdw;
CREATE SERVER "Remote Srv" FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost', dbname 'nowhere');

CREATE SCHEMA app;
CREATE SCHEMA "Mixed Case";
CREATE TYPE app.mood AS ENUM ('sad', 'ok', 'happy');
CREATE TYPE person_t AS (name text, age integer);
CREATE DOMAIN posint AS integer CHECK (VALUE > 0);
CREATE SEQUENCE shared_seq;

CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE FUNCTION view_ins_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;

DO $$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'alice') THEN CREATE ROLE alice; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'Bob') THEN CREATE ROLE "Bob"; END IF;
END$$;
CREATE PUBLICATION pub1;
