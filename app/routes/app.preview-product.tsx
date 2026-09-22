import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { gql } from "../lib/shop.server";
import { numericId } from "../lib/deals";

/**
 * GET /app/preview-product?id=gid://shopify/Product/… — a real product for the
 * editor's live preview, in the shape Liquid gives the storefront widget
 * (snippets/cartlift-data.liquid): product JSON with prices in cents, plus
 * option swatches. Prices are in shop currency.
 */

interface AdminProduct {
  id: string;
  title: string;
  handle: string;
  featuredImage: { url: string } | null;
  options: {
    name: string;
    optionValues: { name: string; swatch: { color: string | null; image: { image: { url: string } | null } | null } | null }[];
  }[];
  variants: {
    nodes: {
      id: string;
      title: string;
      price: string;
      compareAtPrice: string | null;
      availableForSale: boolean;
      selectedOptions: { value: string }[];
      image: { url: string } | null;
    }[];
  };
}

const cents = (amount: string | null) => (amount == null ? null : Math.round(Number(amount) * 100));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id.startsWith("gid://shopify/Product/")) return Response.json({ error: "Unknown product" }, { status: 400 });

  const data = await gql<{ product: AdminProduct | null }>(
    admin,
    `#graphql
      query cartliftPreviewProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          featuredImage { url }
          options {
            name
            optionValues { name swatch { color image { image { url } } } }
          }
          variants(first: 100) {
            nodes {
              id
              title
              price
              compareAtPrice
              availableForSale
              selectedOptions { value }
              image { url }
            }
          }
        }
      }`,
    { id },
  );
  const p = data.product;
  if (!p) return Response.json({ error: "Product not found" }, { status: 404 });

  return Response.json({
    product: {
      id: Number(numericId(p.id)),
      title: p.title,
      handle: p.handle,
      options: p.options.map((o) => o.name),
      variants: p.variants.nodes.map((v) => ({
        id: Number(numericId(v.id)),
        title: v.title,
        price: cents(v.price) ?? 0,
        compare_at_price: cents(v.compareAtPrice),
        available: v.availableForSale,
        options: v.selectedOptions.map((o) => o.value),
        featured_image: v.image ? { src: v.image.url } : null,
      })),
    },
    options: p.options.map((o) => ({
      name: o.name,
      values: o.optionValues.map((v) => ({
        name: v.name,
        color: v.swatch?.color ?? null,
        image: v.swatch?.image?.image?.url ?? null,
      })),
    })),
    image: p.featuredImage?.url ?? null,
  });
};
