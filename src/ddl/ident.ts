// SQL quoting helpers that follow PostgreSQL's own rules (quote_ident, quote_literal).

// Every keyword that is not UNRESERVED: these need quotes to be used as a column or table name.
const KEYWORDS = new Set(`
  all analyse analyze and any array as asc asymmetric both case cast check collate column
  constraint create current_catalog current_date current_role current_time current_timestamp
  current_user default deferrable desc distinct do else end except false fetch for foreign from
  grant group having in initially intersect into lateral leading limit localtime localtimestamp
  not null offset on only or order placing primary references returning select session_user some
  symmetric system_user table then to trailing true union unique user using variadic when where
  window with
  authorization binary collation concurrently cross current_schema freeze full ilike inner is
  isnull join left like natural notnull outer overlaps right similar tablesample verbose
  between bigint bit boolean char character coalesce dec decimal exists extract float greatest
  grouping inout int integer interval json json_array json_arrayagg json_exists json_object
  json_objectagg json_query json_scalar json_serialize json_table json_value least merge_action
  national nchar none normalize nullif numeric out overlay position precision real row setof
  smallint substring time timestamp treat trim values varchar xmlattributes xmlconcat xmlelement
  xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable
`.split(/\s+/).filter(Boolean));

/** Quotes a raw (unquoted) name only when PostgreSQL needs it, like quote_ident(). */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !KEYWORDS.has(name)) {
    return name;
  }
  return quoteIdentAlways(name);
}

export function quoteIdentAlways(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Reads a possibly schema-qualified name written in SQL syntax (`foo`, `app."My Table"`) from the
 * start of `text`. Unquoted parts are folded to lower case when `foldCase` is set, as psql does for
 * the pattern typed after \d. Returns the raw parts and the rest of the text.
 */
export function readQualifiedName(text: string, foldCase = false): { parts: string[]; rest: string } | undefined {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    let part: string;
    if (text[i] === '"') {
      let j = i + 1;
      part = '';
      for (;;) {
        if (j >= text.length) {
          return undefined;
        }
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            part += '"';
            j += 2;
            continue;
          }
          break;
        }
        part += text[j++];
      }
      i = j + 1;
    } else {
      const m = /^[^\s."(),;]+/.exec(text.slice(i));
      if (!m) {
        return undefined;
      }
      part = foldCase ? m[0].toLowerCase() : m[0];
      i += m[0].length;
    }
    parts.push(part);
    if (text[i] !== '.') {
      break;
    }
    i++;
  }
  return { parts, rest: text.slice(i) };
}

/** Quotes each raw part and joins them with dots. */
export function qualifiedName(parts: string[]): string {
  return parts.map(quoteIdent).join('.');
}

/**
 * Text already in SQL identifier syntax (regclass or format_type output) is kept as it is, but a
 * bare name that needs quotes, such as one psql printed raw, gets them.
 */
export function asSqlName(text: string): string {
  const parsed = readQualifiedName(text);
  if (parsed && parsed.rest === '') {
    const looksQuotedAlready = text.includes('"');
    return looksQuotedAlready ? text : qualifiedName(parsed.parts);
  }
  return text;
}
