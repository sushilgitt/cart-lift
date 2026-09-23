import type { Plan } from "@prisma/client";

import prisma from "../db.server";
import { AiError, askJson } from "./ai.server";
import {
  DISCOUNT_LABELS,
  defaultConfig,
  normalizeConfig,
  validateConfig,
  type DealConfig,
  type DealTypeKey,
} from "./deals";

/**
 * The deal assistant: a merchant describes an offer in their own words (or
 * points at a page that has one) and gets a *draft* back.
 *
 * Three rules shape everything here:
 *  1. The model never writes to the store. It proposes a deal; the merchant
 *     reads it in the editor and saves it themselves.
 *  2. Whatever comes back goes through `normalizeConfig` and `validateConfig`,
 *     the same gate the editor uses, so a strange answer becomes a sensible
 *     deal or an error — never a broken one.
 *  3. Every call costs money, so it is gated by plan and by a daily count.
 */

/** Deals the assistant can write, in the words the model is given. */
const TYPES = `"QUANTITY_BREAK" (tiers of the same product), "BXGY" (buy X get Y), "BUNDLE" (a set of different products)`;

const SHAPE = `{
  "name": "a short name a shopkeeper would use, e.g. \\"Bundle & save\\"",
  "note": "one sentence for the merchant: what you built, and anything they still have to do",
  "type": ${TYPES},
  "config": {
    "bars": [
      {
        "qty": 2,                       // units this tier is about
        "kind": "qty" | "bxgy",
        "get": 0,                        // bxgy only: how many are free/discounted
        "discountType": ${Object.keys(DISCOUNT_LABELS).map((k) => `"${k}"`).join(" | ")},
        "discountValue": 10,             // percent, amount in whole currency, or fixed total
        "title": "Buy 2",
        "subtitle": "You save {{saved_percentage}}",
        "label": "SAVE {{saved_amount}}",   // small tag on the bar, optional
        "badge": "Most popular",            // corner badge, optional
        "selected": true,                   // exactly one bar
        "giftText": "+ FREE tote bag"       // only when this tier comes with a gift
      }
    ],
    "style": { "blockTitle": "BUNDLE & SAVE" }
  }
}`;

const VARIABLES = "{{quantity}}, {{price}}, {{full_price}}, {{unit_price}}, {{saved_amount}}, {{saved_percentage}}";

const SYSTEM = [
  "You design quantity-break and bundle offers for Shopify stores, for an app called CartLift.",
  "You reply with a JSON object only — no prose, no code fence — in this shape:",
  SHAPE,
  "Rules:",
  `- Text fields may use these variables, which the storefront fills in: ${VARIABLES}. Prefer them over writing numbers into text.`,
  "- Two to four bars is the useful range. The first bar is normally the plain single item at no discount.",
  "- Exactly one bar has \"selected\": true — usually the middle or best-value one.",
  "- Discounts grow with quantity. Never discount a smaller tier more than a bigger one.",
  "- Keep every text short enough for a small bar on a phone: a few words.",
  "- Write the texts in the same language the merchant used.",
  "- Never invent product names, prices or collections; the merchant picks products afterwards.",
  "- Every bar has a different \"qty\". Two bars of the same size are not allowed.",
  "Choosing the type:",
  "- Buying more of the SAME product at a better price is QUANTITY_BREAK — including when a tier also comes with a free gift.",
  "- BXGY is only for 'buy X, get Y free or discounted'.",
  "- BUNDLE is only for a fixed set of DIFFERENT products bought together.",
  "Buy X get Y, exactly:",
  "- \"qty\" is the TOTAL units the shopper ends up with, and \"get\" is how many of those are free or discounted, so \"get\" is at least 1 and always smaller than \"qty\".",
  "- Buy one get one free is one bar with kind \"bxgy\", qty 2, get 1, discountType \"percentage\", discountValue 100.",
  "- Buy 3 get 2 at half price is qty 5, get 2, discountType \"percentage\", discountValue 50.",
  "Free gifts:",
  "- A gift belongs to a tier: put its wording in that bar's \"giftText\" and say in \"note\" that the merchant still has to pick the gift product in the editor.",
  "- Never invent a gift the merchant didn't ask for, and never put a gift on every tier.",
].join("\n");

