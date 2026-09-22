import type { ActionFunctionArgs } from "react-router";
import { ingestEvents, type IncomingEvent } from "../lib/stats.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_EVENTS = 50;
const MAX_BODY = 64 * 1024;

/**
 * Per-IP budget: 300 events a minute. The endpoint is public (storefront and
 * pixel can't hold a secret), so this caps what one client can inflate.
 */
const WINDOW_MS = 60_000;
const BUDGET = 300;
const budgets = new Map<string, { start: number; used: number }>();
function allow(ip: string, events: number): boolean {
  const now = Date.now();
  let b = budgets.get(ip);
  if (!b || now - b.start > WINDOW_MS) {
    b = { start: now, used: 0 };
    budgets.set(ip, b);
    if (budgets.size > 50_000) budgets.clear(); // bound memory under a flood
  }
  b.used += events;
  return b.used <= BUDGET;
}

/**
 * Storefront beacon: POST /api/events
 *
 * Callers send `text/plain` (sendBeacon / fetch keepalive) so the request stays
 * a CORS "simple" request with no preflight. Always answers 204: a beacon has
 * no error path and failures must never reach the shopper.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 204, headers: CORS });
    const body = JSON.parse(text) as { shop?: string; events?: IncomingEvent[] };
    const shop = String(body.shop ?? "").toLowerCase();
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) && Array.isArray(body.events)) {
      const events = body.events.slice(0, MAX_EVENTS);
      if (allow(ip, events.length)) await ingestEvents(shop, events);
    }
  } catch (error) {
    console.error("Event ingest failed", error);
  }
  return new Response(null, { status: 204, headers: CORS });
};

export const loader = () => new Response("Method not allowed", { status: 405, headers: CORS });
