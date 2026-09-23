import { useMemo, useRef, useState } from "react";
import { useT } from "../lib/admin-i18n";

/**
 * One metric over time: this period (solid, categorical slot 1) against the
 * previous period (dotted, muted). One axis; legend with line keys; a
 * crosshair that snaps to the day with a tooltip; a data table underneath.
 * Colours follow the dataviz reference palette, light and dark.
 */

export interface TrendPoint {
  day: string;
  prevDay: string;
  value: number;
  prev: number;
}

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

/** A round axis maximum and 4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return Array.from({ length: 5 }, (_, i) => i * step);
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function TrendChart({
  title,
  points,
  format,
}: {
  title: string;
  points: TrendPoint[];
  format: (n: number) => string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const overlay = useRef<SVGRectElement>(null);

  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.flatMap((p) => [p.value, p.prev]))), [points]);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const path = (key: "value" | "prev") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const labelDays = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];

  const onMove = (e: React.PointerEvent) => {
    const rect = overlay.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const px = ((e.clientX - rect.left) / rect.width) * plotW;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((px / plotW) * (points.length - 1)))));
  };
  const h = hover == null ? null : points[hover];

  return (
    <div className="viz-root">
      <style>{`
        .viz-root {
          --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
          --grid: #e4e3df; --series-1: #2a78d6; --series-prev: #8e8c86;
          color: var(--text-primary); position: relative;
        }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .viz-root {
            --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
            --grid: #34332f; --series-1: #3987e5; --series-prev: #8f8d85;
          }
        }
        :root[data-theme="dark"] .viz-root {
          --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
          --grid: #34332f; --series-1: #3987e5; --series-prev: #8f8d85;
        }
        .viz-legend { display: flex; gap: 16px; margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
        .viz-key { display: inline-flex; align-items: center; gap: 6px; }
        .viz-tip {
          position: absolute; pointer-events: none; padding: 8px 10px; border-radius: 8px; font-size: 12px;
          background: var(--surface-1); color: var(--text-primary); box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
          white-space: nowrap; transform: translate(-50%, -100%);
        }
        .viz-tip div { display: flex; align-items: center; gap: 6px; }
        .viz-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
        .viz-table th, .viz-table td { padding: 4px 8px; border-bottom: 1px solid var(--grid); text-align: right; }
        .viz-table th:first-child, .viz-table td:first-child { text-align: left; }
      `}</style>
      <div className="viz-legend" aria-hidden="true">
        <span className="viz-key">
          <svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--series-1)" strokeWidth="2" strokeLinecap="round" /></svg>
          {t("This period")}
        </span>
        <span className="viz-key">
          <svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke="var(--series-prev)" strokeWidth="2" strokeDasharray="2 3" strokeLinecap="round" /></svg>
          {t("Previous period")}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${title}: this period against the previous period`}
        style={{ display: "block", overflow: "visible" }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--text-secondary)">
              {format(t)}
            </text>
          </g>
        ))}
        {labelDays.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--text-secondary)">
            {shortDate(points[i].day)}
          </text>
        ))}
        <path d={path("prev")} fill="none" stroke="var(--series-prev)" strokeWidth="2" strokeDasharray="2 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d={path("value")} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {h ? (
          <g>
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--text-secondary)" strokeWidth="1" />
            <circle cx={x(hover!)} cy={y(h.prev)} r="4" fill="var(--series-prev)" stroke="var(--surface-1)" strokeWidth="2" />
            <circle cx={x(hover!)} cy={y(h.value)} r="4" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
          </g>
        ) : null}
        <rect
          ref={overlay}
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {h ? (
        <div className="viz-tip" style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(Math.min(y(h.value), y(h.prev)) / H) * 100}%` }}>
          <div>
            <svg width="12" height="4"><line x1="0" y1="2" x2="12" y2="2" stroke="var(--series-1)" strokeWidth="2" /></svg>
            {shortDate(h.day)}: <strong>{format(h.value)}</strong>
          </div>
          <div>
            <svg width="12" height="4"><line x1="0" y1="2" x2="12" y2="2" stroke="var(--series-prev)" strokeWidth="2" strokeDasharray="2 3" /></svg>
            {shortDate(h.prevDay)}: {format(h.prev)}
          </div>
        </div>
      ) : null}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{t("Show as a table")}</summary>
        <table className="viz-table">
          <thead>
            <tr>
              <th>{t("Day")}</th>
              <th>{t("This period")}</th>
              <th>{t("Previous period")}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}>
                <td>{shortDate(p.day)}</td>
                <td>{format(p.value)}</td>
                <td>{format(p.prev)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
