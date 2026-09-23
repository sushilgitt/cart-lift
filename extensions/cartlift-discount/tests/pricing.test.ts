import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun, type FnConfig } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass } from "../generated/api";
import { priceBar } from "../../../packages/core/src";

type LineSpec = {
  id?: string;
  product?: string;
  variant?: string;
  qty: number;
  price: number;
  deal?: string;
  arm?: string;
  bar?: string;
  gift?: string;
  upsell?: string;
  bundle?: string;
  collections?: string[];
  /** Search & Discovery complementary product GIDs of this line's product. */
  complementary?: string[];
  /** The line is a subscription: it carries a selling plan. */
  plan?: string;
};

function input(config: FnConfig, lines: LineSpec[], rate = 1, country = "US") {
  const ids = config.collectionIds ?? [];
  return {
    presentmentCurrencyRate: String(rate),
    localization: { country: { isoCode: country } },
    cart: {
      lines: lines.map((l, i) => ({
        id: l.id ?? `gid://shopify/CartLine/${i + 1}`,
        quantity: l.qty,
        cost: { amountPerQuantity: { amount: String(l.price) } },
        deal: l.deal ? { value: l.deal } : null,
        arm: l.arm ? { value: l.arm } : null,
        bar: l.bar ? { value: l.bar } : null,
        gift: l.gift ? { value: l.gift } : null,
        upsell: l.upsell ? { value: l.upsell } : null,
        bundle: l.bundle ? { value: l.bundle } : null,
        sellingPlanAllocation: l.plan ? { sellingPlan: { id: l.plan } } : null,
        merchandise: {
          __typename: "ProductVariant",
          id: l.variant ?? `gid://shopify/ProductVariant/${i + 1}`,
          product: {
            id: l.product ?? "gid://shopify/Product/1",
            inCollections: ids.map((c) => ({
              collectionId: c,
              isMember: (l.collections ?? []).includes(c),
            })),
            complementary: l.complementary ? { value: JSON.stringify(l.complementary) } : null,
          },
        },
      })),
    },
    discount: {
      discountClasses: [DiscountClass.Product],
      metafield: { jsonValue: config },
    },
  } as never;
}

const tiers = (extra: Partial<NonNullable<FnConfig["deals"]>[number]> = {}): FnConfig => ({
  deals: [
    {
      id: "d1",
      tt: "ALL",
      name: "Bundle & save",
      bars: [
        { id: "b1", q: 1, k: "q", dt: "none", dv: 0 },
        { id: "b2", q: 2, k: "q", dt: "percentage", dv: 10, m: "Buy 2, save 10%" },
        { id: "b3", q: 3, k: "q", dt: "percentage", dv: 20, m: "Buy 3, save 20%" },
      ],
      ...extra,
    },
  ],
});

const candidates = (r: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r.operations[0] as any)?.productDiscountsAdd?.candidates ?? [];

