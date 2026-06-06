// LLM-based address normalizer for Hebrew venue strings.
//
// Smarticket scrapes produce strings like:
//   "אולם ספורט ביהס נבון -הרב גורן 5 קריית קרניצי"
//   "בית קריניצי, רח' קריניצי 64 רמת גן"
//   "תיאטרון רמת גן - חיבת ציון 16 ר״ג (חדש)"
//
// Nominatim chokes on the venue-name prefix and Hebrew abbreviations
// ("ר״ג", "ת״א"). Heuristic regex extraction is brittle. Instead we hand
// the raw string to Gemini-flash and let it return a clean street address
// suitable for geocoding. The result is cached implicitly via the
// `locations` table, so each unique venue is normalized at most once.

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { DEFAULT_CITY } = require("./geocodingDefaults");

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const { isGeminiAllowed } = require("./geminiPolicy");
const { GEMINI_MODEL } = require("./geminiModel");

const SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    address: {
      type: SchemaType.STRING,
      nullable: true,
      description:
        "A clean Hebrew street address ready to send to OpenStreetMap, " +
        "in the form '<street name> <number>, <city>'. Null if no address can be determined.",
    },
    confidence: {
      type: SchemaType.STRING,
      description: "'high' / 'medium' / 'low' — how confident you are.",
    },
  },
  required: ["address", "confidence"],
};

// {{DEFAULT_CITY}} is replaced at call time with the city hint passed
// in by the caller (or the env-default). We don't hardcode "רמת גן"
// here because that's a multi-city expansion blocker — when we add
// Givatayim feeds the prompt should say "Default city is גבעתיים"
// for those rows.
const SYSTEM_PROMPT_TEMPLATE = `You are a Hebrew venue → street address parser for events in Israel.

Input: a free-text Hebrew venue string. May contain:
  - venue name + address ("אולם ספורט ביהס נבון - הרב גורן 5 קריית קרניצי")
  - just an address ("הרב גורן 5, רמת גן")
  - just a venue name ("תיאטרון הבימה")
  - abbreviations: ר"ג / ר״ג = רמת גן ; ת"א / ת״א = תל אביב ; ב"ש = באר שבע
  - parens-suffix junk: "(חדש)", "(לשעבר ...)" — ignore.

Your job: return a clean address string that a geocoder (Google Places or OpenStreetMap) can find. The downstream geocoder can resolve both street addresses AND venue names — so when in doubt, prefer the venue NAME over a guessed street.

Rules:
1. Prefer "<street name> <number>, <city>" format ONLY when the input ALREADY contains a real street name AND number (or you have rock-solid factual knowledge of the venue's address — e.g. "תיאטרון הבימה" → "כיכר הבימה, תל אביב").
2. Expand abbreviations to full city names (ר"ג → רמת גן, ת"א → תל אביב, etc).
3. Drop generic venue-noun PREFIXES that confuse POI search ("אולם ספורט", "אולם הספורט", "המרכז", "אודיטוריום של…"). Keep the SPECIFIC venue name that follows.
4. Schools, kindergartens, community centers, and similar named venues: when no street number is in the input AND you don't have verified factual knowledge of the street, return the venue name PRESERVED ("בית ספר ויצמן" → "בית ספר ויצמן, רמת גן"). DO NOT invent a street address by using the venue's namesake as a street ("ויצמן 1") — the geocoder can find named venues directly and an invented street can land in a different city.
5. Default city is "{{DEFAULT_CITY}}" when no city is in the input.
6. If you genuinely can't infer anything useful, return address=null.
7. NEVER invent street names or numbers. Specifically: if the venue is named after a person/place (Weizmann, Bialik, Herzl, …) it does NOT mean the venue is ON a street with that name. Use the venue NAME instead.
8. \`confidence\`: 'high' when you have a verified street address (from input or factual knowledge); 'medium' when you stripped a prefix and kept a recognizable venue name; 'low' for everything else.

Return ONLY the JSON.`;

const TIMEOUT_MS = 12000;

/**
 * @param {string} rawAddress Raw venue/address text.
 * @param {Object} [opts]
 * @param {string} [opts.city] City hint injected into the prompt as
 *   the default-city for ambiguous inputs. Defaults to DEFAULT_CITY.
 *   Pass per-row when normalizing in bulk across cities.
 */
async function normalizeAddress(rawAddress, opts = {}) {
  if (!isGeminiAllowed("address")) return null;
  if (!rawAddress) return null;
  const text = String(rawAddress).trim();
  if (!text) return null;
  const city = opts.city || DEFAULT_CITY;
  const systemInstruction = SYSTEM_PROMPT_TEMPLATE.replace("{{DEFAULT_CITY}}", city);

  try {
    const model = genai.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0.1,
      },
    });

    const result = await Promise.race([
      model.generateContent(`Venue: "${text}"`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), TIMEOUT_MS)
      ),
    ]);

    const parsed = JSON.parse(result.response.text());
    if (!parsed.address || parsed.confidence === "low") return null;

    const cleaned = parsed.address.trim();
    if (!cleaned) return null;
    return cleaned;
  } catch (err) {
    console.warn(
      `[AddressNormalizer] failed for "${text}": ${err.message}`
    );
    return null;
  }
}

const EXTRACT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    venue: {
      type: SchemaType.STRING,
      nullable: true,
      description:
        "The venue name or address extracted from the text. Return the most specific location " +
        "mentioned (room, building, street). Null if no venue is clearly stated.",
    },
    confidence: {
      type: SchemaType.STRING,
      description: "'high' / 'medium' / 'low'",
    },
  },
  required: ["venue", "confidence"],
};

const EXTRACT_PROMPT_TEMPLATE = `You are a venue extractor for Hebrew event listings in Israel.

Given an event title and description, extract the venue or address where the event takes place.

Rules:
1. Return the most specific location mentioned — room name, building, street address.
2. Default city is "{{DEFAULT_CITY}}" when not stated.
3. Return null when no venue is mentioned or you're guessing.
4. confidence: 'high' = explicit address/named place; 'medium' = venue name without address; 'low' = vague/implicit.

Return ONLY the JSON.`;

/**
 * Ask Gemini to extract a venue from event prose (title + description).
 * Used as a fallback when the structured CMS fields yield no venue.
 *
 * @param {string} title  Event title
 * @param {string} description  Event description / body text
 * @param {Object} [opts]
 * @param {string} [opts.city]  City hint; defaults to DEFAULT_CITY
 * @returns {Promise<string|null>}  Venue string ready for ensureLocationKey, or null
 */
async function extractVenueFromText(title, description, opts = {}) {
  if (!isGeminiAllowed("address")) return null;
  if (!title && !description) return null;
  const city = opts.city || DEFAULT_CITY;
  const systemInstruction = EXTRACT_PROMPT_TEMPLATE.replace("{{DEFAULT_CITY}}", city);
  const userText = [title && `Title: ${title}`, description && `Description: ${description}`]
    .filter(Boolean)
    .join("\n");

  try {
    const model = genai.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: EXTRACT_SCHEMA,
        temperature: 0.1,
      },
    });

    const result = await Promise.race([
      model.generateContent(userText),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), TIMEOUT_MS)
      ),
    ]);

    const parsed = JSON.parse(result.response.text());
    if (!parsed.venue || parsed.confidence === "low") return null;
    return parsed.venue.trim() || null;
  } catch (err) {
    console.warn(`[AddressNormalizer] extractVenueFromText failed: ${err.message}`);
    return null;
  }
}

module.exports = { normalizeAddress, extractVenueFromText };