export class AssistantError extends Error {}

/** What the assistant proposes: a draft the merchant reviews. */
export interface DealDraft {
  name: string;
  type: DealTypeKey;
  config: DealConfig;
  /** One sentence on what was built, shown above the draft. */
  note: string;
}

const DEAL_TYPES: DealTypeKey[] = ["QUANTITY_BREAK", "BXGY", "BUNDLE"];

/** Turns whatever the model sent into a deal the editor can open, or throws. */
function draftFrom(raw: Record<string, unknown>, fallbackName: string): DealDraft {
  const type = DEAL_TYPES.includes(raw.type as DealTypeKey) ? (raw.type as DealTypeKey) : "QUANTITY_BREAK";
  const config = normalizeConfig(raw.config, type);
  const errors = validateConfig(config);
  if (errors.length) {
    // The model wrote something the editor would reject; say so plainly.
    console.error("Assistant draft rejected", errors);
    throw new AssistantError(`The draft came back with problems: ${errors.slice(0, 3).join(" ")}`);
  }
  const name = String(raw.name ?? "").trim().slice(0, 120) || fallbackName;
  return { name, type, config, note: String(raw.note ?? "").trim().slice(0, 300) };
}

/** A deal from a sentence: "buy 2 save 10%, buy 3 save 20%, gift on the top tier". */
export async function draftFromPrompt(prompt: string): Promise<DealDraft> {
  const text = prompt.trim().slice(0, 4000);
  if (!text) throw new AssistantError("Say what the offer should be.");
  return draftFrom(await ask(`Build this offer:\n\n${text}`), "New deal");
}

/**
 * A deal from a page that already shows one — a competitor's product page, or
 * the merchant's own. The page is fetched here (see `fetchPageText`), stripped
 * to text, and handed over as evidence.
 */
export async function draftFromUrl(url: string): Promise<DealDraft> {
  const page = await fetchPageText(url);
  return draftFrom(
    await ask(
      [
        "This is the text of a product page that shows a quantity offer.",
        "Work out the tiers it offers and rebuild them as a CartLift deal.",
        "Ignore prices of specific products; keep the discounts and the wording style.",
        "",
        page,
      ].join("\n"),
    ),
    "Deal from a page",
  );
}

/** A deal from a screenshot of an offer. */
export async function draftFromImage(image: { media: string; base64: string }): Promise<DealDraft> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(image.media)) {
    throw new AssistantError("Use a PNG, JPEG, WebP or GIF screenshot.");
  }
  return draftFrom(
    await ask("This screenshot shows a quantity offer. Rebuild it as a CartLift deal.", [image]),
    "Deal from a screenshot",
  );
}

/**
 * A change to a deal the merchant is editing, in their own words. The whole
 * config is sent back so the editor can drop it in; the merchant still saves.
 */
export async function editDeal(
  current: { name: string; type: DealTypeKey; config: DealConfig },
  instruction: string,
): Promise<DealDraft> {
  const text = instruction.trim().slice(0, 2000);
  if (!text) throw new AssistantError("Say what should change.");
  const draft = await ask(
    [
      "Here is the deal as it is now:",
      JSON.stringify({ name: current.name, type: current.type, config: trimConfig(current.config) }, null, 2),
      "",
      `Change it as asked, and reply with the whole deal in the same shape: ${text}`,
      "Keep everything the merchant didn't ask to change.",
    ].join("\n"),
  );
  // An edit keeps the parts of the config the model was never shown.
  const merged = { ...draft, config: { ...(current.config as object), ...((draft.config ?? {}) as object) } };
  return draftFrom(merged as Record<string, unknown>, current.name);
}

/**
 * The parts of a config worth showing the model. Style colours, A/B arms and
 * translations are long and rarely what the merchant is asking about; leaving
 * them out keeps the call small (and cheap) and they are merged back after.
 */
function trimConfig(config: DealConfig) {
  return {
    bars: config.bars,
    across: config.across,
    progressiveGifts: config.progressiveGifts,
    subscriptions: config.subscriptions,
    style: { blockTitle: config.style.blockTitle, layout: config.style.layout },
  };
}

