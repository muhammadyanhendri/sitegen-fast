// sitegen-fast: a fast, original reimplementation of makefun-site 1.0.0's build
// semantics. The dialect (front matter, template language, Markdown subset, slug
// rule, report) is the one the reference README states; every routine below is
// written fresh for speed and nothing of the reference implementation is reused:
// templates are parsed once per case and rendered into an array that is joined
// once, Markdown is rendered in a single pass over the lines, slugs and long
// dates are cached per case, and hot paths avoid regular expressions.
//
// run(input) returns the output tree for one case: a JSON object of every path
// the build writes and that file's text, byte for byte identical to the
// reference. All per-case state lives in the state object S built inside run,
// so each case is answered alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const MARK_RE = /\p{M}/gu;
const NON_ASCII_RE = /[^\x00-\x7F]/;
const WS_RE = /\s/;
const CONTINUED_RE = /^ {2,}\S/;
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const INCLUDE_DEPTH = 8;
const REPORT_FILE = 'build-report.txt';

/** The characters a backslash escapes, as a table indexed by char code. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57);
const isSpaceTab = (c) => c === 32 || c === 9;

function hasWhitespace(s) {
  return WS_RE.test(s);
}

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The slug of `text`, cached per case in S. */
function slugify(S, text) {
  const hit = S.slugCache.get(text);
  if (hit !== undefined) return hit;
  // ASCII has no NFKD decomposition and no combining marks, so the slow path
  // (normalise + drop marks) is only needed for non-ASCII input.
  let plain = text;
  if (NON_ASCII_RE.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  let end = Math.min(out.length, 64);
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  S.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, cached per case in S. */
function longDate(S, date) {
  let hit = S.dateCache.get(date);
  if (hit === undefined) {
    hit = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    S.dateCache.set(date, hit);
  }
  return hit;
}

/** Whether the code unit `c` is JavaScript whitespace (the \s set). */
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body's lines: runs of characters other than whitespace. A word
 * never spans a line (the join between lines is a newline, itself whitespace),
 * so counting per line equals counting the joined body, with no join built. */
function countWords(lines) {
  let count = 0;
  for (const line of lines) {
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      if (isSpaceCode(line.charCodeAt(i))) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
  }
  return count;
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrailing(s) {
  let e = s.length;
  while (e > 0 && isSpaceTab(s.charCodeAt(e - 1))) e--;
  return s.slice(0, e);
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dirParts` of a source, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOfKey(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (ok && (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))) ok = false;
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, bodyStart }, or { error } with the
 * first reason it is refused. `lines` is the source's text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length && ((line.charCodeAt(j) >= 97 && line.charCodeAt(j) <= 122) || line.charCodeAt(j) === 95)) j++;
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = stripTrailing(line.slice(j + 2));
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOfKey(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** A fence opener's language, or null when `line` is not one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (!isSpaceTab(line.charCodeAt(i))) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  if (!isSpaceTab(line.charCodeAt(n))) return null;
  let a = n;
  while (a < line.length && isSpaceTab(line.charCodeAt(a))) a++;
  let b = line.length;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` below `to` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  const last = to - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` below `to` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[lo..hi)` rendered inline into `out`; `link(target)` resolves a link's href.
 * Plain runs are flushed whole (one escape pass each) instead of per character,
 * and nested strong, emphasis and link text are rendered by range, never sliced
 * out of the string, so no copy of the inner text is ever built.
 */
function renderInline(s, link, out, lo, hi) {
  const n = hi;
  let i = lo;
  let seg = lo;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : -1;
      if (d !== -1 && ESCAPABLE[d] === 1) {
        if (seg < i) out.push(escapeHtml(s.slice(seg, i)));
        const ch = s[i + 1];
        out.push(ESCAPES[ch] ?? ch);
        i += 2;
        seg = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < n) {
        if (seg < i) out.push(escapeHtml(s.slice(seg, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        seg = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, n);
        if (j > i + 2) {
          if (seg < i) out.push(escapeHtml(s.slice(seg, i)));
          out.push('<strong>');
          renderInline(s, link, out, i + 2, j);
          out.push('</strong>');
          i = j + 2;
          seg = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, n);
      if (j > i + 1) {
        if (seg < i) out.push(escapeHtml(s.slice(seg, i)));
        out.push('<em>');
        renderInline(s, link, out, i + 1, j);
        out.push('</em>');
        i = j + 1;
        seg = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, n);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      if (m !== -1 && m < n) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !hasWhitespace(target)) {
          if (seg < i) out.push(escapeHtml(s.slice(seg, i)));
          out.push('<a href="', escapeHtml(link(target)), '">');
          renderInline(s, link, out, i + 1, k);
          out.push('</a>');
          i = m + 1;
          seg = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  if (seg < n) out.push(escapeHtml(s.slice(seg, n)));
}

/**
 * A body's lines rendered: its HTML (each block on its own lines, a "\n" after
 * the last), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or ""). Blocks are rendered
 * straight into the output array instead of through token objects.
 */
function renderMarkdown(lines, link, S) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  // One scratch array for every inline render in this page, reused block to
  // block instead of allocated per paragraph, heading or list item.
  const tmp = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      // Escaping is per character, so one escape over the joined body plus a
      // trailing newline equals escaping each line and adding one after it.
      const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(S, h.text), ids);
      tmp.length = 0;
      renderInline(h.text, link, tmp, 0, h.text.length);
      const html = tmp.join('');
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        const text = kept.join('\n');
        tmp.length = 0;
        renderInline(text, link, tmp, 0, text.length);
        blocks.push(`<blockquote>\n<p>${tmp.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrdered = o0 !== null;
      const first = isOrdered ? o0 : b0;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      const innerParts = [];
      for (const parts of items) {
        const text = parts.join('\n');
        tmp.length = 0;
        renderInline(text, link, tmp, 0, text.length);
        innerParts.push(`<li>${tmp.join('')}</li>\n`);
      }
      blocks.push(`${open}\n${innerParts.join('')}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    tmp.length = 0;
    renderInline(text, link, tmp, 0, text.length);
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or null when it is not a path. */
function splitPath(text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isNameStart(p.charCodeAt(0))) return null;
    for (let k = 1; k < p.length; k++) if (!isNameChar(p.charCodeAt(k))) return null;
  }
  return parts;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const p = splitPath(text);
  if (p === null) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return p;
}

/** Whether `s` holds only spaces and tabs. */
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) if (!isSpaceTab(s.charCodeAt(i))) return false;
  return true;
}

/** A `for` tag's variable and path, or null. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let j = 4;
  if (j >= tag.length || !isNameStart(tag.charCodeAt(j))) return null;
  j++;
  while (j < tag.length && isNameChar(tag.charCodeAt(j))) j++;
  const name = tag.slice(4, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const path = tag.slice(j + 4);
  if (path.length === 0 || hasWhitespace(path)) return null;
  return { name, path };
}

/** An `if` tag's negation and path, or null. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest.length === 0 || hasWhitespace(rest)) return null;
  return { not, path: rest };
}

/** An `include` tag's template name, or null. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src.slice(lineStart, open)) && isSpacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    const f = parseFor(tag);
    if (f !== null) {
      const node = { kind: 'for', name: f.name, path: pathOf(name, f.path), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    const cond = parseIf(tag);
    if (cond !== null) {
      const node = { kind: 'if', not: cond.not, path: pathOf(name, cond.path), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      continue;
    }
    const inc = parseInclude(tag);
    if (inc !== null) {
      body.push({ kind: 'include', name: inc });
      continue;
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope` ({ vars, parent }); S holds the parsed templates. */
function renderNodes(nodes, scope, S, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, S, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope and vars object per execution; only `loop` is fresh per
        // item. Safe: rendering is synchronous and a re-entrant execution of
        // the same node (through an include) builds its own objects.
        const vars = {};
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, S, depth, out);
        }
        break;
      }
      case 'include': {
        const t = S.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, S, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** Whether `t` opens with a scheme: a letter, then letters, digits, +, - or ., then ':'. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A source's link resolver: a target with a scheme, or opening on / or #, is kept as written. */
function makeLink(S, dir, sourcePath) {
  const dirParts = dir === '' ? [] : dir.split('/');
  const cache = new Map();
  return (target) => {
    const hit = cache.get(target);
    if (hit !== undefined) return hit;
    let href;
    if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) href = target;
    else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && S.bySource.has(path)) href = `${S.bySource.get(path).url}${frag}`;
      else if (path !== null && S.staticPaths.has(path)) href = `${S.base}/${path}${frag}`;
      else {
        S.broken.add(`broken-link ${sourcePath} -> ${target}`);
        href = target;
      }
    }
    cache.set(target, href);
    return href;
  };
}

