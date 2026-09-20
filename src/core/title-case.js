/**
 * Word-initial capitalization ("每词首字母大写").
 *
 * The reader view never rewrites a whole text node: it uses
 * `segmentForCapitalize` so that only the first character of eligible word
 * segments is replaced and everything else (URLs, e-mails, digits, `iPhone`,
 * `DNA`, CJK…) is written back byte for byte.
 */

/** Word tokenizer: a letter followed by letters/digits/apostrophes/hyphens. @type {RegExp} */
const WORD_RE = /\p{L}[\p{L}\p{N}'’\-]*/gu;

/** Scheme URL or `www.` URL, up to the next whitespace. @type {RegExp} */
const URL_AT_RE = /(?:[A-Za-z][A-Za-z0-9+.\-]*:\/\/|www\.)[^\s]+/y;

/** Trailing punctuation that belongs to the sentence, not to the URL. @type {RegExp} */
const URL_TRAILING_PUNCT_RE = /[.,;:!?'"]+$/;

/** Simple e-mail address (`x@y.z`). @type {RegExp} */
const EMAIL_AT_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+/y;

/** Word token at a sticky position. @type {RegExp} */
const WORD_AT_RE = /\p{L}[\p{L}\p{N}'’\-]*/uy;

/** Pure digit run. @type {RegExp} */
const DIGITS_AT_RE = /\p{N}+/uy;

/** Whitespace run. @type {RegExp} */
const SPACE_AT_RE = /\s+/uy;

/** Punctuation run (anything that is not a letter, a digit or whitespace). @type {RegExp} */
const PUNCT_AT_RE = /[^\p{L}\p{N}\s]+/uy;

/**
 * @typedef {Object} CaseSegment
 * @property {string} text   raw slice of the input
 * @property {boolean} word  true for word-ish tokens, false for punctuation/space
 * @property {boolean} [skip] true when the segment must be written back untouched
 */

/**
 * @typedef {Object} RawSegment
 * @property {string} kind 'word'|'short'|'digits'|'url'|'email'|'space'|'punct'
 * @property {string} text
 * @property {boolean} word
 * @property {boolean} skip
 */

/**
 * Coerce a value to a string (null/undefined become '').
 * @param {unknown} value candidate
 * @returns {string} a string
 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Uppercase the first character of a word, leaving the rest untouched.
 * Uses the locale-independent `toUpperCase()`.
 * @param {string} word source word
 * @returns {string} word with a capitalized first character
 */
function upperFirst(word) {
  if (word === '') return word;
  const head = String.fromCodePoint(/** @type {number} */ (word.codePointAt(0)));
  return head.toUpperCase() + word.slice(head.length);
}

/**
 * Match a sticky regex at an exact offset.
 * @param {RegExp} re sticky (`y`) regular expression
 * @param {string} text haystack
 * @param {number} index offset to test
 * @returns {string|null} the match, or null
 */
function matchAt(re, text, index) {
  re.lastIndex = index;
  const m = re.exec(text);
  return m === null ? null : m[0];
}

/**
 * Append one raw segment, merging it into the previous one when the kinds match.
 * @param {RawSegment[]} list accumulator
 * @param {RawSegment['kind']} kind segment kind
 * @param {string} text raw slice
 * @param {boolean} word word-ish flag
 * @param {boolean} skip skip flag
 * @returns {void}
 */
function push(list, kind, text, word, skip) {
  if (text === '') return;
  const last = list.length > 0 ? list[list.length - 1] : null;
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  list.push({ kind, text, word, skip });
}

/**
 * Does this text look like a URL? ("contains ://" or "starts with www.")
 * @param {string} text text to test
 * @returns {boolean} true when the text is URL shaped
 */
function looksLikeUrl(text) {
  const trimmed = text.trim();
  return trimmed.includes('://') || /^www\./i.test(trimmed);
}

/**
 * Uppercase the first character of every word token, leaving the rest of each
 * word byte-identical (`iPhone` → `IPhone`, `DNA` keeps its capitals).
 * Pure-digit runs are not words and are therefore untouched.
 * @param {unknown} text source text
 * @returns {string} text with capitalized word initials
 */
export function toTitleCase(text) {
  const s = asString(text);
  return s.replace(WORD_RE, (word) => upperFirst(word));
}

/**
 * Split text into maximal segments for word-initial capitalization.
 *
 * Adjacent segments of the same kind are merged and concatenating every
 * `text` reproduces the input exactly. `word: true` segments whose `skip` is
 * not `true` are the ones to capitalize; `skip: true` marks URL (contains
 * `://` or starts with `www.`), e-mail, pure-digit and lone single-character
 * tokens, which must be written back untouched.
 *
 * @param {unknown} text source text
 * @returns {CaseSegment[]} ordered segments covering the whole input
 */
export function segmentForCapitalize(text) {
  const s = asString(text);
  /** @type {RawSegment[]} */
  const raw = [];
  let i = 0;

  while (i < s.length) {
    const urlMatch = matchAt(URL_AT_RE, s, i);
    if (urlMatch !== null) {
      const core = urlMatch.replace(URL_TRAILING_PUNCT_RE, '');
      if (core !== '') {
        push(raw, 'url', core, true, true);
        i += core.length;
        continue;
      }
    }
    const emailMatch = matchAt(EMAIL_AT_RE, s, i);
    if (emailMatch !== null) {
      push(raw, 'email', emailMatch, true, true);
      i += emailMatch.length;
      continue;
    }
    const wordMatch = matchAt(WORD_AT_RE, s, i);
    if (wordMatch !== null) {
      const lone = [...wordMatch].length === 1;
      push(raw, lone ? 'short' : 'word', wordMatch, true, lone);
      i += wordMatch.length;
      continue;
    }
    const digitMatch = matchAt(DIGITS_AT_RE, s, i);
    if (digitMatch !== null) {
      push(raw, 'digits', digitMatch, true, true);
      i += digitMatch.length;
      continue;
    }
    const spaceMatch = matchAt(SPACE_AT_RE, s, i);
    if (spaceMatch !== null) {
      push(raw, 'space', spaceMatch, false, false);
      i += spaceMatch.length;
      continue;
    }
    const punctMatch = matchAt(PUNCT_AT_RE, s, i);
    if (punctMatch !== null) {
      push(raw, 'punct', punctMatch, false, false);
      i += punctMatch.length;
      continue;
    }
    // Unreachable for well-formed input; keep the walk total anyway.
    push(raw, 'punct', s.charAt(i), false, false);
    i += 1;
  }

  return raw.map((segment) => {
    /** @type {CaseSegment} */
    const out = { text: segment.text, word: segment.word };
    if (segment.skip) out.skip = true;
    return out;
  });
}

/**
 * @typedef {Object} CaseRange
 * @property {number} start inclusive character offset
 * @property {number} end   exclusive character offset
 * @property {boolean} word true for word-ish tokens
 * @property {boolean} skip true when the token must be written back untouched
 */

/**
 * Position-aware variant of {@link segmentForCapitalize}.
 *
 * `segmentForCapitalize` merges adjacent same-kind runs, which is fine when all you
 * do is re-emit text, but the reader view needs a per-word DOM element to hang
 * `::first-letter { text-transform: uppercase }` on. Ranges therefore stay
 * un-merged, and `text.slice(start, end)` of every range is exactly the token.
 *
 * Ranges are contiguous and cover the whole input, so
 * `ranges.at(-1).end === text.length` and `ranges[i].end === ranges[i + 1].start`.
 *
 * @param {unknown} text source text
 * @returns {CaseRange[]} ordered, contiguous ranges covering the whole input
 */
export function segmentRanges(text) {
  const s = asString(text);
  /** @type {CaseRange[]} */
  const ranges = [];
  let i = 0;
  for (const segment of segmentForCapitalize(s)) {
    const next = i + segment.text.length;
    ranges.push({ start: i, end: next, word: segment.word, skip: segment.skip === true });
    i = next;
  }
  return ranges;
}
