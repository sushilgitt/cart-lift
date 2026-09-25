import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../shopify.server";
import { markUninstalled } from "../lib/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Deals and stats are kept so a re-install picks up where the merchant left
  // off; shop/redact (48h later) is what deletes them.
  await markUninstalled(shop);
  return new Response();
};
