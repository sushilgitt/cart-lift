import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AssistantError,
  DAILY_LIMIT,
  assistantAccess,
  draftFromPrompt,
  draftFromUrl,
  editDeal,
  fetchPageText,
  safeUrl,
} from "./assistant.server";
import { normalizeConfig } from "./deals";

const KEY_VARS = ["CARTLIFT_AI_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CARTLIFT_AI_PROVIDER"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEY_VARS.map((v) => [v, process.env[v]]));
  for (const v of KEY_VARS) delete process.env[v];
  process.env.CARTLIFT_AI_KEY = "sk-test";
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

/** The model answers with `answer`; the request it was sent is returned. */
function modelSays(answer: unknown) {
  const calls: { body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (_url: string, options: { body: string }) => {
    calls.push({ body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] }),
    };
  });
  return calls;
}

const TIERS = {
  name: "Bundle & save",
  type: "QUANTITY_BREAK",
  note: "Three tiers, middle one highlighted.",
  config: {
    bars: [
      { qty: 1, kind: "qty", discountType: "none", discountValue: 0, title: "Just one" },
      { qty: 2, kind: "qty", discountType: "percentage", discountValue: 10, title: "Buy 2", selected: true },
      { qty: 3, kind: "qty", discountType: "percentage", discountValue: 20, title: "Buy 3", badge: "Best value" },
    ],
  },
};

describe("a deal from a sentence", () => {
  test("becomes a draft the editor would accept", async () => {
    const calls = modelSays(TIERS);
    const draft = await draftFromPrompt("buy 2 save 10, buy 3 save 20");

    expect(draft.name).toBe("Bundle & save");
    expect(draft.type).toBe("QUANTITY_BREAK");
    expect(draft.config.bars.map((b) => [b.qty, b.discountValue])).toEqual([
      [1, 0],
      [2, 10],
      [3, 20],
    ]);
    expect(draft.note).toContain("Three tiers");
    // The merchant's words reach the model.
    expect(JSON.stringify(calls[0].body)).toContain("buy 2 save 10");
  });

  test("an empty request never reaches the model", async () => {
    const calls = modelSays(TIERS);
    await expect(draftFromPrompt("   ")).rejects.toThrow(AssistantError);
    expect(calls).toHaveLength(0);
  });

  test("a draft the editor would reject comes back as an error, not a broken deal", async () => {
    // No bars at all: validateConfig refuses this.
    modelSays({ name: "Bad", type: "QUANTITY_BREAK", config: { bars: [] } });
    await expect(draftFromPrompt("something")).rejects.toThrow(/problems/i);
  });

  test("an unknown deal type falls back instead of breaking", async () => {
    modelSays({ ...TIERS, type: "SOMETHING_ELSE" });
    expect((await draftFromPrompt("x")).type).toBe("QUANTITY_BREAK");
  });
});

describe("changing a deal in plain English", () => {
  test("what the model leaves out is kept", async () => {
    const current = normalizeConfig({
      ...normalizeConfig(null),
      style: { blockTitle: "MY TITLE", customCss: ".cl-bar { color: red }" },
      translations: { de: { blockTitle: "MEIN TITEL" } },
    });
    modelSays(TIERS);

    const draft = await editDeal({ name: "Deal", type: "QUANTITY_BREAK", config: current }, "add a third tier");
    expect(draft.config.bars).toHaveLength(3);
    // Style and translations were never shown to the model, and survive.
    expect(draft.config.style.customCss).toBe(".cl-bar { color: red }");
    expect(draft.config.translations.de?.blockTitle).toBe("MEIN TITEL");
  });

  test("an empty instruction is refused before spending a request", async () => {
    const calls = modelSays(TIERS);
    await expect(
      editDeal({ name: "Deal", type: "QUANTITY_BREAK", config: normalizeConfig(null) }, ""),
    ).rejects.toThrow(AssistantError);
    expect(calls).toHaveLength(0);
  });
});

