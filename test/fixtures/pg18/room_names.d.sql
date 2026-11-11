CREATE TABLE public.room_names (
    id integer,
    valid_at daterange,
    name text,
    CONSTRAINT room_names_uq UNIQUE (id, valid_at WITHOUT OVERLAPS) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.room_names ADD CONSTRAINT room_names_fk FOREIGN KEY (id, PERIOD valid_at) REFERENCES rooms(id, PERIOD valid_at);