describe("quantity breaks", () => {
  test("no discount below the first discounted bar", () => {
    expect(cartLinesDiscountsGenerateRun(input(tiers(), [{ qty: 1, price: 10 }])).operations).toEqual([]);
  });

  test("highest reached bar wins, counted across variants of one product", () => {
    const r = cartLinesDiscountsGenerateRun(
      input(tiers(), [
        { qty: 2, price: 10 },
        { qty: 2, price: 10, variant: "gid://shopify/ProductVariant/9" },
      ]),
    );
    const c = candidates(r);
    expect(c).toHaveLength(1);
    expect(c[0].message).toBe("Buy 3, save 20%");
    expect(c[0].value).toEqual({ percentage: { value: 20 } });
    expect(c[0].targets).toHaveLength(2);
  });

  test("different products count separately unless `across`", () => {
    const lines = [
      { qty: 1, price: 10, product: "gid://shopify/Product/1" },
      { qty: 1, price: 10, product: "gid://shopify/Product/2" },
    ];
    expect(candidates(cartLinesDiscountsGenerateRun(input(tiers(), lines)))).toHaveLength(0);
    const across = candidates(cartLinesDiscountsGenerateRun(input(tiers({ across: true }), lines)));
    expect(across[0].value).toEqual({ percentage: { value: 10 } });
  });

  test("fixed total price converts with the presentment rate", () => {
    const config = tiers();
    config.deals![0].bars[1] = { id: "b2", q: 2, k: "q", dt: "fixed_total", dv: 15 };
    // 2 × 20 (presentment) = 40; target 15 × 2 (rate) = 30 → 10 off
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 20 }], 2)));
    expect(c[0].value).toEqual({ fixedAmount: { amount: 10 } });
  });

  test("amount off applies to each item", () => {
    const config = tiers();
    config.deals![0].bars[1] = { id: "b2", q: 2, k: "q", dt: "amount", dv: 3 };
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 20 }])));
    expect(c[0].value).toEqual({ fixedAmount: { amount: 3, appliesToEachItem: true } });
  });

  test("targeting: products, except and collections", () => {
    const only = tiers({ tt: "PRODUCTS", p: ["gid://shopify/Product/7"] });
    expect(candidates(cartLinesDiscountsGenerateRun(input(only, [{ qty: 2, price: 10 }])))).toHaveLength(0);
    expect(
      candidates(
        cartLinesDiscountsGenerateRun(input(only, [{ qty: 2, price: 10, product: "gid://shopify/Product/7" }])),
      ),
    ).toHaveLength(1);

    const except = tiers({ tt: "EXCEPT", p: ["gid://shopify/Product/1"] });
    expect(candidates(cartLinesDiscountsGenerateRun(input(except, [{ qty: 2, price: 10 }])))).toHaveLength(0);

    const col = { ...tiers({ tt: "COLLECTIONS", c: ["gid://shopify/Collection/5"] }), collectionIds: ["gid://shopify/Collection/5"] };
    expect(
      candidates(cartLinesDiscountsGenerateRun(input(col, [{ qty: 2, price: 10, collections: ["gid://shopify/Collection/5"] }]))),
    ).toHaveLength(1);
    expect(candidates(cartLinesDiscountsGenerateRun(input(col, [{ qty: 2, price: 10 }])))).toHaveLength(0);
  });

  test("A/B arm bars are used when the line carries the arm", () => {
    const config = tiers({
      arms: { B: [{ id: "x2", q: 2, k: "q", dt: "percentage", dv: 25 }] },
    });
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10, arm: "B" }])));
    expect(c[0].value).toEqual({ percentage: { value: 25 } });
  });
});

describe("bars sharing a quantity", () => {
  const twin: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "ALL",
        name: "Twin",
        bars: [
          { id: "b1", q: 1, k: "q", dt: "none", dv: 0 },
          { id: "plain", q: 2, k: "q", dt: "percentage", dv: 10, m: "2-pack" },
          { id: "gifted", q: 2, k: "q", dt: "percentage", dv: 10, m: "2-pack + gift", gift: "gid://shopify/ProductVariant/99" },
        ],
      },
    ],
  };
  const gift = { qty: 1, price: 5, product: "gid://shopify/Product/9", variant: "gid://shopify/ProductVariant/99", gift: "d1" };
  const isFree = (c: { targets: { cartLine: { id: string } }[] }[], id: string) =>
    c.some((x) => x.targets[0].cartLine.id === id);

  test("the tagged bar decides the gift and the message", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(twin, [{ qty: 2, price: 10, bar: "gifted" }, gift])));
    expect(c[0].message).toBe("2-pack + gift");
    expect(isFree(c, "gid://shopify/CartLine/2")).toBe(true);
  });

  test("the other bar's gift is not free", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(twin, [{ qty: 2, price: 10, bar: "plain" }, gift])));
    expect(c[0].message).toBe("2-pack");
    expect(isFree(c, "gid://shopify/CartLine/2")).toBe(false);
  });

  test("untagged lines use the first bar in editor order", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(twin, [{ qty: 2, price: 10 }, gift])));
    expect(c[0].message).toBe("2-pack");
    expect(c[0].value).toEqual({ percentage: { value: 10 } });
  });

  test("a tag for a bar not reached falls back to the reached one", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(twin, [{ qty: 3, price: 10, bar: "b1" }])));
    expect(c[0].message).toBe("2-pack");
  });
});

describe("buy X get Y", () => {
  const bogo: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "ALL",
        name: "BOGO",
        bars: [{ id: "b1", q: 2, k: "x", g: 1, dt: "percentage", dv: 100, m: "Buy 1 get 1 free" }],
      },
    ],
  };

  test("discounts the cheapest units, one per complete set", () => {
    const c = candidates(
      cartLinesDiscountsGenerateRun(
        input(bogo, [
          { qty: 3, price: 30 },
          { qty: 2, price: 20, variant: "gid://shopify/ProductVariant/9" },
        ]),
      ),
    );
    // 5 units → 2 sets → 2 free units, both on the $20 line.
    expect(c).toHaveLength(1);
    expect(c[0].targets[0].cartLine.quantity).toBe(2);
    expect(c[0].value).toEqual({ percentage: { value: 100 } });
  });
});

