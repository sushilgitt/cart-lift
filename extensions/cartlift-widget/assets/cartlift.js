/*
 * CartLift storefront widget.
 *
 * Reads the config inlined by snippets/cartlift-data.liquid, renders the deal
 * bars on the product page and drives the theme's own product form:
 *  - single-line adds (one variant, no gift/upsell): sets the form quantity and
 *    adds `_cartlift` / `_cartlift_arm` line properties, then lets the theme add
 *    to cart as usual so its cart drawer keeps working;
 *  - multi-line adds (per-unit variants, gifts, upsells): intercepts the submit
 *    and posts every line to /cart/add.js together.
 *
 * Checkout prices come from the CartLift Discount Function; the numbers shown
 * here use the same formulas (app/lib/deals.ts → priceBar).
 *
 * `window.CartLift.preview()` is used by the admin editor for a live preview.
 */
(function () {
  "use strict";
  if (window.CartLift && window.CartLift.loaded) return;
  var CL = (window.CartLift = window.CartLift || {});
  CL.loaded = true;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoney(cents, format) {
    format = format || "${{amount}}";
    var amount = (Math.round(cents) / 100).toFixed(2);
    var parts = amount.split(".");
    var whole = parts[0];
    var dec = parts[1];
    var commas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var dots = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return format.replace(/\{\{\s*(\w+)\s*\}\}/, function (_m, key) {
      if (key === "amount_no_decimals") return commas;
      if (key === "amount_with_comma_separator") return dots + "," + dec;
      if (key === "amount_no_decimals_with_comma_separator") return dots;
      if (key === "amount_with_apostrophe_separator")
        return whole.replace(/\B(?=(\d{3})+(?!\d))/g, "'") + "." + dec;
      return commas + "." + dec;
    });
  }

  /** Replaces {{variables}}; the text itself is escaped, variables are pre-formatted. */
  function renderText(text, vars) {
    return esc(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? esc(vars[key]) : m;
    });
  }

  /** Mirrors priceBar() in app/lib/deals.ts. Amounts in cents. */
  function priceBar(bar, unit, compare, rate) {
    var qty = Math.max(1, bar.qty);
    var base = unit * qty;
    var total = base;
    var v = Math.max(0, Number(bar.dv) || 0);
    if (bar.kind === "bxgy") {
      var get = Math.min(bar.get || 0, qty - 1);
      var each;
      if (bar.dt === "none") each = unit;
      else if (bar.dt === "percentage") each = (unit * Math.min(v, 100)) / 100;
      else if (bar.dt === "amount") each = Math.min(v * 100 * rate, unit);
      else each = Math.max(0, unit - v * 100 * rate);
      total = base - each * Math.max(0, get);
    } else if (bar.dt === "percentage") {
      total = base * (1 - Math.min(v, 100) / 100);
    } else if (bar.dt === "amount") {
      total = Math.max(0, base - v * 100 * rate * qty);
    } else if (bar.dt === "fixed_total") {
      total = Math.min(base, v * 100 * rate);
    }
    total = Math.round(total);
    var full = Math.max(base, compare > unit ? compare * qty : base);
    var saved = Math.max(0, full - total);
    return {
      total: total,
      full: full,
      saved: saved,
      savedPct: full > 0 ? Math.round((saved / full) * 100) : 0,
      unit: Math.round(total / qty),
    };
  }

  function styleVars(style) {
    var c = (style && style.colors) || {};
    var map = {
      "--cl-accent": c.accent,
      "--cl-bar-bg": c.barBg,
      "--cl-bar-selected-bg": c.barSelectedBg,
      "--cl-border": c.border,
      "--cl-border-selected": c.borderSelected,
      "--cl-title": c.title,
      "--cl-subtitle": c.subtitle,
      "--cl-price": c.price,
      "--cl-full-price": c.fullPrice,
      "--cl-label-bg": c.labelBg,
      "--cl-label-text": c.labelText,
      "--cl-badge-bg": c.badgeBg,
      "--cl-badge-text": c.badgeText,
      "--cl-block-title": c.blockTitle,
      "--cl-radius": style && style.radius != null ? style.radius + "px" : null,
      "--cl-title-size": style && style.titleSize ? style.titleSize + "px" : null,
    };
    var out = "";
    for (var k in map) {
      if (map[k] != null && map[k] !== "" && /^[#\w\s(),.%-]+$/.test(String(map[k])))
        out += k + ":" + map[k] + ";";
    }
    return out;
  }

  function moneyToCents(value, rate) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100 * rate) : 0;
  }

  // ---------------------------------------------------------------------------
  // Rendering (shared by storefront and admin preview)
  // ---------------------------------------------------------------------------

  /**
   * @param deal   storefront deal (see buildStorefrontConfig)
   * @param state  { barId, variantId, unitVariants: [], upsells: {id: bool}, bars }
   * @param ctx    { product, moneyFormat, rate }
   */
  function renderDeal(deal, state, ctx) {
    var style = deal.style || {};
    var product = ctx.product;
    var variants = product.variants || [];
    var variant =
      variants.find(function (v) {
        return String(v.id) === String(state.variantId);
      }) || variants[0];
    if (!variant) return "";
    var unit = Number(variant.price) || 0;
    var compare = style.useCompareAt ? Number(variant.compare_at_price) || 0 : 0;
    var fmt = function (c) {
      return formatMoney(c, ctx.moneyFormat);
    };
    var bars = state.bars || deal.bars;
    var layout = ["vertical", "horizontal", "grid"].indexOf(style.layout) >= 0 ? style.layout : "vertical";

    var html =
      '<div class="cl-block cl-layout-' + layout + '" style="' + styleVars(style) + '" data-deal="' + esc(deal.id) + '">';
    if (style.showBlockTitle && style.blockTitle) {
      html += '<div class="cl-heading"><span>' + esc(style.blockTitle) + "</span></div>";
    }
    html += '<div class="cl-bars" role="radiogroup">';

    bars.forEach(function (bar) {
      var selected = bar.id === state.barId;
      var p = priceBar(bar, unit, compare, ctx.rate);
      var vars = {
        quantity: bar.qty,
        buy: bar.kind === "bxgy" ? bar.qty - (bar.get || 0) : bar.qty,
        get: bar.get || 0,
        price: fmt(p.total),
        full_price: fmt(p.full),
        unit_price: fmt(p.unit),
        saved_amount: fmt(p.saved),
        saved_percentage: p.savedPct + "%",
        product: product.title || "",
      };

      html +=
        '<div class="cl-bar' + (selected ? " is-selected" : "") + '" role="radio" tabindex="0" aria-checked="' +
        selected + '" data-bar="' + esc(bar.id) + '">';
      if (bar.badge) {
        html +=
          '<span class="cl-badge' + (bar.badgeStyle === "fancy" ? " cl-badge--fancy" : "") + '">' +
          renderText(bar.badge, vars) + "</span>";
      }
      html += '<span class="cl-radio" aria-hidden="true"></span>';
      html += '<div class="cl-bar-main"><div class="cl-bar-head"><span class="cl-bar-title">' + renderText(bar.title, vars) + "</span>";
      if (bar.label) html += '<span class="cl-bar-label">' + renderText(bar.label, vars) + "</span>";
      html += "</div>";
      if (bar.subtitle) html += '<div class="cl-bar-sub">' + renderText(bar.subtitle, vars) + "</div>";
      html += "</div>";
      html += '<div class="cl-bar-prices"><span class="cl-price">' + esc(fmt(p.total)) + "</span>";
      if (p.full > p.total) html += '<span class="cl-full">' + esc(fmt(p.full)) + "</span>";
      if (style.showUnitPrice && bar.qty > 1) html += '<span class="cl-unit">' + esc(fmt(p.unit)) + " / each</span>";
      html += "</div>";

      // Extras: variant pickers (selected bar only), gift, upsells.
      var extras = "";
      var multiVariant = variants.length > 1 && deal.variantPerUnit;
      if (selected && multiVariant) {
        extras += '<div class="cl-variants">';
        for (var i = 0; i < bar.qty; i++) {
          var chosen = (state.unitVariants && state.unitVariants[i]) || variant.id;
          extras += '<label class="cl-variant-row"><span>#' + (i + 1) + '</span><select data-unit="' + i + '">';
          variants.forEach(function (v) {
            extras +=
              '<option value="' + esc(v.id) + '"' + (String(v.id) === String(chosen) ? " selected" : "") +
              (v.available === false ? " disabled" : "") + ">" + esc(v.title) + (v.available === false ? " — sold out" : "") + "</option>";
          });
          extras += "</select></label>";
        }
        extras += "</div>";
      }
      if (bar.gift) {
        var giftPrice = moneyToCents(bar.gift.price, ctx.rate);
        extras +=
          '<div class="cl-gift">' +
          (bar.gift.image ? '<img class="cl-thumb" src="' + esc(bar.gift.image) + '" alt="" loading="lazy">' : "") +
          '<span class="cl-extra-text">' + renderText(bar.gift.text || "+ FREE gift", vars) + " — " + esc(bar.gift.title) + "</span>" +
          '<span class="cl-extra-price">' + esc(fmt(0)) + (giftPrice ? "<s>" + esc(fmt(giftPrice)) + "</s>" : "") + "</span></div>";
      }
      (bar.upsells || []).forEach(function (up) {
        if (up.onlyWhenSelected && !selected) return;
        var full = moneyToCents(up.price, ctx.rate);
        var pay = priceBar({ kind: "qty", qty: 1, dt: up.dt, dv: up.dv }, full, 0, ctx.rate).total;
        var upVars = Object.assign({}, vars, { product: up.title, price: fmt(pay), full_price: fmt(full) });
        var checked = state.upsells && Object.prototype.hasOwnProperty.call(state.upsells, up.id) ? state.upsells[up.id] : up.checked;
        extras +=
          '<label class="cl-upsell"><input type="checkbox" data-upsell="' + esc(up.id) + '"' + (checked ? " checked" : "") + ">" +
          (up.image ? '<img class="cl-thumb" src="' + esc(up.image) + '" alt="" loading="lazy">' : "") +
          '<span class="cl-extra-text">' + renderText(up.text, upVars) + "</span>" +
          '<span class="cl-extra-price">' + esc(fmt(pay)) + (full > pay ? "<s>" + esc(fmt(full)) + "</s>" : "") + "</span></label>";
      });
      if (extras) html += '<div class="cl-extras">' + extras + "</div>";
      html += "</div>";
    });

    html += "</div></div>";
    return html;
  }

  function initialBar(bars) {
    var sel = bars.find(function (b) {
      return b.selected;
    });
    return (sel || bars[0] || {}).id;
  }

  /** Admin live preview. Returns an updater. */
  CL.preview = function (el, deal, ctx) {
    var state = {
      barId: initialBar(deal.bars),
      variantId: ctx.product.variants[0] && ctx.product.variants[0].id,
      unitVariants: [],
      upsells: {},
      bars: deal.bars,
    };
    function draw() {
      el.innerHTML = renderDeal(deal, state, ctx);
    }
    el.onclick = function (e) {
      if (e.target.closest("select, input")) return;
      var bar = e.target.closest("[data-bar]");
      if (bar) {
        state.barId = bar.getAttribute("data-bar");
        draw();
      }
    };
    draw();
    return function update(nextDeal, nextCtx) {
      deal = nextDeal;
      ctx = nextCtx || ctx;
      state.bars = deal.bars;
      if (!deal.bars.some(function (b) { return b.id === state.barId; })) state.barId = initialBar(deal.bars);
      draw();
    };
  };
  CL.priceBar = priceBar;
  CL.formatMoney = formatMoney;

  // ---------------------------------------------------------------------------
  // Storefront
  // ---------------------------------------------------------------------------

  function isLive(deal) {
    var now = Date.now();
    if (deal.s && Date.parse(deal.s) > now) return false;
    if (deal.e && Date.parse(deal.e) <= now) return false;
    return true;
  }

  function matchDeal(data) {
    var deals = (data.config && data.config.deals) || [];
    var pid = Number(data.product.id);
    var cols = data.collections || [];
    return deals.find(function (d) {
      if (!isLive(d) || !d.bars || !d.bars.length) return false;
      if (d.tt === "ALL") return true;
      if (d.tt === "PRODUCTS") return d.p.indexOf(pid) >= 0;
      if (d.tt === "EXCEPT") return d.p.indexOf(pid) < 0;
      if (d.tt === "COLLECTIONS")
        return cols.some(function (c) {
          return d.c.indexOf(Number(c)) >= 0;
        });
      return false;
    });
  }

  /** A/B arm, sticky per visitor. Arms: [{key, weight, bars}] (Phase 3). */
  function pickArm(deal) {
    var arms = deal.arms || [];
    if (!arms.length) return { key: "A", bars: deal.bars };
    var storeKey = "cartlift_arm_" + deal.id;
    var key = null;
    try {
      key = localStorage.getItem(storeKey);
    } catch (e) {}
    var all = [{ key: "A", weight: deal.weightA == null ? 50 : deal.weightA, bars: deal.bars }].concat(arms);
    var found = all.find(function (a) {
      return a.key === key;
    });
    if (!found) {
      var total = all.reduce(function (s, a) {
        return s + Math.max(0, a.weight || 0);
      }, 0);
      var r = Math.random() * (total || 1);
      found = all[0];
      for (var i = 0; i < all.length; i++) {
        r -= Math.max(0, all[i].weight || 0);
        if (r < 0) {
          found = all[i];
          break;
        }
      }
      try {
        localStorage.setItem(storeKey, found.key);
      } catch (e) {}
    }
    return found;
  }

  function beacon(api, shop, events) {
    if (!api) return;
    var body = JSON.stringify({ shop: shop, events: events });
    var url = api.replace(/\/$/, "") + "/api/events";
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
    } catch (e) {}
    try {
      fetch(url, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } });
    } catch (e) {}
  }

  function findForm(product, near) {
    var ids = (product.variants || []).map(function (v) {
      return String(v.id);
    });
    var scope = (near && near.closest(".shopify-section, section")) || document;
    var candidates = Array.prototype.slice.call(scope.querySelectorAll('form[action*="/cart/add"]'));
    if (scope !== document) candidates = candidates.concat(Array.prototype.slice.call(document.querySelectorAll('form[action*="/cart/add"]')));
    return candidates.find(function (form) {
      if (form.closest("cart-drawer, .cart-drawer, [id*='quick'], [class*='quick-add'], aside")) return false;
      var input = form.querySelector('[name="id"]');
      return input && ids.indexOf(String(input.value)) >= 0;
    });
  }

  function formControls(form, name) {
    var list = Array.prototype.slice.call(form.querySelectorAll('[name="' + name + '"]'));
    if (form.id) list = list.concat(Array.prototype.slice.call(document.querySelectorAll('[name="' + name + '"][form="' + form.id + '"]')));
    return list;
  }

  function hiddenInput(form, name) {
    var input = form.querySelector('input[type="hidden"][name="' + name + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    return input;
  }

  function mount(container, deal, data, form) {
    var rate = Number(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate) || 1;
    var ctx = { product: data.product, moneyFormat: data.moneyFormat, rate: rate };
    var arm = pickArm(deal);
    var idInput = form.querySelector('[name="id"]');
    var state = {
      barId: initialBar(arm.bars),
      variantId: idInput ? idInput.value : data.product.variants[0].id,
      unitVariants: [],
      upsells: {},
      bars: arm.bars,
    };
    var api = data.config.api;

    // The widget owns the quantity; hide the theme's selector.
    formControls(form, "quantity").forEach(function (q) {
      var wrap = q.closest(".product-form__quantity, .product__quantity, quantity-input, .quantity-selector, .quantity, [class*='quantity-wrapper']");
      (wrap || q).classList.add("cartlift-hidden");
    });

    function selectedBar() {
      return state.bars.find(function (b) {
        return b.id === state.barId;
      });
    }

    function lines() {
      var bar = selectedBar();
      if (!bar) return [];
      var props = { _cartlift: deal.id, _cartlift_arm: arm.key };
      var items = [];
      var counts = {};
      for (var i = 0; i < bar.qty; i++) {
        var id = (deal.variantPerUnit && state.unitVariants[i]) || state.variantId;
        counts[id] = (counts[id] || 0) + 1;
      }
      Object.keys(counts).forEach(function (id) {
        items.push({ id: Number(id), quantity: counts[id], properties: props });
      });
      if (bar.gift) items.push({ id: bar.gift.id, quantity: 1, properties: { _cartlift_gift: deal.id } });
      (bar.upsells || []).forEach(function (up) {
        var on = Object.prototype.hasOwnProperty.call(state.upsells, up.id) ? state.upsells[up.id] : up.checked;
        if (on) items.push({ id: up.variant, quantity: 1, properties: { _cartlift_upsell: deal.id + ":" + up.id } });
      });
      return items;
    }

    function sync() {
      var bar = selectedBar();
      if (!bar) return;
      var qtys = formControls(form, "quantity");
      if (!qtys.length) qtys = [hiddenInput(form, "quantity")];
      qtys.forEach(function (q) {
        q.value = bar.qty;
      });
      hiddenInput(form, "properties[_cartlift]").value = deal.id;
      hiddenInput(form, "properties[_cartlift_arm]").value = arm.key;
      // Buy-it-now only supports a single line.
      var multi = lines().length > 1;
      var dyn = form.querySelector(".shopify-payment-button");
      if (dyn) dyn.classList.toggle("cartlift-hidden", multi);
    }

    function draw() {
      container.innerHTML = renderDeal(deal, state, ctx);
      sync();
    }

    function choose(barId) {
      if (barId === state.barId) return;
      state.barId = barId;
      state.unitVariants = [];
      draw();
      container.dispatchEvent(new CustomEvent("cartlift:bar-selected", { bubbles: true, detail: { dealId: deal.id, barId: barId } }));
    }

    container.addEventListener("click", function (e) {
      if (e.target.closest("select, input, label.cl-upsell")) return;
      var bar = e.target.closest("[data-bar]");
      if (bar) choose(bar.getAttribute("data-bar"));
    });
    container.addEventListener("keydown", function (e) {
      var bar = e.target.closest && e.target.closest("[data-bar]");
      if (bar && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        choose(bar.getAttribute("data-bar"));
      }
    });
    container.addEventListener("change", function (e) {
      var t = e.target;
      if (t.hasAttribute("data-unit")) state.unitVariants[Number(t.getAttribute("data-unit"))] = t.value;
      if (t.hasAttribute("data-upsell")) state.upsells[t.getAttribute("data-upsell")] = t.checked;
      sync();
    });

    // Follow the theme's variant picker.
    setInterval(function () {
      if (idInput && String(idInput.value) !== String(state.variantId)) {
        state.variantId = idInput.value;
        state.unitVariants = [];
        draw();
      }
    }, 300);

    var busy = false;
    function onSubmit(e) {
      var items = lines();
      beacon(api, data.shop, [{ t: "atc", d: deal.id, a: arm.key }]);
      if (items.length <= 1) {
        sync();
        return; // Let the theme add to cart.
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return;
      busy = true;
      addLines(items).finally(function () {
        busy = false;
      });
    }
    form.addEventListener("submit", onSubmit, true);

    draw();

    var seenKey = "cartlift_seen_" + deal.id;
    var seen = false;
    try {
      seen = sessionStorage.getItem(seenKey);
      sessionStorage.setItem(seenKey, "1");
    } catch (e) {}
    if (!seen) beacon(api, data.shop, [{ t: "view", d: deal.id, a: arm.key }]);
  }

  function addLines(items) {
    var drawer = document.querySelector("cart-drawer") || document.querySelector("cart-notification");
    var body = { items: items };
    var canRender = drawer && typeof drawer.getSectionsToRender === "function" && typeof drawer.renderContents === "function";
    if (canRender) {
      body.sections = drawer.getSectionsToRender().map(function (s) {
        return s.id;
      });
      body.sections_url = window.location.pathname;
    }
    return fetch((window.Shopify && window.Shopify.routes && window.Shopify.routes.root || "/") + "cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (json) {
          if (!r.ok) throw new Error(json.description || json.message || "Could not add to cart");
          return json;
        });
      })
      .then(function (json) {
        document.dispatchEvent(new CustomEvent("cartlift:added", { detail: json }));
        if (canRender) {
          var first = (json.items && json.items[0]) || {};
          drawer.renderContents(Object.assign({}, json, { id: first.id, key: first.key }));
          if (drawer.classList && drawer.classList.contains("is-empty")) drawer.classList.remove("is-empty");
        } else {
          window.location.href = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root || "/") + "cart";
        }
      })
      .catch(function (err) {
        window.alert(err.message);
      });
  }

  function init() {
    if (/[?&]cartlift=off\b/.test(window.location.search)) return;
    var nodes = Array.prototype.slice.call(document.querySelectorAll("script[data-cartlift-data]"));
    var parsed = [];
    nodes.forEach(function (node) {
      try {
        parsed.push({ node: node, data: JSON.parse(node.textContent) });
      } catch (e) {}
    });
    // App blocks win over the embed's auto placement.
    parsed.sort(function (a, b) {
      return (a.data.placement === "block" ? 0 : 1) - (b.data.placement === "block" ? 0 : 1);
    });
    var done = {};
    parsed.forEach(function (entry) {
      var data = entry.data;
      if (!data.product || !data.config || done[data.product.id]) return;
      var deal = matchDeal(data);
      if (!deal) return;

      var slot = null;
      var form;
      if (data.placement === "block") {
        slot = document.querySelector('.cartlift-slot[data-product-id="' + data.product.id + '"]');
        if (!slot) return;
        form = findForm(data.product, slot);
      } else {
        form = findForm(data.product, null);
        if (form) {
          slot = document.createElement("div");
          slot.className = "cartlift-slot";
          var btn = form.querySelector('[type="submit"], button[name="add"]');
          var anchor = btn && (btn.closest(".product-form__buttons, .product-form__submit, .product-form__actions") || btn);
          if (anchor && anchor.parentNode && form.contains(anchor)) anchor.parentNode.insertBefore(slot, anchor);
          else form.insertBefore(slot, form.firstChild);
        }
      }
      if (!slot || !form) return;
      done[data.product.id] = true;
      if (data.config.css && !document.getElementById("cartlift-custom-css")) {
        var style = document.createElement("style");
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
