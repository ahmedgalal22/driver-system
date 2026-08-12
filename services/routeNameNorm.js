/**
 * Deterministic, conservative Arabic place normalization for Load Prices.
 * This intentionally is not fuzzy matching: it only normalizes formatting and
 * common spelling variants before exact canonical-key comparison.
 */

const ARABIC_FORMATTING_RE = /[\u0640\u064B-\u065F\u0670]/g;
const ALEF_VARIANTS_RE = /[\u0622\u0623\u0625\u0671]/g;

export function displayRoutePlace(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalizeRoutePlace(value) {
  let place = displayRoutePlace(value);
  if (!place) return '';

  place = place
    .replace(ARABIC_FORMATTING_RE, '')
    .replace(ALEF_VARIANTS_RE, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();

  // A single leading definite article is the only article normalization. This
  // is deterministic and avoids broad fuzzy matching of unrelated locations.
  if (place.startsWith('ال') && place.length > 2) {
    place = place.slice(2);
  }

  return place;
}

export function canonicalRouteKey(loading, destination) {
  const canonical_loading = canonicalizeRoutePlace(loading);
  const canonical_destination = canonicalizeRoutePlace(destination);
  if (!canonical_loading || !canonical_destination) return null;
  return `${canonical_loading}|${canonical_destination}`;
}
