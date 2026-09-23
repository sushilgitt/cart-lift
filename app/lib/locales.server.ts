import { gql, type AdminGraphql } from "./shop.server";

/** The store's published languages (read_locales). The primary one needs no translation. */
export async function shopLocales(admin: AdminGraphql): Promise<{ locale: string; name: string; primary: boolean }[]> {
  try {
    const data = await gql<{ shopLocales: { locale: string; name: string; primary: boolean; published: boolean }[] }>(
      admin,
      `#graphql
        query cartliftShopLocales { shopLocales { locale name primary published } }`,
    );
    return data.shopLocales
      .filter((l) => l.published || l.primary)
      .map((l) => ({ locale: l.locale, name: l.name, primary: l.primary }));
  } catch (error) {
    console.error("Shop locales failed", error);
    return [];
  }
}
