import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[]);

vi.mock("../db.server", () => ({
  default: {
    dealOrder: {
      deleteMany: async (args: unknown) => {
        calls.push(args);
        return { count: 2 };
      },
    },
  },
}));

import { redactOrders } from "./shop.server";

describe("customers/redact", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test("deletes the listed orders for that shop only, numeric or GID", async () => {
    await redactOrders("a.myshopify.com", [123, "gid://shopify/Order/456"]);
    expect(calls).toEqual([
      {
        where: {
          shop: { domain: "a.myshopify.com" },
          OR: [
            { orderId: "123" },
            { orderId: { endsWith: "/123" } },
            { orderId: "456" },
            { orderId: { endsWith: "/456" } },
          ],
        },
      },
    ]);
  });

  test("no orders, or nothing that looks like an id: nothing is deleted", async () => {
    expect(await redactOrders("a.myshopify.com", [])).toBe(0);
    expect(await redactOrders("a.myshopify.com", undefined)).toBe(0);
    expect(await redactOrders("a.myshopify.com", ["", "abc", null])).toBe(0);
    expect(calls).toEqual([]);
  });
});
