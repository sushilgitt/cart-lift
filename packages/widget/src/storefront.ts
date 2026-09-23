import { escapeHtml as esc, formatMoney, matchesTarget, priceBar, priceMixed } from "../../core/src";
import {
  barGifts,
  bundlePrice,
  defaultUnits,
  initialBar,
  mixSlots,
  pickerRows,
  planUnit,
  plansFor,
  renderDeal,
  upsellEntries,
  upsellOn,
} from "./render";
import { type MixPick, type RenderState, type SfArm, type SfBar, type SfData, type SfDeal, type SfMixMatch, type SfProduct, type SfRecommended, type SfStrings } from "./types";
import { stringsFor, translateDeal } from "./i18n";
import { withOption } from "./variants";

/*
 * Storefront mount: renders the matching deal on the product page and drives
 * the theme's own product form.
 *  - Single-line adds (one variant, no gift/upsell): sets the form quantity and
 *    adds `_cartlift` / `_cartlift_arm` line properties, then lets the theme add
 *    to cart as usual so its cart drawer keeps working.
 *  - Multi-line adds (per-unit variants, gifts, upsells): intercepts the submit
 *    and posts every line to /cart/add.js together.
 *
 * Placement: the "CartLift deals" app block, else a `<cartlift-bundle
 * product-id="…">` element placed in the theme's product form, else above the
 * add-to-cart button (app embed).
 *
 * Events, dispatched on the widget and bubbling:
 *  - `cartlift:bar-selected`      { dealId, barId }
 *  - `cartlift:variant-selected`  { dealId, unit, variantId }
 *  - `cartlift:variants-changed`  { dealId, barId, variantIdQuantities, price, formattedPrice }
 */

interface ShopifyGlobal {
  currency?: { rate?: string | number };
  routes?: { root?: string };
}
const shopify = () => (window as unknown as { Shopify?: ShopifyGlobal }).Shopify;
const root = () => shopify()?.routes?.root || "/";

function swallow(fn: () => void) {
  try {
    fn();
  } catch {
    // Storage or beacon unavailable (private mode, blocked): not fatal.
  }
}

function isLive(deal: SfDeal): boolean {
  const now = Date.now();
  if (deal.s && Date.parse(deal.s) > now) return false;
  if (deal.e && Date.parse(deal.e) <= now) return false;
  return true;
}

function matchDeal(data: SfData): SfDeal | undefined {
  const deals = data.config?.deals || [];
  const pid = Number(data.product.id);
  const cols = (data.collections || []).map(Number);
  const country = data.country || "";
  return deals.find(
    (d) =>
      isLive(d) &&
      d.bars?.length > 0 &&
      (!d.ctry?.length || d.ctry.includes(country)) &&
      matchesTarget(d, pid, (c) => cols.includes(Number(c))) === true,
  );
}

/** A/B arm, sticky per visitor. Arms: [{key, weight, bars}] (Phase 3). */
function pickArm(deal: SfDeal): SfArm {
  const arms = deal.arms || [];
  if (!arms.length) return { key: "A", bars: deal.bars };
  const storeKey = "cartlift_arm_" + deal.id;
  let key: string | null = null;
  swallow(() => {
    key = localStorage.getItem(storeKey);
  });
  const all: SfArm[] = [{ key: "A", weight: deal.weightA == null ? 50 : deal.weightA, bars: deal.bars }, ...arms];
  let found = all.find((a) => a.key === key);
  if (!found) {
    const total = all.reduce((s, a) => s + Math.max(0, a.weight || 0), 0);
    let r = Math.random() * (total || 1);
    found = all[0];
    for (const arm of all) {
      r -= Math.max(0, arm.weight || 0);
      if (r < 0) {
        found = arm;
        break;
      }
    }
    const chosen = found.key;
    swallow(() => localStorage.setItem(storeKey, chosen));
  }
  return found;
}

