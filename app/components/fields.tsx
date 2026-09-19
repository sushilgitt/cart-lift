import { useEffect, useRef, type ReactNode } from "react";

/**
 * Controlled wrappers around Polaris web-component fields.
 *
 * React 18 neither forwards `change` events from custom elements to `onChange`
 * nor sets properties on them (it writes string attributes, so `checked={false}`
 * becomes `checked="false"`, which is truthy). These wrappers listen natively
 * and push values in as properties, so the editor can drive a live preview.
 */

function useField<T extends HTMLElement>(
  value: unknown,
  prop: "value" | "checked",
  onValue: (el: T) => void,
) {
  // `any`: each Polaris element has its own ref type; this hook serves them all.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const handler = useRef(onValue);
  handler.current = onValue;

  useEffect(() => {
    const el = ref.current as unknown as Record<string, unknown> | null;
    if (el && el[prop] !== value) el[prop] = value;
  }, [value, prop]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = () => handler.current(el);
    el.addEventListener("input", listener);
    el.addEventListener("change", listener);
    return () => {
      el.removeEventListener("input", listener);
      el.removeEventListener("change", listener);
    };
  }, []);

  return ref;
}

interface Base {
  label: string;
  details?: string;
  error?: string;
  disabled?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  details,
  error,
  placeholder,
  disabled,
}: Base & { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useField<HTMLElement>(value, "value", (el) =>
    onChange(String((el as unknown as { value: string }).value ?? "")),
  );
  return (
    <s-text-field
      ref={ref}
      label={label}
      details={details}
      error={error}
      placeholder={placeholder}
      disabled={disabled || undefined}
    />
  );
}

export function TextArea({
  label,
  value,
  onChange,
  details,
  rows = 6,
}: Base & { value: string; onChange: (v: string) => void; rows?: number }) {
  const ref = useField<HTMLElement>(value, "value", (el) =>
    onChange(String((el as unknown as { value: string }).value ?? "")),
  );
  return <s-text-area ref={ref} label={label} details={details} rows={rows} />;
}

export function NumberField({
  label,
  value,
  onChange,
  details,
  error,
  min,
  max,
  step,
  suffix,
  prefix,
}: Base & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  prefix?: string;
}) {
  const ref = useField<HTMLElement>(String(value), "value", (el) => {
    const n = Number((el as unknown as { value: string }).value);
    onChange(Number.isFinite(n) ? n : 0);
  });
  return (
    <s-number-field
      ref={ref}
      label={label}
      details={details}
      error={error}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      prefix={prefix}
    />
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  details,
}: Base & {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const ref = useField<HTMLElement>(value, "value", (el) =>
    onChange(String((el as unknown as { value: string }).value)),
  );
  return (
    <s-select ref={ref} label={label} details={details}>
      {options.map((o) => (
        <s-option key={o.value} value={o.value}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  details,
}: Base & { checked: boolean; onChange: (v: boolean) => void }) {
  const ref = useField<HTMLElement>(checked, "checked", (el) =>
    onChange(Boolean((el as unknown as { checked: boolean }).checked)),
  );
  return <s-checkbox ref={ref} label={label} details={details} />;
}

export function ColorField({
  label,
  value,
  onChange,
}: Base & { value: string; onChange: (v: string) => void }) {
  const ref = useField<HTMLElement>(value, "value", (el) =>
    onChange(String((el as unknown as { value: string }).value)),
  );
  return <s-color-field ref={ref} label={label} />;
}

export function DateTimeField({
  label,
  value,
  onChange,
  details,
}: Base & { value: string; onChange: (v: string) => void }) {
  // Native input: Polaris has no combined date-time field.
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span>{label}</span>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        style={{
          padding: "6px 8px",
          border: "1px solid #8a8a8a",
          borderRadius: 8,
          font: "inherit",
        }}
      />
      {details ? <span style={{ color: "#616161", fontSize: 12 }}>{details}</span> : null}
    </label>
  );
}

export function Grid({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: `repeat(auto-fit, minmax(${columns >= 3 ? 150 : 200}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
