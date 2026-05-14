const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const axios = require("axios");

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const TICKET_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    is_ticket_listing: {
      type: SchemaType.BOOLEAN,
      description: "True if this message is offering tickets for sale/giveaway",
    },
    event_title: {
      type: SchemaType.STRING,
      description: "Name of the event",
      nullable: true,
    },
    event_date: {
      type: SchemaType.STRING,
      description: "Date in YYYY-MM-DD if found, null otherwise",
      nullable: true,
    },
    event_time: {
      type: SchemaType.STRING,
      description: "Time in HH:MM if found, null otherwise",
      nullable: true,
    },
    quantity: {
      type: SchemaType.INTEGER,
      description: "Number of tickets, default 1",
    },
    price: {
      type: SchemaType.STRING,
      description: "Price as stated (e.g. '100₪', 'חינם'), null if not mentioned",
      nullable: true,
    },
  },
  required: ["is_ticket_listing", "quantity"],
};

const SYSTEM_PROMPT = `You analyze WhatsApp group messages from Israeli ticket marketplaces.
Determine if the message is a ticket listing (someone offering/selling tickets).

Messages may be in Hebrew, include emojis, slang, and abbreviations.
Common patterns: "מוכר/ת כרטיסים ל...", "יש לי X כרטיסים", "נמסר/מעביר כרטיס ל...".

Rules:
- is_ticket_listing = true ONLY if someone is explicitly offering tickets.
- Questions, requests to buy, or general chat = false.
- "נמכר" / "נמסר" / "תפוס" = false (these indicate SOLD, not a listing).
- Extract the event title, date, time, quantity, and price ONLY if this is a listing.
- Default quantity to 1 if not specified.
- Return null for fields not mentioned.`;

async function extractFromText(text) {
  try {
    const model = genai.getGenerativeModel({
      model: "gemini-flash-latest",
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: TICKET_SCHEMA,
        temperature: 0.1,
      },
    });

    const result = await model.generateContent(
      `WhatsApp message:\n"${text}"\n\nExtract ticket listing information.`
    );
    return JSON.parse(result.response.text());
  } catch (err) {
    if (err.message?.includes("429")) {
      console.warn("[TicketExtractor] Gemini Quota Exhausted");
    } else {
      console.error("[TicketExtractor] Text extraction error:", err.message);
    }
    return { is_ticket_listing: false, quantity: 0 };
  }
}

async function extractFromImage(imageBuffer, captionText = "") {
  try {
    const model = genai.getGenerativeModel({
      model: "gemini-flash-latest",
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: TICKET_SCHEMA,
        temperature: 0.1,
      },
    });

    const imagePart = {
      inlineData: {
        mimeType: "image/jpeg",
        data: imageBuffer.toString("base64"),
      },
    };

    const prompt = captionText
      ? `WhatsApp message with image.\nCaption: "${captionText}"\nAnalyze both the image and caption to extract ticket listing info.`
      : `WhatsApp message with image (no caption). Analyze the image to extract ticket listing info.`;

    const result = await model.generateContent([prompt, imagePart]);
    return JSON.parse(result.response.text());
  } catch (err) {
    if (err.message?.includes("429")) {
      console.warn("[TicketExtractor] Gemini Quota Exhausted (image)");
    } else {
      console.error("[TicketExtractor] Image extraction error:", err.message);
    }
    return { is_ticket_listing: false, quantity: 0 };
  }
}

function extractSellerPhone(message) {
  const contact = message.vCards?.[0];
  if (contact) {
    const telMatch = contact.match(/TEL.*?:(\+?\d+)/);
    if (telMatch) return telMatch[1];
  }

  const senderJid = message.author || message.from;
  if (senderJid) {
    const phone = senderJid.split("@")[0];
    if (/^\d{10,15}$/.test(phone)) return phone;
  }

  const bodyPhone = message.body?.match(/0\d{1,2}[-.]?\d{7,8}/);
  if (bodyPhone) return bodyPhone[0].replace(/[-. ]/g, "");

  return null;
}

const SOLD_PATTERNS = [
  /נמכר/,
  /נמסר/,
  /תפוס/,
  /sold/i,
  /taken/i,
  /סגור/,
];

function isSoldMessage(text) {
  return SOLD_PATTERNS.some((p) => p.test(text));
}

module.exports = { extractFromText, extractFromImage, extractSellerPhone, isSoldMessage };
