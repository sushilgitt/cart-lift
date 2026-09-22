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

/** A product page with a Dawn-like form, the widget's data block and the built widget. */
function productPage(deal: Record<string, unknown>) {
  const window = new Window({ url: "https://shop.test/products/tee" });
  const document = window.document;
  const posts: { url: string; body: unknown }[] = [];
  const themeSubmits: number[] = [];
  Object.assign(window, {
    fetch: async (url: string, init?: { body?: string }) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ items: [] }) };
    },
    Shopify: { currency: { rate: "1.0" }, routes: { root: "/" } },
    alert: () => {},
  });
  (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;
  document.body.innerHTML = `
    <section class="shopify-section">
      <form action="/cart/add" class="product-form">
        <input type="hidden" name="id" value="11">
        <div class="product-form__quantity"><input name="quantity" value="1"></div>
        <div class="product-form__buttons"><button type="submit" name="add">Add</button><div class="shopify-payment-button"></div></div>
      </form>
    </section>`;
  const product = {
    id: 1,
    title: "Tee",
    variants: [
      { id: 11, title: "S", price: 2000, compare_at_price: null, available: true },
      { id: 12, title: "M", price: 2000, compare_at_price: null, available: true },
    ],
  };
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
  });
  document.body.appendChild(data);
  const form = document.querySelector("form")!;
  form.addEventListener("submit", () => themeSubmits.push(1));
  window.eval(asset("cartlift.js"));

  const input = (name: string) =>
    (form.querySelector(`[name="${name}"]`) as unknown as { value: string } | null)?.value;
  const click = (barId: string) =>
    document.querySelector(`[data-bar="${barId}"]`)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const submit = () => {
    const event = new window.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { document, input, click, submit, posts, themeSubmits };
}

const bar = (o: Record<string, unknown>) => ({
  kind: "qty", qty: 1, get: 0, dt: "none", dv: 0, title: "Bar", subtitle: "", label: "", badge: "",
  badgeStyle: "simple", selected: false, gift: null, upsells: [], ...o,
});
const deal = (bars: unknown[], o: Record<string, unknown> = {}) => ({
  id: "d1", name: "Deal", type: "QUANTITY_BREAK", tt: "ALL", p: [], c: [], s: null, e: null,
  across: false, variantPerUnit: false, style: { layout: "vertical", showUnitPrice: true }, bars, ...o,
});

describe("storefront widget", () => {
  test("renders the bars with prices and drives the theme form", () => {
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true })]));
    expect(page.document.querySelectorAll(".cl-bar")).toHaveLength(2);
    expect(page.document.querySelector(".cl-bar.is-selected .cl-price")?.textContent).toBe("$36.00");
    expect(page.input("quantity")).toBe("2");
    expect(page.input("properties[_cartlift]")).toBe("d1");
    expect(page.input("properties[_cartlift_bar]")).toBeUndefined();
    page.click("b1");
    expect(page.input("quantity")).toBe("1");
    // A single line goes through the theme's own add to cart.
    expect(page.submit()).toBe(false);
    expect(page.themeSubmits).toHaveLength(1);
  });

  test("tags the bar only when two bars share a quantity", () => {
    const page = productPage(
      deal([bar({ id: "b1" }), bar({ id: "plain", qty: 2, dt: "percentage", dv: 10 }), bar({ id: "gifted", qty: 2, dt: "percentage", dv: 10 })]),
    );
    page.click("gifted");
    expect(page.input("properties[_cartlift_bar]")).toBe("gifted");
  });

  test("a gift makes it a multi-line add posted by the widget", () => {
    const gift = { id: 555, title: "Socks", image: null, price: "5.00", text: "+ FREE gift" };
    const page = productPage(deal([bar({ id: "b1" }), bar({ id: "b2", qty: 2, gift, selected: true })]));
    expect(page.submit()).toBe(true);
    expect(page.themeSubmits).toHaveLength(0);
    const add = page.posts.find((p) => p.url.endsWith("cart/add.js"));
    expect(add?.body).toEqual({
      items: [
        { id: 11, quantity: 2, properties: { _cartlift: "d1", _cartlift_arm: "A" } },
        { id: 555, quantity: 1, properties: { _cartlift_gift: "d1" } },
      ],
    });
  });

  test("escapes merchant text", () => {
    const page = productPage(deal([bar({ id: "b1", title: "<img src=x onerror=alert(1)>" })]));
    expect(page.document.querySelector("img[src=x]")).toBeNull();
    expect(page.document.querySelector(".cl-bar-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
