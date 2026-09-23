import type { Shop, SupportThread } from "@prisma/client";

import prisma from "../db.server";
import { AiError, aiSettings, askJson } from "./ai.server";
import { ESCALATE_WHEN, SUPPORT_KB } from "./support-kb";
import { planById } from "./plans";

/**
 * In-app support: a merchant asks a question and gets an answer grounded in
 * what CartLift actually does (support-kb.ts) plus the state of their own shop.
 *
 * Two rules:
 *  1. The assistant answers from the knowledge base or says it doesn't know and
 *     offers a person. It must never invent a setting, a price or a promise.
 *  2. Nothing about shoppers is sent — only the merchant's own question and
 *     facts about their shop's setup (plan, embed, how many deals are live).
 */

export class SupportError extends Error {}

/** Messages one shop may send per day, whatever their plan. Support is not a paid feature. */
export const DAILY_MESSAGES = 30;

const today = () => new Date().toISOString().slice(0, 10);

interface SupportUsage {
  day?: string;
  used?: number;
}

/** How many messages this shop has sent today. */
export function messagesToday(shop: Pick<Shop, "settings">): number {
  const usage = ((shop.settings as { support?: SupportUsage } | null)?.support ?? {}) as SupportUsage;
  return usage.day === today() ? Number(usage.used) || 0 : 0;
}

async function countMessage(shop: Pick<Shop, "id" | "settings">) {
  const used = messagesToday(shop) + 1;
  const next = { ...((shop.settings ?? {}) as object), support: { day: today(), used } };
  await prisma.shop.update({ where: { id: shop.id }, data: { settings: next as never } });
}

/** Facts about this shop the answer may rely on. Never anything about shoppers. */
export interface ShopContext {
  plan: string;
  devStore: boolean;
  embedOn: boolean | null;
  activeDeals: number;
  totalDeals: number;
  published: boolean;
}

export async function shopContext(shop: Shop, embedOn: boolean | null = null): Promise<ShopContext> {
  const [activeDeals, totalDeals] = await Promise.all([
    prisma.deal.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
    prisma.deal.count({ where: { shopId: shop.id } }),
  ]);
  return {
    plan: planById(shop.plan).name,
    devStore: shop.devStore,
    embedOn,
    activeDeals,
    totalDeals,
    published: Boolean(shop.publishedAt),
  };
}

const SYSTEM = [
  "You are CartLift's support assistant, answering the merchant who installed the app.",
  "Everything you know about CartLift is below, between <cartlift> tags. It is the only source you may use.",
  "",
  "<cartlift>",
  SUPPORT_KB,
  "</cartlift>",
  "",
  "How to answer:",
  "- Be short and concrete. Two or three sentences is usually right; use a numbered list for steps.",
  "- Use the shop's own facts when they are given (their plan, whether the app embed is on, how many deals are live) — they often answer the question by themselves.",
  "- Write in the language the merchant wrote in.",
  "- Never invent settings, prices, timelines or promises. If the answer isn't in what you were given, say you're not sure and offer to pass it to a person.",
  `- Hand over to a person for: ${ESCALATE_WHEN.join("; ")}.`,
  "- Never ask for a password, an API key or card details, and never claim to have changed anything in their shop: you can only explain and point.",
  "",
  'Reply with JSON only: {"reply": "your answer", "human": true|false}.',
  '"human" is true when a person should follow up.',
].join("\n");

export interface SupportAnswer {
  reply: string;
  human: boolean;
}

/** Whether the AI side of support is switched on at all. */
export const supportAiReady = () => Boolean(aiSettings());

/**
 * Answers a merchant's question. Falls back to a plain "a person will reply"
 * message when no AI service is configured, so support always does something.
 */
