import { DEFAULT_STRINGS, type SfDeal, type SfI18n, type SfStrings } from "./types";

/** Applying the page's language to the widget (see snippets/cartlift-data.liquid). */

export const stringsFor = (i18n?: SfI18n | null): SfStrings => ({ ...DEFAULT_STRINGS, ...(i18n?.strings ?? {}) });

/** The deal with its texts in this page's language; untranslated texts stay as they are. */
export function translateDeal(deal: SfDeal, i18n?: SfI18n | null): SfDeal {
  const t = i18n?.deals?.[deal.id];
  if (!t) return deal;
  const pick = (translated: string | undefined, original: string) => (translated && translated.trim() ? translated : original);
  const style = {
    ...deal.style,
    blockTitle: pick(t.blockTitle, deal.style.blockTitle ?? ""),
    ...(deal.style.savingsBar
      ? { savingsBar: { ...deal.style.savingsBar, text: pick(t.savingsText, deal.style.savingsBar.text) } }
      : {}),
  };
  return {
    ...deal,
    style,
    ...(deal.mm ? { mm: { ...deal.mm, title: pick(t.modalTitle, deal.mm.title), button: pick(t.modalButton, deal.mm.button) } } : {}),
    ...(deal.sub
      ? { sub: { ...deal.sub, one: pick(t.onetimeLabel, deal.sub.one), sub: pick(t.subscribeLabel, deal.sub.sub) } }
      : {}),
    bars: deal.bars.map((bar) => {
      const b = t.bars?.[bar.id];
      const upsells = bar.upsells.map((up) => ({ ...up, text: pick(t.upsells?.[up.id], up.text) }));
      if (!b) return { ...bar, upsells };
      return {
        ...bar,
        title: pick(b.title, bar.title),
        subtitle: pick(b.subtitle, bar.subtitle),
        label: pick(b.label, bar.label),
        badge: pick(b.badge, bar.badge),
        highlights: (bar.highlights ?? []).map((h, i) => pick(b.highlights?.[i], h)),
        gifts: (bar.gifts ?? []).map((g) => ({ ...g, text: pick(b.giftText, g.text) })),
        ...(bar.gift ? { gift: { ...bar.gift, text: pick(b.giftText, bar.gift.text) } } : {}),
        upsells,
      };
    }),
    ...(deal.arms
      ? {
          arms: deal.arms.map((arm) => ({
            ...arm,
            bars: translateDeal({ ...deal, bars: arm.bars, arms: undefined }, i18n).bars,
          })),
        }
      : {}),
  };
}