async function ask(user: string, images?: { media: string; base64: string }[]) {
  try {
    return await askJson<Record<string, unknown>>({
      system: SYSTEM,
      user,
      images,
      // Writing a whole deal is worth the bigger model.
      size: "big",
      maxTokens: 4000,
    });
  } catch (error) {
    throw new AssistantError(error instanceof AiError ? error.message : "The assistant could not answer. Try again.");
  }
}

/* -------------------------------------------------------------------------- */
/* Fetching a page the merchant pointed at                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a URL a merchant typed and returns its visible text.
 *
 * A merchant-supplied URL is fetched *by our server*, so it is only allowed to
 * be a public http(s) page: no other schemes, no addresses inside our own
 * network, and a size and time limit. Redirects are followed by fetch, so the
 * final host is checked again.
 */
export async function fetchPageText(url: string): Promise<string> {
  const target = safeUrl(url);
  let response: Response;
  try {
    response = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "CartLift/1.0 (+https://apps.shopify.com)", Accept: "text/html" },
    });
  } catch {
    throw new AssistantError("That page could not be loaded. Check the address.");
  }
  if (!response.ok) throw new AssistantError(`That page answered ${response.status}.`);
  // The address we ended up at matters as much as the one we asked for.
  safeUrl(response.url || target.toString());

  const type = response.headers.get("content-type") || "";
  if (!/text\/html|text\/plain/.test(type)) throw new AssistantError("That address is not a web page.");

  const html = (await response.text()).slice(0, 400_000);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 20) throw new AssistantError("That page had no text to read.");
  return text.slice(0, 12_000);
}

/** http(s), a real host, and not something inside our own network. */
export function safeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new AssistantError("That doesn't look like a web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AssistantError("Only http and https addresses can be read.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    // 127.x, 10.x, 192.168.x, 172.16–31.x, 169.254.x (link-local / cloud metadata)
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    /^fc|^fd|^fe80:/.test(host);
  if (privateHost) throw new AssistantError("That address is not reachable from the internet.");
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Who may use it, and how often                                               */
/* -------------------------------------------------------------------------- */

/** Assistant calls a shop may make per day, by plan. */
export const DAILY_LIMIT: Record<Plan, number> = {
  FREE: 0,
  STARTER: 20,
  SCALE: 50,
  PRO: 100,
  FLEX20: 200,
  FLEX30: 200,
  FLEX40: 300,
  FLEX50: 300,
};

export interface AssistantAccess {
  allowed: boolean;
  used: number;
  limit: number;
  reason?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Whether this shop can ask the assistant right now, and what it has used. */
export async function assistantAccess(shop: {
  id: string;
  plan: Plan;
  devStore: boolean;
  settings: unknown;
}): Promise<AssistantAccess> {
  // Development stores get the paid experience, so the app can be tried out.
  const limit = shop.devStore ? DAILY_LIMIT.PRO : DAILY_LIMIT[shop.plan];
  const usage = ((shop.settings as { ai?: { day?: string; used?: number } } | null)?.ai ?? {}) as {
    day?: string;
    used?: number;
  };
  const used = usage.day === today() ? Number(usage.used) || 0 : 0;

  if (!limit) return { allowed: false, used, limit, reason: "The assistant is on the paid plans." };
  if (used >= limit) {
    return { allowed: false, used, limit, reason: `You've used today's ${limit} assistant requests. It resets tomorrow.` };
  }
  return { allowed: true, used, limit };
}

/** Counts one request against today's allowance. */
export async function countAssistantUse(shopId: string, settings: unknown) {
  const current = ((settings as { ai?: { day?: string; used?: number } } | null)?.ai ?? {}) as {
    day?: string;
    used?: number;
  };
  const used = current.day === today() ? (Number(current.used) || 0) + 1 : 1;
  const next = { ...((settings ?? {}) as object), ai: { day: today(), used } };
  await prisma.shop.update({ where: { id: shopId }, data: { settings: next as never } });
}

/** A starting point when the merchant asks for "something", so the editor is never empty. */
export const blankDraft = (type: DealTypeKey = "QUANTITY_BREAK"): DealDraft => ({
  name: "New deal",
  type,
  config: defaultConfig(type),
  note: "",
});
