import prisma from "../db.server";
import { gql, type AdminGraphql } from "./shop.server";

/**
 * Shopify only runs the pixel once the app creates a WebPixel record on the
 * shop. Cached on Shop.pixelId, so after the first admin load this is a no-op.
 */
export async function ensureWebPixel(admin: AdminGraphql, domain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true, pixelId: true } });
  if (!shop || shop.pixelId) return;

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const settings = JSON.stringify({ shop: domain, api: `${appUrl}/api/events` });

  try {
    const existing = await gql<{ webPixel: { id: string } | null }>(
      admin,
      `#graphql
        query cartliftWebPixel { webPixel { id } }`,
    ).catch(() => ({ webPixel: null }));

    let id = existing.webPixel?.id ?? null;
    if (id) {
      await gql(
        admin,
        `#graphql
          mutation cartliftUpdatePixel($id: ID!, $webPixel: WebPixelInput!) {
            webPixelUpdate(id: $id, webPixel: $webPixel) { userErrors { message } }
          }`,
        { id, webPixel: { settings } },
      );
    } else {
      const data = await gql<{
        webPixelCreate: { webPixel: { id: string } | null; userErrors: { message: string }[] };
      }>(
        admin,
        `#graphql
          mutation cartliftCreatePixel($webPixel: WebPixelInput!) {
            webPixelCreate(webPixel: $webPixel) { webPixel { id } userErrors { message } }
          }`,
        { webPixel: { settings } },
      );
      id = data.webPixelCreate.webPixel?.id ?? null;
      if (!id) console.error(`webPixelCreate failed for ${domain}`, data.webPixelCreate.userErrors);
    }

    if (id) await prisma.shop.update({ where: { id: shop.id }, data: { pixelId: id } });
  } catch (error) {
    console.error(`Pixel registration failed for ${domain}`, error);
  }
}
