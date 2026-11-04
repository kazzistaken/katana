/**
 * The question on a session's terminal, as data: what Claude Code (or Codex) has
 * drawn when it asks something, whatever kind of question it is (one of its own, a
 * permission, a plan to approve, "trust this folder?"). The chat shows it and presses
 * the keys for you (chatview.js). Pure, so scripts/test-promptmenu.mjs runs it.
 *
 * Returns null while nothing is being asked on the screen, else
 * { question, detail, selected, multi, options: [{ label, note, number, checked, free, quiet }] }.
 *   selected  which option the arrow is on
 *   checked   true or false when it can be ticked, else null
 *   free      choosing it means typing an answer
 *   quiet     set apart below a line ("Chat about this")
 */

const MARK = /^(\s*)[❯›>]\s+(?=\S)/;
const RULE = /^\s*[─━═╌-]{8,}\s*$/;
const NUMBERED = /^\s*(?:[❯›>]\s+)?(\d{1,2})[.)]\s+(\S.*)$/;
const CHECKBOX = /^\[([ xX✔✓×])\]\s*(.*)$/;
const FOOTER = /^\s*(?:enter to |esc to |tab\/arrow|tab to |ctrl[+-]|press |↑|↓|←|→)/i;
const TABS = /^\s*(?:←|☐|☒|✔|✓)\s/;
const FREE = /^(?:type something|other)\b/i;
const NOISE = /^\s*(?:security guide|learn more)\s*$/i;
const EARLIER = /^\s*(?:[❯›✻✶✽✢⎿▐▝▘]|\[\d+m)/; // your message, a spinner, its banner
const LISTED = /^\s*(?:[●•⚠→]|- )/;
const HINT_ROW = /^\s{30,}\S.*$/; // words pushed to the right, above the box (the effort setting)
const EMPTY_BOX =/^\s*[│|]?\s*[❯›>]\s*[│|]?\s*$/;

const lead = (line) => line.length - line.trimStart().length;
const nextFilled = (lines, from, step) => {
  for (let i = from; i >= 0 && i < lines.length; i += step) if (lines[i].trim()) return lines[i];
  return '';
};

/** A line with the arrow on it, not in the session's own input box. */
function findArrow(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 34); i -= 1) {
    const line = lines[i];
    if (EMPTY_BOX.test(line)) return -1;
    if (!MARK.test(line)) continue;
    // Between two lines: that's what's being typed, and nothing is being asked.
    if (RULE.test(nextFilled(lines, i - 1, -1)) && RULE.test(nextFilled(lines, i + 1, 1))) return -1;
    return i;
  }
  return -1;
}

