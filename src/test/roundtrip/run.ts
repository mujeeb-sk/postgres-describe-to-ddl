// Round trip against real PostgreSQL servers: create the fixture relations, convert psql's \d and \d+
// output for each, run the result in an empty database and check that psql then describes every
// relation exactly as it described the original.
//
//   PG_BIN=/path/to/pg/bin[:/another/pg/bin] npm run test:roundtrip
//
// Each PG_BIN gets a throwaway cluster in the temp directory, on a free port, removed afterwards.
// PSQL_BIN picks a different psql to describe with (psql output depends on the client version).
// FIXTURES_DIR=test/fixtures also saves the captured output there for the unit tests.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { convertDescribeOutput } from '../../ddl';

const ROOT = path.resolve(__dirname, '../../..');

// psql display settings that change how \d looks; each must convert to the same SQL as the default.
const FORMATS: Record<string, string[]> = {
  unicode: ['-P', 'linestyle=unicode'],
  border2: ['-P', 'border=2'],
  'unicode-border2': ['-P', 'linestyle=unicode', '-P', 'border=2'],
  border0: ['-P', 'border=0'],
  'old-ascii': ['-P', 'linestyle=old-ascii'],
  unaligned: ['-A'],
  'unaligned-comma': ['-A', '-F', ','],
  // Wrapped to a narrow terminal, which cuts up \d's cells, and to a wider one, which cuts up \d+'s.
  wrapped: ['-P', 'format=wrapped', '-P', 'columns=60'],
  'wrapped-unicode': ['-P', 'format=wrapped', '-P', 'columns=60', '-P', 'linestyle=unicode'],
  'wrapped-border0': ['-P', 'format=wrapped', '-P', 'columns=60', '-P', 'border=0'],
  'wrapped-wide': ['-P', 'format=wrapped', '-P', 'columns=110'],
};
const SQL_DIR = path.join(ROOT, 'test/roundtrip');

// Relations whose output is also saved in every format when FIXTURES_DIR is set.
const FORMAT_FIXTURES = ['app.customers', 'orders', 'ft_csv', 'notes_tbl', 'wide_chars'];

const fixtureBase = (name: string) => name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_|_$/g, '');

interface Relation {
  name: string;
  kind: string;
  isPartition: boolean;
}

class Cluster {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-rt-'));
  port = 0;
  psqlBin: string;

  constructor(readonly bin: string) {
    this.psqlBin = process.env.PSQL_BIN || bin;
  }

  async start(): Promise<void> {
    this.port = await freePort();
    // UTF8 whatever the locale is: the fixtures have names and values outside ASCII.
    execFileSync(path.join(this.bin, 'initdb'), ['-D', this.dir, '-U', 'postgres', '-E', 'UTF8', '--auth=trust', '--no-sync'], {
      stdio: 'ignore',
    });
    const conf = `port = ${this.port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n`;
    fs.appendFileSync(path.join(this.dir, 'postgresql.conf'), conf);
    execFileSync(path.join(this.bin, 'pg_ctl'), ['-D', this.dir, '-l', path.join(this.dir, 'log.txt'), '-w', 'start'], {
      stdio: 'ignore',
    });
  }

