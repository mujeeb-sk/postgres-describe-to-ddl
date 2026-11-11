CREATE TABLE app.audit_log (
    msg text
);

-- Not included: child tables (1). Convert the \d+ output to get the partitions too.
-- \d+ app.audit_log
