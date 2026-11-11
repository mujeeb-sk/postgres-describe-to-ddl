CREATE TABLE public.people OF person_t (
    name WITH OPTIONS NOT NULL,
    age WITH OPTIONS DEFAULT 0 NOT NULL,
    CONSTRAINT people_pkey PRIMARY KEY (name)
);