describe("gifts and upsells", () => {
  const config: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "PRODUCTS",
        p: ["gid://shopify/Product/1"],
        name: "Deal",
        bars: [
          { id: "b1", q: 1, k: "q", dt: "none", dv: 0, ups: [{ id: "u1", v: "gid://shopify/ProductVariant/88", dt: "percentage", dv: 50 }] },
          { id: "b2", q: 2, k: "q", dt: "percentage", dv: 10, gift: "gid://shopify/ProductVariant/99" },
        ],
      },
    ],
  };
  const gift = { qty: 1, price: 5, product: "gid://shopify/Product/9", variant: "gid://shopify/ProductVariant/99", gift: "d1" };
  const upsell = { qty: 1, price: 8, product: "gid://shopify/Product/8", variant: "gid://shopify/ProductVariant/88", upsell: "d1:u1" };

  test("gift is free only once its bar is reached", () => {
    const low = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 1, price: 10 }, gift])));
    expect(low.find((c: { value: unknown }) => JSON.stringify(c.value).includes("100"))).toBeUndefined();
    const high = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10 }, gift])));
    expect(high.some((c: { targets: { cartLine: { id: string } }[] }) => c.targets[0].cartLine.id.endsWith("/2"))).toBe(true);
  });

  test("upsell discount needs the deal product in the cart", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [upsell])))).toHaveLength(0);
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 1, price: 10 }, upsell])));
    expect(c).toHaveLength(1);
    expect(c[0].value).toEqual({ percentage: { value: 50 } });
  });

  test("upsell tag on another product gets no discount", () => {
    const foreign = { ...upsell, product: "gid://shopify/Product/500", variant: "gid://shopify/ProductVariant/500", price: 300 };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 1, price: 10 }, foreign])))).toHaveLength(0);
  });

  test("only one upsell unit is discounted, across lines too", () => {
    const c = candidates(
      cartLinesDiscountsGenerateRun(input(config, [{ qty: 1, price: 10 }, { ...upsell, qty: 3 }, { ...upsell, qty: 1 }])),
    );
    expect(c).toHaveLength(1);
    expect(c[0].targets).toEqual([{ cartLine: { id: "gid://shopify/CartLine/2", quantity: 1 } }]);
  });

  test("config without the upsell variant fails closed", () => {
    const old = structuredClone(config);
    delete old.deals![0].bars[0].ups![0].v;
    expect(candidates(cartLinesDiscountsGenerateRun(input(old, [{ qty: 1, price: 10 }, upsell])))).toHaveLength(0);
  });

  test("amount and fixed-price upsells discount one unit, never below zero", () => {
    const withUp = (dt: "amount" | "fixed_total", dv: number) => {
      const c = structuredClone(config);
      c.deals![0].bars[0].ups = [{ id: "u1", v: "gid://shopify/ProductVariant/88", dt, dv }];
      return c;
    };
    // $3 off an $8 upsell.
    let c = candidates(cartLinesDiscountsGenerateRun(input(withUp("amount", 3), [{ qty: 1, price: 10 }, { ...upsell, qty: 2 }])));
    expect(c[0].value).toEqual({ fixedAmount: { amount: 3 } });
    expect(c[0].targets[0].cartLine.quantity).toBe(1);
    // $20 off an $8 upsell is capped at $8.
    c = candidates(cartLinesDiscountsGenerateRun(input(withUp("amount", 20), [{ qty: 1, price: 10 }, upsell])));
    expect(c[0].value).toEqual({ fixedAmount: { amount: 8 } });
    // Fixed price $5 for an $8 upsell → $3 off.
    c = candidates(cartLinesDiscountsGenerateRun(input(withUp("fixed_total", 5), [{ qty: 1, price: 10 }, upsell])));
    expect(c[0].value).toEqual({ fixedAmount: { amount: 3 } });
  });
});

