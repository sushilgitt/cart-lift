import { matchesTarget } from "../../core/src";
import { initialBar, renderDeal } from "./render";
import type { RenderState, SfArm, SfData, SfDeal, SfProduct } from "./types";

/*
 * Storefront mount: renders the matching deal on the product page and drives
 * the theme's own product form.
 *  - Single-line adds (one variant, no gift/upsell): sets the form quantity and
 *    adds `_cartlift` / `_cartlift_arm` line properties, then lets the theme add
 *    to cart as usual so its cart drawer keeps working.
 *  - Multi-line adds (per-unit variants, gifts, upsells): intercepts the submit
 *    and posts every line to /cart/add.js together.
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

function mount(container: HTMLElement, deal: SfDeal, data: SfData, form: HTMLFormElement) {
  const rate = Number(shopify()?.currency?.rate) || 1;
  const ctx = { product: data.product, moneyFormat: data.moneyFormat, rate };
  const arm = pickArm(deal);
  const idInput = form.querySelector<HTMLInputElement>('[name="id"]');
  const state: RenderState & { bars: SfArm["bars"] } = {
    barId: initialBar(arm.bars),
    variantId: idInput ? idInput.value : data.product.variants[0].id,
    unitVariants: [],
    upsells: {},
    bars: arm.bars,
  };
  const api = data.config.api;

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
    for (let i = 0; i < bar.qty; i++) {
      const id = String((deal.variantPerUnit && state.unitVariants[i]) || state.variantId);
      counts[id] = (counts[id] || 0) + 1;
    }
    Object.keys(counts).forEach((id) => {
      items.push({ id: Number(id), quantity: counts[id], properties: props });
    });
    if (bar.gift) items.push({ id: bar.gift.id, quantity: 1, properties: { _cartlift_gift: deal.id } });
    (bar.upsells || []).forEach((up) => {
      const on = Object.prototype.hasOwnProperty.call(state.upsells, up.id) ? state.upsells[up.id] : up.checked;
      if (on) items.push({ id: up.variant, quantity: 1, properties: { _cartlift_upsell: deal.id + ":" + up.id } });
    });
    return items;
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
    // Buy-it-now only supports a single line.
    const multi = lines().length > 1;
    const dyn = form.querySelector(".shopify-payment-button");
    if (dyn) dyn.classList.toggle("cartlift-hidden", multi);
  }

  function draw() {
    container.innerHTML = renderDeal(deal, state, ctx);
    sync();
  }

  function choose(barId: string) {
    if (barId === state.barId) return;
    state.barId = barId;
    state.unitVariants = [];
    draw();
    container.dispatchEvent(new CustomEvent("cartlift:bar-selected", { bubbles: true, detail: { dealId: deal.id, barId } }));
  }

  container.addEventListener("click", (e) => {
    const target = e.target as Element;
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
    if (t.hasAttribute("data-unit")) state.unitVariants[Number(t.getAttribute("data-unit"))] = t.value;
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

export function init() {
  if (/[?&]cartlift=off\b/.test(window.location.search)) return;
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
    if (data.placement === "block") {
      slot = document.querySelector<HTMLElement>('.cartlift-slot[data-product-id="' + data.product.id + '"]');
      if (!slot) return;
      form = findForm(data.product, slot);
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
