// Cases the fixtures from the local servers don't cover: partial pastes, older and newer psql
// versions, and options.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { convertDescribeOutput, findDescriptions, GenerateOptions } from '../../ddl';

const sql = (text: string, options?: GenerateOptions) => convertDescribeOutput(text, options)?.sql;
const lines = (...l: string[]) => l.join('\n');

test("the user's paste: rows without title or header, a \\d line and a Server footer", () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures/user/daily_metrics.txt'), 'utf8');
  const out = sql(text)!;
  assert.ok(out.startsWith('CREATE FOREIGN TABLE daily_metrics (\n    metric_01 bigint,\n'));
  assert.ok(out.includes('    metric_40 double precision,\n'));
  assert.ok(out.endsWith('    metric_54 bigint\n)\nSERVER analytics_server;\n'));
  assert.equal(out.match(/^ {4}metric_\d+ /gm)?.length, 54);
  assert.deepEqual(findDescriptions(text).unnamed, []);
});

const rows = lines(
  ' id   | bigint                      |           | not null |         | ',
  ' name | character varying(50)       | C         |          | \'x\'::character varying | (column_name \'Name\')',
);

test('rows alone: asks for the name, guesses a foreign table from the FDW options column', () => {
  assert.deepEqual(findDescriptions(rows), { found: true, recognized: false, unnamed: ['id, name'] });
  assert.equal(
    sql(rows),
    lines(
      "-- Note: The table name wasn't in the pasted text; replace table_name.",
      "-- Note: The foreign server wasn't in the pasted text; replace server_name.",
      '',
      'CREATE FOREIGN TABLE table_name (',
      '    id bigint NOT NULL,',
      '    name character varying(50) OPTIONS (column_name \'Name\') COLLATE "C" DEFAULT \'x\'::character varying',
      ')',
      'SERVER server_name;',
      '',
    ),
  );
});

test('a typed name is read like psql reads \\d patterns', () => {
  const out = sql(rows + '\nServer: s1', { fallbackNames: ['APP."MyTable"'] })!;
  assert.ok(out.startsWith('CREATE FOREIGN TABLE app."MyTable" (\n'), out);
});

test('PostgreSQL 9.x: one Modifiers column', () => {
  const text = lines(
    '                                   Table "public.t"',
    ' Column |          Type          |                   Modifiers                    ',
    '--------+------------------------+-----------------------------------------------',
    " id     | integer                | not null default nextval('t_id_seq'::regclass)",
    ' name   | character varying(100) | collate C not null',
    " note   | text                   | default 'x'::text",
    'Indexes:',
    '    "t_pkey" PRIMARY KEY, btree (id)',
    'Has OIDs: yes',
  );
  const expected = lines(
    'CREATE TABLE public.t (',
    '    id serial,',
    '    name character varying(100) COLLATE "C" NOT NULL,',
    "    note text DEFAULT 'x'::text,",
    '    CONSTRAINT t_pkey PRIMARY KEY (id)',
    ')',
    'WITH (oids=true);',
    '',
  );
  assert.equal(sql(text), expected);
  // And without the header, from the shape of the cells.
  assert.equal(sql(text.split('\n').filter((_, i) => i !== 1 && i !== 2).join('\n')), expected);
});

test('PostgreSQL 10-13 statistics names and a NOT VALID foreign key', () => {
  const out = sql(
    lines(
      '                Table "public.ab1"',
      ' Column |  Type   | Collation | Nullable | Default ',
      '--------+---------+-----------+----------+---------',
      ' a      | integer |           |          | ',
      ' b      | integer |           |          | ',
      'Foreign-key constraints:',
      '    "ab1_a_fkey" FOREIGN KEY (a) REFERENCES t(id) NOT VALID',
      'Statistics objects:',
      '    "public"."ab1_a_b_stats" (ndistinct, dependencies) ON a, b FROM ab1',
    ),
  )!;
  assert.ok(out.includes('ALTER TABLE public.ab1 ADD CONSTRAINT ab1_a_fkey FOREIGN KEY (a) REFERENCES t(id) NOT VALID;'));
  assert.ok(out.includes('CREATE STATISTICS public.ab1_a_b_stats (ndistinct, dependencies) ON a, b FROM public.ab1;'));
});

