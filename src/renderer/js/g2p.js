/**
 * English text as phonemes, for her lips (lipsync.js): small and rough,
 * no dictionary to load. What matters for a mouth is the vowels, where the
 * lips close and how many syllables, not voicing (p and b, s and z look the
 * same), so this is a compact rule set (in the style of the NRL
 * letter-to-sound rules) with a short list of common words it would get
 * wrong, plus numbers, letters and contractions.
 *
 * Phonemes are ARPAbet (CMUdict's): vowels carry a stress digit (AE1
 * stressed, AH0 not). textPhones(text) gives each word with where it is in
 * the text, its phonemes, and the pause after it (punctuation).
 */

export const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
export const isVowel = (p) => VOWELS.has(p.replace(/\d$/, ''));
export const bare = (p) => p.replace(/\d$/, '');

/* ------------------------------ common words ------------------------------ */

// Words the rules miss (and the commonest, said as they are in running speech).
const WORDS_TEXT = `
a AH0|about AH0 B AW1 T|above AH0 B AH1 V|actually AE1 K CH UW0 AH0 L IY0|after AE1 F T ER0|again AH0 G EH1 N|against AH0 G EH1 N S T|ago AH0 G OW1|all AO1 L|almost AO1 L M OW2 S T|already AO0 L R EH1 D IY0|also AO1 L S OW0|although AO2 L DH OW1|always AO1 L W EY2 Z|am AE1 M|among AH0 M AH1 NG|an AH0 N|and AH0 N D|another AH0 N AH1 DH ER0|answer AE1 N S ER0|any EH1 N IY0|anyone EH1 N IY0 W AH2 N|anything EH1 N IY0 TH IH2 NG|app AE1 P|are AA1 R|area EH1 R IY0 AH0|around ER0 AW1 N D|as AE1 Z|ask AE1 S K|at AE1 T|away AH0 W EY1
beautiful B Y UW1 T AH0 F AH0 L|back B AE1 K|be B IY1|because B IH0 K AH1 Z|been B IH1 N|before B IH0 F AO1 R|being B IY1 IH0 NG|both B OW1 TH|bought B AO1 T|brother B R AH1 DH ER0|brought B R AO1 T|build B IH1 L D|built B IH1 L T|busy B IH1 Z IY0|business B IH1 Z N AH0 S|but B AH1 T|buy B AY1|by B AY1
call K AO1 L|can K AE1 N|can't K AE1 N T|cannot K AE1 N AA0 T|change CH EY1 N JH|check CH EH1 K|claude K L AO1 D|close K L OW1 Z|code K OW1 D|come K AH1 M|coming K AH1 M IH0 NG|could K UH1 D|couldn't K UH1 D AH0 N T
data D EY1 T AH0|day D EY1|did D IH1 D|didn't D IH1 D AH0 N T|do D UW1|does D AH1 Z|doesn't D AH1 Z AH0 N T|doing D UW1 IH0 NG|don't D OW1 N T|done D AH1 N|down D AW1 N
each IY1 CH|early ER1 L IY0|easy IY1 Z IY0|eight EY1 T|eighty EY1 T IY0|eleven IH0 L EH1 V AH0 N|else EH1 L S|enough IH0 N AH1 F|error EH1 R ER0|even IY1 V IH0 N|ever EH1 V ER0|every EH1 V R IY0|everyone EH1 V R IY0 W AH2 N|everything EH1 V R IY0 TH IH2 NG|eye AY1|eyes AY1 Z
father F AA1 DH ER0|few F Y UW1|fifteen F IH0 F T IY1 N|fifty F IH1 F T IY0|file F AY1 L|files F AY1 L Z|fine F AY1 N|first F ER1 S T|five F AY1 V|for F AO1 R|forty F AO1 R T IY0|four F AO1 R|friend F R EH1 N D|from F R AH1 M
get G EH1 T|getting G EH1 T IH0 NG|give G IH1 V|given G IH1 V AH0 N|go G OW1|goes G OW1 Z|going G OW1 IH0 NG|gone G AO1 N|good G UH1 D|great G R EY1 T|guess G EH1 S
had HH AE1 D|has HH AE1 Z|have HH AE1 V|having HH AE1 V IH0 NG|he HH IY1|heard HH ER1 D|hello HH AH0 L OW1|her HH ER1|here HH IY1 R|hey HH EY1|hi HH AY1|him HH IH1 M|his HH IH1 Z|hour AW1 ER0|hours AW1 ER0 Z|how HH AW1|hundred HH AH1 N D R AH0 D
i AY1|i'd AY1 D|i'll AY1 L|i'm AY1 M|i've AY1 V|idea AY0 D IY1 AH0|if IH1 F|in IH0 N|into IH1 N T UW0|is IH1 Z|isn't IH1 Z AH0 N T|it IH1 T|it's IH1 T S|its IH1 T S
just JH AH1 S T
katana K AH0 T AA1 N AH0|key K IY1|keys K IY1 Z|know N OW1|knew N UW1
last L AE1 S T|later L EY1 T ER0|laugh L AE1 F|learn L ER1 N|let's L EH1 T S|like L AY1 K|little L IH1 T AH0 L|live L IH1 V|look L UH1 K|lose L UW1 Z|love L AH1 V
made M EY1 D|make M EY1 K|many M EH1 N IY0|may M EY1|maybe M EY1 B IY0|me M IY1|mean M IY1 N|might M AY1 T|million M IH1 L Y AH0 N|minute M IH1 N AH0 T|minutes M IH1 N AH0 T S|money M AH1 N IY0|more M AO1 R|most M OW1 S T|mother M AH1 DH ER0|move M UW1 V|much M AH1 CH|must M AH1 S T|my M AY1
need N IY1 D|never N EH1 V ER0|new N UW1|next N EH1 K S T|nine N AY1 N|ninety N AY1 N T IY0|no N OW1|none N AH1 N|not N AA1 T|nothing N AH1 TH IH0 NG|now N AW1|number N AH1 M B ER0
of AH0 V|off AO1 F|oh OW1|ok OW2 K EY1|okay OW2 K EY1|old OW1 L D|on AA1 N|once W AH1 N S|one W AH1 N|only OW1 N L IY0|open OW1 P AH0 N|or AO1 R|other AH1 DH ER0|our AW1 ER0|out AW1 T|over OW1 V ER0|own OW1 N
people P IY1 P AH0 L|percent P ER0 S EH1 N T|please P L IY1 Z|pretty P R IH1 T IY0|probably P R AA1 B AH0 B L IY0|put P UH1 T
question K W EH1 S CH AH0 N|quiet K W AY1 AH0 T|quite K W AY1 T
read R IY1 D|ready R EH1 D IY0|really R IH1 L IY0|right R AY1 T
said S EH1 D|says S EH1 Z|second S EH1 K AH0 N D|seven S EH1 V AH0 N|seventy S EH1 V AH0 N T IY0|she SH IY1|should SH UH1 D|shouldn't SH UH1 D AH0 N T|since S IH1 N S|six S IH1 K S|sixty S IH1 K S T IY0|so S OW1|some S AH1 M|someone S AH1 M W AH2 N|something S AH1 M TH IH0 NG|sorry S AA1 R IY0|start S T AA1 R T|still S T IH1 L|sure SH UH1 R
task T AE1 S K|tasks T AE1 S K S|ten T EH1 N|than DH AE1 N|thank TH AE1 NG K|thanks TH AE1 NG K S|that DH AE1 T|that's DH AE1 T S|the DH AH0|their DH EH1 R|them DH EH1 M|then DH EH1 N|there DH EH1 R|there's DH EH1 R Z|these DH IY1 Z|they DH EY1|they're DH EH1 R|thing TH IH1 NG|things TH IH1 NG Z|think TH IH1 NG K|thirty TH ER1 T IY0|this DH IH1 S|those DH OW1 Z|though DH OW1|thought TH AO1 T|thousand TH AW1 Z AH0 N D|three TH R IY1|through TH R UW1|to T UW0|today T AH0 D EY1|together T AH0 G EH1 DH ER0|tomorrow T AH0 M AA1 R OW2|too T UW1|tough T AH1 F|twelve T W EH1 L V|twenty T W EH1 N T IY0|two T UW1
under AH1 N D ER0|until AH0 N T IH1 L|up AH1 P|upon AH0 P AA1 N|us AH1 S|use Y UW1 Z|used Y UW1 Z D|user Y UW1 Z ER0|users Y UW1 Z ER0 Z
very V EH1 R IY0
want W AA1 N T|wants W AA1 N T S|was W AH0 Z|wasn't W AA1 Z AH0 N T|water W AO1 T ER0|way W EY1|we W IY1|we're W IH1 R|we've W IY1 V|well W EH1 L|went W EH1 N T|were W ER1|what W AH1 T|what's W AH1 T S|when W EH1 N|where W EH1 R|which W IH1 CH|while W AY1 L|who HH UW1|whole HH OW1 L|whom HH UW1 M|whose HH UW1 Z|why W AY1|will W IH1 L|with W IH1 DH|without W IH0 TH AW1 T|woman W UH1 M AH0 N|women W IH1 M AH0 N|won't W OW1 N T|word W ER1 D|work W ER1 K|working W ER1 K IH0 NG|world W ER1 L D|would W UH1 D|wouldn't W UH1 D AH0 N T
yeah Y AE1|year Y IH1 R|yes Y EH1 S|yesterday Y EH1 S T ER0 D EY2|yet Y EH1 T|you Y UW1|you'll Y UW1 L|you're Y UH1 R|you've Y UW1 V|young Y AH1 NG|your Y AO1 R|yours Y AO1 R Z
zero Z IH1 R OW0`;

