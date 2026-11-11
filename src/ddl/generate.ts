// Turns a parsed \d description into the statements that recreate the relation.

import { asSqlName, quoteIdent, quoteIdentAlways, quoteLiteral, readQualifiedName } from './ident';
import { Column, Description, Section } from './parse';

export interface GenerateOptions {
  /** Names for the descriptions that neither a title nor a \d command named, in order. */
  fallbackNames?: string[];
  /** Write integer columns that default to their own sequence as serial types (default true). */
  serialColumns?: boolean;
}

export const PLACEHOLDER_TABLE = 'table_name';
export const PLACEHOLDER_SERVER = 'server_name';

export function generateDdl(descriptions: Description[], options: GenerateOptions = {}): string {
  let unnamed = 0;
  const generators = descriptions.map(
    (d) => new Generator(d, options, d.name ? undefined : options.fallbackNames?.[unnamed++]),
  );
  if (generators.length === 1) {
    return generators[0].run() + '\n';
  }
  // Several relations make one script: parents before their partitions and children, tables before
  // views, and statements that can point at other tables after all of them.
  const paste = { has: (name: string) => generators.some((g) => g.isThisTable(name)) };
  const ordered = dependencyOrder(generators);
  const out = ordered.map((g) => g.run(paste)).filter(Boolean);
  const later = ordered.map((g) => g.deferredSql()).filter(Boolean);
  if (later.length > 0) {
    out.push('-- Foreign keys, rules and policies, now that all the tables exist.\n\n' + later.join('\n\n'));
  }
  return out.join('\n\n') + '\n';
}

function dependencyOrder(generators: Generator[]): Generator[] {
  const out: Generator[] = [];
  const visiting = new Set<Generator>();
  const visit = (g: Generator) => {
    if (out.includes(g) || visiting.has(g)) {
      return;
    }
    visiting.add(g);
    for (const parent of g.parents()) {
      const found = generators.find((other) => other !== g && other.isThisTable(parent));
      if (found) {
        visit(found);
      }
    }
    // A view goes after the views its query selects from.
    for (const other of generators) {
      if (other !== g && g.selectsFrom(other)) {
        visit(other);
      }
    }
    out.push(g);
  };
  generators.filter((g) => !g.isViewLike).forEach(visit);
  generators.filter((g) => g.isViewLike).forEach(visit);
  return out;
}

/** The other relations pasted together with this one. */
interface Paste {
  has(name: string): boolean;
}

/** A not-null constraint as PostgreSQL 18's \d+ lists it. */
interface NotNull {
  name: string;
  noInherit: boolean;
  notValid: boolean;
  /** Declared on this table itself, not only inherited from a parent. */
  local: boolean;
}

/** The identifiers in a query, string constants left out. */
function namesIn(sql: string): Set<string> {
  const names = new Set<string>();
  for (const m of sql.matchAll(/'(?:[^']|'')*'|"((?:[^"]|"")*)"|[\p{L}_][\p{L}\p{N}_$]*/gu)) {
    if (!m[0].startsWith("'")) {
      names.add(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[0]);
    }
  }
  return names;
}

// Statements that may refer to other tables; with several tables they go after all of them.
const CROSS_TABLE_GROUPS = ['foreign keys', 'rules', 'row security'];

// The order of the statement groups after CREATE.
const GROUP_ORDER = [
  'sequences', 'constraints', 'indexes', 'replica identity', 'foreign keys', 'triggers', 'rules', 'row security',
  'statistics', 'columns', 'comments', 'partitions',
];

const SERIAL_TYPES: Record<string, string> = { smallint: 'smallserial', integer: 'serial', bigint: 'bigserial' };
const NEXTVAL_RE = /nextval\('((?:[^']|'')+)'::regclass\)/g;

// typstorage of the built-in types, to tell a changed storage from the default one.
const DEFAULT_STORAGE: Record<string, string> = {};
for (const [storage, types] of Object.entries({
  plain:
    'boolean,"char",name,smallint,integer,bigint,oid,tid,xid,cid,xid8,point,lseg,box,line,real,' +
    'double precision,circle,money,macaddr,macaddr8,date,time without time zone,time with time zone,' +
    'timestamp without time zone,timestamp with time zone,interval,uuid,tsquery,pg_lsn',
  main: 'numeric,inet,cidr',
  extended:
    'bytea,text,json,jsonb,jsonpath,xml,path,polygon,character,character varying,bit,bit varying,refcursor,' +
    'tsvector,txid_snapshot,int4range,int8range,numrange,tsrange,tstzrange,daterange,int4multirange,' +
    'int8multirange,nummultirange,tsmultirange,tstzmultirange,datemultirange',
})) {
  for (const t of types.split(',')) {
    DEFAULT_STORAGE[t] = storage;
  }
}

/** Splits a section's lines into entries; a line for which `isStart` is false continues the entry above. */
function entries(section: Section | undefined, isStart: RegExp = /^ {4}\S/): string[] {
  const out: string[] = [];
  for (const line of section?.lines ?? []) {
    if (isStart.test(line) || out.length === 0) {
      out.push(line.replace(/^ {4}/, ''));
    } else {
      out[out.length - 1] += '\n' + line;
    }
  }
  return out;
}

