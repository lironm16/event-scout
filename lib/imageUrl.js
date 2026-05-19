// Image-URL normalisation.
//
// Telegram's `sendPhoto` is strict: a URL like `/uploads/thumbs/x.jpg`
// fails with `400 Bad Request: invalid file HTTP URL specified: URL host
// is empty`. Smarticket's HTML quotes images as relative paths and our
// enricher used to persist them as-is, so most rows in `events.image`
// look like `/uploads/thumbs/...`. This helper ensures every URL handed
// to Telegram (or anyone) is fully-qualified.
//
// Source-awareness:
//   Each Smarticket tenant hosts its own /uploads/. Passing the wrong
//   base produces a 404 (Telegram then falls back to text-only). Callers
//   should pass the row's `source` value or the row itself; missing
//   source resolves to the legacy default ('mbe-rg') which is correct
//   for every row written before sql/034.
//
// Two callers:
//   1. The enricher / scraper, when WRITING a freshly-extracted URL.
//   2. The notifiers and renderers, when READING `events.image` —
//      defensive against legacy rows still stored with a leading `/`.

const { getImageBase } = require("./sourceUrls");

function resolveSource(sourceOrEvent) {
  if (sourceOrEvent == null) return undefined;
  if (typeof sourceOrEvent === "string") return sourceOrEvent;
  return sourceOrEvent.source;
}

/**
 * Convert any value we might see in `events.image` into a fully-qualified
 * URL. Returns `null` for anything that can't be salvaged so the caller
 * can fall back to a text-only message instead of a Telegram 400.
 *
 *   "https://x/y.jpg"    → "https://x/y.jpg"    (already absolute)
 *   "/uploads/x.jpg"     → "https://<tenant>/uploads/x.jpg"
 *   "uploads/x.jpg"      → "https://<tenant>/uploads/x.jpg"
 *   "" / null / "  "     → null
 *
 * @param {string|null|undefined} value
 * @param {string|{source?:string}} [sourceOrEvent] tenant key or event
 *   object. Omit for legacy callers — defaults to 'mbe-rg' which matches
 *   the DB DEFAULT and is correct for every row written before sql/034.
 */
// Percent-encode any non-ASCII characters in a URL so Telegram's
// sendPhoto doesn't reject it with "invalid file HTTP URL specified".
// City event images often have Hebrew filenames (e.g. /media/.../שבועות.jpg).
// `new URL(href).href` handles the encoding while preserving the host,
// path separators, and already-encoded sequences (idempotent).
function encodeNonAsciiUrl(href) {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

function normalizeImageUrl(value, sourceOrEvent) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  let url;
  if (s.startsWith("http://") || s.startsWith("https://")) {
    url = s;
  } else {
    const base = getImageBase(resolveSource(sourceOrEvent));
    url = s.startsWith("/") ? `${base}${s}` : `${base}/${s}`;
  }
  return encodeNonAsciiUrl(url);
}

module.exports = {
  normalizeImageUrl,
};