const WORDS = new Map();
for (const entry of WORDS_TEXT.split(/[|\n]/)) {
  const [word, ...phones] = entry.trim().split(/\s+/);
  if (word) WORDS.set(word, phones);
}

/* ------------------------------ letters to sounds ------------------------------ */

// Each rule: left context [letters] right context = phonemes. In the contexts:
//   #  one or more vowels      :  zero or more consonants   ^  one consonant
//   +  e, i or y               .  a voiced consonant         %  an ending (e, es, ed, er, ing, ely)
//   a space is the word's edge; anything else is itself (a regex: | and ( ) work).
const RULES_TEXT = {
  a: `[a]tion=EY|[a] =AH| [are] =AA R| [ar]o=AH R|[ar]#=EH R| ^[as]#=EY S|[a]wa=AH|[aw]=AO| :[any]=EH N IY|[again]=AH G EH N|#:[ally]=AH L IY| [al]#=AH L|#:[ag]e=IH JH|[a]^%=EY|[a]^e=EY|[aigh]=EY|[ai]=EY|[ay]=EY|[augh]=AO|[au]=AO|#:[al] =AH L|#:[als] =AH L Z|[alk]=AO K|[all]=AO L|[al]^=AO L| :[able]=EY B AH L|[able]=AH B AH L|[ange]=EY N JH|[air]=EH R|[ar]=AA R|[a]=AE`,
  b: ` [be]^#=B IH|[b]=B`,
  c: ` [ch]^=K|^e[ch]=K|[ch]=CH| s[ci]#=S AY|[ci]a=SH|[ci]o=SH|[ci]en=SH|[cc]+=K S|[ck]=K|[c]+=S|[c]=K`,
  d: ` [de]^#=D IH|[dge]=JH|[du]a=JH UW|[d]=D`,
  e: `#:(t|d)[ed] =IH D|#:[ed] =D|#:(s|z|x|ch|sh|c|g)[es] =IH Z|#:[es] =Z|#:[ely] =L IY|#:[ement]=M AH N T|#:[e] =| :[e] =IY|[eigh]=EY|[eau]=OW|[eu]=Y UW|[ew]=Y UW|[ee]=IY|[ear]^=ER|[ear]=IH R|[ea]=IY|[ei]=IY|[ey]=IY|[er]#=EH R|[er]=ER|[e]^e =IY|[e]^es =IY| [ex]#=IH G Z| [re]^#=R IH|[e]=EH`,
  f: `[f]=F`,
  g: ` [gn]=N|[gn] =N| [gh]=G|[gh]=|[ge]t=G EH| [gi]v=G IH|[gg]=G|[g]+=JH|[g]=G`,
  h: `[h]#=HH|[h]=`,
  i: ` [in]=IH N| [i] =AY|[ind] =AY N D|[ier]=IY ER|#:r[ied] =IY D|[ied] =AY D|[ien]=IY EH N|[ie]t=AY EH|[igh]=AY|[ild]=AY L D|[ign] =AY N|[ign]^=AY N|[ique]=IY K|[i]^%=AY|[i]^e=AY|[ir]#=AY R|[ir]=ER|[iz]%=AY Z|[ion]=Y AH N|[i]=IH`,
  j: `[j]=JH`,
  k: ` [k]n=|[k]=K`,
  l: `[lo]c#=L OW|#:^[le] =AH L|[l]=L`,
  m: `[m]=M`,
  n: `[ng]=NG|[nk]=NG K|[n]=N`,
  o: `[of] =AH V|#:[or] =ER|#:[ors] =ER Z|[ought]=AO T|[ough]=AH F|[ould]=UH D|(h| )[our]=AW ER|[our]=AO R|[ou]=AW|(d|t|br|cr|cl|fr|g)[ow]n=AW|(h|n|c|w|v)[ow] =AW|[ow]=OW|[oa]=OW|[oi]=OY|[oy]=OY|[ook]=UH K|[ood]=UH D|[oor]=AO R|[oo]=UW|[or]=AO R|[ov]=AH V|[o]^%=OW|[o]^e=OW|[o]e=OW|[o] =OW|[ong]=AO NG|[o]=AA`,
  p: `[ph]=F|[peop]=P IY P|[p]=P`,
  q: `[quar]=K W AO R|[qu]=K W|[q]=K`,
  r: `[rh]=R|[r]=R`,
  s: `[sch]=S K|[sh]=SH|[ssion]=SH AH N|#[sion]=ZH AH N|[sion]=SH AH N|[sure]=SH UH R|#[sur]#=ZH ER|[s]=S`,
  t: `[tch]=CH|[th]=TH|s[ti]#n=CH|[tion]=SH AH N|[ti]o=SH|[ti]a=SH|[tien]=SH AH N|[tur]#=CH ER|[tu]a=CH UW|[t]=T`,
  u: ` [un]i=Y UW N| [un]=AH N|(t|s|r|d)[ur]#=UH R|[ur]#=Y UH R|[ur]=ER|[uy]=AY| g[u]#=| g[u]%=|g[u]#=W|[ue]=UW|[ui]=UW|[u]^ =AH|[u]^^=AH|[u]^%=UW|[u]^#=UW|[u]=AH`,
  v: `[view]=V Y UW|[v]=V`,
  w: `[wa]s=W AA|[wa]t=W AA|[war]=W AO R|[wor]^=W ER|[wr]=R|[who]=HH UW|[wh]=W|[w]=W`,
  x: ` [x]=Z|[x]=K S`,
  y: ` [y]#=Y|#:^[y] =IY|#:^[y]i=IY| :[y] =AY| :[y]#=AY|[y]=IH`,
  z: `[z]=Z`,
};

