/* Markdown rendering for comment bodies and agent responses.
 *
 * Everything Markdown-related lives here: the renderer used by the comment
 * cards (renderMarkdown) and the plain-text reducer used by the collapsed
 * thread previews (stripMarkdown). No other module parses Markdown.
 *
 * Safety model — the reason this is hand-written rather than a library:
 * the source text is escaped with esc() before any markup is inserted, so
 * every '<' in a comment body is already '&lt;' by the time a rule runs.
 * The only HTML in the output is the tags this file emits, which means no
 * separate sanitizer is needed. The one value that flows from the source
 * into an attribute is a link href, and safeUrl() restricts that to http,
 * https and mailto — javascript: and data: never reach the DOM. The
 * server-highlighted fence tokens (renderMarkdown's `fences`) are the other
 * outside input: they come from comments.json, which is only semi-trusted,
 * so their text is esc()'d like everything else and a style string reaches
 * a style attribute only when it matches FENCE_STYLE_RE (see fenceHtml).
 *
 * Deliberately not supported, because comment bodies rarely need them and
 * each one costs more than it returns: setext headings, reference links,
 * HTML blocks, and block-level content (paragraphs, code fences)
 * nested inside a list item. A list item still accepts continuation lines.
 */

import { esc } from './dom.js';

/* ---------- placeholders ----------
 * Chunks that must survive later rules (code spans, links, code fences) are
 * lifted out and replaced by a token, then put back at the end. A token is
 * NUL + a letter + an index + NUL: NUL cannot appear in the source (normalize
 * strips it) and no Markdown rule matches it, so a token passes through
 * untouched. Each producer owns a letter: C code span, L link, F fence, and
 * I for whatever renderMarkdown's liftInline hook pulls out (the attachment
 * images that images.ts renders inline).
 */
const NUL = '\u0000';
const TOKEN_RE = /\u0000[CLFI](\d+)\u0000/g;

function hold(store, letter, html) {
  store.push(html);
  return NUL + letter + (store.length - 1) + NUL;
}

function restore(text, store) {
  return text.replace(TOKEN_RE, function (m, n) {
    const html = store[Number(n)];
    return html === undefined ? '' : html;
  });
}

/* ---------- inline ---------- */

// Schemes allowed in a link href. Tested against the escaped text, which is
// safe because esc() leaves ':' and '/' alone.
function safeUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

function linkHtml(url, inner) {
  return '<a href="' + url + '" target="_blank" rel="noopener">' + inner + '</a>';
}

