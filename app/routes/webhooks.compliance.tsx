import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Mandatory compliance webhooks: /webhooks/compliance
 *
 * CartLift stores no customer data — deal stats are aggregates and DealOrder
 * holds an order id and amounts only — so the customer topics have nothing to
 * return or delete. shop/redact removes everything the shop owns.
 *
 * `authenticate.webhook` verifies the HMAC; unsigned review probes get a 401.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  try {
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
