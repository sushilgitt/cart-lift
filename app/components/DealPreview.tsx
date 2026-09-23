import { useEffect, useRef, useState } from "react";
import widgetCss from "../../extensions/cartlift-widget/assets/cartlift.css?url";
import widgetJs from "../../extensions/cartlift-widget/assets/cartlift.js?url";
import { useT } from "../lib/admin-i18n";

/**
 * Live preview that runs the real storefront renderer (cartlift.js), so what
 * the merchant sees here is exactly what shoppers get.
 */

type PreviewDeal = Record<string, unknown> & { bars: unknown[] };
interface PreviewCtx {
  product: { title: string; variants: { id: number; title: string; price: number; compare_at_price: number | null; available: boolean }[] };
  moneyFormat: string;
  rate: number;
}

declare global {
  interface Window {
    CartLift?: {
      preview?: (el: HTMLElement, deal: PreviewDeal, ctx: PreviewCtx) => (deal: PreviewDeal, ctx?: PreviewCtx) => void;
    };
  }
}

let loader: Promise<void> | null = null;
function loadWidget() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.CartLift?.preview) return Promise.resolve();
  loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = widgetJs;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Preview script failed to load"));
    document.head.appendChild(script);
  });
  return loader;
}

export function DealPreview({ deal, ctx }: { deal: PreviewDeal; ctx: PreviewCtx }) {
  const t = useT();
  const el = useRef<HTMLDivElement>(null);
  const update = useRef<((deal: PreviewDeal, ctx?: PreviewCtx) => void) | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadWidget()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !el.current || !window.CartLift?.preview) return;
    if (!update.current) update.current = window.CartLift.preview(el.current, deal, ctx);
    else update.current(deal, ctx);
  }, [ready, deal, ctx]);

  return (
    <>
      <link rel="stylesheet" href={widgetCss} />
      {!ready ? <s-spinner accessibilityLabel={t("Loading preview")} /> : null}
      {/* Owned by cartlift.js — React must never render children in here. */}
      <div ref={el} style={{ minHeight: ready ? 120 : 0 }} />
    </>
  );
}
