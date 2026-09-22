import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShop } from "../lib/sync.server";
import { blockDeepLink, embedDeepLink, embedStatus, themeSettings } from "../lib/theme.server";
import { ColorField, TextArea } from "../components/fields";
import { paletteFromSettings } from "../lib/brand";
import {
  BRAND_GROUPS,
  BRAND_LINKS,
  normalizeConfig,
  normalizePalette,
  type BrandPalette,
  type DealTypeKey,
} from "../lib/deals";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const settings = (shop.settings ?? {}) as { customCss?: string; brandPalette?: unknown };
  const embed = await embedStatus(admin);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return {
    customCss: settings.customCss ?? "",
    palette: normalizePalette(settings.brandPalette),
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

  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const saveSettings = (changes: Record<string, unknown>) =>
    prisma.shop.update({
      where: { id: shop.id },
      data: { settings: { ...((shop.settings ?? {}) as object), ...changes } as Prisma.InputJsonValue },
    });

  if (intent === "css") {
    await saveSettings({ customCss: String(form.get("customCss") ?? "").slice(0, 20_000) });
  } else if (intent === "scan") {
    const theme = await themeSettings(admin);
    if (!theme) return { ok: false, message: "Couldn't read your theme's colours.", palette: null };
    await saveSettings({ brandPalette: paletteFromSettings(theme) });
  } else if (intent === "palette") {
    let raw: unknown = null;
    try {
      raw = JSON.parse(String(form.get("palette") ?? "null"));
    } catch {
      // Ignored: treated as an empty palette.
    }
    await saveSettings({ brandPalette: normalizePalette(raw) });
  } else if (intent === "apply-brand") {
    // Link every deal's (and running variant's) colours to the palette.
    const deals = await prisma.deal.findMany({ where: { shopId: shop.id } });
    for (const deal of deals) {
      const config = normalizeConfig(deal.config, deal.type as DealTypeKey);
      config.style = { ...config.style, colors: { ...config.style.colors, ...BRAND_LINKS } };
      for (const arm of Object.values(config.abTest.arms)) {
        if (arm?.style) arm.style = { ...arm.style, colors: { ...arm.style.colors, ...BRAND_LINKS } };
      }
      await prisma.deal.update({ where: { id: deal.id }, data: { config: config as unknown as Prisma.InputJsonValue } });
    }
  }

  const messages: Record<string, string> = {
    republish: "Deals republished",
    scan: "Brand colours read from your theme",
    palette: "Brand colours saved",
    "apply-brand": "Brand colours applied to every deal",
  };
  try {
    await syncShop(admin, session.shop, { force: intent === "republish" });
    return { ok: true, message: messages[String(intent)] ?? "Settings saved" };
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

      <BrandColors
        key={JSON.stringify(d.palette)}
        initial={d.palette}
        submit={(data) => fetcher.submit(data, { method: "post" })}
      />

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

/** The brand palette editor; re-created (via key) when the saved palette changes. */
function BrandColors({ initial, submit }: { initial: BrandPalette | null; submit: (data: Record<string, string>) => void }) {
  const [palette, setPalette] = useState<BrandPalette | null>(initial);
  const fetcher = { submit: (data: Record<string, string>) => submit(data) };
  return (
        <s-section heading="Brand colours">
          <s-stack gap="base">
            <s-paragraph>
              Read your theme&apos;s colours into a palette, adjust it, then apply it to your deals. Deals using brand colours update
              when you change the palette.
            </s-paragraph>
            {palette ? (
              <s-stack gap="base">
                {BRAND_GROUPS.map((group) => (
                  <s-stack key={group} gap="small-200">
                    <s-text type="strong">{group[0].toUpperCase() + group.slice(1)}</s-text>
                    <s-stack direction="inline" gap="base" alignItems="end">
                      {palette[group].map((hex, i) => (
                        <div key={`${group}-${i}`} style={{ width: 150 }}>
                          <ColorField
                            label={`${group} ${i + 1}`}
                            value={hex}
                            onChange={(v) => setPalette({ ...palette, [group]: palette[group].map((c, j) => (j === i ? v : c)) })}
                          />
                        </div>
                      ))}
                      {palette[group].length < 4 ? (
                        <s-button
                          variant="tertiary"
                          icon="plus"
                          accessibilityLabel={`Add a ${group} colour`}
                          onClick={() => setPalette({ ...palette, [group]: [...palette[group], "#888888"] })}
                        />
                      ) : null}
                    </s-stack>
                  </s-stack>
                ))}
              </s-stack>
            ) : (
              <s-paragraph color="subdued">No palette yet.</s-paragraph>
            )}
            <s-button-group>
              <s-button onClick={() => fetcher.submit({ intent: "scan" })}>
                {palette ? "Scan my theme again" : "Scan my theme"}
              </s-button>
              {palette ? (
                <s-button onClick={() => fetcher.submit({ intent: "palette", palette: JSON.stringify(palette) })}>
                  Save palette
                </s-button>
              ) : null}
              {palette ? (
                <s-button
                  variant="primary"
                  onClick={() => {
                    if (confirm("Use brand colours in every deal? Their current colours are replaced by links to the palette."))
                      fetcher.submit({ intent: "apply-brand" });
                  }}
                >
                  Apply to all deals
                </s-button>
              ) : null}
            </s-button-group>
          </s-stack>
        </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
