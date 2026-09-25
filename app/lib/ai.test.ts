import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AiError, aiSettings, askJson, parseJson } from "./ai.server";
import { TranslateError, translateTexts } from "./translate.server";

/** Every AI variable, cleared between tests so one can't leak into the next. */
const VARS = [
  "CARTLIFT_AI_PROVIDER",
  "CARTLIFT_AI_BASE_URL",
  "CARTLIFT_AI_KEY",
  "CARTLIFT_AI_MODEL",
  "CARTLIFT_AI_MODEL_BIG",
  "CARTLIFT_TRANSLATE_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

/** A fetch that records the request and answers with `body`. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, options: { headers: Record<string, string>; body: string }) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      json: async () => body,
    };
  });
  return calls;
}

const openAiSays = (content: string) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });

describe("which AI service the server talks to", () => {
  test("no key: AI features say so instead of failing oddly", async () => {
    expect(aiSettings()).toBe(null);
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(/need an API key/i);
  });

  test("an OpenAI-style key is the default; an Anthropic key alone picks Anthropic", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(aiSettings()).toMatchObject({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1" });

    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(aiSettings()).toMatchObject({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" });
  });

  test("any OpenAI-compatible service can be pointed at, with its own models", () => {
    process.env.CARTLIFT_AI_KEY = "k";
    process.env.CARTLIFT_AI_BASE_URL = "https://openrouter.ai/api/v1/";
    process.env.CARTLIFT_AI_MODEL = "mistral-small";
    const settings = aiSettings()!;
    // The trailing slash would double up in the request URL.
    expect(settings.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(settings.model).toBe("mistral-small");
  });
});

describe("asking for JSON", () => {
  test("an OpenAI-compatible request carries the key, the model and the JSON instruction", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";
    process.env.CARTLIFT_AI_MODEL_BIG = "big-model";
    const calls = stubFetch(openAiSays('{"ok": true}'));

    expect(await askJson({ system: "sys", user: "usr", size: "big", maxTokens: 100 })).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    expect(calls[0].body).toMatchObject({
      model: "big-model",
      response_format: { type: "json_object" },
      max_completion_tokens: 100,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
    });
  });

  test("an Anthropic request uses that API's own shape", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const calls = stubFetch({ content: [{ type: "text", text: '{"ok": true}' }], stop_reason: "end_turn" });

    expect(await askJson({ system: "sys", user: "usr" })).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant");
    expect(calls[0].body).toMatchObject({ system: "sys", max_tokens: 16000 });
  });

  test("failures become sentences a merchant can act on", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";

    stubFetch({ error: { message: "bad key" } }, { status: 401 });
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(/key was rejected/i);

    stubFetch({ error: { message: "slow down" } }, { status: 429 });
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(/rate limiting/i);

    stubFetch({ error: { message: "boom" } }, { status: 503 });
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(/having trouble/i);

    stubFetch({ choices: [{ message: { content: "{" }, finish_reason: "length" }] });
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(/cut short/i);
  });

  test("a key is never part of the message a merchant sees", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-secret-value";
    stubFetch({ error: { message: "Incorrect API key provided: sk-secret-value" } }, { status: 401 });
    await expect(askJson({ system: "s", user: "u" })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("sk-secret-value") }) as Error,
    );
  });

  test("JSON wrapped in a code fence or a sentence is still read", () => {
    expect(parseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Here you go: {"a": 1} — hope that helps')).toEqual({ a: 1 });
    expect(() => parseJson("no json at all")).toThrow(AiError);
  });
});

describe("auto-translate", () => {
  test("asks for the texts and keeps what came back", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";
    const calls = stubFetch(openAiSays('{"buy": "Kaufe {{quantity}}", "save": "Du sparst {{saved_amount}}"}'));

    const out = await translateTexts({ buy: "Buy {{quantity}}", save: "You save {{saved_amount}}" }, "German (de)");
    expect(out).toEqual({ buy: "Kaufe {{quantity}}", save: "Du sparst {{saved_amount}}" });
    expect(calls[0].body.messages).toMatchObject([{}, { content: expect.stringContaining("German (de)") }]);
  });

  test("a translation that mangled a variable keeps the English text", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";
    stubFetch(openAiSays('{"save": "Du sparst {{betrag}}", "buy": "Kaufe {{quantity}}"}'));

    const out = await translateTexts({ save: "You save {{saved_amount}}", buy: "Buy {{quantity}}" }, "German (de)");
    expect(out.save).toBe("You save {{saved_amount}}");
    expect(out.buy).toBe("Kaufe {{quantity}}");
  });

  test("nothing to translate: no request is made at all", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";
    const calls = stubFetch(openAiSays("{}"));
    expect(await translateTexts({ blank: "  ", empty: "" }, "German (de)")).toEqual({});
    expect(calls).toHaveLength(0);
  });

  test("a service failure reaches the merchant as a translation failure", async () => {
    process.env.CARTLIFT_AI_KEY = "sk-test";
    stubFetch({ error: { message: "nope" } }, { status: 429 });
    await expect(translateTexts({ a: "A" }, "German (de)")).rejects.toThrow(TranslateError);
  });
});
