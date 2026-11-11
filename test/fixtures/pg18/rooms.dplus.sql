CREATE TABLE public.rooms (
    id integer NOT NULL,
    valid_at daterange NOT NULL,
    CONSTRAINT rooms_pk PRIMARY KEY (id, valid_at WITHOUT OVERLAPS)
);

-- Foreign keys of other tables that point at this one (recreate them with those tables):
-- ALTER TABLE room_names ADD CONSTRAINT room_names_fk FOREIGN KEY (id, PERIOD valid_at) REFERENCES rooms(id, PERIOD valid_at);
