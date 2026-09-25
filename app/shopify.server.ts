import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureShop } from "./lib/shop.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  hooks: {
    // Runs inside authenticate.admin when a store installs (or reinstalls),
    // before any page loader reads the shop row — loaders run in parallel, so
    // provisioning only in the layout loader left the first page open to a race.
    afterAuth: async ({ session }) => {
      await ensureShop(session.shop);
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
const authenticateAdmin: typeof shopify.authenticate.admin = async (request) => {
  try {
    return await shopify.authenticate.admin(request);
  } catch (error) {
    // A malformed `host` query parameter makes the library's URL parsing
    // throw; that is a bad request, not a server error.
    if ((error as { code?: string }).code === "ERR_INVALID_URL") {
      throw new Response("Bad request", { status: 400 });
    }
    throw error;
  }
};

export const authenticate = { ...shopify.authenticate, admin: authenticateAdmin };

/**
 * `authenticate.webhook` that still delivers the webhook when the signature
 * is valid but loading the store's offline session fails — typically a
 * token refresh for a store that has just uninstalled, which Shopify refuses.
 * Without this, app/uninstalled and the compliance webhooks answer 500 exactly
 * when they matter. A bad signature (401), bad request (400) or wrong method
 * (405) is still thrown as before.
 */
export async function authenticateWebhook(request: Request) {
  const copy = request.clone();
  try {
    return await shopify.authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response && error.status < 500) throw error;
    console.error("Webhook session unavailable; handling without it", error);
    const topic = (copy.headers.get("x-shopify-topic") ?? "").toUpperCase().replace(/[/.]/g, "_");
    return {
      topic,
      shop: copy.headers.get("x-shopify-shop-domain") ?? "",
      payload: JSON.parse(await copy.text()) as Record<string, unknown>,
      session: undefined,
    };
  }
}
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