  stop(): void {
    spawnSync(path.join(this.bin, 'pg_ctl'), ['-D', this.dir, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    if (!process.env.KEEP) {
      fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /** Runs psql; returns stdout and stderr, and whether it succeeded. */
  psql(db: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync(
      path.join(this.psqlBin, 'psql'),
      ['-X', '-h', '127.0.0.1', '-p', String(this.port), '-U', 'postgres', '-d', db, ...args],
      { input, encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } },
    );
    return { ok: r.status === 0, out: r.stdout, err: r.stderr };
  }

  run(db: string, sql: string): void {
    const r = this.psql(db, ['-q', '-v', 'ON_ERROR_STOP=1'], sql);
    if (!r.ok) {
      throw new Error(`psql failed in ${db}:\n${r.err}`);
    }
  }

  query(db: string, sql: string): string[] {
    const r = this.psql(db, ['-Atq', '-c', sql]);
    if (!r.ok) {
      throw new Error(`query failed in ${db}:\n${r.err}`);
    }
    return r.out.split('\n').filter(Boolean);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const read = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8');

/** Output differences that are expected, because the converter writes those parts as comments. */
function normalize(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^Publications:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^ {4}/.test(line)) {
      continue;
    }
    skipping = false;
    out.push(line.replace(/satisfies_hash_partition\('\d+'::oid/, "satisfies_hash_partition('<oid>'::oid"));
  }
  return out.join('\n');
}

/** A line diff (longest common subsequence), good enough for a few hundred lines. */
function diff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const lcs = a.map(() => new Array<number>(b.length + 1).fill(0));
  lcs.push(new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push('+ ' + b[j++]);
    } else {
      out.push('- ' + a[i++]);
    }
  }
  return out.join('\n');
}

async function roundTrip(bin: string): Promise<number> {
  const cluster = new Cluster(bin);
  await cluster.start();
  let failures = 0;
  let tablespaceDir: string | undefined;
  try {
    const version = Number(cluster.query('postgres', 'SHOW server_version_num')[0]);
    const label = `PostgreSQL ${Math.floor(version / 10000)} (psql from ${cluster.psqlBin})`;
    console.log(`\n# ${label}`);

    const setup = read('setup.sql');
    let objects = read('objects.sql');
    if (version >= 150000) {
      objects += read('objects_15.sql');
    }
    if (version >= 180000) {
      objects += read('objects_18.sql');
    }
    tablespaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-rt-ts-'));
    cluster.run('postgres', `CREATE TABLESPACE "Fast Space" LOCATION '${tablespaceDir}'`);
    const pasteDbs = ['all_d_reversed', 'all_d_in_order', 'all_dplus_reversed', 'all_dplus_in_order'];
    for (const db of ['src', 'dst_d', 'dst_dplus', ...pasteDbs]) {
      cluster.run('postgres', `CREATE DATABASE ${db}`);
      cluster.run(db, setup);
    }
    cluster.run('src', objects);

    // Creation (oid) order is dependency order. Extension members are created by the extension.
    const relations: Relation[] = cluster
      .query(
        'src',
        `SELECT c.oid::regclass::text || '|' || c.relkind::text || '|' || c.relispartition::text
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'app', 'Mixed Case') AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
            AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                            AND d.objid = c.oid AND d.deptype = 'e')
          ORDER BY c.oid`,
      )
      .map((row) => {
        const [name, kind, isPartition] = row.split('|');
        return { name, kind, isPartition: isPartition === 'true' };
      });

    const fixturesDir = process.env.FIXTURES_DIR
      ? path.resolve(ROOT, process.env.FIXTURES_DIR, `pg${Math.floor(version / 10000)}`)
      : undefined;
    if (fixturesDir) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    for (const mode of ['d', 'd+'] as const) {
      const db = mode === 'd' ? 'dst_d' : 'dst_dplus';
      const described = new Map<string, string>();
      let converted = 0;
      for (const rel of relations) {
        const output = cluster.psql('src', ['-c', `\\${mode} ${rel.name}`]).out;
        described.set(rel.name, output);
        if (fixturesDir) {
          fs.writeFileSync(path.join(fixturesDir, `${fixtureBase(rel.name)}.${mode === 'd' ? 'd' : 'dplus'}.txt`), output);
        }
        if (mode === 'd' && (rel.kind === 'v' || rel.kind === 'm')) {
          continue; // \d doesn't show a view's query.
        }
        const sql = convertDescribeOutput(output)?.sql;
        if (!sql) {
          console.log(`not ok - ${mode} ${rel.name}: nothing converted`);
          failures++;
          continue;
        }
        for (const [format, args] of Object.entries(FORMATS)) {
          const variant = cluster.psql('src', [...args, '-c', `\\${mode} ${rel.name}`]).out;
          if (fixturesDir && FORMAT_FIXTURES.includes(rel.name)) {
            fs.writeFileSync(path.join(fixturesDir, `${fixtureBase(rel.name)}.${mode === 'd' ? 'd' : 'dplus'}.${format}.txt`), variant);
          }
          const variantSql = convertDescribeOutput(variant)?.sql;
          if (variantSql !== sql) {
            console.log(`not ok - ${mode} ${rel.name} (${format}): converts differently\n${diff(sql, variantSql ?? '')}`);
            failures++;
          }
        }
        // A parent's \d+ already created its plain partitions; the partition's own output recreates it fully.
        const exists = cluster.query(db, `SELECT to_regclass('${rel.name.replace(/'/g, "''")}') IS NOT NULL`)[0] === 't';
        const drop = rel.isPartition && exists ? `DROP TABLE ${rel.name};\n` : '';
        const r = cluster.psql(db, ['-q', '-v', 'ON_ERROR_STOP=1'], drop + sql);
        if (!r.ok) {
          console.log(`not ok - ${mode} ${rel.name}: the SQL failed\n${r.err}\n${sql}`);
          failures++;
        } else {
          converted++;
        }
      }
      // Compare once everything exists, so "Referenced by" and child lists are complete on both sides.
      const compare = (db: string, what: string) => {
        let same = 0;
        for (const rel of relations) {
          if (mode === 'd' && (rel.kind === 'v' || rel.kind === 'm')) {
            continue;
          }
          const expected = normalize(described.get(rel.name)!);
          const actual = normalize(cluster.psql(db, ['-c', `\\${mode} ${rel.name}`]).out);
          if (expected === actual) {
            same++;
          } else {
            console.log(`not ok - ${mode} ${rel.name} (${what}): described differently\n${diff(expected, actual)}`);
            failures++;
          }
        }
        return same;
      };
      const same = compare(db, 'one at a time');
      console.log(`ok - \\${mode}: ${converted} relations converted and run one at a time, ${same} described identically`);

      // Everything pasted at once makes one script: last-created first after psql prompts (so parents
      // come after their partitions and keys point forward), and in order the way \\d+ * prints it.
      const pastes = {
        reversed: [...relations].reverse().map((rel) => `src=# \\${mode} ${rel.name}\n${described.get(rel.name)}`),
        in_order: relations.map((rel) => described.get(rel.name)!),
      };
      for (const [order, parts] of Object.entries(pastes)) {
        const pasteDb = `all_${mode === 'd' ? 'd' : 'dplus'}_${order}`;
        if (fixturesDir) {
          fs.writeFileSync(path.join(fixturesDir, `all_${order}.${mode === 'd' ? 'd' : 'dplus'}.txt`), parts.join('\n'));
        }
        const sql = convertDescribeOutput(parts.join('\n'))?.sql ?? '';
        const r = cluster.psql(pasteDb, ['-q', '-v', 'ON_ERROR_STOP=1'], sql);
        if (!r.ok) {
          console.log(`not ok - ${mode} all pasted at once (${order}): the SQL failed\n${r.err}`);
          failures++;
          continue;
        }
        const n = compare(pasteDb, `all pasted at once, ${order}`);
        console.log(`ok - \\${mode}: all ${relations.length} pasted at once (${order.replace('_', ' ')}), ${n} described identically`);
      }
    }
  } finally {
    cluster.stop();
    if (tablespaceDir && !process.env.KEEP) {
      fs.rmSync(tablespaceDir, { recursive: true, force: true });
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const bins = (process.env.PG_BIN ?? '').split(':').filter(Boolean);
  if (bins.length === 0) {
    console.error('Set PG_BIN to the bin directory of a PostgreSQL install (several separated by ":").');
    process.exit(2);
  }
  let failures = 0;
  for (const bin of bins) {
    failures += await roundTrip(bin);
  }
  console.log(failures === 0 ? '\nAll round trips passed.' : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
