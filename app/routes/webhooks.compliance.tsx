import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { redactOrders } from "../lib/shop.server";

/**
 * Mandatory compliance webhooks: /webhooks/compliance
 *
 * CartLift stores no customer data — deal stats are aggregates and DealOrder
 * holds an order id and amounts only — so customers/data_request has nothing
 * to return. customers/redact still deletes the DealOrder rows of the listed
 * orders, as the privacy policy promises. shop/redact removes everything the
 * shop owns.
 *
 * `authenticate.webhook` verifies the HMAC; unsigned review probes get a 401.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  try {
    if (topic === "CUSTOMERS_REDACT") {
      const removed = await redactOrders(shop, (payload as { orders_to_redact?: unknown }).orders_to_redact);
      console.log(`Redacted ${removed} order records for ${shop}`);
    }
    if (topic === "SHOP_REDACT") {
      await prisma.shop.deleteMany({ where: { domain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
    }
    console.log(`Handled ${topic} for ${shop}`);
  } catch (error) {
    console.error(`Compliance webhook ${topic} failed for ${shop}`, error);
    return new Response("Compliance handler error", { status: 500 });
  }
  return new Response();
};

export const loader = () => new Response("Method not allowed", { status: 405 });
