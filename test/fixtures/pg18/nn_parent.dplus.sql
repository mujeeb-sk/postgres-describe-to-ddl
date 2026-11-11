CREATE SEQUENCE IF NOT EXISTS nn_parent_id_seq;

CREATE TABLE public.nn_parent (
    a integer CONSTRAINT my_nn NOT NULL,
    c integer,
    d integer NOT NULL,
    "E e" integer CONSTRAINT "Odd ""nn""" NOT NULL,
    id integer DEFAULT nextval('nn_parent_id_seq'::regclass) CONSTRAINT id_nn NOT NULL
);

ALTER SEQUENCE nn_parent_id_seq OWNED BY public.nn_parent.id;

ALTER TABLE public.nn_parent ADD CONSTRAINT c_nn NOT NULL c NOT VALID;

-- Child tables (convert their own \d output):
-- nn_child
