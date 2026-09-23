import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { nextPriority, shopIdFor } from "../lib/deal.server";
import {
  AssistantError,
  assistantAccess,
  countAssistantUse,
  draftFromImage,
  draftFromPrompt,
  draftFromUrl,
  type DealDraft,
} from "../lib/assistant.server";
import { aiSettings } from "../lib/ai.server";
import { useT } from "../lib/admin-i18n";
import { TextArea, TextField } from "../components/fields";
import type { Prisma } from "@prisma/client";

/**
 * "Describe an offer" → a draft deal.
 *
 * The assistant only ever creates a *draft*: it is saved paused, and the
 * merchant opens it in the editor, checks it and turns it on. Nothing the model
 * writes reaches a storefront without a person looking at it first.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const access = await assistantAccess(shop);
  return {
    configured: Boolean(aiSettings()),
    access,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const access = await assistantAccess(shop);
  if (!access.allowed) return { ok: false, error: access.reason ?? "The assistant isn't available on this plan." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "prompt");

  let draft: DealDraft;
  try {
    if (intent === "url") {
      draft = await draftFromUrl(String(form.get("url") ?? ""));
    } else if (intent === "image") {
      const file = form.get("image");
      if (!(file instanceof File) || !file.size) return { ok: false, error: "Choose a screenshot first." };
      if (file.size > 4_000_000) return { ok: false, error: "That screenshot is over 4 MB. Try a smaller one." };
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      draft = await draftFromImage({ media: file.type, base64 });
    } else {
      draft = await draftFromPrompt(String(form.get("prompt") ?? ""));
    }
  } catch (error) {
    if (error instanceof AssistantError) return { ok: false, error: error.message };
    console.error("Assistant failed", error);
    return { ok: false, error: "The assistant could not answer. Try again." };
  }

  // Only successful calls count against the allowance.
  await countAssistantUse(shop.id, shop.settings);

  // Saved paused, so it can't reach a storefront before the merchant looks.
  const deal = await prisma.deal.create({
    data: {
      shopId: await shopIdFor(session.shop),
      name: draft.name,
      type: draft.type,
      status: "DRAFT",
      targetType: "ALL",
      products: [] as unknown as Prisma.InputJsonValue,
      collections: [] as unknown as Prisma.InputJsonValue,
      config: draft.config as unknown as Prisma.InputJsonValue,
      priority: await nextPriority(await shopIdFor(session.shop)),
    },
  });
  return { ok: true, id: deal.id, note: draft.note };
};

export default function Assistant() {
  const t = useT();
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // A finished draft: take the merchant straight into the editor.
  useEffect(() => {
    if (result?.ok && result.id) navigate(`/app/deals/${result.id}`);
  }, [result, navigate]);

  const send = (data: Record<string, string>) => fetcher.submit(data, { method: "post" });

  if (!d.configured) {
    return (
      <s-page heading={t("Assistant")}>
        <s-section>
          <s-paragraph>{t("The assistant isn't switched on for this store.")}</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading={t("Assistant")}>
      {!d.access.allowed && d.access.reason ? <s-banner tone="info">{d.access.reason}</s-banner> : null}
      {result && !result.ok ? <s-banner tone="critical">{result.error}</s-banner> : null}

      <s-section heading={t("Describe the offer")}>
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {t("Write it the way you'd explain it to a colleague. You get a draft deal to check — nothing goes live until you turn it on.")}
          </s-paragraph>
          <TextArea
            label={t("What should the offer be?")}
            details={t("e.g. Buy 2 save 10%, buy 3 save 20%, and a free tote on the biggest tier")}
            value={prompt}
            rows={4}
            onChange={setPrompt}
          />
          <s-button
            variant="primary"
            loading={busy || undefined}
            disabled={!d.access.allowed || !d.configured || undefined}
            onClick={() => send({ intent: "prompt", prompt })}
          >
            {t("Build the deal")}
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading={t("Copy an offer from a page")}>
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {t("Point at a product page that already shows a quantity offer — yours or anyone's. The wording and the tiers come across; products and prices don't.")}
          </s-paragraph>
          <TextField
            label={t("Page address")}
            value={url}
            placeholder="https://example.com/products/tee"
            onChange={setUrl}
          />
          <s-button
            loading={busy || undefined}
            disabled={!d.access.allowed || !d.configured || undefined}
            onClick={() => send({ intent: "url", url })}
          >
            {t("Read the page")}
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading={t("From a screenshot")}>
        <s-stack gap="base">
          <s-paragraph color="subdued">{t("A picture of an offer works too — PNG or JPEG, up to 4 MB.")}</s-paragraph>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" />
          <s-button
            loading={busy || undefined}
            disabled={!d.access.allowed || !d.configured || undefined}
            onClick={() => {
              const chosen = file.current?.files?.[0];
              if (!chosen) return;
              const body = new FormData();
              body.set("intent", "image");
              body.set("image", chosen);
              fetcher.submit(body, { method: "post", encType: "multipart/form-data" });
            }}
          >
            {t("Read the screenshot")}
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading={t("How this works")}>
        <s-unordered-list>
          <s-list-item>{t("The assistant writes a draft. It never turns a deal on, and never changes a deal you already published.")}</s-list-item>
          <s-list-item>{t("Drafts are checked the same way the editor checks them, so a strange answer becomes an error rather than a broken deal.")}</s-list-item>
          <s-list-item>
            {t("Today: {{used}} of {{limit}} requests used.", { used: d.access.used, limit: d.access.limit })}
          </s-list-item>
          <s-list-item>{t("Your products, customers and orders are never sent — only what you type here.")}</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