export function parsePromptMenu(screen) {
  // (A line right across the screen can run on into the next row when it's read: they're two.)
  const lines = String(screen || '')
    .split('\n')
    .flatMap((line) => {
      const joined = /^(\s*[─━═╌]{8,})(?=[^─━═╌\s])(.*)$/.exec(line);
      return joined ? [joined[1], joined[2]] : [line];
    })
    .map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const arrow = findArrow(lines);
  if (arrow < 0) return null;

  const at = MARK.exec(lines[arrow])[1].length;
  const numbered = NUMBERED.test(lines[arrow]);
  // Where an unnumbered option starts: under the arrow's words.
  const column = at + 2;

  // Up to the block's first option.
  let first = arrow;
  for (let i = arrow - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (RULE.test(line)) continue;
    const isOption = numbered ? NUMBERED.test(line) : lead(line) === column;
    if (isOption) first = i;
    else if (lead(line) <= at) break;
  }

  // Down from there: options, their notes, and what's set apart below a line.
  const options = [];
  let selected = -1;
  let quiet = false;
  let hasBoxes = false;
  let labelColumn = column;
  for (let i = first; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      // (A blank line can sit before a line and its option; anything else ends the block.)
      if (RULE.test(nextFilled(lines, i + 1, 1))) continue;
      break;
    }
    if (FOOTER.test(line)) break;
    if (RULE.test(line)) {
      if (options.length) quiet = true;
      continue;
    }
    const number = NUMBERED.exec(line);
    const isArrow = MARK.test(line);
    let option = null;
    if (number && (numbered || isArrow)) {
      const box = CHECKBOX.exec(number[2]);
      if (box) hasBoxes = true;
      option = { label: (box ? box[2] : number[2]).trim(), note: '', number: Number(number[1]), checked: box ? box[1] !== ' ' : null, free: false, quiet };
      labelColumn = line.indexOf(number[2]);
    } else if (!numbered && (isArrow || lead(line) === column)) {
      option = { label: line.replace(MARK, '').trim(), note: '', number: 0, checked: null, free: false, quiet };
    } else if (numbered && hasBoxes && lead(line) === labelColumn && lead(line) < labelColumn + 2) {
      // Ticking boxes: "Next", under the numbers, moves on.
      option = { label: line.trim(), note: '', number: 0, checked: null, free: false, quiet };
    } else if (options.length && lead(line) > at) {
      const last = options.at(-1);
      // (A note that only repeats the option says nothing.)
      if (line.trim() !== last.label) last.note = `${last.note} ${line.trim()}`.trim();
      continue;
    } else break;
    option.free = FREE.test(option.label);
    if (isArrow) selected = options.length;
    options.push(option);
  }
  if (options.length < 2 || selected < 0) return null;
  // Without numbers it's only a menu if it says how to use it (your own message above looks just like one).
  if (!numbered && !lines.slice(first).some((line) => FOOTER.test(line))) return null;

  // What it asks: the paragraph above, and what comes before that up to the line at its top.
  const above = [];
  for (let i = first - 1; i >= Math.max(0, first - 24); i -= 1) {
    // (Not every question has a line at its top: what the session printed before it stays out too.)
    if (RULE.test(lines[i]) || EARLIER.test(lines[i])) break;
    above.unshift(lines[i]);
  }
  const body = above.filter((line) => !NOISE.test(line) && !TABS.test(line));
  while (body.length && !body.at(-1).trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  const blank = body.reduce((found, line, i) => (line.trim() ? found : i), -1);
  // In the last paragraph, a list ("● Size → Large") belongs with the detail: the question is the words after it.
  let cut = blank;
  body.forEach((line, i) => {
    if (i > blank && i < body.length - 1 && LISTED.test(line)) cut = i;
  });
  const question = body.slice(cut + 1).map((line) => line.trim()).join(' ').trim();
  const detail = body
    .slice(0, Math.max(0, cut === blank ? cut : cut + 1))
    .join('\n')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/^ +/gm, (spaces) => spaces.slice(0, Math.max(0, spaces.length - 1)))
    .trim();
  return { question, detail, selected, multi: hasBoxes, options };
}

/**
 * Which of a terminal's rows hold the session's own input box, from the lines above
 * its arrow to the last words under it (its hints): [first, last], or null.
 */
export function inputBoxRows(rows) {
  let last = rows.length - 1;
  while (last >= 0 && !rows[last].trim()) last -= 1;
  for (let i = last; i >= Math.max(0, last - 8); i -= 1) {
    if (!/^\s*[│|]?\s*[❯›>]/.test(rows[i]) || /^\s*[❯›>]\s+\d{1,2}[.)]\s/.test(rows[i])) continue;
    const isEdge = (row) => /^\s*[─━╭┌-][─━-]{7,}/.test(row || '');
    if (!isEdge(rows[i - 1])) return null;
    let first = i - 1;
    while (first > 0 && (isEdge(rows[first - 1]) || HINT_ROW.test(rows[first - 1]))) first -= 1;
    return [first, last];
  }
  return null;
}

/** The keys that move the arrow from one option to another, one at a time. */
export function arrowKeys(from, to) {
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? '\x1b[B' : '\x1b[A'));
}
