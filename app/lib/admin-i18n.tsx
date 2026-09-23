import { createContext, useContext, type ReactNode } from "react";

import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import it from "../locales/it.json";
import nl from "../locales/nl.json";
import ptBR from "../locales/pt-BR.json";
import sv from "../locales/sv.json";
import tr from "../locales/tr.json";

/**
 * The admin in the merchant's language.
 *
 * Shopify embeds the app with `?locale=<language>`, so every request says which
 * language the staff member reads. Texts are keyed by their English source:
 * a missing translation falls back to that English text instead of a key, and
 * a text that changes in the code simply goes back to English until it is
 * translated again. `{{name}}` placeholders are filled by `t`.
 */

export const ADMIN_LOCALES: Record<string, string> = {
  en: "English",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  it: "Italiano",
  nl: "Nederlands",
  sv: "Svenska",
  tr: "Türkçe",
  "pt-BR": "Português (Brasil)",
};

const DICTIONARIES: Record<string, Record<string, string>> = { fr, de, es, it, nl, sv, tr, "pt-BR": ptBR };

/** A Shopify locale matched to one we ship; English when we don't have it. */
export function matchLocale(wanted: string): string {
  if (ADMIN_LOCALES[wanted]) return wanted;
  // "de-AT" → "de". "pt-PT" is not served Brazilian text, only regions we ship.
  const language = wanted.split("-")[0].toLowerCase();
  return ADMIN_LOCALES[language] ? language : "en";
}

/** The language of this request: Shopify's `locale`, matched to what we have. */
export function adminLocale(request: Request): string {
  return matchLocale(new URL(request.url).searchParams.get("locale") || "en");
}

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

const fill = (text: string, vars?: Record<string, string | number>) =>
  vars ? text.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;

const I18nContext = createContext<Record<string, string>>({});

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return <I18nContext.Provider value={DICTIONARIES[locale] ?? {}}>{children}</I18nContext.Provider>;
}

/** `t("Save deal")` — the English text is the key. */
export function useT(): Translate {
  const dictionary = useContext(I18nContext);
  return (text, vars) => fill(dictionary[text] || text, vars);
}