function beacon(api: string, shop: string, events: Record<string, unknown>[]) {
  if (!api) return;
  const body = JSON.stringify({ shop, events });
  const url = api.replace(/\/$/, "") + "/api/events";
  let sent = false;
  swallow(() => {
    sent = Boolean(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" })));
  });
  if (sent) return;
  swallow(() => {
    fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
  });
}

const all = <E extends Element>(scope: ParentNode, selector: string) => Array.from(scope.querySelectorAll<E>(selector));

function findForm(product: SfProduct, near: Element | null): HTMLFormElement | undefined {
  const ids = (product.variants || []).map((v) => String(v.id));
  const scope: ParentNode = near?.closest(".shopify-section, section") || document;
  let candidates = all<HTMLFormElement>(scope, 'form[action*="/cart/add"]');
  if (scope !== document) candidates = candidates.concat(all<HTMLFormElement>(document, 'form[action*="/cart/add"]'));
  return candidates.find((form) => {
    if (form.closest("cart-drawer, .cart-drawer, [id*='quick'], [class*='quick-add'], aside")) return false;
    const input = form.querySelector<HTMLInputElement>('[name="id"]');
    return Boolean(input) && ids.indexOf(String(input!.value)) >= 0;
  });
}

function formControls(form: HTMLFormElement, name: string): HTMLInputElement[] {
  let list = all<HTMLInputElement>(form, '[name="' + name + '"]');
  if (form.id) list = list.concat(all<HTMLInputElement>(document, '[name="' + name + '"][form="' + form.id + '"]'));
  return list;
}

function hiddenInput(form: HTMLFormElement, name: string): HTMLInputElement {
  let input = form.querySelector<HTMLInputElement>('input[type="hidden"][name="' + name + '"]');
  if (!input) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    form.appendChild(input);
  }
  return input;
}

/**
 * The form's selling plan: set while subscribed, removed for a one-time
 * purchase. The widget owns an input of its own, so a plan the theme's own
 * picker left behind can never be posted alongside it.
 */
function setSellingPlan(form: HTMLFormElement, plan: number | null | undefined) {
  const own = form.querySelector<HTMLInputElement>('input[data-cartlift-plan]');
  if (plan == null) {
    own?.remove();
    return;
  }
  if (own) {
    own.value = String(plan);
    return;
  }
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "selling_plan";
  input.setAttribute("data-cartlift-plan", "");
  input.value = String(plan);
  form.appendChild(input);
}

interface CartLine {
  id: number;
  quantity: number;
  properties: Record<string, string>;
  /** Subscription lines: the selling plan the shopper picked. */
  selling_plan?: number;
}

interface DawnDrawer extends HTMLElement {
  getSectionsToRender(): { id: string }[];
  renderContents(state: unknown): void;
}

function addLines(items: CartLine[], addError: string): Promise<void> {
  const drawer = (document.querySelector("cart-drawer") || document.querySelector("cart-notification")) as DawnDrawer | null;
  const body: Record<string, unknown> = { items };
  const canRender =
    drawer && typeof drawer.getSectionsToRender === "function" && typeof drawer.renderContents === "function";
  if (canRender) {
    body.sections = drawer.getSectionsToRender().map((s) => s.id);
    body.sections_url = window.location.pathname;
  }
  return fetch(root() + "cart/add.js", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) =>
      r.json().then((json) => {
        if (!r.ok) throw new Error(json.description || json.message || addError);
        return json;
      }),
    )
    .then((json) => {
      document.dispatchEvent(new CustomEvent("cartlift:added", { detail: json }));
      if (canRender) {
        const first = (json.items && json.items[0]) || {};
        drawer.renderContents({ ...json, id: first.id, key: first.key });
        if (drawer.classList && drawer.classList.contains("is-empty")) drawer.classList.remove("is-empty");
      } else {
        window.location.href = root() + "cart";
      }
    })
    .catch((err: Error) => {
      window.alert(err.message);
    });
}

/** Complementary products for a product (Search & Discovery), fetched once per page. */
const recommended = new Map<string, Promise<SfRecommended[]>>();
function complementaryFor(productId: string | number): Promise<SfRecommended[]> {
  const key = String(productId);
  let request = recommended.get(key);
  if (!request) {
    request = fetch(root() + "recommendations/products.json?product_id=" + encodeURIComponent(key) + "&intent=complementary&limit=10")
      .then((r) => (r.ok ? r.json() : { products: [] }))
      .then((json) => (Array.isArray(json.products) ? json.products : []))
      .catch(() => []);
    recommended.set(key, request);
  }
  return request;
}

// ---------------------------------------------------------------------------
// Mix & match: the pool's products and the chooser
// ---------------------------------------------------------------------------

interface PoolProduct {
  id: number;
  title: string;
  image: string | null;
  variants: { id: number; title: string; price: number; available: boolean }[];
}