const CONS = '[bcdfghjklmnpqrstvwxz]';
const SYMBOLS = { '#': '[aeiouy]+', ':': `${CONS}*`, '^': CONS, '+': '[eiy]', '.': '[bdvgjlmnrwz]', '%': '(er|es|ed|ely|ing|e) ' };
const context = (text) => text.replace(/[#:^+.%]/g, (c) => SYMBOLS[c]);

const RULES = {};
// Rules split on | outside of ( ): rebuilt so a context's (a|b) stays whole.
for (const [letter, text] of Object.entries(RULES_TEXT)) {
  const list = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '|' && !depth) {
      list.push(cur);
      cur = '';
    } else cur += ch;
  }
  list.push(cur);
  RULES[letter] = list.map((rule) => {
    const m = /^(.*)\[(.+)\](.*)=(.*)$/.exec(rule);
    if (!m) throw new Error(`bad rule ${rule}`);
    return { left: m[1] ? new RegExp(`${context(m[1])}$`) : null, match: m[2], right: m[3] ? new RegExp(`^${context(m[3])}`) : null, phones: m[4].trim() ? m[4].trim().split(/\s+/) : [] };
  });
}

/** A word by the rules: its phonemes, unstressed (no digits yet). */
function byRules(word) {
  const w = ` ${word} `;
  const out = [];
  for (let i = 1; i < w.length - 1; ) {
    const rules = RULES[w[i]];
    if (!rules) {
      i += 1;
      continue;
    }
    let done = false;
    for (const r of rules) {
      if (w.startsWith(r.match, i) === false) continue;
      if (r.left && !r.left.test(w.slice(0, i))) continue;
      if (r.right && !r.right.test(w.slice(i + r.match.length))) continue;
      for (const p of r.phones) if (out.at(-1) !== p || isVowel(p)) out.push(p); // a doubled letter is one sound
      i += r.match.length;
      done = true;
      break;
    }
    if (!done) i += 1;
  }
  return out;
}

