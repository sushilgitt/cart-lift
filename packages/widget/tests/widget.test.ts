import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { bundle } from "../../../scripts/build-widget.mjs";

const asset = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../extensions/cartlift-widget/assets/${name}`, import.meta.url)), "utf8");

describe("built assets", () => {
  test("match packages/widget/src (run `npm run build:widget` after editing)", async () => {
    const built = (await bundle()) as Record<string, string>;
    for (const [name, code] of Object.entries(built)) {
      expect(asset(name).replace(/\r\n/g, "\n"), name).toBe(code);
    }
  });
});

type Json = Record<string, unknown>;

const TEE = {
  id: 1,
  title: "Tee",
  handle: "tee",
  variants: [
    { id: 11, title: "S", price: 2000, compare_at_price: null, available: true },
    { id: 12, title: "M", price: 2000, compare_at_price: null, available: true },
  ],
};

/** Size × Color, with Large / Blue sold out. */
const SHIRT = {
  id: 1,
  title: "Shirt",
  options: ["Size", "Color"],
  variants: [
    { id: 21, title: "S / Red", options: ["S", "Red"], price: 3000, compare_at_price: 4000, available: true, featured_image: { src: "https://cdn/s-red.png" } },
    { id: 22, title: "S / Blue", options: ["S", "Blue"], price: 3000, compare_at_price: 4000, available: true, featured_image: { src: "https://cdn/s-blue.png" } },
    { id: 23, title: "L / Red", options: ["L", "Red"], price: 3000, compare_at_price: 4000, available: true },
    { id: 24, title: "L / Blue", options: ["L", "Blue"], price: 3000, compare_at_price: 4000, available: false },
  ],
};
const SHIRT_SWATCHES = [
  { name: "Size", values: [{ name: "S", color: null, image: null }, { name: "L", color: null, image: null }] },
  { name: "Color", values: [{ name: "Red", color: "#ff0000", image: null }, { name: "Blue", color: "#0000ff", image: "https://cdn/blue.png" }] },
];

/** A product page with a Dawn-like form, the widget's data block and the built widget. */
function productPage(
  deal: Json,
  {
    product = TEE as Json,
    variant = String((product.variants as Json[])[0].id),
    extra = {} as Json,
    inForm = "",
    recommendations = [] as Json[],
    store = {} as Record<string, Json>,
    storage = {} as Record<string, string>,
  } = {},
) {
  const window = new Window({ url: "https://shop.test/products/tee" });
  const document = window.document;
  const posts: { url: string; body: unknown }[] = [];
  const themeSubmits: number[] = [];
  const events: [string, Json][] = [];
  Object.assign(window, {
    fetch: async (url: string, init?: { body?: string }) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("recommendations/products.json")) return { ok: true, json: async () => ({ products: recommendations }) };
      // Storefront JSON endpoints (mix & match pool): exact path → body.
      const path = String(url).split("?")[0];
      if (store[path]) return { ok: true, json: async () => store[path] };
      return { ok: true, json: async () => ({ items: [] }) };
    },
    Shopify: { currency: { rate: "1.0" }, routes: { root: "/" } },
    alert: () => {},
  });
  (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  document.body.innerHTML = `
    <section class="shopify-section">
      <form action="/cart/add" class="product-form">
        <input type="hidden" name="id" value="${variant}">
        ${inForm}
        <div class="product-form__quantity"><input name="quantity" value="1"></div>
        <div class="product-form__buttons"><button type="submit" name="add">Add</button><div class="shopify-payment-button"></div></div>
      </form>
    </section>`;
  const data = document.createElement("script");
  data.type = "application/json";
  data.setAttribute("data-cartlift-data", "1");
  data.textContent = JSON.stringify({
    config: { v: 1, api: "", css: "", deals: [deal] },
    product,
    collections: [],
    moneyFormat: "${{amount}}",
    shop: "s.myshopify.com",
    placement: "auto",
    ...extra,
  });
  document.body.appendChild(data);
  const form = document.querySelector("form")!;
  form.addEventListener("submit", () => themeSubmits.push(1));
  for (const name of ["cartlift:bar-selected", "cartlift:variant-selected", "cartlift:variants-changed"]) {
    document.addEventListener(name, (e) => events.push([name, (e as unknown as { detail: Json }).detail]));
  }
  window.eval(asset("cartlift.js"));

  const $ = (selector: string) => document.querySelector(selector) as unknown as HTMLElement | null;
  const input = (name: string) => (form.querySelector(`[name="${name}"]`) as unknown as { value: string } | null)?.value;
  const click = (selector: string) => $(selector)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  const choose = (selector: string, value: string) => {
    const el = $(selector) as unknown as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  };
  const submit = () => {
    const event = new window.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const added = () => posts.find((p) => p.url.endsWith("cart/add.js"))?.body as { items: Json[] } | undefined;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { document, $, input, click, choose, submit, added, settle, posts, themeSubmits, events };
}

const bar = (o: Json) => ({
  kind: "qty", qty: 1, get: 0, dt: "none", dv: 0, title: "Bar", subtitle: "", label: "", badge: "",
  badgeStyle: "simple", selected: false, gift: null, upsells: [], ...o,
});
const deal = (bars: unknown[], o: Json = {}) => ({
  id: "d1", name: "Deal", type: "QUANTITY_BREAK", tt: "ALL", p: [], c: [], s: null, e: null,
  across: false, variantPerUnit: false, style: { layout: "vertical", showUnitPrice: true }, bars, ...o,
});

describe("storefront widget", () => {
  test("renders the bars with prices and drives the theme form", () => {
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true })]));
    expect(page.document.querySelectorAll(".cl-bar")).toHaveLength(2);
    expect(page.$(".cl-bar.is-selected .cl-price")?.textContent).toBe("$36.00");
    expect(page.input("quantity")).toBe("2");
    expect(page.input("properties[_cartlift]")).toBe("d1");
    expect(page.input("properties[_cartlift_bar]")).toBeUndefined();
    page.click('[data-bar="b1"]');
    expect(page.input("quantity")).toBe("1");
    // A single line goes through the theme's own add to cart.
    expect(page.submit()).toBe(false);
    expect(page.themeSubmits).toHaveLength(1);
  });

  test("tags the bar only when two bars share a quantity", () => {
    const page = productPage(
      deal([bar({ id: "b1" }), bar({ id: "plain", qty: 2, dt: "percentage", dv: 10 }), bar({ id: "gifted", qty: 2, dt: "percentage", dv: 10 })]),
    );
    page.click('[data-bar="gifted"]');
    expect(page.input("properties[_cartlift_bar]")).toBe("gifted");
  });

  test("a gift makes it a multi-line add posted by the widget", () => {
    const gift = { id: 555, title: "Socks", image: null, price: "5.00", text: "+ FREE gift" };
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, gift, selected: true })]));
    expect(page.submit()).toBe(true);
    expect(page.themeSubmits).toHaveLength(0);
    expect(page.added()).toEqual({
      items: [
        { id: 11, quantity: 2, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
        { id: 555, quantity: 1, properties: { _cartlift_gift: "d1" } },
      ],
    });
  });

  test("escapes merchant text", () => {
    const page = productPage(deal([bar({ id: "b1", title: "<img src=x onerror=alert(1)>", highlights: ["<b>bold</b>"] })]));
    expect(page.document.querySelector("img[src=x]")).toBeNull();
    expect(page.$(".cl-bar-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(page.$(".cl-highlights li")?.textContent).toBe("<b>bold</b>");
  });
});

describe("Phase 1: bars", () => {
  test("bar image and highlights", () => {
    const page = productPage(
      deal([bar({ id: "b1", image: { url: "https://cdn/pack.png", alt: "Pack" }, highlights: ["Free shipping", "", "Save {{saved_percentage}}"], dt: "percentage", dv: 10 })]),
    );
    const img = page.$(".cl-bar-img") as unknown as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://cdn/pack.png");
    expect(img.getAttribute("alt")).toBe("Pack");
    expect([...page.document.querySelectorAll(".cl-highlights li")].map((li) => li.textContent)).toEqual(["Free shipping", "Save 10%"]);
  });

  test("new variables: compare_price, discount and metafield values", () => {
    const page = productPage(
      deal([bar({ id: "b1", qty: 2, dt: "percentage", dv: 15, title: "{{discount}} off, was {{compare_price}}", subtitle: "{{material}} · {{missing}}" })], {
        mfv: [{ name: "material", k: "custom.material" }, { name: "missing", k: "custom.none" }],
      }),
      { product: SHIRT, extra: { mf: { "custom.material": "Organic cotton", "custom.none": null } } },
    );
    expect(page.$(".cl-bar-title")?.textContent).toBe("15% off, was $80.00");
    // Unknown or empty variables stay as typed.
    expect(page.$(".cl-bar-sub")?.textContent).toBe("Organic cotton · {{missing}}");
  });

  test("buy X get Y with an extra percentage shows the checkout price", () => {
    const page = productPage(deal([bar({ id: "b1", kind: "bxgy", qty: 4, get: 1, dt: "percentage", dv: 100, xp: 10 })]));
    // 4 × $20 − 1 free = $60, − 10% = $54.
    expect(page.$(".cl-price")?.textContent).toBe("$54.00");
  });
});

describe("Phase 1: variants", () => {
  test("per-unit pickers have one dropdown per option; sold-out combinations are marked", () => {
    const page = productPage(deal([bar({ id: "b1", qty: 2, selected: true })], { variantPerUnit: true }), { product: SHIRT, variant: "21" });
    const rows = page.document.querySelectorAll(".cl-variant-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll("select")).toHaveLength(2);
    expect(rows[0].querySelector(".cl-unit-no")?.textContent).toBe("#1");
    // Unit 2: switch to L; Blue is then sold out.
    page.choose('select[data-unit="1"][data-opt="0"]', "L");
    const colors = [...page.document.querySelectorAll('select[data-unit="1"][data-opt="1"] option')].map((o) => o.textContent);
    expect(colors).toEqual(["Red", "Blue — sold out"]);
    expect(page.events.find(([n]) => n === "cartlift:variant-selected")?.[1]).toEqual({ dealId: "d1", unit: 1, variantId: 23 });
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toEqual([
      { id: 21, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
      { id: 23, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
    ]);
  });

  test("same variant on every unit: the theme adds it (form id follows the pickers)", () => {
    const page = productPage(deal([bar({ id: "b1", qty: 2, selected: true })], { variantPerUnit: true }), { product: SHIRT, variant: "21" });
    page.choose('select[data-unit="0"][data-opt="1"]', "Blue");
    page.choose('select[data-unit="1"][data-opt="1"]', "Blue");
    expect(page.input("id")).toBe("22");
    expect(page.submit()).toBe(false);
  });

  test("swatches: colour, uploaded image or variant image, with shape and selection", () => {
    const style = (source: string) => ({ layout: "vertical", variants: { display: "swatch", source, shape: "square", size: 30 } });
    const color = productPage(deal([bar({ id: "b1", selected: true })], { showVariantPicker: true, style: style("color") }), {
      product: SHIRT,
      variant: "21",
      extra: { options: SHIRT_SWATCHES },
    });
    const red = color.$('.cl-swatch[data-opt="1"][data-val="Red"]')!;
    expect(red.getAttribute("style")).toContain("background-color:#ff0000");
    expect(red.className).toContain("cl-swatch--square");
    expect(red.className).toContain("is-selected");
    // Size has no swatch data: text buttons. Single-unit rows have no "#1".
    expect(color.$('.cl-swatch[data-opt="0"][data-val="S"]')!.className).toContain("cl-swatch--text");
    expect(color.$(".cl-unit-no")).toBeNull();
    color.click('.cl-swatch[data-opt="1"][data-val="Blue"]');
    expect(color.input("id")).toBe("22");

    const image = productPage(deal([bar({ id: "b1", selected: true })], { showVariantPicker: true, style: style("image") }), {
      product: SHIRT, variant: "21", extra: { options: SHIRT_SWATCHES },
    });
    expect(image.$('.cl-swatch[data-val="Blue"]')!.getAttribute("style")).toContain("https://cdn/blue.png");

    const variantImage = productPage(deal([bar({ id: "b1", selected: true })], { showVariantPicker: true, style: style("variant_image") }), {
      product: SHIRT, variant: "21", extra: { options: SHIRT_SWATCHES },
    });
    expect(variantImage.$('.cl-swatch[data-val="Blue"]')!.getAttribute("style")).toContain("https://cdn/s-blue.png");
  });

  test("single-bar picker only on quantity-1 bars, and only when switched on", () => {
    const on = productPage(deal([bar({ id: "b1", selected: true }), bar({ id: "b2", qty: 2 })], { showVariantPicker: true }), { product: SHIRT, variant: "21" });
    expect(on.document.querySelectorAll(".cl-variant-row")).toHaveLength(1);
    on.click('[data-bar="b2"]');
    expect(on.document.querySelectorAll(".cl-variant-row")).toHaveLength(0);
    const off = productPage(deal([bar({ id: "b1", selected: true })]), { product: SHIRT, variant: "21" });
    expect(off.document.querySelectorAll(".cl-variant-row")).toHaveLength(0);
  });

  test("default variants per unit; sold-out defaults are skipped", () => {
    const page = productPage(
      deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, dvar: [24, 22, 23] })], { variantPerUnit: true }),
      { product: SHIRT, variant: "21" },
    );
    page.click('[data-bar="b2"]');
    // 24 is sold out → units get 22 and 23.
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toEqual([
      { id: 22, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
      { id: 23, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
    ]);
  });

  test("the chosen variant sold out: the bar says so", () => {
    const page = productPage(deal([bar({ id: "b1", selected: true })]), { product: SHIRT, variant: "24" });
    expect(page.$(".cl-bar.is-soldout .cl-soldout")?.textContent).toBe("Sold out");
  });
});

describe("Phase 1: upsells, placement, events", () => {
  test("complementary products become upsell rows and are added with the upsell tag", async () => {
    const recommendations = [
      { id: 1, title: "Tee (itself)", variants: [{ id: 11, price: 2000, available: true }] },
      { id: 7, title: "Cap", featured_image: "https://cdn/cap.png", variants: [{ id: 70, price: 1200, available: true }] },
      { id: 8, title: "Sold out bag", variants: [{ id: 80, price: 900, available: false }] },
      { id: 9, title: "Belt", variants: [{ id: 90, price: 1500, available: true }] },
    ];
    const upsell = { id: "u1", source: "complementary", limit: 1, variant: 0, title: "", image: null, price: null, text: "Add {{product}} for {{price}}", dt: "percentage", dv: 25, checked: true, onlyWhenSelected: false };
    const page = productPage(deal([bar({ id: "b1", selected: true, upsells: [upsell] })]), { recommendations });
    await page.settle();
    expect(page.posts[0].url).toContain("recommendations/products.json?product_id=1&intent=complementary");
    const rows = page.document.querySelectorAll(".cl-upsell");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Add Cap for $9.00");
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toContainEqual({ id: 70, quantity: 1, properties: { _cartlift_upsell: "d1:u1" } });
  });

  test("<cartlift-bundle> in the product form is used as the placement", () => {
    const page = productPage(deal([bar({ id: "b1" })]), { inForm: '<cartlift-bundle product-id="1"></cartlift-bundle>' });
    expect(page.$("cartlift-bundle .cl-block")).not.toBeNull();
    expect(page.document.querySelectorAll(".cl-block")).toHaveLength(1);
  });

  test("variants-changed reports the lines and bundle price", () => {
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 3, dt: "percentage", dv: 20 })]));
    page.click('[data-bar="b2"]');
    const last = page.events.filter(([n]) => n === "cartlift:variants-changed").pop()?.[1];
    expect(last).toEqual({ dealId: "d1", barId: "b2", variantIdQuantities: { 11: 3 }, price: 4800, formattedPrice: "$48.00" });
  });
});

describe("Phase 2: gifts", () => {
  const gift = (id: number, title: string) => ({ id, title, image: `https://cdn/${id}.png`, price: "5.00", text: "+ FREE" });

  test("a bar with several gifts shows and adds each of them", () => {
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, selected: true, gifts: [gift(91, "Socks"), gift(92, "Cap")] })]));
    expect(page.document.querySelectorAll(".cl-bar.is-selected .cl-gift")).toHaveLength(2);
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toEqual([
      { id: 11, quantity: 2, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
      { id: 91, quantity: 1, properties: { _cartlift_gift: "d1" } },
      { id: 92, quantity: 1, properties: { _cartlift_gift: "d1" } },
    ]);
  });

  test("the gift track shows each tier's new gifts, unlocked up to the selected bar", () => {
    const page = productPage(
      deal(
        [
          bar({ id: "b1" }),
          bar({ id: "b2", qty: 2, selected: true, gifts: [gift(91, "Socks")] }),
          // Progressive: tier 3 carries tier 2's gift too; the track shows only what's new.
          bar({ id: "b3", qty: 3, gifts: [gift(91, "Socks"), gift(92, "Cap")] }),
        ],
        { style: { layout: "vertical", giftTrack: true } },
      ),
    );
    const steps = () => [...page.document.querySelectorAll(".cl-gt-step")].map((s) => [s.className.includes("is-unlocked"), s.querySelectorAll("img").length, s.querySelector(".cl-gt-label")?.textContent]);
    expect(steps()).toEqual([
      [true, 1, "Unlocked"],
      [false, 1, "Buy 3"],
    ]);
    page.click('[data-bar="b3"]');
    expect(steps()).toEqual([
      [true, 1, "Unlocked"],
      [true, 1, "Unlocked"],
    ]);
  });
});

