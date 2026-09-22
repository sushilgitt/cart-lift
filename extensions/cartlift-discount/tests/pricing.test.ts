import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun, type FnConfig } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass } from "../generated/api";

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
  collections?: string[];
};

function input(config: FnConfig, lines: LineSpec[], rate = 1) {
  const ids = config.collectionIds ?? [];
  return {
    presentmentCurrencyRate: String(rate),
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
        merchandise: {
          __typename: "ProductVariant",
          id: l.variant ?? `gid://shopify/ProductVariant/${i + 1}`,
          product: {
            id: l.product ?? "gid://shopify/Product/1",
            inCollections: ids.map((c) => ({
              collectionId: c,
              isMember: (l.collections ?? []).includes(c),
            })),
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