/** The value after "Label:" plus the aligned lines under it, for one-item-per-line footers like Inherits. */
function listEntries(section: Section): string[] {
  return [section.value, ...section.lines.map((l) => l.trim())].filter(Boolean).map((e) => e.replace(/,$/, ''));
}

function commentOut(text: string): string {
  return text
    .split('\n')
    .map((l) => '-- ' + l)
    .join('\n');
}

class Generator {
  private readonly kind: string;
  private readonly relName: string;
  private readonly table: string;
  private readonly foreign: boolean;
  private readonly isView: boolean;
  private readonly isMatview: boolean;
  private readonly isPartition: boolean;
  private readonly temp: boolean;
  private readonly alterTable: string;

  private readonly notes: string[] = [];
  private readonly sequences: string[] = [];
  private readonly inline: string[] = [];
  /** Statements that follow CREATE, by group (see GROUP_ORDER). */
  private readonly after = new Map<string, string[]>();
  /** Statements written as comments, with the reason as their heading. */
  private readonly commented = new Map<string, string[]>();

  /** The not-null constraints PostgreSQL 18's \d+ lists, by column name. */
  private readonly notNulls = new Map<string, NotNull>();
  private queryNames?: Set<string>;

  private readonly d: Description;
  private paste?: Paste;

  constructor(
    d: Description,
    private readonly options: GenerateOptions,
    fallbackName?: string,
  ) {
    this.d = d;
    this.kind = d.kind;
    this.notes.push(...d.notes);
    if (!d.name) {
      // Read the name the user typed the way psql reads \d's argument.
      const typed = fallbackName ? readQualifiedName(fallbackName.trim(), true) : undefined;
      if (typed && typed.rest.trim() === '' && typed.parts.length <= 2) {
        d = { ...d, name: typed.parts[typed.parts.length - 1], schema: typed.parts.length > 1 ? typed.parts[0] : undefined };
        this.d = d;
      } else {
        this.notes.push(`The table name wasn't in the pasted text; replace ${PLACEHOLDER_TABLE}.`);
      }
    }
    this.relName = d.name ?? PLACEHOLDER_TABLE;
    this.temp = d.schema !== undefined && /^pg_temp(_\d+)?$/.test(d.schema);
    this.table = d.schema && !this.temp ? `${quoteIdent(d.schema)}.${quoteIdent(this.relName)}` : quoteIdent(this.relName);
    this.foreign =
      this.kind === 'foreign table' || !!this.section('Server') || !!this.section('FDW options') || d.hasFdwColumn;
    this.isView = this.kind === 'view';
    this.isMatview = this.kind.endsWith('materialized view');
    this.isPartition = !!this.section('Partition of');
    this.alterTable = this.foreign ? 'ALTER FOREIGN TABLE' : this.isMatview ? 'ALTER MATERIALIZED VIEW' : 'ALTER TABLE';
  }

  private section(label: string): Section | undefined {
    return this.d.sections.find((s) => s.label === label);
  }

  private add(group: string, sql: string): void {
    const list = this.after.get(group) ?? [];
    list.push(sql);
    this.after.set(group, list);
  }

  private addCommented(reason: string, sql: string): void {
    const list = this.commented.get(reason) ?? [];
    list.push(sql);
    this.commented.set(reason, list);
  }

  /**
   * A partition gets its parent's constraints from PARTITION OF, and \d doesn't say which ones those
   * are, so a partition's constraints are written as comments rather than created twice.
   */
  private addLocalOrInherited(group: string, sql: string, inline = false): void {
    if (this.isPartition) {
      this.addCommented(
        'Constraints that come from the parent table are created by PARTITION OF.\n' +
          'Uncomment any that were added to this partition only.',
        inline ? `${this.alterTable} ${this.table} ADD ${sql};` : sql,
      );
    } else if (inline) {
      this.inline.push(sql);
    } else {
      this.add(group, sql);
    }
  }

  get isViewLike(): boolean {
    return this.isView || this.isMatview;
  }

  /** True when this view's query names the view `other`, which then has to exist first. */
  selectsFrom(other: Generator): boolean {
    if (!this.isViewLike || !other.isViewLike) {
      return false;
    }
    this.queryNames ??= namesIn(this.section('View definition')?.lines.join('\n') ?? '');
    return this.queryNames.has(other.relName);
  }

  /** The tables this one is a partition or child of, as psql names them. */
  parents(): string[] {
    const partitionOf = this.section('Partition of');
    const parsed = partitionOf ? readQualifiedName(partitionOf.value) : undefined;
    const inherits = this.section('Inherits');
    return [
      ...(parsed ? [partitionOf!.value.slice(0, partitionOf!.value.length - parsed.rest.length)] : []),
      ...(inherits ? listEntries(inherits) : []),
    ];
  }

  /** The statements held back by run(paste) because they may refer to tables pasted after this one. */
  deferredSql(): string {
    return CROSS_TABLE_GROUPS.flatMap((group) => this.after.get(group) ?? [])
      .join('\n');
  }

