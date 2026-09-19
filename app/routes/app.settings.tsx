import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShop } from "../lib/sync.server";
import { blockDeepLink, embedDeepLink, embedStatus } from "../lib/theme.server";
import { TextArea } from "../components/fields";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const settings = (shop.settings ?? {}) as { customCss?: string };
  const embed = await embedStatus(admin);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return {
    customCss: settings.customCss ?? "",
    embedEnabled: embed.enabled,
    themeName: embed.themeName ?? null,
    embedUrl: embedDeepLink(session.shop, apiKey),
    blockUrl: blockDeepLink(session.shop, apiKey),
    publishedAt: shop.publishedAt?.toISOString() ?? null,
    discountId: shop.discountId,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "css") {
    const customCss = String(form.get("customCss") ?? "").slice(0, 20_000);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
    const settings = { ...((shop.settings ?? {}) as object), customCss };
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: settings as Prisma.InputJsonValue } });
  }

  try {
    await syncShop(admin, session.shop, { force: intent === "republish" });
    return { ok: true, message: intent === "republish" ? "Deals republished" : "Settings saved" };
  } catch (error) {
    console.error("Sync failed", error);
    return { ok: false, message: "Publishing to your store failed. Try again in a moment." };
  }
};

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [css, setCss] = useState(d.customCss);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <s-page heading="Settings">
      <s-section heading="Theme setup">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>App embed in {d.themeName ?? "your live theme"}:</s-text>
            {d.embedEnabled === true ? (
              <s-badge tone="success">On</s-badge>
            ) : d.embedEnabled === false ? (
              <s-badge tone="critical">Off</s-badge>
            ) : (
              <s-badge>Unknown</s-badge>
            )}
          </s-stack>
          <s-paragraph>
            With the embed on, CartLift places deals above the add-to-cart button automatically. For a custom
            position, add the “CartLift deals” block to your product template instead.
          </s-paragraph>
          <s-button-group>
            <s-button href={d.embedUrl} target="_blank" variant="primary">
              {d.embedEnabled ? "Open app embeds" : "Turn on app embed"}
            </s-button>
            <s-button href={d.blockUrl} target="_blank">
              Add block to product page
            </s-button>
          </s-button-group>
        </s-stack>
      </s-section>

      <s-section heading="Custom CSS">
        <s-stack gap="base">
          <TextArea
            label="CSS added to product pages that show a deal"
            details="Target .cl-block, .cl-bar, .cl-bar.is-selected, .cl-badge, .cl-price and so on."
            value={css}
            onChange={setCss}
            rows={8}
          />
          <div>
            <s-button
              loading={fetcher.state !== "idle" || undefined}
              onClick={() => fetcher.submit({ intent: "css", customCss: css }, { method: "post" })}
            >
              Save CSS
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Troubleshooting">
        <s-stack gap="base">
          <s-paragraph>
            Last published: {d.publishedAt ? new Date(d.publishedAt).toLocaleString() : "never"}.
            {d.discountId ? " The CartLift automatic discount is installed." : " The CartLift discount is created when you save your first deal."}
          </s-paragraph>
          <s-paragraph>
            Add <code>?cartlift=off</code> to any product URL to view the page without CartLift.
          </s-paragraph>
          <div>
            <s-button onClick={() => fetcher.submit({ intent: "republish" }, { method: "post" })}>Republish deals</s-button>
          </div>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
