import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShop } from "../lib/sync.server";
import { blockDeepLink, embedDeepLink, embedStatus, themeSettings } from "../lib/theme.server";
import { ColorField, Grid, Select, TextArea, TextField } from "../components/fields";
import { paletteFromSettings } from "../lib/brand";
import { shopLocales } from "../lib/locales.server";
import { TranslateError, translateTexts } from "../lib/translate.server";
import {
  BRAND_GROUPS,
  BRAND_LINKS,
  DEFAULT_STRINGS,
  normalizeConfig,
  normalizePalette,
  normalizeStrings,
  type BrandPalette,
  type DealTypeKey,
  type WidgetStrings,
} from "../lib/deals";
import { useT } from "../lib/admin-i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  const settings = (shop.settings ?? {}) as { customCss?: string; brandPalette?: unknown; i18n?: unknown };
  const embed = await embedStatus(admin);
  const locales = await shopLocales(admin);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return {
    customCss: settings.customCss ?? "",
    palette: normalizePalette(settings.brandPalette),
    locales,
    strings: normalizeStrings(settings.i18n),
    defaults: DEFAULT_STRINGS,
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
  } else if (intent === "strings") {
    let raw: unknown = null;
    try {
      raw = JSON.parse(String(form.get("strings") ?? "null"));
    } catch {
      // Ignored: treated as no strings.
    }
    await saveSettings({ i18n: normalizeStrings(raw) });
  } else if (intent === "translate-strings") {
    const language = String(form.get("language") ?? "");
    try {
      const translated = await translateTexts(DEFAULT_STRINGS as unknown as Record<string, string>, language);
      return { ok: true, message: "Translated. Check the text, then save.", translated };
    } catch (error) {
      console.error("Auto-translate failed", error);
      return { ok: false, message: error instanceof TranslateError ? error.message : "Translation failed.", translated: null };
    }
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
  const t = useT();
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
    <s-page heading={t("Settings")}>
      <s-section heading={t("Theme setup")}>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>App embed in {d.themeName ?? "your live theme"}:</s-text>
            {d.embedEnabled === true ? (
              <s-badge tone="success">{t("On")}</s-badge>
            ) : d.embedEnabled === false ? (
              <s-badge tone="critical">{t("Off")}</s-badge>
            ) : (
              <s-badge>{t("Unknown")}</s-badge>
            )}
          </s-stack>
          <s-paragraph>
            {t("With the embed on, CartLift places deals above the add-to-cart button automatically. For a custom position, add the “CartLift deals” block to your product template instead.")}
          </s-paragraph>
          <s-button-group>
            <s-button href={d.embedUrl} target="_blank" variant="primary">
              {d.embedEnabled ? t("Open app embeds") : t("Turn on app embed")}
            </s-button>
            <s-button href={d.blockUrl} target="_blank">
              {t("Add block to product page")}
            </s-button>
          </s-button-group>
        </s-stack>
      </s-section>

      {d.locales.length > 1 ? (
        <WidgetText
          key={JSON.stringify(d.strings)}
          locales={d.locales}
          initial={d.strings}
          defaults={d.defaults}
          translated={(fetcherData) => (fetcherData as { translated?: Record<string, string> } | undefined)?.translated ?? null}
          submit={(data) => fetcher.submit(data, { method: "post" })}
          result={fetcher.data}
          busy={fetcher.state !== "idle"}
        />
      ) : null}

      <BrandColors
        key={JSON.stringify(d.palette)}
        initial={d.palette}
        submit={(data) => fetcher.submit(data, { method: "post" })}
      />

      <s-section heading={t("Custom CSS")}>
        <s-stack gap="base">
          <TextArea
            label={t("CSS added to product pages that show a deal")}
            details={t("Target .cl-block, .cl-bar, .cl-bar.is-selected, .cl-badge, .cl-price and so on.")}
            value={css}
            onChange={setCss}
            rows={8}
          />
          <div>
            <s-button
              loading={fetcher.state !== "idle" || undefined}
              onClick={() => fetcher.submit({ intent: "css", customCss: css }, { method: "post" })}
            >
              {t("Save CSS")}
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <s-section heading={t("Troubleshooting")}>
        <s-stack gap="base">
          <s-paragraph>
            Last published: {d.publishedAt ? new Date(d.publishedAt).toLocaleString() : "never"}.
            {d.discountId ? t(" The CartLift automatic discount is installed.") : t(" The CartLift discount is created when you save your first deal.")}
          </s-paragraph>
          <s-paragraph>
            Add <code>?cartlift=off</code> {t("to any product URL to view the page without CartLift.")}
          </s-paragraph>
          <div>
            <s-button onClick={() => fetcher.submit({ intent: "republish" }, { method: "post" })}>{t("Republish deals")}</s-button>
          </div>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/** The widget's own words per language ("/ each", "Sold out", …). */
function WidgetText({
  locales,
  initial,
  defaults,
  translated,
  submit,
  result,
  busy,
}: {
  locales: { locale: string; name: string; primary: boolean }[];
  initial: Record<string, Partial<WidgetStrings>>;
  defaults: WidgetStrings;
  translated: (result: unknown) => Record<string, string> | null;
  submit: (data: Record<string, string>) => void;
  result: unknown;
  busy: boolean;
}) {
  const t = useT();
  const others = locales.filter((l) => !l.primary);
  const [locale, setLocale] = useState(others[0]?.locale ?? "");
  const [strings, setStrings] = useState(initial);
  const language = others.find((l) => l.locale === locale);
  const current = strings[locale] ?? {};

  // A finished auto-translation fills the fields; the merchant saves them.
  const filled = useRef<unknown>(null);
  useEffect(() => {
    const values = translated(result);
    if (!values || filled.current === result) return;
    filled.current = result;
    // The action's answer arrives as fetcher data; this is where it lands.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStrings((s) => ({ ...s, [locale]: { ...s[locale], ...values } }));
  }, [result, locale, translated]);

  return (
    <s-section heading={t("Widget text")}>
      <s-stack gap="base">
        <s-paragraph>
          {t("The words CartLift adds itself. Leave a field empty to keep the English text.")}
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <Select
            label={t("Language")}
            value={locale}
            onChange={setLocale}
            options={others.map((l) => ({ value: l.locale, label: `${l.name} (${l.locale})` }))}
          />
          <s-button
            loading={busy || undefined}
            onClick={() => language && submit({ intent: "translate-strings", language: `${language.name} (${language.locale})` })}
          >
            {t("Translate automatically")}
          </s-button>
          <s-button variant="primary" onClick={() => submit({ intent: "strings", strings: JSON.stringify(strings) })}>
            {t("Save text")}
          </s-button>
        </s-stack>
        <Grid>
          {(Object.keys(defaults) as (keyof WidgetStrings)[]).map((key) => (
            <TextField
              key={key}
              label={defaults[key]}
              value={current[key] ?? ""}
              placeholder={defaults[key]}
              onChange={(value) => setStrings((s) => ({ ...s, [locale]: { ...s[locale], [key]: value } }))}
            />
          ))}
        </Grid>
      </s-stack>
    </s-section>
  );
}

/** The brand palette editor; re-created (via key) when the saved palette changes. */
function BrandColors({ initial, submit }: { initial: BrandPalette | null; submit: (data: Record<string, string>) => void }) {
  const t = useT();
  const [palette, setPalette] = useState<BrandPalette | null>(initial);
  const fetcher = { submit: (data: Record<string, string>) => submit(data) };
  return (
        <s-section heading={t("Brand colours")}>
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
              <s-paragraph color="subdued">{t("No palette yet.")}</s-paragraph>
            )}
            <s-button-group>
              <s-button onClick={() => fetcher.submit({ intent: "scan" })}>
                {palette ? t("Scan my theme again") : t("Scan my theme")}
              </s-button>
              {palette ? (
                <s-button onClick={() => fetcher.submit({ intent: "palette", palette: JSON.stringify(palette) })}>
                  {t("Save palette")}
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
                  {t("Apply to all deals")}
                </s-button>
              ) : null}
            </s-button-group>
          </s-stack>
        </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