const PREFIXES = /^(be|de|re|pre|con|com|ex|per)(?=[bcdfghjklmnpqrstvwxz])/;

/** Stress for a word the rules made: its main syllable's vowel 1, the rest 0. */
function stress(word, phones) {
  const vowels = phones.map((p, i) => (VOWELS.has(p) ? i : -1)).filter((i) => i >= 0);
  if (!vowels.length) return phones;
  let main = 0;
  if (vowels.length > 1) {
    if (/(tion|sion|cian|tial|cial|ious|eous)s?$/.test(word)) main = vowels.length - 2;
    else if (/(ic|ical|ics)$/.test(word)) main = vowels.length - 2;
    else if (/(ity|ify|ible|ogy|ography)$/.test(word) && vowels.length > 2) main = vowels.length - 3;
    else if (PREFIXES.test(word) && vowels.length > 1 && !/(ing|ed|er|ly|es|s)$/.test(word)) main = 1;
    else if (PREFIXES.test(word) && vowels.length > 2) main = 1;
  }
  main = Math.max(0, Math.min(vowels.length - 1, main));
  return phones.map((p, i) => (VOWELS.has(p) ? `${p}${i === vowels[main] ? 1 : 0}` : p));
}

const SIBILANT = new Set(['S', 'Z', 'SH', 'ZH', 'CH', 'JH']);
// Endings a known word can take: [ending, how to rebuild the stem, the ending's phonemes given the stem's last phoneme].
const ENDINGS = [
  ["n't", (s) => [s], () => ['AH0', 'N', 'T']],
  ["'s", (s) => [s], (last) => (SIBILANT.has(last) ? ['IH0', 'Z'] : ['Z'])],
  ["'ll", (s) => [s], () => ['L']],
  ["'re", (s) => [s], () => ['R']],
  ["'ve", (s) => [s], () => ['V']],
  ["'d", (s) => [s], () => ['D']],
  ['ing', (s) => [s, `${s}e`, s.replace(/(.)\1$/, '$1')], () => ['IH0', 'NG']],
  ['ed', (s) => [s, `${s}e`, s.replace(/(.)\1$/, '$1')], (last) => (last === 'T' || last === 'D' ? ['IH0', 'D'] : ['D'])],
  ['es', (s) => [s], () => ['IH0', 'Z']],
  ['s', (s) => [s], (last) => (SIBILANT.has(last) ? ['IH0', 'Z'] : ['Z'])],
  ['ly', (s) => [s, `${s}le`], () => ['L', 'IY0']],
  ['er', (s) => [s, `${s}e`, s.replace(/(.)\1$/, '$1')], () => ['ER0']],
  ['est', (s) => [s, `${s}e`], () => ['IH0', 'S', 'T']],
];