export async function answerQuestion(
  question: string,
  context: ShopContext,
  history: { author: string; body: string }[] = [],
): Promise<SupportAnswer> {
  const text = question.trim().slice(0, 4000);
  if (!text) throw new SupportError("Write your question first.");

  const conversation = history
    .slice(-8)
    .map((m) => `${m.author === "MERCHANT" ? "Merchant" : "Support"}: ${m.body}`)
    .join("\n");

  try {
    const answer = await askJson<{ reply?: unknown; human?: unknown }>({
      system: SYSTEM,
      user: [
        `This shop: plan ${context.plan}${context.devStore ? " (development store)" : ""}, ` +
          `${context.activeDeals} of ${context.totalDeals} deals active, ` +
          `app embed ${context.embedOn === null ? "unknown" : context.embedOn ? "on" : "off"}, ` +
          `${context.published ? "deals published" : "nothing published yet"}.`,
        conversation ? `\nSo far:\n${conversation}` : "",
        `\nThe merchant asks:\n${text}`,
      ].join("\n"),
      size: "small",
      maxTokens: 1200,
    });

    const reply = String(answer.reply ?? "").trim();
    if (!reply) throw new SupportError("The answer came back empty. Try again, or ask for a person.");
    return { reply: reply.slice(0, 4000), human: Boolean(answer.human) };
  } catch (error) {
    if (error instanceof SupportError) throw error;
    throw new SupportError(
      error instanceof AiError
        ? error.message
        : "Support couldn't answer just now. Ask for a person and we'll follow up.",
    );
  }
}

/**
 * What a merchant is told when the assistant can't answer — because no AI
 * service is configured, or the request failed. It states what actually
 * happened and promises nothing the app can't keep: the app offers no way to
 * reach a person, so it doesn't pretend to.
 */
export const CANT_ANSWER =
  "Thanks — this is saved to your conversation. CartLift's assistant couldn't answer this one.";

export interface ThreadWithMessages extends SupportThread {
  messages: { id: string; author: string; body: string; createdAt: Date }[];
}

/** Starts a conversation, or adds to one, and writes the answer. */
export async function sendMessage(options: {
  shop: Shop;
  threadId?: string | null;
  body: string;
  embedOn?: boolean | null;
}): Promise<{ threadId: string }> {
  const body = options.body.trim().slice(0, 4000);
  if (!body) throw new SupportError("Write your message first.");

  if (messagesToday(options.shop) >= DAILY_MESSAGES) {
    throw new SupportError(`You've sent today's ${DAILY_MESSAGES} messages. They start again tomorrow.`);
  }

  // The thread has to belong to this shop — a thread id from elsewhere is not a way in.
  let thread =
    options.threadId
      ? await prisma.supportThread.findFirst({
          where: { id: options.threadId, shopId: options.shop.id },
          include: { messages: { orderBy: { createdAt: "asc" } } },
        })
      : null;
  if (options.threadId && !thread) throw new SupportError("That conversation is not on this shop.");

  if (!thread) {
    thread = await prisma.supportThread.create({
      data: { shopId: options.shop.id, subject: body.slice(0, 120) },
      include: { messages: true },
    });
  }

  await prisma.supportMessage.create({ data: { threadId: thread.id, author: "MERCHANT", body } });
  await countMessage(options.shop);

  // No AI configured: say so honestly and flag the thread for a person to read.
  if (!supportAiReady()) {
    await prisma.supportMessage.create({ data: { threadId: thread.id, author: "ASSISTANT", body: CANT_ANSWER } });
    await prisma.supportThread.update({
      where: { id: thread.id },
      data: { needsHuman: true, updatedAt: new Date() },
    });
    return { threadId: thread.id };
  }

  const context = await shopContext(options.shop, options.embedOn ?? null);
  let answer: SupportAnswer;
  try {
    answer = await answerQuestion(body, context, thread.messages ?? []);
  } catch (error) {
    // A failure still leaves the merchant with a thread and a person to answer it.
    await prisma.supportMessage.create({ data: { threadId: thread.id, author: "ASSISTANT", body: CANT_ANSWER } });
    await prisma.supportThread.update({ where: { id: thread.id }, data: { needsHuman: true, updatedAt: new Date() } });
    console.error("Support answer failed", error);
    return { threadId: thread.id };
  }

  await prisma.supportMessage.create({ data: { threadId: thread.id, author: "ASSISTANT", body: answer.reply } });
  await prisma.supportThread.update({
    where: { id: thread.id },
    data: { needsHuman: answer.human, updatedAt: new Date() },
  });
  return { threadId: thread.id };
}

/** This shop's conversations, newest first. */
export function listThreads(shopId: string) {
  return prisma.supportThread.findMany({
    where: { shopId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    include: { messages: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
}

/** One conversation of this shop, with everything said in it. */
export function getThread(shopId: string, id: string) {
  return prisma.supportThread.findFirst({
    where: { id, shopId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}
