import type { BrandPalette } from "./deals";

/**
 * Brand Colors: a palette read from the live theme's settings
 * (config/settings_data.json), grouped like Kaching's — Neutrals, Accents,
 * Badge, Alerts. Deals link to palette slots ("brand:accents.0"), so editing
 * the palette restyles every linked deal.
 */

const DEFAULTS: BrandPalette = {
  neutrals: ["#ffffff", "#f4f6f8", "#d9d9d9", "#1a1a1a"],
  accents: ["#1a1a1a"],
  badge: ["#1a1a1a", "#ffffff"],
  alerts: ["#0f7a3a", "#e7f5ec"],
};

function toHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return "#" + rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return null;
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function hsl(hex: string) {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

/** WCAG relative luminance. */
function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever reads better on `hex`. */
export const contrastText = (hex: string) => (luminance(hex) > 0.45 ? "#1a1a1a" : "#ffffff");

/** `hex` mixed toward white. */
export function tint(hex: string, amount: number) {
  return "#" + channels(hex).map((c) => Math.round((c + (1 - c) * amount) * 255).toString(16).padStart(2, "0")).join("");
}

/** Every colour setting in the theme settings, with its key path. */
function collect(node: unknown, path: string, out: { key: string; hex: string }[]) {
  if (out.length > 400) return;
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) collect(v, path ? `${path}.${k}` : k, out);
    return;
  }
  const hex = toHex(node);
  if (hex && !/gradient|shadow/i.test(path)) out.push({ key: path.toLowerCase(), hex });
}

export function paletteFromSettings(settings: unknown): BrandPalette {
  const current = (settings as { current?: unknown })?.current;
  const found: { key: string; hex: string }[] = [];
  collect(typeof current === "object" ? current : {}, "", found);
  const unique = [...new Map(found.map((c) => [c.hex, c])).values()];
  if (!unique.length) return { ...DEFAULTS };

  const neutral = unique.filter((c) => hsl(c.hex).s < 0.18).sort((a, b) => hsl(b.hex).l - hsl(a.hex).l);
  const pick = (list: typeof neutral, idx: number[]) => [...new Set(idx.map((i) => list[i]?.hex).filter(Boolean))] as string[];
  const neutrals = neutral.length
    ? pick(neutral, [0, 1, Math.floor(neutral.length / 2), neutral.length - 1])
    : DEFAULTS.neutrals;

  const vivid = unique.filter((c) => hsl(c.hex).s >= 0.18);
  // The theme's button colour is its call-to-action colour: the widget's accent should match it.
  const preferred = (c: { key: string }) =>
    /button(?!_label)/.test(c.key) ? 0 : /accent|primary|brand/.test(c.key) ? 1 : /link/.test(c.key) ? 2 : 3;
  const accents = vivid
    .sort((a, b) => preferred(a) - preferred(b) || hsl(b.hex).s - hsl(a.hex).s)
    .slice(0, 4)
    .map((c) => c.hex);

  const main = accents[0] ?? neutrals[neutrals.length - 1] ?? DEFAULTS.accents[0];
  const sale = unique.find((c) => /sale|success|badge|savings|discount/.test(c.key) && hsl(c.hex).s >= 0.18)?.hex ?? DEFAULTS.alerts[0];

  return {
    neutrals: neutrals.slice(0, 4),
    accents: accents.length ? accents : [main],
    badge: [main, contrastText(main)],
    alerts: [sale, tint(sale, 0.85)],
  };
}
