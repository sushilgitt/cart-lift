/** Analytics days follow the shop's clock, not the server's. */

/** A day in the shop's timezone, as a DATE (UTC midnight). */
export function shopDay(timezone: string | null | undefined, now = new Date()): Date {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return new Date(`${ymd}T00:00:00Z`);
  } catch {
    return new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  }
}
