import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getDeal, nextPriority, parseDealInput, shopIdFor } from "../lib/deal.server";
import { gql } from "../lib/shop.server";
import { TranslateError, translateTexts } from "../lib/translate.server";
import { shopLocales } from "../lib/locales.server";
import { syncShop } from "../lib/sync.server";
import { abResult, MIN_ORDERS_PER_ARM } from "../../packages/core/src";
import {
  ARM_FIELDS,
  ARM_KEYS,
  BRAND_GROUPS,
  BRAND_LINKS,
  BUILT_IN_VARIABLES,
  PRESET_THEMES,
  normalizePalette,
  resolveColor,
  translatableTexts,
  translationFromTexts,
  armConfig,
  DISCOUNT_LABELS,
  TEMPLATES,
  TEMPLATE_INFO,
  newBundleBar,
  newBundleItem,
  templateConfig,
  newBar,
  newUpsell,
  normalizeConfig,
  storefrontDeal,
  type Bar,
  type DealConfig,
  type DealStyle,
  type DealTypeKey,
  type ArmKey,
  type ArmOverride,
  type BrandPalette,
  type BundleItem,
  type DealTranslation,
  type Subscriptions,
  type DiscountType,
  type MetafieldVar,
  type MixMatch,
  type TemplateKey,
  type ResourceRef,
  type TargetTypeKey,
  type Upsell,
  type VariantRef,
} from "../lib/deals";
import {
  Checkbox,
  ColorField,
  TextArea,
  DateTimeField,
  Grid,
  NumberField,
  Select,
  TextField,
} from "../components/fields";
import { DealPreview } from "../components/DealPreview";
import { useT } from "../lib/admin-i18n";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const TYPES: DealTypeKey[] = ["QUANTITY_BREAK", "BXGY", "BUNDLE"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { moneyFormat: true, currencyCode: true, settings: true },
  });
  const moneyFormat = (shop?.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, "");
  const palette = normalizePalette((shop?.settings as { brandPalette?: unknown } | null)?.brandPalette);

  const locales = await shopLocales(admin);

  // Markets to limit a deal to (read_markets). Empty when the store has one market.
  let markets: { id: string; name: string }[] = [];
  try {
    const data = await gql<{ markets: { nodes: { id: string; name: string; status: string }[] } }>(
      admin,
      `#graphql
        query cartliftMarketList { markets(first: 50) { nodes { id name status } } }`,
    );
    markets = data.markets.nodes.filter((m) => m.status === "ACTIVE").map((m) => ({ id: m.id, name: m.name }));
  } catch (error) {
    console.error("Markets list failed", error);
  }

  if (params.id === "new") {
    const url = new URL(request.url);
    // ?template=… from the gallery; ?type=… from older links.
    const byType: Record<DealTypeKey, TemplateKey> = { QUANTITY_BREAK: "quantity_breaks", BXGY: "bxgy", BUNDLE: "mix_match" };
    const requested = url.searchParams.get("template") as TemplateKey | null;
    const legacy = url.searchParams.get("type") as DealTypeKey | null;
    const template: TemplateKey =
      requested && TEMPLATES[requested]?.available ? requested : legacy && TYPES.includes(legacy) ? byType[legacy] : "quantity_breaks";
    const type = TEMPLATES[template].type;
    return {
      ab: null,
      palette,
      markets,
      locales,
      isNew: true,
      moneyFormat,
      currency: shop?.currencyCode ?? "USD",
      deal: {
        id: "new",
        name: TEMPLATES[template].title,
        type,
        status: "ACTIVE" as "ACTIVE" | "DRAFT" | "PAUSED",
        targetType: "ALL" as TargetTypeKey,
        products: [] as ResourceRef[],
        collections: [] as ResourceRef[],
        startsAt: null as string | null,
        endsAt: null as string | null,
        config: templateConfig(template),
      },
    };
  }

  const deal = await getDeal(session.shop, params.id!);
  if (!deal) throw new Response("Deal not found", { status: 404 });
  const config = normalizeConfig(deal.config, deal.type as DealTypeKey);

  // A/B results since the test started (to its end, if it ended).
  let ab: ReturnType<typeof abResult> | null = null;
  const test = config.abTest;
  if (test.status !== "off" && test.startedAt) {
    const since = new Date(test.startedAt.slice(0, 10) + "T00:00:00Z");
    const until = test.endedAt ? new Date(new Date(test.endedAt).getTime() + 86_400_000) : new Date(Date.now() + 86_400_000);
    const rows = await prisma.dailyStat.groupBy({
      by: ["arm"],
      where: { dealId: deal.id, day: { gte: since, lt: until } },
      _sum: { views: true, orders: true },
    });
    const keys = ["A", ...Object.keys(test.arms)];
    ab = abResult(
      keys.map((key) => {
        const row = rows.find((r) => r.arm === key);
        return { key, visitors: row?._sum.views ?? 0, orders: row?._sum.orders ?? 0 };
      }),
    );
  }

  return {
    ab,
    palette,
    markets,
    locales,
    isNew: false,
    moneyFormat,
    currency: shop?.currencyCode ?? "USD",
    deal: {
      id: deal.id,
      name: deal.name,
      type: deal.type as DealTypeKey,
      status: deal.status as "ACTIVE" | "DRAFT" | "PAUSED",
      targetType: deal.targetType as TargetTypeKey,
      products: (deal.products ?? []) as unknown as ResourceRef[],
      collections: (deal.collections ?? []) as unknown as ResourceRef[],
      startsAt: deal.startsAt?.toISOString() ?? null,
      endsAt: deal.endsAt?.toISOString() ?? null,
      config,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as { intent?: string; deal?: Record<string, unknown> };

  if (body.intent === "delete" && params.id !== "new") {
    const deal = await getDeal(session.shop, params.id!);
    if (deal) await prisma.deal.delete({ where: { id: deal.id } });
    await syncShop(admin, session.shop).catch((e) => console.error("Sync failed", e));
    return redirect("/app/deals");
  }

  if (body.intent === "translate") {
    // Translates the editor's current draft; the merchant reviews, then saves.
    const { data } = parseDealInput(body.deal ?? {});
    const config = normalizeConfig(data.config, data.type as DealTypeKey);
    const language = String((body as { language?: string }).language ?? "");
    try {
      const texts = await translateTexts(translatableTexts(config), language);
      return { ok: true, errors: [] as string[], translation: translationFromTexts(texts) };
    } catch (error) {
      const message = error instanceof TranslateError ? error.message : "Translation failed. Try again.";
      console.error("Auto-translate failed", error);
      return { ok: false, errors: [message] };
    }
  }

  const { errors, data } = parseDealInput(body.deal ?? {});
  if (errors.length) return { ok: false, errors };

  const shopId = await shopIdFor(session.shop);
  let id = params.id!;
  if (id === "new") {
    const created = await prisma.deal.create({
      data: { ...data, shopId, priority: await nextPriority(shopId) },
    });
    id = created.id;
  } else {
    const existing = await getDeal(session.shop, id);
    if (!existing) return { ok: false, errors: ["This deal no longer exists."] };
    await prisma.deal.update({ where: { id }, data });
  }

  try {
    await syncShop(admin, session.shop);
  } catch (error) {
    console.error("Sync failed", error);
    return {
      ok: false,
      errors: ["Saved, but publishing to your store failed. Save again in a moment."],
    };
  }

  if (params.id === "new") return redirect(`/app/deals/${id}?saved=1`);
  return { ok: true, errors: [] as string[] };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type LoaderData = Awaited<ReturnType<typeof loader>>;
type EditorDeal = LoaderData["deal"];

const DISCOUNT_OPTIONS = (Object.keys(DISCOUNT_LABELS) as DiscountType[]).map((value) => ({
  value,
  label: DISCOUNT_LABELS[value],
}));

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

/* eslint-disable @typescript-eslint/no-explicit-any */
function pickedImage(item: any): string | null {
  return item?.images?.[0]?.originalSrc ?? item?.image?.originalSrc ?? item?.featuredImage?.url ?? null;
}

export default function DealRoute() {
  const data = useLoaderData<typeof loader>();
  // Remount when the loader switches deals (e.g. /new -> /:id after creating).
  return <DealEditor key={data.deal.id} data={data} />;
}

function DealEditor({ data }: { data: LoaderData }) {
  const t = useT();
  const { deal: initial, isNew, moneyFormat, currency } = data;
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();

  const [deal, setDeal] = useState<EditorDeal>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [previewPrice, setPreviewPrice] = useState(29.99);
  const [previewProduct, setPreviewProduct] = useState<PreviewProduct | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // The language an auto-translation is running for.
  const [translating, setTranslating] = useState<string | null>(null);

  const loadPreviewProduct = useCallback(async (id: string) => {
    setPreviewLoading(true);
    const product = await fetchPreviewProduct(id);
    if (product) setPreviewProduct(product);
    setPreviewLoading(false);
  }, []);

  // Preview on the deal's first product when it has one.
  useEffect(() => {
    const first = initial.products[0]?.id;
    if (!first) return;
    let cancelled = false;
    fetchPreviewProduct(first).then((product) => {
      if (!cancelled && product) setPreviewProduct(product);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dirty = isNew || JSON.stringify(deal) !== baseline;
  const saving = fetcher.state !== "idle";
  const result = fetcher.data;

  // A finished auto-translation fills the draft (the merchant saves it).
  useEffect(() => {
    const payload = fetcher.data as { translation?: DealTranslation } | undefined;
    if (fetcher.state !== "idle" || !payload?.translation || !translating) return;
    const locale = translating;
    const translation = payload.translation;
    // The action's answer arrives as fetcher data; this effect is the one place
    // that knows which language was being translated.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranslating(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDeal((d) => ({
      ...d,
      config: { ...d.config, translations: { ...d.config.translations, [locale]: translation } },
    }));
    shopify.toast.show("Translated. Check the text, then save.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Reset the baseline after a successful save.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setBaseline(JSON.stringify(deal));
      shopify.toast.show("Deal saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("saved")) shopify.toast.show("Deal created");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A/B: which variant the bars, style and picker options below edit.
  const [armKey, setArmKey] = useState<ArmKey>("A");
  const patch = useCallback((changes: Partial<EditorDeal>) => setDeal((d) => ({ ...d, ...changes })), []);
  /** Changes the deal, or — for fields a variant can change — the variant being edited. */
  const patchConfig = useCallback(
    (changes: Partial<DealConfig>) =>
      setDeal((d) => {
        if (armKey === "A") return { ...d, config: { ...d.config, ...changes } };
        const own: ArmOverride = {};
        const shared: Partial<DealConfig> = {};
        for (const [k, v] of Object.entries(changes)) {
          if ((ARM_FIELDS as readonly string[]).includes(k)) (own as Record<string, unknown>)[k] = v;
          else (shared as Record<string, unknown>)[k] = v;
        }
        const arms = { ...d.config.abTest.arms, [armKey]: { ...d.config.abTest.arms[armKey as "B"], ...own } };
        return { ...d, config: { ...d.config, ...shared, abTest: { ...d.config.abTest, arms } } };
      }),
    [armKey],
  );
  const viewOf = useCallback((c: DealConfig) => (armKey === "A" ? c : armConfig(c, armKey)), [armKey]);
  const patchStyle = useCallback(
    (changes: Partial<DealStyle>) =>
      setDeal((d) => {
        const style = { ...viewOf(d.config).style, ...changes };
        if (armKey === "A") return { ...d, config: { ...d.config, style } };
        const arms = { ...d.config.abTest.arms, [armKey]: { ...d.config.abTest.arms[armKey as "B"], style } };
        return { ...d, config: { ...d.config, abTest: { ...d.config.abTest, arms } } };
      }),
    [armKey, viewOf],
  );
  const patchBar = useCallback(
    (id: string, changes: Partial<Bar>) =>
      setDeal((d) => {
        const bars = viewOf(d.config).bars.map((b) => {
          if (b.id === id) return { ...b, ...changes };
          // Only one bar can be the default.
          if (changes.selected) return { ...b, selected: false };
          return b;
        });
        if (armKey === "A") return { ...d, config: { ...d.config, bars } };
        const arms = { ...d.config.abTest.arms, [armKey]: { ...d.config.abTest.arms[armKey as "B"], bars } };
        return { ...d, config: { ...d.config, abTest: { ...d.config.abTest, arms } } };
      }),
    [armKey, viewOf],
  );

  const save = () => fetcher.submit({ intent: "save", deal } as any, { method: "post", encType: "application/json" });
  const discard = () => setDeal(JSON.parse(baseline));

  const pickProducts = async () => {
    const selected: any = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: deal.products.map((p) => ({ id: p.id })),
    } as any);
    if (!selected) return;
    patch({
      products: selected.map((p: any) => ({ id: p.id, title: p.title, image: pickedImage(p), handle: p.handle })),
    });
    const price = Number(selected[0]?.variants?.[0]?.price);
    if (price > 0) setPreviewPrice(price);
  };

  const pickCollections = async () => {
    const selected: any = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      selectionIds: deal.collections.map((c) => ({ id: c.id })),
    } as any);
    if (!selected) return;
    patch({ collections: selected.map((c: any) => ({ id: c.id, title: c.title, image: pickedImage(c), handle: c.handle })) });
  };

  const pickRefs = async (type: "product" | "collection", current: ResourceRef[]): Promise<ResourceRef[] | null> => {
    const selected: any = await shopify.resourcePicker({ type, multiple: true, selectionIds: current.map((r) => ({ id: r.id })) } as any);
    if (!selected) return null;
    return selected.map((r: any) => ({ id: r.id, title: r.title, image: pickedImage(r), handle: r.handle }));
  };

  const pickPreviewProduct = async () => {
    const selected: any = await shopify.resourcePicker({ type: "product", multiple: false } as any);
    if (selected?.[0]?.id) loadPreviewProduct(selected[0].id);
  };

  const pickVariants = async (current: VariantRef[]): Promise<VariantRef[] | null> => {
    const selected: any = await shopify.resourcePicker({
      type: "variant",
      multiple: true,
      selectionIds: current.map((v) => ({ id: v.id })),
    } as any);
    if (!selected) return null;
    return selected.map((v: any) => ({
      id: v.id,
      title: v.title && v.title !== "Default Title" ? `${v.product?.title ?? v.displayName ?? ""} - ${v.title}` : v.product?.title ?? v.displayName ?? v.id,
      productId: v.product?.id ?? "",
      productTitle: v.product?.title,
      image: v.image?.originalSrc ?? v.image?.url ?? null,
      price: v.price ?? null,
    }));
  };

  const pickVariant = async (): Promise<VariantRef | null> => {
    const selected: any = await shopify.resourcePicker({ type: "product", multiple: false, filter: { variants: true } } as any);
    const product = selected?.[0];
    const variant = product?.variants?.[0];
    if (!product || !variant) return null;
    return {
      id: variant.id,
      title: !variant.title || variant.title === "Default Title" ? product.title : `${product.title} - ${variant.title}`,
      productId: product.id,
      productTitle: product.title,
      image: variant.image?.originalSrc ?? pickedImage(product),
      price: variant.price ?? null,
    };
  };

  // The preview shows the variant being edited.
  const previewDeal = useMemo(
    () => storefrontDeal({ ...deal, config: armKey === "A" ? deal.config : armConfig(deal.config, armKey) }, data.palette) as any,
    [deal, armKey, data.palette],
  );
  const previewCtx = useMemo(() => {
    if (previewProduct) return { product: previewProduct.product, options: previewProduct.options, moneyFormat, rate: 1 };
    const cents = Math.round(previewPrice * 100);
    return {
      product: {
        title: deal.products[0]?.title || "Sample product",
        variants: [
          { id: 1, title: "Small", price: cents, compare_at_price: Math.round(cents * 1.25), available: true },
          { id: 2, title: "Medium", price: cents, compare_at_price: Math.round(cents * 1.25), available: true },
          { id: 3, title: "Large", price: cents, compare_at_price: null, available: false },
        ],
      },
      moneyFormat,
      rate: 1,
    };
  }, [deal.products, previewPrice, moneyFormat, previewProduct]);

  const errors = result && !result.ok ? result.errors : [];
  const isBxgy = deal.type === "BXGY";
  const { config } = deal;
  // What the variant being edited shows (the deal itself for A).
  const view = armKey === "A" ? config : armConfig(config, armKey);
  const bars = view.bars;

  const moveBar = (index: number, dir: -1 | 1) => {
    const next = [...bars];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    patchConfig({ bars: next });
  };

  return (
    <s-page heading={isNew ? `${t("New deal")}: ${t(TEMPLATE_INFO[deal.type].title)}` : deal.name}>
      <SaveBar id="deal-save-bar" open={dirty}>
        <button variant="primary" onClick={save} disabled={saving}></button>
        <button onClick={isNew ? () => navigate("/app/deals") : discard} disabled={saving}></button>
      </SaveBar>
      <s-link slot="breadcrumb-actions" href="/app/deals">
        Deals
      </s-link>
      <s-button slot="primary-action" variant="primary" onClick={save} loading={saving || undefined}>
        Save
      </s-button>
      {!isNew ? (
        <s-button
          slot="secondary-actions"
          tone="critical"
          onClick={() => {
            if (confirm("Delete this deal?"))
              fetcher.submit({ intent: "delete" } as any, { method: "post", encType: "application/json" });
          }}
        >
          Delete
        </s-button>
      ) : null}

      {errors.length ? (
        <s-banner tone="critical" heading="Please fix these before saving">
          <s-stack gap="small-100">
            {errors.map((e) => (
              <s-text key={e}>{e}</s-text>
            ))}
          </s-stack>
        </s-banner>
      ) : null}

      {/* ---------------- Deal ---------------- */}
      <s-section heading="Deal">
        <s-stack gap="base">
          <Grid>
            <TextField label="Deal name" value={deal.name} onChange={(name) => patch({ name })} details="Only you see this." />
            <Select
              label="Status"
              value={deal.status}
              onChange={(status) => patch({ status: status as EditorDeal["status"] })}
              options={[
                { value: "ACTIVE", label: "Active" },
                { value: "DRAFT", label: "Draft" },
                { value: "PAUSED", label: "Paused" },
              ]}
            />
          </Grid>
          <TextField
            label="Discount name in cart and checkout"
            value={view.discountName}
            onChange={(discountName) => patchConfig({ discountName })}
            placeholder="Leave empty to use each bar's title"
          />
        </s-stack>
      </s-section>

      {/* ---------------- A/B test ---------------- */}
      {!isNew ? (
        <AbTestPanel
          test={config.abTest}
          results={data.ab}
          editing={armKey}
          onEdit={setArmKey}
          snapshot={() => {
            const copy: ArmOverride = {};
            for (const field of ARM_FIELDS) (copy as Record<string, unknown>)[field] = JSON.parse(JSON.stringify(config[field]));
            return copy;
          }}
          onChange={(abTest) => setDeal((d) => ({ ...d, config: { ...d.config, abTest } }))}
          onApply={(key) => {
            const override = config.abTest.arms[key as "B"] ?? {};
            setDeal((d) => ({
              ...d,
              config: { ...d.config, ...override, abTest: { status: "off", weights: { A: 100 }, arms: {}, startedAt: null, endedAt: null } },
            }));
            setArmKey("A");
            shopify.toast.show(`Variant ${key} is now the deal. Save to publish.`);
          }}
        />
      ) : null}
      {armKey !== "A" ? (
        <s-banner tone="info" heading={`Editing variant ${armKey}`}>
          Bars, style, variant pickers and the discount name below belong to variant {armKey}. Visibility, schedule and mix &amp;
          match are shared by every variant.
        </s-banner>
      ) : null}

      {/* ---------------- Visibility ---------------- */}
      <s-section heading="Visibility">
        <s-stack gap="base">
          <Select
            label="Show this deal on"
            value={deal.targetType}
            onChange={(targetType) => patch({ targetType: targetType as TargetTypeKey })}
            options={[
              { value: "ALL", label: "All products" },
              { value: "PRODUCTS", label: "Selected products" },
              { value: "COLLECTIONS", label: "Products in selected collections" },
              { value: "EXCEPT", label: "All products except selected" },
            ]}
          />
          {deal.targetType === "PRODUCTS" || deal.targetType === "EXCEPT" ? (
            <ResourceList
              items={deal.products}
              onPick={pickProducts}
              label="products"
              onRemove={(id) => patch({ products: deal.products.filter((p) => p.id !== id) })}
            />
          ) : null}
          {deal.targetType === "COLLECTIONS" ? (
            <ResourceList
              items={deal.collections}
              onPick={pickCollections}
              label="collections"
              onRemove={(id) => patch({ collections: deal.collections.filter((c) => c.id !== id) })}
            />
          ) : null}
          <Checkbox
            label="Count quantities across different products"
            details="On: 1 shirt + 1 cap counts as 2 units (mix & match). Off: each product climbs the tiers on its own."
            checked={config.across}
            onChange={(across) => patchConfig({ across })}
          />
          {data.markets.length > 1 ? (
            <s-stack gap="small-200">
              <s-text type="strong">Markets</s-text>
              <s-paragraph color="subdued">Pick none to run this deal in every market.</s-paragraph>
              <s-stack direction="inline" gap="base">
                {data.markets.map((market) => (
                  <Checkbox
                    key={market.id}
                    label={market.name}
                    checked={config.markets.some((m) => m.id === market.id)}
                    onChange={(on) =>
                      patchConfig({
                        markets: on
                          ? [...config.markets, { id: market.id, title: market.name }]
                          : config.markets.filter((m) => m.id !== market.id),
                      })
                    }
                  />
                ))}
              </s-stack>
            </s-stack>
          ) : null}
          <Grid>
            <DateTimeField label="Start (optional)" value={toLocalInput(deal.startsAt)} onChange={(v) => patch({ startsAt: fromLocalInput(v) })} />
            <DateTimeField label="End (optional)" value={toLocalInput(deal.endsAt)} onChange={(v) => patch({ endsAt: fromLocalInput(v) })} />
          </Grid>
        </s-stack>
      </s-section>

      {/* ---------------- Bars ---------------- */}
      <s-section heading="Deal bars">
        <s-stack gap="base">
          <s-paragraph color="subdued">Drag bars to reorder them, or use the arrows.</s-paragraph>
          <s-paragraph color="subdued">
            Text can use {[...BUILT_IN_VARIABLES, ...config.metafieldVars.map((m) => m.name).filter(Boolean)]
              .map((v) => `{{${v}}}`)
              .join(", ")}
            . Amounts are in {currency}.
          </s-paragraph>
          {bars.map((bar, index) => (
            <div
              key={bar.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", bar.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = bars.findIndex((b) => b.id === e.dataTransfer.getData("text/plain"));
                if (from < 0 || from === index) return;
                const next = [...bars];
                const [moved] = next.splice(from, 1);
                next.splice(index, 0, moved);
                patchConfig({ bars: next });
              }}
              title="Drag to reorder"
              style={{ cursor: "grab" }}
            >
            <BarEditor
              bar={bar}
              index={index}
              count={bars.length}
              allowBxgy={isBxgy}
              onChange={(changes) => patchBar(bar.id, changes)}
              onMove={(dir) => moveBar(index, dir)}
              onRemove={() => patchConfig({ bars: bars.filter((b) => b.id !== bar.id) })}
              pickVariant={pickVariant}
              pickVariants={pickVariants}
            />
            </div>
          ))}
          <s-button-group>
            <s-button
              icon="plus"
              onClick={() => {
                const maxQty = Math.max(0, ...bars.map((b) => b.qty));
                patchConfig({
                  bars: [
                    ...bars,
                    newBar({ qty: maxQty + 1, title: `Buy ${maxQty + 1}`, discountType: "percentage", discountValue: 10 }),
                  ],
                });
              }}
            >
              Add quantity bar
            </s-button>
            <s-button
              icon="plus"
              onClick={() => {
                const maxQty = Math.max(0, ...bars.map((b) => b.qty));
                const buy = Math.max(1, Math.ceil((maxQty + 1) / 2));
                patchConfig({
                  bars: [
                    ...bars,
                    newBar({
                      kind: "bxgy",
                      qty: buy * 2,
                      get: buy,
                      discountType: "percentage",
                      discountValue: 100,
                      title: `Buy ${buy}, get ${buy} FREE`,
                    }),
                  ],
                });
              }}
            >
              Add buy X get Y bar
            </s-button>
            <s-button icon="plus" onClick={() => patchConfig({ bars: [...bars, newBundleBar()] })}>
              Add bundle bar
            </s-button>
          </s-button-group>
          <Checkbox
            label="Progressive gifts"
            details="Each bar also gets the free gifts of every smaller bar."
            checked={view.progressiveGifts}
            onChange={(progressiveGifts) => patchConfig({ progressiveGifts })}
          />
          <Checkbox
            label="Let customers choose a variant for each item"
            details="Shows a size/colour picker per unit on the selected bar."
            checked={view.variantPerUnit}
            onChange={(variantPerUnit) => patchConfig({ variantPerUnit })}
          />
          <Checkbox
            label="Show the variant picker on single-item bars"
            details="Off: shoppers use your theme's variant picker for one item."
            checked={view.showVariantPicker}
            onChange={(showVariantPicker) => patchConfig({ showVariantPicker })}
          />
        </s-stack>
      </s-section>

      {/* ---------------- Metafield variables ---------------- */}
      <MetafieldVarsEditor vars={config.metafieldVars} onChange={(metafieldVars) => patchConfig({ metafieldVars })} />

      {/* ---------------- Translations ---------------- */}
      {data.locales.length > 1 ? (
        <TranslationsEditor
          locales={data.locales}
          texts={translatableTexts(config)}
          translations={config.translations}
          busy={translating}
          onChange={(translations) => patchConfig({ translations })}
          onTranslate={(locale, language) => {
            setTranslating(locale);
            fetcher.submit({ intent: "translate", language, deal } as any, { method: "post", encType: "application/json" });
          }}
        />
      ) : null}

      {/* ---------------- Subscriptions ---------------- */}
      <SubscriptionsEditor
        subs={config.subscriptions}
        onChange={(changes) => patchConfig({ subscriptions: { ...config.subscriptions, ...changes } })}
      />

      {/* ---------------- Mix & match ---------------- */}
      <MixMatchEditor
        mm={config.mixMatch}
        onChange={(changes) => patchConfig({ mixMatch: { ...config.mixMatch, ...changes }, ...(changes.enabled ? { across: true } : {}) })}
        pickRefs={pickRefs}
      />

      {/* ---------------- Style ---------------- */}
      <StyleEditor style={view.style} palette={data.palette} onChange={patchStyle} />

      {/* ---------------- Preview ---------------- */}
      <s-section slot="aside" heading="Live preview">
        <s-stack gap="base">
          <DealPreview deal={previewDeal} ctx={previewCtx} />
          {previewProduct ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-thumbnail src={previewProduct.image ?? undefined} alt={previewProduct.product.title} size="small" />
              <s-text>{previewProduct.product.title}</s-text>
            </s-stack>
          ) : (
            <NumberField label="Preview unit price" value={previewPrice} min={0} step={0.01} onChange={setPreviewPrice} suffix={currency} />
          )}
          <s-button-group>
            <s-button onClick={pickPreviewProduct} loading={previewLoading || undefined}>
              {previewProduct ? "Change product" : "Preview a product"}
            </s-button>
            {previewProduct ? <s-button variant="tertiary" onClick={() => setPreviewProduct(null)}>Use a sample</s-button> : null}
          </s-button-group>
          <s-paragraph color="subdued">Checkout applies the same prices automatically through the CartLift discount.</s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ResourceList({
  items,
  onPick,
  onRemove,
  label,
}: {
  items: ResourceRef[];
  onPick: () => void;
  onRemove: (id: string) => void;
  label: string;
}) {
  return (
    <s-stack gap="small-200">
      {items.map((item) => (
        <s-stack key={item.id} direction="inline" gap="small-200" alignItems="center">
          <s-thumbnail src={item.image ?? undefined} alt={item.title} size="small" />
          <s-text>{item.title}</s-text>
          <s-button variant="tertiary" icon="x" accessibilityLabel={`Remove ${item.title}`} onClick={() => onRemove(item.id)} />
        </s-stack>
      ))}
      <div>
        <s-button onClick={onPick}>{items.length ? `Edit ${label}` : `Select ${label}`}</s-button>
      </div>
    </s-stack>
  );
}

function BarEditor({
  bar,
  index,
  count,
  allowBxgy,
  onChange,
  onMove,
  onRemove,
  pickVariant,
  pickVariants,
}: {
  bar: Bar;
  index: number;
  count: number;
  allowBxgy: boolean;
  onChange: (changes: Partial<Bar>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  pickVariant: () => Promise<VariantRef | null>;
  pickVariants: (current: VariantRef[]) => Promise<VariantRef[] | null>;
}) {
  const t = useT();
  const bxgy = bar.kind === "bxgy";
  const bundle = bar.kind === "bundle";
  return (
    <s-box padding="base" border="base" borderRadius="base" background={bar.selected ? "subdued" : undefined}>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Bar {index + 1}</s-heading>
            <s-badge tone={bxgy ? "info" : bundle ? "success" : "neutral"}>
              {bxgy ? "Buy X get Y" : bundle ? t("Complete the bundle") : t("Quantity break")}
            </s-badge>
            {bar.selected ? <s-badge tone="success">{t("Default")}</s-badge> : null}
          </s-stack>
          <s-button-group>
            <s-button icon="arrow-up" variant="tertiary" accessibilityLabel={t("Move up")} disabled={index === 0 || undefined} onClick={() => onMove(-1)} />
            <s-button
              icon="arrow-down"
              variant="tertiary"
              accessibilityLabel={t("Move down")}
              disabled={index === count - 1 || undefined}
              onClick={() => onMove(1)}
            />
            <s-button
              icon="delete"
              variant="tertiary"
              tone="critical"
              accessibilityLabel={t("Remove bar")}
              disabled={count <= 1 || undefined}
              onClick={onRemove}
            />
          </s-button-group>
        </s-stack>

        {bundle ? (
          <BundleItemsEditor items={bar.items} onChange={(items) => onChange({ items })} pickVariant={pickVariant} />
        ) : null}
        <Grid columns={3}>
          {bundle ? null : allowBxgy || bxgy ? (
            <Select
              label={t("Bar type")}
              value={bar.kind}
              onChange={(kind) =>
                onChange(
                  kind === "bxgy"
                    ? { kind: "bxgy", get: Math.max(1, Math.floor(bar.qty / 2)), qty: Math.max(2, bar.qty) }
                    : { kind: "qty", get: 0 },
                )
              }
              options={[
                { value: "qty", label: t("Quantity break") },
                { value: "bxgy", label: t("Buy X get Y") },
              ]}
            />
          ) : null}
          {bundle ? null : bxgy ? (
            <>
              <NumberField
                label={t("Buy")}
                min={1}
                value={bar.qty - bar.get}
                onChange={(buy) => onChange({ qty: Math.max(1, Math.floor(buy)) + bar.get })}
              />
              <NumberField
                label={t("Get")}
                min={1}
                value={bar.get}
                onChange={(get) => {
                  const g = Math.max(1, Math.floor(get));
                  onChange({ get: g, qty: bar.qty - bar.get + g });
                }}
              />
            </>
          ) : (
            <NumberField label={t("Quantity")} min={1} value={bar.qty} onChange={(qty) => onChange({ qty: Math.max(1, Math.floor(qty)) })} />
          )}
          {bundle ? null : (
          <Select
            label={bxgy ? t("Discount on the free items") : t("Discount")}
            value={bar.discountType}
            onChange={(dt) => onChange({ discountType: dt as DiscountType })}
            options={
              bxgy
                ? [
                    { value: "percentage", label: t("Percentage off (100 = free)") },
                    { value: "amount", label: t("Amount off each") },
                    { value: "fixed_total", label: t("Fixed price each") },
                  ]
                : DISCOUNT_OPTIONS
            }
          />
          )}
          {!bundle && bar.discountType !== "none" ? (
            <NumberField
              label={bar.discountType === "percentage" ? t("Percent") : t("Amount")}
              min={0}
              max={bar.discountType === "percentage" ? 100 : undefined}
              step={bar.discountType === "percentage" ? 1 : 0.01}
              suffix={bar.discountType === "percentage" ? "%" : undefined}
              value={bar.discountValue}
              onChange={(discountValue) => onChange({ discountValue: Math.max(0, discountValue) })}
            />
          ) : null}
          {bxgy ? (
            <NumberField
              label={t("Extra discount on the rest")}
              details={t("On top of the free items, e.g. Buy 3 get 1 + 10%.")}
              min={0}
              max={100}
              suffix="%"
              value={bar.extraPercent}
              onChange={(extraPercent) => onChange({ extraPercent: Math.min(100, Math.max(0, extraPercent)) })}
            />
          ) : null}
        </Grid>

        <Grid>
          <TextField label={t("Title")} value={bar.title} onChange={(title) => onChange({ title })} />
          <TextField label={t("Subtitle")} value={bar.subtitle} onChange={(subtitle) => onChange({ subtitle })} />
          <TextField label={t("Label")} value={bar.label} onChange={(label) => onChange({ label })} placeholder={t("e.g. SAVE 20%")} />
          <TextField label={t("Badge")} value={bar.badge} onChange={(badge) => onChange({ badge })} placeholder={t("e.g. Most popular")} />
        </Grid>
        <HighlightsEditor highlights={bar.highlights} onChange={(highlights) => onChange({ highlights })} />
        <BarImageEditor image={bar.image} onChange={(image) => onChange({ image })} />
        <s-stack gap="small-200">
          <s-text type="strong">{t("Default variants")}</s-text>
          <s-paragraph color="subdued">
            {t("Pre-selected in the variant pickers, one per item in order. Only variants of the product being viewed are used.")}
          </s-paragraph>
          {bar.defaultVariants.length ? (
            <s-stack direction="inline" gap="small-200">
              {bar.defaultVariants.map((v, i) => (
                <s-badge key={`${v.id}-${i}`}>{`#${i + 1} ${v.title}`}</s-badge>
              ))}
            </s-stack>
          ) : null}
          <s-button-group>
            <s-button
              onClick={async () => {
                const picked = await pickVariants(bar.defaultVariants);
                if (picked) onChange({ defaultVariants: picked.slice(0, Math.max(1, bar.qty)) });
              }}
            >
              {bar.defaultVariants.length ? t("Change default variants") : t("Set default variants")}
            </s-button>
            {bar.defaultVariants.length ? (
              <s-button variant="tertiary" onClick={() => onChange({ defaultVariants: [] })}>
                {t("Clear")}
              </s-button>
            ) : null}
          </s-button-group>
        </s-stack>
        <s-stack direction="inline" gap="base">
          <Checkbox label={t("Selected by default")} checked={bar.selected} onChange={(selected) => onChange({ selected })} />
          {bar.badge ? (
            <Checkbox
              label={t("Fancy badge")}
              checked={bar.badgeStyle === "fancy"}
              onChange={(fancy) => onChange({ badgeStyle: fancy ? "fancy" : "simple" })}
            />
          ) : null}
        </s-stack>

        {/* Free gifts */}
        <s-stack gap="small-200">
          <s-text type="strong">{t("Free gifts")}</s-text>
          {bar.gifts.map((gift) => (
            <s-stack key={gift.id} direction="inline" gap="small-200" alignItems="center">
              <s-thumbnail src={gift.image ?? undefined} alt={gift.title} size="small" />
              <s-text>{gift.title}</s-text>
              <s-button
                variant="tertiary"
                icon="x"
                accessibilityLabel={`Remove ${gift.title}`}
                onClick={() => onChange({ gifts: bar.gifts.filter((g) => g.id !== gift.id) })}
              />
            </s-stack>
          ))}
          {bar.gifts.length ? <TextField label={t("Gift text")} value={bar.giftText} onChange={(giftText) => onChange({ giftText })} /> : null}
          {bar.gifts.length < 5 ? (
            <div>
              <s-button
                icon="gift-card"
                onClick={async () => {
                  const gift = await pickVariant();
                  if (gift && !bar.gifts.some((g) => g.id === gift.id)) onChange({ gifts: [...bar.gifts, gift] });
                }}
              >
                {t("Add free gift")}
              </s-button>
            </div>
          ) : null}
        </s-stack>

        {/* Upsells */}
        <s-stack gap="small-200">
          <s-text type="strong">{t("Upsells on this bar")}</s-text>
          {bar.upsells.map((up) => (
            <UpsellEditor
              key={up.id}
              upsell={up}
              onChange={(changes) => onChange({ upsells: bar.upsells.map((u) => (u.id === up.id ? { ...u, ...changes } : u)) })}
              onRemove={() => onChange({ upsells: bar.upsells.filter((u) => u.id !== up.id) })}
              pickVariant={pickVariant}
            />
          ))}
          <s-button-group>
            <s-button
              icon="plus"
              onClick={async () => {
                const variant = await pickVariant();
                if (variant) onChange({ upsells: [...bar.upsells, newUpsell({ variant })] });
              }}
            >
              {t("Add upsell")}
            </s-button>
            <s-button
              icon="plus"
              onClick={() =>
                onChange({
                  upsells: [
                    ...bar.upsells,
                    newUpsell({ source: "complementary", text: "Add {{product}} for {{price}}", limit: 1 }),
                  ],
                })
              }
            >
              {t("Add complementary products")}
            </s-button>
          </s-button-group>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

function UpsellEditor({
  upsell,
  onChange,
  onRemove,
  pickVariant,
}: {
  upsell: Upsell;
  onChange: (changes: Partial<Upsell>) => void;
  onRemove: () => void;
  pickVariant: () => Promise<VariantRef | null>;
}) {
  const t = useT();
  const complementary = upsell.source === "complementary";
  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          {complementary ? (
            <s-stack gap="small-100">
              <s-text type="strong">{t("Complementary products")}</s-text>
              <s-text color="subdued">From the Search & Discovery app&apos;s complementary products for the viewed product.</s-text>
            </s-stack>
          ) : (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-thumbnail src={upsell.variant?.image ?? undefined} alt={upsell.variant?.title ?? ""} size="small" />
              <s-text>{upsell.variant?.title ?? "No product"}</s-text>
            </s-stack>
          )}
          <s-button-group>
            {complementary ? null : (
              <s-button
                variant="tertiary"
                onClick={async () => {
                  const variant = await pickVariant();
                  if (variant) onChange({ variant });
                }}
              >
                {t("Change")}
              </s-button>
            )}
            <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel={t("Remove upsell")} onClick={onRemove} />
          </s-button-group>
        </s-stack>
        {complementary ? (
          <NumberField
            label={t("Products to offer")}
            min={1}
            max={4}
            value={upsell.limit}
            onChange={(limit) => onChange({ limit: Math.min(4, Math.max(1, Math.floor(limit))) })}
          />
        ) : null}
        <TextField label={t("Text")} value={upsell.text} onChange={(text) => onChange({ text })} />
        <Grid>
          <Select
            label={t("Discount")}
            value={upsell.discountType}
            onChange={(dt) => onChange({ discountType: dt as DiscountType })}
            options={[
              { value: "none", label: t("No discount") },
              { value: "percentage", label: t("Percentage off") },
              { value: "amount", label: t("Amount off") },
              { value: "fixed_total", label: t("Fixed price") },
            ]}
          />
          {upsell.discountType !== "none" ? (
            <NumberField label={t("Value")} min={0} value={upsell.discountValue} onChange={(discountValue) => onChange({ discountValue })} />
          ) : null}
        </Grid>
        <s-stack direction="inline" gap="base">
          <Checkbox label={t("Pre-checked")} checked={upsell.checked} onChange={(checked) => onChange({ checked })} />
          <Checkbox
            label={t("Only show when this bar is selected")}
            checked={upsell.onlyWhenSelected}
            onChange={(onlyWhenSelected) => onChange({ onlyWhenSelected })}
          />
        </s-stack>
      </s-stack>
    </s-box>
  );
}

interface PreviewProduct {
  product: { id: number; title: string; variants: { id: number; title: string; price: number; compare_at_price: number | null; available: boolean }[] };
  options: { name: string; values: { name: string; color: string | null; image: string | null }[] }[];
  image: string | null;
}

async function fetchPreviewProduct(id: string): Promise<PreviewProduct | null> {
  try {
    const response = await fetch(`/app/preview-product?id=${encodeURIComponent(id)}`);
    return response.ok ? ((await response.json()) as PreviewProduct) : null;
  } catch {
    return null;
  }
}

function HighlightsEditor({ highlights, onChange }: { highlights: string[]; onChange: (h: string[]) => void }) {
  const t = useT();
  return (
    <s-stack gap="small-200">
      <s-text type="strong">{t("Highlights")}</s-text>
      {highlights.map((h, i) => (
        <s-stack key={i} direction="inline" gap="small-200" alignItems="end">
          <div style={{ flex: 1 }}>
            <TextField
              label={`Highlight ${i + 1}`}
              value={h}
              placeholder={t("e.g. Free shipping")}
              onChange={(value) => onChange(highlights.map((x, j) => (j === i ? value : x)))}
            />
          </div>
          <s-button
            variant="tertiary"
            icon="x"
            accessibilityLabel={`Remove highlight ${i + 1}`}
            onClick={() => onChange(highlights.filter((_, j) => j !== i))}
          />
        </s-stack>
      ))}
      {highlights.length < 4 ? (
        <div>
          <s-button icon="plus" variant="tertiary" onClick={() => onChange([...highlights, ""])}>
            {t("Add highlight")}
          </s-button>
        </div>
      ) : null}
    </s-stack>
  );
}

function BarImageEditor({ image, onChange }: { image: Bar["image"]; onChange: (image: Bar["image"]) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("alt", image?.alt ?? "");
      const response = await fetch("/app/upload", { method: "POST", body });
      const result = await response.json();
      if (result.ok) onChange({ url: result.url, alt: result.alt });
      else setError(result.error || "Upload failed.");
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-stack gap="small-200">
      <s-text type="strong">{t("Bar image")}</s-text>
      {image ? (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-thumbnail src={image.url} alt={image.alt} size="small" />
          <div style={{ flex: 1 }}>
            <TextField label={t("Image description (alt text)")} value={image.alt} onChange={(alt) => onChange({ ...image, alt })} />
          </div>
          <s-button variant="tertiary" icon="x" accessibilityLabel={t("Remove image")} onClick={() => onChange(null)} />
        </s-stack>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) upload(file);
        }}
      />
      <div>
        <s-button icon="image" loading={busy || undefined} onClick={() => input.current?.click()}>
          {image ? t("Replace image") : t("Upload image")}
        </s-button>
      </div>
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </s-stack>
  );
}

function MetafieldVarsEditor({ vars, onChange }: { vars: MetafieldVar[]; onChange: (vars: MetafieldVar[]) => void }) {
  const t = useT();
  const set = (i: number, changes: Partial<MetafieldVar>) => onChange(vars.map((v, j) => (j === i ? { ...v, ...changes } : v)));
  return (
    <s-section heading={t("Metafield variables")}>
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Show a product metafield in any text, e.g. {"{{material}}"} from custom.material. Up to 4.
        </s-paragraph>
        {vars.map((v, i) => (
          <s-stack key={i} direction="inline" gap="small-200" alignItems="end">
            <Grid columns={3}>
              <TextField label={t("Variable")} value={v.name} placeholder="material" onChange={(name) => set(i, { name: name.trim() })} />
              <TextField label={t("Namespace")} value={v.namespace} placeholder="custom" onChange={(namespace) => set(i, { namespace: namespace.trim() })} />
              <TextField label={t("Key")} value={v.key} placeholder="material" onChange={(key) => set(i, { key: key.trim() })} />
            </Grid>
            <s-button variant="tertiary" icon="x" accessibilityLabel={`Remove variable ${i + 1}`} onClick={() => onChange(vars.filter((_, j) => j !== i))} />
          </s-stack>
        ))}
        {vars.length < 4 ? (
          <div>
            <s-button icon="plus" onClick={() => onChange([...vars, { name: "", namespace: "custom", key: "" }])}>
              {t("Add metafield variable")}
            </s-button>
          </div>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function BundleItemsEditor({
  items,
  onChange,
  pickVariant,
}: {
  items: BundleItem[];
  onChange: (items: BundleItem[]) => void;
  pickVariant: () => Promise<VariantRef | null>;
}) {
  const t = useT();
  const set = (id: string, changes: Partial<BundleItem>) => onChange(items.map((it) => (it.id === id ? { ...it, ...changes } : it)));
  return (
    <s-stack gap="small-200">
      <s-text type="strong">{t("Items in the bundle")}</s-text>
      <s-paragraph color="subdued">{t("The product being viewed plus the items you pick, each with its own discount. Checkout discounts complete sets only.")}</s-paragraph>
      {items.map((it) => (
        <s-box key={it.id} padding="small" border="base" borderRadius="base">
          <s-stack gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
              {it.variant ? (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-thumbnail src={it.variant.image ?? undefined} alt={it.variant.title} size="small" />
                  <s-text>{it.variant.title}</s-text>
                </s-stack>
              ) : (
                <s-text type="strong">{items.indexOf(it) === 0 ? t("The product being viewed") : t("Pick a product")}</s-text>
              )}
              <s-button-group>
                {items.indexOf(it) === 0 ? null : (
                  <s-button
                    variant="tertiary"
                    onClick={async () => {
                      const variant = await pickVariant();
                      if (variant) set(it.id, { variant });
                    }}
                  >
                    {it.variant ? t("Change") : t("Pick product")}
                  </s-button>
                )}
                {items.indexOf(it) === 0 ? null : (
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel={t("Remove item")}
                    onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                  />
                )}
              </s-button-group>
            </s-stack>
            <Grid columns={3}>
              <NumberField label={t("Quantity")} min={1} max={20} value={it.qty} onChange={(qty) => set(it.id, { qty: Math.max(1, Math.floor(qty)) })} />
              <Select
                label={t("Discount")}
                value={it.discountType}
                onChange={(dt) => set(it.id, { discountType: dt as DiscountType })}
                options={[
                  { value: "none", label: t("No discount") },
                  { value: "percentage", label: t("Percentage off") },
                  { value: "amount", label: t("Amount off each") },
                  { value: "fixed_total", label: t("Fixed price each") },
                ]}
              />
              {it.discountType !== "none" ? (
                <NumberField
                  label={it.discountType === "percentage" ? t("Percent") : t("Amount")}
                  min={0}
                  max={it.discountType === "percentage" ? 100 : undefined}
                  value={it.discountValue}
                  onChange={(discountValue) => set(it.id, { discountValue: Math.max(0, discountValue) })}
                />
              ) : null}
            </Grid>
          </s-stack>
        </s-box>
      ))}
      {items.length < 6 ? (
        <div>
          <s-button icon="plus" onClick={() => onChange([...items, newBundleItem({ discountType: "percentage", discountValue: 10 })])}>
            {t("Add item")}
          </s-button>
        </div>
      ) : null}
    </s-stack>
  );
}

/** Selling plans: which purchases the deal prices, and the widget's picker. */
function SubscriptionsEditor({
  subs,
  onChange,
}: {
  subs: Subscriptions;
  onChange: (changes: Partial<Subscriptions>) => void;
}) {
  const t = useT();
  return (
    <s-section heading={t("Subscriptions")}>
      <s-stack gap="base">
        <Select
          label={t("This deal applies to")}
          value={subs.apply}
          onChange={(apply) => onChange({ apply: apply as Subscriptions["apply"] })}
          options={[
            { value: "both", label: t("One-time and subscription purchases") },
            { value: "subscription", label: t("Subscription purchases only") },
            { value: "onetime", label: t("One-time purchases only") },
          ]}
        />
        <Checkbox
          label={t("Show a one-time / subscribe picker")}
          details={t("For products with a selling plan. The picker prices the whole deal from the plan the shopper chooses.")}
          checked={subs.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        {subs.enabled ? (
          <>
            <Grid>
              <TextField
                label={t("One-time text")}
                value={subs.onetimeLabel}
                onChange={(onetimeLabel) => onChange({ onetimeLabel })}
              />
              <TextField
                label={t("Subscribe text")}
                value={subs.subscribeLabel}
                onChange={(subscribeLabel) => onChange({ subscribeLabel })}
              />
            </Grid>
            <Select
              label={t("Selected when the page opens")}
              value={subs.preselect}
              onChange={(preselect) => onChange({ preselect: preselect as Subscriptions["preselect"] })}
              options={[
                { value: "onetime", label: t("One-time purchase") },
                { value: "subscribe", label: t("Subscribe") },
              ]}
            />
            <s-paragraph color="subdued">
              {t("Free gifts are always added as one-time items, never as a subscription.")}
            </s-paragraph>
          </>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function MixMatchEditor({
  mm,
  onChange,
  pickRefs,
}: {
  mm: MixMatch;
  onChange: (changes: Partial<MixMatch>) => void;
  pickRefs: (type: "product" | "collection", current: ResourceRef[]) => Promise<ResourceRef[] | null>;
}) {
  const t = useT();
  return (
    <s-section heading={t("Mix & match")}>
      <s-stack gap="base">
        <Checkbox
          label={t("Let shoppers fill a bar with different products")}
          details={t("Each unit after the first gets a “choose” button that opens a product picker.")}
          checked={mm.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        {mm.enabled ? (
          <>
            <Select
              label={t("Products shoppers can choose")}
              value={mm.pool}
              onChange={(pool) => onChange({ pool: pool as MixMatch["pool"] })}
              options={[
                { value: "visibility", label: t("Same products as the deal's visibility") },
                { value: "products", label: t("Selected products") },
                { value: "collections", label: t("Products in selected collections") },
                { value: "except", label: t("All products except selected") },
              ]}
            />
            {mm.pool === "products" || mm.pool === "except" ? (
              <ResourceList
                items={mm.products}
                label={t("products")}
                onPick={async () => {
                  const products = await pickRefs("product", mm.products);
                  if (products) onChange({ products });
                }}
                onRemove={(id) => onChange({ products: mm.products.filter((p) => p.id !== id) })}
              />
            ) : null}
            {mm.pool === "collections" ? (
              <ResourceList
                items={mm.collections}
                label={t("collections")}
                onPick={async () => {
                  const collections = await pickRefs("collection", mm.collections);
                  if (collections) onChange({ collections });
                }}
                onRemove={(id) => onChange({ collections: mm.collections.filter((c) => c.id !== id) })}
              />
            ) : null}
            <Grid>
              <TextField label={t("Picker title")} value={mm.modalTitle} onChange={(modalTitle) => onChange({ modalTitle })} />
              <TextField label={t("Button text")} value={mm.buttonText} onChange={(buttonText) => onChange({ buttonText })} />
              <NumberField label={t("Product photo size")} min={32} max={160} suffix="px" value={mm.photoSize} onChange={(photoSize) => onChange({ photoSize })} />
            </Grid>
            <Checkbox label={t("Show product names")} checked={mm.showNames} onChange={(showNames) => onChange({ showNames })} />
          </>
        ) : null}
      </s-stack>
    </s-section>
  );
}

type AbResults = LoaderData["ab"];

function AbTestPanel({
  test,
  results,
  editing,
  onEdit,
  onChange,
  onApply,
  snapshot,
}: {
  test: DealConfig["abTest"];
  results: AbResults;
  editing: ArmKey;
  onEdit: (key: ArmKey) => void;
  /** Variant A's fields, copied: a new variant starts as the deal is now. */
  snapshot: () => ArmOverride;
  onChange: (test: DealConfig["abTest"]) => void;
  onApply: (key: ArmKey) => void;
}) {
  const t = useT();
  const keys: ArmKey[] = ["A", ...(Object.keys(test.arms) as ArmKey[])];
  const next = ARM_KEYS.find((k) => !keys.includes(k));
  const even = (list: ArmKey[]) => {
    const share = Math.floor(100 / list.length);
    return Object.fromEntries(list.map((k, i) => [k, i === 0 ? 100 - share * (list.length - 1) : share]));
  };
  const total = keys.reduce((sum, k) => sum + (test.weights[k] ?? 0), 0);
  const running = test.status === "running";
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  return (
    <s-section heading={t("A/B test")}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge tone={running ? "success" : test.status === "ended" ? "info" : "neutral"}>
            {running ? "Running" : test.status === "ended" ? t("Ended") : t("Not running")}
          </s-badge>
          <s-text color="subdued">
            Test up to four variants of this deal — bars, prices, style, text. Visitors keep their variant. A winner needs at least{" "}
            {MIN_ORDERS_PER_ARM} orders per variant and a significant difference in conversion rate.
          </s-text>
        </s-stack>

        {keys.length > 1 ? (
          <s-stack direction="inline" gap="small-200">
            {keys.map((k) => (
              <s-button key={k} variant={editing === k ? "primary" : "secondary"} onClick={() => onEdit(k)}>
                {`Edit ${k}`}
              </s-button>
            ))}
          </s-stack>
        ) : null}

        {keys.length > 1 ? (
          <s-stack gap="small-200">
            <s-text type="strong">{t("Traffic split")}</s-text>
            <Grid columns={4}>
              {keys.map((k) => (
                <NumberField
                  key={k}
                  label={`Variant ${k}`}
                  min={0}
                  max={100}
                  suffix="%"
                  value={test.weights[k] ?? 0}
                  onChange={(w) => onChange({ ...test, weights: { ...test.weights, [k]: Math.max(0, Math.min(100, Math.round(w))) } })}
                />
              ))}
            </Grid>
            {total !== 100 ? <s-text tone="critical">{`The split adds up to ${total}%; it must be 100%.`}</s-text> : null}
          </s-stack>
        ) : null}

        <s-button-group>
          {next && !running ? (
            <s-button
              icon="plus"
              onClick={() => {
                // A new variant starts as a copy of the deal as it is now.
                const list = [...keys, next];
                onChange({ ...test, arms: { ...test.arms, [next]: snapshot() }, weights: even(list) });
                onEdit(next);
              }}
            >
              {`Add variant ${next}`}
            </s-button>
          ) : null}
          {keys.length > 1 && !running ? (
            <s-button onClick={() => onChange({ ...test, weights: even(keys) })}>{t("Split evenly")}</s-button>
          ) : null}
          {keys.length > 1 && !running ? (
            <s-button
              variant="primary"
              onClick={() => onChange({ ...test, status: "running", startedAt: new Date().toISOString(), endedAt: null })}
            >
              {t("Start test")}
            </s-button>
          ) : null}
          {running ? (
            <s-button tone="critical" onClick={() => onChange({ ...test, status: "ended", endedAt: new Date().toISOString() })}>
              {t("End test")}
            </s-button>
          ) : null}
          {editing !== "A" && !running ? (
            <s-button
              tone="critical"
              variant="tertiary"
              onClick={() => {
                const arms = { ...test.arms };
                delete arms[editing as "B"];
                const list = keys.filter((k) => k !== editing);
                onChange({ ...test, arms, weights: even(list), status: list.length > 1 ? test.status : "off" });
                onEdit("A");
              }}
            >
              {`Remove variant ${editing}`}
            </s-button>
          ) : null}
        </s-button-group>
        <s-text color="subdued">{t("Changes to the test take effect when you save.")}</s-text>

        {results ? (
          <s-stack gap="small-200">
            <s-text type="strong">
              {results.status === "winner"
                ? `Variant ${results.winner} is the winner.`
                : results.status === "no_clear_winner"
                  ? "No clear winner yet: the difference isn't significant."
                  : `Collecting data: every variant needs ${MIN_ORDERS_PER_ARM} orders.`}
            </s-text>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("Variant")}</s-table-header>
                <s-table-header format="numeric">{t("Visitors")}</s-table-header>
                <s-table-header format="numeric">{t("Orders")}</s-table-header>
                <s-table-header format="numeric">{t("Conversion")}</s-table-header>
                <s-table-header format="numeric">{t("Lift vs A")}</s-table-header>
                <s-table-header format="numeric">{t("p-value")}</s-table-header>
                <s-table-header>{t("Action")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {results.arms.map((r) => (
                  <s-table-row key={r.key}>
                    <s-table-cell>
                      {r.key}
                      {results.winner === r.key ? " — winner" : ""}
                    </s-table-cell>
                    <s-table-cell>{r.visitors}</s-table-cell>
                    <s-table-cell>{r.orders}</s-table-cell>
                    <s-table-cell>{pct(r.conversion)}</s-table-cell>
                    <s-table-cell>{r.lift == null ? "—" : `${r.lift >= 0 ? "+" : "−"}${Math.abs(r.lift * 100).toFixed(1)}%`}</s-table-cell>
                    <s-table-cell>{r.key === "A" ? "—" : r.p.toFixed(3)}</s-table-cell>
                    <s-table-cell>
                      {r.key !== "A" && test.arms[r.key as "B"] ? (
                        <s-button
                          variant={results.winner === r.key ? "primary" : "tertiary"}
                          onClick={() => {
                            if (confirm(`Make variant ${r.key} the deal and end the test?`)) onApply(r.key as ArmKey);
                          }}
                        >
                          {results.winner === r.key ? t("Apply winner") : t("Apply")}
                        </s-button>
                      ) : null}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}

/** Deal texts per language, with auto-translate. */
function TranslationsEditor({
  locales,
  texts,
  translations,
  busy,
  onChange,
  onTranslate,
}: {
  locales: { locale: string; name: string; primary: boolean }[];
  texts: Record<string, string>;
  translations: Record<string, DealTranslation>;
  busy: string | null;
  onChange: (translations: Record<string, DealTranslation>) => void;
  onTranslate: (locale: string, language: string) => void;
}) {
  const t = useT();
  const others = locales.filter((l) => !l.primary);
  const [locale, setLocale] = useState(others[0]?.locale ?? "");
  const language = others.find((l) => l.locale === locale);
  const current = translations[locale] ?? {};
  const flat = translationToTexts(current);

  const set = (key: string, value: string) =>
    onChange({ ...translations, [locale]: translationFromTexts({ ...flat, [key]: value }) });

  return (
    <s-section heading={t("Translations")}>
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Your storefront shows these texts in the shopper&apos;s language. Anything you leave empty stays in{" "}
          {locales.find((l) => l.primary)?.name ?? "your default language"}.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <Select
            label={t("Language")}
            value={locale}
            onChange={setLocale}
            options={others.map((l) => ({ value: l.locale, label: `${l.name} (${l.locale})` }))}
          />
          <s-button
            loading={busy === locale || undefined}
            onClick={() => language && onTranslate(locale, `${language.name} (${language.locale})`)}
          >
            {t("Translate automatically")}
          </s-button>
        </s-stack>
        <s-stack gap="small-200">
          {Object.entries(texts).map(([key, source]) => (
            <Grid key={key}>
              <s-stack gap="small-100">
                <s-text color="subdued">{source}</s-text>
              </s-stack>
              <TextField label={key} value={flat[key] ?? ""} placeholder={source} onChange={(v) => set(key, v)} />
            </Grid>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/** A DealTranslation back to flat { key: text } (the shape the editor edits). */
function translationToTexts(t: DealTranslation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["blockTitle", "savingsText", "modalTitle", "modalButton"] as const) {
    if (t[key]) out[key] = t[key]!;
  }
  for (const [barId, fields] of Object.entries(t.bars ?? {})) {
    for (const [field, value] of Object.entries(fields ?? {})) {
      if (field === "highlights" && Array.isArray(value)) {
        value.forEach((h, i) => {
          if (h) out[`bars.${barId}.highlights.${i}`] = h;
        });
      } else if (typeof value === "string" && value) {
        out[`bars.${barId}.${field}`] = value;
      }
    }
  }
  for (const [id, text] of Object.entries(t.upsells ?? {})) if (text) out[`upsells.${id}`] = text;
  return out;
}

const COLOR_FIELDS: [keyof DealStyle["colors"], string][] = [
  ["accent", "Accent (radio, checkbox)"],
  ["barBg", "Bar background"],
  ["barSelectedBg", "Selected bar background"],
  ["border", "Border"],
  ["borderSelected", "Selected border"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["price", "Price"],
  ["fullPrice", "Full price"],
  ["labelBg", "Label background"],
  ["labelText", "Label text"],
  ["badgeBg", "Badge background"],
  ["badgeText", "Badge text"],
  ["blockTitle", "Block title"],
];

/** Optional colours: empty follows another colour. */
const EXTRA_COLOR_FIELDS: [keyof DealStyle["colors"], string, string][] = [
  ["giftBg", "Gift background", "Same as label"],
  ["giftText", "Gift text", "Same as label"],
  ["upsellBg", "Upsell background", "Transparent"],
  ["upsellText", "Upsell text", "Same as title"],
  ["upsellBorder", "Upsell border", "Same as border"],
];

const WEIGHTS = [
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extra bold" },
];

const slotLabel = (link: string) => {
  const m = /^brand:(\w+)\.(\d)$/.exec(link);
  return m ? `Brand ${m[1]} ${Number(m[2]) + 1}` : link;
};

/** A colour that may be a hex or a link to a brand palette slot. */
function ColorSlot({
  label,
  value,
  palette,
  onChange,
  emptyLabel,
}: {
  label: string;
  value: string;
  palette: BrandPalette | null;
  onChange: (v: string) => void;
  emptyLabel?: string;
}) {
  const t = useT();
  if (value.startsWith("brand:")) {
    const hex = resolveColor(value, palette);
    return (
      <s-stack gap="small-100">
        <s-text>{label}</s-text>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid #ccc", background: hex || "transparent" }} />
          <s-badge tone="info">{slotLabel(value)}</s-badge>
          <s-button variant="tertiary" onClick={() => onChange(hex || "#000000")}>
            {t("Unlink")}
          </s-button>
        </s-stack>
      </s-stack>
    );
  }
  if (emptyLabel && !value) {
    return (
      <s-stack gap="small-100">
        <s-text>{label}</s-text>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text color="subdued">{emptyLabel}</s-text>
          <s-button variant="tertiary" onClick={() => onChange("#ffffff")}>
            {t("Set colour")}
          </s-button>
        </s-stack>
      </s-stack>
    );
  }
  return (
    <s-stack gap="small-100">
      <ColorField label={label} value={value} onChange={onChange} />
      <s-stack direction="inline" gap="small-200">
        {palette ? (
          <select
            aria-label={`Link ${label} to a brand colour`}
            value=""
            onChange={(e) => e.currentTarget.value && onChange(e.currentTarget.value)}
            style={{ fontSize: 12 }}
          >
            <option value="">{t("Use a brand colour…")}</option>
            {BRAND_GROUPS.flatMap((g) =>
              palette[g].map((hex, i) => (
                <option key={`${g}.${i}`} value={`brand:${g}.${i}`}>
                  {`${g} ${i + 1} (${hex})`}
                </option>
              )),
            )}
          </select>
        ) : null}
        {emptyLabel ? (
          <s-button variant="tertiary" onClick={() => onChange("")}>
            {t("Reset")}
          </s-button>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

function StyleEditor({
  style,
  palette,
  onChange,
}: {
  style: DealStyle;
  palette: BrandPalette | null;
  onChange: (changes: Partial<DealStyle>) => void;
}) {
  const t = useT();
  const sb = style.savingsBar;
  const setSb = (changes: Partial<DealStyle["savingsBar"]>) => onChange({ savingsBar: { ...sb, ...changes } });
  return (
    <s-section heading={t("Style")}>
      <s-stack gap="base">
        <s-stack gap="small-200">
          <s-text type="strong">{t("Theme")}</s-text>
          <s-stack direction="inline" gap="small-200">
            {Object.entries(PRESET_THEMES).map(([key, preset]) => (
              <s-button key={key} onClick={() => onChange({ colors: { ...style.colors, ...preset.colors } })}>
                {preset.label}
              </s-button>
            ))}
            {palette ? (
              <s-button variant="primary" onClick={() => onChange({ colors: { ...style.colors, ...BRAND_LINKS } })}>
                {t("Use brand colours")}
              </s-button>
            ) : (
              <s-link href="/app/settings">{t("Set up brand colours")}</s-link>
            )}
          </s-stack>
        </s-stack>

        <Grid columns={3}>
          <Select
            label={t("Layout")}
            value={style.layout}
            onChange={(layout) => onChange({ layout: layout as DealStyle["layout"] })}
            options={[
              { value: "vertical", label: t("Vertical list") },
              { value: "horizontal", label: t("Horizontal") },
              { value: "grid", label: t("Grid (2 columns)") },
              { value: "plain", label: t("Plain (no cards)") },
            ]}
          />
          <NumberField label={t("Corner radius")} min={0} max={30} suffix="px" value={style.radius} onChange={(radius) => onChange({ radius })} />
          <NumberField label={t("Border width")} min={0} max={6} suffix="px" value={style.borderWidth} onChange={(borderWidth) => onChange({ borderWidth })} />
          <NumberField label={t("Space between bars")} min={0} max={32} suffix="px" value={style.barGap} onChange={(barGap) => onChange({ barGap })} />
          <NumberField label={t("Bar padding")} min={4} max={32} suffix="px" value={style.barPadding} onChange={(barPadding) => onChange({ barPadding })} />
          <NumberField label={t("Bar image size")} min={24} max={160} suffix="px" value={style.imageSize} onChange={(imageSize) => onChange({ imageSize })} />
        </Grid>

        <s-heading>{t("Text")}</s-heading>
        <Grid columns={3}>
          <NumberField label={t("Title size")} min={11} max={24} suffix="px" value={style.titleSize} onChange={(titleSize) => onChange({ titleSize })} />
          <Select label={t("Title weight")} value={String(style.titleWeight)} onChange={(v) => onChange({ titleWeight: Number(v) })} options={WEIGHTS} />
          <NumberField label={t("Subtitle size")} min={9} max={24} suffix="px" value={style.subtitleSize} onChange={(subtitleSize) => onChange({ subtitleSize })} />
          <NumberField label={t("Price size")} min={10} max={32} suffix="px" value={style.priceSize} onChange={(priceSize) => onChange({ priceSize })} />
          <NumberField label={t("Block title size")} min={9} max={28} suffix="px" value={style.blockTitleSize} onChange={(blockTitleSize) => onChange({ blockTitleSize })} />
          <Select label={t("Block title weight")} value={String(style.blockTitleWeight)} onChange={(v) => onChange({ blockTitleWeight: Number(v) })} options={WEIGHTS} />
        </Grid>
        <Grid>
          <TextField label={t("Block title")} value={style.blockTitle} onChange={(blockTitle) => onChange({ blockTitle })} />
          <s-stack gap="small-200">
            <Checkbox label={t("Show block title")} checked={style.showBlockTitle} onChange={(showBlockTitle) => onChange({ showBlockTitle })} />
            <Checkbox label={t("Show price per item")} checked={style.showUnitPrice} onChange={(showUnitPrice) => onChange({ showUnitPrice })} />
            <Checkbox
              label={t("Use product compare-at price as the full price")}
              checked={style.useCompareAt}
              onChange={(useCompareAt) => onChange({ useCompareAt })}
            />
            <Checkbox
              label={t("Show the gift track")}
              details={t("Every gift tier above the bars, unlocked as bigger bars are chosen.")}
              checked={style.giftTrack}
              onChange={(giftTrack) => onChange({ giftTrack })}
            />
          </s-stack>
        </Grid>

        <s-heading>{t("Variant pickers")}</s-heading>
        <Grid columns={3}>
          <Select
            label={t("Show variants as")}
            value={style.variants.display}
            onChange={(display) => onChange({ variants: { ...style.variants, display: display as DealStyle["variants"]["display"] } })}
            options={[
              { value: "dropdown", label: t("Dropdowns") },
              { value: "swatch", label: t("Swatches") },
            ]}
          />
          {style.variants.display === "swatch" ? (
            <>
              <Select
                label={t("Swatch")}
                value={style.variants.source}
                onChange={(source) => onChange({ variants: { ...style.variants, source: source as DealStyle["variants"]["source"] } })}
                options={[
                  { value: "color", label: t("Colour (from the product's option swatches)") },
                  { value: "image", label: t("Uploaded swatch image") },
                  { value: "variant_image", label: t("Variant image") },
                ]}
              />
              <Select
                label={t("Shape")}
                value={style.variants.shape}
                onChange={(shape) => onChange({ variants: { ...style.variants, shape: shape as DealStyle["variants"]["shape"] } })}
                options={[
                  { value: "circle", label: t("Circle") },
                  { value: "rounded", label: t("Rounded") },
                  { value: "square", label: t("Square") },
                ]}
              />
              <NumberField
                label={t("Swatch size")}
                min={16}
                max={64}
                suffix="px"
                value={style.variants.size}
                onChange={(size) => onChange({ variants: { ...style.variants, size } })}
              />
            </>
          ) : null}
        </Grid>

        <s-heading>{t("Colours")}</s-heading>
        <Grid columns={3}>
          {COLOR_FIELDS.map(([key, label]) => (
            <ColorSlot
              key={key}
              label={label}
              value={style.colors[key]}
              palette={palette}
              onChange={(value) => onChange({ colors: { ...style.colors, [key]: value } })}
            />
          ))}
          {EXTRA_COLOR_FIELDS.map(([key, label, emptyLabel]) => (
            <ColorSlot
              key={key}
              label={label}
              value={style.colors[key]}
              palette={palette}
              emptyLabel={emptyLabel}
              onChange={(value) => onChange({ colors: { ...style.colors, [key]: value } })}
            />
          ))}
        </Grid>

        <s-heading>{t("Savings summary")}</s-heading>
        <Checkbox
          label={t("Show a savings summary under the bars")}
          details={t("“You're saving $X on this order” — updates as shoppers change their choice; hidden when there's no saving.")}
          checked={sb.enabled}
          onChange={(enabled) => setSb({ enabled })}
        />
        {sb.enabled ? (
          <>
            <TextField
              label={t("Text")}
              value={sb.text}
              details="Use {{saved_amount}} and {{saved_percentage}}."
              onChange={(text) => setSb({ text })}
            />
            <Grid columns={3}>
              <ColorSlot label={t("Background")} value={sb.background} palette={palette} onChange={(background) => setSb({ background })} />
              <ColorSlot label={t("Text colour")} value={sb.textColor} palette={palette} onChange={(textColor) => setSb({ textColor })} />
              <ColorSlot label={t("Savings colour")} value={sb.valueColor} palette={palette} onChange={(valueColor) => setSb({ valueColor })} />
              <Select
                label={t("Alignment")}
                value={sb.align}
                onChange={(align) => setSb({ align: align as DealStyle["savingsBar"]["align"] })}
                options={[
                  { value: "left", label: t("Left") },
                  { value: "center", label: t("Centre") },
                  { value: "right", label: t("Right") },
                ]}
              />
              <NumberField label={t("Text size")} min={10} max={24} suffix="px" value={sb.size} onChange={(size) => setSb({ size })} />
            </Grid>
            <s-stack direction="inline" gap="base">
              <Checkbox label={t("Count free gifts as savings")} checked={sb.includeGifts} onChange={(includeGifts) => setSb({ includeGifts })} />
              <Checkbox label={t("Border")} checked={sb.border} onChange={(border) => setSb({ border })} />
              <Checkbox label={t("Icon")} checked={sb.icon} onChange={(icon) => setSb({ icon })} />
            </s-stack>
          </>
        ) : null}

        <s-heading>{t("Custom code")}</s-heading>
        <TextArea
          label={t("HTML above the bars")}
          value={style.htmlAbove}
          rows={3}
          details={t("Shown as written on your store. The preview leaves out scripts.")}
          onChange={(htmlAbove) => onChange({ htmlAbove })}
        />
        <TextArea label={t("HTML below the bars")} value={style.htmlBelow} rows={3} onChange={(htmlBelow) => onChange({ htmlBelow })} />
        <TextArea
          label={t("CSS for this deal")}
          value={style.customCss}
          rows={5}
          details="Applies to this deal only, e.g. .cl-bar-title { letter-spacing: 0.04em; }"
          onChange={(customCss) => onChange({ customCss })}
        />
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