describe("buy X get Y with an extra percentage", () => {
  const deal = (xp: number): FnConfig => ({
    deals: [
      {
        id: "d1",
        tt: "ALL",
        name: "B3G1",
        bars: [{ id: "b1", q: 4, k: "x", g: 1, dt: "percentage", dv: 100, xp, m: "Buy 3 get 1 + 10%" }],
      },
    ],
  });
  const off = (c: { value: { fixedAmount?: { amount: number }; percentage?: { value: number } } }[], lines: { qty: number; price: number }[]) =>
    c.reduce((sum, x, i) => sum + (x.value.fixedAmount?.amount ?? (lines[i].price * lines[i].qty * (x.value.percentage?.value ?? 0)) / 100), 0);

  test("without it, output is the classic free-unit discount", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(deal(0), [{ qty: 4, price: 20 }])));
    expect(c).toEqual([
      { message: "Buy 3 get 1 + 10%", targets: [{ cartLine: { id: "gid://shopify/CartLine/1", quantity: 1 } }], value: { percentage: { value: 100 } } },
    ]);
  });

  test("free unit plus 10% off the rest, as one amount per line — matching the widget price", () => {
    const lines = [{ qty: 4, price: 20 }];
    const c = candidates(cartLinesDiscountsGenerateRun(input(deal(10), lines)));
    // 4 × $20 = $80; one free ($20) → $60; 10% off → $54. $26 off.
    expect(c).toEqual([
      { message: "Buy 3 get 1 + 10%", targets: [{ cartLine: { id: "gid://shopify/CartLine/1" } }], value: { fixedAmount: { amount: 26 } } },
    ]);
    const shown = priceBar({ kind: "bxgy", qty: 4, get: 1, dt: "percentage", dv: 100, xp: 10 }, 2000);
    expect(shown.total).toBe(5400);
  });

  test("the cheapest unit is the free one across lines", () => {
    const lines = [
      { qty: 3, price: 30 },
      { qty: 1, price: 10, variant: "gid://shopify/ProductVariant/9" },
    ];
    const c = candidates(cartLinesDiscountsGenerateRun(input(deal(10), lines)));
    // $90 + $10; the $10 unit is free; 10% off $90 → $9. $19 off in total.
    expect(Math.round(off(c, lines) * 100) / 100).toBe(19);
  });
});

describe("complementary upsells", () => {
  const config: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "PRODUCTS",
        p: ["gid://shopify/Product/1"],
        name: "Deal",
        bars: [{ id: "b1", q: 1, k: "q", dt: "none", dv: 0, ups: [{ id: "u1", c: 1, l: 2, dt: "percentage", dv: 20 }] }],
      },
    ],
  };
  const main = { qty: 1, price: 10, complementary: ["gid://shopify/Product/7", "gid://shopify/Product/8"] };
  const up = (product: number, qty = 1) => ({
    qty,
    price: 10,
    product: `gid://shopify/Product/${product}`,
    variant: `gid://shopify/ProductVariant/${product}0`,
    upsell: "d1:u1",
  });

  test("discounts a product listed as complementary to a deal product in the cart", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [main, up(7, 3)])));
    expect(c).toEqual([{ message: "Deal", targets: [{ cartLine: { id: "gid://shopify/CartLine/2", quantity: 1 } }], value: { percentage: { value: 20 } } }]);
  });

  test("not a product that isn't complementary, nor when the list is missing", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [main, up(500)])))).toHaveLength(0);
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 1, price: 10 }, up(7)])))).toHaveLength(0);
  });

  test("at most `limit` different products, one unit each", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [main, up(7), up(8), up(7)])));
    expect(c.map((x: { targets: { cartLine: { id: string } }[] }) => x.targets[0].cartLine.id)).toEqual([
      "gid://shopify/CartLine/2",
      "gid://shopify/CartLine/3",
    ]);
  });
});

type Cand = { message: string; targets: { cartLine: { id: string; quantity?: number } }[]; value: { percentage?: { value: number }; fixedAmount?: { amount: number } } };
const line = (n: number) => `gid://shopify/CartLine/${n}`;
const onLine = (c: Cand[], n: number) => c.filter((x) => x.targets[0].cartLine.id === line(n));

