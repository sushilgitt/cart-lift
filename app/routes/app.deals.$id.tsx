import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getDeal, nextPriority, parseDealInput, shopIdFor } from "../lib/deal.server";
import { syncShop } from "../lib/sync.server";
import {
  DISCOUNT_LABELS,
  TEMPLATE_INFO,
  newBar,
  newUpsell,
  normalizeConfig,
  storefrontDeal,
  type Bar,
  type DealConfig,
  type DealStyle,
  type DealTypeKey,
  type DiscountType,
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
    const requested = url.searchParams.get("type") as DealTypeKey;
    const type = TYPES.includes(requested) ? requested : "QUANTITY_BREAK";
    return {
      isNew: true,
      moneyFormat,
      currency: shop?.currencyCode ?? "USD",
      deal: {
        id: "new",
        name: TEMPLATE_INFO[type].title,
        type,
        status: "ACTIVE" as "ACTIVE" | "DRAFT" | "PAUSED",
        targetType: "ALL" as TargetTypeKey,
        products: [] as ResourceRef[],
        collections: [] as ResourceRef[],
        startsAt: null as string | null,
        endsAt: null as string | null,
        config: normalizeConfig(null, type),
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
      products: selected.map((p: any) => ({ id: p.id, title: p.title, image: pickedImage(p) })),
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
    patch({ collections: selected.map((c: any) => ({ id: c.id, title: c.title, image: pickedImage(c) })) });
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
  }, [deal.products, previewPrice, moneyFormat]);

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
            Text can use {"{{quantity}}"}, {"{{price}}"}, {"{{unit_price}}"}, {"{{full_price}}"}, {"{{saved_amount}}"},{" "}
            {"{{saved_percentage}}"} and {"{{product}}"}. Amounts are in {currency}.
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
          </s-button-group>
          <Checkbox
            label="Let customers choose a variant for each item"
            details="Shows a size/colour picker per unit on the selected bar."
            checked={config.variantPerUnit}
            onChange={(variantPerUnit) => patchConfig({ variantPerUnit })}
          />
        </s-stack>
      </s-section>

      {/* ---------------- Style ---------------- */}
      <StyleEditor style={config.style} onChange={patchStyle} />

      {/* ---------------- Preview ---------------- */}
      <s-section slot="aside" heading="Live preview">
        <s-stack gap="base">
          <DealPreview deal={previewDeal} ctx={previewCtx} />
          <NumberField label="Preview unit price" value={previewPrice} min={0} step={0.01} onChange={setPreviewPrice} suffix={currency} />
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
}: {
  bar: Bar;
  index: number;
  count: number;
  allowBxgy: boolean;
  onChange: (changes: Partial<Bar>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  pickVariant: () => Promise<VariantRef | null>;
}) {
  const bxgy = bar.kind === "bxgy";
  return (
    <s-box padding="base" border="base" borderRadius="base" background={bar.selected ? "subdued" : undefined}>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>Bar {index + 1}</s-heading>
            <s-badge tone={bxgy ? "info" : "neutral"}>{bxgy ? "Buy X get Y" : "Quantity break"}</s-badge>
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

        <Grid columns={3}>
          {allowBxgy || bxgy ? (
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
          {bxgy ? (
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
          {bar.discountType !== "none" ? (
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
        </Grid>

        <Grid>
          <TextField label="Title" value={bar.title} onChange={(title) => onChange({ title })} />
          <TextField label="Subtitle" value={bar.subtitle} onChange={(subtitle) => onChange({ subtitle })} />
          <TextField label="Label" value={bar.label} onChange={(label) => onChange({ label })} placeholder="e.g. SAVE 20%" />
          <TextField label="Badge" value={bar.badge} onChange={(badge) => onChange({ badge })} placeholder="e.g. Most popular" />
        </Grid>
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

        {/* Free gift */}
        <s-stack gap="small-200">
          <s-text type="strong">Free gift</s-text>
          {bar.gift ? (
            <>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-thumbnail src={bar.gift.image ?? undefined} alt={bar.gift.title} size="small" />
                <s-text>{bar.gift.title}</s-text>
                <s-button variant="tertiary" icon="x" accessibilityLabel="Remove gift" onClick={() => onChange({ gift: null })} />
              </s-stack>
              <TextField label="Gift text" value={bar.giftText} onChange={(giftText) => onChange({ giftText })} />
            </>
          ) : (
            <div>
              <s-button
                icon="gift-card"
                onClick={async () => {
                  const gift = await pickVariant();
                  if (gift) onChange({ gift });
                }}
              >
                Add free gift
              </s-button>
            </div>
          )}
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
          <div>
            <s-button
              icon="plus"
              onClick={async () => {
                const variant = await pickVariant();
                if (variant) onChange({ upsells: [...bar.upsells, newUpsell({ variant })] });
              }}
            >
              Add upsell
            </s-button>
          </div>
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
  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-thumbnail src={upsell.variant?.image ?? undefined} alt={upsell.variant?.title ?? ""} size="small" />
            <s-text>{upsell.variant?.title ?? "No product"}</s-text>
          </s-stack>
          <s-button-group>
            <s-button
              variant="tertiary"
              onClick={async () => {
                const variant = await pickVariant();
                if (variant) onChange({ variant });
              }}
            >
              Change
            </s-button>
            <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel="Remove upsell" onClick={onRemove} />
          </s-button-group>
        </s-stack>
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
          </s-stack>
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