describe("Phase 2: complete the bundle", () => {
  const bundleBar = bar({
    id: "set",
    kind: "bundle",
    qty: 2,
    title: "The set: {{price}}",
    selected: true,
    items: [
      { id: "i1", v: null, q: 1, dt: "none", dv: 0 },
      { id: "i2", v: 70, q: 1, dt: "percentage", dv: 25, title: "Cap", image: "https://cdn/cap.png", price: "20.00" },
    ],
  });

  test("prices the set per item and lists the items", () => {
    const page = productPage(deal([bar({ id: "b1" }), bundleBar]));
    // Tee $20 + cap $20 − 25% = $35; was $40.
    expect(page.$(".cl-bar.is-selected .cl-price")?.textContent).toBe("$35.00");
    expect(page.$(".cl-bar.is-selected .cl-full")?.textContent).toBe("$40.00");
    expect(page.$(".cl-bar.is-selected .cl-bar-title")?.textContent).toBe("The set: $35.00");
    expect([...page.document.querySelectorAll(".cl-bundle-item .cl-extra-text")].map((e) => e.textContent)).toEqual(["Tee — S", "Cap"]);
  });

  test("adds every item tagged for the bundle, the viewed product marked as main", () => {
    const page = productPage(deal([bar({ id: "b1" }), bundleBar]));
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toEqual([
      { id: 11, quantity: 1, properties: { _cartlift_bundle: "d1:set", _cartlift_arm: "A", _cartlift_main: "1" } },
      { id: 70, quantity: 1, properties: { _cartlift_bundle: "d1:set", _cartlift_arm: "A" } },
    ]);
  });
});

