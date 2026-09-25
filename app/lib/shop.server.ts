import prisma from "../db.server";

export interface AdminGraphql {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** Runs an Admin GraphQL call and throws on top-level or user errors. */
export async function gql<T = unknown>(
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
 * Shopify sends no "installed" webhook, so the shop is provisioned when a
 * session is created (afterAuth in shopify.server.ts) and again by the admin
 * loader. Re-installs clear `uninstalledAt` and force a republish, because the
 * app-data metafield and the discount were removed with the installation.
 *
 * Safe to call concurrently: on first open, React Router runs the layout and
 * page loaders in parallel, and both may try to create the row.
 */
export async function ensureShop(domain: string) {
  let existing = await prisma.shop.findUnique({ where: { domain } });
  if (!existing) {
    try {
      return await prisma.shop.create({ data: { domain } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      existing = await prisma.shop.findUniqueOrThrow({ where: { domain } });
    }
  }
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
        plan: { partnerDevelopment: boolean };
      };
    }>(
      admin,
      `#graphql
        query cartliftShopProfile {
          shop {
            name
            contactEmail
            currencyCode
            ianaTimezone
            currencyFormats { moneyFormat }
            plan { partnerDevelopment }
          }
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
        devStore: Boolean(data.shop.plan?.partnerDevelopment),
      },
    });
  } catch (error) {
    // Cosmetic; never block the admin on it.
    console.error(`Shop profile backfill failed for ${domain}`, error);
  }
}

/**
 * customers/redact: forget the orders Shopify lists. The pixel reports an
 * order id as a number or a GID, so both forms match. Daily totals stay —
 * they can't be traced back to a customer.
 */
export async function redactOrders(domain: string, orderIds: unknown): Promise<number> {
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .map((id) => String(id).split("/").pop() ?? "")
    .filter((id) => /^\d{1,20}$/.test(id));
  if (!ids.length) return 0;
  const { count } = await prisma.dealOrder.deleteMany({
    where: {
      shop: { domain },
      OR: ids.flatMap((id) => [{ orderId: id }, { orderId: { endsWith: `/${id}` } }]),
    },
  });
  return count;
}

export async function markUninstalled(domain: string) {
  await prisma.session.deleteMany({ where: { shop: domain } });
  await prisma.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: new Date(), discountId: null, pixelId: null, publishedHash: null },
  });
}
