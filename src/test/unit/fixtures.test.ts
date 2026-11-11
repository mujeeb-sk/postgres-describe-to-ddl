// Checks the conversion of real psql output captured from PostgreSQL 14, 16, 17 and 18 (by
// `FIXTURES_DIR=test/fixtures npm run test:roundtrip`). The expected SQL in the .sql files was run
// and verified by the round trip; regenerate it with UPDATE_GOLDEN=1 after an intended change.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { convertDescribeOutput } from '../../ddl';
import { qualifiedName } from '../../ddl/ident';

const FIXTURES = path.resolve(__dirname, '../../../test/fixtures');
const update = !!process.env.UPDATE_GOLDEN;

const files = fs
  .readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.txt'))
  .sort();
// "orders.dplus.txt" is a base output; "orders.dplus.unicode.txt" the same in another format.
const bases = files.filter((f) => /\.(d|dplus)\.txt$/.test(f) || f.startsWith('user'));
const variants = files.filter((f) => !bases.includes(f));

const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const convert = (text: string, name?: string) =>
  convertDescribeOutput(text, { fallbackNames: name ? [name] : [] })?.sql;

for (const file of bases) {
  test(`converts ${file}`, () => {
    const sql = convert(read(file));
    if (!sql) {
      return assert.fail('nothing converted');
    }
    const golden = path.join(FIXTURES, file.replace(/\.txt$/, '.sql'));
    if (update || !fs.existsSync(golden)) {
      fs.writeFileSync(golden, sql);
    }
    assert.equal(sql, fs.readFileSync(golden, 'utf8'));
  });
}

const TITLE = /^\s*(.+?) "(.*)"$/;
const isHeader = (l: string) => /^\s*Column\s*\|/.test(l) || /^-+(\+-+)+$/.test(l);
// The same in any border and line style.
const isAnyHeader = (l: string) => /^[\s|│]*Column\s*[|│]/.test(l) || /^[-+─┼┬┴├┤┌┐└┘ ]*[-─][-+─┼┬┴├┤┌┐└┘ ]*$/.test(l);

for (const file of variants) {
  const base = file.replace(/\.[\w-]+\.txt$/, '.txt');
  test(`converts ${file} like the default format`, () => {
    assert.equal(convert(read(file)), convert(read(base)));
  });

  // The header says where the columns are; without it the bars have to. Unaligned output and
  // border 0 have no bars to go by.
  if (!/\.(unaligned[\w-]*|[\w-]*border0)\.txt$/.test(file)) {
    test(`converts ${file} without the column header like the default format`, () => {
      const [titleLine, ...rest] = read(file).split('\n');
      assert.equal(convert([titleLine, ...rest.filter((l) => !isAnyHeader(l))].join('\n')), convert(read(base)));
    });
  }
}

for (const file of bases.filter((f) => !f.startsWith('user'))) {
  const text = read(file);
  const [titleLine, ...rest] = text.split('\n');
  const title = TITLE.exec(titleLine);
  if (!title || !rest.some((l) => l.includes('|') && !isHeader(l))) {
    continue;
  }

  test(`converts ${file} without the column header`, () => {
    const withoutHeader = [titleLine, ...rest.filter((l) => !isHeader(l))].join('\n');
    assert.equal(convert(withoutHeader), convert(text));
  });

  // Without the title the kind of relation has to come from the footers, which works for these.
  if (['Table', 'Partitioned table', 'Foreign table'].includes(title[1])) {
    test(`converts ${file} from just the rows and footers, given the name`, () => {
      const [schema, ...name] = title[2].split('.');
      const rowsOnly = rest.filter((l) => !isHeader(l)).join('\n');
      assert.equal(convert(rowsOnly, qualifiedName([schema, name.join('.')])), convert(text));
    });
  }
}
