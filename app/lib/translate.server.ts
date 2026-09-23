import Anthropic from "@anthropic-ai/sdk";

/**
 * Auto-translate: the merchant's deal texts and widget words, translated with
 * the Claude API. Merchants review and edit the result before it is published.
 *
 * Needs ANTHROPIC_API_KEY on the server. CARTLIFT_TRANSLATE_MODEL overrides the
 * model. Text variables like {{saved_amount}} must survive untouched, so they
 * are part of the instructions and checked afterwards.
 */

export const TRANSLATE_MODEL = process.env.CARTLIFT_TRANSLATE_MODEL || "claude-opus-5";

const SYSTEM = [
  "You translate short marketing text for a Shopify storefront widget that sells product bundles.",
  "Rules:",
  "- Keep every {{variable}} exactly as it appears, including its braces and spelling.",
  "- Keep the tone short, concrete and sales-like; match the length of the source as closely as you can, because the text sits on small buttons and bars.",
  "- Keep capitalisation style (ALL CAPS stays ALL CAPS) and any trailing punctuation.",
  "- Do not translate brand or product names.",
  "- Reply with a JSON object only: the same keys as the input, values translated. No explanation, no code fence.",
].join("\n");

export class TranslateError extends Error {}

const variablesOf = (text: string) => (text.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((v) => v.replace(/\s+/g, ""));

/**
 * Translates `texts` ({ key: source }) into `language` (e.g. "German (de)").
 * Values whose variables came back changed keep their source text.
 */
export async function translateTexts(texts: Record<string, string>, language: string): Promise<Record<string, string>> {
  const entries = Object.entries(texts).filter(([, v]) => v && v.trim());
  if (!entries.length) return {};
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new TranslateError("Auto-translate needs an Anthropic API key on the server (ANTHROPIC_API_KEY).");
  }

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 8000,
      // Translation is simple work: keep the thinking (and the spend) low.
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Translate these values into ${language}. Reply with JSON only.\n\n${JSON.stringify(
            Object.fromEntries(entries),
            null,
            2,
          )}`,
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new TranslateError("The Anthropic API key was rejected.");
    if (error instanceof Anthropic.RateLimitError) throw new TranslateError("Anthropic is rate limiting us. Try again in a moment.");
    if (error instanceof Anthropic.APIError) throw new TranslateError(`Translation failed (${error.status}). Try again.`);
    throw new TranslateError("Translation failed. Try again.");
  }

  if (response.stop_reason === "refusal") throw new TranslateError("The model declined to translate this text.");
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    // Be forgiving about a code fence, even though the prompt asks for none.
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new TranslateError("The translation came back in an unexpected format. Try again.");
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
