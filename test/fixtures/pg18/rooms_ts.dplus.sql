CREATE TABLE public.rooms_ts (
    id integer NOT NULL,
    valid_at daterange NOT NULL,
    CONSTRAINT rooms_ts_pk PRIMARY KEY (id, valid_at WITHOUT OVERLAPS) USING INDEX TABLESPACE "Fast Space"
);