describe("Phase 2: mix & match", () => {
  const mm = { tt: "PRODUCTS", p: [7, 8], c: [], ph: ["cap", "belt"], ch: [], title: "Pick your items", button: "Add", names: true, photo: 64 };
  const store = {
    "/products/cap.js": { id: 7, title: "Cap", featured_image: "//cdn/cap.png", variants: [{ id: 70, title: "Default Title", price: 1200, available: true }] },
    "/products/belt.js": {
      id: 8,
      title: "Belt",
      featured_image: null,
      variants: [
        { id: 80, title: "S", price: 1500, available: true },
        { id: 81, title: "L", price: 1600, available: true },
      ],
    },
  };
  const mixDeal = deal([bar({ id: "b1" }), bar({ id: "b3", qty: 3, dt: "percentage", dv: 10, selected: true })], { mm, across: true });

  test("the selected bar has one slot per unit; the chooser fills a slot", async () => {
    const page = productPage(mixDeal, { store });
    const slots = page.document.querySelectorAll(".cl-bar.is-selected .cl-slot");
    expect(slots).toHaveLength(3);
    expect(slots[0].className).toContain("is-filled");
    page.click('.cl-slot[data-slot="1"]');
    expect(page.$(".cl-modal h2")?.textContent).toBe("Pick your items");
    await page.settle();
    expect([...page.document.querySelectorAll(".cl-pick-name")].map((n) => n.textContent)).toEqual(["Cap", "Belt"]);
    expect(page.$('.cl-pick[data-product="7"] img')?.getAttribute("src")).toBe("https://cdn/cap.png");
    page.click('.cl-pick[data-product="7"] .cl-pick-add');
    expect(page.$(".cl-modal")).toBeNull();
    expect(page.$('.cl-slot.is-filled .cl-slot-change[data-slot="1"]')).not.toBeNull();
  });

  test("with every slot picked, the price uses the picked products; lines add them", async () => {
    const page = productPage(mixDeal, { store });
    page.click('.cl-slot[data-slot="1"]');
    await page.settle();
    page.click('.cl-pick[data-product="7"] .cl-pick-add');
    page.click('.cl-slot[data-slot="2"]');
    await page.settle();
    page.choose('.cl-pick[data-product="8"] select', "81");
    page.click('.cl-pick[data-product="8"] .cl-pick-add');
    // $20 + $12 + $16 = $48, − 10% = $43.20.
    expect(page.$(".cl-bar.is-selected .cl-price")?.textContent).toBe("$43.20");
    expect(page.submit()).toBe(true);
    expect(page.added()?.items).toEqual([
      { id: 11, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
      { id: 70, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
      { id: 81, quantity: 1, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
    ]);
  });

  test("empty slots take the viewed product; the chooser searches and closes on Escape", async () => {
    const page = productPage(mixDeal, { store });
    expect(page.input("quantity")).toBe("3");
    expect(page.submit()).toBe(false); // one line (3 × the viewed product): the theme adds it
    page.click('.cl-slot[data-slot="1"]');
    await page.settle();
    const search = page.$(".cl-modal-search") as unknown as HTMLInputElement;
    search.value = "bel";
    search.dispatchEvent(new (page.document.defaultView as unknown as { Event: typeof Event }).Event("input"));
    expect([...page.document.querySelectorAll(".cl-pick-name")].map((n) => n.textContent)).toEqual(["Belt"]);
    const view = page.document.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent };
    page.document.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape" }) as never);
    expect(page.$(".cl-modal")).toBeNull();
  });
});

describe("Phase 3: A/B arms and tracking", () => {
  const abDeal = deal([bar({ id: "a1" }), bar({ id: "a2", qty: 2, dt: "percentage", dv: 10, selected: true })], {
    weightA: 50,
    arms: [{ key: "B", weight: 50, bars: [bar({ id: "b3", qty: 3, dt: "percentage", dv: 20, selected: true, title: "Three" })], style: { layout: "grid" } }],
  });

  test("a visitor in arm B sees B's bars and style, and lines carry the arm", () => {
    const page = productPage(abDeal, { storage: { cartlift_arm_d1: "B" } });
    expect([...page.document.querySelectorAll(".cl-bar")].map((b) => b.getAttribute("data-bar"))).toEqual(["b3"]);
    expect(page.$(".cl-block")?.className).toContain("cl-layout-grid");
    expect(page.input("properties[_cartlift_arm]")).toBe("B");
    expect(page.input("quantity")).toBe("3");
  });

  test("arm A keeps the deal; the seen deal is remembered with its arm", () => {
    const page = productPage(abDeal, { storage: { cartlift_arm_d1: "A" } });
    expect([...page.document.querySelectorAll(".cl-bar")].map((b) => b.getAttribute("data-bar"))).toEqual(["a1", "a2"]);
    const seen = JSON.parse((page.document.defaultView as unknown as { localStorage: Storage }).localStorage.getItem("cartlift_seen") || "{}");
    expect(seen).toEqual({ d1: "A" });
  });
});

describe("Phase 4: design", () => {
  const savings = (o: Json = {}) => ({
    enabled: true, text: "You save {{saved_amount}} ({{saved_percentage}})", includeGifts: true,
    background: "#eeeeee", textColor: "#111111", valueColor: "#0f7a3a", border: true, icon: true, align: "left", size: 15, ...o,
  });
  const gift = { id: 91, title: "Socks", image: null, price: "5.00", text: "+ FREE" };

  test("savings summary: the selected bar's saving plus gifts and ticked upsells", () => {
    const upsell = { id: "u1", variant: 777, title: "Cap", image: null, price: "10.00", text: "Cap", dt: "percentage", dv: 50, checked: true, onlyWhenSelected: false };
    const page = productPage(
      deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true, gifts: [gift], upsells: [upsell] })], {
        style: { layout: "vertical", savingsBar: savings() },
      }),
    );
    // $4 off the bar + $5 gift + $5 off the cap = $14 of $40 + $5 + $10 = 25%.
    const bar2 = page.$(".cl-savings");
    expect(bar2?.textContent).toBe("✓You save $14.00 (25%)");
    expect(bar2?.className).toContain("cl-savings--left");
    expect(bar2?.className).toContain("cl-savings--border");
    expect(bar2?.getAttribute("style")).toContain("--cl-sb-value:#0f7a3a");
    page.click('[data-bar="b1"]');
    // Single bar, no discount, no gift: no saving, no bar.
    expect(page.$(".cl-savings")).toBeNull();
  });

  test("savings summary: gifts left out when asked; off by default", () => {
    const on = productPage(
      deal([bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true, gifts: [gift] })], {
        style: { layout: "vertical", savingsBar: savings({ includeGifts: false, text: "{{saved_amount}}" }) },
      }),
    );
    expect(on.$(".cl-savings")?.textContent).toBe("✓$4.00");
    const off = productPage(deal([bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true })]));
    expect(off.$(".cl-savings")).toBeNull();
  });

  test("plain layout and style variables", () => {
    const page = productPage(
      deal([bar({ id: "b1" })], {
        style: { layout: "plain", barGap: 4, borderWidth: 0, titleWeight: 600, priceSize: 20, colors: { giftBg: "#fafafa", upsellBorder: "" } },
      }),
    );
    const block = page.$(".cl-block")!;
    expect(block.className).toContain("cl-layout-plain");
    const css = block.getAttribute("style")!;
    expect(css).toContain("--cl-bar-gap:4px");
    expect(css).toContain("--cl-border-width:0px");
    expect(css).toContain("--cl-title-weight:600");
    expect(css).toContain("--cl-price-size:20px");
    expect(css).toContain("--cl-gift-bg:#fafafa");
    expect(css).not.toContain("--cl-upsell-border");
  });

  test("deal CSS is scoped to the deal and can't close its style element", () => {
    const page = productPage(deal([bar({ id: "b1" })], { style: { layout: "vertical", customCss: ".cl-bar{color:red}</style><b id=x>" } }));
    const style = page.$('style[data-cartlift-css="d1"]')!;
    expect(style.textContent).toBe('.cl-block[data-deal="d1"]{.cl-bar{color:red}<' + "\\" + '/style><b id=x>}');
    expect(page.$("b#x")).toBeNull();
  });

  test("custom HTML: as written on the store, without scripts in the admin preview", () => {
    const html = '<p class="note">Ships today</p><img src=x onerror="alert(1)"><a href="javascript:alert(2)">x</a><script>alert(3)</script>';
    const d = deal([bar({ id: "b1" })], { style: { layout: "vertical", htmlAbove: html } });
    const store = productPage(d);
    expect(store.$(".cl-html--above p.note")?.textContent).toBe("Ships today");
    expect(store.$(".cl-html--above script")).not.toBeNull();

    // The admin preview (window.CartLift.preview) strips them.
    const view = store.document.defaultView as unknown as {
      CartLift: { preview: (el: unknown, deal: unknown, ctx: unknown) => void };
      document: Document;
    };
    const el = view.document.createElement("div");
    view.CartLift.preview(el, d, { product: TEE, moneyFormat: "${{amount}}", rate: 1 });
    expect(el.querySelector(".cl-html--above p.note")?.textContent).toBe("Ships today");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(el.querySelector("a")?.getAttribute("href")).toBeNull();
  });
});
