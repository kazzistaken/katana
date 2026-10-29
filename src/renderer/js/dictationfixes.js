/**
 * Corrections for words speech engines commonly mishear. Whole words only,
 * case-insensitive; add a [pattern, replacement] pair to extend.
 */
const CORRECTIONS = [
  [/\bcloud\b/gi, 'Claude'],
  [/\bclouds\b/gi, 'Claudes'],
];

export function fixDictation(text) {
  return CORRECTIONS.reduce((out, [pattern, word]) => out.replace(pattern, word), String(text || ''));
}
