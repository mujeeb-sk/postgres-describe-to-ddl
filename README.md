# Postgres \d to CREATE TABLE

**Author:** Mujeeb · **Version:** 1.0.0

Paste what psql prints for `\d` or `\d+` and get the SQL that recreates the table: `CREATE TABLE`, `CREATE FOREIGN TABLE` (for any foreign data wrapper), and its indexes, constraints, triggers and so on.

```
test=# \d daily_metrics

 metric_01 | bigint                      |           |          |         |
 ...
 metric_40 | double precision            |           |          |         |
Server: analytics_server
```

becomes

```sql
CREATE FOREIGN TABLE daily_metrics (
    metric_01 bigint,
    ...
    metric_40 double precision
)
SERVER analytics_server;
```

## How to use it

Copy the output from psql (the terminal, a log, a chat message), then use one of these:

- **Postgres: Convert \d Output to CREATE TABLE** (Command Palette). It converts the selection in the editor, or the whole editor if it holds `\d` output, or else the clipboard. The SQL opens in a new tab.
- In VS Code's terminal, select the psql output, right-click and choose **Convert \d Output to CREATE TABLE**.
- In an editor, select the output, right-click and choose **Replace \d Output with CREATE TABLE** to swap it for the SQL in place. With several selections, each one is replaced with its own SQL.

You don't have to copy everything psql printed:

- The title line (`Table "public.orders"`) and the column header are optional. Without the title, the name is taken from the `\d` line above the output (`test=# \d daily_metrics`). If there's neither, the extension asks for the name.
- Without the `Server:` line of a foreign table, the SQL says `SERVER server_name` with a note to replace it.
- psql's display settings are understood: the aligned (default), wrapped, unaligned (`\a`, with any `\f` field separator) and CSV formats, borders 0 to 2, and the ascii, old-ascii and unicode line styles.
- Whatever stands in front of every line is ignored: indentation, the `> ` of a quoted mail, a comment leader (`-- `, `# `, `// `, ` * `).
- Other text around the output is left out: prompts, other commands and the results of queries.

## Many tables at once

Paste as many `\d` outputs as you like (a whole psql session, or `\d+ order*`), and you get one script:

- Parent tables come before their partitions and child tables, whatever order you pasted them in. Views come after the tables, and after the views they select from.
- Foreign keys, rules and policies are at the end, so they can refer to any of the pasted tables.
- If a partitioned table and one of its partitions are both pasted, the partition is created once.
- Blank lines separate pastes that are just rows (no title or `\d` line). The extension asks for each table's name, showing its first columns.

## What it converts

- Tables: regular, unlogged, temporary, partitioned (range, list, hash), partitions (including default and sub-partitioned ones), inherited (`INHERITS`), typed (`OF type`), and tables with no columns.
- Foreign tables, including foreign partitions and table and column `OPTIONS`.
- Views and materialized views, from `\d+` (plain `\d` doesn't show their query).
- Columns: types, collations, `NOT NULL`, defaults, identity and generated (stored and, from PostgreSQL 18, virtual) columns. An integer column that uses its own sequence becomes `serial`/`bigserial`/`smallserial`. Any other sequence a default uses is created first with `CREATE SEQUENCE IF NOT EXISTS`.
- Footers: indexes (unique, partial, expression, `INCLUDE`, storage options, tablespace, `CLUSTER`, replica identity), primary key, unique (`NULLS NOT DISTINCT`), exclusion, check (`NO INHERIT`, `NOT VALID`) and foreign-key constraints, including keys `WITHOUT OVERLAPS` and constraints that are `NOT ENFORCED` (PostgreSQL 18). Also triggers (including constraint triggers, disabled, `ALWAYS` and `REPLICA` ones), rules, row-level security and policies, extended statistics, partition key and bounds, `INHERITS`, tablespace, access method, and `WITH (...)` options.
- From `\d+` only: column comments, storage, compression and statistics targets, and the partition list of a partitioned table. On PostgreSQL 18 also the not-null constraints as they were made: their names, `NO INHERIT`, `NOT VALID`, and whether a child table or partition has its own or its parent's.

Some things are written as SQL comments rather than run, with the reason above them:

- A partition's primary key and other constraints, since `PARTITION OF` copies the parent's. Uncomment any that were added to that partition only. (A partition's indexes are created with `IF NOT EXISTS` for the same reason.)
- Foreign keys of other tables that point at this one (`Referenced by:`), unless those tables are pasted too.
- Publications the table is in, and anything psql printed that the extension doesn't recognise.

## What `\d` doesn't show

The SQL can only contain what psql printed. These are not in `\d` output, so they aren't in the SQL:

- The owner, `GRANT`s, and the table's own comment (`\dt+` shows that comment).
- Options of identity and serial sequences, and their current values.
- Column options set with `ALTER COLUMN ... SET (n_distinct = ...)`, and comments on indexes and constraints.
- `UNLOGGED` or `TEMPORARY`, when the title line wasn't pasted.
- Whether a materialized view was created `WITH NO DATA`.
- Spaces at the end of a line inside a comment or default that spans several lines: the aligned formats pad every line with spaces, so these can't be told apart. (Unaligned output keeps them.)

The types, functions, servers, roles and referenced tables the table uses must already exist where you run the SQL.

## What it can't read

- psql's HTML, AsciiDoc, LaTeX and troff formats. The command says which one it found.
- CSV and tuples-only (`\t`) output have no title and no footers, so only the columns are converted.
- Output of a psql that isn't in English. The columns are read by their position, with a note in the SQL, but the title and the footers aren't. Start psql with `LC_MESSAGES=C` for a full conversion.
- Lines that were cut short (a pager such as `less -S`, a selection narrower than the output) or re-wrapped (a mail client). The text that is gone can't be recovered, and nothing warns about it.
- With `\pset border 0`, the column header and the line of dashes under it are needed: there are no bars to find the columns by.
- `\pset linestyle old-ascii` together with border 0 or the wrapped format: values that span several lines can come out wrong.
- Sequences, indexes, composite types and TOAST tables: the SQL names them in a comment and converts nothing.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `describeToDdl.serialColumns` | `true` | Write integer columns that default to their own sequence as `serial` types. When off, the `nextval()` default is kept and the sequence is created first. |

## Tests

- `npm run test:unit` checks the conversion of real psql output (PostgreSQL 14, 16, 17 and 18, in every display format) against SQL that the round trip verified.
- `PG_BIN=/path/to/pg/bin npm run test:roundtrip` (several bin directories can be given, separated by `:`) creates a throwaway cluster for each, makes every kind of table there, converts psql's `\d` and `\d+` output for each one, runs the SQL in an empty database, and checks that psql then describes every table exactly as before. It does this one table at a time and with all of them pasted at once. `PSQL_BIN` describes with another version's psql.
- `npm run test:integration` runs the commands in a separate VS Code window.

## Release

Bump `version` in package.json, add the changes to CHANGELOG.md, commit, then push a matching tag. The Publish workflow runs the unit tests and publishes to the Marketplace.

```
git tag v1.0.1
git push origin v1.0.1
```

## License

MIT. The full text is in the LICENSE file.
