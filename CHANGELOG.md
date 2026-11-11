# Changelog

## 1.0.0

First release.

- **Convert \d Output to CREATE TABLE**: turns psql `\d` or `\d+` output (the selection, the whole editor, or the clipboard) into SQL in a new tab. Also on the terminal's right-click menu.
- **Replace \d Output with CREATE TABLE**: swaps the selected output for its SQL in place.
- Converts tables, partitioned tables and partitions, foreign tables, views and materialized views, with their indexes, constraints, triggers, rules, policies and statistics.
- Several `\d` outputs pasted together become one script, with parents before their partitions and foreign keys last.
- Reads psql's aligned, wrapped, unaligned and CSV formats in every border and line style, and partial pastes without the title or column header.
- Ignores indentation, mail quoting and comment leaders in front of the lines, and the prompts and query results around the output.
- Setting for writing an integer column that uses its own sequence as `serial`.
