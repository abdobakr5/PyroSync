import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Flame } from "./flame";
import { Badge, Button, Empty, Icon, IconButton, Segment, Select } from "./ui";
import { MATCH_COLORS } from "./colors";
import { SNAPSHOT, fmt, quantile, sources, type FireRecord, type Filters } from "./data";
import {
  BASE_END,
  BASE_START,
  DATA_START,
  buildEngine,
  clsLabel,
  computeKpis,
  dayPoints,
  isAnomalous,
  periodDetail,
  type APoint,
  type Cls,
  type Resolution,
} from "./anomaly";
import {
  loadAdminShapes,
  loadGeoIndex,
  regionLabel,
  reverseGeocode,
  reverseLookup,
  type GeoLookup,
} from "./geo";

type Range = { id: string; label: string; start: string; end: string; year?: number };
export const RANGES: Range[] = [
  { id: "multi", label: "2012 – Apr 2026 · multi-sensor era", start: "2012-01-01", end: SNAPSHOT },
  { id: "full", label: "Nov 2000 – Apr 2026 · full record", start: DATA_START, end: SNAPSHOT },
  { id: "last5", label: "2021 – Apr 2026 · last 5 years", start: "2021-01-01", end: SNAPSHOT },
  ...Array.from({ length: 15 }, (_, i) => 2026 - i).map((y) => ({
    id: `y${y}`,
    label: y === 2026 ? "2026 (to 15 Apr)" : String(y),
    start: `${y}-01-01`,
    end: y === 2026 ? SNAPSHOT : `${y}-12-31`,
    year: y,
  })),
];
const CLS_COLOR: Record<Cls, string> = {
  extreme: "#F04438",
  elevated: "#FF963D",
  normal: "#51D6F0",
  below: "#3E9FCC",
  nobase: "#A9C0D3",
  nodata: "#A9C0D3",
  partial: "#A9C0D3",
};
const pctText = (p: number | null) =>
  p === null ? "n/a" : `${p >= 0 ? "+" : ""}${p.toFixed(p !== 0 && Math.abs(p) < 10 ? 1 : 0)}%`;
const resLabel: Record<Resolution, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
};
const longDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function useLocationName(lat?: number, lon?: number) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    let live = true;
    reverseGeocode(lat, lon).then(
      (r: GeoLookup) =>
        live &&
        setName(
          [r.admin ? regionLabel(r.admin) : r.place?.name, r.country?.n]
            .filter(Boolean)
            .join(", ") || "Unidentified location",
        ),
      () => live && setName("Location unavailable"),
    );
    return () => {
      live = false;
    };
  }, [lat, lon]);
  return name;
}

/* ---------------------------------- KPI system ---------------------------------- */

function DaysCalendar({
  engineDays,
  start,
  end,
}: {
  engineDays: { date: string; cls: Cls }[];
  start: string;
  end: string;
}) {
  // Scope split into ≤42 bins on a 7-column grid; cell shade = share of anomalous days, hatched = no data.
  const days = engineDays.filter((d) => d.date >= start && d.date <= end);
  const bins = Math.min(42, Math.max(1, days.length));
  const size = days.length / bins;
  const cells = Array.from({ length: bins }, (_, i) => {
    const slice = days.slice(Math.floor(i * size), Math.floor((i + 1) * size) || 1);
    const valid = slice.filter(
      (d) => d.cls !== "nodata" && d.cls !== "nobase" && d.cls !== "partial",
    );
    return {
      share: valid.length ? valid.filter((d) => isAnomalous(d.cls)).length / valid.length : null,
    };
  });
  return (
    <div className="kpi-cal" aria-hidden="true">
      {cells.map((c, i) => (
        <i
          key={i}
          className={c.share === null ? "gap" : ""}
          style={
            c.share ? { background: `rgba(255, 150, 61, ${0.25 + c.share * 0.75})` } : undefined
          }
        />
      ))}
    </div>
  );
}