const LETTER_NAMES = {
  a: 'EY1', b: 'B IY1', c: 'S IY1', d: 'D IY1', e: 'IY1', f: 'EH1 F', g: 'JH IY1', h: 'EY1 CH', i: 'AY1', j: 'JH EY1', k: 'K EY1', l: 'EH1 L', m: 'EH1 M',
  n: 'EH1 N', o: 'OW1', p: 'P IY1', q: 'K Y UW1', r: 'AA1 R', s: 'EH1 S', t: 'T IY1', u: 'Y UW1', v: 'V IY1', w: 'D AH1 B AH0 L Y UW0', x: 'EH1 K S', y: 'W AY1', z: 'Z IY1',
};
/** A word spelled out (API, npm). */
const spell = (word) => [...word.toLowerCase()].flatMap((c) => (LETTER_NAMES[c] || '').split(' ').filter(Boolean));

/** One word's phonemes (with stress). */
export function wordPhones(raw) {
  const word = String(raw || '').toLowerCase().replace(/[’‘]/g, "'").replace(/^'+|'+$/g, '');
  if (!word) return [];
  if (WORDS.has(word)) return WORDS.get(word);
  // Initials and code words with no vowel are said as letters.
  if (/^[A-Z]{2,5}s?$/.test(raw) && !WORDS.has(word)) return spell(raw.replace(/s$/, ''));
  if (!/[aeiouy]/.test(word)) return spell(word);
  for (const [end, stems, tail] of ENDINGS) {
    if (!word.endsWith(end) || word.length - end.length < 2) continue;
    for (const stem of stems(word.slice(0, -end.length))) {
      if (WORDS.has(stem)) {
        const base = WORDS.get(stem);
        return [...base, ...tail(base.at(-1))];
      }
    }
  }
  return stress(word.replace(/'/g, ''), byRules(word.replace(/'/g, '')));
}

