import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getDeal, nextPriority, parseDealInput, shopIdFor } from "../lib/deal.server";
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const TYPES: DealTypeKey[] = ["QUANTITY_BREAK", "BXGY", "BUNDLE"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { moneyFormat: true, currencyCode: true, settings: true },
  });
  const moneyFormat = (shop?.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, "");
  const palette = normalizePalette((shop?.settings as { brandPalette?: unknown } | null)?.brandPalette);

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
  const { deal: initial, isNew, moneyFormat, currency } = data;
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();

  const [deal, setDeal] = useState<EditorDeal>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [previewPrice, setPreviewPrice] = useState(29.99);
  const [previewProduct, setPreviewProduct] = useState<PreviewProduct | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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
    <s-page heading={isNew ? `New deal: ${TEMPLATE_INFO[deal.type].title}` : deal.name}>
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
  const bxgy = bar.kind === "bxgy";
  const bundle = bar.kind === "bundle";
  return (
    <s-box padding="base" border="base" borderRadius="base" background={bar.selected ? "subdued" : undefined}>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Bar {index + 1}</s-heading>
            <s-badge tone={bxgy ? "info" : bundle ? "success" : "neutral"}>
              {bxgy ? "Buy X get Y" : bundle ? "Complete the bundle" : "Quantity break"}
            </s-badge>
            {bar.selected ? <s-badge tone="success">Default</s-badge> : null}
          </s-stack>
          <s-button-group>
            <s-button icon="arrow-up" variant="tertiary" accessibilityLabel="Move up" disabled={index === 0 || undefined} onClick={() => onMove(-1)} />
            <s-button
              icon="arrow-down"
              variant="tertiary"
              accessibilityLabel="Move down"
              disabled={index === count - 1 || undefined}
              onClick={() => onMove(1)}
            />
            <s-button
              icon="delete"
              variant="tertiary"
              tone="critical"
              accessibilityLabel="Remove bar"
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
              label="Bar type"
              value={bar.kind}
              onChange={(kind) =>
                onChange(
                  kind === "bxgy"
                    ? { kind: "bxgy", get: Math.max(1, Math.floor(bar.qty / 2)), qty: Math.max(2, bar.qty) }
                    : { kind: "qty", get: 0 },
                )
              }
              options={[
                { value: "qty", label: "Quantity break" },
                { value: "bxgy", label: "Buy X get Y" },
              ]}
            />
          ) : null}
          {bundle ? null : bxgy ? (
            <>
              <NumberField
                label="Buy"
                min={1}
                value={bar.qty - bar.get}
                onChange={(buy) => onChange({ qty: Math.max(1, Math.floor(buy)) + bar.get })}
              />
              <NumberField
                label="Get"
                min={1}
                value={bar.get}
                onChange={(get) => {
                  const g = Math.max(1, Math.floor(get));
                  onChange({ get: g, qty: bar.qty - bar.get + g });
                }}
              />
            </>
          ) : (
            <NumberField label="Quantity" min={1} value={bar.qty} onChange={(qty) => onChange({ qty: Math.max(1, Math.floor(qty)) })} />
          )}
          {bundle ? null : (
          <Select
            label={bxgy ? "Discount on the free items" : "Discount"}
            value={bar.discountType}
            onChange={(dt) => onChange({ discountType: dt as DiscountType })}
            options={
              bxgy
                ? [
                    { value: "percentage", label: "Percentage off (100 = free)" },
                    { value: "amount", label: "Amount off each" },
                    { value: "fixed_total", label: "Fixed price each" },
                  ]
                : DISCOUNT_OPTIONS
            }
          />
          )}
          {!bundle && bar.discountType !== "none" ? (
            <NumberField
              label={bar.discountType === "percentage" ? "Percent" : "Amount"}
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
              label="Extra discount on the rest"
              details="On top of the free items, e.g. Buy 3 get 1 + 10%."
              min={0}
              max={100}
              suffix="%"
              value={bar.extraPercent}
              onChange={(extraPercent) => onChange({ extraPercent: Math.min(100, Math.max(0, extraPercent)) })}
            />
          ) : null}
        </Grid>

        <Grid>
          <TextField label="Title" value={bar.title} onChange={(title) => onChange({ title })} />
          <TextField label="Subtitle" value={bar.subtitle} onChange={(subtitle) => onChange({ subtitle })} />
          <TextField label="Label" value={bar.label} onChange={(label) => onChange({ label })} placeholder="e.g. SAVE 20%" />
          <TextField label="Badge" value={bar.badge} onChange={(badge) => onChange({ badge })} placeholder="e.g. Most popular" />
        </Grid>
        <HighlightsEditor highlights={bar.highlights} onChange={(highlights) => onChange({ highlights })} />
        <BarImageEditor image={bar.image} onChange={(image) => onChange({ image })} />
        <s-stack gap="small-200">
          <s-text type="strong">Default variants</s-text>
          <s-paragraph color="subdued">
            Pre-selected in the variant pickers, one per item in order. Only variants of the product being viewed are used.
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
              {bar.defaultVariants.length ? "Change default variants" : "Set default variants"}
            </s-button>
            {bar.defaultVariants.length ? (
              <s-button variant="tertiary" onClick={() => onChange({ defaultVariants: [] })}>
                Clear
              </s-button>
            ) : null}
          </s-button-group>
        </s-stack>
        <s-stack direction="inline" gap="base">
          <Checkbox label="Selected by default" checked={bar.selected} onChange={(selected) => onChange({ selected })} />
          {bar.badge ? (
            <Checkbox
              label="Fancy badge"
              checked={bar.badgeStyle === "fancy"}
              onChange={(fancy) => onChange({ badgeStyle: fancy ? "fancy" : "simple" })}
            />
          ) : null}
        </s-stack>

        {/* Free gifts */}
        <s-stack gap="small-200">
          <s-text type="strong">Free gifts</s-text>
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
          {bar.gifts.length ? <TextField label="Gift text" value={bar.giftText} onChange={(giftText) => onChange({ giftText })} /> : null}
          {bar.gifts.length < 5 ? (
            <div>
              <s-button
                icon="gift-card"
                onClick={async () => {
                  const gift = await pickVariant();
                  if (gift && !bar.gifts.some((g) => g.id === gift.id)) onChange({ gifts: [...bar.gifts, gift] });
                }}
              >
                Add free gift
              </s-button>
            </div>
          ) : null}
        </s-stack>

        {/* Upsells */}
        <s-stack gap="small-200">
          <s-text type="strong">Upsells on this bar</s-text>
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
              Add upsell
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
              Add complementary products
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
  const complementary = upsell.source === "complementary";
  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          {complementary ? (
            <s-stack gap="small-100">
              <s-text type="strong">Complementary products</s-text>
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
                Change
              </s-button>
            )}
            <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel="Remove upsell" onClick={onRemove} />
          </s-button-group>
        </s-stack>
        {complementary ? (
          <NumberField
            label="Products to offer"
            min={1}
            max={4}
            value={upsell.limit}
            onChange={(limit) => onChange({ limit: Math.min(4, Math.max(1, Math.floor(limit))) })}
          />
        ) : null}
        <TextField label="Text" value={upsell.text} onChange={(text) => onChange({ text })} />
        <Grid>
          <Select
            label="Discount"
            value={upsell.discountType}
            onChange={(dt) => onChange({ discountType: dt as DiscountType })}
            options={[
              { value: "none", label: "No discount" },
              { value: "percentage", label: "Percentage off" },
              { value: "amount", label: "Amount off" },
              { value: "fixed_total", label: "Fixed price" },
            ]}
          />
          {upsell.discountType !== "none" ? (
            <NumberField label="Value" min={0} value={upsell.discountValue} onChange={(discountValue) => onChange({ discountValue })} />
          ) : null}
        </Grid>
        <s-stack direction="inline" gap="base">
          <Checkbox label="Pre-checked" checked={upsell.checked} onChange={(checked) => onChange({ checked })} />
          <Checkbox
            label="Only show when this bar is selected"
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
  return (
    <s-stack gap="small-200">
      <s-text type="strong">Highlights</s-text>
      {highlights.map((h, i) => (
        <s-stack key={i} direction="inline" gap="small-200" alignItems="end">
          <div style={{ flex: 1 }}>
            <TextField
              label={`Highlight ${i + 1}`}
              value={h}
              placeholder="e.g. Free shipping"
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
            Add highlight
          </s-button>
        </div>
      ) : null}
    </s-stack>
  );
}

