import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { ADMIN_LOCALES, adminLocale } from "./admin-i18n";

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../locales/${name}`, import.meta.url)), "utf8")) as Record<string, string>;

/** Every English text the admin asks for, harvested from the source. */
function sourceTexts(): Set<string> {
  const out = new Set<string>();
  const call = /(?<![A-Za-z0-9_$.])t\("([^"]+)"/g;
  for (const dir of ["../routes", "../components"]) {
    const base = fileURLToPath(new URL(dir, import.meta.url));
    for (const file of readdirSync(base).filter((f) => f.endsWith(".tsx"))) {
      const code = readFileSync(`${base}/${file}`, "utf8");
      for (const match of code.matchAll(call)) out.add(match[1]);
    }
  }
  return out;
}

const variables = (text: string) => (text.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((v) => v.replace(/\s+/g, "")).sort();

describe("the admin's language", () => {
  const url = (locale: string) => new Request(`https://app.test/app?shop=s.myshopify.com&locale=${locale}`);

  test("follows Shopify's locale, down to the language, and falls back to English", () => {
    expect(adminLocale(url("de"))).toBe("de");
    expect(adminLocale(url("pt-BR"))).toBe("pt-BR");
    // A region we don't ship: the language alone still matches.
    expect(adminLocale(url("de-AT"))).toBe("de");
    // Portuguese from Portugal is not silently served Brazilian text.
    expect(adminLocale(url("pt-PT"))).toBe("en");
    expect(adminLocale(url("ja"))).toBe("en");
    expect(adminLocale(new Request("https://app.test/app"))).toBe("en");
  });

  test("every language we offer has a dictionary", () => {
    const files = new Set(readdirSync(fileURLToPath(new URL("../locales", import.meta.url))));
    for (const locale of Object.keys(ADMIN_LOCALES)) {
      if (locale === "en") continue; // English is the source.
      expect(files, locale).toContain(`${locale}.json`);
    }
  });
});

describe("the dictionaries", () => {
  const source = sourceTexts();
  const locales = Object.keys(ADMIN_LOCALES).filter((l) => l !== "en");

  test.each(locales)("%s translates texts the admin actually shows, and keeps their variables", (locale) => {
    const dictionary = read(`${locale}.json`);
    expect(Object.keys(dictionary).length).toBeGreaterThan(200);
    for (const [english, translated] of Object.entries(dictionary)) {
      expect(translated.trim(), `${locale}: ${english}`).not.toBe("");
      // A translation that lost or renamed a variable would render a blank.
      expect(variables(translated), `${locale}: ${english}`).toEqual(variables(english));
    }
  });

  test.each(locales)("%s has no keys the admin stopped using", (locale) => {
    // Besides the literals in the routes, the admin translates texts that come
    // from app/lib (metric and plan names, template titles) via t(value).
    const known = new Set([...source, ...libTexts()]);
    expect(Object.keys(read(`${locale}.json`)).filter((key) => !known.has(key))).toEqual([]);
  });
});

/** English texts that live in app/lib and reach the admin through t(value). */
function libTexts(): Set<string> {
  const out = new Set<string>();
  const base = fileURLToPath(new URL("..", import.meta.url));
  for (const file of ["lib/deals.ts", "lib/metric-defs.ts", "lib/plans.ts"]) {
    const code = readFileSync(`${base}/${file}`, "utf8");
    for (const match of code.matchAll(/(?:title|description|label|help|name): "([^"]+)"/g)) out.add(match[1]);
    // Discount labels are keyed by the discount type ({ amount: "Amount off…" }).
    const labels = code.match(/export const DISCOUNT_LABELS[^}]+}/)?.[0] ?? "";
    for (const match of labels.matchAll(/: "([^"]+)"/g)) out.add(match[1]);
    for (const group of code.matchAll(/features: \[([^\]]+)\]/g)) {
      for (const feature of group[1].matchAll(/"([^"]+)"/g)) out.add(feature[1]);
    }
  }
  return out;
}