test('PostgreSQL 18: virtual generated columns, not-null constraint footers', () => {
  const out = sql(
    lines(
      '                                       Table "public.g"',
      ' Column |  Type   | Collation | Nullable |          Default           | Storage | Compression | Stats target | Description ',
      '--------+---------+-----------+----------+----------------------------+---------+-------------+--------------+-------------',
      ' a      | integer |           | not null |                            | plain   |             |              | ',
      ' b      | integer |           |          | generated always as (a * 2) | plain   |             |              | ',
      'Not-null constraints:',
      '    "g_a_not_null" NOT NULL "a"',
      'Access method: heap',
    ),
  );
  assert.equal(
    out,
    lines('CREATE TABLE public.g (', '    a integer NOT NULL,', '    b integer GENERATED ALWAYS AS (a * 2) VIRTUAL', ');', ''),
  );
});

test('temporary tables, DETACH PENDING partitions and disabled internal triggers', () => {
  const out = sql(
    lines(
      '               Table "pg_temp_3.tmp_part"',
      ' Column |  Type   | Collation | Nullable | Default ',
      '--------+---------+-----------+----------+---------',
      ' a      | integer |           |          | ',
      'Partition of: parent FOR VALUES IN (1) DETACH PENDING',
      'Disabled internal triggers:',
      '    "RI_ConstraintTrigger_c_16410" AFTER INSERT ON tmp_part FROM t NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_check_ins"()',
    ),
  )!;
  assert.ok(out.startsWith('CREATE TEMPORARY TABLE tmp_part PARTITION OF parent\nFOR VALUES IN (1);'), out);
  assert.ok(out.includes('\n-- "RI_ConstraintTrigger_c_16410" AFTER INSERT'), out);
});

test('several descriptions in one paste, with prompts, a pager and Windows line endings', () => {
  const text = lines(
    'test=# \\d a',
    '      Table "public.a"',
    ' Column |  Type   | Collation | Nullable | Default ',
    '--------+---------+-----------+----------+---------',
    ' x      | integer |           |          | ',
    '',
    'test=# \\d b',
    ' y      | text    |           |          | ',
    '(END)',
  ).replace(/\n/g, '\r\n');
  assert.equal(
    sql(text),
    lines('CREATE TABLE public.a (', '    x integer', ');', '', 'CREATE TABLE b (', '    y text', ');', ''),
  );
});

test('serialColumns: false keeps nextval() and creates the sequence first', () => {
  const text = lines(
    '                          Table "app.t"',
    ' Column |  Type   | Collation | Nullable |              Default              ',
    '--------+---------+-----------+----------+-----------------------------------',
    " id     | integer |           | not null | nextval('app.t_id_seq'::regclass)",
  );
  assert.ok(sql(text)!.includes('    id serial\n'));
  assert.equal(
    sql(text, { serialColumns: false }),
    lines(
      'CREATE SEQUENCE IF NOT EXISTS app.t_id_seq;',
      '',
      'CREATE TABLE app.t (',
      "    id integer DEFAULT nextval('app.t_id_seq'::regclass) NOT NULL",
      ');',
      '',
      'ALTER SEQUENCE app.t_id_seq OWNED BY app.t.id;',
      '',
    ),
  );
});

test('a sequence that is not the column\'s own stays a default', () => {
  const out = sql(
    lines(
      '        Table "public.t"',
      ' Column |  Type  | Collation | Nullable |          Default           ',
      '--------+--------+-----------+----------+----------------------------',
      " id     | bigint |           | not null | nextval('ids'::regclass)",
    ),
  )!;
  assert.ok(out.startsWith('CREATE SEQUENCE IF NOT EXISTS ids;\n\nCREATE TABLE public.t (\n'));
  assert.ok(out.includes("    id bigint DEFAULT nextval('ids'::regclass) NOT NULL\n"));
  assert.ok(!out.includes('OWNED BY'));
});

test('things that are not tables', () => {
  assert.equal(convertDescribeOutput('hello | world'.replace('|', '')), undefined);
  assert.deepEqual(findDescriptions('just some text'), { found: false, recognized: false, unnamed: [] });
  // A Markdown table has bars too, but its rows aren't \d's.
  assert.deepEqual(findDescriptions('| a | b |\n|---|---|\n| 1 | 2 |'), { found: false, recognized: false, unnamed: [] });
  const seq = sql(
    lines(
      '                     Sequence "public.s"',
      '  Type  | Start | Minimum |       Maximum       | Increment | Cycles? | Cache ',
      '--------+-------+---------+---------------------+-----------+---------+-------',
      ' bigint |     1 |       1 | 9223372036854775807 |         1 | no      |     1',
    ),
  );
  assert.equal(seq, '-- Sequence "public.s": only tables, foreign tables and views can be converted.\n');
});

