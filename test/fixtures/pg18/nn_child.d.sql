CREATE SEQUENCE IF NOT EXISTS nn_parent_id_seq;

CREATE TABLE public.nn_child (
    a integer NOT NULL,
    c integer NOT NULL,
    d integer NOT NULL,
    "E e" integer NOT NULL,
    id integer DEFAULT nextval('nn_parent_id_seq'::regclass) NOT NULL,
    z integer NOT NULL
)
INHERITS (nn_parent);
