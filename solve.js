// A fast drop-in replacement for makefun-site 1.0.0, written for the
// make.fun bounty "site-generator-speed-01-run-20261122".
//
// run(input) returns exactly the output tree makefun-site's build
// returns for the same input — every page, the index and tag pages,
// build-report.txt and each static file, byte for byte — but built
// with leaner machinery than the reference pipeline:
//
//   * the text helpers scan by hand and skip work when a string is
//     plain ASCII (the common case in a generated site);
//   * the front-matter reader walks line offsets instead of
//     splitting the whole source, so a body is never copied to be
//     read;
//   * the Markdown reader classifies each line by its first
//     characters instead of a battery of regular expressions, and
//     its inline pass works on offsets into the original string
//     instead of slicing a fresh substring at every mark;
//   * slugs are memoised per build, because a site repeats its tag
//     names and headings across hundreds of sources;
//   * templates are compiled once into node trees whose paths are
//     pre-split, and rendering walks them with a plain scope chain.
//
// No dependencies, no clock, no environment, no file access: the
// answer is a function of the input alone, like the reference's.

// ---------------------------------------------------------------- text

/** `s` with & < > " and ' replaced by their HTML escapes, in one pass. */
function escapeHtml(s) {
  let parts = null;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (parts === null) parts = [];
    if (run < i) parts.push(s.slice(run, i));
    parts.push(rep);
    run = i + 1;
  }
  if (parts === null) return s;
  if (run < s.length) parts.push(s.slice(run));
  return parts.join('');
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered,
 * every run of characters other than a-z and 0-9 one "-", none at
 * either end, at most 64 characters with a "-" left at the cut
 * dropped, and "untitled" when nothing is left. ASCII text (the
 * common case) skips the Unicode normalisation, which is the
 * identity there.
 */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether a char code is one of JavaScript's whitespace codes (the \s set). */
