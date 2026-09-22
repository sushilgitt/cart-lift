/*
 * CartLift cart watcher — keeps free gifts in step with the cart.
 *
 * The product widget adds a gift when the shopper picks a gift bar, but a cart
 * can reach (or leave) a gift tier in other ways: adding the product twice,
 * changing quantities in the cart, quick-add from a collection page. This
 * script runs on every page (app embed), watches the theme's Ajax cart calls
 * and reconciles gift lines after each change:
 *  - adds a missing gift once its bar is reached,
 *  - removes a gift whose bar is no longer reached (it would be charged at
 *    full price otherwise),
 *  - keeps each gift at quantity 1, since only one unit is free.
 *
 * Which bar a cart reaches is decided with the Discount Function's rules
 * (extensions/cartlift-discount), from the `cartlift/gifts` metafield
 * published by app/lib/sync.server.ts → buildGiftConfig. When it can't be
 * sure — a line whose collections are unknown here — it changes nothing.
 *
 * A gift the shopper removes while still eligible stays removed until the
 * tier is lost and reached again.
 */
(function () {
  "use strict";
  if (window.CartLiftCart && window.CartLiftCart.loaded) return;
  var API = (window.CartLiftCart = window.CartLiftCart || {});
  API.loaded = true;

  // ---------------------------------------------------------------------------
  // Planning (pure; mirrors cart_lines_discounts_generate_run.ts)
  // ---------------------------------------------------------------------------

  /** true / false, or null when collection membership is unknown. */
  function eligible(deal, item, cols) {
    var pid = Number(item.product_id);
    var p = deal.p || [];
    if (deal.tt === "ALL") return true;
    if (deal.tt === "PRODUCTS") return p.indexOf(pid) >= 0;
    if (deal.tt === "EXCEPT") return p.indexOf(pid) < 0;
    if (deal.tt === "COLLECTIONS") {
      var member = cols[pid];
      if (!member) return null;
      var wanted = deal.c || [];
      return member.some(function (c) {
        return wanted.indexOf(Number(c)) >= 0;
      });
    }
    return false;
  }

  /**
   * Highest bar whose quantity the units reach. Among bars sharing that
   * quantity, the one the shopper picked (`preferred`) wins, else the first.
   */
  function reachedBar(bars, units, preferred) {
    var top = 0;
    bars.forEach(function (bar) {
      if (bar.q > 0 && units >= bar.q && bar.q > top) top = bar.q;
    });
    if (!top) return null;
    var tied = bars.filter(function (bar) {
      return bar.q === top;
    });
    return (
      tied.find(function (bar) {
        return preferred != null && bar.id === preferred;
      }) || tied[0]
    );
  }

  var giftKey = function (dealId, variantId) {
    return dealId + "|" + Number(variantId);
  };

  /**
   * Works out the cart changes that bring gift lines in line with the tiers.
   *
   * @param config  gift config ({ deals: [...] })
   * @param cart    /cart.js response
   * @param cols    { productId: [collectionId] }
   * @param skip    { giftKey: true } gifts not to add (dismissed or unavailable)
   * @returns null when unsure, else { want, present, updates, adds }
   */
  function plan(config, cart, cols, skip) {
    var deals = (config && config.deals) || [];
    var items = (cart && cart.items) || [];
    var byId = {};
    deals.forEach(function (d) {
      byId[d.id] = d;
    });

    // 1. Group deal units exactly like the Function.
    var groups = {};
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var props = item.properties || {};
      if (props._cartlift_gift || props._cartlift_upsell) continue;

      var deal = null;
      var tagged = props._cartlift ? byId[props._cartlift] : null;
      if (tagged) {
        var ok = eligible(tagged, item, cols);
        if (ok === null) return null;
        if (ok) deal = tagged;
      }
      if (!deal) {
        for (var j = 0; j < deals.length; j++) {
          var match = eligible(deals[j], item, cols);
          if (match === null) return null;
          if (match) {
            deal = deals[j];
            break;
          }
        }
      }
      if (!deal) continue;

      var key = deal.across ? deal.id : deal.id + "|" + item.product_id;
      var group = groups[key] || (groups[key] = { deal: deal, units: 0, bar: null });
      group.units += Number(item.quantity) || 0;
      if (props._cartlift_bar && !group.bar) group.bar = props._cartlift_bar;
    }

    // 2. Gifts the reached bars unlock: one unit per (deal, gift variant).
    var want = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var bar = reachedBar(g.deal.bars || [], g.units, g.bar);
      if (bar && bar.gift) want[giftKey(g.deal.id, bar.gift)] = { deal: g.deal.id, variant: Number(bar.gift) };
    });

    // 3. Compare with the gift lines in the cart.
    var have = {};
    items.forEach(function (item) {
      var dealId = (item.properties || {})._cartlift_gift;
      if (!dealId) return;
      var k = giftKey(dealId, item.variant_id);
      (have[k] = have[k] || []).push(item);
    });

    var updates = {};
    var present = [];
    Object.keys(have).forEach(function (k) {
      have[k].forEach(function (item, index) {
        var qty = want[k] && index === 0 ? 1 : 0;
        if (Number(item.quantity) !== qty) updates[item.key] = qty;
      });
      if (want[k]) present.push(k);
    });

    var adds = [];
    Object.keys(want).forEach(function (k) {
      if (have[k] || (skip && skip[k])) return;
      adds.push({ key: k, id: want[k].variant, quantity: 1, properties: { _cartlift_gift: want[k].deal } });
    });

    return { want: want, present: present, updates: updates, adds: adds };
  }

  API.plan = plan;

  // ---------------------------------------------------------------------------
  // Storefront runtime
  // ---------------------------------------------------------------------------

  var nodes = Array.prototype.slice.call(document.querySelectorAll("script[data-cartlift-cart]"));
  var blobs = [];
  nodes.forEach(function (node) {
    try {
      blobs.push(JSON.parse(node.textContent));
    } catch (e) {
      // Malformed block: ignore it.
    }
  });
  var data = blobs[0];
  if (!data || !data.config || !Array.isArray(data.config.deals) || !data.config.g) return;
  if (/[?&]cartlift=off\b/.test(window.location.search)) return;
  if (typeof window.fetch !== "function" || typeof Promise === "undefined") return;

  var config = data.config;
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || data.root || "/";
  if (root.charAt(root.length - 1) !== "/") root += "/";
  var nativeFetch = window.fetch.bind(window);

  function store(kind) {
    try {
      return window[kind];
    } catch (e) {
      return null;
    }
  }
  var session = store("sessionStorage");
  function readJson(key, fallback) {
    try {
      var v = session && JSON.parse(session.getItem(key) || "null");
      return v && typeof v === "object" ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      if (session) session.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Storage full or blocked: work without it.
    }
  }

  // Collection membership: rendered by Liquid for the cart's products and the
  // current product, remembered for the session so Ajax-added products seen
  // on an earlier page are known too.
  var COLS = "cartlift_cols";
  var cols = readJson(COLS, {});
  function learn(pid, list) {
    if (!pid || pid === "_" || !Array.isArray(list)) return;
    cols[Number(pid)] = list.map(Number);
  }
  blobs.forEach(function (b) {
    Object.keys(b.cols || {}).forEach(function (pid) {
      learn(pid, b.cols[pid]);
    });
  });
  Array.prototype.slice.call(document.querySelectorAll("script[data-cartlift-data]")).forEach(function (node) {
    try {
      var d = JSON.parse(node.textContent);
      if (d.product) learn(String(d.product.id), d.collections || []);
    } catch (e) {
      // Malformed block: ignore it.
    }
  });
  writeJson(COLS, cols);

  // Gifts in the cart after the last pass, gifts the shopper removed, and gifts
  // that failed to add (sold out, unpublished) — so nothing loops.
  var LAST = "cartlift_gifts_last";
  var DISMISSED = "cartlift_gifts_dismissed";
  var FAILED = "cartlift_gifts_failed";

  function post(path, body) {
    return nativeFetch(root + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (json) {
        if (!r.ok) throw new Error(json.description || json.message || "Cart request failed");
        return json;
      });
    });
  }

  function reconcile(cart) {
    // Both are about this cart only: a new cart (e.g. after checkout) starts clean.
    var sameCart = function (state) {
      return state.token && state.token === cart.token ? state.keys || {} : {};
    };
    var last = sameCart(readJson(LAST, {}));
    var dismissed = sameCart(readJson(DISMISSED, {}));
    var failed = readJson(FAILED, {});

    var skip = {};
    Object.keys(dismissed).forEach(function (k) {
      skip[k] = true;
    });
    Object.keys(failed).forEach(function (k) {
      skip[k] = true;
    });

    // A gift that was in the cart last time, is still earned, and is gone now
    // was removed by the shopper: don't force it back.
    var probe = plan(config, cart, cols, skip);
    if (!probe) return Promise.resolve(false);
    var inCart = {};
    probe.present.forEach(function (k) {
      inCart[k] = true;
    });
    Object.keys(last).forEach(function (k) {
      if (probe.want[k] && !inCart[k]) {
        dismissed[k] = true;
        skip[k] = true;
      }
    });
    // Losing the tier resets the choice, so reaching it again brings the gift back.
    Object.keys(dismissed).forEach(function (k) {
      if (!probe.want[k]) delete dismissed[k];
    });
    writeJson(DISMISSED, { token: cart.token || null, keys: dismissed });

    var p = plan(config, cart, cols, skip);
    var changed = false;
    var kept = {};
    p.present.forEach(function (k) {
      kept[k] = true;
    });

    var chain = Promise.resolve();
    if (Object.keys(p.updates).length) {
      chain = chain.then(function () {
        return post("cart/update.js", { updates: p.updates }).then(function () {
          changed = true;
        });
      });
    }
    // One request per gift, so one unavailable gift can't block another.
    p.adds.forEach(function (add) {
      chain = chain.then(function () {
        return post("cart/add.js", { items: [{ id: add.id, quantity: add.quantity, properties: add.properties }] }).then(
          function () {
            changed = true;
            kept[add.key] = true;
            document.dispatchEvent(
              new CustomEvent("cartlift:gift-added", { detail: { dealId: add.properties._cartlift_gift, variantId: add.id } }),
            );
          },
          function (err) {
            failed[add.key] = true;
            writeJson(FAILED, failed);
            console.warn("[CartLift] Free gift could not be added:", err && err.message);
          },
        );
      });
    });

    return chain.then(function () {
      writeJson(LAST, { token: cart.token || null, keys: kept });
      return changed;
    });
  }

  // Theme refresh after we change the cart ------------------------------------

  function dawnPubSub() {
    /* global publish, PUB_SUB_EVENTS */
    try {
      if (typeof publish === "function" && typeof PUB_SUB_EVENTS !== "undefined" && PUB_SUB_EVENTS.cartUpdate) {
        return function (cart) {
          publish(PUB_SUB_EVENTS.cartUpdate, { source: "cartlift", cartData: cart });
        };
      }
    } catch (e) {
      // Not a Dawn-style theme.
    }
    return null;
  }

  function refreshBubble() {
    var bubble = document.getElementById("cart-icon-bubble");
    if (!bubble || typeof DOMParser === "undefined") return;
    nativeFetch(root + "?sections=cart-icon-bubble", { credentials: "same-origin" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (sections) {
        var html = sections && sections["cart-icon-bubble"];
        if (!html) return;
        var inner = new DOMParser().parseFromString(html, "text/html").querySelector(".shopify-section");
        if (inner) bubble.innerHTML = inner.innerHTML;
      })
      .catch(function () {});
  }

  function refreshTheme(cart) {
    document.dispatchEvent(new CustomEvent("cartlift:cart-updated", { detail: cart }));

    // The cart page shows lines and totals; reload it so both are right.
    if (/^cart/.test(data.template || "") || /\/cart\/?$/.test(window.location.pathname)) {
      var now = Date.now();
      var lastReload = Number(readJson("cartlift_reload", { t: 0 }).t) || 0;
      if (now - lastReload > 5000) {
        writeJson("cartlift_reload", { t: now });
        window.location.reload();
        return;
      }
    }

    // Dawn and its descendants re-render the cart drawer on this event.
    var dawn = dawnPubSub();
    if (dawn) {
      try {
        dawn(cart);
      } catch (e) {
        // A theme handler failed; the cart itself is already right.
      }
      refreshBubble();
      return;
    }
    // Events other popular themes listen to for a cart re-render.
    ["cart:refresh", "cart:build", "theme:cart:reload"].forEach(function (name) {
      document.documentElement.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { cart: cart } }));
    });
  }

  // Scheduling -----------------------------------------------------------------

  var timer = null;
  var running = false;
  var again = false;

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay == null ? 400 : delay);
  }

  function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    nativeFetch(root + "cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("cart.js " + r.status);
        return r.json();
      })
      .then(function (cart) {
        return reconcile(cart).then(function (changed) {
          if (!changed) return;
          return nativeFetch(root + "cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
            .then(function (r) {
              return r.json();
            })
            .then(refreshTheme);
        });
      })
      .catch(function (err) {
        console.warn("[CartLift]", err && err.message);
      })
      .then(function () {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  }

  // Watch the theme's (and other apps') cart changes. Our own requests use
  // nativeFetch, so they never trigger another pass.
  var MUTATION = /\/cart\/(add|change|update|clear)(\.js|\.json)?(?:[?#]|$)/;

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var response = nativeFetch(input, init);
    if (MUTATION.test(url)) {
      response.then(
        function (r) {
          if (r.ok) schedule();
        },
        function () {},
      );
    }
    return response;
  };

  if (window.XMLHttpRequest) {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._cartliftUrl = String(url);
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (MUTATION.test(this._cartliftUrl || "")) {
        this.addEventListener("load", function () {
          if (this.status >= 200 && this.status < 300) schedule();
        });
      }
      return send.apply(this, arguments);
    };
  }

  // Full-page cart changes (non-Ajax forms, /cart/change links) land on a new
  // page load; check the cart then too, and when returning via back/forward.
  if (Number(data.count) > 0) schedule(0);
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) schedule(0);
  });
})();