describe("progressive gifts", () => {
  const config: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "ALL",
        name: "Gifts",
        bars: [
          { id: "b1", q: 1, k: "q", dt: "none", dv: 0 },
          { id: "b2", q: 2, k: "q", dt: "none", dv: 0, gifts: ["gid://shopify/ProductVariant/91"] },
          { id: "b3", q: 3, k: "q", dt: "none", dv: 0, gifts: ["gid://shopify/ProductVariant/91", "gid://shopify/ProductVariant/92"] },
        ],
      },
    ],
  };
  const gift = (v: number) => ({ qty: 1, price: 5, product: `gid://shopify/Product/${v}`, variant: `gid://shopify/ProductVariant/${v}`, gift: "d1" });

  test("every gift of the reached bar is free; the next tier's are not yet", () => {
    const two = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10 }, gift(91), gift(92)]))) as Cand[];
    expect(onLine(two, 2)).toHaveLength(1);
    expect(onLine(two, 3)).toHaveLength(0);
    const three = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 3, price: 10 }, gift(91), gift(92)]))) as Cand[];
    expect(onLine(three, 2)).toHaveLength(1);
    expect(onLine(three, 3)).toHaveLength(1);
  });

  test("an older config with a single `gift` still works", () => {
    const old: FnConfig = { deals: [{ id: "d1", tt: "ALL", name: "Old", bars: [{ id: "b1", q: 2, k: "q", dt: "none", dv: 0, gift: "gid://shopify/ProductVariant/91" }] }] };
    expect(onLine(candidates(cartLinesDiscountsGenerateRun(input(old, [{ qty: 2, price: 10 }, gift(91)]))) as Cand[], 2)).toHaveLength(1);
  });
});

describe("complete the bundle", () => {
  const config: FnConfig = {
    deals: [
      {
        id: "d1",
        tt: "PRODUCTS",
        p: ["gid://shopify/Product/1"],
        name: "Look",
        bars: [
          { id: "b1", q: 1, k: "q", dt: "none", dv: 0 },
          { id: "b2", q: 2, k: "q", dt: "percentage", dv: 10 },
          {
            id: "set",
            q: 3,
            k: "b",
            dt: "none",
            dv: 0,
            m: "Complete the look",
            gifts: ["gid://shopify/ProductVariant/99"],
            it: [
              { v: null, q: 1, dt: "none", dv: 0 },
              { v: "gid://shopify/ProductVariant/70", q: 1, dt: "percentage", dv: 25 },
              { v: "gid://shopify/ProductVariant/80", q: 1, dt: "fixed_total", dv: 5 },
            ],
          },
        ],
      },
    ],
  };
  const main = (qty = 1) => ({ qty, price: 40, bundle: "d1:set" });
  const cap = (qty = 1) => ({ qty, price: 20, product: "gid://shopify/Product/7", variant: "gid://shopify/ProductVariant/70", bundle: "d1:set" });
  const belt = (qty = 1) => ({ qty, price: 15, product: "gid://shopify/Product/8", variant: "gid://shopify/ProductVariant/80", bundle: "d1:set" });

  test("a complete set discounts each item by its own rule", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [main(), cap(), belt()]))) as Cand[];
    expect(onLine(c, 1)).toHaveLength(0); // main item: no discount
    expect(onLine(c, 2)).toEqual([{ message: "Complete the look", targets: [{ cartLine: { id: line(2), quantity: 1 } }], value: { percentage: { value: 25 } } }]);
    // Belt at a fixed $5: $10 off.
    expect(onLine(c, 3)[0].value).toEqual({ fixedAmount: { amount: 10 } });
  });

  test("an incomplete set gets nothing", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [main(), cap()])))).toHaveLength(0);
  });

  test("two sets, with a spare item left at full price", () => {
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [main(2), cap(3), belt(2)]))) as Cand[];
    expect(onLine(c, 2)[0].targets[0].cartLine.quantity).toBe(2);
    expect(onLine(c, 3)[0].value).toEqual({ fixedAmount: { amount: 20 } });
  });

  test("the main slot needs a product the deal targets; tags on other products do nothing", () => {
    const foreignMain = { qty: 1, price: 400, product: "gid://shopify/Product/500", variant: "gid://shopify/ProductVariant/500", bundle: "d1:set" };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [foreignMain, cap(), belt()])))).toHaveLength(0);
    const fakeItem = { qty: 1, price: 400, product: "gid://shopify/Product/600", variant: "gid://shopify/ProductVariant/600", bundle: "d1:set" };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [main(), fakeItem, belt()])))).toHaveLength(0);
  });

  test("bundle lines don't also climb the quantity tiers; a complete set unlocks its gift", () => {
    const gift = { qty: 1, price: 5, product: "gid://shopify/Product/9", variant: "gid://shopify/ProductVariant/99", gift: "d1" };
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [main(2), cap(), belt(), gift]))) as Cand[];
    // 2 × main as bundle lines: no 10% tier discount on line 1.
    expect(onLine(c, 1)).toHaveLength(0);
    expect(onLine(c, 4)[0].value).toEqual({ percentage: { value: 100 } });
  });
});

