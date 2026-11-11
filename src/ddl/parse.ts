// Parses the text psql prints for \d and \d+ into a plain model: the title, the column rows and the
// footer sections (Indexes:, Server:, Partition key:, ...). Works with or without the title and
// column header lines, for the aligned, wrapped, unaligned and CSV formats and every border and
// linestyle psql prints \d with.

import { readQualifiedName } from './ident';
import { displayWidth, Measured, WIDTH_RULES } from './width';

export interface Column {
  name: string;
  type: string;
  collation: string;
  notNull: boolean;
  default: string;
  fdwOptions: string;
  storage: string;
  compression: string;
  statsTarget: string;
  description: string;
}

export interface Section {
  /** The footer label without the colon, e.g. "Indexes" or "Server". */
  label: string;
  /** Text after the colon on the label line, e.g. the server name. */
  value: string;
  /** The lines under the label, as printed. */
  lines: string[];
}

export interface Description {
  /** The relation kind from the title, e.g. "Foreign table"; empty when there was no title. */
  kind: string;
  schema?: string;
  /** The raw relation name, or undefined when neither the title nor a \d command named it. */
  name?: string;
  columns: Column[];
  sections: Section[];
  /** True when the input had a header row naming a FDW options column. */
  hasFdwColumn: boolean;
  /** The text had a title, a \d command, the column header or a known footer, not just rows with bars. */
  recognized: boolean;
  /** The rows have the cells \d prints (a type, "not null", ...), though nothing else says what they are. */
  shaped: boolean;
  /** What the reader should know about how the text was read. */
  notes: string[];
}

// Footer labels psql prints for tables, views and foreign tables (PostgreSQL 9.x to 18).
const FOOTER_LABELS = [
  'Access method',
  'Check constraints',
  'Child tables',
  'Disabled internal triggers',
  'Disabled rules',
  'Disabled triggers',
  'Disabled user triggers',
  'FDW options',
  'Foreign-key constraints',
  'Has OIDs',
  'Indexes',
  'Inherits',
  'No partition constraint',
  'Not-null constraints',
  'Number of child tables',
  'Number of partitions',
  'Options',
  'Owned by',
  'Owning table',
  'Partition constraint',
  'Partition key',
  'Partition of',
  'Partitions',
  'Policies',
  'Policies (forced row security enabled)',
  'Policies (row security disabled)',
  'Policies (row security enabled)',
  'Publications',
  'Referenced by',
  'Replica Identity',
  'Rules',
  'Rules firing always',
  'Rules firing on replica only',
  'Server',
  'Statistics objects',
  'Tablespace',
  'Triggers',
  'Triggers firing always',
  'Triggers firing on replica only',
  'Typed table of type',
  'View definition',
];

const FOOTER_RE = new RegExp(
  '^(' + [...FOOTER_LABELS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|') + '):(?: (.*))?$',
);
// A line shaped like a footer label, whether or not it is one this converter knows.
const FOOTER_LIKE_RE = /^[A-Z][A-Za-z -]*(?: \([^)]*\))?:(?: |$)/;

// "No partition constraint" has no colon.
const BARE_FOOTERS = new Set(['No partition constraint']);

const TITLE_RE =
  /^\s*((?:unlogged |partitioned |unlogged partitioned )?(?:table|index|materialized view|sequence)|foreign table|view|composite type|toast table|special relation)\s+"(.*)"\s*$/i;

