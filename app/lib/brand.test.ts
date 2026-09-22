import { describe, expect, test } from "vitest";
import { contrastText, paletteFromSettings, tint } from "./brand";
import { normalizeConfig, normalizePalette, publishedStyle, resolveColor } from "./deals";

// Dawn-like settings_data.json.
const dawn = {
  current: {
    color_schemes: {
      "scheme-1": { settings: { background: "#FFFFFF", text: "#121212", button: "#121212", button_label: "#FFFFFF", shadow: "#121212" } },
      "scheme-2": { settings: { background: "#F3F3F3", text: "#121212", button: "#334FB4", button_label: "#F3F3F3" } },
      "scheme-3": { settings: { background: "#242833", text: "#FFFFFF", button: "#FFFFFF" } },
    },
    sale_badge_color_scheme: "scheme-5",
    colors_accent_1: "#e94f37",
    badge_sale_color: "#c0392b",
  },
};

describe("brand palette from the theme", () => {
  test("groups the theme's colours", () => {
    const p = paletteFromSettings(dawn);
    expect(p.neutrals[0]).toBe("#ffffff");
    expect(p.neutrals[p.neutrals.length - 1]).toBe("#121212");
    // Button / accent settings come first among the vivid colours.
    expect(p.accents[0]).toBe("#334fb4");
    expect(p.accents).toContain("#e94f37");
    expect(p.badge).toEqual([p.accents[0], "#ffffff"]);
    expect(p.alerts[0]).toBe("#c0392b");
    expect(p.alerts[1]).toBe(tint("#c0392b", 0.85));
  });

  test("no colours: sensible defaults", () => {
    expect(paletteFromSettings({ current: "Default" }).neutrals).toEqual(["#ffffff", "#f4f6f8", "#d9d9d9", "#1a1a1a"]);
  });

  test("contrast text", () => {
    expect(contrastText("#ffff00")).toBe("#1a1a1a");
    expect(contrastText("#1a1a1a")).toBe("#ffffff");
  });
});

describe("brand links", () => {
  const palette = normalizePalette({ neutrals: ["#fefefe"], accents: ["#334fb4", "#e94f37"], badge: ["#334fb4", "#ffffff"], alerts: ["bad", "#c0392b"] })!;

  test("normalize drops invalid colours", () => {
    expect(palette.alerts).toEqual(["#c0392b"]);
    expect(normalizePalette({})).toBeNull();
  });

  test("links resolve at publish; missing slots are empty; hex stays", () => {
    expect(resolveColor("brand:accents.1", palette)).toBe("#e94f37");
    expect(resolveColor("brand:accents.3", palette)).toBe("");
    expect(resolveColor("brand:accents.0", null)).toBe("");
    expect(resolveColor("#123456", palette)).toBe("#123456");
    const style = normalizeConfig({ style: { colors: { accent: "brand:accents.0" }, customCss: "a{}</style><script>" } }).style;
    const out = publishedStyle(style, palette);
    expect(out.colors.accent).toBe("#334fb4");
    expect(out.customCss).not.toContain("</style");
  });
});
