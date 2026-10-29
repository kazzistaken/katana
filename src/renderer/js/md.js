import { el } from './util.js';

/**
 * Just enough Markdown for Claude's answers and the documents the viewer
 * shows: paragraphs, `code`, **bold**, *italic*, fenced code blocks, bullet
 * and numbered lists (nested by indent), headings, quotes, rules, tables
 * (kept as their monospace text) and [links](…) shown as their words.
 * Built as DOM nodes, never as HTML, so nothing a file says can run as markup.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))/g;

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
      out.push(el('pre', { class: 'md-pre', text: code.join('\n') }));
      continue;
    }
    // A table: its own monospace text lines up already.
    if (/^\s*\|/.test(line)) {
      endPara();
      endList();
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) rows.push(lines[i].trim());
      i -= 1;
      out.push(el('pre', { class: 'md-table', text: rows.filter((row) => !/^\|[\s:|-]+\|$/.test(row)).join('\n') }));
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
