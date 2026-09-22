import prisma from "../db.server";

export interface Totals {
  views: number;
  addToCarts: number;
  checkouts: number;
  orders: number;
  units: number;
  revenue: number;
  addedRevenue: number;
}

export interface DealRow extends Totals {
  dealId: string;
  name: string;
  arm: string;
}

const empty = (): Totals => ({ views: 0, addToCarts: 0, checkouts: 0, orders: 0, units: 0, revenue: 0, addedRevenue: 0 });

export function rates(t: Totals) {
  return {
    atcRate: t.views ? t.addToCarts / t.views : 0,
    checkoutRate: t.views ? t.checkouts / t.views : 0,
    conversion: t.views ? t.orders / t.views : 0,
    aov: t.orders ? t.revenue / t.orders : 0,
    revenuePerVisitor: t.views ? t.revenue / t.views : 0,
    unitsPerOrder: t.orders ? t.units / t.orders : 0,
  };
}

/** Per deal & arm totals plus a per-day series for [from, to). */
export async function dealAnalytics(domain: string, from: Date, to: Date) {
  const rows = await prisma.dailyStat.findMany({
    where: { shop: { domain }, day: { gte: from, lt: to } },
    include: { deal: { select: { name: true } } },
    orderBy: { day: "asc" },
  });

  const total = empty();
  const byKey = new Map<string, DealRow>();
  const byDay = new Map<string, Totals>();

  for (const r of rows) {
    const add = (t: Totals) => {
      t.views += r.views;
      t.addToCarts += r.addToCarts;
      t.checkouts += r.checkouts;
      t.orders += r.orders;
      t.units += r.units;
      t.revenue += Number(r.revenue);
      t.addedRevenue += Number(r.addedRevenue);
    };
    add(total);
    const key = `${r.dealId}|${r.arm}`;
    let row = byKey.get(key);
    if (!row) {
      row = { dealId: r.dealId, name: r.deal.name, arm: r.arm, ...empty() };
      byKey.set(key, row);
    }
    add(row);
    const day = r.day.toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = empty();
      byDay.set(day, d);
    }
    add(d);
  }

  const series: { day: string; revenue: number; orders: number }[] = [];
  for (let t = new Date(from); t < to; t = new Date(t.getTime() + 86400_000)) {
    const day = t.toISOString().slice(0, 10);
    const d = byDay.get(day);
    series.push({ day, revenue: d?.revenue ?? 0, orders: d?.orders ?? 0 });
  }

  return { total, rows: [...byKey.values()], series };
}

export function rangeFromParam(value: string | null) {
  const days = [7, 30, 90].includes(Number(value)) ? Number(value) : 30;
  const to = new Date(new Date().toISOString().slice(0, 10));
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  return { days, from, to };
}
