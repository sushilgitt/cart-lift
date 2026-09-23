import { AiError, askJson } from "./ai.server";

/**
 * Auto-translate: the merchant's deal texts and widget words, translated by
 * whichever model the server is configured for (see ai.server.ts). Merchants
 * review and edit the result before it is published.
 *
 * Text variables like {{saved_amount}} must survive untouched, so they are part
 * of the instructions and checked again afterwards.
 */

const SYSTEM = [
  "You translate short marketing text for a Shopify storefront widget that sells product bundles.",
  "Rules:",
  "- Keep every {{variable}} exactly as it appears, including its braces and spelling.",
  "- Keep the tone short, concrete and sales-like; match the length of the source as closely as you can, because the text sits on small buttons and bars.",
  "- Keep capitalisation style (ALL CAPS stays ALL CAPS) and any trailing punctuation.",
  "- Do not translate brand or product names.",
  "- Reply with a JSON object only: the same keys as the input, values translated. No explanation, no code fence.",
].join("\n");

/** Kept as its own class so callers can tell a translation failure from a bug. */
export class TranslateError extends Error {}

const variablesOf = (text: string) => (text.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((v) => v.replace(/\s+/g, ""));

/**
 * Translates `texts` ({ key: source }) into `language` (e.g. "German (de)").
 * Values whose variables came back changed keep their source text.
 */
export async function translateTexts(texts: Record<string, string>, language: string): Promise<Record<string, string>> {
  const entries = Object.entries(texts).filter(([, v]) => v && v.trim());
  if (!entries.length) return {};

  let parsed: Record<string, unknown>;
  try {
    parsed = await askJson<Record<string, unknown>>({
      system: SYSTEM,
      user: `Translate these values into ${language}. Reply with JSON only.\n\n${JSON.stringify(
        Object.fromEntries(entries),
        null,
        2,
      )}`,
      // Short texts: the small model is enough, and much cheaper.
      size: "small",
      maxTokens: 8000,
    });
  } catch (error) {
    throw new TranslateError(error instanceof AiError ? error.message : "Translation failed. Try again.");
  }

  const out: Record<string, string> = {};
  for (const [key, source] of entries) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    // A translation that lost or renamed a variable would break the text.
    const before = variablesOf(source).sort().join(",");
    const after = variablesOf(value).sort().join(",");
    out[key] = before === after ? value.trim() : source;
  }
  return out;
}