function BarImageEditor({ image, onChange }: { image: Bar["image"]; onChange: (image: Bar["image"]) => void }) {
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
      <s-text type="strong">Bar image</s-text>
      {image ? (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-thumbnail src={image.url} alt={image.alt} size="small" />
          <div style={{ flex: 1 }}>
            <TextField label="Image description (alt text)" value={image.alt} onChange={(alt) => onChange({ ...image, alt })} />
          </div>
          <s-button variant="tertiary" icon="x" accessibilityLabel="Remove image" onClick={() => onChange(null)} />
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
          {image ? "Replace image" : "Upload image"}
        </s-button>
      </div>
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </s-stack>
  );
}

function MetafieldVarsEditor({ vars, onChange }: { vars: MetafieldVar[]; onChange: (vars: MetafieldVar[]) => void }) {
  const set = (i: number, changes: Partial<MetafieldVar>) => onChange(vars.map((v, j) => (j === i ? { ...v, ...changes } : v)));
  return (
    <s-section heading="Metafield variables">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Show a product metafield in any text, e.g. {"{{material}}"} from custom.material. Up to 4.
        </s-paragraph>
        {vars.map((v, i) => (
          <s-stack key={i} direction="inline" gap="small-200" alignItems="end">
            <Grid columns={3}>
              <TextField label="Variable" value={v.name} placeholder="material" onChange={(name) => set(i, { name: name.trim() })} />
              <TextField label="Namespace" value={v.namespace} placeholder="custom" onChange={(namespace) => set(i, { namespace: namespace.trim() })} />
              <TextField label="Key" value={v.key} placeholder="material" onChange={(key) => set(i, { key: key.trim() })} />
            </Grid>
            <s-button variant="tertiary" icon="x" accessibilityLabel={`Remove variable ${i + 1}`} onClick={() => onChange(vars.filter((_, j) => j !== i))} />
          </s-stack>
        ))}
        {vars.length < 4 ? (
          <div>
            <s-button icon="plus" onClick={() => onChange([...vars, { name: "", namespace: "custom", key: "" }])}>
              Add metafield variable
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
  const set = (id: string, changes: Partial<BundleItem>) => onChange(items.map((it) => (it.id === id ? { ...it, ...changes } : it)));
  return (
    <s-stack gap="small-200">
      <s-text type="strong">Items in the bundle</s-text>
      <s-paragraph color="subdued">The product being viewed plus the items you pick, each with its own discount. Checkout discounts complete sets only.</s-paragraph>
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
                <s-text type="strong">{items.indexOf(it) === 0 ? "The product being viewed" : "Pick a product"}</s-text>
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
                    {it.variant ? "Change" : "Pick product"}
                  </s-button>
                )}
                {items.indexOf(it) === 0 ? null : (
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel="Remove item"
                    onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                  />
                )}
              </s-button-group>
            </s-stack>
            <Grid columns={3}>
              <NumberField label="Quantity" min={1} max={20} value={it.qty} onChange={(qty) => set(it.id, { qty: Math.max(1, Math.floor(qty)) })} />
              <Select
                label="Discount"
                value={it.discountType}
                onChange={(dt) => set(it.id, { discountType: dt as DiscountType })}
                options={[
                  { value: "none", label: "No discount" },
                  { value: "percentage", label: "Percentage off" },
                  { value: "amount", label: "Amount off each" },
                  { value: "fixed_total", label: "Fixed price each" },
                ]}
              />
              {it.discountType !== "none" ? (
                <NumberField
                  label={it.discountType === "percentage" ? "Percent" : "Amount"}
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
            Add item
          </s-button>
        </div>
      ) : null}
    </s-stack>
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
  return (
    <s-section heading="Mix & match">
      <s-stack gap="base">
        <Checkbox
          label="Let shoppers fill a bar with different products"
          details="Each unit after the first gets a “choose” button that opens a product picker."
          checked={mm.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        {mm.enabled ? (
          <>
            <Select
              label="Products shoppers can choose"
              value={mm.pool}
              onChange={(pool) => onChange({ pool: pool as MixMatch["pool"] })}
              options={[
                { value: "visibility", label: "Same products as the deal's visibility" },
                { value: "products", label: "Selected products" },
                { value: "collections", label: "Products in selected collections" },
                { value: "except", label: "All products except selected" },
              ]}
            />
            {mm.pool === "products" || mm.pool === "except" ? (
              <ResourceList
                items={mm.products}
                label="products"
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
                label="collections"
                onPick={async () => {
                  const collections = await pickRefs("collection", mm.collections);
                  if (collections) onChange({ collections });
                }}
                onRemove={(id) => onChange({ collections: mm.collections.filter((c) => c.id !== id) })}
              />
            ) : null}
            <Grid>
              <TextField label="Picker title" value={mm.modalTitle} onChange={(modalTitle) => onChange({ modalTitle })} />
              <TextField label="Button text" value={mm.buttonText} onChange={(buttonText) => onChange({ buttonText })} />
              <NumberField label="Product photo size" min={32} max={160} suffix="px" value={mm.photoSize} onChange={(photoSize) => onChange({ photoSize })} />
            </Grid>
            <Checkbox label="Show product names" checked={mm.showNames} onChange={(showNames) => onChange({ showNames })} />
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
    <s-section heading="A/B test">
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge tone={running ? "success" : test.status === "ended" ? "info" : "neutral"}>
            {running ? "Running" : test.status === "ended" ? "Ended" : "Not running"}
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
            <s-text type="strong">Traffic split</s-text>
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
            <s-button onClick={() => onChange({ ...test, weights: even(keys) })}>Split evenly</s-button>
          ) : null}
          {keys.length > 1 && !running ? (
            <s-button
              variant="primary"
              onClick={() => onChange({ ...test, status: "running", startedAt: new Date().toISOString(), endedAt: null })}
            >
              Start test
            </s-button>
          ) : null}
          {running ? (
            <s-button tone="critical" onClick={() => onChange({ ...test, status: "ended", endedAt: new Date().toISOString() })}>
              End test
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
        <s-text color="subdued">Changes to the test take effect when you save.</s-text>

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
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header format="numeric">Visitors</s-table-header>
                <s-table-header format="numeric">Orders</s-table-header>
                <s-table-header format="numeric">Conversion</s-table-header>
                <s-table-header format="numeric">Lift vs A</s-table-header>
                <s-table-header format="numeric">p-value</s-table-header>
                <s-table-header>Action</s-table-header>
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
                          {results.winner === r.key ? "Apply winner" : "Apply"}
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
  if (value.startsWith("brand:")) {
    const hex = resolveColor(value, palette);
    return (
      <s-stack gap="small-100">
        <s-text>{label}</s-text>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid #ccc", background: hex || "transparent" }} />
          <s-badge tone="info">{slotLabel(value)}</s-badge>
          <s-button variant="tertiary" onClick={() => onChange(hex || "#000000")}>
            Unlink
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
            Set colour
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
            <option value="">Use a brand colour…</option>
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
            Reset
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
  const sb = style.savingsBar;
  const setSb = (changes: Partial<DealStyle["savingsBar"]>) => onChange({ savingsBar: { ...sb, ...changes } });
  return (
    <s-section heading="Style">
      <s-stack gap="base">
        <s-stack gap="small-200">
          <s-text type="strong">Theme</s-text>
          <s-stack direction="inline" gap="small-200">
            {Object.entries(PRESET_THEMES).map(([key, preset]) => (
              <s-button key={key} onClick={() => onChange({ colors: { ...style.colors, ...preset.colors } })}>
                {preset.label}
              </s-button>
            ))}
            {palette ? (
              <s-button variant="primary" onClick={() => onChange({ colors: { ...style.colors, ...BRAND_LINKS } })}>
                Use brand colours
              </s-button>
            ) : (
              <s-link href="/app/settings">Set up brand colours</s-link>
            )}
          </s-stack>
        </s-stack>

        <Grid columns={3}>
          <Select
            label="Layout"
            value={style.layout}
            onChange={(layout) => onChange({ layout: layout as DealStyle["layout"] })}
            options={[
              { value: "vertical", label: "Vertical list" },
              { value: "horizontal", label: "Horizontal" },
              { value: "grid", label: "Grid (2 columns)" },
              { value: "plain", label: "Plain (no cards)" },
            ]}
          />
          <NumberField label="Corner radius" min={0} max={30} suffix="px" value={style.radius} onChange={(radius) => onChange({ radius })} />
          <NumberField label="Border width" min={0} max={6} suffix="px" value={style.borderWidth} onChange={(borderWidth) => onChange({ borderWidth })} />
          <NumberField label="Space between bars" min={0} max={32} suffix="px" value={style.barGap} onChange={(barGap) => onChange({ barGap })} />
          <NumberField label="Bar padding" min={4} max={32} suffix="px" value={style.barPadding} onChange={(barPadding) => onChange({ barPadding })} />
          <NumberField label="Bar image size" min={24} max={160} suffix="px" value={style.imageSize} onChange={(imageSize) => onChange({ imageSize })} />
        </Grid>

        <s-heading>Text</s-heading>
        <Grid columns={3}>
          <NumberField label="Title size" min={11} max={24} suffix="px" value={style.titleSize} onChange={(titleSize) => onChange({ titleSize })} />
          <Select label="Title weight" value={String(style.titleWeight)} onChange={(v) => onChange({ titleWeight: Number(v) })} options={WEIGHTS} />
          <NumberField label="Subtitle size" min={9} max={24} suffix="px" value={style.subtitleSize} onChange={(subtitleSize) => onChange({ subtitleSize })} />
          <NumberField label="Price size" min={10} max={32} suffix="px" value={style.priceSize} onChange={(priceSize) => onChange({ priceSize })} />
          <NumberField label="Block title size" min={9} max={28} suffix="px" value={style.blockTitleSize} onChange={(blockTitleSize) => onChange({ blockTitleSize })} />
          <Select label="Block title weight" value={String(style.blockTitleWeight)} onChange={(v) => onChange({ blockTitleWeight: Number(v) })} options={WEIGHTS} />
        </Grid>
        <Grid>
          <TextField label="Block title" value={style.blockTitle} onChange={(blockTitle) => onChange({ blockTitle })} />
          <s-stack gap="small-200">
            <Checkbox label="Show block title" checked={style.showBlockTitle} onChange={(showBlockTitle) => onChange({ showBlockTitle })} />
            <Checkbox label="Show price per item" checked={style.showUnitPrice} onChange={(showUnitPrice) => onChange({ showUnitPrice })} />
            <Checkbox
              label="Use product compare-at price as the full price"
              checked={style.useCompareAt}
              onChange={(useCompareAt) => onChange({ useCompareAt })}
            />
            <Checkbox
              label="Show the gift track"
              details="Every gift tier above the bars, unlocked as bigger bars are chosen."
              checked={style.giftTrack}
              onChange={(giftTrack) => onChange({ giftTrack })}
            />
          </s-stack>
        </Grid>

        <s-heading>Variant pickers</s-heading>
        <Grid columns={3}>
          <Select
            label="Show variants as"
            value={style.variants.display}
            onChange={(display) => onChange({ variants: { ...style.variants, display: display as DealStyle["variants"]["display"] } })}
            options={[
              { value: "dropdown", label: "Dropdowns" },
              { value: "swatch", label: "Swatches" },
            ]}
          />
          {style.variants.display === "swatch" ? (
            <>
              <Select
                label="Swatch"
                value={style.variants.source}
                onChange={(source) => onChange({ variants: { ...style.variants, source: source as DealStyle["variants"]["source"] } })}
                options={[
                  { value: "color", label: "Colour (from the product's option swatches)" },
                  { value: "image", label: "Uploaded swatch image" },
                  { value: "variant_image", label: "Variant image" },
                ]}
              />
              <Select
                label="Shape"
                value={style.variants.shape}
                onChange={(shape) => onChange({ variants: { ...style.variants, shape: shape as DealStyle["variants"]["shape"] } })}
                options={[
                  { value: "circle", label: "Circle" },
                  { value: "rounded", label: "Rounded" },
                  { value: "square", label: "Square" },
                ]}
              />
              <NumberField
                label="Swatch size"
                min={16}
                max={64}
                suffix="px"
                value={style.variants.size}
                onChange={(size) => onChange({ variants: { ...style.variants, size } })}
              />
            </>
          ) : null}
        </Grid>

        <s-heading>Colours</s-heading>
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

        <s-heading>Savings summary</s-heading>
        <Checkbox
          label="Show a savings summary under the bars"
          details="“You're saving $X on this order” — updates as shoppers change their choice; hidden when there's no saving."
          checked={sb.enabled}
          onChange={(enabled) => setSb({ enabled })}
        />
        {sb.enabled ? (
          <>
            <TextField
              label="Text"
              value={sb.text}
              details="Use {{saved_amount}} and {{saved_percentage}}."
              onChange={(text) => setSb({ text })}
            />
            <Grid columns={3}>
              <ColorSlot label="Background" value={sb.background} palette={palette} onChange={(background) => setSb({ background })} />
              <ColorSlot label="Text colour" value={sb.textColor} palette={palette} onChange={(textColor) => setSb({ textColor })} />
              <ColorSlot label="Savings colour" value={sb.valueColor} palette={palette} onChange={(valueColor) => setSb({ valueColor })} />
              <Select
                label="Alignment"
                value={sb.align}
                onChange={(align) => setSb({ align: align as DealStyle["savingsBar"]["align"] })}
                options={[
                  { value: "left", label: "Left" },
                  { value: "center", label: "Centre" },
                  { value: "right", label: "Right" },
                ]}
              />
              <NumberField label="Text size" min={10} max={24} suffix="px" value={sb.size} onChange={(size) => setSb({ size })} />
            </Grid>
            <s-stack direction="inline" gap="base">
              <Checkbox label="Count free gifts as savings" checked={sb.includeGifts} onChange={(includeGifts) => setSb({ includeGifts })} />
              <Checkbox label="Border" checked={sb.border} onChange={(border) => setSb({ border })} />
              <Checkbox label="Icon" checked={sb.icon} onChange={(icon) => setSb({ icon })} />
            </s-stack>
          </>
        ) : null}

        <s-heading>Custom code</s-heading>
        <TextArea
          label="HTML above the bars"
          value={style.htmlAbove}
          rows={3}
          details="Shown as written on your store. The preview leaves out scripts."
          onChange={(htmlAbove) => onChange({ htmlAbove })}
        />
        <TextArea label="HTML below the bars" value={style.htmlBelow} rows={3} onChange={(htmlBelow) => onChange({ htmlBelow })} />
        <TextArea
          label="CSS for this deal"
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