const table = (title: string, ...body: string[]) =>
  lines(
    `                Table "${title}"`,
    ' Column |  Type   | Collation | Nullable | Default ',
    '--------+---------+-----------+----------+---------',
    ...body,
  );

test('several tables: parents first, then their partitions; foreign keys and rules after every table', () => {
  const text = lines(
    // A partition and a child pasted before their parents, a key to a table pasted later.
    table('public.p_2024', ' id     | integer |           | not null | ', "Partition of: p FOR VALUES IN (2024)"),
    '',
    table(
      'public.orders',
      ' id     | integer |           | not null | ',
      ' c      | integer |           |          | ',
      'Foreign-key constraints:',
      '    "orders_c_fkey" FOREIGN KEY (c) REFERENCES customers(id)',
      'Rules:',
      '    orders_r AS',
      '    ON DELETE TO orders DO INSTEAD  DELETE FROM customers',
      '  WHERE customers.id = old.c',
    ),
    '',
    table(
      'public.p',
      ' id     | integer |           | not null | ',
      'Partition key: LIST (id)',
      'Partitions: p_2024 FOR VALUES IN (2024),',
      '            p_2025 FOR VALUES IN (2025)',
    ),
    '',
    table(
      'public.customers',
      ' id     | integer |           | not null | ',
      'Indexes:',
      '    "customers_pkey" PRIMARY KEY, btree (id)',
      'Referenced by:',
      '    TABLE "orders" CONSTRAINT "orders_c_fkey" FOREIGN KEY (c) REFERENCES customers(id)',
    ),
  );
  assert.equal(
    sql(text),
    lines(
      'CREATE TABLE public.p (',
      '    id integer NOT NULL',
      ')',
      'PARTITION BY LIST (id);',
      '',
      // p_2024 comes from its own description, so only p_2025 is made from the list.
      'CREATE TABLE IF NOT EXISTS p_2025 PARTITION OF public.p',
      'FOR VALUES IN (2025);',
      '',
      'CREATE TABLE public.p_2024 PARTITION OF p (',
      '    id WITH OPTIONS NOT NULL',
      ')',
      'FOR VALUES IN (2024);',
      '',
      'CREATE TABLE public.orders (',
      '    id integer NOT NULL,',
      '    c integer',
      ');',
      '',
      'CREATE TABLE public.customers (',
      '    id integer NOT NULL,',
      '    CONSTRAINT customers_pkey PRIMARY KEY (id)',
      ');',
      '',
      '-- Foreign keys, rules and policies, now that all the tables exist.',
      '',
      'ALTER TABLE public.orders ADD CONSTRAINT orders_c_fkey FOREIGN KEY (c) REFERENCES customers(id);',
      'CREATE RULE orders_r AS',
      '    ON DELETE TO orders DO INSTEAD  DELETE FROM customers',
      '  WHERE customers.id = old.c;',
      '',
    ),
  );
});

test('several pastes of rows alone, told apart by the blank lines between them', () => {
  const text = lines(
    ' a      | integer |           |          | ',
    ' b      | text    |           |          | ',
    '',
    ' c      | bigint  |           | not null | ',
    'Server: analytics_server',
    '',
    ' d      | date    |           |          | ',
  );
  assert.deepEqual(findDescriptions(text).unnamed, ['a, b', 'c', 'd']);
  assert.equal(
    sql(text, { fallbackNames: ['one', 'app.two', ''] }),
    lines(
      'CREATE TABLE one (',
      '    a integer,',
      '    b text',
      ');',
      '',
      'CREATE FOREIGN TABLE app.two (',
      '    c bigint NOT NULL',
      ')',
      'SERVER analytics_server;',
      '',
      "-- Note: The table name wasn't in the pasted text; replace table_name.",
      '',
      'CREATE TABLE table_name (',
      '    d date',
      ');',
      '',
    ),
  );
});

test("several of the user's \\d pastes in a row", () => {
  const one = fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures/user/daily_metrics.txt'), 'utf8');
  const out = sql(one + one.replace(/daily_metrics/g, 'weekly_metrics') + one.replace(/daily_metrics/g, 'monthly_metrics'))!;
  assert.deepEqual(out.match(/^CREATE FOREIGN TABLE \w+/gm), [
    'CREATE FOREIGN TABLE daily_metrics',
    'CREATE FOREIGN TABLE weekly_metrics',
    'CREATE FOREIGN TABLE monthly_metrics',
  ]);
  assert.equal(out.match(/^SERVER analytics_server;$/gm)?.length, 3);
});

