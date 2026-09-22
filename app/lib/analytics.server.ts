import prisma from "../db.server";
import { addTotals, emptyTotals, metrics, type Totals } from "../../packages/core/src";
import { armConfig, normalizeConfig, type DealTypeKey } from "./deals";
import { shopDay } from "./days";

/**
 * Analytics 2.0 queries: totals and a daily series for a date range and the
 * period before it, plus the Bundles / Bars / Products / Features tables.
 * Days are the shop's (see stats.server.ts). Formulas live in packages/core.
 */

export { metrics, type Totals } from "../../packages/core/src";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface Range {
  /** Inclusive start (UTC midnight of a shop day). */
  from: Date;
  /** Exclusive end. */
  to: Date;
  days: number;
}

export const PRESETS = [7, 30, 90] as const;

/**
 * The selected range from `?days=7|30|90` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * (inclusive, up to a year), ending today in the shop's timezone, and the
 * previous period of the same length.
 */
export function parseRange(params: URLSearchParams, timezone?: string | null) {
  const today = shopDay(timezone);
  const from = params.get("from");
  const to = params.get("to");
  let range: Range;
  let preset: number | null = null;
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
  const f = date(from);
  const t = date(to);
  if (f && t && f <= t && t.getTime() - f.getTime() <= 366 * DAY) {
    const end = new Date(Math.min(t.getTime(), today.getTime()) + DAY);
    range = { from: f, to: end, days: Math.max(1, Math.round((end.getTime() - f.getTime()) / DAY)) };
  } else {
    const days = PRESETS.includes(Number(params.get("days")) as (typeof PRESETS)[number]) ? Number(params.get("days")) : 30;
    preset = days;
    const end = new Date(today.getTime() + DAY);
    range = { from: new Date(end.getTime() - days * DAY), to: end, days };
  }
  const previous: Range = { from: new Date(range.from.getTime() - range.days * DAY), to: range.from, days: range.days };
  return { range, previous, preset, fromInput: iso(range.from), toInput: iso(new Date(range.to.getTime() - DAY)) };
}

const totalsOf = (r: Record<string, unknown>) => addTotals(emptyTotals(), r);

export async function analytics(domain: string, range: Range, previous: Range, dealId?: string | null) {
  const where = (r: Range) => ({
    shop: { domain },
    day: { gte: r.from, lt: r.to },
    ...(dealId ? { dealId } : {}),
  });
  const [rows, prevRows, facts, deals] = await Promise.all([
    prisma.dailyStat.findMany({ where: where(range), orderBy: { day: "asc" } }),
    prisma.dailyStat.findMany({ where: where(previous) }),
    prisma.statFact.findMany({ where: where(range) }),
    prisma.deal.findMany({ where: { shop: { domain } }, select: { id: true, name: true, type: true, config: true } }),
  ]);
  const dealById = new Map(deals.map((d) => [d.id, d]));

  // Totals and the daily series, aligned day by day with the previous period.
  const total = emptyTotals();
  const prevTotal = emptyTotals();
  const byDay = new Map<string, Totals>();
  const prevByDay = new Map<string, Totals>();
  for (const r of rows) {
    addTotals(total, r);
    addTotals(byDay.get(iso(r.day)) ?? byDay.set(iso(r.day), emptyTotals()).get(iso(r.day))!, r);
  }
  for (const r of prevRows) {
    addTotals(prevTotal, r);
    addTotals(prevByDay.get(iso(r.day)) ?? prevByDay.set(iso(r.day), emptyTotals()).get(iso(r.day))!, r);
  }
  const series = Array.from({ length: range.days }, (_, i) => {
    const day = iso(new Date(range.from.getTime() + i * DAY));
    const prevDay = iso(new Date(previous.from.getTime() + i * DAY));
    return { day, prevDay, cur: byDay.get(day) ?? emptyTotals(), prev: prevByDay.get(prevDay) ?? emptyTotals() };
  });

  // Bundles: per deal and arm.
  const bundles = new Map<string, { dealId: string; name: string; arm: string; totals: Totals }>();
  for (const r of rows) {
    const key = `${r.dealId}|${r.arm}`;
    const row = bundles.get(key) ?? { dealId: r.dealId, name: dealById.get(r.dealId)?.name ?? "Deleted deal", arm: r.arm, totals: emptyTotals() };
    addTotals(row.totals, r);
    bundles.set(key, row);
  }

  // Bars, products, features (StatFact).
  const barTitle = (dId: string, arm: string, barId: string) => {
    const d = dealById.get(dId);
    if (!d) return barId;
    const config = armConfig(normalizeConfig(d.config, d.type as DealTypeKey), arm);
    const bar = config.bars.find((b) => b.id === barId);
    return bar ? bar.title || `Bar of ${bar.qty}` : "Removed bar";
  };
  const group = (dim: string, keyOf: (f: (typeof facts)[number]) => string) => {
    const out = new Map<string, { key: string; dealId: string; arm: string; totals: Totals }>();
    for (const f of facts.filter((x) => x.dim === dim)) {
      const key = keyOf(f);
      const row = out.get(key) ?? { key: f.key, dealId: f.dealId, arm: f.arm, totals: emptyTotals() };
      addTotals(row.totals, f);
      out.set(key, row);
    }
    return [...out.values()];
  };
  const bars = group("bar", (f) => `${f.dealId}|${f.arm}|${f.key}`).map((b) => ({
    ...b,
    dealName: dealById.get(b.dealId)?.name ?? "Deleted deal",
    title: barTitle(b.dealId, b.arm, b.key),
  }));
  const products = group("product", (f) => f.key);
  const features = group("feature", (f) => f.key);

  return {
    total,
    prevTotal,
    series,
    bundles: [...bundles.values()],
    bars,
    products,
    features,
    deals: deals.map((d) => ({ id: d.id, name: d.name })),
  };
}

/** Deal totals for the dashboard: the last 30 days in the shop's timezone. */
export async function last30(domain: string, timezone?: string | null) {
  const { range, previous } = parseRange(new URLSearchParams("days=30"), timezone);
  const rows = await prisma.dailyStat.findMany({ where: { shop: { domain }, day: { gte: range.from, lt: range.to } } });
  const prevRows = await prisma.dailyStat.findMany({ where: { shop: { domain }, day: { gte: previous.from, lt: previous.to } } });
  const total = rows.reduce((t, r) => addTotals(t, r), emptyTotals());
  const prevTotal = prevRows.reduce((t, r) => addTotals(t, r), emptyTotals());
  return { total, prevTotal, metrics: metrics(total), prevMetrics: metrics(prevTotal) };
}

export { totalsOf };
