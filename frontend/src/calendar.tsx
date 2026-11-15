import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Flame } from "./flame";
import { Button, Icon, Segment, Select } from "./ui";
import {
  MONTHS,
  SNAPSHOT,
  calendarValue,
  compact,
  fmt,
  isoWeek,
  periodRange,
  valueOf,
  type Filters,
  type FireRecord,
  type Metric,
} from "./data";

// Cool blue → cyan (moderate) → amber (elevated) → orange-red (high).
export const SEQ = [
  "#D3EAF6",
  "#A6DCF0",
  "#6FCDEB",
  "#20BCE5",
  "#FFE0A3",
  "#FFC15A",
  "#FF963D",
  "#FF693B",
  "#F04438",
  "#C62828",
];
const DIV = [
  { max: -50, color: "#0B6FA4", label: "≤ −50%" },
  { max: -25, color: "#3E9FCC", label: "−50 to −25%" },
  { max: -10, color: "#A6DCF0", label: "−25 to −10%" },
  { max: 10, color: "#EEF4F8", label: "±10%" },
  { max: 25, color: "#FFD99A", label: "+10 to +25%" },
  { max: 50, color: "#FF963D", label: "+25 to +50%" },
  { max: 75, color: "#F04438", label: "+50 to +75%" },
  { max: Infinity, color: "#C62828", label: "> +75%" },
];
export const metricUnit = (metric: Metric, mode: string) =>
  metric === "frp"
    ? "MW maximum FRP"
    : metric === "anomaly"
      ? "% vs. baseline"
      : mode === "raw"
        ? "raw detections"
        : "analytical records";

export type PeriodRef = { year: number; index: number; weekly: boolean };

