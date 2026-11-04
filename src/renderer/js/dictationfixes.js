/**
 * What speech engines get wrong: words they commonly mishear (whole words only,
 * case-insensitive; add a [pattern, replacement] pair to extend), and the "uh"s
 * and "um"s people say while thinking, which are left out. ("Uh-huh" stays.)
 */
const CORRECTIONS = [
  [/\bcloud\b/gi, 'Claude'],
  [/\bclouds\b/gi, 'Claudes'],
];

const FILLER = String.raw`(?<![\p{L}\p{N}'’-])(?:uh+m*|um+)(?![\p{L}\p{N}'’-])`;
// One or more in a row, with the punctuation that set them apart.
const FILLERS = new RegExp(String.raw`(,\s*)?(${FILLER}(?:[\s,]+${FILLER})*)(\s*[,.…!?]+)?`, 'giu');
const CAPITAL_NEXT = '\u0001';

function withoutFillers(text) {
  const out = text.replace(FILLERS, (_match, before = '', fillers, after = '', at, whole) => {
    const opens = !before && (at === 0 || /[.…!?]\s*$/.test(whole.slice(0, at)));
    const ends = /[.…!?]/.test(after);
    // A sentence that was nothing else goes; one it ended keeps its full stop.
    if (ends) return opens ? '' : after.trim();
    // At the start of a sentence, the next word takes its capital.
    if (opens) return /^\p{Lu}/u.test(fillers) ? CAPITAL_NEXT : '';
    return before || after.includes(',') ? ',' : '';
  });
  if (out === text) return text;
  return out
    .replace(new RegExp(`${CAPITAL_NEXT}\\s*(\\S)`, 'gu'), (_match, next) => next.toLocaleUpperCase())
    .replaceAll(CAPITAL_NEXT, '')
    .replace(/\s+([,.…!?])/g, '$1')
    .replace(/,+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function fixDictation(text) {
  return withoutFillers(CORRECTIONS.reduce((out, [pattern, word]) => out.replace(pattern, word), String(text || '')));
}