  run(paste?: Paste): string {
    this.paste = paste;
    const kind = this.kind;
    if (kind && !kind.endsWith('table') && !this.isView && !this.isMatview) {
      return `-- ${kind[0].toUpperCase() + kind.slice(1)} "${this.d.schema ? this.d.schema + '.' : ''}${this.relName}": only tables, foreign tables and views can be converted.`;
    }
    if (kind === 'toast table') {
      return `-- TOAST table "${this.d.schema}.${this.relName}" is created by PostgreSQL itself; nothing to convert.`;
    }

    if ((this.isView || this.isMatview) && !this.section('View definition')) {
      return commentOut(
        `Note: psql shows a view's query only for \\d+; run \\d+ ${this.relName} and convert that output.`,
      );
    }

    // Footers first: they add table constraints that go inside CREATE TABLE.
    this.notNullConstraints();
    this.indexes();
    this.checkConstraints();
    this.foreignKeys();
    this.triggers();
    this.rules();
    this.policies();
    this.statistics();
    this.columnExtras();
    this.partitions();
    this.otherFooters();
    const create = this.isView || this.isMatview ? this.createView() : this.createTable();

    const out: string[] = [];
    if (this.notes.length > 0) {
      out.push(this.notes.map((n) => commentOut('Note: ' + n)).join('\n'));
    }
    if (this.sequences.length > 0) {
      out.push(this.sequences.join('\n'));
    }
    if (create) {
      out.push(create);
    }
    for (const group of GROUP_ORDER) {
      const list = this.after.get(group);
      if (list && !(this.paste && CROSS_TABLE_GROUPS.includes(group))) {
        out.push(list.join('\n'));
      }
    }
    for (const [reason, list] of this.commented) {
      out.push(commentOut(reason) + '\n' + list.map(commentOut).join('\n'));
    }
    return out.join('\n\n');
  }

  private createTable(): string {
    const d = this.d;
    const unlogged = this.kind.startsWith('unlogged');
    let head = `CREATE ${this.temp ? 'TEMPORARY ' : unlogged ? 'UNLOGGED ' : ''}${this.foreign ? 'FOREIGN ' : ''}TABLE ${this.table}`;
    const clauses: string[] = [];
    const items: string[] = [];

    const partitionOf = this.section('Partition of');
    const typedOf = this.section('Typed table of type');
    if (partitionOf) {
      const parsed = readQualifiedName(partitionOf.value);
      const parent = parsed ? partitionOf.value.slice(0, partitionOf.value.length - parsed.rest.length) : partitionOf.value;
      const bound = (parsed ? parsed.rest : '').trim().replace(/ DETACH PENDING$/, '');
      head += ` PARTITION OF ${parent}`;
      clauses.push(bound || 'DEFAULT');
      // A partition can have its own defaults and NOT NULLs; repeating the parent's is harmless.
      // Identity and generated columns always come from the parent.
      items.push(...this.columnsWithOptions((c) => !/^generated /i.test(c.default)));
    } else if (typedOf) {
      head += ` OF ${typedOf.value}`;
      items.push(...this.columnsWithOptions(() => true));
    } else {
      items.push(...d.columns.map((c) => this.columnDef(c)));
    }

    const inherits = this.section('Inherits');
    if (inherits) {
      clauses.push(`INHERITS (${listEntries(inherits).join(', ')})`);
    }
    const key = this.section('Partition key');
    if (key) {
      clauses.push(`PARTITION BY ${key.value}`);
    }
    clauses.push(...this.storageClauses());
    if (this.foreign) {
      const server = this.section('Server');
      if (!server) {
        this.notes.push(`The foreign server wasn't in the pasted text; replace ${PLACEHOLDER_SERVER}.`);
      }
      clauses.push(`SERVER ${server ? quoteIdent(server.value) : PLACEHOLDER_SERVER}`);
      const fdw = this.section('FDW options');
      if (fdw) {
        clauses.push(`OPTIONS ${fdw.value}`);
      }
    }

    const body = [...items, ...this.inline];
    if (body.length > 0) {
      head += ' (\n    ' + body.join(',\n    ') + '\n)';
    } else if (!partitionOf && !typedOf) {
      head += ' ()';
    }
    return [head, ...clauses].join('\n') + ';';
  }

  /** `col WITH OPTIONS DEFAULT ... NOT NULL`, for columns that come from a parent or a type. */
  private columnsWithOptions(keepDefault: (c: Column) => boolean): string[] {
    return this.d.columns.flatMap((c) => {
      const opts = [keepDefault(c) ? this.defaultClause(c) : '', this.notNullClause(c)].filter(Boolean);
      return opts.length > 0 ? [`${quoteIdent(c.name)} WITH OPTIONS ${opts.join(' ')}`] : [];
    });
  }

  private createView(): string {
    const query = this.section('View definition')!.lines.join('\n').replace(/;\s*$/, '');
    const clauses = this.storageClauses();
    if (this.isView) {
      return [`CREATE VIEW ${this.table}`, ...clauses, 'AS', query].join('\n') + ';';
    }
    return [`CREATE MATERIALIZED VIEW ${this.table}`, ...clauses, 'AS', query].join('\n') + ';';
  }

