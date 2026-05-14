// Heuristics for venue strings that describe an online / non-physical event.
// We match these BEFORE calling Nominatim so we never waste a network round
// trip on something that has no coordinates by definition.
//
// Detected matches are persisted to `locations` with source='virtual' and
// found=false — so downstream geocoder lookups see them as "permanently
// resolved as virtual" instead of "pending" or "transiently failed".

const VIRTUAL_PATTERNS = [
  // English
  /\bzoom\b/i,
  /\bonline\b/i,
  /\bwebinar\b/i,
  /\bvirtual\b/i,
  /\bgoogle\s*meet\b/i,
  /\bms\s*teams\b/i,
  /\bteams\s*meeting\b/i,
  /\blivestream(ing)?\b/i,
  /\bremote\s*(meeting|session)\b/i,

  // Hebrew
  // Note: JS \b only works on ASCII; we use Unicode-aware lookarounds so
  // "זום" matches standalone but NOT as part of a larger Hebrew word.
  /(?<![א-ת])זום(?![א-ת])/,
  /אונליין/,
  /מקוון/,
  /וירטואלי/,
  /סטרימינג/,
  /שידור\s*חי/,
  /מפגש\s*מקוון/,
  /מפגש\s*וירטואלי/,
  /הרצאה\s*מקוונת/,
];

function isVirtualVenue(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  return VIRTUAL_PATTERNS.some((re) => re.test(trimmed));
}

module.exports = {
  isVirtualVenue,
  VIRTUAL_PATTERNS,
};