export function AnomalyKpis({
  kpis,
  engineDays,
  scope,
  scopeLabel,
  onMonth,
  onYear,
  onEvent,
}: {
  kpis: ReturnType<typeof computeKpis>;
  engineDays: { date: string; cls: Cls }[];
  scope: { start: string; end: string };
  scopeLabel: string;
  onMonth: (p: APoint) => void;
  onYear: (y: number) => void;
  onEvent: (r: FireRecord) => void;
}) {
  const k = kpis;
  const loc = useLocationName(k.maxFrp?.record.lat, k.maxFrp?.record.lon);
  const delta = k.previous && k.previous.comparable ? k.anomalyDays - k.previous.days : null;
  const runSegs = k.run ? Math.min(k.run.len, 14) : 0;
  return (
    <section className="akpis" aria-label={`Anomaly intelligence summary for ${scopeLabel}`}>
      <div className="akpi">
        <span className="akpi-title">Total Anomaly Days</span>
        <strong className="akpi-value">
          {fmt(k.anomalyDays)}
          <em>days</em>
        </strong>
        <DaysCalendar engineDays={engineDays} start={scope.start} end={scope.end} />
        <small>{scopeLabel}</small>
        <small className={delta === null ? "" : delta > 0 ? "up" : "down"}>
          {delta === null
            ? k.previous
              ? "Previous period lacks compatible coverage"
              : "No previous equivalent period"
            : `${delta >= 0 ? "+" : ""}${delta} vs previous ${fmt(k.totalDays)} days`}
        </small>
      </div>
      <button
        className="akpi clickable"
        disabled={!k.month}
        onClick={() => k.month && onMonth(k.month)}
        title="Select this month on the timeline"
      >
        <span className="akpi-title">Most Anomalous Month</span>
        {k.month ? (
          <>
            <strong className="akpi-value">
              {k.month.label.split(" ")[0]}
              <em>{k.month.year}</em>
            </strong>
            <div className="akpi-thermal" aria-hidden="true">
              <i
                style={{ left: `${Math.min(100, Math.max(0, ((k.month.pct ?? 0) + 50) / 2))}%` }}
              />
            </div>
            <small>
              {pctText(k.month.pct)} vs same-month median · {clsLabel(k.month.cls)}
            </small>
            <small>
              {k.month.anomDays} anomalous day{k.month.anomDays === 1 ? "" : "s"} in month
            </small>
          </>
        ) : (
          <small>No month with a compatible baseline in scope</small>
        )}
      </button>
      <button
        className="akpi clickable"
        disabled={!k.year}
        onClick={() => k.year && onYear(k.year.year)}
        title="Filter the timeline to this year"
      >
        <span className="akpi-title">Highest Anomaly Year</span>
        {k.year ? (
          <>
            <strong className="akpi-value">
              {k.year.year}
              <em>{pctText(k.year.pct)}</em>
            </strong>
            <div className="akpi-years" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => BASE_START + i).map((y) => (
                <i key={y} className={y === k.year!.year ? "on" : ""} />
              ))}
            </div>
            <small>
              Annual total vs {BASE_START}–{BASE_END} median ({fmt(k.year.base?.median ?? 0)})
            </small>
            <small>Complete years only · click to filter timeline</small>
          </>
        ) : (
          <small>No complete year with a compatible baseline</small>
        )}
      </button>
      <button
        className="akpi clickable hot"
        disabled={!k.maxFrp}
        onClick={() => k.maxFrp && onEvent(k.maxFrp.record)}
        title="Focus the globe on this event"
      >
        <span className="akpi-title">Maximum Observed FRP</span>
        {k.maxFrp ? (
          <>
            <strong className="akpi-value">
              {k.maxFrp.frp.toFixed(1)}
              <em>MW</em>
              <Flame size={16} intensity="high" animated={false} />
            </strong>
            <div className="akpi-thermo" aria-hidden="true">
              <i style={{ width: `${Math.min(100, (k.maxFrp.frp / 180) * 100)}%` }} />
            </div>
            <small>
              {k.maxFrp.record.date} · {k.maxFrp.time} UTC · {k.maxFrp.record.id}
            </small>
            <small>
              {loc || "Resolving location…"} · {k.maxFrp.sensor} ({k.maxFrp.satellite})
            </small>
          </>
        ) : (
          <small>No observations in scope</small>
        )}
      </button>
      <div className="akpi">
        <span className="akpi-title">Consecutive Anomaly Days</span>
        {k.run ? (
          <>
            <strong className="akpi-value">
              {k.run.len}
              <em>day{k.run.len === 1 ? "" : "s"}</em>
            </strong>
            <div className="akpi-chain" aria-hidden="true">
              {Array.from({ length: runSegs }, (_, i) => (
                <i key={i} />
              ))}
              {k.run.len > 14 && <span>+{k.run.len - 14}</span>}
            </div>
            <small>
              {longDate(k.run.start)} → {longDate(k.run.end)}
            </small>
            <small>
              Peak {pctText(k.run.peak)}
              {k.missingDays
                ? ` · ${fmt(k.missingDays)} days lack compatible data; runs never bridge gaps`
                : ""}
            </small>
          </>
        ) : (
          <small>
            No anomalous days in scope
            {k.missingDays ? ` · ${fmt(k.missingDays)} days lack compatible data` : ""}
          </small>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------- Timeline chart ---------------------------------- */

function Timeline({
  points,
  res,
  selected,
  onSelect,
  markDate,
  unit,
}: {
  points: APoint[];
  res: Resolution;
  selected: APoint | null;
  onSelect: (p: APoint) => void;
  markDate?: string;
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000,
    H = 300,
    L = 54,
    R = 16,
    T = 22,
    B = 34;
  const n = points.length;
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const valid = points.filter((p) => p.pct !== null);
  const bandOf = (p: APoint) =>
    p.base && p.base.median > 0
      ? [
          ((p.base.q1 - p.base.median) / p.base.median) * 100,
          ((p.base.q3 - p.base.median) / p.base.median) * 100,
        ]
      : null;
  const sorted = valid.map((p) => p.pct!).sort((a, b) => a - b);
  const yMax = Math.min(300, Math.max(100, quantile(sorted, 0.97) * 1.15 || 100));
  const yMin = Math.max(-100, Math.min(-50, sorted[0] ?? -50));
  const clampV = (v: number) => Math.max(yMin, Math.min(yMax, v));
  const y = (v: number) => T + ((yMax - clampV(v)) / (yMax - yMin)) * (H - T - B);
  const segs: number[][] = [];
  points.forEach((p, i) => {
    if (p.pct === null) return;
    const last = segs[segs.length - 1];
    last && last[last.length - 1] === i - 1 ? last.push(i) : segs.push([i]);
  });
  const gaps: { a: number; b: number; cls: Cls }[] = [];
  points.forEach((p, i) => {
    if (p.pct !== null) return;
    const g = gaps[gaps.length - 1];
    g && g.b === i - 1 && g.cls === p.cls ? (g.b = i) : gaps.push({ a: i, b: i, cls: p.cls });
  });
  const line = (s: number[]) =>
    s.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].pct!).toFixed(1)}`).join("");
  const fill = (s: number[], thr: number) =>
    `M${x(s[0])},${y(thr)}` +
    s.map((i) => `L${x(i).toFixed(1)},${y(points[i].pct!).toFixed(1)}`).join("") +
    `L${x(s[s.length - 1])},${y(thr)}Z`;
  const band = (s: number[]) => {
    const up = s
      .map((i) => bandOf(points[i]))
      .map((b, k) => (b ? `${k ? "L" : "M"}${x(s[k])},${y(b[1])}` : ""))
      .join("");
    const low = [...s]
      .reverse()
      .map((i) => {
        const b = bandOf(points[i]);
        return b ? `L${x(i)},${y(b[0])}` : "";
      })
      .join("");
    return up ? `${up}${low}Z` : "";
  };
  const half = n > 1 ? (W - L - R) / (n - 1) / 2 : 20;
  const selIdx = selected ? points.findIndex((p) => p.key === selected.key) : -1;
  const markIdx = markDate ? points.findIndex((p) => p.start <= markDate && p.end >= markDate) : -1;
  const ticks = useMemo(() => {
    if (res === "day")
      return points
        .map((p, i) =>
          p.start.endsWith("-01")
            ? {
                i,
                t: new Date(`${p.start}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short" }),
              }
            : null,
        )
        .filter(Boolean) as { i: number; t: string }[];
    const yrs = points
      .map((p, i) => ({ i, y: p.year, first: i === 0 || points[i - 1].year !== p.year }))
      .filter((p) => p.first);
    const step = Math.ceil(yrs.length / 13);
    if (res === "year")
      return points.map((p, i) => ({ i, t: String(p.year) })).filter((_, k) => k % step === 0);
    if (yrs.length <= 1)
      return points
        .map((p, i) => ({ i, t: p.label.split(" ")[0] }))
        .filter((_, k) => res === "month" || k % 4 === 0);
    return yrs.filter((_, k) => k % step === 0).map((p) => ({ i: p.i, t: String(p.y) }));
  }, [points, res]);
  const idxAt = (e: MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((mx - L) / (W - L - R)) * (n - 1))));
  };
  const step = (dir: number) => {
    let i = selIdx < 0 ? (dir > 0 ? -1 : n) : selIdx;
    do i += dir;
    while (i >= 0 && i < n && points[i].pct === null);
    if (i >= 0 && i < n) onSelect(points[i]);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight") (e.preventDefault(), step(1));
    if (e.key === "ArrowLeft") (e.preventDefault(), step(-1));
  };
  const hp = hover !== null ? points[hover] : null;
  const dots = n <= 220;
  return (
    <div className="atl-plot">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="application"
        tabIndex={0}
        onKeyDown={onKey}
        aria-label={`Thermal anomaly timeline, ${resLabel[res].toLowerCase()} points. Use left and right arrow keys to select periods.`}
      >
        <defs>
          <pattern
            id="atl-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line y2="6" stroke="rgba(169,192,211,0.35)" strokeWidth="2" />
          </pattern>
          <clipPath id="atl-above25">
            <rect x={L} y={T} width={W - L - R} height={Math.max(0, y(25) - T)} />
          </clipPath>
          <clipPath id="atl-above75">
            <rect x={L} y={T} width={W - L - R} height={Math.max(0, y(75) - T)} />
          </clipPath>
          <linearGradient id="atl-warm" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#FF963D" stopOpacity=".55" />
            <stop offset="1" stopColor="#FF963D" stopOpacity=".12" />
          </linearGradient>
          <linearGradient id="atl-hot" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#F04438" stopOpacity=".75" />
            <stop offset="1" stopColor="#F04438" stopOpacity=".25" />
          </linearGradient>
        </defs>
        {[yMin, -25, 0, 25, 75, yMax]
          .filter((v, i, a) => v >= yMin && v <= yMax && a.indexOf(v) === i)
          .map((v) => (
            <text key={v} x={L - 8} y={y(v) + 4} textAnchor="end" className="axis-text">
              {v > 0 ? `+${Math.round(v)}` : Math.round(v)}%
            </text>
          ))}
        {gaps.map((g, k) => (
          <g key={k}>
            <rect
              x={x(g.a) - half}
              y={T}
              width={x(g.b) - x(g.a) + half * 2}
              height={H - T - B}
              fill="url(#atl-hatch)"
              className="atl-gap"
            />
            {x(g.b) - x(g.a) > 90 && (
              <text
                x={(x(g.a) + x(g.b)) / 2}
                y={T + 14}
                textAnchor="middle"
                className="atl-gap-label"
              >
                {g.cls === "nobase"
                  ? "No compatible baseline (pre-2012 / sparse)"
                  : g.cls === "partial"
                    ? "Partial coverage"
                    : "No source data"}
              </text>
            )}
          </g>
        ))}
        {segs.map((s, k) => (
          <path key={k} d={band(s)} className="atl-band" />
        ))}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="atl-baseline" />
        <line x1={L} x2={W - R} y1={y(25)} y2={y(25)} className="atl-thr elevated" />
        {y(75) > T && <line x1={L} x2={W - R} y1={y(75)} y2={y(75)} className="atl-thr extreme" />}
        <text x={W - R - 4} y={y(25) - 5} textAnchor="end" className="atl-thr-label">
          Elevated ≥ +25%
        </text>
        {y(75) > T + 10 && (
          <text x={W - R - 4} y={y(75) - 5} textAnchor="end" className="atl-thr-label hot">
            Extreme ≥ +75%
          </text>
        )}
        <text x={L + 6} y={y(0) + 15} className="atl-thr-label base">
          Historical median (0%)
        </text>
        {segs.map((s, k) => (
          <path key={`w${k}`} d={fill(s, 25)} fill="url(#atl-warm)" clipPath="url(#atl-above25)" />
        ))}
        {segs.map((s, k) => (
          <path key={`h${k}`} d={fill(s, 75)} fill="url(#atl-hot)" clipPath="url(#atl-above75)" />
        ))}
        {segs.map((s, k) => (
          <path key={`l${k}`} d={line(s)} className="atl-line" />
        ))}
        {points.map(
          (p, i) =>
            p.pct !== null &&
            (dots || isAnomalous(p.cls)) && (
              <circle
                key={p.key}
                cx={x(i)}
                cy={y(p.pct)}
                r={isAnomalous(p.cls) ? (dots ? 3.6 : 2.4) : 2.2}
                fill={CLS_COLOR[p.cls]}
                className="atl-dot"
              />
            ),
        )}
        {markIdx >= 0 && (
          <g className="atl-mark">
            <line x1={x(markIdx)} x2={x(markIdx)} y1={T} y2={H - B} />
            <text x={x(markIdx) + 5} y={H - B - 6}>
              Selected event
            </text>
          </g>
        )}
        {selIdx >= 0 && (
          <g className="atl-sel">
            <line x1={x(selIdx)} x2={x(selIdx)} y1={T} y2={H - B} />
            {points[selIdx].pct !== null && (
              <>
                <circle cx={x(selIdx)} cy={y(points[selIdx].pct!)} r="9" className="ring" />
                <circle
                  cx={x(selIdx)}
                  cy={y(points[selIdx].pct!)}
                  r="5"
                  fill={CLS_COLOR[points[selIdx].cls]}
                  className="core"
                />
              </>
            )}
          </g>
        )}
        {hp && hover !== selIdx && (
          <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="atl-hover" />
        )}
        {ticks.map(({ i, t }) => (
          <text key={`${i}-${t}`} x={x(i)} y={H - 10} textAnchor="middle" className="axis-text">
            {t}
          </text>
        ))}
        <rect
          x={L - half}
          y={T}
          width={W - L - R + half * 2}
          height={H - T - B}
          fill="transparent"
          className="atl-hit"
          onMouseMove={(e) => setHover(idxAt(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const i = idxAt(e);
            points[i] && onSelect(points[i]);
          }}
        />
      </svg>
      {hp && (
        <div
          className={`atl-tip ${x(hover!) / W > 0.66 ? "flip" : ""}`}
          style={{ left: `${(x(hover!) / W) * 100}%` }}
          aria-hidden="true"
        >
          <strong>{hp.label}</strong>
          <span>
            {hp.pct === null ? clsLabel(hp.cls) : `${pctText(hp.pct)} · ${clsLabel(hp.cls)}`}
          </span>
          {hp.observed !== null && (
            <span>
              {fmt(hp.observed)} {res === "day" ? `${unit} (7-day window)` : unit}
              {hp.base ? ` vs median ${fmt(hp.base.median)}` : ""}
            </span>
          )}
          <em>Click to inspect</em>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Period inspector ---------------------------------- */

function useAreaBreakdown(records: FireRecord[]) {
  const [rows, setRows] = useState<{ name: string; n: number }[] | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setRows(null);
    if (!records.length) return setRows([]);
    Promise.all([loadGeoIndex(), loadAdminShapes()]).then(
      ([index, shapes]) => {
        if (!live) return;
        const m = new Map<string, number>(),
          c = new Set<string>();
        records.slice(0, 600).forEach((r) => {
          const lk = reverseLookup(index, shapes, r.lat, r.lon);
          const name = lk.admin ? regionLabel(lk.admin) : (lk.country?.n ?? "Unidentified");
          m.set(name, (m.get(name) || 0) + 1);
          if (lk.country) c.add(lk.country.n);
        });
        setRows([...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n));
        setCountries([...c]);
      },
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [records]);
  return { rows, countries };
}

export function PeriodInspector({
  point,
  history,
  filters,
  scopeName,
  yearMonths = [],
  onDiveYear,
  onSelectMonth,
  onClose,
  onEvent,
}: {
  point: APoint;
  history: FireRecord[];
  filters: Filters;
  scopeName: string;
  yearMonths?: APoint[];
  onDiveYear?: (year: number) => void;
  onSelectMonth?: (m: APoint) => void;
  onClose: () => void;
  onEvent: (r: FireRecord) => void;
}) {
  const unit = filters.mode === "raw" ? "source detections" : "analytical records";
  const det = useMemo(
    () => periodDetail(point, history, filters.mode, unit, scopeName),
    [point, history, filters.mode, unit, scopeName],
  );
  const geo = useAreaBreakdown(det.records);
  const iqr = point.base ? `${fmt(point.base.q1)} – ${fmt(point.base.q3)}` : "Not available";
  const title =
    point.res === "week"
      ? `ISO week ${point.index + 1}, ${point.year}`
      : point.res === "day"
        ? longDate(point.start)
        : point.res === "year"
          ? `Year ${point.year}`
          : new Date(`${point.start}T12:00:00Z`).toLocaleDateString("en-GB", {
              month: "long",
              year: "numeric",
            });
  const dayCount =
    point.res === "day" ? history.filter((r) => r.date === point.start).length : null;
  const topEvents = [...det.records]
    .sort((a, b) => b.frp - a.frp)
    .slice(0, point.res === "day" ? 10 : 6);
  const maxSrc = det.maxFrp
    ? sources(det.maxFrp).reduce((a, b) => (b.frp_mw > a.frp_mw ? b : a))
    : null;
  return (
    <section
      className={`api cls-${point.cls}`}
      aria-label={`Anomaly details for ${title}`}
      aria-live="polite"
    >
      <header className="api-head">
        <span className="api-marker" aria-hidden="true" />
        <div>
          <span className="eyebrow">
            SELECTED{" "}
            {point.res === "day"
              ? "DAY"
              : point.res === "week"
                ? "ISO WEEK"
                : point.res.toUpperCase()}{" "}
            · {scopeName.toUpperCase()}
          </span>
          <h2>{title}</h2>
          <small>
            {longDate(point.start)} – {longDate(point.end > SNAPSHOT ? SNAPSHOT : point.end)}
            {point.end > SNAPSHOT ? " (partial)" : ""}
          </small>
        </div>
        <Badge
          tone={
            point.cls === "extreme"
              ? "thermal"
              : point.cls === "elevated"
                ? "warning"
                : point.cls === "normal"
                  ? "cyan"
                  : "muted"
          }
        >
          {clsLabel(point.cls)}
        </Badge>
        <strong className="api-score">{pctText(point.pct)}</strong>
        {point.res === "year" && onDiveYear && (
          <Button variant="primary" icon="calendar" onClick={() => onDiveYear(point.year)}>
            Dive into {point.year} months
          </Button>
        )}
        <IconButton icon="close" label="Clear selected period" onClick={onClose} />
      </header>
      <div className="api-grid">
        <div className="api-sec">
          <h3>01 · Activity</h3>
          <dl>
            <div>
              <dt>Observed {point.res === "day" ? "(7-day window)" : ""}</dt>
              <dd>
                {point.observed === null ? "Not available" : `${fmt(point.observed)} ${unit}`}
              </dd>
            </div>
            {dayCount !== null && (
              <div>
                <dt>Records on this day</dt>
                <dd>{fmt(dayCount)}</dd>
              </div>
            )}
            <div>
              <dt>Historical median</dt>
              <dd>
                {point.base
                  ? `${fmt(point.base.median)} (${point.base.n} years, ${BASE_START}–${BASE_END})`
                  : "Not available"}
              </dd>
            </div>
            <div>
              <dt>Historical IQR</dt>
              <dd>{iqr}</dd>
            </div>
            <div>
              <dt>Deviation</dt>
              <dd>{pctText(point.pct)}</dd>
            </div>
            <div>
              <dt title="Modified z = (observed − median) ÷ (MAD ÷ 0.6745)">
                Robust (modified) z-score <Icon name="info" size={11} />
              </dt>
              <dd>{point.z === null ? "Not available" : point.z.toFixed(2)}</dd>
            </div>
          </dl>
        </div>
        <div className="api-sec thermal">
          <h3>02 · Thermal intensity</h3>
          <dl>
            <div>
              <dt>Maximum FRP</dt>
              <dd>{det.maxFrp ? `${det.maxFrp.frp.toFixed(1)} MW` : "Not available"}</dd>
            </div>
            <div>
              <dt>Mean FRP</dt>
              <dd>
                {det.meanFrp === null
                  ? "Not available"
                  : `${det.meanFrp.toFixed(1)} MW per ${filters.mode === "raw" ? "detection" : "record"}`}
              </dd>
            </div>
            <div>
              <dt>Total FRP</dt>
              <dd className="muted">Not reported — instantaneous power is not additive</dd>
            </div>
            <div>
              <dt>Highest-intensity event</dt>
              <dd>
                {det.maxFrp ? (
                  <button className="record-link" onClick={() => onEvent(det.maxFrp!)}>
                    {det.maxFrp.id}
                  </button>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Date of maximum FRP</dt>
              <dd>
                {det.maxFrp && maxSrc
                  ? `${det.maxFrp.date} · ${maxSrc.time_utc} UTC · ${maxSrc.sensor}`
                  : "—"}
              </dd>
            </div>
          </dl>
        </div>
        <div className="api-sec">
          <h3>03 · Temporal pattern</h3>
          <dl>
            <div>
              <dt>Anomaly days</dt>
              <dd>
                {point.res === "day"
                  ? isAnomalous(point.cls)
                    ? "This day is anomalous"
                    : "Not anomalous"
                  : `${point.anomDays} day${point.anomDays === 1 ? "" : "s"}`}
              </dd>
            </div>
            <div>
              <dt>Longest consecutive run</dt>
              <dd>
                {point.run
                  ? `${point.run.len} day${point.run.len === 1 ? "" : "s"} (${point.run.start} → ${point.run.end})`
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>First anomalous day</dt>
              <dd>{point.firstAnom ?? "—"}</dd>
            </div>
            <div>
              <dt>Last anomalous day</dt>
              <dd>{point.lastAnom ?? "—"}</dd>
            </div>
            <div>
              <dt>Days without compatible data</dt>
              <dd>{fmt(point.missingDays)}</dd>
            </div>
          </dl>
        </div>
        <div className="api-sec">
          <h3>04 · Sensor breakdown</h3>
          <div className="api-bars">
            {[
              ["Matched", det.composition.matched, MATCH_COLORS["Matched (Both)"]],
              ["VIIRS-Only", det.composition.viirsOnly, MATCH_COLORS["VIIRS-Only"]],
              ["MODIS-Only", det.composition.modisOnly, MATCH_COLORS["MODIS-Only"]],
            ].map(([l, v, c]) => (
              <div key={l as string}>
                <span>{l}</span>
                <div>
                  <i
                    style={{
                      width: `${det.records.length ? ((v as number) / det.records.length) * 100 : 0}%`,
                      background: c as string,
                    }}
                  />
                </div>
                <strong>{fmt(v as number)}</strong>
              </div>
            ))}
          </div>
          <small>
            {fmt(det.composition.modis)} MODIS + {fmt(det.composition.viirs)} VIIRS source
            detections · unmatched = {fmt(det.composition.viirsOnly + det.composition.modisOnly)}{" "}
            records
          </small>
        </div>
        <div className="api-sec">
          <h3>05 · Geographic distribution</h3>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>{scopeName}</dd>
            </div>
            <div>
              <dt>Countries</dt>
              <dd>{geo.rows === null ? "Resolving…" : geo.countries.join(", ") || "—"}</dd>
            </div>
            <div>
              <dt>Affected subregions</dt>
              <dd>{geo.rows === null ? "Resolving…" : `${geo.rows.length}`}</dd>
            </div>
          </dl>
          {geo.rows && geo.rows.length > 0 && (
            <ul className="api-areas">
              {geo.rows.slice(0, 5).map((r) => (
                <li key={r.name}>
                  <span>{r.name}</span>
                  <strong>{fmt(r.n)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="api-sec interp">
          <h3>06 · Interpretation</h3>
          <p>{det.interpretation}</p>
          {topEvents.length > 0 && (
            <div className="api-events">
              <span>{point.res === "day" ? "Event identifiers" : "Strongest events"}</span>
              {topEvents.map((r) => (
                <button key={r.id} className="related-chip" onClick={() => onEvent(r)}>
                  <span className="chip-swatch" style={{ background: MATCH_COLORS[r.match] }} />
                  <span>
                    {r.id}
                    <small>
                      {r.date} · {r.frp.toFixed(0)} MW
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {point.res === "year" && yearMonths.length > 0 && (
          <div className="api-sec interp">
            <h3>07 · Months in {point.year} (click to dive into month)</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(135px, 1fr))",
                gap: 8,
                marginTop: 8,
              }}
            >
              {yearMonths.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className="related-chip"
                  style={{
                    justifyContent: "space-between",
                    width: "100%",
                    textAlign: "left",
                  }}
                  onClick={() => onSelectMonth?.(m)}
                >
                  <span
                    className="chip-swatch"
                    style={{ background: CLS_COLOR[m.cls] }}
                  />
                  <span style={{ flex: 1 }}>
                    {m.label}
                    <small>
                      {pctText(m.pct)} · {m.anomDays} anom day{m.anomDays === 1 ? "" : "s"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------- Container ---------------------------------- */

/** Selection keys: "YYYY-MM" month · "YYYY-Www" ISO week · "YYYY" year · "YYYY-MM-DD" day. */
export const periodKeyRes = (key: string): Resolution =>
  /^\d{4}-W\d{2}$/.test(key)
    ? "week"
    : /^\d{4}$/.test(key)
      ? "year"
      : /^\d{4}-\d{2}-\d{2}$/.test(key)
        ? "day"
        : "month";

export function ThermalAnomalyTimeline({
  history,
  filters,
  scopeName,
  selectedKey,
  onSelect,
  markDate,
  onEvent,
  loading = false,
}: {
  history: FireRecord[];
  filters: Filters;
  scopeName: string;
  selectedKey?: string;
  onSelect: (p: APoint | null) => void;
  markDate?: string;
  onEvent: (r: FireRecord) => void;
  loading?: boolean;
}) {
  const [res, setRes] = useState<Resolution>("month");
  const [rangeId, setRangeId] = useState("multi");
  const viirsOnly =
    filters.sensor === "VIIRS" ||
    (filters.matches.length > 0 && !filters.matches.includes("MODIS-Only"));
  const engine = useMemo(
    () => buildEngine(history, filters.mode, filters.sensor, viirsOnly),
    [history, filters.mode, filters.sensor, viirsOnly],
  );
  const range = RANGES.find((r) => r.id === rangeId)!;
  // Resolve the selection against the current engine so area or filter changes recalculate it.
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    const r = periodKeyRes(selectedKey);
    if (r === "day") return dayPoints(engine, selectedKey, selectedKey)[0] ?? null;
    return engine[r].find((p) => p.key === selectedKey) ?? null;
  }, [engine, selectedKey]);
  // Daily resolution is limited to one year so each point stays legible.
  useEffect(() => {
    if (res === "day" && !range.year)
      setRangeId(`y${selected?.year && selected.year >= 2012 ? selected.year : 2025}`);
  }, [res, range.year, selected?.year]);
  // Sync global Control Deck year / All-time selection into the anomaly timeline.
  useEffect(() => {
    const startYear = Number(filters.start.slice(0, 4));
    const endYear = Number(filters.end.slice(0, 4));
    if (startYear === endYear && startYear >= 2012 && startYear <= 2026) {
      setRangeId(`y${startYear}`);
      setRes((r) => (r === "year" ? "month" : r));
    } else if (filters.start === "2000-11-01" && filters.end === SNAPSHOT) {
      setRangeId("full");
    }
  }, [filters.start, filters.end]);
  const points = useMemo(
    () =>
      res === "day"
        ? range.year
          ? dayPoints(engine, range.start, range.end)
          : []
        : engine[res].filter((p) => p.end >= range.start && p.start <= range.end),
    [engine, res, range],
  );
  const scope = selected
    ? { start: selected.start, end: selected.end > SNAPSHOT ? SNAPSHOT : selected.end }
    : { start: range.start, end: range.end };
  const kpis = useMemo(
    () => computeKpis(engine, history, scope),
    [engine, history, scope.start, scope.end],
  );
  const unit = filters.mode === "raw" ? "source detections" : "analytical records";
  const empty = !points.some((p) => p.pct !== null);
  return (
    <section className="atl" aria-label="Thermal anomaly timeline">
      <header className="atl-head">
        <div>
          <span className="eyebrow">THERMAL ANOMALY TIMELINE · {scopeName.toUpperCase()}</span>
          <h2>When was fire activity unusual — and for how long?</h2>
          <p>
            {resLabel[res]} {unit} compared with the same seasonal period in {BASE_START}–{BASE_END}{" "}
            (leave-one-out median). Above +25% with robust z ≥ 2 is Elevated; above +75% with z ≥
            3.5 is Extreme.
          </p>
        </div>
        <div className="atl-controls">
          <Segment
            value={res}
            onChange={(v) => setRes(v)}
            options={(["day", "week", "month", "year"] as Resolution[]).map((r) => ({
              value: r,
              label: resLabel[r],
            }))}
          />
          <Select
            aria-label="Analysis period"
            value={rangeId}
            onChange={(e) => {
              const nextId = e.target.value;
              const nextRange = RANGES.find((r) => r.id === nextId);
              setRangeId(nextId);
              if (nextRange?.year) {
                setRes((r) => (r === "year" ? "month" : r));
                if (selected && selected.year !== nextRange.year) onSelect(null);
              }
            }}
          >
            {RANGES.filter((r) => res !== "day" || r.year).map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
      </header>
      <div className="akpi-scope">
        <span>
          <Icon name="target" size={13} />
          KPI scope:{" "}
          <strong>
            {selected
              ? `selected ${selected.res === "day" ? "day" : selected.res} · ${selected.label}`
              : range.label}
          </strong>
        </span>
        {selected && <button onClick={() => onSelect(null)}>Show whole analysis period</button>}
      </div>
      {loading ? (
        <div className="atl-skeleton" role="status" aria-label="Loading anomaly timeline">
          <i />
          <i />
          <i />
          <i />
          <i />
          <b />
        </div>
      ) : (
        <>
          <AnomalyKpis
            kpis={kpis}
            engineDays={engine.days}
            scope={scope}
            scopeLabel={selected ? selected.label : range.label}
            onMonth={(p) => (setRes("month"), onSelect(p))}
            onYear={(y) => (
              setRangeId(`y${y}`),
              setRes((r) => (r === "year" ? "month" : r)),
              onSelect(null)
            )}
            onEvent={onEvent}
          />
          <div className="atl-legend">
            <span>
              <i className="k-line" />
              Anomaly vs seasonal median
            </span>
            <span>
              <i className="k-band" />
              Normal range (IQR)
            </span>
            <span>
              <i className="k-warm" />
              Elevated
            </span>
            <span>
              <i className="k-hot" />
              Extreme
            </span>
            <span>
              <i className="k-gap" />
              No compatible data
            </span>
            {markDate && (
              <span>
                <i className="k-mark" />
                Selected event period
              </span>
            )}
          </div>
          {empty ? (
            <Empty
              title="No anomaly can be computed here"
              detail={`${scopeName} has no observations with a compatible ${BASE_START}–${BASE_END} baseline in this period. Missing coverage is not shown as normal.`}
            />
          ) : (
            <Timeline
              points={points}
              res={res}
              selected={selected && selected.res === res ? selected : null}
              onSelect={onSelect}
              markDate={markDate}
              unit={unit}
            />
          )}
          {selected ? (
            <PeriodInspector
              point={selected}
              history={history}
              filters={filters}
              scopeName={scopeName}
              yearMonths={
                selected.res === "year"
                  ? engine.month.filter((m) => m.year === selected.year)
                  : []
              }
              onDiveYear={(year) => {
                setRangeId(`y${year}`);
                setRes("month");
                onSelect(null);
              }}
              onSelectMonth={(m) => {
                setRangeId(`y${m.year}`);
                setRes("month");
                onSelect(m);
              }}
              onClose={() => onSelect(null)}
              onEvent={onEvent}
            />
          ) : (
            <div className="api-empty">
              <Icon name="target" size={16} />
              Select any point on the timeline — or use the arrow keys — to inspect that period. The
              globe, calendar, and KPIs follow your selection.
            </div>
          )}
        </>
      )}
      <details className="atl-method">
        <summary>Methodology & limits</summary>
        <p>
          Anomaly % = (observed − historical median) ÷ historical median × 100, using the same
          calendar month, ISO week, year, or centred 7-day window in each {BASE_START}–{BASE_END}{" "}
          year except the evaluated one; at least 5 baseline years are required and a zero median
          yields no percentage. Robust (modified) z-score = (observed − median) ÷ (MAD ÷ 0.6745). An
          anomalous day has an Elevated or Extreme 7-day window. Consecutive runs use real calendar
          dates and break at any day without compatible data. Highest Anomaly Year compares complete
          annual totals with the median of other baseline years. Powered by PyroSync Gold NASA MODIS & VIIRS detections (2003–2025).
        </p>
      </details>
    </section>
  );
}