// `test=# \d orders`, `\d+ public.foo`, `=> \dS "My Table"`.
const COMMAND_RE = /(?:^|[#>]\s*)\\d[S+]{0,2}\s+(\S.*?)\s*;?\s*$/;
// Any other psql prompt (`test=# select 1;`, `test-# `, `test=*> `): what was described ends there.
const PROMPT_RE = /^[^\s|]*[=^!\-'"($*][*!?]?[#>](?:\s|$)/;

const SEPARATOR_RE = /^[\s|+-]*-[\s|+-]*$/;
// With \pset border 0 there are no bars: dash groups under the header mark the columns.
const BORDER0_SEPARATOR_RE = /^-+(?: -+)+$/;
const IGNORED_RE = /^(?:\(END\)|Time: [\d.]+ ms.*|Did not find any relation.*)$/;
// psql prints this under query results and lists such as \dt, never under one relation's description.
const ROW_COUNT_RE = /^\(\d+ rows?\)$/;
// The header of unaligned output, whatever \pset fieldsep is: "Column|Type|...", "Column,Type,...".
const UNALIGNED_HEADER_RE = /^Column([^A-Za-z0-9]{1,3})Type(?:\1|$)/;

const FOREIGN_HEADER_NOTE =
  "The column header isn't the one an English psql prints, so the columns were read by their position and " +
  "the title and footers (indexes, constraints and so on) may be missing. Start psql with LC_MESSAGES=C " +
  'and describe the table again to convert all of it.';

type Format = 'aligned' | 'unaligned' | 'border0';

interface Block {
  recognized: boolean;
  kind: string;
  schema?: string;
  name?: string;
  format: Format;
  /** Unaligned output: the field separator, and whether the fields are quoted the CSV way. */
  sep: string;
  csv: boolean;
  headerLine?: string;
  /** The line of dashes under the header: it gives the exact position and width of every column. */
  separatorLine?: string;
  rowLines: string[];
  sections: Section[];
  phase: 'table' | 'footer';
  /** The last line before the rows that wasn't used; with border 0 it turns out to be the header. */
  unused?: string;
  /** A row count followed: this is a query result or a list, not a description. */
  rejected: boolean;
}

const count = (line: string, sep: string) => line.split(sep).length - 1;
const bars = (line: string) => count(line, '|');

/** The name of the psql output format `text` is in, when it's one that can't be converted. */
export function unsupportedFormat(text: string): string | undefined {
  if (/<table border=/.test(text) && /<t[hd] align=/.test(text)) {
    return 'HTML';
  }
  if (/^\[options="header",cols=/m.test(text)) {
    return 'AsciiDoc';
  }
  if (/\\begin\{(?:tabular|longtable)\}/.test(text)) {
    return 'LaTeX';
  }
  if (/^\.TS$/m.test(text) && /^\.TE$/m.test(text)) {
    return 'troff';
  }
  return undefined;
}

export function parseDescriptions(text: string): Description[] {
  if (unsupportedFormat(text)) {
    return [];
  }
  const blocks: Block[] = [];
  let cur: Block | undefined;
  let blankRun = 0;

  const startBlock = (): Block => {
    cur = {
      recognized: false, kind: '', format: 'aligned', sep: '|', csv: false, rowLines: [], sections: [],
      phase: 'table', rejected: false,
    };
    blocks.push(cur);
    return cur;
  };
  const isEmpty = (b: Block) => b.rowLines.length === 0 && b.sections.length === 0 && b.headerLine === undefined;

  for (const rawLine of undecorate(normalize(text).split('\n'))) {
    const line = rawLine.replace(/\s+$/, '');

    // A quoted CSV field goes on over line breaks, blank lines included.
    if (cur?.csv && cur.phase === 'table' && cur.rowLines.length > 0 && csvFieldIsOpen(cur.rowLines[cur.rowLines.length - 1])) {
      cur.rowLines[cur.rowLines.length - 1] += '\n' + rawLine;
      continue;
    }
    if (line.trim() === '') {
      blankRun++;
      continue;
    }
    if (IGNORED_RE.test(line.trim())) {
      continue;
    }
    const blanksBefore = blankRun;
    const wasBlank = blankRun > 0;
    blankRun = 0;
    if (ROW_COUNT_RE.test(line.trim())) {
      // What it counts is a query result or a list, unless something said it is a description:
      // then the result that followed it was just not told apart, and ends here.
      if (cur && !cur.recognized) {
        cur.rejected = true;
      }
      cur = undefined;
      continue;
    }

    const isCommand = COMMAND_RE.test(line) && !line.includes('|');
    const isTitle = TITLE_RE.test(line) && !line.includes('|');
    const isPrompt = !isCommand && PROMPT_RE.test(line);

    // Unaligned output (\a) has no continuation markers: a row with fewer separators than the header,
    // or a line without any (the last column went on), continues the row above.
    if (cur?.phase === 'table' && cur.format === 'unaligned' && !cur.csv && cur.rowLines.length > 0) {
      const last = cur.rowLines.length - 1;
      const unfinished = count(cur.rowLines[last], cur.sep) < count(cur.headerLine!, cur.sep);
      const somethingElse = FOOTER_RE.test(line) || FOOTER_LIKE_RE.test(line) || isCommand || isTitle || isPrompt;
      if (unfinished || (count(rawLine, cur.sep) === 0 && !somethingElse)) {
        cur.rowLines[last] += '\n'.repeat(blanksBefore + 1) + rawLine;
        continue;
      }
    }

    if (isCommand) {
      const b = cur && isEmpty(cur) && !cur.name ? cur : startBlock();
      b.recognized = true;
      const parsed = readQualifiedName(COMMAND_RE.exec(line)![1], true);
      if (parsed && !/[*?]/.test(parsed.parts.join(''))) {
        b.name = parsed.parts[parsed.parts.length - 1];
        b.schema = parsed.parts.length > 1 ? parsed.parts[parsed.parts.length - 2] : undefined;
      }
      continue;
    }
    if (isPrompt) {
      cur = undefined;
      continue;
    }

    if (isTitle) {
      const title = TITLE_RE.exec(line)!;
      const b = cur && isEmpty(cur) && !cur.kind ? cur : startBlock();
      b.kind = title[1].toLowerCase();
      b.recognized = true;
      const full = title[2];
      const dot = full.indexOf('.');
      b.schema = dot >= 0 ? full.slice(0, dot) : undefined;
      b.name = dot >= 0 ? full.slice(dot + 1) : full;
      continue;
    }

    const footer = FOOTER_RE.exec(line) ?? (BARE_FOOTERS.has(line) ? [line, line, ''] : null);
    // psql never prints a blank line among the rows or footers: what follows one is another table's
    // rows, or not part of a description at all. Only a view's query may have blank lines in it,
    // until the semicolon that ends it.
    const lastSection = cur?.sections[cur.sections.length - 1];
    const inViewQuery = lastSection?.label === 'View definition' && !/;\s*$/.test(lastSection.lines[lastSection.lines.length - 1] ?? '');
    if (wasBlank && cur && (cur.rowLines.length > 0 || cur.sections.length > 0) && !footer && !inViewQuery) {
      startBlock();
    }

    let b = cur ?? startBlock();
    if (footer) {
      b.recognized = true;
      b.phase = 'footer';
      b.sections.push({ label: footer[1], value: footer[2] ?? '', lines: [] });
      continue;
    }

    if (b.phase === 'footer') {
      const section = b.sections[b.sections.length - 1];
      if (FOOTER_LIKE_RE.test(line) && section.label !== 'View definition') {
        b.sections.push(unknownSection(line));
      } else {
        section.lines.push(line);
      }
      continue;
    }

    const sep = unalignedSeparator(line);
    if (sep !== undefined && (b.format === 'unaligned' ? b.rowLines.length > 0 : b.headerLine === undefined && b.rowLines.length === 0)) {
      // The header of unaligned output; a second one starts another table that has no title.
      if (b.format === 'unaligned') {
        b = startBlock();
      }
      b.format = 'unaligned';
      b.sep = sep;
      // psql's CSV format prints neither a title nor footers.
      b.csv = sep === ',' && !b.kind;
      b.headerLine = line;
      b.recognized = true;
    } else if (b.format === 'unaligned') {
      if (count(rawLine, b.sep) > 0) {
        b.rowLines.push(rawLine);
      } else if (b.rowLines.length > 0) {
        b.phase = 'footer';
        b.sections.push(unknownSection(line));
      }
    } else if (b.headerLine === undefined && b.rowLines.length === 0 && BORDER0_SEPARATOR_RE.test(line) && b.unused) {
      b.format = 'border0';
      b.headerLine = b.unused;
      b.separatorLine = line;
      b.recognized = b.recognized || /^\s*Column\s/.test(b.headerLine);
    } else if (b.format === 'border0' && b.headerLine !== undefined) {
      b.rowLines.push(line);
    } else if (SEPARATOR_RE.test(line)) {
      // The line above a separator is the header (border 2 also draws one above the header).
      if (b.headerLine === undefined && b.rowLines.length > 0) {
        b.headerLine = b.rowLines.pop()!;
        b.recognized = b.recognized || /^\s*\|?\s*Column\s*\|/.test(b.headerLine);
      }
      if (b.headerLine !== undefined && b.separatorLine === undefined && b.rowLines.length === 0) {
        b.separatorLine = line;
      }
    } else if (line.includes('|')) {
      const cells = line.replace(/^\s*\|/, '').split('|').map((c) => c.trim());
      if (b.headerLine === undefined && b.rowLines.length === 0 && cells[0] === 'Column' && /^type$/i.test(cells[1] ?? '')) {
        b.headerLine = line;
        b.recognized = true;
      } else {
        b.rowLines.push(line);
      }
    } else if (b.rowLines.length > 0 && continuesOldAscii(line, b.rowLines)) {
      b.rowLines.push(line);
    } else if (b.rowLines.length > 0) {
      // A footer we don't know (added in a newer psql?): keep it as a section of its own.
      b.phase = 'footer';
      b.sections.push(unknownSection(line));
    } else {
      // Before the rows: psql's banner, a stray command, or the header of border 0 output.
      b.unused = line;
    }
  }

  return blocks.filter((b) => !b.rejected && (!isEmpty(b) || b.name)).map(toDescription);
}

function unknownSection(line: string): Section {
  const colon = line.indexOf(':');
  return colon > 0
    ? { label: line.slice(0, colon), value: line.slice(colon + 1).trim(), lines: [] }
    : { label: line, value: '', lines: [] };
}

/** The field separator, when `line` is the header of unaligned output. */
function unalignedSeparator(line: string): string | undefined {
  const sep = UNALIGNED_HEADER_RE.exec(line)?.[1];
  // Spaces are what aligned output has around its bars; only a lone tab is a separator.
  return sep !== undefined && (sep === '\t' || !/\s/.test(sep)) ? sep : undefined;
}

/**
 * With \pset linestyle old-ascii, the lines after the first of a multi-line cell have no bars: a
 * ":" (after a line break) or ";" (after wrapping) stands where the bar left of the cell would be.
 */
function continuesOldAscii(line: string, rowLines: string[]): boolean {
  const m = /^(\s+)[:;](?: |$)/.exec(line);
  if (!m) {
    return false;
  }
  for (let i = rowLines.length - 1; i >= 0; i--) {
    if (rowLines[i].includes('|')) {
      return new Measured(rowLines[i]).columnsOf('|').includes(m[1].length);
    }
  }
  return false;
}

function normalize(text: string): string {
  // Tabs only mean something as the field separator of unaligned output.
  const tabSeparated = /^Column\tType(?:\t|$)/m.test(text);
  return (tabSeparated ? text : text.replace(/\t/g, '    '))
    .replace(/\r\n?/g, '\n')
    .replace(/[│┃║]/g, '|')
    .replace(/[─━═]/g, '-')
    .replace(/[┼╋╪╫╬┬┴├┤┌┐└┘╞╡╤╧╔╗╚╝╟╢╥╨╠╣╦╩]/g, '+');
}

/**
 * Removes what every line was given on the way here: indentation, the "> " of a quoted mail, the
 * leader of a code comment ("-- ", "# ", "// ", "* "). psql's own output never starts every line
 * the same way, apart from the single space in front of rows pasted alone.
 */
function undecorate(lines: string[]): string[] {
  for (let pass = 0; pass < 4; pass++) {
    const used = lines.filter((l) => l.trim() !== '');
    if (used.length === 0) {
      break;
    }
    let prefix = used[0];
    for (const l of used) {
      let i = 0;
      while (i < prefix.length && i < l.length && prefix[i] === l[i]) {
        i++;
      }
      prefix = prefix.slice(0, i);
    }
    const lead = decoration(prefix);
    if (!lead) {
      break;
    }
    lines = lines.map((l) => (l.startsWith(lead) ? l.slice(lead.length) : l.trim() === '' ? '' : l));
  }
  return lines;
}

/** The part of `prefix` that is indentation and quote or comment leaders. */
function decoration(prefix: string): string {
  let i = 0;
  for (;;) {
    const m = /^(?: +|>+|#|--|\/\/|\*)/.exec(prefix.slice(i));
    if (!m) {
      break;
    }
    // A leader stands apart from the text: "--" is one, the dashes of a separator line are not.
    const next = prefix[i + m[0].length];
    if (m[0].trim() !== '' && next !== undefined && next !== ' ') {
      break;
    }
    i += m[0].length;
  }
  return prefix.slice(0, i);
}

// ---------------------------------------------------------------------------------------------
// Aligned output: cells are found by their position, the way psql laid them out.

const NEWLINE_MARKS = ['+', '↵'];
const WRAP_MARKS = ['.', '…'];
const isNewlineMark = (ch: string) => NEWLINE_MARKS.includes(ch);
const isWrapMark = (ch: string) => WRAP_MARKS.includes(ch);

/** One cell on one printed line. A cell with line breaks, or wrapped by \pset format wrapped, takes several. */
interface Piece {
  /** The cell's text on this line, with the padding up to the column's width. */
  text: string;
  /** The mark left of the text: "." or "…" when it goes on from a wrapped line. */
  left: string;
  /** The mark right of the text: "+" or "↵" when a line break follows, "." or "…" when it wraps. */
  right: string;
  /** With linestyle old-ascii, what stands in place of the bar left of the cell: ":" or ";". */
  rule: string;
  /** The right mark's position isn't known (no header to measure the column by): it may end `text`. */
  open: boolean;
}

interface PrintedLine {
  pieces: Piece[];
  /** The cells were cut at psql's column positions, not just at every bar. */
  exact: boolean;
  /** An old-ascii continuation line. */
  continuation: boolean;
}

interface Grid {
  header?: string[];
  rows: string[][];
}

function loosePiece(text: string): Piece {
  return { text: text.trim(), left: '', right: '', rule: '', open: true };
}

function readAligned(b: Block): Grid {
  const lines = b.headerLine !== undefined ? [b.headerLine, ...b.rowLines] : b.rowLines;
  // With border 2 every line has a bar at both ends.
  const border2 = lines.length > 0 && lines.every((l) => /^\s*\|/.test(l));
  const bodies = lines.map((l) => (border2 ? l.replace(/^\s*\|/, '').replace(/\|$/, '') : l));
  // Rows start with a space, which is where the mark of a wrapped line goes; rows pasted alone may
  // have lost it.
  const leftPad = bodies.every((l) => /^[ .…]/.test(l));

  /** Cuts the lines at the separators' display columns; `lastWidth` is the width of the last column. */
  const cut = (seps: number[] | undefined, lastWidth: number | undefined): Grid => {
    const read = (l: string): PrintedLine => {
      for (const widthRule of seps ? WIDTH_RULES : []) {
        const m = new Measured(l, widthRule);
        const at = seps!.map((s) => m.charAt(s));
        const isRow = at.every((ch) => ch === '|');
        const continuation =
          !isRow && at.every((ch) => ch === '' || ch === ' ' || ch === ':' || ch === ';') && at.some((ch) => ch === ':' || ch === ';');
        if (!isRow && !continuation) {
          continue;
        }
        const pieces: Piece[] = [];
        let fits = true;
        for (let k = 0; k <= seps!.length; k++) {
          const from = k === 0 ? 0 : seps![k - 1] + 1;
          const pad = k > 0 || leftPad ? 1 : 0;
          const left = pad ? m.charAt(from) : '';
          let text: string;
          let right = '';
          let open = false;
          if (k < seps!.length) {
            text = m.slice(from + pad, seps![k] - 1);
            right = m.charAt(seps![k] - 1);
          } else if (lastWidth !== undefined) {
            text = m.slice(from + pad, from + pad + lastWidth);
            right = m.charAt(from + pad + lastWidth);
            fits = fits && m.slice(from + pad + lastWidth + 1).trim() === '';
          } else {
            text = m.slice(from + pad);
            open = true;
          }
          fits = fits && (left.trim() === '' || isWrapMark(left)) && (right.trim() === '' || isWrapMark(right) || isNewlineMark(right));
          pieces.push({ text, left: left.trim(), right: right.trim(), rule: k > 0 && continuation ? at[k - 1].trim() : '', open });
        }
        if (fits) {
          return { pieces, exact: true, continuation };
        }
      }
      return { pieces: l.split('|').map(loosePiece), exact: false, continuation: false };
    };
    const printed = bodies.map(read);
    const header = b.headerLine !== undefined ? printed.shift()!.pieces.map((p) => p.text.trim()) : undefined;
    const widths = seps?.map((s, k) => s - (k === 0 ? (leftPad ? 1 : 0) : seps[k - 1] + 2) - 1);
    return { header, rows: joinPrinted(printed, [...(widths ?? []), lastWidth]) };
  };

  // The line of dashes under the header says exactly where the separators are.
  const rule = b.separatorLine === undefined ? '' : border2 ? b.separatorLine.replace(/^\s*\+/, '').replace(/\+$/, '') : b.separatorLine;
  if (/^-+(?:\+-+)+$/.test(rule)) {
    const seps = [...rule].flatMap((ch, i) => (ch === '+' ? [i] : []));
    return cut(seps, rule.length - seps[seps.length - 1] - 3);
  }

  // No header was pasted. psql pads every row so the separators line up, so a bar that sits at the
  // same position in most rows is a separator and any other bar is part of a value.
  const withBars = bodies.filter((l) => l.includes('|'));
  const counts = new Map<number, number>();
  for (const l of withBars) {
    for (const col of new Measured(l).columnsOf('|')) {
      counts.set(col, (counts.get(col) ?? 0) + 1);
    }
  }
  const positions =
    withBars.length > 1 ? [...counts].filter(([, n]) => n * 2 > withBars.length).map(([col]) => col).sort((x, y) => x - y) : [];
  if (positions.length > 0) {
    // With border 2 the last column is padded too, so its width shows.
    const lastWidth = border2 ? displayWidth(withBars[0]) - positions[positions.length - 1] - 3 : undefined;
    // Every row has at least the separator bars, so the positions are only trusted when there are
    // as many as the row with the fewest bars has.
    if (positions.length === Math.min(...withBars.map(bars))) {
      return cut(positions, lastWidth);
    }
  }
  // Text that isn't aligned (typed by hand, edited) is split on every bar instead.
  return cut(undefined, undefined);
}

function readBorder0(b: Block): Grid {
  const groups = [...b.separatorLine!.matchAll(/-+/g)].map((m) => ({ start: m.index!, width: m[0].length }));
  const cut = (l: string): PrintedLine => {
    let fallback: Piece[] | undefined;
    for (const widthRule of WIDTH_RULES) {
      const m = new Measured(l, widthRule);
      const pieces = groups.map((g): Piece => ({
        text: m.slice(g.start, g.start + g.width),
        left: '',
        right: m.charAt(g.start + g.width).trim(),
        rule: '',
        open: false,
      }));
      // Between two columns there is one space, or the mark of a cell that goes on.
      if (pieces.every((p) => p.right === '' || isWrapMark(p.right) || isNewlineMark(p.right))) {
        return { pieces, exact: true, continuation: false };
      }
      fallback ??= pieces.map((p) => ({ ...p, right: '', open: true }));
    }
    return { pieces: fallback!, exact: false, continuation: false };
  };
  const header = cut(b.headerLine!).pieces.map((p) => p.text.trim());
  return { header, rows: joinPrinted(b.rowLines.map(cut), groups.map((g) => g.width)) };
}

/** Puts the printed lines of each row back together into one row of whole cells. */
function joinPrinted(printed: PrintedLine[], widths: (number | undefined)[]): string[][] {
  const groups: PrintedLine[][] = [];
  let prev: PrintedLine | undefined;
  for (const line of printed) {
    const first = line.pieces[0];
    const goesOn =
      prev !== undefined &&
      (line.continuation ||
        (prev.exact && prev.pieces.some((p) => p.right !== '')) ||
        isWrapMark(first.left) ||
        // The name cell of a real row is never empty.
        (first.text.trim() === '' && line.pieces.some((p) => p.text.trim() !== '')));
    if (goesOn) {
      groups[groups.length - 1].push(line);
    } else {
      groups.push([line]);
    }
    prev = line;
  }
  return groups.map((group) => {
    const cells = Math.max(...group.map((l) => l.pieces.length));
    return Array.from({ length: cells }, (_, k) => joinPieces(group.map((l) => l.pieces[k]), widths[k]));
  });
}

function joinPieces(pieces: (Piece | undefined)[], width: number | undefined): string {
  let out = '';
  let prev: Piece | undefined;
  for (const p of pieces) {
    if (!p) {
      continue;
    }
    if (!prev) {
      out = p.text;
      prev = p;
      continue;
    }
    let mark = prev.right;
    if (prev.open && mark === '') {
      // Without the column's width the mark can't be told from the text by its position: take a
      // final "+" for one, and a final "." when the next line says it goes on from a wrapped line.
      const last = out.slice(-1);
      if (isNewlineMark(last) || (isWrapMark(last) && isWrapMark(p.left))) {
        mark = last;
        out = out.slice(0, -1);
      }
    }
    if (isNewlineMark(mark) || p.rule === ':') {
      out = out.replace(/ +$/, '') + '\n' + p.text;
    } else if (isWrapMark(mark) || isWrapMark(p.left) || p.rule === ';') {
      // A wrapped line fills the column, so spaces at its end are part of the value.
      const missing = width === undefined ? 0 : width - displayWidth(prev.text);
      out += ' '.repeat(Math.max(0, missing)) + p.text;
    } else if (p.text.trim() !== '') {
      out = out.replace(/ +$/, '');
      out = out ? out + ' ' + p.text.trim() : p.text.trim();
    }
    prev = p;
  }
  return out.replace(/ +$/, '');
}

// ---------------------------------------------------------------------------------------------

function toDescription(b: Block): Description {
  let grid: Grid;
  if (b.format === 'unaligned') {
    const header = (b.csv ? splitCsv(b.headerLine!) : b.headerLine!.split(b.sep)).map((c) => c.trim());
    const rows = b.rowLines.map((l) => (b.csv ? splitCsv(l).map((c) => c.trim()) : fitRow(l.split(b.sep), header, b.sep)));
    grid = { header, rows };
  } else {
    grid = b.format === 'border0' ? readBorder0(b) : readAligned(b);
  }
  const { header, rows } = grid;
  const foreign =
    /foreign/i.test(b.kind) ||
    b.sections.some((s) => s.label === 'Server' || s.label === 'FDW options') ||
    (header ?? []).some((h) => /^fdw options$/i.test(h));

  let layout: Layout;
  let shaped = false;
  const notes: string[] = [];
  if (header && /^column$/i.test(header[0] ?? '') && /^type$/i.test(header[1] ?? '')) {
    layout = layoutFromHeader(header);
  } else {
    // No header, or one in another language: the cells say what they are.
    ({ layout, shaped } = inferLayout(rows, foreign));
    if (header && shaped) {
      notes.push(FOREIGN_HEADER_NOTE);
    }
  }
  const columns = rows.filter((r) => r.some((c) => c !== '')).map((r) => toColumn(r, layout));
  return {
    kind: b.kind,
    schema: b.schema,
    name: b.name,
    columns,
    sections: b.sections,
    hasFdwColumn: layout.fdwOptions !== undefined,
    recognized: b.recognized,
    shaped,
    notes,
  };
}

/**
 * In unaligned output a separator inside a value can't be told from a real one by its position.
 * When a row has more cells than the header, glue the extra ones back into whichever column makes
 * every cell a valid value for its column.
 */
function fitRow(cells: string[], header: string[], sep: string): string[] {
  const extra = cells.length - header.length;
  if (extra <= 0) {
    return cells.map((c) => c.trim());
  }
  const layout = layoutFromHeader(header);
  const order = [layout.description, layout.name, layout.default, layout.fdwOptions, layout.type, layout.collation];
  for (const k of [...order, ...header.keys()]) {
    if (k === undefined) {
      continue;
    }
    const candidate = [...cells.slice(0, k), cells.slice(k, k + extra + 1).join(sep), ...cells.slice(k + extra + 1)].map(
      (c) => c.trim(),
    );
    if (isValidRow(candidate, layout)) {
      return candidate;
    }
  }
  return [...cells.slice(0, header.length - 1), cells.slice(header.length - 1).join(sep)].map((c) => c.trim());
}

function isValidRow(cells: string[], layout: Layout): boolean {
  const at = (i: number | undefined) => (i === undefined ? '' : cells[i]);
  return (
    at(layout.name) !== '' &&
    isTypeName(at(layout.type)) &&
    ['', 'not null'].includes(at(layout.nullable)) &&
    (layout.storage === undefined || STORAGE_VALUES.has(at(layout.storage))) &&
    ['', 'pglz', 'lz4'].includes(at(layout.compression)) &&
    /^-?\d*$/.test(at(layout.statsTarget)) &&
    (at(layout.fdwOptions) === '' || /^\(.*\)$/s.test(at(layout.fdwOptions))) &&
    !/\s/.test(at(layout.collation))
  );
}

/** A type as format_type() prints it starts with a letter or a quote, and closes the brackets it opens. */
function isTypeName(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) {
      return false;
    }
  }
  return depth === 0 && /^[\p{L}_"]/u.test(text);
}

/** Reads CSV fields: a field in double quotes can hold commas, line breaks and doubled quotes. */
function splitCsv(record: string): string[] {
  return scanCsv(record).fields;
}

/** True when `record` ends inside a quoted field, so the next line belongs to it. */
function csvFieldIsOpen(record: string): boolean {
  return scanCsv(record).open;
}

function scanCsv(record: string): { fields: string[]; open: boolean } {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (record[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return { fields, open: quoted };
}

type Layout = Partial<Record<keyof Column | 'nullable' | 'modifiers', number>>;

const HEADER_FIELDS: Record<string, keyof Layout> = {
  column: 'name',
  type: 'type',
  collation: 'collation',
  nullable: 'nullable',
  default: 'default',
  'fdw options': 'fdwOptions',
  storage: 'storage',
  compression: 'compression',
  'stats target': 'statsTarget',
  description: 'description',
  modifiers: 'modifiers',
};

function layoutFromHeader(header: string[]): Layout {
  const layout: Layout = {};
  header.forEach((h, i) => {
    const field = HEADER_FIELDS[h.toLowerCase()];
    if (field && layout[field] === undefined) {
      layout[field] = i;
    }
  });
  if (layout.name === undefined) {
    layout.name = 0;
  }
  if (layout.type === undefined) {
    layout.type = 1;
  }
  return layout;
}

const STORAGE_VALUES = new Set(['plain', 'main', 'external', 'extended']);

/**
 * Works out which cell is which when the header line wasn't pasted. `shaped` says whether the rows
 * really look like \d's: a name, a type, then the "not null" column (or 9.x's modifiers).
 */
function inferLayout(rows: string[][], foreign: boolean): { layout: Layout; shaped: boolean } {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const all = (i: number, test: (v: string) => boolean) => rows.length > 0 && rows.every((r) => test(r[i] ?? ''));
  const isStorage = (i: number) => all(i, (v) => STORAGE_VALUES.has(v));
  const isFdwOptions = (i: number) => all(i, (v) => v === '' || v.startsWith('('));
  // Every row has a name and a type; this keeps rows of data out.
  const named = all(0, (v) => v !== '') && all(1, isTypeName);

  const layout: Layout = { name: 0, type: 1 };
  let pos: number;
  if (width >= 5 && all(3, (v) => v === '' || v === 'not null')) {
    Object.assign(layout, { collation: 2, nullable: 3, default: 4 });
    pos = 5;
  } else if (width >= 3 && all(2, (v) => /^(?:collate \S+)?\s*(?:not null)?\s*(?:default .*)?$/s.test(v))) {
    layout.modifiers = 2;
    pos = 3;
  } else {
    return { layout: width >= 5 ? { name: 0, type: 1, collation: 2, nullable: 3, default: 4 } : layout, shaped: false };
  }
  if (pos < width && isFdwOptions(pos) && !isStorage(pos) && (foreign || width - pos === 1)) {
    layout.fdwOptions = pos++;
  }
  if (pos < width && isStorage(pos)) {
    layout.storage = pos++;
    const left = width - pos;
    if (left >= 3) {
      layout.compression = pos++;
    }
    if (left >= 2) {
      layout.statsTarget = pos++;
    }
    if (left >= 1) {
      layout.description = pos++;
    }
  }
  return { layout, shaped: named };
}

function toColumn(row: string[], layout: Layout): Column {
  const cell = (i: number | undefined) => (i === undefined ? '' : (row[i] ?? ''));
  const col: Column = {
    name: cell(layout.name),
    type: cell(layout.type),
    collation: cell(layout.collation),
    notNull: cell(layout.nullable) === 'not null',
    default: cell(layout.default),
    fdwOptions: cell(layout.fdwOptions),
    storage: cell(layout.storage),
    compression: cell(layout.compression),
    statsTarget: cell(layout.statsTarget),
    description: cell(layout.description),
  };
  if (layout.modifiers !== undefined) {
    // PostgreSQL 9.x: "collate C not null default nextval('t_id_seq'::regclass)".
    let mods = cell(layout.modifiers);
    const collate = /^collate (\S+)\s*/.exec(mods);
    if (collate) {
      col.collation = collate[1].replace(/^"(.*)"$/, '$1');
      mods = mods.slice(collate[0].length);
    }
    const notNull = /^not null\s*/.exec(mods);
    if (notNull) {
      col.notNull = true;
      mods = mods.slice(notNull[0].length);
    }
    const def = /^default (.*)$/s.exec(mods);
    if (def) {
      col.default = def[1];
    }
  }
  return col;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