/* ------------------------------ numbers ------------------------------ */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** A whole number in words ("one hundred twenty three"); past a billion, digit by digit. */
export function numberWords(n) {
  if (!Number.isFinite(n) || n < 0 || n >= 1e9) return String(n).split('').filter((c) => /\d/.test(c)).map((d) => ONES[d]).join(' ');
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1e6) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return `${numberWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${numberWords(n % 1e6)}` : ''}`;
}

/* ------------------------------ text ------------------------------ */

/**
 * Text as words to say: [{ text, start, end (its characters in `text`),
 * phones, pause }], where pause is what follows it: 'stop' (. ! ? or a
 * line break), 'comma' (, ; : — and brackets) or ''.
 */
export function textPhones(text) {
  const src = String(text || '');
  const out = [];
  const re = /[A-Za-z]+(?:['’][A-Za-z]+)*|\d+(?:[.,]\d+)*|[&%@+=]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const token = m[0];
    let phones;
    if (/^\d/.test(token)) {
      const [whole, frac] = token.replace(/,(?=\d{3}\b)/g, '').split(/[.,]/);
      const said = numberWords(Number(whole)) + (frac ? ` point ${frac.split('').map((d) => ONES[d]).join(' ')}` : '');
      phones = said.split(' ').flatMap(wordPhones);
    } else if (/^[&%@+=]$/.test(token)) phones = { '&': 'and', '%': 'percent', '@': 'at', '+': 'plus', '=': 'equals' }[token].split(' ').flatMap(wordPhones);
    else phones = wordPhones(token);
    if (!phones.length) continue;
    out.push({ text: token, start: m.index, end: m.index + token.length, phones, pause: '' });
  }
  // What comes between each word and the next (or the end) says how long she pauses.
  for (let i = 0; i < out.length; i += 1) {
    const gap = src.slice(out[i].end, i + 1 < out.length ? out[i + 1].start : src.length);
    out[i].pause = /[.!?…]|\n/.test(gap) ? 'stop' : /[,;:—–()]|\s-\s/.test(gap) ? 'comma' : '';
  }
  if (out.length) out.at(-1).pause = 'stop';
  return out;
}
