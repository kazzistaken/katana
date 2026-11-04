/**
 * What the live engine (main preview.js) heard of each phrase being dictated. It's
 * rough, so it's never shown: it's kept in case hearing the phrase properly fails,
 * when rough words are better than losing what you said. Pure, so
 * scripts/test-dictationphrases.mjs runs it under Node.
 */

export function createPhrases() {
  let current = null; // the phrase being spoken
  let hearing = ''; // what the live engine has so far of what it's hearing now

  return {
    /** A voice started. */
    begin() {
      // (A long phrase cut in two mid-sentence: the live engine is still on the same sentence.)
      if (!current) current = { heard: '', hearing: '', from: hearing };
      return current;
    },
    /** The live engine's words so far (cumulative); `settled`: it's done with what it was hearing. */
    live(text, settled = false) {
      let words = String(text || '');
      if (current?.from && words.startsWith(current.from)) words = words.slice(current.from.length).trimStart();
      if (settled) {
        hearing = '';
        if (current) {
          current.from = '';
          current.heard = [current.heard, words].filter(Boolean).join(' ');
          current.hearing = '';
        }
      } else {
        hearing = String(text || '');
        if (current) current.hearing = words;
      }
    },
    /** The pause: this phrase is finished being said. */
    end() {
      const phrase = current;
      current = null;
      return phrase;
    },
    /** The rough words of a phrase. */
    rough: (phrase) => (phrase ? [phrase.heard, phrase.hearing].filter(Boolean).join(' ') : ''),
  };
}
