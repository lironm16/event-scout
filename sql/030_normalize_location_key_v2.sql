-- Strengthen `normalize_location_key(text)` to mirror the updated JS
-- `normalizeKey()` in lib/locationStore.js.
--
-- v1 (sql/013) only did: lower + Hebrew-quote-fold + collapse-whitespace
-- + trim. That left two real-world failure modes:
--
--   1. Trailing punctuation differences (".." vs nothing) created
--      duplicate rows for the same physical place.
--   2. Unicode bidi/zero-width chars (RLM, LRM, ZWSP) embedded in
--      pasted strings split otherwise-identical inputs into two keys.
--
-- v2 adds:
--   • Strip Unicode dir marks / zero-width chars (U+200B, U+200E,
--     U+200F, U+202A..U+202E).
--   • Strip a trailing run of ".", ",", "…" plus optional whitespace.
--
-- Internal punctuation, parens content, dashes — all preserved. Two
-- venue strings that differ in those characters MUST stay distinct
-- (e.g. "X (לשעבר Y)" vs "X (חדש)" are different places per user rule).
--
-- The function is IMMUTABLE so we use CREATE OR REPLACE — no schema
-- rebuild, no FK updates, just a new function body.
--
-- Implementation note: same as sql/013, we avoid embedded quote
-- characters in string literals (some web SQL editors mis-tokenise
-- them across statement boundaries). Hebrew quotes are reached via
-- chr() codepoints; the new dir-mark / zero-width chars likewise.
--   chr(1523) = ׳ (Hebrew geresh,    U+05F3)
--   chr(1524) = ״ (Hebrew gershayim, U+05F4)
--   chr(8203) = U+200B (ZWSP)
--   chr(8206) = U+200E (LRM)
--   chr(8207) = U+200F (RLM)
--   chr(8234) = U+202A (LRE)
--   chr(8235) = U+202B (RLE)
--   chr(8236) = U+202C (PDF)
--   chr(8237) = U+202D (LRO)
--   chr(8238) = U+202E (RLO)
--   chr(8230) = … (HORIZONTAL ELLIPSIS, U+2026)
--   chr(39)   = '  (ASCII apostrophe)
--   chr(34)   = "  (ASCII double quote)

CREATE OR REPLACE FUNCTION public.normalize_location_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $body$
  SELECT NULLIF(
    trim(
      regexp_replace(
        -- 4. Collapse whitespace runs.
        regexp_replace(
          -- 3. Strip trailing run of '.', ',', '…' + optional whitespace.
          --    The character class encloses the three marks; '$' anchors
          --    end-of-string. Outer regexp_replace later normalises the
          --    intermediate whitespace.
          regexp_replace(
            -- 2. Hebrew quote variants → ASCII (geresh / gershayim).
            translate(
              -- 1. Drop Unicode bidi / zero-width chars from the lowered input.
              translate(
                lower(input),
                chr(8203) || chr(8206) || chr(8207)
                  || chr(8234) || chr(8235) || chr(8236)
                  || chr(8237) || chr(8238),
                ''
              ),
              chr(1523) || chr(1524),
              chr(39) || chr(34)
            ),
            '[.,' || chr(8230) || ']+\s*$',
            '',
            'g'
          ),
          '\s+', ' ', 'g'
        ),
        '\s+$', '', 'g'
      )
    ),
    ''
  );
$body$;

NOTIFY pgrst, 'reload schema';
