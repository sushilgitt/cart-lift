/*
 * CartLift cart watcher — built to extensions/cartlift-widget/assets/cartlift-cart.js
 * by scripts/build-widget.mjs. Edit this source, not the built asset.
 *
 * Keeps the cart tidy and free gifts in step with it. The product widget adds
 * a gift when the shopper picks a gift bar, but a cart can reach (or leave) a
 * gift tier in other ways: adding the product twice, changing quantities in the
 * cart, quick-add from a collection page. This script runs on every page (app
 * embed), watches the theme's Ajax cart calls and after each change:
 *  - merges a plain line into the CartLift line of the same variant, like Kaching,
 *  - adds a missing gift once its bar is reached,
 *  - removes a gift whose bar is no longer reached (it would be charged at
 *    full price otherwise),
 *  - keeps each gift at quantity 1, since only one unit is free.
 *
 * The rules live in packages/core (planGifts, mergePlan) and mirror the
 * Discount Function. When unsure — a line whose collections are unknown here —
 * nothing changes. A gift the shopper removes while still eligible stays
 * removed until the tier is lost and reached again.
 */
import { mergePlan, planGifts, type AjaxCart, type Collections, type GiftConfig } from "../../core/src";

// Theme globals (Dawn and its descendants); may not exist.
declare const PUB_SUB_EVENTS: { cartUpdate?: string } | undefined;
declare function publish(event: string, data: unknown): void;

interface WatcherGlobal {
  loaded?: boolean;
  plan?: typeof planGifts;
  mergePlan?: typeof mergePlan;
}

interface CartData {
  config: GiftConfig & { g?: boolean };
  country?: string;
  cols?: Record<string, number[]>;
  count?: number;
  root?: string;
  template?: string;
}

const w = window as unknown as { CartLiftCart?: WatcherGlobal; Shopify?: { routes?: { root?: string } } };

// The planning functions are exposed for tests even where the runtime stays off.
if (!w.CartLiftCart?.loaded) {
  const API: WatcherGlobal = (w.CartLiftCart = w.CartLiftCart || {});
  API.loaded = true;
  API.plan = planGifts;
  API.mergePlan = mergePlan;
  start();
}