describe("reading a page the merchant pointed at", () => {
  test("only public http(s) addresses are fetched", () => {
    expect(() => safeUrl("https://example.com/products/tee")).not.toThrow();
    expect(() => safeUrl("http://example.com")).not.toThrow();

    for (const bad of [
      "file:///etc/passwd",
      "ftp://example.com",
      "http://localhost:3000/admin",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      // The cloud metadata service, the one that really matters.
      "http://169.254.169.254/latest/meta-data/",
      "http://db.internal/",
      "not a url",
    ]) {
      expect(() => safeUrl(bad), bad).toThrow(AssistantError);
    }
  });

  test("a page becomes plain text, with scripts and markup dropped", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/products/tee",
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () =>
        `<html><head><style>.a{color:red}</style><script>alert('x')</script></head>
         <body><h1>Buy 2 save 10%</h1><p>Buy&nbsp;3 save 20%</p>
         <p>Free shipping on every bundle, 30-day returns.</p></body></html>`,
    }));
    const text = await fetchPageText("https://example.com/products/tee");
    expect(text).toContain("Buy 2 save 10%");
    expect(text).toContain("Buy 3 save 20%");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<h1>");
  });

  test("anything that isn't a readable page is refused", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/file.pdf",
      headers: { get: () => "application/pdf" },
      text: async () => "%PDF-1.4",
    }));
    await expect(fetchPageText("https://example.com/file.pdf")).rejects.toThrow(/not a web page/i);

    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 404,
      url: "https://example.com/missing",
      headers: { get: () => "text/html" },
      text: async () => "",
    }));
    await expect(fetchPageText("https://example.com/missing")).rejects.toThrow(/404/);
  });

  test("the page's text is what the model is asked about", async () => {
    vi.stubGlobal("fetch", async (url: string, options?: { body?: string }) => {
      if (String(url).includes("chat/completions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(TIERS) }, finish_reason: "stop" }],
          }),
          request: options,
        };
      }
      return {
        ok: true,
        status: 200,
        url: "https://example.com/products/tee",
        headers: { get: () => "text/html" },
        text: async () => "<body>Buy 2 save 10%, buy 3 save 20%. Free shipping on bundles.</body>",
      };
    });
    const draft = await draftFromUrl("https://example.com/products/tee");
    expect(draft.config.bars).toHaveLength(3);
  });
});

describe("who may ask, and how often", () => {
  const shop = (over: Partial<Parameters<typeof assistantAccess>[0]> = {}) => ({
    id: "s1",
    plan: "STARTER" as const,
    devStore: false,
    settings: {},
    ...over,
  });

  test("the Free plan is told where to find it", async () => {
    const access = await assistantAccess(shop({ plan: "FREE" }));
    expect(access.allowed).toBe(false);
    expect(access.reason).toMatch(/paid plans/i);
  });

  test("development stores get the paid experience", async () => {
    const access = await assistantAccess(shop({ plan: "FREE", devStore: true }));
    expect(access.allowed).toBe(true);
    expect(access.limit).toBe(DAILY_LIMIT.PRO);
  });

  test("today's requests count, yesterday's don't", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const used = await assistantAccess(shop({ settings: { ai: { day: today, used: 3 } } }));
    expect(used).toMatchObject({ allowed: true, used: 3, limit: DAILY_LIMIT.STARTER });

    const spent = await assistantAccess(shop({ settings: { ai: { day: today, used: DAILY_LIMIT.STARTER } } }));
    expect(spent.allowed).toBe(false);
    expect(spent.reason).toMatch(/resets tomorrow/i);

    const yesterday = await assistantAccess(shop({ settings: { ai: { day: "2020-01-01", used: 99 } } }));
    expect(yesterday).toMatchObject({ allowed: true, used: 0 });
  });

  test("bigger plans get more", () => {
    expect(DAILY_LIMIT.FREE).toBe(0);
    expect(DAILY_LIMIT.PRO).toBeGreaterThan(DAILY_LIMIT.STARTER);
    expect(DAILY_LIMIT.FLEX50).toBeGreaterThanOrEqual(DAILY_LIMIT.PRO);
  });
});