  /** USING, WITH (...) and TABLESPACE. */
  private storageClauses(): string[] {
    const clauses: string[] = [];
    const am = this.section('Access method');
    if (am && am.value !== 'heap') {
      clauses.push(`USING ${quoteIdent(am.value)}`);
    }
    const options: string[] = [];
    if (this.section('Has OIDs')?.value === 'yes') {
      options.push('oids=true');
    }
    const relOptions = this.section('Options');
    if (relOptions) {
      for (const opt of relOptions.value.split(', ')) {
        const eq = opt.indexOf('=');
        const value = eq >= 0 ? opt.slice(eq + 1) : '';
        options.push(eq < 0 || /^[\w.+-]+$/.test(value) ? opt : `${opt.slice(0, eq)}=${quoteLiteral(value)}`);
      }
    }
    if (options.length > 0) {
      clauses.push(`WITH (${options.join(', ')})`);
    }
    const ts = this.section('Tablespace');
    if (ts) {
      clauses.push(`TABLESPACE ${quoteIdent(ts.value.replace(/^"(.*)"$/, '$1'))}`);
    }
    return clauses;
  }

  private columnDef(c: Column): string {
    const serial = this.serialType(c);
    const parts = [quoteIdent(c.name), serial ?? c.type];
    if (this.foreign && c.fdwOptions) {
      parts.push(`OPTIONS ${c.fdwOptions}`);
    }
    if (c.compression && !this.foreign) {
      parts.push(`COMPRESSION ${c.compression}`);
    }
    if (c.collation) {
      parts.push(`COLLATE ${quoteIdentAlways(c.collation)}`);
    }
    if (!serial) {
      const def = this.defaultClause(c);
      if (def) {
        parts.push(def);
      }
      const notNull = this.notNullClause(c);
      if (notNull) {
        parts.push(notNull);
      }
    }
    return parts.join(' ');
  }

