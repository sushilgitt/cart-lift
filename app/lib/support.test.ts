import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DAILY_MESSAGES, SupportError, answerQuestion, messagesToday, supportAiReady } from "./support.server";
import { SUPPORT_KB } from "./support-kb";

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

const context = (over: Partial<Parameters<typeof answerQuestion>[1]> = {}) => ({
  plan: "Starter",
  devStore: false,
  embedOn: true,
  activeDeals: 2,
  totalDeals: 3,
  published: true,
  ...over,
});

describe("what support is told", () => {
  test("the answer is grounded in the knowledge base, and the shop's own state goes with the question", async () => {
    const calls = modelSays({ reply: "Turn on the app embed in Settings → Theme setup.", human: false });
    const answer = await answerQuestion("my deal isn't showing", context({ embedOn: false }));

    expect(answer).toEqual({ reply: "Turn on the app embed in Settings → Theme setup.", human: false });
    const sent = JSON.stringify(calls[0].body);
    // The model is given CartLift's own documentation…
    expect(sent).toContain("Why a deal might not show");
    // …and the facts that usually answer the question.
    expect(sent).toContain("app embed off");
    expect(sent).toContain("2 of 3 deals active");
    expect(sent).toContain("plan Starter");
  });

  test("nothing about shoppers is sent — the merchant's words and their setup, and that's all", async () => {
    const calls = modelSays({ reply: "ok", human: false });
    await answerQuestion("how do gifts work?", context());
    // What the *shop* contributes is the user message; the system prompt is our
    // own documentation, which is allowed to use words like "customer".
    const messages = calls[0].body.messages as { role: string; content: string }[];
    const fromShop = messages.find((m) => m.role === "user")!.content;
    expect(fromShop.split("\n").filter(Boolean)).toEqual([
      "This shop: plan Starter, 2 of 3 deals active, app embed on, deals published.",
      "The merchant asks:",
      "how do gifts work?",
    ]);
  });

  test("the earlier conversation is carried, but not endlessly", async () => {
    const calls = modelSays({ reply: "ok", human: false });
    const history = Array.from({ length: 20 }, (_, i) => ({ author: "MERCHANT", body: `question ${i}` }));
    await answerQuestion("and now?", context(), history);
    const sent = JSON.stringify(calls[0].body);
    expect(sent).toContain("question 19");
    expect(sent).not.toContain("question 5");
  });

  test("an empty question never reaches the model", async () => {
    const calls = modelSays({ reply: "ok", human: false });
    await expect(answerQuestion("   ", context())).rejects.toThrow(SupportError);
    expect(calls).toHaveLength(0);
  });

  test("an empty or failed answer becomes something the merchant can act on", async () => {
    modelSays({ reply: "  ", human: false });
    await expect(answerQuestion("hello", context())).rejects.toThrow(/ask for a person|try again/i);

    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "slow" } }) }));
    await expect(answerQuestion("hello", context())).rejects.toThrow(SupportError);
  });

  test("a question for a person comes back flagged", async () => {
    modelSays({ reply: "I'll pass this to someone who can look at your invoice.", human: true });
    expect((await answerQuestion("refund my last invoice", context())).human).toBe(true);
  });
});

describe("limits and configuration", () => {
  test("support counts today's messages only", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(messagesToday({ settings: { support: { day: today, used: 4 } } })).toBe(4);
    expect(messagesToday({ settings: { support: { day: "2020-01-01", used: 99 } } })).toBe(0);
    expect(messagesToday({ settings: {} })).toBe(0);
    expect(DAILY_MESSAGES).toBeGreaterThan(0);
  });

  test("support knows whether it can answer by itself", () => {
    expect(supportAiReady()).toBe(true);
    delete process.env.CARTLIFT_AI_KEY;
    expect(supportAiReady()).toBe(false);
  });
});

describe("the knowledge base", () => {
  test("says the things merchants actually ask about", () => {
    for (const topic of ["app embed", "Draft or Paused", "?cartlift=off", "added revenue", "7-day free trial"]) {
      expect(SUPPORT_KB, topic).toContain(topic);
    }
  });

  test("states the prices the app actually charges", () => {
    // A wrong price here becomes a wrong answer to every merchant who asks.
    for (const price of ["$14.99", "$29.99", "$59.99", "$149.99", "$299.99", "$599.99"]) {
      expect(SUPPORT_KB, price).toContain(price);
    }
    // The tiers we removed must not linger in what support tells people.
    for (const gone of ["$99", "$149 ", "$199", "$299/"]) {
      expect(SUPPORT_KB, gone).not.toContain(gone);
    }
  });
});

describe("what support promises a merchant", () => {
  test("it states what happened and promises nothing the app can't keep", async () => {
    const { CANT_ANSWER } = await import("./support.server");
    expect(CANT_ANSWER).toContain("saved to your conversation");
    // The app has no way to reach a person, so it must not imply one.
    expect(CANT_ANSWER).not.toMatch(/email|@|get back to you|reply to you/i);
  });
});
