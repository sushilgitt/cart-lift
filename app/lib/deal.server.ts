import type { Deal, DealStatus, DealType, Prisma, TargetType } from "@prisma/client";
import prisma from "../db.server";
import { normalizeConfig, validateConfig, type DealConfig, type ResourceRef } from "./deals";

export interface DealInput {
  name: string;
  type: DealType;
  status: DealStatus;
  targetType: TargetType;
  products: ResourceRef[];
  collections: ResourceRef[];
  startsAt: string | null;
  endsAt: string | null;
  config: DealConfig;
}

const TYPES: DealType[] = ["QUANTITY_BREAK", "BXGY", "BUNDLE"];
const STATUSES: DealStatus[] = ["DRAFT", "ACTIVE", "PAUSED"];
const TARGETS: TargetType[] = ["ALL", "PRODUCTS", "COLLECTIONS", "EXCEPT"];

const cleanRefs = (value: unknown): ResourceRef[] =>
  Array.isArray(value)
    ? value
        .filter((r) => r && typeof r.id === "string" && r.id.startsWith("gid://shopify/"))
        .slice(0, 250)
        .map((r) => ({ id: r.id, title: String(r.title ?? ""), image: r.image ?? null }))
    : [];

const date = (v: unknown) => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Parses and validates editor input. Returns field errors instead of throwing. */
export function parseDealInput(raw: Record<string, unknown>) {
  const errors: string[] = [];
  const type = TYPES.includes(raw.type as DealType) ? (raw.type as DealType) : "QUANTITY_BREAK";
  const status = STATUSES.includes(raw.status as DealStatus) ? (raw.status as DealStatus) : "DRAFT";
  const targetType = TARGETS.includes(raw.targetType as TargetType)
    ? (raw.targetType as TargetType)
    : "ALL";
  const name = String(raw.name ?? "").trim().slice(0, 120);
  const products = cleanRefs(raw.products);
  const collections = cleanRefs(raw.collections);
  const startsAt = date(raw.startsAt);
  const endsAt = date(raw.endsAt);
  const config = normalizeConfig(raw.config, type);

  if (!name) errors.push("Give the deal a name.");
  if ((targetType === "PRODUCTS" || targetType === "EXCEPT") && !products.length)
    errors.push("Pick at least one product.");
  if (targetType === "COLLECTIONS" && !collections.length) errors.push("Pick at least one collection.");
  if (startsAt && endsAt && endsAt <= startsAt) errors.push("The end date must be after the start date.");
  errors.push(...validateConfig(config));

  const data = {
    name,
    type,
    status,
    targetType,
    products: products as unknown as Prisma.InputJsonValue,
    collections: collections as unknown as Prisma.InputJsonValue,
    startsAt,
    endsAt,
    config: config as unknown as Prisma.InputJsonValue,
  };
  return { errors, data };
}

export async function shopIdFor(domain: string) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain }, select: { id: true } });
  return shop.id;
}

export async function getDeal(domain: string, id: string): Promise<Deal | null> {
  return prisma.deal.findFirst({ where: { id, shop: { domain } } });
}

export async function listDeals(domain: string) {
  return prisma.deal.findMany({
    where: { shop: { domain } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
}

export async function duplicateDeal(domain: string, id: string) {
  const deal = await getDeal(domain, id);
  if (!deal) return null;
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = deal;
  return prisma.deal.create({
    data: {
      ...rest,
      name: `${deal.name} (copy)`,
      status: "DRAFT",
      products: deal.products as Prisma.InputJsonValue,
      collections: deal.collections as Prisma.InputJsonValue,
      config: deal.config as Prisma.InputJsonValue,
    },
  });
}

export async function nextPriority(shopId: string) {
  const last = await prisma.deal.findFirst({
    where: { shopId },
    orderBy: { priority: "desc" },
    select: { priority: true },
  });
  return (last?.priority ?? -1) + 1;
}
