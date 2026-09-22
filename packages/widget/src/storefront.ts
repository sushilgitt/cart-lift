import { formatMoney, matchesTarget, priceBar } from "../../core/src";
import { defaultUnits, initialBar, pickerRows, renderDeal, upsellEntries, upsellOn } from "./render";
import type { RenderState, SfArm, SfData, SfDeal, SfProduct, SfRecommended } from "./types";
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
  return deals.find(
    (d) =>
      isLive(d) &&
      d.bars?.length > 0 &&
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

interface CartLine {
  id: number;
  quantity: number;
  properties: Record<string, string>;
}

interface DawnDrawer extends HTMLElement {
  getSectionsToRender(): { id: string }[];
  renderContents(state: unknown): void;
}

function addLines(items: CartLine[]): Promise<void> {
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
        if (!r.ok) throw new Error(json.description || json.message || "Could not add to cart");
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

function mount(container: HTMLElement, deal: SfDeal, data: SfData, form: HTMLFormElement) {
  const rate = Number(shopify()?.currency?.rate) || 1;
  const ctx = { product: data.product, moneyFormat: data.moneyFormat, rate, options: data.options, mf: data.mf };
  const arm = pickArm(deal);
  const idInput = form.querySelector<HTMLInputElement>('[name="id"]');
  const firstBar = initialBar(arm.bars);
  const state: RenderState & { bars: SfArm["bars"] } = {
    barId: firstBar,
    variantId: idInput ? idInput.value : data.product.variants[0].id,
    unitVariants: defaultUnits(arm.bars.find((b) => b.id === firstBar), data.product),
    upsells: {},
    bars: arm.bars,
  };
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

  // `_cartlift_bar` tells checkout which of two bars with the same quantity was
  // picked. Only sent when needed: otherwise the same product added from two
  // bars would become two cart lines.
  const tiedQuantities = arm.bars.some((b, i) => arm.bars.some((o, j) => j !== i && o.qty === b.qty));

  const selectedBar = () => state.bars.find((b) => b.id === state.barId);

  function lines(): CartLine[] {
    const bar = selectedBar();
    if (!bar) return [];
    const props: Record<string, string> = { _cartlift: deal.id, _cartlift_arm: arm.key };
    if (tiedQuantities) props._cartlift_bar = bar.id;
    const items: CartLine[] = [];
    const counts: Record<string, number> = {};
    const rows = pickerRows(deal, bar, data.product);
    for (let i = 0; i < bar.qty; i++) {
      const id = String((rows && state.unitVariants[i]) || state.variantId);
      counts[id] = (counts[id] || 0) + 1;
    }
    Object.keys(counts).forEach((id) => {
      items.push({ id: Number(id), quantity: counts[id], properties: props });
    });
    if (bar.gift) items.push({ id: bar.gift.id, quantity: 1, properties: { _cartlift_gift: deal.id } });
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
      .filter((l) => l.properties._cartlift)
      .forEach((l) => {
        variantIdQuantities[l.id] = (variantIdQuantities[l.id] || 0) + l.quantity;
      });
    const variant = data.product.variants.find((v) => String(v.id) === String(state.variantId)) || data.product.variants[0];
    const compare = deal.style?.useCompareAt ? Number(variant.compare_at_price) || 0 : 0;
    const price = priceBar(bar, Number(variant.price) || 0, compare, rate).total;
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

  function sync() {
    const bar = selectedBar();
    if (!bar) return;
    let qtys = formControls(form, "quantity");
    if (!qtys.length) qtys = [hiddenInput(form, "quantity")];
    qtys.forEach((q) => {
      q.value = String(bar.qty);
    });
    hiddenInput(form, "properties[_cartlift]").value = deal.id;
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
      beacon(api, data.shop, [{ t: "atc", d: deal.id, a: arm.key }]);
      if (items.length <= 1) {
        sync();
        return; // Let the theme add to cart.
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return;
      busy = true;
      addLines(items).finally(() => {
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
  if (!seen) beacon(api, data.shop, [{ t: "view", d: deal.id, a: arm.key }]);
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
