import prisma from "../db.server";

export interface AdminGraphql {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** Runs an Admin GraphQL call and throws on top-level or user errors. */
export async function gql<T = any>(
  admin: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/**
 * Shopify sends no "installed" webhook, so the admin loader provisions the
 * shop. Re-installs clear `uninstalledAt` and force a republish, because the
 * app-data metafield and the discount were removed with the installation.
 */
export async function ensureShop(domain: string) {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (!existing) return prisma.shop.create({ data: { domain } });
  if (existing.uninstalledAt) {
    return prisma.shop.update({
      where: { id: existing.id },
      data: {
        uninstalledAt: null,
        installedAt: new Date(),
        discountId: null,
        pixelId: null,
        publishedHash: null,
      },
    });
  }
  return existing;
}

export async function backfillShopProfile(admin: AdminGraphql, domain: string) {
  try {
    const data = await gql<{
      shop: {
        name: string;
        contactEmail: string | null;
        currencyCode: string;
        ianaTimezone: string;
        currencyFormats: { moneyFormat: string };
      };
    }>(
      admin,
      `#graphql
        query cartliftShopProfile {
          shop { name contactEmail currencyCode ianaTimezone currencyFormats { moneyFormat } }
        }`,
    );
    await prisma.shop.update({
      where: { domain },
      data: {
        name: data.shop.name,
        email: data.shop.contactEmail,
        currencyCode: data.shop.currencyCode,
        moneyFormat: data.shop.currencyFormats.moneyFormat,
        timezone: data.shop.ianaTimezone,
      },
    });
  } catch (error) {
    // Cosmetic; never block the admin on it.
    console.error(`Shop profile backfill failed for ${domain}`, error);
  }
}

export async function markUninstalled(domain: string) {
  await prisma.session.deleteMany({ where: { shop: domain } });
  await prisma.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: new Date(), discountId: null, pixelId: null, publishedHash: null },
  });
}