function isWsCode(c) {
  return (
    (c >= 9 && c <= 13) || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

/** How many words `text` holds: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * A front-matter string value: "..." whose only escapes are \" and
 * \\, or a bare rest-of-line that never opens on " or [. Returns
 * { value } or { error }.
 */
function stringValue(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function dateValue(raw) {
  const bad = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return bad;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDigit(raw[i])) return bad;
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return bad;
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ or ]. */
function tagsValue(raw) {
  const bad = { error: 'key "tags": an empty tag, or one holding " [ or ]' };
  if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',').map((t) => t.trim());
  for (const t of tags) {
    if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return bad;
  }
  return { value: tags };
}

/** One key's parsed value, or the reason it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateValue(raw);
    case 'tags':
      return tagsValue(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (const c of raw) {
        if (!((c >= 'a' && c <= 'z') || isDigit(c) || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length > 64) return { error: 'key "slug": not a slug' };
      let seg = 0;
      for (const c of raw) {
        if ((c >= 'a' && c <= 'z') || isDigit(c)) seg++;
        else if (c === '-' && seg > 0) seg = 0;
        else return { error: 'key "slug": not a slug' };
      }
      return seg > 0 ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }
 * with the first reason it is refused. `text` has "\n" line ends.
 * The reader walks line offsets, so the body is sliced out once,
 * whole, and never split into lines it does not need.
 */
function parseFrontMatter(text) {
  // Line 1 must be exactly "---".
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Collect the lines up to the closing "---".
  const lines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    lines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      if (line[j] !== ' ' && line[j] !== '\t') {
        blank = false;
        break;
      }
    }
    if (blank || line.startsWith('#')) continue;
    // "key: value": a key of a-z and _, a colon, then either the end
    // of the line or one space and the value.
    let k = 0;
    while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
    if (k === 0 || line[k] !== ':' || (k + 1 < line.length && line[k + 1] !== ' ')) {
      return { error: `line ${i + 2} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw = k + 1 === line.length ? '' : line.slice(k + 2);
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------- markdown

const isSpaceTab = (c) => c === ' ' || c === '\t';

/** A line of nothing but spaces and tabs (or nothing at all). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line[a])) a++;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  return line.slice(a, b);
}

/**
 * A fence's opening line: three backticks, an optional language of
 * A-Z a-z 0-9 _ + -, then spaces or tabs only. Returns the language
 * ("" for none), or null when the line opens no fence.
 */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || isDigit(c) || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (!isSpaceTab(line[i])) return null;
    i++;
  }
  return lang;
}

/** A fence's closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/**
 * A heading line's depth and text, or null: 1 to 6 "#", at least one
 * space or tab, then text (spaces and tabs at its end dropped;
 * closing "#"s are kept as text). No text, or 7 or more "#", is no
 * heading.
 */
function headingOf(line) {
  let h = 0;
  while (line[h] === '#') h++;
  if (h < 1 || h > 6 || !isSpaceTab(line[h])) return null;
  let a = h;
  while (a < line.length && isSpaceTab(line[a])) a++;
  let b = line.length;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHr(line) {
  const head = line.slice(0, 3);
  if (head !== '---' && head !== '***') return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A bullet item's text ("- " or "* " opens it), or null. */
function bulletText(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's number and text ("12. " opens it), or null. */
function orderedText(line) {
  let d = 0;
  while (d < line.length && isDigit(line[d])) d++;
  if (d < 1 || d > 9 || line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line[j] === ' ') j++;
  return j >= 2 && j < line.length && !/\s/.test(line[j]);
}

/**
 * Whether `line` ends a paragraph: blank, a fence, a heading or a
 * break. Each of those opens on a distinct first character, so the
 * first character picks the only test that can pass.
 */
function endsParagraph(line) {
  const c = line[0];
  if (c === undefined || c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return fenceLang(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one not beside another *), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * The inline rendering of s[a..b): code spans, strong, emphasis,
 * links and backslash escapes, left to right; every other character
 * escaped. Works on offsets into `s`, so a nested mark re-reads its
 * span in place instead of copying it. `link(target)` is a link's
 * href.
 */
function inlineRange(s, a, b, link) {
  const parts = [];
  let run = a;
  let i = a;
  const flush = (to) => {
    if (run < to) parts.push(escapeHtml(s.slice(run, to)));
  };
  // Jump straight to the next character that can open a mark (a
  // backslash, a backtick, a star or a bracket); everything between
  // two marks is one plain run, escaped whole.
  const special = /[\\`*[]/g;
  while (i < b) {
    special.lastIndex = i;
    const m = special.exec(s);
    if (m === null || m.index >= b) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        parts.push(escapeHtml(s[i + 1]));
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    else if (c === 96) {
      // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        flush(i);
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    else if (c === 42) {
      // star
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          flush(i);
          parts.push('<strong>', inlineRange(s, i + 2, j, link), '</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, b);
        if (j > i + 1) {
          flush(i);
          parts.push('<em>', inlineRange(s, i + 1, j, link), '</em>');
          i = j + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    else {
      // open bracket
      const k = findUnescaped(s, ']', i + 1, b);
      let close = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < b) close = p;
      }
      const target = close === -1 ? '' : s.slice(k + 2, close);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        parts.push('<a href="', escapeHtml(link(target)), '">', inlineRange(s, i + 1, k, link), '</a>');
        i = close + 1;
        run = i;
      } else i++;
      continue;
    }
  }
  flush(b);
  return parts.join('');
}

/**
 * A body's rendering: its HTML (each block followed by "\n"), its
 * table of contents (every level 2 and 3 heading: level, id and its
 * inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). Blocks are classified and rendered in one pass.
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = line[0] === '`' ? fenceLang(line) : null;
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const inner = body.map((l) => `${escapeHtml(l)}\n`).join('');
      blocks.push(lang === '' ? `<pre><code>${inner}</code></pre>` : `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`);
      continue;
    }
    const heading = line[0] === '#' ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const html = inlineRange(heading.text, 0, heading.text.length, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((line[0] === '-' || line[0] === '*') && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const kept = [];
      while (i < n && lines[i][0] === '>') {
        const raw = lines[i];
        const stripped = trimLine(raw[1] === ' ' ? raw.slice(2) : raw.slice(1));
        if (stripped !== '') kept.push(stripped);
        i++;
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const text = kept.join('\n');
        blocks.push(`<blockquote>\n<p>${inlineRange(text, 0, text.length, link)}</p>\n</blockquote>`);
      }
      continue;
    }
    const bullet = line[0] === '-' || line[0] === '*' ? bulletText(line) : null;
    const ordered = bullet === null && line[0] >= '0' && line[0] <= '9' ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const text = isOrdered ? orderedText(lines[i])?.text : bulletText(lines[i]);
        if (text !== undefined && text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      const rendered = items.map((parts) => {
        const text = parts.join('\n');
        return `<li>${inlineRange(text, 0, text.length, link)}</li>\n`;
      });
      blocks.push(`${open}\n${rendered.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineRange(text, 0, text.length, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its message names it and says why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether s[a..b) is nothing but spaces and tabs. */
function allSpaceTab(s, a, b) {
  for (let i = a; i < b; i++) if (!isSpaceTab(s[i])) return false;
  return true;
}

/**
 * A template's tokens: text, {{ }} (var), {{{ }}} (raw) and {% %}
 * (tag). A {% %} tag alone on its line (only spaces or tabs beside
 * it) takes the whole line with it, its "\n" included.
 */
function tokenizeTemplate(name, src) {
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
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A template parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [{ node: root, body: root.body }];
  for (const tok of tokenizeTemplate(name, src)) {
    const frame = stack[stack.length - 1];
    if (tok.t === 'text') frame.body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') frame.body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        frame.body.push(node);
        stack.push({ node, body: node.body });
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        frame.body.push(node);
        stack.push({ node, body: node.then });
      } else if (tag === 'else') {
        if (frame.node.kind !== 'if' || frame.node.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        frame.node.else = [];
        frame.body = frame.node.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (frame.node.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${want}`);
        stack.pop();
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) frame.body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].node.kind} is not closed`);
  return root.body;
}

/** The value at `path`: its first name from the nearest scope holding it, then own properties down. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
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
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); `templates` maps names to parsed node trees. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const v = lookupPath(scope, n.path);
        if (typeof v === 'string') out += escapeHtml(v);
        else if (typeof v === 'number' || typeof v === 'boolean') out += String(v);
        else if (Array.isArray(v)) out += escapeHtml(textOf(v));
        break;
      }
      case 'raw': {
        const v = lookupPath(scope, n.path);
        if (typeof v === 'string') out += v;
        else if (typeof v === 'number' || typeof v === 'boolean') out += String(v);
        else if (Array.isArray(v)) out += textOf(v);
        break;
      }
      case 'if': {
        const branch = truthy(lookupPath(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope for the whole loop, its bindings updated per
        // item: rendering is synchronous, so nothing can observe
        // a stale binding.
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { [n.name]: null, loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          out += renderNodes(n.body, child, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

/**
 * The parsed templates with every include spliced in place,
 * expanded under the render-time rule (an include renders its
 * template one level deeper, and past depth 8 renders nothing).
 * Include targets are literal names and rendering is a pure tree
 * walk, so the spliced trees render exactly what the walk over
 * the unexpanded trees renders — without paying for the include
 * step on every page of a site.
 */
function expandTemplates(templates) {
  const memo = new Map();
  const expandNodes = (nodes, depth) => {
    const out = [];
    for (const n of nodes) {
      if (n.kind === 'include') {
        if (depth < INCLUDE_DEPTH) out.push(...expandTemplate(n.name, depth + 1));
      } else if (n.kind === 'for') out.push({ ...n, body: expandNodes(n.body, depth) });
      else if (n.kind === 'if') out.push({ ...n, then: expandNodes(n.then, depth), else: n.else === null ? null : expandNodes(n.else, depth) });
      else out.push(n);
    }
    return out;
  };
  const expandTemplate = (name, depth) => {
    const key = `${depth}:${name}`;
    let v = memo.get(key);
    if (v === undefined) {
      const nodes = templates.get(name);
      v = nodes === undefined ? [] : expandNodes(nodes, depth);
      memo.set(key, v);
    }
    return v;
  };
  const out = new Map();
  for (const name of templates.keys()) out.set(name, expandTemplate(name, 0));
  return out;
}

// ---------------------------------------------------------------- build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target[0];
  if (!((c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z'))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target[i];
    if (c === ':') return true;
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || isDigit(c) || c === '+' || c === '.' || c === '-')) return false;
  }
  return false;
}

/**
 * One site's output tree: path -> text, exactly makefun-site 1.0.0's
 * answer for `input`. The stages run in the reference's order:
 * sources, templates, front matter, permalinks, Markdown,
 * collections, tags, layouts, report.
 */
export function run(input) {
  // Slugs repeat across a site (tag names, headings, respelled
  // titles), and slugify is pure: memoise it for this build.
  const slugMemo = new Map();
  const slugOf = (text) => {
    let v = slugMemo.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugMemo.set(text, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const expanded = expandTemplates(templates);

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path, line ends made "\n"; a file
  // that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, in this
  // order of checks — parse, the generator's own directories, a
  // post with no date, a layout no template parses — and a draft is
  // reported and dropped last.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: a post's directory is posts/; a page's is its
  // source's directory. Slugs are made unique in the directory, in
  // source order; at the root, posts, tags and page are taken.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the page or static
  // file they name; a target that names neither is reported broken
  // and kept as written.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return `${hit.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // Collections: the posts, newest date first, equal dates by slug;
  // each post's newer is the one before it, its older the one after.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags by slug, each slug once in its own
  // order, a tag named as first met walking the posts in collection
  // order; tags ordered by count of posts, then slug. A page's tags
  // link to the tag of the same slug, or have url "" where no post
  // has that tag.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates see.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  // A source's card is read by its own page, by the index and tag
  // lists and by every page's "recent" list: build it once, on the
  // source, and share it (rendering only ever reads it).
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout; the index through
  // "index", per_page posts a page; each tag through "tag"; the
  // tags index through "tags". A missing template writes nothing.
  // Then each static file at its own path, unless a built page has
  // that path.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  // Every render shares one root scope (site, tags, recent); the
  // per-render values sit in a child scope, where the lookup finds
  // them first, exactly as it finds them in the merged scope.
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = expanded.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars, parent: rootScope }, expanded, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