// Bold, italic and strikethrough. Split out from inline() so link text can
// carry emphasis without re-running the link and code rules over it.
//
// The '_' forms require a non-word character on both sides so that
// snake_case identifiers — common in these comments — are left alone. The
// '*' forms carry no such guard, matching what most writers expect.
function emphasis(t) {
  return t
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__([^\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/~~([^\n]+?)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
}

// One line of Markdown to HTML: escape first, then lift out the spans that
// must not be reprocessed, then apply emphasis to what is left.
function inline(s, store) {
  let t = esc(String(s == null ? '' : s));

  t = t.replace(/`([^`\n]+)`/g, function (m, code) {
    return hold(store, 'C', '<code>' + code + '</code>');
  });

  t = t.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, text, url) {
    if (!safeUrl(url)) return m;
    return hold(store, 'L', linkHtml(url, emphasis(text)));
  });

  // Bare URLs. Runs after the [text](url) rule, whose output is already a
  // token by now, so an href can never be linkified a second time. The
  // trailing class stops before punctuation that usually ends the sentence
  // rather than the URL.
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,:;!?])/g, function (m, pre, url) {
    return pre + hold(store, 'L', linkHtml(url, url));
  });

  return emphasis(t);
}

/* ---------- blocks ---------- */

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n');
}

/* Style string of a stored fence token. Only the exact shapes the server's
 * styleAttr() (highlight.ts) emits — a hex color, optionally followed by the
 * three font flags in this order — may reach a style attribute; anything
 * else (url(), extra properties, ...) fails the match and the token renders
 * unstyled. */
const FENCE_STYLE_RE = /^color:#[0-9a-fA-F]{3,8}(;font-style:italic)?(;font-weight:bold)?(;text-decoration:underline)?$/;

// Inner HTML of one highlighted fence, built from the server-supplied tokens
// stored on the comment (see CommentFences in ../types.ts). Nothing is taken
// on faith: token text is esc()'d, a style is used only when it matches
// FENCE_STYLE_RE, and the token texts must reassemble exactly the fence's
// own lines — a mismatch (hand-edited comments.json, fences out of step with
// the body) returns null and the caller falls back to plain escaped text, so
// the highlighted view can never show different code than the source.
function fenceHtml(fence, bodyLines) {
  if (!fence || !Array.isArray(fence.lines) || fence.lines.length !== bodyLines.length) {
    return null;
  }
  const out = [];
  for (let i = 0; i < fence.lines.length; i++) {
    const tokens = fence.lines[i];
    if (!Array.isArray(tokens)) return null;
    let text = '';
    let html = '';
    for (let j = 0; j < tokens.length; j++) {
      const tok = tokens[j];
      if (!tok || typeof tok.t !== 'string') return null;
      text += tok.t;
      const span = esc(tok.t);
      html += typeof tok.s === 'string' && FENCE_STYLE_RE.test(tok.s)
        ? '<span style="' + tok.s + '">' + span + '</span>'
        : span;
    }
    if (text !== bodyLines[i]) return null;
    out.push(html);
  }
  return out.join('\n');
}

// Lift ``` fenced blocks out before the line parser runs, so their contents
// are never read as Markdown. An unclosed fence runs to the end of the text,
// which is what GitHub does too. The info string (```ts) is dropped here:
// the server already used it to pick the highlight language, and `fences`
// (when given) carries the resulting tokens for fence i — see fenceHtml.
function liftFences(src, store, fences) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let fenceIndex = 0;
  while (i < lines.length) {
    if (!/^\s*```/.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    i++;
    const body = [];
    while (i < lines.length && !/^\s*```/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++;
    const highlighted = fences ? fenceHtml(fences[fenceIndex], body) : null;
    fenceIndex++;
    out.push(hold(store, 'F', '<pre><code>' +
      (highlighted !== null ? highlighted : esc(body.join('\n'))) +
      '</code></pre>'));
  }
  return out;
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_TOKEN_RE = /^\u0000F\d+\u0000$/;
// GitHub-style task list item, tested against a list item's content.
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

/* ---------- tables ----------
 * GFM pipe tables. A '|' line becomes a header only when the line under it
 * is a delimiter row — cells of dashes with optional alignment colons and
 * at least one '|'. Without that second line, a '|' line stays ordinary
 * paragraph text. Body rows are the following lines that still contain a
 * '|'; a blank line or one without a pipe ends the table.
 */

// Sentinel for an escaped '\|' inside a cell: lifted out before the row is
// split on '|' and put back as a literal pipe. NUL-delimited like the
// placeholder tokens so it cannot occur in the source, but carrying no
// index, so TOKEN_RE never touches it.
const CELL_PIPE = '\u0000P\u0000';

// One row into trimmed cell strings. A leading or trailing '|' is
// decorative and dropped, as on GitHub.
function splitCells(line) {
  let t = line.trim().replace(/\\\|/g, CELL_PIPE);
  if (t.charAt(0) === '|') t = t.slice(1);
  if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
  return t.split('|').map(function (c) {
    return c.split(CELL_PIPE).join('|').trim();
  });
}

// Alignments of a delimiter row ('' left, 'center', 'right'), or null when
// the line is not one. The renderer turns the last two into md-center /
// md-right classes; left-aligned cells carry no class.
function tableAlign(line) {
  if (line.indexOf('|') === -1) return null;
  const cells = splitCells(line);
  const align = [];
  for (let i = 0; i < cells.length; i++) {
    const m = /^(:?)-+(:?)$/.exec(cells[i]);
    if (!m) return null;
    align.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : '');
  }
  return align;
}

// One <tr>. The header's cell count rules the row: missing cells render
// empty and extra ones are dropped, matching GitHub.
function tableRow(tag, cells, align, store) {
  let html = '<tr>';
  for (let i = 0; i < align.length; i++) {
    html += '<' + tag + (align[i] ? ' class="md-' + align[i] + '"' : '') + '>' +
      inline(cells[i] === undefined ? '' : cells[i], store) +
      '</' + tag + '>';
  }
  return html + '</tr>';
}

/**
 * Markdown to HTML, ready to drop into a comment card's `.body`.
 *
 * `liftInline` is an optional hook for a caller that has its own inline
 * syntax to render — images.ts uses it for the `[画像: <id>]` markers. It is
 * called once per line, AFTER code fences have been lifted out (so a marker
 * inside a fence stays literal) and BEFORE anything is parsed as Markdown,
 * with (line, hold); returning `hold(html)` swaps that span for a token that
 * survives parsing untouched and is put back verbatim at the end.
 *
 * `fences` is the comment's stored server-side fence highlighting (the
 * `fences` field of a ReviewComment / AgentResponse): one entry per ```
 * fence in source order, tokenized by Shiki at save time. A valid entry
 * colors that fence via fenceHtml; a null, missing or malformed one leaves
 * the fence as plain escaped text, exactly as without the argument.
 */
export function renderMarkdown(text, liftInline?, fences?) {
  const store = [];
  let lines = liftFences(normalize(text), store, fences);
  if (liftInline) {
    lines = lines.map(function (l) {
      return liftInline(l, function (html) { return hold(store, 'I', html); });
    });
  }

  let html = '';
  // Open <ul>/<ol> levels, outermost first. `indent` is the leading-space
  // width of the item that opened the level: a deeper indent opens a nested
  // level inside the current <li>, a shallower one closes back down to it.
  const stack = [];
  let itemOpen = false;
  let para = [];
  let quote = [];

  function flushPara() {
    if (!para.length) return;
    html += '<p>' + para.map(function (l) { return inline(l, store); }).join('<br>') + '</p>';
    para = [];
  }

  function flushQuote() {
    if (!quote.length) return;
    html += '<blockquote>' +
      quote.map(function (l) { return inline(l, store); }).join('<br>') +
      '</blockquote>';
    quote = [];
  }

  // Close one list level. This level's </li> comes first, then its </ul>;
  // the parent's <li> stays open, because a nested list always sits inside
  // one.
  function closeLevel() {
    if (itemOpen) html += '</li>';
    html += '</' + stack.pop().tag + '>';
    itemOpen = stack.length > 0;
  }

  function closeListsTo(indent) {
    while (stack.length && stack[stack.length - 1].indent > indent) closeLevel();
  }

  function closeLists() {
    while (stack.length) closeLevel();
    itemOpen = false;
  }

  function flushAll() {
    flushPara();
    flushQuote();
    closeLists();
  }

  function listItem(indent, tag, content) {
    closeListsTo(indent);
    const top = stack.length ? stack[stack.length - 1] : null;
    if (!top || indent > top.indent) {
      // Nest inside the current <li>, or start the block's first list.
      html += '<' + tag + '>';
      stack.push({ indent: indent, tag: tag });
      itemOpen = false;
    } else if (top.tag !== tag) {
      // Same depth, but the marker switched between bulleted and numbered:
      // close this level and reopen it as the other kind.
      closeLevel();
      html += '<' + tag + '>';
      stack.push({ indent: indent, tag: tag });
      itemOpen = false;
    } else if (itemOpen) {
      html += '</li>';
      itemOpen = false;
    }

    const task = TASK_RE.exec(content);
    if (task) {
      html += '<li class="task-item">' +
        '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ' +
        inline(task[2], store);
    } else {
      html += '<li>' + inline(content, store);
    }
    itemOpen = true;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (FENCE_TOKEN_RE.test(line.trim())) {
      flushAll();
      html += line.trim();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html += '<h' + level + '>' + inline(heading[2], store) + '</h' + level + '>';
      continue;
    }

    if (HR_RE.test(line)) {
      flushAll();
      html += '<hr>';
      continue;
    }

    // Table header candidate: needs the delimiter row under it with the
    // same number of cells. Anything short of that falls through to the
    // rules below, so a lone '|' line is still just paragraph text.
    if (line.indexOf('|') !== -1 && i + 1 < lines.length) {
      const align = tableAlign(lines[i + 1]);
      const head = align ? splitCells(line) : null;
      if (align && head && head.length === align.length) {
        flushAll();
        i++;
        let body = '';
        while (i + 1 < lines.length && lines[i + 1].indexOf('|') !== -1) {
          body += tableRow('td', splitCells(lines[i + 1]), align, store);
          i++;
        }
        html += '<table><thead>' + tableRow('th', head, align, store) + '</thead>' +
          '<tbody>' + body + '</tbody></table>';
        continue;
      }
    }

    const q = QUOTE_RE.exec(line);
    if (q) {
      flushPara();
      closeLists();
      quote.push(q[1]);
      continue;
    }
    flushQuote();

    const item = LIST_RE.exec(line);
    if (item) {
      flushPara();
      listItem(item[1].replace(/\t/g, '    ').length,
        /^\d/.test(item[2]) ? 'ol' : 'ul',
        item[3]);
      continue;
    }

    // A plain line while a list item is open continues that item instead of
    // starting a paragraph, so a wrapped bullet stays one bullet.
    if (itemOpen) {
      html += '<br>' + inline(line.trim(), store);
      continue;
    }

    closeLists();
    para.push(line);
  }

  flushAll();
  return restore(html, store);
}

/* ---------- plain text ---------- */

// Drop Markdown punctuation so a collapsed thread preview reads as prose
// instead of showing raw syntax. Approximate by design: the result is only
// ever truncated into a one-line label, never rendered as markup.
export function stripMarkdown(text) {
  return String(text == null ? '' : text)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^(?=.*\|)[ \t|:-]+$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, '$2')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2');
}
