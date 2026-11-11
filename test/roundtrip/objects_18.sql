-- Fixture relations for PostgreSQL 18+.

-- Not-null constraints have names, and \d+ lists them: a name of one's own, NO INHERIT, NOT VALID,
-- and on a child or partition the parent's constraint next to its own.
-- (NO INHERIT is on a table without children: plain \d doesn't print it, so a child couldn't be
-- recreated from \d alone.)
CREATE TABLE nn_alone (a integer, b integer NOT NULL NO INHERIT);
CREATE TABLE nn_parent (
  a integer CONSTRAINT my_nn NOT NULL,
  c integer,
  d integer NOT NULL,
  "E e" integer CONSTRAINT "Odd ""nn""" NOT NULL,
  id serial CONSTRAINT id_nn NOT NULL
);
ALTER TABLE nn_parent ADD CONSTRAINT c_nn NOT NULL c NOT VALID;
CREATE TABLE nn_child (z integer NOT NULL, a integer NOT NULL) INHERITS (nn_parent);
CREATE TABLE nn_part (a integer CONSTRAINT par_nn NOT NULL, b integer NOT NULL, c integer) PARTITION BY LIST (a);
CREATE TABLE nn_part_1 PARTITION OF nn_part FOR VALUES IN (1);
CREATE TABLE nn_part_2 PARTITION OF nn_part (c CONSTRAINT own_nn NOT NULL) FOR VALUES IN (2);

-- Keys WITHOUT OVERLAPS, and a foreign key with PERIOD.
CREATE TABLE rooms (id integer, valid_at daterange, CONSTRAINT rooms_pk PRIMARY KEY (id, valid_at WITHOUT OVERLAPS));
CREATE TABLE room_names (
  id integer,
  valid_at daterange,
  name text,
  CONSTRAINT room_names_uq UNIQUE (id, valid_at WITHOUT OVERLAPS) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT room_names_fk FOREIGN KEY (id, PERIOD valid_at) REFERENCES rooms (id, PERIOD valid_at)
);
CREATE TABLE rooms_ts (
  id integer,
  valid_at daterange,
  CONSTRAINT rooms_ts_pk PRIMARY KEY (id, valid_at WITHOUT OVERLAPS) USING INDEX TABLESPACE "Fast Space"
);

-- Virtual generated columns, and constraints that are not enforced.
CREATE TABLE gen_tbl (
  a integer,
  b integer GENERATED ALWAYS AS (a * 2) VIRTUAL,
  c integer GENERATED ALWAYS AS (a + 1) STORED,
  CONSTRAINT gen_chk CHECK (a > 0) NOT ENFORCED
);
CREATE TABLE gen_ref (a integer, CONSTRAINT gen_ref_fk FOREIGN KEY (a) REFERENCES app.customers (id) NOT ENFORCED);