// ---- Text that reached the converter changed, or in another of psql's formats.

const small = lines(
  '                 Table "public.t"',
  ' Column |  Type   | Collation | Nullable |  Default  ',
  '--------+---------+-----------+----------+-----------',
  ' id     | integer |           | not null | ',
  " name   | text    |           |          | 'x'::text",
  'Indexes:',
  '    "t_pkey" PRIMARY KEY, btree (id)',
  '    "t_name_idx" btree (name)',
);
const smallSql = lines(
  'CREATE TABLE public.t (',
  '    id integer NOT NULL,',
  "    name text DEFAULT 'x'::text,",
  '    CONSTRAINT t_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE INDEX t_name_idx ON public.t USING btree (name);',
  '',
);

test('indented, quoted and commented-out pastes read like the plain text', () => {
  assert.equal(sql(small), smallSql);
  const each = (prefix: string, blank = prefix.trimEnd()) =>
    ('\n' + small + '\n').split('\n').map((l) => (l ? prefix + l : blank)).join('\n');
  for (const prefix of ['    ', '\t', '> ', '> > ', '>> ', '-- ', '# ', '// ', ' * ']) {
    assert.equal(sql(each(prefix)), smallSql, JSON.stringify(prefix));
  }
  // The rows alone, indented: their own leading space goes with the indentation.
  const rowsOnly = small.split('\n').slice(3, 5);
  assert.equal(
    sql(rowsOnly.map((l) => '      ' + l).join('\n'), { fallbackNames: ['t'] }),
    sql(rowsOnly.join('\n'), { fallbackNames: ['t'] }),
  );
});

test('psql --csv: quoted fields with commas, quotes, line breaks and blank lines', () => {
  const text = lines(
    'test=# \\d+ notes',
    'Column,Type,Collation,Nullable,Default,Storage,Compression,Stats target,Description',
    'id,integer,,not null,,plain,,,',
    'price,"numeric(10,2)",,,0,main,,,"first line',
    '',
    'says ""hi"", twice"',
    'body,text,,,"\'a,b\'::text",extended,,,',
  );
  assert.equal(
    sql(text),
    lines(
      'CREATE TABLE notes (',
      '    id integer NOT NULL,',
      '    price numeric(10,2) DEFAULT 0,',
      "    body text DEFAULT 'a,b'::text",
      ');',
      '',
      "COMMENT ON COLUMN notes.price IS 'first line",
      '',
      'says "hi", twice\';',
      '',
    ),
  );
});

test('unaligned output with another field separator (\\f): a comma, a tab', () => {
  const withSeparator = (s: string) =>
    lines(
      'Table "public.t"',
      ['Column', 'Type', 'Collation', 'Nullable', 'Default'].join(s),
      ['id', 'integer', '', 'not null', ''].join(s),
      ['price', 'numeric(10,2)', '', '', '0'].join(s),
      ['name', 'text', '', '', `'a${s}b'::text`].join(s),
      'Indexes:',
      '    "t_pkey" PRIMARY KEY, btree (id)',
    );
  const expected = (s: string) =>
    lines(
      'CREATE TABLE public.t (',
      '    id integer NOT NULL,',
      '    price numeric(10,2) DEFAULT 0,',
      `    name text DEFAULT 'a${s}b'::text,`,
      '    CONSTRAINT t_pkey PRIMARY KEY (id)',
      ');',
      '',
    );
  for (const s of [',', '\t', ';', '|']) {
    assert.equal(sql(withSeparator(s)), expected(s), JSON.stringify(s));
  }
});

test('several unaligned descriptions one after another', () => {
  const session = lines(
    'test=# \\a',
    'Output format is unaligned.',
    'test=# \\d a',
    'Table "public.a"',
    'Column|Type|Collation|Nullable|Default',
    'x|integer|||',
    'test=# \\d b',
    'Table "public.b"',
    'Column|Type|Collation|Nullable|Default',
    "y|text|||'two",
    '',
    "lines'::text",
    'test=# select 1;',
  );
  const expected = lines(
    'CREATE TABLE public.a (',
    '    x integer',
    ');',
    '',
    'CREATE TABLE public.b (',
    "    y text DEFAULT 'two",
    '',
    "lines'::text",
    ');',
    '',
  );
  assert.equal(sql(session), expected);
  // Without the prompts, and with nothing but the column header to tell the tables apart.
  const bare = session.split('\n').filter((l) => !l.startsWith('test=#') && !l.startsWith('Output'));
  assert.equal(sql(bare.join('\n')), expected);
  assert.deepEqual(findDescriptions(bare.filter((l) => !l.startsWith('Table')).join('\n')).unnamed, ['x', 'y']);
});

