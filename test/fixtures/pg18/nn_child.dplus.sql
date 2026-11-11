CREATE SEQUENCE IF NOT EXISTS nn_parent_id_seq;

CREATE TABLE public.nn_child (
    a integer NOT NULL,
    c integer,
    d integer,
    "E e" integer,
    id integer DEFAULT nextval('nn_parent_id_seq'::regclass),
    z integer NOT NULL
)
INHERITS (nn_parent);
