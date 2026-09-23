/**
 * The one place CartLift talks to a language model.
 *
 * Which provider is used is configuration, not code: `CARTLIFT_AI_PROVIDER` is
 * either "openai-compatible" (OpenAI itself, and the many APIs that copy its
 * chat-completions shape — Gemini, Groq, Mistral, DeepSeek, OpenRouter, a local
 * Ollama…) or "anthropic". Everything above this module — auto-translate, the
 * deal assistant — only asks for JSON back and never learns which one answered.
 *
 *   CARTLIFT_AI_PROVIDER   openai-compatible | anthropic   (default: whichever key is set)
 *   CARTLIFT_AI_BASE_URL   e.g. https://api.openai.com/v1  (openai-compatible only)
 *   CARTLIFT_AI_KEY        the API key
 *   CARTLIFT_AI_MODEL      default model for short jobs (translation)
 *   CARTLIFT_AI_MODEL_BIG  model for the assistant, which reasons over a whole deal
 *
 * ANTHROPIC_API_KEY / OPENAI_API_KEY are honoured as well, so an existing
 * deployment keeps working without new variables.
 */

export type AiProvider = "openai-compatible" | "anthropic";

/** A failure a merchant should read: never a stack trace, never the key. */
export class AiError extends Error {}

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  key: string;
  model: string;
  bigModel: string;
}

const env = (name: string) => (process.env[name] || "").trim();

const DEFAULT_MODELS: Record<AiProvider, { small: string; big: string }> = {
  // Cheap and fast for short texts; the bigger one writes whole deals.
  "openai-compatible": { small: "gpt-5.4-mini", big: "gpt-5.4" },
  anthropic: { small: "claude-haiku-4-5-20251001", big: "claude-opus-5" },
};

/** What this server is configured to talk to, or null when no key is set. */
export function aiSettings(): AiSettings | null {
  const key = env("CARTLIFT_AI_KEY") || env("OPENAI_API_KEY") || env("ANTHROPIC_API_KEY");
  if (!key) return null;

  const configured = env("CARTLIFT_AI_PROVIDER").toLowerCase();
  const provider: AiProvider =
    configured === "anthropic" || (!configured && !env("CARTLIFT_AI_KEY") && !env("OPENAI_API_KEY") && env("ANTHROPIC_API_KEY"))
      ? "anthropic"
      : "openai-compatible";

  const defaults = DEFAULT_MODELS[provider];
  return {
    provider,
    baseUrl: (env("CARTLIFT_AI_BASE_URL") || (provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, ""),
    key,
    model: env("CARTLIFT_AI_MODEL") || env("CARTLIFT_TRANSLATE_MODEL") || defaults.small,
    bigModel: env("CARTLIFT_AI_MODEL_BIG") || defaults.big,
  };
}

export interface AskOptions {
  system: string;
  user: string;
  /** "big" for work that reasons over a whole deal; "small" (default) for short texts. */
  size?: "small" | "big";
  maxTokens?: number;
  /** Seconds before giving up; the admin is waiting on this call. */
  timeout?: number;
}

/**
 * Asks the model for a JSON object and returns it parsed.
 * Throws AiError with a sentence a merchant can act on.
 */
export async function askJson<T = Record<string, unknown>>(options: AskOptions): Promise<T> {
  const settings = aiSettings();
  if (!settings) {
    throw new AiError("AI features need an API key on the server (CARTLIFT_AI_KEY).");
  }
  const text = await ask(settings, options);
  return parseJson<T>(text);
}

/** The raw answer, as text. */
export async function ask(settings: AiSettings, options: AskOptions): Promise<string> {
  const model = options.size === "big" ? settings.bigModel : settings.model;
  const maxTokens = options.maxTokens ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (options.timeout ?? 120) * 1000);

  try {
    const response =
      settings.provider === "anthropic"
        ? await anthropicCall(settings, options, model, maxTokens, controller.signal)
        : await openAiCall(settings, options, model, maxTokens, controller.signal);
    if (!response.trim()) throw new AiError("The model sent an empty answer. Try again.");
    return response;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if ((error as { name?: string })?.name === "AbortError") {
      throw new AiError("The model took too long to answer. Try again.");
    }
    // Network errors and anything else unexpected: say so without leaking details.
    console.error("AI request failed", error);
    throw new AiError("Could not reach the AI service. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
}

async function openAiCall(
  settings: AiSettings,
  options: AskOptions,
  model: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.user },
      ],
      response_format: { type: "json_object" },
      // Current OpenAI models want max_completion_tokens; older clones only
      // know max_tokens, and both ignore the one they don't use.
      max_completion_tokens: maxTokens,
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    error?: { message?: string; code?: string };
  } | null;

  if (!response.ok || body?.error) {
    throw describe(response.status, body?.error?.message);
  }
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new AiError("The answer was cut short. Try again with fewer texts at once.");
  }
  return choice?.message?.content ?? "";
}

async function anthropicCall(
  settings: AiSettings,
  options: AskOptions,
  model: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${settings.baseUrl}/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: options.system,
      messages: [{ role: "user", content: options.user }],
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    error?: { message?: string };
  } | null;

  if (!response.ok || body?.error) {
    throw describe(response.status, body?.error?.message);
  }
  if (body?.stop_reason === "refusal") throw new AiError("The model declined this request.");
  if (body?.stop_reason === "max_tokens") {
    throw new AiError("The answer was cut short. Try again with fewer texts at once.");
  }
  return (body?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** An HTTP failure as a sentence the merchant can act on. */
function describe(status: number, message?: string): AiError {
  if (status === 401 || status === 403) return new AiError("The AI API key was rejected. Check it in your server settings.");
  if (status === 429) return new AiError("The AI service is rate limiting us. Try again in a moment.");
  if (status === 402) return new AiError("The AI account has no credit left.");
  if (status >= 500) return new AiError("The AI service is having trouble. Try again in a moment.");
  // A 400 usually means the model name is wrong or the request is too big.
  console.error("AI request rejected", status, message);
  return new AiError(`The AI service rejected the request (${status}). Check the configured model.`);
}

/** JSON from the answer, tolerating a code fence or a sentence around it. */
export function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Some models wrap the object in a line of prose; take the outermost braces.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        // fall through
      }
    }
    throw new AiError("The answer came back in an unexpected format. Try again.");
  }
}