test('a header in another language: the columns are read by position, with a note', () => {
  const text = lines(
    '                 Tabelle »public.t«',
    ' Spalte |   Typ   | Sortierfolge | NULL erlaubt? | Vorgabewert ',
    '--------+---------+--------------+---------------+-------------',
    ' id     | integer |              | not null      | ',
    " name   | text    |              |               | 'x'::text",
    'Indexe:',
    '    "t_pkey" PRIMARY KEY, btree (id)',
  );
  assert.deepEqual(findDescriptions(text), { found: true, recognized: false, unnamed: ['id, name'] });
  const out = sql(text, { fallbackNames: ['t'] })!;
  assert.match(out, /^-- Note: The column header isn't the one an English psql prints/);
  assert.ok(out.includes("CREATE TABLE t (\n    id integer NOT NULL,\n    name text DEFAULT 'x'::text\n);"), out);
  assert.ok(out.includes('-- psql lines this converter does not know:\n-- Indexe: \n--     "t_pkey" PRIMARY KEY, btree (id)'), out);
});

test('query results, lists and other text with bars are not \\d output', () => {
  const result = lines(' id | name ', '----+------', '  1 | x', '  2 | y', '(2 rows)');
  const list = lines(
    '         List of relations',
    ' Schema |  Name  | Type  |  Owner   ',
    '--------+--------+-------+----------',
    ' public | orders | table | postgres',
    '(1 row)',
  );
  // Five columns, the fourth always empty: only the row count says it isn't a description.
  const wide = lines(' a | b | c | d | e ', '---+---+---+---+---', ' x | y | z |   | w', '(1 row)');
  for (const text of [result, list, wide, 'cat access.log | grep 500 | wc -l', '| a | b |\n|---|---|\n| 1 | 2 |']) {
    assert.equal(convertDescribeOutput(text), undefined, text);
    assert.deepEqual(findDescriptions(text), { found: false, recognized: false, unnamed: [] }, text);
  }
  // Next to a description, only the description is converted.
  assert.equal(sql(lines(result, '', small, '', list)), smallSql);
});

test('another psql prompt ends the description', () => {
  const text = lines(small, 'test=# select count(*) from t;', ' count ', '-------', '     0', '(1 row)', '', 'test=# ');
  assert.equal(sql(text), smallSql);
});

test("psql's other output formats are named, not converted", () => {
  const formats: Record<string, string> = {
    HTML: lines('<table border="1">', '  <caption>Table &quot;public.t&quot;</caption>', '  <tr>', '    <th align="center">Column</th>', '  </tr>', '</table>'),
    AsciiDoc: lines('.Table "public.t"', '[options="header",cols="<l,<l,<l,<l,<l",frame="none"]', '|====', '^l|Column ^l|Type ^l|Collation ^l|Nullable ^l|Default', '|id |integer |  |not null |', '|===='),
    LaTeX: lines('\\begin{center}', 'Table "public.t"', '\\end{center}', '', '\\begin{tabular}{l | l | l | l | l}', '\\textit{Column} & \\textit{Type} \\\\', '\\hline', 'id & integer \\\\', '\\end{tabular}'),
    troff: lines('.LP', '.DS C', 'Table "public.t"', '.DE', '.LP', '.TS', 'center;', 'l | l.', '\\fIColumn\\fP\t\\fIType\\fP', '_', 'id\tinteger', '.TE'),
  };
  for (const [name, text] of Object.entries(formats)) {
    assert.equal(convertDescribeOutput(text), undefined, name);
    assert.deepEqual(findDescriptions(text), { unsupported: name, found: false, recognized: false, unnamed: [] });
  }
  assert.equal(findDescriptions(small).unsupported, undefined);
});

const view = (name: string, from: string, kind = 'View') =>
  lines(
    `                 ${kind} "public.${name}"`,
    ' Column |  Type   | Collation | Nullable | Default | Storage | Description ',
    '--------+---------+-----------+----------+---------+---------+-------------',
    ' a      | integer |           |          |         | plain   | ',
    'View definition:',
    ' SELECT a',
    `   FROM ${from};`,
  );

test('views are created after the views they select from, whatever order they were pasted in', () => {
  const text = lines(view('v3', '"V 2"'), '', view('unrelated', "t\n  WHERE 'v1'::text IS NOT NULL"), '', view('V 2', 'v1', 'Materialized view'), '', view('v1', 't'));
  assert.deepEqual(sql(text)!.match(/^CREATE (?:MATERIALIZED )?VIEW \S+( \S+")?/gm), [
    'CREATE VIEW public.v1',
    'CREATE MATERIALIZED VIEW public."V 2"',
    'CREATE VIEW public.v3',
    // Naming v1 in a string doesn't make it depend on v1: it stays where it was pasted.
    'CREATE VIEW public.unrelated',
  ]);
});

test('PostgreSQL 18: not-null constraints keep their names, NO INHERIT and NOT VALID', () => {
  const describe = (title: string, columns: string[], ...footers: string[]) =>
    lines(
      `                                    Table "public.${title}"`,
      ' Column |  Type   | Collation | Nullable | Default | Storage | Compression | Stats target | Description ',
      '--------+---------+-----------+----------+---------+---------+-------------+--------------+-------------',
      ...columns.map((c) => ` ${c.padEnd(6)} | integer |           | not null |         | plain   |             |              | `),
      ...footers,
    );
  const parent = describe(
    'p',
    ['a', 'b', 'c', 'd'],
    'Not-null constraints:',
    '    "my_nn" NOT NULL "a"',
    '    "p_b_not_null" NOT NULL "b" NO INHERIT',
    '    "c_nn" NOT NULL "c" NOT VALID',
    '    "p_d_not_null" NOT NULL "d"',
    'Child tables: ch',
    'Access method: heap',
  );
  assert.equal(
    sql(parent),
    lines(
      'CREATE TABLE public.p (',
      '    a integer CONSTRAINT my_nn NOT NULL,',
      '    b integer NOT NULL NO INHERIT,',
      '    c integer,',
      '    d integer NOT NULL',
      ');',
      '',
      'ALTER TABLE public.p ADD CONSTRAINT c_nn NOT NULL c NOT VALID;',
      '',
      '-- Child tables (convert their own \\d output):',
      '-- ch',
      '',
    ),
  );
  // What the child inherits isn't repeated; what it adds is.
  const child = describe(
    'ch',
    ['a', 'c', 'd', 'z'],
    'Not-null constraints:',
    '    "ch_a_not_null" NOT NULL "a" (local, inherited)',
    '    "c_nn" NOT NULL "c" (inherited)',
    '    "p_d_not_null" NOT NULL "d" (inherited)',
    '    "own" NOT NULL "z"',
    'Inherits: p',
    'Access method: heap',
  );
  assert.equal(
    sql(child),
    lines(
      'CREATE TABLE public.ch (',
      '    a integer NOT NULL,',
      '    c integer,',
      '    d integer,',
      '    z integer CONSTRAINT own NOT NULL',
      ')',
      'INHERITS (p);',
      '',
    ),
  );
});

test('PostgreSQL 18: keys WITHOUT OVERLAPS are table constraints, not indexes', () => {
  const out = sql(
    lines(
      '                   Table "public.rooms"',
      '  Column  |   Type    | Collation | Nullable | Default ',
      '----------+-----------+-----------+----------+---------',
      ' id       | integer   |           | not null | ',
      ' valid_at | daterange |           | not null | ',
      'Indexes:',
      '    "rooms_pk" PRIMARY KEY (id, valid_at WITHOUT OVERLAPS), tablespace "fast"',
      '    "rooms_uq" UNIQUE (id, valid_at WITHOUT OVERLAPS) DEFERRABLE INITIALLY DEFERRED',
    ),
  );
  assert.equal(
    out,
    lines(
      'CREATE TABLE public.rooms (',
      '    id integer NOT NULL,',
      '    valid_at daterange NOT NULL,',
      '    CONSTRAINT rooms_pk PRIMARY KEY (id, valid_at WITHOUT OVERLAPS) USING INDEX TABLESPACE fast,',
      '    CONSTRAINT rooms_uq UNIQUE (id, valid_at WITHOUT OVERLAPS) DEFERRABLE INITIALLY DEFERRED',
      ');',
      '',
    ),
  );
});
