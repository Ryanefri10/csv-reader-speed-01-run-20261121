// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader's {columns, rows, errors} for {text, header}, but parsed with
// indexOf/slice scanning instead of one character at a time.
//
// Semantics follow vendor/csv-reader 1.0.0 exactly:
//  - U+FEFF at the very start is dropped.
//  - A record ends at LF or CRLF; a line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next quote that is not doubled;
//    "" inside is one quote; each CRLF or lone CR inside reads as LF; what
//    follows the closing quote up to the next comma or line break is appended
//    as it stands (quote_junk, when the field ends); a quote that never
//    closes is a literal character and the text after it is read again as
//    unquoted (unterminated_quote).
//  - A quote inside an unquoted field is a literal character.
//  - columns is the first record when header is true, else null; rows are the
//    records after it, each padded (short_row, fields: its count) or cut
//    (long_row, extra: the cut fields) to the first record's width.
//  - Each error is {code, line, row} in the order met; line is the 1-based
//    line its record starts on, row its record's index in rows (null for the
//    header). A record's short_row/long_row is reported when it ends.
//
// Pure: no clock, no randomness, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters from pos onto `value` up to the next comma or
  // line break; a CR not followed by LF is dropped (stray_cr). Returns
  // [value, ended, added]; `added` counts the characters kept. Fast path:
  // the field ends at the nearer of the next comma / next LF; a CR inside the
  // slice (other than the CR of a CRLF ending) falls back to the slow path.
  function readUnquoted(value) {
    let ci = text.indexOf(',', pos);
    if (ci < 0) ci = len;
    let ni = text.indexOf('\n', pos);
    if (ni < 0) ni = len;
    if (ci <= ni) {
      if (ci === len) {
        // No comma and no LF before the end: the field runs to the end.
        const v = text.slice(pos, len);
        if (v.indexOf('\r') < 0) {
          pos = len;
          return [value === '' ? v : value + v, END, v.length];
        }
        return readUnquotedSlow(value);
      }
      const v = text.slice(pos, ci);
      if (v.indexOf('\r') < 0) {
        pos = ci + 1;
        return [value === '' ? v : value + v, COMMA, v.length];
      }
      return readUnquotedSlow(value);
    }
    // The field ends at a line break (ni < ci).
    let v = text.slice(pos, ni);
    if (ni > pos && text.charCodeAt(ni - 1) === 13) v = text.slice(pos, ni - 1);
    if (v.indexOf('\r') < 0) {
      pos = ni + 1;
      line += 1;
      return [value === '' ? v : value + v, LINE_BREAK, v.length];
    }
    return readUnquotedSlow(value);
  }

  // Character-at-a-time unquoted read, exactly as the reference does it.
  function readUnquotedSlow(value) {
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return [value, COMMA, added];
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return [value, LINE_BREAK, added];
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return [value, END, added];
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns [value, ended, added] like readUnquoted (added is only used for
  // the quote_junk check on the junk path).
  function readQuoted() {
    const open = pos;
    let p = pos + 1;
    let closed = -1;
    let doubled = false;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q < 0) break;
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        p = q + 2;
        continue;
      }
      closed = q;
      break;
    }
    if (closed < 0) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted. line was never advanced by the scan, so
      // it is still the opening quote's line, as the reference resets it to.
      pos = open + 1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    // The raw inner span [open+1, closed): every '"' in it is half of a
    // doubled pair, by construction of the scan above. Check for CR/LF
    // inside the span itself, never past it: an unbounded search past the
    // closing quote would scan the rest of the file on LF files.
    const raw = text.slice(open + 1, closed);
    const hasCR = raw.indexOf('\r') >= 0;
    const hasLF = raw.indexOf('\n') >= 0;
    let value;
    if (!doubled && !hasCR && !hasLF) {
      value = raw;
    } else {
      value = doubled ? raw.replaceAll('""', '"') : raw;
      if (hasCR || hasLF) {
        // Line breaks inside quotes: each CRLF and each lone CR reads as one
        // LF, and each counts one line; a plain LF counts one line.
        let breaks = 0;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 10) breaks += 1;
          else if (c === 13) {
            breaks += 1;
            if (raw.charCodeAt(i + 1) === 10) i += 1;
          }
        }
        line += breaks;
        value = value.replace(/\r\n?/g, '\n');
      }
    }
    pos = closed + 1;
    if (pos >= len) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    {
      // Fast path: a record whose line holds no quote before its line break
      // is all unquoted fields. (A quote inside an unquoted field is a
      // literal, but it is rare; any quote sends the record to the slow path.)
      const ni = text.indexOf('\n', pos);
      const qi = text.indexOf('"', pos);
      if (qi < 0 || (ni >= 0 && qi > ni)) {
        const end = ni < 0 ? len : ni;
        let seg = text.slice(pos, end);
        const cr = seg.indexOf('\r');
        if (cr < 0) {
          if (seg === '') {
            // Empty line: no record.
            pos = end + (ni < 0 ? 0 : 1);
            if (ni >= 0) line += 1;
            if (pos >= len) break;
            continue;
          }
          fields = seg.split(',');
          pos = end + (ni < 0 ? 0 : 1);
          if (ni >= 0) line += 1;
        } else if (cr === seg.length - 1 && ni >= 0) {
          // CRLF ending: the CR is the line break, not field content.
          if (seg.length === 1) {
            pos = end + 1;
            line += 1;
            if (pos >= len) break;
            continue;
          }
          fields = seg.slice(0, -1).split(',');
          pos = end + 1;
          line += 1;
        }
        // Otherwise a stray CR sits inside the record: fall through to the
        // field-by-field path below.
      }
    }
    let quoted = false;
    if (fields === undefined) {
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field[0]);
      } while (field[1] === COMMA);

      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
