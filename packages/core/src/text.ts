const VARIABLE = /\{\{\s*(\w+)\s*\}\}/g;

export type TextVars = Record<string, string | number>;

/**
 * Replaces `{{variables}}`; unknown ones are left as typed. Pass `escape` to
 * HTML-escape both the text and the values (storefront rendering).
 */
export function renderText(text: string, vars: TextVars, escape?: (value: string) => string): string {
  const safe = escape ?? ((v: string) => v);
  return safe(text || "").replace(VARIABLE, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? safe(String(vars[key])) : m,
  );
}

export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