  /**
   * PostgreSQL 18 names not-null constraints and \d+ lists them. Reads that list, so that a column
   * gets the constraint it had: its name, NO INHERIT, NOT VALID, or none of its own when the
   * constraint is the parent's.
   */
  private notNullConstraints(): void {
    for (const entry of entries(this.section('Not-null constraints'), /^ {4}"/)) {
      const flags = /((?: NO INHERIT| \((?:local, )?inherited\)| NOT VALID)*)$/.exec(entry)![1];
      const body = entry.slice(0, entry.length - flags.length);
      // psql prints both names as they are, quotes inside them included: find the column by its name.
      const column = this.d.columns
        .filter((c) => body.endsWith(` NOT NULL "${c.name}"`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      const name = column && /^"(.*)"$/s.exec(body.slice(0, -` NOT NULL "${column.name}"`.length));
      if (!column || !name) {
        this.addCommented('Not-null constraints that could not be read:', entry);
        continue;
      }
      const notNull: NotNull = {
        name: name[1],
        noInherit: flags.includes(' NO INHERIT'),
        notValid: flags.includes(' NOT VALID'),
        local: !flags.includes(' (inherited)'),
      };
      this.notNulls.set(column.name, notNull);
      if (notNull.local && notNull.notValid) {
        // CREATE TABLE can't add a NOT VALID constraint.
        this.add(
          'constraints',
          `${this.alterTable} ${this.table} ADD CONSTRAINT ${quoteIdent(notNull.name)} NOT NULL ${quoteIdent(column.name)}` +
            `${notNull.noInherit ? ' NO INHERIT' : ''} NOT VALID;`,
        );
      }
    }
  }

  /** The NOT NULL of a column definition: plain, or as the constraint \d+ listed for the column. */
  private notNullClause(c: Column): string {
    if (!c.notNull) {
      return '';
    }
    const notNull = this.notNulls.get(c.name);
    if (!notNull) {
      return 'NOT NULL';
    }
    // The parent's constraint comes with the parent; a NOT VALID one is added after CREATE TABLE.
    if (!notNull.local || notNull.notValid) {
      return '';
    }
    const named = notNull.name !== makeObjectName(this.relName, c.name, 'not_null');
    return `${named ? `CONSTRAINT ${quoteIdent(notNull.name)} ` : ''}NOT NULL${notNull.noInherit ? ' NO INHERIT' : ''}`;
  }

  private defaultClause(c: Column): string {
    const def = c.default;
    if (!def) {
      return '';
    }
    if (/^generated always as identity$/i.test(def)) {
      return 'GENERATED ALWAYS AS IDENTITY';
    }
    if (/^generated by default as identity$/i.test(def)) {
      return 'GENERATED BY DEFAULT AS IDENTITY';
    }
    const stored = /^generated always as \((.*)\) stored$/is.exec(def);
    if (stored) {
      return `GENERATED ALWAYS AS (${stored[1]}) STORED`;
    }
    const virtual = /^generated always as \((.*)\)$/is.exec(def);
    if (virtual) {
      return `GENERATED ALWAYS AS (${virtual[1]}) VIRTUAL`;
    }
    for (const m of def.matchAll(NEXTVAL_RE)) {
      // The sequence has to exist before the table that uses it.
      const seq = m[1].replace(/''/g, "'");
      const create = `CREATE SEQUENCE IF NOT EXISTS ${seq};`;
      if (!this.sequences.includes(create)) {
        this.sequences.push(create);
        if (this.ownSequence(c, seq)) {
          this.add('sequences', `ALTER SEQUENCE ${seq} OWNED BY ${this.table}.${quoteIdent(c.name)};`);
        }
      }
    }
    return `DEFAULT ${def}`;
  }

  /** serial/bigserial/smallserial when the column is exactly what that shorthand creates. */
  private serialType(c: Column): string | undefined {
    if (this.options.serialColumns === false || this.foreign) {
      return undefined;
    }
    const serial = SERIAL_TYPES[c.type];
    const m = /^nextval\('((?:[^']|'')+)'::regclass\)$/.exec(c.default);
    if (!serial || !m || !c.notNull || !this.ownSequence(c, m[1].replace(/''/g, "'"))) {
      return undefined;
    }
    // serial brings a plain NOT NULL of its own.
    if (this.notNullClause(c) !== 'NOT NULL') {
      return undefined;
    }
    return serial;
  }

  /** True when `seq` has the name PostgreSQL gives the sequence of a serial column. */
  private ownSequence(c: Column, seq: string): boolean {
    const parsed = readQualifiedName(seq);
    if (!parsed || parsed.rest !== '') {
      return false;
    }
    const name = parsed.parts[parsed.parts.length - 1];
    const schema = parsed.parts.length > 1 ? parsed.parts[parsed.parts.length - 2] : undefined;
    if (schema && this.d.schema && schema !== this.d.schema) {
      return false;
    }
    return name === makeObjectName(this.relName, c.name, 'seq');
  }

  private indexes(): void {
    for (const entry of entries(this.section('Indexes'), /^ {4}"/)) {
      const m = /^"(.*?)" (.*)$/s.exec(entry);
      if (!m) {
        this.addCommented('Index lines that could not be read:', entry);
        continue;
      }
      const name = quoteIdent(m[1]);
      let rest = m[2];
      // psql appends the index's tablespace after everything else.
      let tablespace = '';
      const ts = /, tablespace "(.*)"$/s.exec(rest);
      if (ts) {
        tablespace = quoteIdent(ts[1]);
        rest = rest.slice(0, ts.index);
      }
      const flags = new Set<string>();
      for (let again = true; again; ) {
        again = false;
        for (const flag of [' REPLICA IDENTITY', ' INVALID', ' CLUSTER']) {
          if (rest.endsWith(flag)) {
            flags.add(flag.trim());
            rest = rest.slice(0, -flag.length);
            again = true;
          }
        }
      }

      const constraint = /^(PRIMARY KEY|UNIQUE CONSTRAINT), (.*)$/s.exec(rest);
      if (constraint) {
        let def = constraint[2];
        let deferrable = '';
        if (def.endsWith(' INITIALLY DEFERRED')) {
          deferrable = ' INITIALLY DEFERRED';
          def = def.slice(0, -deferrable.length);
        }
        if (def.endsWith(' DEFERRABLE')) {
          deferrable = ' DEFERRABLE' + deferrable;
          def = def.slice(0, -' DEFERRABLE'.length);
        }
        // "btree (a) INCLUDE (b)" -> "(a) INCLUDE (b)"; NULLS NOT DISTINCT goes right after UNIQUE.
        def = def.replace(/^\S+ /, '');
        let keyword = constraint[1] === 'PRIMARY KEY' ? 'PRIMARY KEY' : 'UNIQUE';
        if (def.includes(' NULLS NOT DISTINCT')) {
          def = def.replace(' NULLS NOT DISTINCT', '');
          keyword += ' NULLS NOT DISTINCT';
        }
        const using = tablespace ? ` USING INDEX TABLESPACE ${tablespace}` : '';
        this.addLocalOrInherited('indexes', `CONSTRAINT ${name} ${keyword} ${def}${using}${deferrable}`, true);
      } else if (rest.startsWith('EXCLUDE ') || /^(?:PRIMARY KEY|UNIQUE) \(/.test(rest)) {
        // An exclusion constraint, or a key WITHOUT OVERLAPS (PostgreSQL 18): psql prints these as
        // the constraint is written, not as an index.
        const def = tablespace
          ? insertBefore(rest, [' WHERE ', ' DEFERRABLE', ' NOT DEFERRABLE', ' INITIALLY '], ` USING INDEX TABLESPACE ${tablespace}`)
          : rest;
        this.addLocalOrInherited('indexes', `CONSTRAINT ${name} ${def}`, true);
      } else {
        const unique = rest.startsWith('UNIQUE, ');
        let def = unique ? rest.slice('UNIQUE, '.length) : rest;
        if (tablespace) {
          def = insertBefore(def, [' WHERE '], ` TABLESPACE ${tablespace}`);
        }
        if (flags.has('INVALID')) {
          this.add('indexes', `-- ${name} was INVALID on the source (an interrupted CREATE INDEX CONCURRENTLY?).`);
        }
        if (this.isPartition && !this.after.has('indexes')) {
          this.add(
            'indexes',
            "-- IF NOT EXISTS skips the indexes PARTITION OF already made from the parent table's indexes.",
          );
        }
        const ifNotExists = this.isPartition ? 'IF NOT EXISTS ' : '';
        this.add('indexes', `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ifNotExists}${name} ON ${this.table} USING ${def};`);
      }
      if (flags.has('CLUSTER')) {
        this.add('indexes', `${this.alterTable} ${this.table} CLUSTER ON ${name};`);
      }
      if (flags.has('REPLICA IDENTITY')) {
        this.add('indexes', `${this.alterTable} ${this.table} REPLICA IDENTITY USING INDEX ${name};`);
      }
    }
  }

  private checkConstraints(): void {
    for (const entry of entries(this.section('Check constraints'), /^ {4}"/)) {
      const m = /^"(.*?)" (CHECK .*)$/s.exec(entry);
      if (!m) {
        this.addCommented('Check constraints that could not be read:', entry);
        continue;
      }
      const sql = `CONSTRAINT ${quoteIdent(m[1])} ${m[2]}`;
      if (m[2].endsWith(' NOT VALID')) {
        // CREATE TABLE can't add a NOT VALID constraint.
        this.addLocalOrInherited('constraints', `${this.alterTable} ${this.table} ADD ${sql};`);
      } else {
        this.addLocalOrInherited('constraints', sql, true);
      }
    }
  }

  private foreignKeys(): void {
    const localKeys: string[] = [];
    for (const entry of entries(this.section('Foreign-key constraints'), /^ {4}(?:"|TABLE ")/)) {
      const local = /^"(.*?)" (FOREIGN KEY .*)$/s.exec(entry);
      const inherited = /^TABLE "(.*?)" CONSTRAINT "(.*?)" (FOREIGN KEY .*)$/s.exec(entry);
      if (local) {
        localKeys.push(local[1]);
        this.addLocalOrInherited(
          'foreign keys',
          `${this.alterTable} ${this.table} ADD CONSTRAINT ${quoteIdent(local[1])} ${local[2]};`,
        );
      } else if (inherited) {
        this.addCommented(
          'Foreign keys inherited from the parent table (created by PARTITION OF):',
          `${this.alterTable} ${this.table} ADD CONSTRAINT ${quoteIdent(inherited[2])} ${inherited[3]};`,
        );
      } else {
        this.addCommented('Foreign keys that could not be read:', entry);
      }
    }
    for (const entry of entries(this.section('Referenced by'), /^ {4}TABLE "/)) {
      const m = /^TABLE "(.*?)" CONSTRAINT "(.*?)" (FOREIGN KEY .*)$/s.exec(entry);
      if (m && this.isThisTable(m[1]) && localKeys.includes(m[2])) {
        continue; // A self-reference, already added above.
      }
      if (m && this.paste?.has(m[1])) {
        continue; // That table was pasted too, and adds the key itself.
      }
      this.addCommented(
        'Foreign keys of other tables that point at this one (recreate them with those tables):',
        m ? `ALTER TABLE ${asSqlName(m[1])} ADD CONSTRAINT ${quoteIdent(m[2])} ${m[3]};` : entry,
      );
    }
  }

  /** True when `name` (as regclass prints it) is this table. */
  isThisTable(name: string): boolean {
    const parsed = readQualifiedName(name);
    if (!parsed || parsed.rest !== '') {
      return false;
    }
    const rel = parsed.parts[parsed.parts.length - 1];
    const schema = parsed.parts.length > 1 ? parsed.parts[parsed.parts.length - 2] : undefined;
    return rel === this.relName && (!schema || !this.d.schema || schema === this.d.schema);
  }

  private triggers(): void {
    const states: Record<string, string> = {
      Triggers: '',
      'Disabled user triggers': 'DISABLE',
      'Disabled triggers': 'DISABLE',
      'Triggers firing always': 'ENABLE ALWAYS',
      'Triggers firing on replica only': 'ENABLE REPLICA',
    };
    for (const section of this.d.sections) {
      if (section.label === 'Disabled internal triggers') {
        for (const entry of entries(section)) {
          this.addCommented(
            'Internal (foreign key) triggers were disabled, e.g. by ALTER TABLE ... DISABLE TRIGGER ALL:',
            entry,
          );
        }
        continue;
      }
      const state = states[section.label];
      if (state === undefined) {
        continue;
      }
      for (let entry of entries(section)) {
        const name = readQualifiedName(entry)?.parts[0] ?? entry.split(' ')[0];
        const inherited = /, ON TABLE (.*)$/s.exec(entry);
        if (inherited) {
          entry = entry.slice(0, inherited.index);
        }
        const constraintTrigger = / (?:NOT )?DEFERRABLE INITIALLY (?:DEFERRED|IMMEDIATE) /.test(entry);
        const sql = `CREATE ${constraintTrigger ? 'CONSTRAINT ' : ''}TRIGGER ${entry};`;
        const enable = state ? `${this.alterTable} ${this.table} ${state} TRIGGER ${quoteIdent(name)};` : '';
        if (inherited) {
          this.addCommented(
            'Triggers that come from the parent table (created by PARTITION OF):',
            sql + (enable ? '\n' + enable : ''),
          );
        } else {
          this.add('triggers', sql);
          if (enable) {
            this.add('triggers', enable);
          }
        }
      }
    }
  }

  private rules(): void {
    const states: Record<string, string> = {
      Rules: '',
      'Disabled rules': 'DISABLE',
      'Rules firing always': 'ENABLE ALWAYS',
      'Rules firing on replica only': 'ENABLE REPLICA',
    };
    for (const section of this.d.sections) {
      const state = states[section.label];
      if (state === undefined) {
        continue;
      }
      for (const entry of entries(section, /^ {4}(?:"(?:[^"]|"")+"|\S+) AS$/)) {
        const name = readQualifiedName(entry)?.parts[0] ?? entry.split(' ')[0];
        this.add('rules', `CREATE RULE ${entry.replace(/;?\s*$/, ';')}`);
        if (state) {
          this.add('rules', `ALTER TABLE ${this.table} ${state} RULE ${quoteIdent(name)};`);
        }
      }
    }
  }

  private policies(): void {
    for (const section of this.d.sections) {
      if (!section.label.startsWith('Policies')) {
        continue;
      }
      if (!section.label.includes('disabled')) {
        this.add('row security', `${this.alterTable} ${this.table} ENABLE ROW LEVEL SECURITY;`);
      }
      if (section.label.includes('forced')) {
        this.add('row security', `${this.alterTable} ${this.table} FORCE ROW LEVEL SECURITY;`);
      }
      for (const entry of entries(section, /^ {4}POLICY "/)) {
        const [first, ...more] = entry.split('\n');
        const head = /^POLICY "(.*)"( AS RESTRICTIVE)?(?: FOR (\w+))?$/.exec(first);
        if (!head) {
          this.addCommented('Policies that could not be read:', entry);
          continue;
        }
        const clauses: string[] = [];
        for (const line of more) {
          const clause = /^ {6}(TO|USING|WITH CHECK) (.*)$/.exec(line);
          if (clause && clause[1] === 'TO') {
            clauses.push('TO ' + clause[2].split(',').map((r) => (r === 'public' ? 'PUBLIC' : quoteIdent(r))).join(', '));
          } else if (clause) {
            clauses.push(`${clause[1]} ${clause[2]}`);
          } else if (clauses.length > 0) {
            clauses[clauses.length - 1] += '\n' + line;
          }
        }
        let sql = `CREATE POLICY ${quoteIdent(head[1])} ON ${this.table}`;
        if (head[2]) {
          sql += ' AS RESTRICTIVE';
        }
        if (head[3]) {
          sql += ` FOR ${head[3]}`;
        }
        this.add('row security', [sql, ...clauses].join('\n    ') + ';');
      }
    }
  }

  private statistics(): void {
    for (const entry of entries(this.section('Statistics objects'))) {
      const m = /^(.+?)(?: \(([a-z, ]+)\))? ON (.+) FROM (.+?)(?:; STATISTICS (-?\d+))?$/s.exec(entry);
      if (!m) {
        this.addCommented('Statistics objects that could not be read:', entry);
        continue;
      }
      const name = statisticsName(m[1]);
      this.add('statistics', `CREATE STATISTICS ${name}${m[2] ? ` (${m[2]})` : ''} ON ${m[3]} FROM ${this.table};`);
      if (m[5] !== undefined) {
        this.add('statistics', `ALTER STATISTICS ${name} SET STATISTICS ${m[5]};`);
      }
    }
  }

  /** Storage, statistics targets and comments of columns (\d+ only). */
  private columnExtras(): void {
    const inlineCompression = !this.isPartition && !this.isView && !this.isMatview && !this.section('Typed table of type');
    for (const c of this.d.columns) {
      const col = `${this.table} ALTER COLUMN ${quoteIdent(c.name)}`;
      const base = c.type
        .replace(/\(\d+(?:,\s*\d+)?\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const defaultStorage = base.endsWith('[]') ? 'extended' : base.startsWith('interval') ? 'plain' : DEFAULT_STORAGE[base];
      if (c.storage && defaultStorage && c.storage !== defaultStorage && !this.isView) {
        this.add('columns', `${this.alterTable} ${col} SET STORAGE ${c.storage.toUpperCase()};`);
      }
      if (c.fdwOptions && this.foreign && this.isPartition) {
        // CREATE FOREIGN TABLE ... PARTITION OF has no place for column options.
        this.add('columns', `${this.alterTable} ${col} OPTIONS ${c.fdwOptions};`);
      }
      if (c.compression && !inlineCompression && !this.foreign) {
        this.add('columns', `${this.alterTable} ${col} SET COMPRESSION ${c.compression};`);
      }
      if (c.statsTarget && c.statsTarget !== '-1' && !this.isView) {
        this.add('columns', `${this.alterTable} ${col} SET STATISTICS ${c.statsTarget};`);
      }
      if (c.description) {
        this.add('comments', `COMMENT ON COLUMN ${this.table}.${quoteIdent(c.name)} IS ${quoteLiteral(c.description)};`);
      }
    }
  }

  private partitions(): void {
    const list = this.section('Partitions');
    if (!list) {
      return;
    }
    for (const entry of listEntries(list)) {
      let text = entry.replace(/ \(DETACH PENDING\)$/, '');
      const kind = /, (PARTITIONED|FOREIGN)$/.exec(text);
      if (kind) {
        text = text.slice(0, kind.index);
      }
      const parsed = readQualifiedName(text);
      const name = parsed ? text.slice(0, text.length - parsed.rest.length) : text;
      const bound = parsed ? parsed.rest.trim() : '';
      if (this.paste?.has(name)) {
        continue; // Its own description was pasted too.
      }
      const sql = `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${this.table}\n${bound};`;
      if (kind?.[1] === 'PARTITIONED') {
        this.addCommented(
          'Partitions that are partitioned themselves: convert their own \\d+ output for PARTITION BY and their partitions.',
          sql,
        );
      } else if (kind?.[1] === 'FOREIGN') {
        this.addCommented('Partitions that are foreign tables: convert their own \\d output for the SERVER.', sql);
      } else {
        this.add('partitions', sql);
      }
    }
  }

  private otherFooters(): void {
    const handled = new Set([
      'Access method', 'Check constraints', 'Disabled internal triggers', 'Disabled rules', 'Disabled triggers',
      'Disabled user triggers', 'FDW options', 'Foreign-key constraints', 'Has OIDs', 'Indexes', 'Inherits',
      'No partition constraint', 'Not-null constraints', 'Options', 'Partition constraint', 'Partition key',
      'Partition of', 'Partitions', 'Referenced by', 'Rules', 'Rules firing always', 'Rules firing on replica only',
      'Server', 'Statistics objects', 'Tablespace', 'Triggers', 'Triggers firing always',
      'Triggers firing on replica only', 'Typed table of type', 'View definition', 'Owned by', 'Owning table',
    ]);
    for (const s of this.d.sections) {
      if (handled.has(s.label) || s.label.startsWith('Policies')) {
        continue;
      }
      if (s.label === 'Replica Identity') {
        this.add('replica identity', `${this.alterTable} ${this.table} REPLICA IDENTITY ${s.value};`);
      } else if (s.label === 'Publications') {
        for (const entry of entries(s, /^ {4}"/)) {
          const m = /^"(.*?)"(.*)$/s.exec(entry);
          this.addCommented(
            'Publications this table is in (the publications must exist first):',
            m ? `ALTER PUBLICATION ${quoteIdent(m[1])} ADD TABLE ${this.table}${m[2]};` : entry,
          );
        }
      } else if (s.label === 'Child tables') {
        this.addCommented('Child tables (convert their own \\d output):', listEntries(s).join(', '));
      } else if (s.label === 'Number of partitions' || s.label === 'Number of child tables') {
        const what = s.label === 'Number of partitions' ? 'partitions' : 'child tables';
        this.addCommented(
          `Not included: ${what} (${s.value.replace(/ \(Use .*$/, '')}). Convert the \\d+ output to get the partitions too.`,
          `\\d+ ${this.table}`,
        );
      } else {
        this.addCommented('psql lines this converter does not know:', [`${s.label}: ${s.value}`, ...s.lines].join('\n'));
      }
    }
  }
}

/**
 * Inserts `insertion` before the first of `keywords` that is outside parentheses and quotes, or at
 * the end when there is none.
 */
function insertBefore(sql: string, keywords: string[], insertion: string): string {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (depth === 0 && keywords.some((k) => sql.startsWith(k, i))) {
      return sql.slice(0, i) + insertion + sql.slice(i);
    }
  }
  return sql + insertion;
}

function statisticsName(raw: string): string {
  const both = /^"(.*)"\."(.*)"$/.exec(raw);
  if (both) {
    return `${quoteIdent(both[1])}.${quoteIdent(both[2])}`;
  }
  const one = /^"(.*)"$/.exec(raw);
  const text = one ? one[1] : raw;
  const dot = text.indexOf('.');
  return dot < 0 ? quoteIdent(text) : `${quoteIdent(text.slice(0, dot))}.${quoteIdent(text.slice(dot + 1))}`;
}

/** PostgreSQL's makeObjectName(): "<name1>_<name2>_<label>", shortened to fit in 63 bytes. */
export function makeObjectName(name1: string, name2: string, label: string): string {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  const avail = 63 - 1 - (label.length + 1);
  let n1 = bytes(name1);
  let n2 = bytes(name2);
  while (n1 + n2 > avail) {
    if (n1 > n2) {
      n1--;
    } else {
      n2--;
    }
  }
  return `${clipBytes(name1, n1)}_${clipBytes(name2, n2)}_${label}`;
}

function clipBytes(s: string, max: number): string {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > max) {
      break;
    }
    out += ch;
    used += n;
  }
  return out;
}
