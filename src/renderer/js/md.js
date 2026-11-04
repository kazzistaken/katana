import { el, icons } from './util.js';

/**
 * Just enough Markdown for Claude's answers and the documents the viewer
 * shows: paragraphs, `code`, **bold**, *italic*, fenced code blocks, bullet
 * and numbered lists (nested by indent), headings, quotes, rules, tables
 * and [links](…) shown as their words.
 * Built as DOM nodes, never as HTML, so nothing a file says can run as markup.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))/g;

/** A text box's top right corner: copy it, or save it as a .md file (icons only). */
function blockActions(text) {
  const copy = el('button', {
    type: 'button',
    title: 'Copy',
    'aria-label': 'Copy',
    html: icons.copy,
    onclick: async () => {
      await navigator.clipboard.writeText(text);
      copy.innerHTML = icons.check;
      clearTimeout(copy._reset);
      copy._reset = setTimeout(() => {
        copy.innerHTML = icons.copy;
      }, 1500);
    },
  });
  const save = el('button', {
    type: 'button',
    title: 'Download as .md',
    'aria-label': 'Download as .md',
    html: icons.download,
    onclick: () => {
      // Named after its first line; the save dialog can change that.
      const first = text.split('\n').find((line) => line.trim()) || '';
      const name = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'text';
      window.api.file.saveText(`${name}.md`, `${text}\n`);
    },
  });
  return el('span', { class: 'md-pre-actions' }, copy, save);
}

/** One line's inline marks as nodes. */
export function inline(text) {
  return String(text || '')
    .split(INLINE)
    .filter((part) => part !== '' && part !== undefined)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return el('code', { class: 'md-code', text: part.slice(1, -1) });
      if (/^\*\*[^*]+\*\*$/.test(part)) return el('b', { text: part.slice(2, -2) });
      if (/^\*[^*]+\*$/.test(part)) return el('em', { text: part.slice(1, -1) });
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) return el('span', { class: 'md-link', title: link[2], text: link[1] });
      return document.createTextNode(part);
    });
}

/** The words without their marks (a title, a headline that must stay plain). */
export const plainText = (text) =>
  String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/, '');

/** A table's lines (| a | b |) as a table, with a header if the second line is the |---| kind. */
function table(rows) {
  const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const rule = (row) => /^\s*\|[\s:|-]+\|\s*$/.test(row) && row.includes('-');
  const headed = rows.length > 1 && rule(rows[1]);
  const aligns = headed ? cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '')) : [];
  const line = (row, tag) =>
    el(
      'tr',
      {},
      cells(row).map((cell, i) => el(tag, { style: aligns[i] ? `text-align:${aligns[i]}` : null }, inline(cell)))
    );
  const body = rows.filter((row, i) => !rule(row) && !(headed && i === 0));
  return el(
    'div',
    { class: 'md-table-wrap' },
    el('table', { class: 'md-table' }, headed ? el('thead', {}, line(rows[0], 'th')) : null, el('tbody', {}, body.map((row) => line(row, 'td'))))
  );
}

/** Blocks of text as nodes. */
export function blocks(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  // Open lists, outermost first: { node, indent }.
  let lists = [];
  const endPara = () => {
    if (para.length) out.push(el('p', {}, inline(para.join(' '))));
    para = [];
  };
  const endList = () => {
    if (lists.length) out.push(lists[0].node);
    lists = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      endPara();
      endList();
      const code = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) code.push(lines[i]);
      // (The buttons float in the corner, so the first lines wrap around them and nothing sits under them.)
      out.push(el('pre', { class: 'md-pre' }, blockActions(code.join('\n')), code.join('\n')));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      endPara();
      endList();
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) rows.push(lines[i].trim());
      i -= 1;
      out.push(table(rows));
      continue;
    }
    // (Before bullets: "* * *" and "- - -" are rules, not lists.)
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      endList();
      out.push(el('hr', { class: 'md-rule' }));
      continue;
    }
    const bullet = line.match(/^(\s*)(?:[-*+•]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      endPara();
      const indent = bullet[1].replace(/\t/g, '  ').length;
      const tag = bullet[2] ? 'ol' : 'ul';
      while (lists.length && indent < lists.at(-1).indent) lists.pop();
      const top = lists.at(-1);
      if (!top || indent > top.indent) {
        const node = el(tag, { class: 'md-list' });
        if (top) (top.node.lastElementChild || top.node).append(node);
        lists.push({ node, indent });
      } else if (top.node.tagName.toLowerCase() !== tag && lists.length === 1) {
        endList();
        lists.push({ node: el(tag, { class: 'md-list' }), indent });
      }
      lists.at(-1).node.append(el('li', {}, inline(bullet[3])));
      continue;
    }
    // A wrapped list item: its next line, indented under it.
    if (lists.length && /^\s{2,}\S/.test(line)) {
      lists.at(-1).node.lastElementChild?.append(' ', ...inline(line.trim()));
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      endPara();
      endList();
      out.push(el('p', { class: `md-heading is-h${heading[1].length}` }, inline(heading[2].replace(/\s+#+\s*$/, ''))));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      endList();
      out.push(el('hr', { class: 'md-rule' }));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      endPara();
      endList();
      const said = [quote[1]];
      for (i += 1; i < lines.length && /^\s*>/.test(lines[i]); i += 1) said.push(lines[i].replace(/^\s*>\s?/, ''));
      i -= 1;
      out.push(el('blockquote', { class: 'md-quote' }, inline(said.join(' '))));
      continue;
    }
    if (!line.trim()) {
      endPara();
      // A loose list (blank lines between its items) is still one list.
      const after = lines.slice(i + 1).find((next) => next.trim());
      if (!(lists.length && after && /^\s*(?:[-*+•]|\d+[.)])\s+/.test(after))) endList();
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endPara();
  endList();
  return out;
}
