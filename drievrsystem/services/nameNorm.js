/**
 * nameNorm.js — Canonical driver-name normalization ("natural" comparison).
 *
 * ONE pipeline shared by:
 *   - ClientRepository.createDriverUnique (duplicate prevention), and
 *   - the receipt-row driver autocomplete (search + ranking + highlight).
 *
 * normalizeDriverName(value) → canonical comparison form:
 *   • leading/trailing whitespace trimmed, internal runs collapsed to one space
 *   • Arabic diacritics (harakat U+064B–U+065F, superscript alef U+0670) removed
 *   • tatweel/kashida (U+0640) removed
 *   • alef-family folded: أ / إ / آ / ٱ → ا
 * Case is NOT folded here (duplicate prevention compares visually identical
 * names); the search path additionally lowercases both sides where applicable.
 */

const _AR_ALEF_FOLD = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا' };
// tatweel (ـ) + harakat (diacritics ً–۟) + superscript alef (ٰ)
const _AR_STRIP_RE = /[\u0640\u064B-\u065F\u0670]/;

function _isSpace(ch) { return /\s/.test(ch); }

export function normalizeDriverName(value) {
  return normalizeNameWithMap(value).text;
}

/**
 * normalizeNameWithMap(value) → { text, map }
 * Same normalization as normalizeDriverName, plus `map`: for every character
 * of the normalized text, the index of its source character in the ORIGINAL
 * string. Used to highlight the matched span in the un-normalized display name
 * (safe — coordinates only, never HTML).
 * Stripped characters (diacritics/tatweel) emit nothing, so a matched span can
 * be extended over them by the caller when building original coordinates.
 */
export function normalizeNameWithMap(value) {
  const s   = String(value ?? '');
  const out = [];
  const map = [];
  let prevSpace = true; // leading whitespace never emits (trim)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (_isSpace(ch)) {
      if (!prevSpace) { out.push(' '); map.push(i); }
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    if (_AR_STRIP_RE.test(ch)) continue;          // dropped — no map entry
    const folded = _AR_ALEF_FOLD[ch] || ch;
    for (const c of folded) { out.push(c); map.push(i); }
  }
  // trailing collapsed space (emitted before a following word existed) → trim
  if (out.length && out[out.length - 1] === ' ') { out.pop(); map.pop(); }
  return { text: out.join(''), map };
}
