import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { embedStatus } from "../lib/theme.server";
import {
  DAILY_MESSAGES,
  SupportError,
  getThread,
  listThreads,
  messagesToday,
  sendMessage,
  supportAiReady,
  supportEmail,
} from "../lib/support.server";
import { useT } from "../lib/admin-i18n";
import { TextArea } from "../components/fields";

/**
 * Support: the merchant asks, CartLift answers from what it actually knows,
 * and anything it can't answer is marked for a person.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const id = new URL(request.url).searchParams.get("thread");
  const thread = id ? await getThread(shop.id, id) : null;

  return {
    ai: supportAiReady(),
    email: supportEmail(),
    left: Math.max(0, DAILY_MESSAGES - messagesToday(shop)),
    threads: (await listThreads(shop.id)).map((t) => ({
      id: t.id,
      subject: t.subject,
      needsHuman: t.needsHuman,
      updatedAt: t.updatedAt.toISOString(),
    })),
    thread: thread
      ? {
          id: thread.id,
          subject: thread.subject,
          needsHuman: thread.needsHuman,
          messages: thread.messages.map((m) => ({
            id: m.id,
            author: m.author,
            body: m.body,
            at: m.createdAt.toISOString(),
          })),
        }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const form = await request.formData();

  // Whether the app embed is on often *is* the answer, so it goes with the question.
  const embed = await embedStatus(admin).catch(() => ({ enabled: null }));

  try {
    const { threadId } = await sendMessage({
      shop,
      threadId: String(form.get("thread") ?? "") || null,
      body: String(form.get("body") ?? ""),
      wantsHuman: form.get("intent") === "human",
      embedOn: embed.enabled,
    });
    return { ok: true, threadId };
  } catch (error) {
    if (error instanceof SupportError) return { ok: false, error: error.message };
    console.error("Support failed", error);
    return { ok: false, error: "Something went wrong sending that. Try again." };
  }
};

export default function Support() {
  const t = useT();
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [body, setBody] = useState("");
  const sent = useRef<string | null>(null);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // A sent message empties the box and opens its conversation.
  useEffect(() => {
    if (fetcher.state !== "idle" || !result?.ok || !result.threadId) return;
    if (sent.current === result.threadId && params.get("thread") === result.threadId) return;
    sent.current = result.threadId;
    setBody("");
    if (params.get("thread") !== result.threadId) navigate(`/app/support?thread=${result.threadId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, result]);

  const send = (intent: "ask" | "human") => {
    if (!body.trim()) return;
    fetcher.submit({ intent, body, thread: d.thread?.id ?? "" }, { method: "post" });
  };

  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <s-page heading={t("Support")}>
      {d.thread ? (
        <s-button slot="primary-action" onClick={() => navigate("/app/support")}>
          {t("New conversation")}
        </s-button>
      ) : null}

      {result && !result.ok ? <s-banner tone="critical">{result.error}</s-banner> : null}

      {d.thread ? (
        <s-section heading={d.thread.subject}>
          <s-stack gap="base">
            {d.thread.messages.map((message) => (
              <Bubble key={message.id} author={message.author} body={message.body} at={when(message.at)} />
            ))}
            {busy ? <s-text color="subdued">{t("Writing a reply…")}</s-text> : null}
            {d.thread.needsHuman ? (
              <s-banner tone="info">
                {t("This conversation is flagged for a person.")}{" "}
                {d.email ? <s-link href={`mailto:${d.email}?subject=${encodeURIComponent(d.thread.subject)}`}>{d.email}</s-link> : null}
              </s-banner>
            ) : null}
          </s-stack>
        </s-section>
      ) : (
        <s-section heading={t("Hi there 👋")}>
          <s-stack gap="base">
            <s-paragraph>
              {d.ai
                ? t("Ask us anything about CartLift — setting up a deal, why one isn't showing, plans and billing.")
                : t("Ask us anything about CartLift. A person reads every message and replies by email.")}
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      <s-section heading={d.thread ? t("Reply") : t("Start a conversation")}>
        <s-stack gap="base">
          <TextArea
            label={t("Your message")}
            details={t("e.g. My deal isn't showing on the product page")}
            value={body}
            rows={4}
            onChange={setBody}
          />
          <s-stack direction="inline" gap="base" alignItems="center">
            {d.ai ? (
              <s-button variant="primary" loading={busy || undefined} disabled={!d.left || undefined} onClick={() => send("ask")}>
                {t("Send")}
              </s-button>
            ) : null}
            <s-button loading={busy || undefined} disabled={!d.left || undefined} onClick={() => send("human")}>
              {t("Talk to a person")}
            </s-button>
            {d.left ? null : <s-text color="subdued">{t("You've reached today's message limit.")}</s-text>}
          </s-stack>
          {d.email ? (
            <s-text color="subdued">
              {t("Or email us at")} <s-link href={`mailto:${d.email}`}>{d.email}</s-link>
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      {d.threads.length ? (
        <s-section heading={t("Your conversations")} padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("Conversation")}</s-table-header>
              <s-table-header>{t("Status")}</s-table-header>
              <s-table-header>{t("Last message")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.threads.map((thread) => (
                <s-table-row key={thread.id}>
                  <s-table-cell>
                    <s-link href={`/app/support?thread=${thread.id}`}>{thread.subject}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {thread.needsHuman ? (
                      <s-badge tone="info">{t("With a person")}</s-badge>
                    ) : (
                      <s-badge tone="success">{t("Answered")}</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>{when(thread.updatedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}
    </s-page>
  );
}

/** One message. Bodies are rendered as text — never as HTML. */
function Bubble({ author, body, at }: { author: string; body: string; at: string }) {
  const t = useT();
  const mine = author === "MERCHANT";
  const who = mine ? t("You") : author === "HUMAN" ? t("CartLift support") : t("CartLift assistant");
  return (
    <s-box
      padding="base"
      borderRadius="base"
      background={mine ? "subdued" : undefined}
      border={mine ? undefined : "base"}
    >
      <s-stack gap="small-200">
        <s-text color="subdued">
          {who} · {at}
        </s-text>
        {body.split(/\n{2,}/).map((paragraph, i) => (
          <s-paragraph key={i}>{paragraph}</s-paragraph>
        ))}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
