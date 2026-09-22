import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getDeal, nextPriority, parseDealInput, shopIdFor } from "../lib/deal.server";
import { syncShop } from "../lib/sync.server";
import {
  BUILT_IN_VARIABLES,
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
    select: { moneyFormat: true, currencyCode: true },
  });
  const moneyFormat = (shop?.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, "");

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
  return {
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
      config: normalizeConfig(deal.config, deal.type as DealTypeKey),
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

  const patch = useCallback((changes: Partial<EditorDeal>) => setDeal((d) => ({ ...d, ...changes })), []);
  const patchConfig = useCallback(
    (changes: Partial<DealConfig>) => setDeal((d) => ({ ...d, config: { ...d.config, ...changes } })),
    [],
  );
  const patchStyle = useCallback(
    (changes: Partial<DealStyle>) =>
      setDeal((d) => ({ ...d, config: { ...d.config, style: { ...d.config.style, ...changes } } })),
    [],
  );
  const patchBar = useCallback(
    (id: string, changes: Partial<Bar>) =>
      setDeal((d) => ({
        ...d,
        config: {
          ...d.config,
          bars: d.config.bars.map((b) => {
            if (b.id === id) return { ...b, ...changes };
            // Only one bar can be the default.
            if (changes.selected) return { ...b, selected: false };
            return b;
          }),
        },
      })),
    [],
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

  const previewDeal = useMemo(() => storefrontDeal(deal) as any, [deal]);
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
  const bars = config.bars;

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
            value={config.discountName}
            onChange={(discountName) => patchConfig({ discountName })}
            placeholder="Leave empty to use each bar's title"
          />
        </s-stack>
      </s-section>

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
          <s-paragraph color="subdued">
            Text can use {[...BUILT_IN_VARIABLES, ...config.metafieldVars.map((m) => m.name).filter(Boolean)]
              .map((v) => `{{${v}}}`)
              .join(", ")}
            . Amounts are in {currency}.
          </s-paragraph>
          {bars.map((bar, index) => (
            <BarEditor
              key={bar.id}
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
            checked={config.progressiveGifts}
            onChange={(progressiveGifts) => patchConfig({ progressiveGifts })}
          />
          <Checkbox
            label="Let customers choose a variant for each item"
            details="Shows a size/colour picker per unit on the selected bar."
            checked={config.variantPerUnit}
            onChange={(variantPerUnit) => patchConfig({ variantPerUnit })}
          />
          <Checkbox
            label="Show the variant picker on single-item bars"
            details="Off: shoppers use your theme's variant picker for one item."
            checked={config.showVariantPicker}
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
      <StyleEditor style={config.style} onChange={patchStyle} />

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

function StyleEditor({ style, onChange }: { style: DealStyle; onChange: (changes: Partial<DealStyle>) => void }) {
  return (
    <s-section heading="Style">
      <s-stack gap="base">
        <Grid columns={3}>
          <Select
            label="Layout"
            value={style.layout}
            onChange={(layout) => onChange({ layout: layout as DealStyle["layout"] })}
            options={[
              { value: "vertical", label: "Vertical list" },
              { value: "horizontal", label: "Horizontal" },
              { value: "grid", label: "Grid (2 columns)" },
            ]}
          />
          <NumberField label="Corner radius" min={0} max={30} suffix="px" value={style.radius} onChange={(radius) => onChange({ radius })} />
          <NumberField label="Title size" min={11} max={24} suffix="px" value={style.titleSize} onChange={(titleSize) => onChange({ titleSize })} />
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
          <NumberField label="Bar image size" min={24} max={160} suffix="px" value={style.imageSize} onChange={(imageSize) => onChange({ imageSize })} />
        </Grid>
        <s-heading>Colours</s-heading>
        <Grid columns={3}>
          {COLOR_FIELDS.map(([key, label]) => (
            <ColorField
              key={key}
              label={label}
              value={style.colors[key]}
              onChange={(value) => onChange({ colors: { ...style.colors, [key]: value } })}
            />
          ))}
        </Grid>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
