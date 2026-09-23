import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useT } from "../lib/admin-i18n";

/**
 * The support launcher: a button in the corner of every admin page that opens
 * a small card, the way merchants expect support to work.
 *
 * It is deliberately plain HTML. Polaris' components are built for page
 * layout, and this floats above one; keeping it self-contained means it can't
 * disturb the page underneath.
 */
export function SupportLauncher() {
  const t = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Escape closes it, and so does a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 400 }}>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-label={t("Support")}
          style={{
            width: 320,
            marginBottom: 12,
            borderRadius: 16,
            overflow: "hidden",
            background: "#fff",
            border: "1px solid #e3e3e3",
            boxShadow: "0 12px 32px rgba(0,0,0,.18)",
            font: "inherit",
          }}
        >
          <div style={{ padding: "20px 20px 16px", background: "#f6f6f7" }}>
            <div style={{ fontSize: 20, fontWeight: 650, marginBottom: 4 }}>{t("Hi there 👋")}</div>
            <div style={{ fontSize: 14, color: "#616161" }}>{t("Ask us anything, or share your feedback.")}</div>
          </div>
          <div style={{ padding: 16, display: "grid", gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{t("Start a conversation")}</div>
            <button
              type="button"
              onClick={() => go("/app/support")}
              style={{
                width: "100%",
                padding: "10px 16px",
                borderRadius: 999,
                border: "none",
                background: "#303030",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("Send us a message")}
            </button>
          </div>
          <div style={{ padding: "12px 16px", borderTop: "1px solid #e3e3e3" }}>
            <button
              type="button"
              onClick={() => go("/app/support")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#005bd3",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {t("See all your conversations")}
            </button>
          </div>
        </div>
      ) : null}

      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-label={t("Support")}
        onClick={() => setOpen((was) => !was)}
        style={{
          width: 52,
          height: 52,
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          border: "none",
          background: "#303030",
          color: "#fff",
          boxShadow: "0 6px 16px rgba(0,0,0,.24)",
          cursor: "pointer",
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          ) : (
            <path
              d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.4 9.4 0 0 1-2.8-.4L4 21l1.4-4a8 8 0 0 1-1.4-4.5 8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 7.4z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </button>
    </div>
  );
}