/** A page's link record as templates read it. */
function linkOf(S, s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(S, s.data.date) };
}

/** A post's card, as lists show it (built once per source). */
function cardOf(S, s) {
  if (s.card === undefined) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(S, s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  return s.card;
}

/** A page as its layout reads it. */
function pageOf(S, s) {
  return {
    ...cardOf(S, s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(S, s.newer ?? null),
    older: linkOf(S, s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(S, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(S, p)) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const S = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    slugCache: new Map(),
    dateCache: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
    report: [],
    posts: [],
    tags: [],
    output: {},
  };

  // Templates, parsed in code-unit order of their name. One that does not
  // parse is reported and left out, as if it were not there.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      S.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      S.report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const raw = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      S.sources.push({ path: f.path, lines: raw.split('\n') });
    } else S.statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in order: parse, generator's own directory, post's date,
  // layout, draft.
  const kept = [];
  for (const s of S.sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      S.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = s.lines.slice(fm.bodyStart);
    s.lines = null;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      S.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      S.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!S.templates.has(layout)) {
      S.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      S.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  S.sources = kept;

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of S.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(S, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${S.base}/${s.outDir}/`;
    S.bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved, its words counted.
  S.staticPaths = new Set(S.statics.map((f) => f.path));
  for (const s of S.sources) {
    const md = renderMarkdown(s.bodyLines, makeLink(S, dirOf(s.path), s.path), S);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.bodyLines);
    s.bodyLines = null;
  }

  // Collections: the posts, newest date first, then by slug; newer and older.
  const posts = S.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  S.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order,
  // ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(S, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of S.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${S.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of S.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  S.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages.
  const cards = new Map(S.posts.map((p) => [p, cardOf(S, p)]));
  const site = { title: input.site.title, base_url: S.base };
  const allTags = S.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = S.posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = S.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, S, 0, out);
    return out.join('');
  };
  for (const s of S.sources) S.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(S, s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(S.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${S.base}/` : `${S.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: S.posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) S.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of S.tags) {
    const html = render('tag', { tag: tagOf(S, t) });
    if (html !== null) S.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) S.output['tags/index.html'] = tagsHtml;
  for (const f of S.statics) {
    if (Object.hasOwn(S.output, f.path)) S.report.push(`shadowed ${f.path}: a built page has its path`);
    else S.output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...S.report, ...S.broken].sort(byCodeUnits);
  const pageCount = S.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${S.posts.length} posts, ${S.tags.length} tags and ${S.statics.length} static files`);
  S.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return S.output;
}