const absolute = (url: unknown) => {
  const u = typeof url === "string" ? url : "";
  return u.startsWith("//") ? "https:" + u : u || null;
};

const getJson = (url: string) =>
  fetch(url, { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

/** Up to 24 products of the pool, with presentment prices from /products/<handle>.js. */
const pools = new Map<string, Promise<PoolProduct[]>>();
function loadPool(mm: SfMixMatch): Promise<PoolProduct[]> {
  const key = JSON.stringify([mm.tt, mm.ph, mm.ch, mm.p]);
  let request = pools.get(key);
  if (request) return request;
  request = (async () => {
    let handles: string[] = [];
    if (mm.tt === "PRODUCTS") {
      handles = mm.ph || [];
    } else if (mm.tt === "COLLECTIONS") {
      for (const h of mm.ch || []) {
        const json = await getJson(root() + "collections/" + encodeURIComponent(h) + "/products.json?limit=50");
        for (const p of json?.products || []) if (p?.handle) handles.push(p.handle);
      }
    } else {
      const json = await getJson(root() + "products.json?limit=50");
      for (const p of json?.products || []) {
        if (!p?.handle) continue;
        if (mm.tt === "EXCEPT" && (mm.p || []).includes(Number(p.id))) continue;
        handles.push(p.handle);
      }
    }
    handles = [...new Set(handles)].slice(0, 24);
    const products = await Promise.all(handles.map((h) => getJson(root() + "products/" + encodeURIComponent(h) + ".js")));
    return products
      .filter((p) => p && Array.isArray(p.variants))
      .map((p) => ({
        id: Number(p.id),
        title: String(p.title || ""),
        image: absolute(p.featured_image),
        variants: p.variants.map((v: { id: number; title: string; price: number; available: boolean }) => ({
          id: Number(v.id),
          title: String(v.title || ""),
          price: Number(v.price) || 0,
          available: v.available !== false,
        })),
      }))
      .filter((p) => p.variants.some((v: { available: boolean }) => v.available));
  })();
  pools.set(key, request);
  return request;
}

/** The chooser dialog. Styled with the widget's colours (copied from `from`). */
function openChooser(
  mm: SfMixMatch,
  moneyFormat: string,
  words: SfStrings,
  from: HTMLElement,
  onPick: (pick: MixPick) => void,
) {
  const trigger = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "cl-modal-backdrop";
  backdrop.setAttribute("style", from.closest(".cl-block")?.getAttribute("style") || "");
  const photo = Math.min(160, Math.max(24, Number(mm.photo) || 64));
  backdrop.innerHTML =
    '<div class="cl-modal" role="dialog" aria-modal="true" aria-labelledby="cl-modal-title" style="--cl-slot-photo:' + photo + 'px">' +
    '<div class="cl-modal-head"><h2 id="cl-modal-title">' + esc(mm.title || words.choose) + "</h2>" +
    '<button type="button" class="cl-modal-close" aria-label="' + esc(words.close) + '">&times;</button></div>' +
    '<input class="cl-modal-search" type="search" placeholder="' + esc(words.search) + '" aria-label="' + esc(words.search) + '">' +
    '<div class="cl-modal-list" aria-busy="true"><p class="cl-modal-note">' + esc(words.loading) + "</p></div></div>";
  document.body.appendChild(backdrop);
  const list = backdrop.querySelector<HTMLElement>(".cl-modal-list")!;
  const search = backdrop.querySelector<HTMLInputElement>(".cl-modal-search")!;
  let products: PoolProduct[] = [];

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    trigger?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = products.filter((p) => !q || p.title.toLowerCase().includes(q));
    list.removeAttribute("aria-busy");
    list.innerHTML = shown.length
      ? shown
          .map((p) => {
            const variants = p.variants.filter((v) => v.available);
            const first = variants[0];
            return (
              '<div class="cl-pick" data-product="' + p.id + '">' +
              (p.image ? '<img class="cl-pick-img" src="' + esc(p.image) + '" alt="" loading="lazy">' : "") +
              (mm.names === false ? "" : '<span class="cl-pick-name">' + esc(p.title) + "</span>") +
              (variants.length > 1
                ? '<select class="cl-pick-variant" aria-label="' + esc(p.title) + '">' +
                  variants.map((v) => '<option value="' + v.id + '">' + esc(v.title) + " — " + esc(formatMoney(v.price, moneyFormat)) + "</option>").join("") +
                  "</select>"
                : '<span class="cl-pick-price">' + esc(formatMoney(first.price, moneyFormat)) + "</span>") +
              '<button type="button" class="cl-pick-add">' + esc(mm.button || words.choose) + "</button></div>"
            );
          })
          .join("")
      : '<p class="cl-modal-note">' + esc(words.noProducts) + "</p>";
  };

  backdrop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target === backdrop || target.closest(".cl-modal-close")) return close();
    const add = target.closest(".cl-pick-add");
    if (!add) return;
    const card = add.closest<HTMLElement>(".cl-pick")!;
    const product = products.find((p) => String(p.id) === card.dataset.product);
    if (!product) return;
    const select = card.querySelector<HTMLSelectElement>(".cl-pick-variant");
    const variant = product.variants.find((v) => String(v.id) === (select ? select.value : "")) || product.variants.find((v) => v.available)!;
    onPick({
      productId: product.id,
      variantId: variant.id,
      title: product.title + (variant.title && variant.title !== "Default Title" ? " — " + variant.title : ""),
      image: product.image,
      price: variant.price,
    });
    close();
  });
  search.addEventListener("input", draw);
  search.focus();
  loadPool(mm).then((loaded) => {
    products = loaded;
    draw();
  });
}

