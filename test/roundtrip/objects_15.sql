-- Fixture relations for PostgreSQL 15+.
CREATE TABLE nnd (
  a integer,
  b integer,
  c integer,
  CONSTRAINT nnd_a_key UNIQUE NULLS NOT DISTINCT (a) INCLUDE (b)
);
CREATE UNIQUE INDEX nnd_b_idx ON nnd (b) NULLS NOT DISTINCT;
CREATE PUBLICATION pub2 FOR TABLE nnd (a, b) WHERE (a > 0);
