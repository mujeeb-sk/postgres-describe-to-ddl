// Display width of text. psql pads its columns by the width a terminal gives each character, so a
// separator's position has to be counted in display columns, not in characters: a CJK character
// takes two columns, a combining mark none.

// Characters that are two columns wide (East Asian Wide and Fullwidth in Unicode's
// EastAsianWidth.txt, neighbouring ranges merged).
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cd5],
  [0x1aff0, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

// The smaller set older psql versions treated as wide (no emoji or symbols).
const WIDE_CJK_ONLY: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** Which characters count as two columns wide: all of Unicode's, or only the CJK ones. */
export type WidthRule = 'unicode' | 'cjk';
export const WIDTH_RULES: WidthRule[] = ['unicode', 'cjk'];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) {
      hi = mid - 1;
    } else if (cp > ranges[mid][1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

function charWidth(ch: string, rule: WidthRule): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x300) {
    return 1;
  }
  if (ZERO_WIDTH.test(ch)) {
    return 0;
  }
  return inRanges(cp, rule === 'unicode' ? WIDE : WIDE_CJK_ONLY) ? 2 : 1;
}

/** A line with the display column each of its characters starts at. */
export class Measured {
  /** `columns[i]` is where `text[i]` starts; the entry after the last one is the line's width. */
  private readonly columns: number[] | undefined;

  constructor(
    readonly text: string,
    rule: WidthRule = 'unicode',
  ) {
    // Plain ASCII, the usual case: a character's column is its index.
    if (/[^\x00-\x7f]/.test(text)) {
      this.columns = [];
      let col = 0;
      for (const ch of text) {
        for (let i = 0; i < ch.length; i++) {
          this.columns.push(col);
        }
        col += charWidth(ch, rule);
      }
      this.columns.push(col);
    }
  }

  get width(): number {
    return this.columns ? this.columns[this.columns.length - 1] : this.text.length;
  }

  /** The index of the character that starts at `column` or, when none does, of the first one after it. */
  indexAt(column: number): number {
    if (!this.columns) {
      return Math.min(Math.max(column, 0), this.text.length);
    }
    let i = 0;
    while (i < this.text.length && this.columns[i] < column) {
      i++;
    }
    return i;
  }

  /** The character that starts exactly at `column`; empty when the line is shorter or a wide character covers it. */
  charAt(column: number): string {
    const i = this.indexAt(column);
    if (i >= this.text.length || (this.columns && this.columns[i] !== column)) {
      return '';
    }
    return this.text[i];
  }

  /** The text in display columns `from` (inclusive) to `to` (exclusive, the end of the line by default). */
  slice(from: number, to?: number): string {
    return this.text.slice(this.indexAt(from), to === undefined ? undefined : this.indexAt(to));
  }

  /** The display columns of every `ch` in the line. */
  columnsOf(ch: string): number[] {
    const out: number[] = [];
    for (let i = this.text.indexOf(ch); i >= 0; i = this.text.indexOf(ch, i + 1)) {
      out.push(this.columns ? this.columns[i] : i);
    }
    return out;
  }
}

/** The display width of `text`. */
export function displayWidth(text: string, rule: WidthRule = 'unicode'): number {
  return new Measured(text, rule).width;
}