/** The deal as a visitor in `arm` sees it. */
function armDeal(deal: SfDeal, arm: SfArm): SfDeal {
  if (arm.key === "A") return deal;
  return {
    ...deal,
    bars: arm.bars,
    style: arm.style ?? deal.style,
    variantPerUnit: arm.variantPerUnit ?? deal.variantPerUnit,
    showVariantPicker: arm.showVariantPicker ?? deal.showVariantPicker,
  };
}

function mount(container: HTMLElement, base: SfDeal, data: SfData, form: HTMLFormElement) {
  const rate = Number(shopify()?.currency?.rate) || 1;
  // This page's language: the widget's own words, and the deal's texts.
  const words = stringsFor(data.i18n);
  const ctx = {
    product: data.product,
    moneyFormat: data.moneyFormat,
    rate,
    options: data.options,
    mf: data.mf,
    strings: words,
    plans: data.sp,
    alloc: data.spa,
  };
  const translated = translateDeal(base, data.i18n);
  const arm = pickArm(translated);
  const deal = armDeal(translated, arm);
  const idInput = form.querySelector<HTMLInputElement>('[name="id"]');
  const firstBar = initialBar(arm.bars);
  const state: RenderState & { bars: SfArm["bars"] } = {
    barId: firstBar,
    variantId: idInput ? idInput.value : data.product.variants[0].id,
    unitVariants: defaultUnits(arm.bars.find((b) => b.id === firstBar), data.product),
    upsells: {},
    bars: arm.bars,
    mix: {},
    // A deal only for subscriptions, or one that asks for it, starts subscribed.
    plan: null,
  };
  if (deal.sub?.on) {
    const first = plansFor(deal, state.variantId ?? "", ctx)[0];
    if (first && (deal.sub.pre === "sub" || deal.sub.apply === "s")) state.plan = first.p;
  }
  const api = data.config.api;
  const emit = (name: string, detail: Record<string, unknown>) =>
    container.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { dealId: deal.id, ...detail } }));

  // The widget owns the quantity; hide the theme's selector.
  formControls(form, "quantity").forEach((q) => {
    const wrap = q.closest(
      ".product-form__quantity, .product__quantity, quantity-input, .quantity-selector, .quantity, [class*='quantity-wrapper']",
    );
    (wrap || q).classList.add("cartlift-hidden");
  });

  // The widget owns the selling plan while its picker is shown: the theme's
  // own control is hidden and disabled, so only the widget's plan is posted.
  if (deal.sub?.on) {
    formControls(form, "selling_plan").forEach((control) => {
      control.disabled = true;
      const wrap = control.closest("[class*='selling-plan'], [class*='subscription'], [class*='purchase-option'], fieldset");
      (wrap || control).classList.add("cartlift-hidden");
    });
  }

  // `_cartlift_bar` tells checkout which of two bars with the same quantity was
  // picked. Only sent when needed: otherwise the same product added from two
  // bars would become two cart lines.
  const tiedQuantities = arm.bars.some((b, i) => arm.bars.some((o, j) => j !== i && o.qty === b.qty));

  const selectedBar = () => state.bars.find((b) => b.id === state.barId);

  /** The chosen selling plan, for a variant that can actually be bought on it. */
  function planFor(variantId: string): { selling_plan?: number } {
    if (state.plan == null) return {};
    const allocations = data.spa?.[String(variantId)] ?? [];
    return allocations.some((a) => a.p === state.plan) ? { selling_plan: state.plan } : {};
  }

  function lines(): CartLine[] {
    const bar = selectedBar();
    if (!bar) return [];
    const props: Record<string, string> = { _cartlift: deal.id, _cartlift_arm: arm.key };
    if (tiedQuantities) props._cartlift_bar = bar.id;
    const items: CartLine[] = [];
    const counts: Record<string, number> = {};
    const rows = pickerRows(deal, bar, data.product);
    const viewed = String((rows && state.unitVariants[0]) || state.variantId);
    if (bar.kind === "bundle") {
      // Every item of the set, tagged for the bundle; the viewed product marked as the main one.
      const tag = deal.id + ":" + bar.id;
      for (const it of bar.items || []) {
        const id = it.v == null ? Number(viewed) : it.v;
        const own: Record<string, string> = { _cartlift_bundle: tag, _cartlift_arm: arm.key };
        if (it.v == null) own._cartlift_main = "1";
        const same = items.find((l) => l.id === id && JSON.stringify(l.properties) === JSON.stringify(own));
        if (same) same.quantity += it.q;
        else items.push({ id, quantity: it.q, properties: own, ...planFor(String(id)) });
      }
    } else {
      const slots = mixSlots(deal, bar);
      for (let i = 0; i < bar.qty; i++) {
        // Mix & match: the picked product per slot; empty slots take the viewed product.
        const pick = slots && i > 0 ? state.mix?.[i] : undefined;
        const id = pick ? String(pick.variantId) : slots ? viewed : String((rows && state.unitVariants[i]) || state.variantId);
        counts[id] = (counts[id] || 0) + 1;
      }
      Object.keys(counts).forEach((id) => {
        items.push({ id: Number(id), quantity: counts[id], properties: props, ...planFor(id) });
      });
    }
    barGifts(bar).forEach((gift) => items.push({ id: gift.id, quantity: 1, properties: { _cartlift_gift: deal.id } }));
    upsellEntries(bar, state, ctx).forEach((up) => {
      if (up.onlyWhenSelected && state.barId !== bar.id) return;
      if (upsellOn(up, state))
        items.push({ id: up.variant, quantity: 1, properties: { _cartlift_upsell: deal.id + ":" + up.upsellId } });
    });
    return items;
  }

  let lastSignature = "";
  function announce(items: CartLine[]) {
    const bar = selectedBar();
    if (!bar) return;
    const variantIdQuantities: Record<string, number> = {};
    items
      .filter((l) => l.properties._cartlift || l.properties._cartlift_bundle)
      .forEach((l) => {
        variantIdQuantities[l.id] = (variantIdQuantities[l.id] || 0) + l.quantity;
      });
    const price = barTotal(bar);
    const signature = JSON.stringify([bar.id, variantIdQuantities, price]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    emit("cartlift:variants-changed", {
      barId: bar.id,
      variantIdQuantities,
      price,
      formattedPrice: formatMoney(price, data.moneyFormat),
    });
  }

  /** What the selected bar costs, as the widget shows it (cents). */
  function barTotal(bar: SfBar): number {
    const variant = data.product.variants.find((v) => String(v.id) === String(state.variantId)) || data.product.variants[0];
    const plans = plansFor(deal, variant.id, ctx);
    const plan = state.plan ?? (deal.sub?.apply === "s" ? plans[0]?.p : null);
    const priced = planUnit(variant, plans.length ? plan : null, plans);
    const unit = priced.unit;
    if (bar.kind === "bundle") return bundlePrice(bar, unit, rate).total;
    const slots = mixSlots(deal, bar);
    const picks = slots ? Array.from({ length: slots - 1 }, (_, i) => state.mix?.[i + 1]) : [];
    if (picks.length && picks.every(Boolean)) return priceMixed(bar, [unit, ...picks.map((p) => p!.price)], rate).total;
    const compare = deal.style?.useCompareAt ? Number(priced.compare) || 0 : 0;
    return priceBar(bar, unit, compare, rate).total;
  }

  function sync() {
    const bar = selectedBar();
    if (!bar) return;
    let qtys = formControls(form, "quantity");
    if (!qtys.length) qtys = [hiddenInput(form, "quantity")];
    const quantity = bar.kind === "bundle" ? (bar.items || []).find((it) => it.v == null)?.q || 1 : bar.qty;
    qtys.forEach((q) => {
      q.value = String(quantity);
    });
    hiddenInput(form, "properties[_cartlift]").value = deal.id;
    if (deal.sub?.on) setSellingPlan(form, state.plan);
    hiddenInput(form, "properties[_cartlift_arm]").value = arm.key;
    if (tiedQuantities) hiddenInput(form, "properties[_cartlift_bar]").value = bar.id;
    const items = lines();
    // One line goes through the theme's form: make it add the variant the widget
    // shows (picked per unit or on a single bar), not only the theme's own pick.
    const main = items.filter((l) => l.properties._cartlift);
    if (items.length === 1 && main.length === 1 && idInput && String(idInput.value) !== String(main[0].id)) {
      idInput.value = String(main[0].id);
      state.variantId = idInput.value;
    }
    // Buy-it-now only supports a single line.
    const multi = items.length > 1;
    const dyn = form.querySelector(".shopify-payment-button");
    if (dyn) dyn.classList.toggle("cartlift-hidden", multi);
    announce(items);
  }

  function draw() {
    container.innerHTML = renderDeal(deal, state, ctx);
    sync();
  }

  function choose(barId: string) {
    if (barId === state.barId) return;
    state.barId = barId;
    state.unitVariants = defaultUnits(state.bars.find((b) => b.id === barId), data.product);
    draw();
    emit("cartlift:bar-selected", { barId });
  }

  /** One-time or a selling plan; the whole deal is priced from it. */
  function pickPlan(plan: number | null) {
    if (plan === state.plan) return;
    state.plan = plan;
    draw();
    emit("cartlift:plan-selected", { sellingPlan: plan });
  }

  /** Sets option `opt` of unit `unit` to `value`. */
  function pickOption(unit: number, opt: number, value: string) {
    const variants = data.product.variants;
    const currentId = state.unitVariants[unit] || state.variantId;
    const current = variants.find((v) => String(v.id) === String(currentId)) || variants[0];
    const next = withOption(data.product, current, opt, value);
    state.unitVariants[unit] = next.id;
    draw();
    emit("cartlift:variant-selected", { unit, variantId: next.id });
  }

  container.addEventListener("click", (e) => {
    const target = e.target as Element;
    const swatch = target.closest<HTMLElement>(".cl-swatch");
    if (swatch) {
      e.preventDefault();
      pickOption(Number(swatch.dataset.unit), Number(swatch.dataset.opt), swatch.dataset.val || "");
      return;
    }
    const slot = target.closest<HTMLElement>("[data-slot]");
    if (slot && deal.mm) {
      e.preventDefault();
      const index = Number(slot.dataset.slot);
      openChooser(deal.mm, data.moneyFormat, words, container.querySelector(".cl-block") || container, (pick) => {
        state.mix = { ...state.mix, [index]: pick };
        draw();
        emit("cartlift:variant-selected", { unit: index, variantId: pick.variantId });
      });
      return;
    }
    const plan = target.closest<HTMLElement>("[data-plan]");
    if (plan && !target.closest("select")) {
      e.preventDefault();
      pickPlan(plan.dataset.plan ? Number(plan.dataset.plan) : null);
      return;
    }
    if (target.closest("select, input, label.cl-upsell")) return;
    const bar = target.closest("[data-bar]");
    if (bar) choose(bar.getAttribute("data-bar")!);
  });
  container.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const bar = target.closest && target.closest("[data-bar]");
    if (bar && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      choose(bar.getAttribute("data-bar")!);
    }
  });
  container.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.hasAttribute("data-opt")) {
      pickOption(Number(t.getAttribute("data-unit")), Number(t.getAttribute("data-opt")), t.value);
      return;
    }
    if (t.hasAttribute("data-plan-select")) {
      pickPlan(Number(t.value));
      return;
    }
    if (t.hasAttribute("data-upsell")) state.upsells[t.getAttribute("data-upsell")!] = t.checked;
    sync();
  });

  // Follow the theme's variant picker.
  setInterval(() => {
    if (idInput && String(idInput.value) !== String(state.variantId)) {
      state.variantId = idInput.value;
      state.unitVariants = [];
      draw();
    }
  }, 300);

  // Complementary upsells: load the products, then redraw.
  if (arm.bars.some((b) => (b.upsells || []).some((u) => u.source === "complementary"))) {
    complementaryFor(data.product.id).then((products) => {
      state.complementary = products;
      draw();
    });
  }

  let busy = false;
  form.addEventListener(
    "submit",
    (e) => {
      const items = lines();
      beacon(api, data.shop, [{ t: "atc", d: deal.id, a: arm.key, b: state.barId, p: data.product.id }]);
      if (items.length <= 1) {
        sync();
        return; // Let the theme add to cart.
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return;
      busy = true;
      addLines(items, words.addError).finally(() => {
        busy = false;
      });
    },
    true,
  );

  draw();

  const seenKey = "cartlift_seen_" + deal.id;
  let seen: string | null = null;
  swallow(() => {
    seen = sessionStorage.getItem(seenKey);
    sessionStorage.setItem(seenKey, "1");
  });
  if (!seen) beacon(api, data.shop, [{ t: "view", d: deal.id, a: arm.key, p: data.product.id }]);
  // Deals this visitor saw (and their arm): the pixel reports them with the
  // order, so orders without deal lines still count for visitor conversion.
  swallow(() => {
    const all = JSON.parse(localStorage.getItem("cartlift_seen") || "{}");
    if (all[deal.id] !== arm.key) {
      all[deal.id] = arm.key;
      const keys = Object.keys(all);
      if (keys.length > 20) delete all[keys[0]];
      localStorage.setItem("cartlift_seen", JSON.stringify(all));
    }
  });
}