function start() {
  const blobs: CartData[] = [];
  Array.from(document.querySelectorAll("script[data-cartlift-cart]")).forEach((node) => {
    try {
      blobs.push(JSON.parse(node.textContent || ""));
    } catch {
      // Malformed block: ignore it.
    }
  });
  const data = blobs[0];
  if (!data || !data.config || !Array.isArray(data.config.deals) || !data.config.deals.length) return;
  if (/[?&]cartlift=off\b/.test(window.location.search)) return;
  if (typeof window.fetch !== "function" || typeof Promise === "undefined") return;

  // Deals limited to markets only apply in their countries.
  const country = data.country || "";
  const config = {
    ...data.config,
    deals: data.config.deals.filter((d) => !d.ctry?.length || d.ctry.includes(country)),
  };
  if (!config.deals.length) return;
  let root = w.Shopify?.routes?.root || data.root || "/";
  if (root.charAt(root.length - 1) !== "/") root += "/";
  const nativeFetch = window.fetch.bind(window);

  let session: Storage | null = null;
  try {
    session = window.sessionStorage;
  } catch {
    session = null;
  }
  function readJson<T extends object>(key: string, fallback: T): T {
    try {
      const v = session && JSON.parse(session.getItem(key) || "null");
      return v && typeof v === "object" ? v : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(key: string, value: unknown) {
    try {
      if (session) session.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: work without it.
    }
  }

  // Collection membership: rendered by Liquid for the cart's products and the
  // current product, remembered for the session so Ajax-added products seen
  // on an earlier page are known too.
  const COLS = "cartlift_cols";
  const cols: Collections = readJson(COLS, {});
  const learn = (pid: string, list: unknown) => {
    if (!pid || pid === "_" || !Array.isArray(list)) return;
    cols[Number(pid)] = list.map(Number);
  };
  blobs.forEach((b) => Object.keys(b.cols || {}).forEach((pid) => learn(pid, b.cols![pid])));
  Array.from(document.querySelectorAll("script[data-cartlift-data]")).forEach((node) => {
    try {
      const d = JSON.parse(node.textContent || "");
      if (d.product) learn(String(d.product.id), d.collections || []);
    } catch {
      // Malformed block: ignore it.
    }
  });
  writeJson(COLS, cols);

  // Gifts in the cart after the last pass, gifts the shopper removed, and gifts
  // that failed to add (sold out, unpublished) — so nothing loops.
  const LAST = "cartlift_gifts_last";
  const DISMISSED = "cartlift_gifts_dismissed";
  const FAILED = "cartlift_gifts_failed";

  type Flags = Record<string, boolean>;
  type CartState = { token?: string | null; keys?: Flags };

  function post<T = unknown>(path: string, body: unknown): Promise<T> {
    return nativeFetch(root + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then((r) =>
      r.json().then((json) => {
        if (!r.ok) throw new Error(json.description || json.message || "Cart request failed");
        return json as T;
      }),
    );
  }

  const readCart = (): Promise<AjaxCart> =>
    nativeFetch(root + "cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } }).then((r) => {
      if (!r.ok) throw new Error("cart.js " + r.status);
      return r.json();
    });

  /** Merges duplicate lines first; resolves with the cart to plan gifts on. */
  function merge(cart: AjaxCart): Promise<{ cart: AjaxCart; changed: boolean }> {
    const updates = mergePlan(cart);
    if (!Object.keys(updates).length) return Promise.resolve({ cart, changed: false });
    // update.js answers with the whole cart.
    return post<AjaxCart>("cart/update.js", { updates }).then((next) => ({ cart: next, changed: true }));
  }

  function reconcile(cart: AjaxCart): Promise<boolean> {
    // Both are about this cart only: a new cart (e.g. after checkout) starts clean.
    const sameCart = (state: CartState): Flags => (state.token && state.token === cart.token ? state.keys || {} : {});
    const last = sameCart(readJson<CartState>(LAST, {}));
    const dismissed = sameCart(readJson<CartState>(DISMISSED, {}));
    const failed = readJson<Flags>(FAILED, {});

    const skip: Flags = { ...dismissed, ...failed };

    // A gift that was in the cart last time, is still earned, and is gone now
    // was removed by the shopper: don't force it back.
    const probe = planGifts(config, cart, cols, skip);
    if (!probe) return Promise.resolve(false);
    const inCart = new Set(probe.present);
    Object.keys(last).forEach((k) => {
      if (probe.want[k] && !inCart.has(k)) {
        dismissed[k] = true;
        skip[k] = true;
      }
    });
    // Losing the tier resets the choice, so reaching it again brings the gift back.
    Object.keys(dismissed).forEach((k) => {
      if (!probe.want[k]) delete dismissed[k];
    });
    writeJson(DISMISSED, { token: cart.token || null, keys: dismissed });

    const p = planGifts(config, cart, cols, skip)!;
    let changed = false;
    const kept: Flags = {};
    p.present.forEach((k) => {
      kept[k] = true;
    });

    let chain = Promise.resolve();
    if (Object.keys(p.updates).length) {
      chain = chain.then(() =>
        post("cart/update.js", { updates: p.updates }).then(() => {
          changed = true;
        }),
      );
    }
    // One request per gift, so one unavailable gift can't block another.
    p.adds.forEach((add) => {
      chain = chain.then(() =>
        post("cart/add.js", { items: [{ id: add.id, quantity: add.quantity, properties: add.properties }] }).then(
          () => {
            changed = true;
            kept[add.key] = true;
            document.dispatchEvent(
              new CustomEvent("cartlift:gift-added", { detail: { dealId: add.properties._cartlift_gift, variantId: add.id } }),
            );
          },
          (err: Error) => {
            failed[add.key] = true;
            writeJson(FAILED, failed);
            console.warn("[CartLift] Free gift could not be added:", err && err.message);
          },
        ),
      );
    });

    return chain.then(() => {
      writeJson(LAST, { token: cart.token || null, keys: kept });
      return changed;
    });
  }

  // Theme refresh after we change the cart ------------------------------------

  /**
   * Dawn's pub/sub. `PUB_SUB_EVENTS` is a top-level `const` in Dawn, so it
   * isn't on window: it's read by bare name (the bundle is a classic script).
   */
  function dawnPubSub(): ((cart: AjaxCart) => void) | null {
    try {
      if (typeof publish === "function" && typeof PUB_SUB_EVENTS !== "undefined" && PUB_SUB_EVENTS?.cartUpdate) {
        const topic = PUB_SUB_EVENTS.cartUpdate;
        return (cart) => publish(topic, { source: "cartlift", cartData: cart });
      }
    } catch {
      // Not a Dawn-style theme.
    }
    return null;
  }

  function refreshBubble() {
    const bubble = document.getElementById("cart-icon-bubble");
    if (!bubble || typeof DOMParser === "undefined") return;
    nativeFetch(root + "?sections=cart-icon-bubble", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((sections) => {
        const html = sections && sections["cart-icon-bubble"];
        if (!html) return;
        const inner = new DOMParser().parseFromString(html, "text/html").querySelector(".shopify-section");
        if (inner) bubble.innerHTML = inner.innerHTML;
      })
      .catch(() => {});
  }

  function refreshTheme(cart: AjaxCart) {
    document.dispatchEvent(new CustomEvent("cartlift:cart-updated", { detail: cart }));

    // A theme or cart-drawer app can take over the refresh in one line:
    //   window.CartLift = { ...window.CartLift, onCartUpdated: cart => myDrawer.reload() }
    const hook = (window as unknown as { CartLift?: { onCartUpdated?: (cart: AjaxCart) => void } }).CartLift?.onCartUpdated;
    if (typeof hook === "function") {
      try {
        hook(cart);
        refreshBubble();
        return;
      } catch {
        // The hook failed; fall through to the usual refresh.
      }
    }

    // The cart page shows lines and totals; reload it so both are right.
    if (/^cart/.test(data.template || "") || /\/cart\/?$/.test(window.location.pathname)) {
      const now = Date.now();
      const lastReload = Number(readJson<{ t?: number }>("cartlift_reload", { t: 0 }).t) || 0;
      if (now - lastReload > 5000) {
        writeJson("cartlift_reload", { t: now });
        window.location.reload();
        return;
      }
    }

    // Dawn and its descendants re-render the cart drawer on this event.
    const dawn = dawnPubSub();
    if (dawn) {
      try {
        dawn(cart);
      } catch {
        // A theme handler failed; the cart itself is already right.
      }
      refreshBubble();
      return;
    }
    // Events other popular themes and cart-drawer apps listen to for a
    // re-render. They are all "please re-read the cart", so sending several is
    // safe: a drawer that doesn't know one ignores it.
    ["cart:refresh", "cart:build", "theme:cart:reload", "cart:updated", "cart-drawer:refresh"].forEach((name) => {
      document.documentElement.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { cart } }));
    });
    refreshBubble();
  }

  // Scheduling -----------------------------------------------------------------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;

  function schedule(delay?: number) {
    clearTimeout(timer);
    timer = setTimeout(run, delay == null ? 400 : delay);
  }

  function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    readCart()
      .then((cart) => merge(cart).then((merged) => reconcile(merged.cart).then((changed) => changed || merged.changed)))
      .then((changed) => {
        if (changed) return readCart().then(refreshTheme);
      })
      .catch((err: Error) => {
        console.warn("[CartLift]", err && err.message);
      })
      .then(() => {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  }

  // Watch the theme's (and other apps') cart changes. Our own requests use
  // nativeFetch, so they never trigger another pass.
  const MUTATION = /\/cart\/(add|change|update|clear)(\.js|\.json)?(?:[?#]|$)/;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : (input as Request)?.url || String(input);
    const response = nativeFetch(input, init);
    if (MUTATION.test(url)) {
      response.then(
        (r) => {
          if (r.ok) schedule();
        },
        () => {},
      );
    }
    return response;
  };

  if (window.XMLHttpRequest) {
    type TrackedXhr = XMLHttpRequest & { _cartliftUrl?: string };
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: TrackedXhr, ...args: unknown[]) {
      this._cartliftUrl = String(args[1]);
      return (open as (...a: unknown[]) => void).apply(this, args);
    } as typeof open;
    XMLHttpRequest.prototype.send = function (this: TrackedXhr, ...args: unknown[]) {
      if (MUTATION.test(this._cartliftUrl || "")) {
        this.addEventListener("load", function (this: XMLHttpRequest) {
          if (this.status >= 200 && this.status < 300) schedule();
        });
      }
      return (send as (...a: unknown[]) => void).apply(this, args);
    } as typeof send;
  }

  // Full-page cart changes (non-Ajax forms, /cart/change links) land on a new
  // page load; check the cart then too, and when returning via back/forward.
  if (Number(data.count) > 0) schedule(0);
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) schedule(0);
  });
}
