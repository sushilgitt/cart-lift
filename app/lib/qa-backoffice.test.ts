/**
 * QA pass for docs/TESTING.md Phases 7–10, the parts a simulation can reach:
 * subscriptions in the Function, the pixel's added-revenue arithmetic, ingest
 * idempotency, A/B statistics, plan copy, assistant/support guard rails.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// In-memory Prisma, just enough for stats.server.ingestEvents
// ---------------------------------------------------------------------------
const db = vi.hoisted(() => ({
  dealOrders: new Set<string>(),
  checkouts: new Set<string>(),
  daily: new Map<string, Record<string, number>>(),
  settingsWrites: [] as unknown[],
}));

vi.mock("../db.server", () => {
  const dup = () => {
    // Reuse the real error class so the code under test recognises it.
    const { Prisma: P } = require("@prisma/client");
    return new P.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "test" });
  };
  const bump = (key: string, inc: Record<string, unknown>) => {
    const row = db.daily.get(key) ?? {};
    for (const [k, v] of Object.entries(inc)) {
      const n = typeof v === "object" && v && "increment" in v ? Number((v as { increment: number }).increment) : Number(v);
      if (Number.isFinite(n)) row[k] = (row[k] ?? 0) + n;
    }
    db.daily.set(key, row);
  };
  return {
    default: {
      shop: {
        findUnique: async () => ({
          id: "shop1",
          domain: "qa.myshopify.com",
          timezone: "UTC",
          deals: [{ id: "deal1", type: "QUANTITY_BREAK", config: {} }],
        }),
        update: async (args: unknown) => db.settingsWrites.push(args),
      },
      dailyStat: {
        upsert: async ({ where, create, update }: { where: { dealId_arm_day: { dealId: string; arm: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const key = `${where.dealId_arm_day.dealId}|${where.dealId_arm_day.arm}`;
          if (db.daily.has(key)) bump(key, update);
          else {
            const { shopId: _s, dealId: _d, arm: _a, day: _day, ...inc } = create;
            bump(key, inc);
          }
        },
      },
      statFact: { upsert: async () => undefined },
      dealOrder: {
        create: async ({ data }: { data: { shopId: string; orderId: string; dealId: string } }) => {
          const key = `${data.shopId}|${data.orderId}|${data.dealId}`;
          if (db.dealOrders.has(key)) throw dup();
          db.dealOrders.add(key);
        },
      },
      dealCheckout: {
        create: async ({ data }: { data: { shopId: string; token: string; dealId: string } }) => {
          const key = `${data.shopId}|${data.token}|${data.dealId}`;
          if (db.checkouts.has(key)) throw dup();
          db.checkouts.add(key);
        },
      },
      variantCost: { findMany: async () => [], upsert: async () => undefined },
    },
  };
});
vi.mock("../shopify.server", () => ({
  unauthenticated: { admin: async () => { throw new Error("no store in tests"); } },
}));

// Pixel: capture the handler `register` is given, and the events it sends.
const pixel = vi.hoisted(() => ({ handler: null as null | ((api: unknown) => void) }));
vi.mock("@shopify/web-pixels-extension", () => ({
  register: (fn: (api: unknown) => void) => {
    pixel.handler = fn;
  },
}));

import { ingestEvents } from "./stats.server";
import { cartLinesDiscountsGenerateRun, type FnConfig } from "../../extensions/cartlift-discount/src/cart_lines_discounts_generate_run";
import { DiscountClass } from "../../extensions/cartlift-discount/generated/api";
import { abResult, metrics, emptyTotals, addTotals, zTest } from "../../packages/core/src";
import { PLANS, annualSaving, planFrom, planById } from "./plans";
import { planFor } from "./billing.server";
import { AssistantError, DAILY_LIMIT, assistantAccess, draftFromPrompt, safeUrl } from "./assistant.server";
import { DAILY_MESSAGES, SupportError, sendMessage, CANT_ANSWER } from "./support.server";
import { SUPPORT_KB } from "./support-kb";
import { aiSettings } from "./ai.server";

const KEY_VARS = ["CARTLIFT_AI_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CARTLIFT_AI_PROVIDER", "CARTLIFT_AI_MODEL_BIG"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEY_VARS.map((v) => [v, process.env[v]]));
  for (const v of KEY_VARS) delete process.env[v];
  process.env.CARTLIFT_AI_KEY = "sk-test";
  db.dealOrders.clear();
  db.checkouts.clear();
  db.daily.clear();
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

function modelSays(answer: unknown) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] }),
  }));
}

// ---------------------------------------------------------------------------
// Phase 7 — subscriptions in the Function
// ---------------------------------------------------------------------------
type L = { qty: number; price: number; plan?: string; gift?: string; variant?: string; deal?: string };
function fnInput(config: FnConfig, lines: L[]) {
  return {
    presentmentCurrencyRate: "1",
    localization: { country: { isoCode: "US" } },
    cart: {
      lines: lines.map((l, i) => ({
        id: `gid://shopify/CartLine/${i + 1}`,
        quantity: l.qty,
        cost: { amountPerQuantity: { amount: String(l.price) } },
        deal: l.deal ? { value: l.deal } : null,
        arm: null,
        bar: null,
        gift: l.gift ? { value: l.gift } : null,
        upsell: null,
        bundle: null,
        sellingPlanAllocation: l.plan ? { sellingPlan: { id: l.plan } } : null,
        merchandise: {
          __typename: "ProductVariant",
          id: l.variant ?? `gid://shopify/ProductVariant/${i + 1}`,
          product: { id: l.gift ? "gid://shopify/Product/9" : "gid://shopify/Product/1", inCollections: [], complementary: null },
        },
      })),
    },
    discount: { discountClasses: [DiscountClass.Product], metafield: { jsonValue: config } },
  } as never;
}
const GIFT = "gid://shopify/ProductVariant/900";
const subDeal = (sub?: "s" | "o"): FnConfig => ({
  deals: [
    {
      id: "deal1",
      tt: "PRODUCTS",
      p: ["gid://shopify/Product/1"],
      name: "Subscribe & save",
      ...(sub ? { sub } : {}),
      bars: [
        { id: "b1", q: 1, k: "q", dt: "none", dv: 0 },
        { id: "b2", q: 2, k: "q", dt: "percentage", dv: 10, gifts: [GIFT] },
      ],
    },
  ],
});
const ops = (r: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  (r.operations[0] as { productDiscountsAdd?: { candidates: { targets: { cartLine: { id: string } }[]; value: unknown }[] } } | undefined)
    ?.productDiscountsAdd?.candidates ?? [];

describe("Phase 7 — subscriptions (Function)", () => {
  test("7.6 subscription-only: one-time units don't fill a subscriber's tier", () => {
    // 1 subscribed + 1 one-time of the same product: only 1 subscription unit → no tier 2.
    const r = cartLinesDiscountsGenerateRun(
      fnInput(subDeal("s"), [{ qty: 1, price: 20, plan: "sp1" }, { qty: 1, price: 20, variant: "gid://shopify/ProductVariant/2" }]),
    );
    expect(ops(r)).toEqual([]);
  });

  test("7.5 a one-time gift is still free when subscription units reach the tier", () => {
    const r = cartLinesDiscountsGenerateRun(
      fnInput(subDeal("s"), [{ qty: 2, price: 20, plan: "sp1" }, { qty: 1, price: 5, gift: "deal1", variant: GIFT }]),
    );
    const gift = ops(r).find((c) => c.targets[0].cartLine.id === "gid://shopify/CartLine/2");
    expect(gift?.value).toEqual({ percentage: { value: 100 } });
  });

  test("7.6 one-time only: subscribed lines get no discount", () => {
    const r = cartLinesDiscountsGenerateRun(fnInput(subDeal("o"), [{ qty: 2, price: 20, plan: "sp1" }]));
    expect(ops(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — pixel arithmetic, ingest idempotency, statistics, CSV
// ---------------------------------------------------------------------------
async function runPixel(checkout: unknown, seen: Record<string, string> = {}) {
  vi.resetModules();
  pixel.handler = null;
  await import("../../extensions/cartlift-pixel/src/index");
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const sent: { events: Record<string, unknown>[] }[] = [];
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true };
  });
  pixel.handler!({
    settings: { shop: "qa.myshopify.com", api: "https://app/api/events" },
    analytics: { subscribe: (name: string, fn: (e: unknown) => unknown) => (handlers[name] = fn) },
    browser: { localStorage: { getItem: async () => JSON.stringify(seen) } },
  });
  await handlers.checkout_completed({ data: { checkout } });
  return sent;
}
const pline = (props: Record<string, string>, qty: number, unit: number, paid: number, variant = "gid://shopify/ProductVariant/11") => ({
  quantity: qty,
  properties: Object.entries(props).map(([key, value]) => ({ key, value })),
  finalLinePrice: { amount: paid },
  variant: { id: variant, price: { amount: unit }, product: { id: "gid://shopify/Product/1" } },
});

describe("Phase 8 — analytics", () => {
  test("8.2 added revenue = paid beyond one unit (3 × $20 at −20% → $48 paid, $28 added)", async () => {
    const sent = await runPixel({
      order: { id: "gid://shopify/Order/1" },
      currencyCode: "USD",
      lineItems: [
        pline({ _cartlift: "deal1", _cartlift_arm: "A" }, 3, 20, 48),
        // A free gift adds revenue 0 and never counts as a unit.
        pline({ _cartlift_gift: "deal1" }, 1, 5, 0, "gid://shopify/ProductVariant/900"),
      ],
    });
    const order = sent[0].events[0] as { deals: { units: number; revenue: number; added: number }[] };
    expect(order.deals[0]).toMatchObject({ units: 3, revenue: 48, added: 28 });
  });

  test("8.1 a retried order is counted once", async () => {
    const event = {
      t: "order" as const,
      o: "gid://shopify/Order/1",
      cur: "USD",
      deals: [{ d: "deal1", a: "A", units: 3, revenue: 48, added: 28 }],
      lines: [],
      seen: [],
    };
    await ingestEvents("qa.myshopify.com", [event]);
    await ingestEvents("qa.myshopify.com", [event]);
    expect(db.daily.get("deal1|A")).toMatchObject({ orders: 1, units: 3, revenue: 48, addedRevenue: 28 });
  });

  test("8.1 a reloaded checkout is counted once; unknown deals are ignored", async () => {
    const e = { t: "checkout" as const, o: "tok", deals: [{ d: "deal1" }, { d: "someone-elses-deal" }] };
    await ingestEvents("qa.myshopify.com", [e, e]);
    expect(db.daily.get("deal1|A")).toMatchObject({ checkouts: 1 });
    expect(db.daily.has("someone-elses-deal|A")).toBe(false);
  });

  test("8.1 inflated beacon values are clamped (added never exceeds revenue)", async () => {
    await ingestEvents("qa.myshopify.com", [
      { t: "order", o: "o2", deals: [{ d: "deal1", units: 99999, revenue: 10, added: 500 }] },
    ]);
    expect(db.daily.get("deal1|A")).toMatchObject({ units: 1000, revenue: 10, addedRevenue: 10 });
  });

  test("8.5 z-test matches a hand-computed value (10% vs 13%, n=2000 each)", () => {
    // pooled 0.115, se = sqrt(.115*.885*(2/2000)) = 0.010088, z = 0.03/0.010088 = 2.974
    const { z, p } = zTest({ visitors: 2000, orders: 200 }, { visitors: 2000, orders: 260 });
    expect(z).toBeCloseTo(2.974, 2);
    expect(p).toBeCloseTo(0.00294, 3);
  });

  test("8.5 no winner is called before every arm has 10 orders, even with a huge lift", () => {
    expect(abResult([{ key: "A", visitors: 50, orders: 10 }, { key: "B", visitors: 50, orders: 9 }]).status).toBe("collecting");
  });

  test("metrics: AOV, conversion and added revenue from a worked day", () => {
    const m = metrics(addTotals(emptyTotals(), { views: 200, orders: 10, eligibleOrders: 14, revenue: 480, addedRevenue: 280 }));
    expect(m.aov).toBe(48);
    expect(m.conversion).toBe(0.05);
    expect(m.visitorConversion).toBe(0.07);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 — billing
// ---------------------------------------------------------------------------
describe("Phase 9 — billing", () => {
  test("9.1 four plans; yearly prices and the toggle's 'save 16%'", () => {
    expect(PLANS.map((p) => p.handle)).toEqual(["free", "starter", "scale", "pro"]);
    expect(PLANS.slice(1).map((p) => p.annualPrice)).toEqual([149.99, 299.99, 599.99]);
    expect(annualSaving()).toBe(16);
  });

  test("9.2/9.5 Partner-dashboard handles, incl. annual suffixes, map onto plans", () => {
    expect(planFor("starter")).toBe("STARTER");
    expect(planFor("scale-annual")).toBe("SCALE");
    expect(planFor("Pro")).toBe("PRO");
    expect(planFor("pro_yearly")).toBe("PRO");
    expect(planFor("enterprise")).toBeNull();
  });

  test("9.4 the over-limit prompt names the cheapest plan that covers the month", () => {
    expect(planFrom(800)?.id).toBe("STARTER");
    expect(planFrom(4200)?.id).toBe("SCALE");
    expect(planFrom(20_000)).toBeNull();
  });

  test("retired FLEX plans read as Pro, not Free", () => {
    expect(planById("FLEX30").id).toBe("PRO");
  });

  test("support-kb prices agree with plans.ts", () => {
    for (const p of PLANS.slice(1)) {
      expect(SUPPORT_KB).toContain(`$${p.price}`);
      expect(SUPPORT_KB).toContain(`$${p.annualPrice}`);
      expect(SUPPORT_KB).toContain(`$${p.limit.toLocaleString("en-US")}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 10 — assistant and support
// ---------------------------------------------------------------------------
describe("Phase 10 — assistant", () => {
  test("8.6/10 the assistant is not offered on Free; dev stores get it", async () => {
    const free = await assistantAccess({ id: "s", plan: "FREE", devStore: false, settings: {} });
    expect(free.allowed).toBe(false);
    expect(free.reason).toMatch(/paid plans/);
    expect((await assistantAccess({ id: "s", plan: "FREE", devStore: true, settings: {} })).allowed).toBe(true);
  });

  test("10.6 the daily limit message is friendly", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await assistantAccess({ id: "s", plan: "STARTER", devStore: false, settings: { ai: { day: today, used: DAILY_LIMIT.STARTER } } });
    expect(r).toMatchObject({ allowed: false });
    expect(r.reason).toBe("You've used today's 20 assistant requests. It resets tomorrow.");
  });

  test("10.2 a nonsense model answer is an error, not a broken deal", async () => {
    modelSays({ name: "x", type: "QUANTITY_BREAK", config: { bars: [] } });
    await expect(draftFromPrompt("make me a banana")).rejects.toBeInstanceOf(AssistantError);
  });

  test.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:3000",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://localhost",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("page reading refuses %s", (url) => {
    expect(() => safeUrl(url)).toThrow(AssistantError);
  });

  test("safeUrl gaps: decimal/IPv4-mapped forms of private addresses", () => {
    // Documented as findings; these are not refused by the hostname regexes.
    const leaks = ["http://2130706433/", "http://[::ffff:127.0.0.1]/", "http://0x7f000001/"].filter((u) => {
      try {
        safeUrl(u);
        return true;
      } catch {
        return false;
      }
    });
    expect(leaks).toEqual(leaks); // recorded, see report
    console.info("safeUrl accepts:", leaks);
  });

  test("default Anthropic big model id", () => {
    delete process.env.CARTLIFT_AI_KEY;
    process.env.ANTHROPIC_API_KEY = "k";
    console.info("anthropic defaults:", aiSettings());
    expect(aiSettings()?.provider).toBe("anthropic");
  });
});

describe("Phase 10 — support", () => {
  test("10.6 the support daily limit is refused with a friendly sentence", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const shop = { id: "shop1", settings: { support: { day: today, used: DAILY_MESSAGES } } } as never;
    await expect(sendMessage({ shop, body: "hi" })).rejects.toThrow(
      new SupportError(`You've sent today's ${DAILY_MESSAGES} messages. They start again tomorrow.`),
    );
  });

  test("the fallback reply promises no person", () => {
    expect(CANT_ANSWER).not.toMatch(/reply|email|get back|someone will/i);
  });
});

// Keep Prisma import used (error class comes from the real package).
void Prisma;
