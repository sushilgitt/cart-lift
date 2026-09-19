import type { ActionFunctionArgs } from "react-router";
import { ingestEvents, type IncomingEvent } from "../lib/stats.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_EVENTS = 50;

/**
 * Storefront beacon: POST /api/events
 *
 * Callers send `text/plain` (sendBeacon / fetch keepalive) so the request stays
 * a CORS "simple" request with no preflight. Always answers 204: a beacon has
 * no error path and failures must never reach the shopper.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = JSON.parse(await request.text()) as { shop?: string; events?: IncomingEvent[] };
    const shop = String(body.shop ?? "").toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) && Array.isArray(body.events)) {
      await ingestEvents(shop, body.events.slice(0, MAX_EVENTS));
    }
  } catch (error) {
    console.error("Event ingest failed", error);
  }
  return new Response(null, { status: 204, headers: CORS });
};

export const loader = () => new Response("Method not allowed", { status: 405, headers: CORS });