/** `<cartlift-bundle product-id="…">`: a placement slot for custom themes. */
function defineElement() {
  if (typeof customElements === "undefined" || customElements.get("cartlift-bundle")) return;
  customElements.define("cartlift-bundle", class extends HTMLElement {});
}

export function init() {
  if (/[?&]cartlift=off\b/.test(window.location.search)) return;
  defineElement();
  const parsed: SfData[] = [];
  all<HTMLScriptElement>(document, "script[data-cartlift-data]").forEach((node) => {
    try {
      parsed.push(JSON.parse(node.textContent || ""));
    } catch {
      // Malformed block: skip it.
    }
  });
  // App blocks win over the embed's auto placement.
  parsed.sort((a, b) => (a.placement === "block" ? 0 : 1) - (b.placement === "block" ? 0 : 1));
  const done: Record<string, boolean> = {};
  parsed.forEach((data) => {
    if (!data.product || !data.config || done[data.product.id]) return;
    const deal = matchDeal(data);
    if (!deal) return;

    let slot: HTMLElement | null = null;
    let form: HTMLFormElement | undefined;
    const element = document.querySelector<HTMLElement>('cartlift-bundle[product-id="' + data.product.id + '"]');
    if (data.placement === "block") {
      slot = document.querySelector<HTMLElement>('.cartlift-slot[data-product-id="' + data.product.id + '"]');
      if (!slot) return;
      form = findForm(data.product, slot);
    } else if (element) {
      // Placed by the merchant inside the product form.
      slot = element;
      form = (element.closest('form[action*="/cart/add"]') as HTMLFormElement | null) || findForm(data.product, element);
    } else {
      form = findForm(data.product, null);
      if (form) {
        slot = document.createElement("div");
        slot.className = "cartlift-slot";
        const btn = form.querySelector('[type="submit"], button[name="add"]');
        const anchor = btn && (btn.closest(".product-form__buttons, .product-form__submit, .product-form__actions") || btn);
        if (anchor && anchor.parentNode && form.contains(anchor)) anchor.parentNode.insertBefore(slot, anchor);
        else form.insertBefore(slot, form.firstChild);
      }
    }
    if (!slot || !form) return;
    done[data.product.id] = true;
    if (data.config.css && !document.getElementById("cartlift-custom-css")) {
      const style = document.createElement("style");
      style.id = "cartlift-custom-css";
      style.textContent = data.config.css;
      document.head.appendChild(style);
    }
    try {
      mount(slot, deal, data, form);
    } catch (err) {
      console.error("[CartLift]", err);
    }
  });
}