export function HeatCalendar({
  history,
  filters,
  metric,
  onMetric,
  weekly,
  onWeekly,
  full = false,
  selected,
  onPeriod,
  onClearPeriod,
  onExpand,
  inspector,
}: {
  history: FireRecord[];
  filters: Filters;
  metric: Metric;
  onMetric: (m: Metric) => void;
  weekly: boolean;
  onWeekly: (v: boolean) => void;
  full?: boolean;
  selected: PeriodRef | null;
  onPeriod: (year: number, index: number, weekly: boolean) => void;
  onClearPeriod?: () => void;
  onExpand?: () => void;
  inspector?: ReactNode;
}) {
  const [years, setYears] = useState("scope");
  const [drillYear, setDrillYear] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    year: number;
    index: number;
    n: number | null;
    count: number;
    missing: boolean;
    partial: boolean;
  } | null>(null);
  useEffect(() => {
    setYears("scope");
    const sy = Number(filters.start.slice(0, 4));
    const ey = Number(filters.end.slice(0, 4));
    if (full && sy === ey) setDrillYear(sy);
    else setDrillYear(null);
  }, [filters.start, filters.end, full]);
  const count = weekly ? 53 : 12;
  const groups = useMemo(() => {
    const result = new Map<string, FireRecord[]>();
    for (const r of history) {
      let year = Number(r.date.slice(0, 4)),
        index = Number(r.date.slice(5, 7)) - 1;
      if (weekly) {
        const w = isoWeek(r.date);
        year = w.year;
        index = w.week - 1;
      }
      const key = `${year}-${index}`;
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(r);
    }
    return result;
  }, [history, weekly]);
  const baseline = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => {
        const nums = Array.from({ length: 12 }, (_, j) =>
          valueOf(groups.get(`${2012 + j}-${index}`) || [], filters.mode, filters.sensor),
        ).sort((a, b) => a - b);
        return (nums[5] + nums[6]) / 2;
      }),
    [groups, count, filters.mode, filters.sensor],
  );
  const viirsOnly =
    filters.sensor === "VIIRS" ||
    (filters.matches.length > 0 && !filters.matches.includes("MODIS-Only"));
  const startYear = Number(filters.start.slice(0, 4));
  const endYear = Number(filters.end.slice(0, 4));
  const yearList = drillYear !== null
    ? [drillYear]
    : full
      ? Array.from({ length: 27 }, (_, i) => 2000 + i).filter((y) =>
          years === "scope"
            ? y >= startYear && y <= endYear
            : years === "all" || y >= Number(years),
        )
      : Array.from({ length: 8 }, (_, i) => 2017 + i);

  const cells = useMemo(
    () =>
      yearList.map((y) => {
        const has53 =
          new Date(Date.UTC(y, 0, 1)).getUTCDay() === 4 ||
          (new Date(Date.UTC(y, 0, 1)).getUTCDay() === 3 &&
            new Date(Date.UTC(y, 1, 29)).getUTCMonth() === 1);
        return Array.from({ length: count }, (_, i) => {
          const range = periodRange(y, i, weekly);
          const rows = groups.get(`${y}-${i}`) || [];
          const missing =
            (weekly && i === 52 && !has53) ||
            (y === 2000 && range.end < "2000-11-01") ||
            (viirsOnly && range.end < "2012-01-01") ||
            range.start > SNAPSHOT;
          const partial = !missing && range.end > SNAPSHOT;
          const n = missing
            ? null
            : metric === "anomaly" && (y < 2012 || partial)
              ? null
              : calendarValue(rows, metric, filters.mode, filters.sensor, baseline[i]);
          return {
            y,
            i,
            rows,
            missing,
            partial,
            n,
            range,
            obs: valueOf(rows, filters.mode, filters.sensor),
          };
        });
      }),
    [
      yearList.join(),
      count,
      groups,
      metric,
      filters.mode,
      filters.sensor,
      baseline,
      viirsOnly,
      weekly,
    ],
  );
  const values = cells
    .flat()
    .filter((c) => c.n !== null)
    .map((c) => c.n as number);
  const maxValue = metric === "frp" ? 180 : Math.max(1, ...values);
  const sorted = [...values].sort((a, b) => a - b);
  // Significant = top decile of displayed values (or > +75% for anomalies); marked with a flame glyph.
  const significant =
    metric === "anomaly" ? 75 : (sorted[Math.floor(sorted.length * 0.9)] ?? Infinity);
  const yearTotals = cells.map((row) => {
    const avail = row.filter((c) => !c.missing);
    if (!avail.length) return null;
    if (metric === "frp") return Math.max(0, ...avail.map((c) => (c.n as number) || 0));
    if (metric === "anomaly") {
      const ok = avail.filter((c) => c.n !== null);
      return ok.length ? ok.reduce((s, c) => s + (c.n as number), 0) / ok.length : null;
    }
    return avail.reduce((s, c) => s + c.obs, 0);
  });
  const maxYear = Math.max(1, ...yearTotals.map((v) => Math.abs(v ?? 0)));
  const color = (n: number | null, missing: boolean) => {
    if (missing || n === null) return undefined;
    if (metric === "anomaly") return DIV.find((d) => n <= d.max)!.color;
    if (n === 0) return "#FFFFFF";
    return SEQ[Math.min(9, Math.floor((n / maxValue) * 10))];
  };
  const unit = metricUnit(metric, filters.mode);
  const describe = (c: (typeof cells)[number][number]) =>
    `${c.y} ${weekly ? `ISO week ${c.i + 1}` : MONTHS[c.i]}: ${c.missing ? "No source data available (not zero)" : c.n === null ? "Insufficient compatible baseline" : `${fmt(c.n)} ${unit}`}${c.partial ? " · partial coverage through 15 Apr 2026" : ""}${c.n !== null && c.n >= significant && c.n > 0 ? " · significant activity" : ""}`;

  return (
    <section className={`matrix ${full ? "matrix-full" : ""}`} aria-label="Thermal history matrix">
      <header className="matrix-head">
        <div>
          <span className="eyebrow">
            THERMAL HISTORY MATRIX · {full ? "2000–2026" : "2017–2024 PREVIEW"}
          </span>
          <h2>
            <Icon name="calendar" size={18} />
            Historical burning activity
          </h2>
        </div>
        <div className="matrix-actions">
          {drillYear !== null && (
            <Button
              variant="primary"
              icon="reset"
              onClick={() => {
                setDrillYear(null);
                if (startYear === endYear) setYears("all");
              }}
            >
              Back to all years
            </Button>
          )}
          {full && drillYear === null && (
            <Select
              aria-label="Calendar year range"
              value={years}
              onChange={(e) => setYears(e.target.value)}
            >
              <option value="scope">
                {startYear === endYear
                  ? `${startYear} · time context`
                  : `${startYear}–${endYear} · time context`}
              </option>
              <option value="all">2000–2026 · all years</option>
              <option value="2012">2012–2026 · multi-sensor era</option>
              <option value="2020">2020–2026 · recent</option>
            </Select>
          )}
          {!full && onExpand && (
            <button className="text-link" onClick={onExpand}>
              Open full matrix
              <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
      </header>
      <div className="matrix-toolbar">
        <Segment
          value={metric}
          onChange={onMetric}
          options={[
            { value: "count", label: "Fire count" },
            { value: "frp", label: "FRP intensity" },
            { value: "anomaly", label: "Anomaly %" },
          ]}
        />
        <Segment
          className="period-segment"
          value={weekly ? "week" : "month"}
          onChange={(v) => onWeekly(v === "week")}
          options={[
            { value: "month", label: "Months" },
            { value: "week", label: "ISO weeks" },
          ]}
        />
      </div>
      <p className="matrix-metric-note">
        {metric === "count"
          ? `${filters.mode === "raw" ? "Raw source detections" : "Harmonized analytical records (1 km cell × UTC day)"} per period · linear scale.`
          : metric === "frp"
            ? "Maximum fire radiative power (MW) of any source observation in the period · scale capped at 180 MW."
            : `Percent change vs. the 2012–2023 median for the same ${weekly ? "ISO week" : "month"} · pre-2012 and partial periods excluded.`}
      </p>
      <div className="matrix-scroll">
        <div
          className={`matrix-grid ${weekly ? "weekly" : ""}`}
          role="grid"
          aria-label={`${weekly ? "ISO weekly" : "Monthly"} ${unit}, ${filters.mode} data`}
          style={{ "--columns": count } as CSSProperties}
        >
          <div className="matrix-row matrix-axis" role="row">
            <span className="axis-label" role="columnheader">
              Year
            </span>
            {Array.from({ length: count }, (_, i) => (
              <span key={i} role="columnheader">
                {weekly ? (i % 4 === 0 ? `W${i + 1}` : "") : MONTHS[i]}
              </span>
            ))}
            <span className="axis-label total-head" role="columnheader">
              {metric === "count" ? "Year total" : metric === "frp" ? "Year max" : "Mean Δ"}
            </span>
          </div>
          {cells.map((row, ri) => (
            <div className="matrix-row" key={row[0].y} role="row">
              <button
                type="button"
                className={`year-label ${Number(filters.start.slice(0, 4)) === row[0].y ? "active-year" : ""}`}
                role="rowheader"
                onClick={() => {
                  if (weekly) onWeekly(false);
                  setDrillYear(row[0].y);
                }}
                title={`Click to drill down into ${row[0].y} months`}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "inherit",
                  font: "inherit",
                  padding: 0,
                  textDecoration: drillYear === null ? "underline dotted rgba(81,214,240,0.45)" : "none",
                }}
              >
                {row[0].y}
                {row[0].y === 2012 && <i title="Suomi-NPP VIIRS coverage begins" />}
              </button>
              {row.map((c) => {
                const isSel =
                  !!selected &&
                  selected.year === c.y &&
                  selected.index === c.i &&
                  selected.weekly === weekly;
                const sig = c.n !== null && c.n > 0 && c.n >= significant;
                const fill = color(c.n, c.missing);
                return (
                  <button
                    key={c.i}
                    role="gridcell"
                    aria-selected={isSel}
                    aria-label={describe(c)}
                    title={describe(c)}
                    disabled={c.missing}
                    className={`cell ${c.missing ? "missing" : ""} ${c.n === null && !c.missing ? "nobase" : ""} ${c.n === 0 ? "zero" : ""} ${c.partial ? "partial" : ""} ${isSel ? "selected" : ""} ${sig ? "significant" : ""}`}
                    style={fill ? { backgroundColor: fill } : undefined}
                    onMouseEnter={() =>
                      setHover({
                        year: c.y,
                        index: c.i,
                        n: c.n,
                        count: c.obs,
                        missing: c.missing,
                        partial: c.partial,
                      })
                    }
                    onFocus={() =>
                      setHover({
                        year: c.y,
                        index: c.i,
                        n: c.n,
                        count: c.obs,
                        missing: c.missing,
                        partial: c.partial,
                      })
                    }
                    onClick={() => onPeriod(c.y, c.i, weekly)}
                    onDoubleClick={() => onClearPeriod?.()}
                  >
                    {isSel && sig ? (
                      <Flame size={weekly ? 9 : 13} className="cell-flame" />
                    ) : sig && !weekly ? (
                      <span className="cell-glyph" aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
              <span
                className="year-total"
                title={`${row[0].y}: ${yearTotals[ri] === null ? "no data" : fmt(yearTotals[ri] as number)}`}
              >
                <span className="yt-track">
                  <i
                    style={{ width: `${(Math.abs(yearTotals[ri] ?? 0) / maxYear) * 100}%` }}
                    className={(yearTotals[ri] ?? 0) < 0 ? "negative" : ""}
                  />
                </span>
                <span>
                  {yearTotals[ri] === null
                    ? "—"
                    : metric === "anomaly"
                      ? `${(yearTotals[ri] as number) >= 0 ? "+" : ""}${(yearTotals[ri] as number).toFixed(0)}%`
                      : compact(yearTotals[ri] as number)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="matrix-legend">
        <div className="legend-scale">
          <span>{metric === "anomaly" ? "Below baseline" : "Low"}</span>
          {(metric === "anomaly" ? DIV.map((d) => d.color) : SEQ).map((c, i) => (
            <i
              key={i}
              style={{ background: c }}
              title={metric === "anomaly" ? DIV[i].label : undefined}
            />
          ))}
          <span>
            {metric === "anomaly"
              ? "Above"
              : metric === "frp"
                ? "180+ MW"
                : `${compact(maxValue)} max`}
          </span>
        </div>
        <div className="legend-states">
          <span>
            <i className="state zero" />
            Zero
          </span>
          <span>
            <i className="state missing" />
            No data
          </span>
          <span>
            <i className="state partial" />
            Partial
          </span>
          <span>
            <span className="cell-glyph static" />
            Top 10%
          </span>
        </div>
      </div>
      <div className="matrix-hover" aria-live="polite">
        {hover ? (
          <>
            <strong>
              {hover.year} · {weekly ? `ISO week ${hover.index + 1}` : MONTHS[hover.index]}
            </strong>
            <span>
              {hover.missing
                ? "Data unavailable — not zero"
                : hover.n === null
                  ? "Insufficient compatible baseline"
                  : `${fmt(hover.n)} ${unit}`}
            </span>
            <span className="muted-dark">
              {hover.missing
                ? "Outside source coverage"
                : `${fmt(hover.count)} ${filters.mode === "raw" ? "detections" : "records"}${hover.partial ? " · partial" : ""} · Gold`}
            </span>
          </>
        ) : (
          <>
            <Icon name="info" size={14} />
            <span>
              Hover to read a period. Select a cell to filter the globe, trends, and KPIs to that
              period.
            </span>
          </>
        )}
      </div>
      {drillYear !== null && !weekly && cells[0] && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(125px, 1fr))",
            gap: 8,
            marginTop: 12,
            marginBottom: 12,
          }}
        >
          {cells[0].map((c) => {
            const isSel =
              !!selected && selected.year === c.y && selected.index === c.i && !selected.weekly;
            return (
              <button
                key={c.i}
                type="button"
                disabled={c.missing}
                onClick={() => onPeriod(c.y, c.i, false)}
                onDoubleClick={() => onClearPeriod?.()}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: isSel ? "1px solid #0B6FA4" : "1px solid rgba(15, 38, 60, 0.14)",
                  background: isSel ? "rgba(32, 188, 229, 0.14)" : "#ffffff",
                  color: "#0f263c",
                  cursor: c.missing ? "not-allowed" : "pointer",
                  opacity: c.missing ? 0.5 : 1,
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>
                  {MONTHS[c.i]} {c.y}
                </span>
                <span style={{ fontSize: 12, color: "#2b4b68" }}>
                  {c.missing
                    ? "Unavailable"
                    : c.n === null
                      ? "No baseline"
                      : `${fmt(c.n)} ${metric === "anomaly" ? "%" : metric === "frp" ? "MW" : ""}`}
                </span>
                <span style={{ fontSize: 11, color: "#5e7890" }}>
                  {c.missing ? "—" : `${fmt(c.obs)} ${filters.mode === "raw" ? "det." : "rec."}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {inspector}
      {full && (
        <div className="coverage-strip">
          <Icon name="satellite" size={16} />
          <span>
            <strong>Coverage matters.</strong> Demo MODIS from Nov 2000 · VIIRS from 2012 · 2026
            partial through 15 Apr. Hatched cells are unavailable, never zero. ISO week 53 exists
            only in long ISO years.
          </span>
        </div>
      )}
    </section>
  );
}
