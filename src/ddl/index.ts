// Converts psql \d / \d+ output into CREATE TABLE (or CREATE FOREIGN TABLE, CREATE VIEW, ...) statements.

import { generateDdl, GenerateOptions } from './generate';
import { Description, parseDescriptions, unsupportedFormat } from './parse';

export { GenerateOptions, PLACEHOLDER_TABLE } from './generate';
export { Description } from './parse';

export interface Conversion {
  sql: string;
  descriptions: Description[];
}

/** Returns undefined when the text has no \d output in it. */
export function convertDescribeOutput(text: string, options: GenerateOptions = {}): Conversion | undefined {
  const descriptions = parseDescriptions(text).filter(hasContent);
  if (descriptions.length === 0) {
    return undefined;
  }
  return { sql: generateDdl(descriptions, options), descriptions };
}

/**
 * A title alone counts: a table with no columns prints nothing else. Rows with bars alone don't:
 * they have to look like \d's rows, or come with something only \d prints.
 */
function hasContent(d: Description): boolean {
  return (d.recognized || d.shaped) && (d.columns.length > 0 || d.sections.length > 0 || d.kind !== '');
}

export interface Found {
  /** The text has something that parses as \d output (column rows or footers). */
  found: boolean;
  /** The text has something only \d prints: a title, a \d command, the column header or a footer. */
  recognized: boolean;
  /** For each description that doesn't say which table it is, its first column names. */
  unnamed: string[];
  /** The psql output format of the text, when it's one that can't be converted (e.g. "HTML"). */
  unsupported?: string;
}

export function findDescriptions(text: string): Found {
  const descriptions = parseDescriptions(text).filter(hasContent);
  const unsupported = unsupportedFormat(text);
  return {
    ...(unsupported ? { unsupported } : {}),
    found: descriptions.length > 0,
    recognized: descriptions.some((d) => d.recognized),
    unnamed: descriptions
      .filter((d) => !d.name)
      .map((d) => {
        const names = d.columns.slice(0, 3).map((c) => c.name);
        return names.join(', ') + (d.columns.length > 3 ? ', …' : '');
      }),
  };
}