describe("mix & match pool", () => {
  const config: FnConfig = {
    collectionIds: ["gid://shopify/Collection/5"],
    deals: [
      {
        id: "d1",
        tt: "PRODUCTS",
        p: ["gid://shopify/Product/1"],
        across: true,
        mm: { tt: "COLLECTIONS", c: ["gid://shopify/Collection/5"] },
        name: "Mix",
        bars: [{ id: "b1", q: 3, k: "q", dt: "percentage", dv: 20, m: "Any 3, save 20%" }],
      },
    ],
  };

  test("pool products count toward the tiers together with the deal's products", () => {
    const lines = [
      { qty: 1, price: 10, deal: "d1" },
      { qty: 2, price: 12, product: "gid://shopify/Product/7", variant: "gid://shopify/ProductVariant/70", deal: "d1", collections: ["gid://shopify/Collection/5"] },
    ];
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, lines))) as Cand[];
    expect(c[0].message).toBe("Any 3, save 20%");
    expect(c[0].targets).toHaveLength(2);
  });

  test("products outside both don't count", () => {
    const lines = [
      { qty: 1, price: 10, deal: "d1" },
      { qty: 2, price: 12, product: "gid://shopify/Product/7", variant: "gid://shopify/ProductVariant/70", deal: "d1" },
    ];
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, lines)))).toHaveLength(0);
  });
});

describe("markets", () => {
  const config: FnConfig = {
    deals: [
      { id: "eu", tt: "ALL", ctry: ["DE", "FR"], name: "EU deal", bars: [{ id: "b", q: 2, k: "q", dt: "percentage", dv: 20, m: "EU" }] },
      { id: "all", tt: "ALL", name: "Everywhere", bars: [{ id: "b", q: 2, k: "q", dt: "percentage", dv: 10, m: "All" }] },
    ],
  };
  const two = [{ qty: 2, price: 10 }];

  test("a deal limited to markets applies only in their countries", () => {
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, two, 1, "DE")))[0].message).toBe("EU");
    // Outside its countries the next deal takes the line.
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, two, 1, "US")))[0].message).toBe("All");
  });

  test("unknown country: only unrestricted deals run", () => {
    const onlyEu: FnConfig = { deals: [config.deals![0]] };
    expect(candidates(cartLinesDiscountsGenerateRun(input(onlyEu, two, 1, "")))).toHaveLength(0);
  });
});

describe("subscriptions", () => {
  const PLAN = "gid://shopify/SellingPlan/5";
  const bars = (m = "Save 20%") => [{ id: "b2", q: 2, k: "q" as const, dt: "percentage" as const, dv: 20, m }];
  const deal = (sub?: "s" | "o", id = "d1", name = "Save 20%") => ({ id, tt: "ALL" as const, name, bars: bars(name), ...(sub ? { sub } : {}) });

  test("by default both one-time and subscription lines are priced", () => {
    const config: FnConfig = { deals: [deal()] };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10 }])))).toHaveLength(1);
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10, plan: PLAN }])))).toHaveLength(1);
  });

  test("subscription-only: one-time lines are left alone", () => {
    const config: FnConfig = { deals: [deal("s")] };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10, plan: PLAN }])))[0].message).toBe("Save 20%");
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10 }])))).toHaveLength(0);
  });

  test("one-time only: subscription lines are left alone", () => {
    const config: FnConfig = { deals: [deal("o")] };
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10 }])))[0].message).toBe("Save 20%");
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10, plan: PLAN }])))).toHaveLength(0);
  });

  test("a line the widget tagged for a deal that skips its purchase type falls to the next deal", () => {
    const config: FnConfig = { deals: [deal("o", "onetime", "One-time"), deal(undefined, "any", "Anything")] };
    const c = candidates(cartLinesDiscountsGenerateRun(input(config, [{ qty: 2, price: 10, plan: PLAN, deal: "onetime" }])));
    expect(c[0].message).toBe("Anything");
  });

  test("the two kinds don't fill one tier together", () => {
    const config: FnConfig = { deals: [deal("s")] };
    const mixed = [{ qty: 1, price: 10, plan: PLAN }, { qty: 1, price: 10 }];
    expect(candidates(cartLinesDiscountsGenerateRun(input(config, mixed)))).toHaveLength(0);
  });
});
