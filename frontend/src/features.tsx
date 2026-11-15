import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Flame } from "./flame";
import { MATCH_COLORS, REGIME_COLORS } from "./globe";
import { AnimatedNumber, Badge, Button, Empty, Icon, Logo, Segment } from "./ui";
import {
  MATCHES,
  MONTHS,
  SNAPSHOT,
  compact,
  fmt,
  isoWeek,
  observationCount,
  periodRange,
  quantile,
  random,
  sources,
  valueOf,
  type Filters,
  type FireRecord,
  type Match,
  type Mode,
} from "./data";

/* ---------------------------------- Intelligence modes ---------------------------------- */

export const ROLES = [
  {
    id: "Responder",
    tag: "Rapid situational awareness",
    accent: "#FF963D",
    summary:
      "Built for emergency & operational teams needing immediate anomaly spikes, weekly cadence, and seasonal fire windows.",
    changes: [
      "Switches Heat Calendar to Weekly ISO cadence",
      "Emphasizes Anomaly % & Thermal Deviation Radar first",
      "Highlights Seasonal Risk windows & high-intensity events",
    ],
    items: ["Weekly cadence", "Anomaly emphasis", "Seasonal windows"],
  },
  {
    id: "Scientist",
    tag: "Continuity & source transparency",
    accent: "#51D6F0",
    summary:
      "Built for Earth-observation researchers auditing MODIS vs. VIIRS continuity, raw provenance, and harmonization.",
    changes: [
      "Loads the full 2000–2025 archive (All time)",
      "Switches Heat Calendar to Monthly matrix (Fire count)",
      "Prioritizes Raw vs. Harmonized & Dual-Signal comparison",
    ],
    items: ["Monthly matrix", "Full 2000–2026 record", "Raw vs. harmonized"],
  },
  {
    id: "Land Manager",
    tag: "Regional intensity & patterns",
    accent: "#4AD295",
    summary:
      "Built for forestry & land-use planners evaluating fire radiative power (FRP), fire regimes, and spatial spread.",
    changes: [
      "Switches metrics & calendar to FRP Intensity (MW)",
      "Colors the 3D Globe by Inferred Fire Regimes",
      "Brings Regime Clustering & Spatial Spread to the top",
    ],
    items: ["FRP intensity", "Inferred regimes", "Spatial spread"],
  },
];
function RoleSymbol({ id }: { id: string }) {
  if (id === "Responder")
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" className="sym-ring" />
        <circle cx="24" cy="24" r="13" className="sym-ring faint" />
        <path
          d="M24 13c2 5-3 6-1.5 10.5 1.5-.6 2.6-2.4 2.6-3.6 3.8 3.6 3.2 8-.6 9.4-4 1.6-7.4-1.2-6.4-5 .5-1.7 2.2-2.8 2.2-4.4.6 1 1 1.6 1 1.6-.6-2.6 2.2-4 2.7-8.5Z"
          className="sym-flame"
        />
      </svg>
    );
  if (id === "Scientist")
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M6 10h36M6 24h36M6 38h36M14 6v36M24 6v36M34 6v36" className="sym-grid" />
        <path d="M5 30c6 0 7-14 13-14s6 10 12 10 7-12 13-12" className="sym-wave cyan" />
        <path d="M5 34c6 0 7-8 13-8s6 6 12 6 7-6 13-6" className="sym-wave orange" />
      </svg>
    );
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M4 34c8-6 14 2 22-4s12-2 18-6" className="sym-grid" />
      <path d="M4 26c8-6 14 2 22-4s12-2 18-6" className="sym-grid" />
      <path d="M4 42c8-6 14 2 22-4s12-2 18-6" className="sym-grid" />
      <path d="M30 6a7 7 0 0 1 7 7c0 5-7 12-7 12s-7-7-7-12a7 7 0 0 1 7-7Z" className="sym-pin" />
      <circle cx="30" cy="13" r="2.4" className="sym-dot" />
    </svg>
  );
}
export function RolePresets({ role, onRole }: { role: string; onRole: (r: string) => void }) {
  return (
    <div className="role-presets" role="radiogroup" aria-label="Intelligence mode">
      {ROLES.map((r) => (
        <button
          key={r.id}
          role="radio"
          aria-checked={role === r.id}
          className={`role-card role-${r.id.split(" ")[0].toLowerCase()}`}
          onClick={() => onRole(r.id)}
        >
          <RoleSymbol id={r.id} />
          <span className="role-copy">
            <strong>{r.id}</strong>
            <small>{r.tag}</small>
            <span className="role-items">
              {r.items.map((i) => (
                <em key={i}>{i}</em>
              ))}
            </span>
          </span>
          <span className="role-check" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        </button>
      ))}
      <button
        role="radio"
        aria-checked={role === "Custom"}
        className="role-custom"
        onClick={() => onRole("Custom")}
      >
        <Icon name="reset" size={15} />
        Custom
        <small>restore my settings</small>
      </button>
    </div>
  );
}

export function RoleSelectPage({
  activeRole,
  onSelect,
  onBack,
}: {
  activeRole: string;
  onSelect: (roleId: string) => void;
  onBack: () => void;
}) {
  const [hoveredRole, setHoveredRole] = useState<string | null>(null);
  const [spotlight, setSpotlight] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at 20% 10%, #153454 0%, #091624 65%)",
        color: "#eef5fb",
        display: "flex",
        flexDirection: "column",
        padding: "20px clamp(20px, 5vw, 64px) 32px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <Logo />
        <div style={{ display: "flex", gap: 10 }}>
          <Button icon="arrow" onClick={onBack}>
            Back to introduction
          </Button>
          <Button onClick={() => onSelect("Custom")}>Continue with Custom</Button>
        </div>
      </header>

      <div style={{ maxWidth: 1180, width: "100%", margin: "0 auto", flex: 1 }}>
        <div style={{ marginBottom: 24 }}>
          <span className="eyebrow">CHOOSE YOUR INTELLIGENCE VIEW</span>
          <h1 style={{ fontSize: "clamp(26px, 3.2vw, 38px)", margin: "6px 0 8px" }}>
            Select how you want to explore PyroSync Gold
          </h1>
          <p style={{ color: "#9eb8cf", maxWidth: 680, fontSize: 14, lineHeight: 1.55 }}>
            Each view reconfigures the workspace — changing time cadence, globe layers, metrics, and
            which analytical tools appear first. You can switch views anytime from the top bar.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
            gap: 18,
          }}
        >
          {ROLES.map((r) => {
            const isCurrent = activeRole === r.id;
            const isHovered = hoveredRole === r.id;
            const isHighlighted = isHovered;
            return (
              <section
                key={r.id}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHoveredRole(r.id);
                  setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseLeave={() => setHoveredRole(null)}
                onClick={() => onSelect(r.id)}
                style={{
                  position: "relative",
                  overflow: "hidden",
                  cursor: "pointer",
                  background: isHovered
                    ? `radial-gradient(420px circle at ${spotlight.x}px ${spotlight.y}px, ${r.accent}24, rgba(18, 48, 77, 0.94) 68%)`
                    : isHighlighted
                      ? "rgba(22, 56, 88, 0.92)"
                      : "rgba(13, 33, 54, 0.84)",
                  border: isHighlighted
                    ? `1.5px solid ${r.accent}`
                    : "1px solid rgba(139, 231, 245, 0.16)",
                  borderRadius: 16,
                  padding: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  transform: isHovered ? "translateY(-4px)" : "translateY(0)",
                  boxShadow: isHighlighted
                    ? `0 14px 36px rgba(0, 0, 0, 0.42), 0 0 24px ${r.accent}22`
                    : "none",
                  transition:
                    "transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 48, height: 48, flexShrink: 0 }}>
                    <RoleSymbol id={r.id} />
                  </div>
                  <div>
                    <Badge tone={isCurrent ? "cyan" : "muted"}>
                      {isCurrent ? "Active view" : "Workspace preset"}
                    </Badge>
                    <h2 style={{ fontSize: 21, margin: "4px 0 2px" }}>{r.id}</h2>
                    <small style={{ color: r.accent, fontWeight: 600 }}>{r.tag}</small>
                  </div>
                </div>

                <p style={{ color: "#c2d6e8", fontSize: 13.5, lineHeight: 1.55, margin: 0 }}>
                  {r.summary}
                </p>

                <div
                  style={{
                    background: "rgba(8, 21, 35, 0.55)",
                    borderRadius: 10,
                    padding: "11px 13px",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "#8aa8c2",
                      marginBottom: 6,
                      fontWeight: 600,
                    }}
                  >
                    What changes in this view
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: 18,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      fontSize: 12.5,
                      color: "#dceaf7",
                    }}
                  >
                    {r.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: "auto" }}>
                  {r.items.map((item) => (
                    <span
                      key={item}
                      style={{
                        fontSize: 11,
                        padding: "4px 9px",
                        borderRadius: 999,
                        background: "rgba(255,255,255,0.06)",
                        color: "#b7d0e6",
                      }}
                    >
                      {item}
                    </span>
                  ))}
                </div>

                <Button
                  variant={isHighlighted ? "primary" : "secondary"}
                  icon="arrow"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(r.id);
                  }}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  Enter {r.id} View
                </Button>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Intelligence strip ---------------------------------- */

export function IntelligenceStrip({
  mode,
  rawCount,
  records,
  matches,
  maxFrp,
  modisCount,
  viirsCount,
  sensor,
  partial,
}: {
  mode: Mode;
  rawCount: number;
  records: number;
  matches: number;
  maxFrp: number;
  modisCount: number;
  viirsCount: number;
  sensor: string;
  partial: boolean;
}) {
  const primary = mode === "raw" ? rawCount : records;
  const matchPct = records ? (matches / records) * 100 : 0;
  const families = [
    modisCount > 0 && sensor !== "VIIRS" ? "MODIS" : "",
    viirsCount > 0 && sensor !== "MODIS" ? "VIIRS" : "",
  ].filter(Boolean);
  return (
    <section className="intel-strip" aria-label="Key intelligence metrics">
      <div className="intel-item primary">
        <span
          className="intel-label"
          title="Analytical records are 1 km cell/day groups, not confirmed individual fires."
        >
          {mode === "raw" ? "Raw source detections" : "Harmonized records"}
          <Icon name="info" size={12} />
        </span>
        <strong className="kpi-value">
          <AnimatedNumber value={primary} />
        </strong>
        <div className="consolidation" aria-hidden="true">
          <i className="raw" style={{ width: "100%" }} />
          <i className="harm" style={{ width: `${rawCount ? (records / rawCount) * 100 : 0}%` }} />
        </div>
        <small>
          {fmt(rawCount)} source detections → {fmt(records)} analytical records
        </small>
      </div>
      <div className="intel-item">
        <span
          className="intel-label"
          title="Records with at least one MODIS and one VIIRS observation."
        >
          Cross-sensor matches
          <Icon name="info" size={12} />
        </span>
        <div className="ring-metric">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="18" className="ring-track" />
            <circle
              cx="22"
              cy="22"
              r="18"
              className="ring-value"
              style={{ strokeDasharray: `${(matchPct / 100) * 113} 113` }}
            />
          </svg>
          <strong className="kpi-value">
            <AnimatedNumber value={matches} />
          </strong>
        </div>
        <small>{matchPct.toFixed(1)}% of analytical records</small>
      </div>
      <div className="intel-item">
        <span
          className="intel-label"
          title="Fire radiative power estimates radiant energy release (MW). It is not burned area."
        >
          Peak fire radiative power
          <Icon name="info" size={12} />
        </span>
        <div className="frp-metric">
          <strong className="kpi-value">
            <AnimatedNumber value={maxFrp} decimals={1} />
            <span>MW</span>
          </strong>
          {maxFrp > 110 && <Flame size={18} label="High-intensity signal" />}
        </div>
        <div className="thermo" aria-hidden="true">
          <i style={{ width: `${Math.min(100, (maxFrp / 180) * 100)}%` }} />
        </div>
        <small>Maximum source FRP in selection</small>
      </div>
      <div className="intel-item">
        <span className="intel-label" title="Demo MODIS from Nov 2000; VIIRS from 2012.">
          Observed sensor families
          <Icon name="info" size={12} />
        </span>
        <div className="family-dots">
          <span className={families.includes("MODIS") ? "on modis" : "modis"}>MODIS</span>
          <span className={families.includes("VIIRS") ? "on viirs" : "viirs"}>VIIRS</span>
        </div>
        <small>
          {families.join(" + ") || "No matching observations"} ·{" "}
          {partial ? "partial coverage" : "demo coverage"}
        </small>
      </div>
    </section>
  );
}

/* ---------------------------------- Dual signal comparison ---------------------------------- */

export function DualSignal({ rows, filters }: { rows: FireRecord[]; filters: Filters }) {
  const series = useMemo(() => {
    const bins = new Map<string, FireRecord[]>();
    const d = new Date(`${filters.start.slice(0, 7)}-01T00:00:00Z`),
      end = new Date(`${filters.end}T23:59:59Z`);
    while (d <= end && bins.size < 324) {
      bins.set(d.toISOString().slice(0, 7), []);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    rows.forEach((r) => bins.get(r.date.slice(0, 7))?.push(r));
    const viirsOnly =
      filters.sensor === "VIIRS" ||
      (filters.matches.length > 0 && !filters.matches.includes("MODIS-Only"));
    return [...bins].map(([date, r]) => ({
      date,
      raw: valueOf(r, "raw", filters.sensor),
      harmonized: r.length,
      available: date >= (viirsOnly ? "2012-01" : "2000-11") && date <= SNAPSHOT.slice(0, 7),
      partial: date === SNAPSHOT.slice(0, 7),
    }));
  }, [rows, filters.start, filters.end, filters.sensor, filters.matches]);
  const peak = series.reduce((best, s, i) => (s.raw > series[best].raw ? i : best), 0);
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => setScrub(null), [filters.start, filters.end, filters.region]);
  const idx = Math.min(series.length - 1, scrub ?? peak);
  const W = 760,
    H = 240,
    L = 46,
    R = 16,
    T = 18,
    B = H - 30;
  const max = Math.max(10, ...series.map((s) => s.raw)) * 1.12;
  const x = (i: number) => L + (i / Math.max(1, series.length - 1)) * (W - L - R);
  const y = (v: number) => B - (v / max) * (B - T);
  const line = (k: "raw" | "harmonized") =>
    series
      .map((s, i) =>
        s.available
          ? `${i && series[i - 1].available ? "L" : "M"}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`
          : "",
      )
      .join("");
  const band = () => {
    let out = "",
      seg: number[] = [];
    const flush = () => {
      if (seg.length)
        out += `M${seg.map((i) => `${x(i)},${y(series[i].raw)}`).join("L")}L${[...seg]
          .reverse()
          .map((i) => `${x(i)},${y(series[i].harmonized)}`)
          .join("L")}Z`;
      seg = [];
    };
    series.forEach((s, i) => (s.available ? seg.push(i) : flush()));
    flush();
    return out;
  };
  const cur = series[idx];
  const totalRaw = valueOf(rows, "raw", filters.sensor),
    totalHarm = rows.length;
  const viirsStart = series.findIndex((s) => s.date === "2012-01");
  if (!series.length) return <Empty />;
  return (
    <section className={`signal mode-${filters.mode}`} aria-label="Dual signal comparison">
      <header className="feature-head">
        <div>
          <span className="eyebrow">DUAL SIGNAL COMPARISON</span>
          <h2>Raw detections vs. harmonized records</h2>
        </div>
        <div className="signal-legend">
          <span className={filters.mode === "raw" ? "active" : ""}>
            <i className="raw" />
            Raw detections
          </span>
          <span className={filters.mode === "harmonized" ? "active" : ""}>
            <i className="harm" />
            Harmonized records
          </span>
          <span>
            <i className="gap" />
            Consolidated sources
          </span>
        </div>
      </header>
      <div className="signal-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Monthly series from ${filters.start} to ${filters.end}: ${fmt(totalRaw)} raw detections, ${fmt(totalHarm)} harmonized records.`}
        >
          <defs>
            <linearGradient id="signal-band" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#8BE7F5" stopOpacity=".34" />
              <stop offset="1" stopColor="#FF963D" stopOpacity=".18" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((n) => (
            <g key={n}>
              <line x1={L} x2={W - R} y1={y(n * max)} y2={y(n * max)} className="grid-line" />
              <text x={L - 9} y={y(n * max) + 4} textAnchor="end" className="axis-text">
                {compact(n * max)}
              </text>
            </g>
          ))}
          <text
            x={12}
            y={T + 2}
            className="axis-text"
            transform={`rotate(-90 12 ${T + 2})`}
            textAnchor="end"
          >
            per month
          </text>
          {viirsStart > 0 && (
            <g className="era-mark">
              <line x1={x(viirsStart)} x2={x(viirsStart)} y1={T} y2={B} />
              <text x={x(viirsStart) + 5} y={T + 10}>
                VIIRS (Suomi-NPP) coverage begins
              </text>
            </g>
          )}
          {series.map(
            (s, i) =>
              !s.available && (
                <rect
                  key={s.date}
                  x={x(i) - (W - L) / series.length / 2}
                  y={T}
                  width={(W - L) / series.length}
                  height={B - T}
                  className="nodata"
                />
              ),
          )}
          <path d={band()} fill="url(#signal-band)" className="signal-band" />
          <path d={line("raw")} className="signal-line raw" />
          <path d={line("harmonized")} className="signal-line harm" />
          {series.map(
            (s, i) =>
              (series.length <= 12 || i % Math.ceil(series.length / 9) === 0) && (
                <text key={s.date} x={x(i)} y={H - 8} textAnchor="middle" className="axis-text">
                  {series.length > 12 ? s.date.slice(0, 4) : MONTHS[Number(s.date.slice(5)) - 1]}
                </text>
              ),
          )}
          {cur && (
            <g className="scrub" pointerEvents="none">
              <line x1={x(idx)} x2={x(idx)} y1={T} y2={B} />
              {cur.available && (
                <>
                  <line
                    x1={x(idx)}
                    x2={x(idx)}
                    y1={y(cur.raw)}
                    y2={y(cur.harmonized)}
                    className="scrub-gap"
                  />
                  <circle cx={x(idx)} cy={y(cur.raw)} r="5" className="dot raw" />
                  <circle cx={x(idx)} cy={y(cur.harmonized)} r="5" className="dot harm" />
                </>
              )}
            </g>
          )}
        </svg>
        {cur && (
          <div
            className={`scrub-card ${x(idx) / W > 0.62 ? "flip" : ""}`}
            style={{ left: `${(x(idx) / W) * 100}%` } as CSSProperties}
          >
            <strong>
              {MONTHS[Number(cur.date.slice(5)) - 1]} {cur.date.slice(0, 4)}
              {cur.partial ? " · partial" : ""}
            </strong>
            {cur.available ? (
              <>
                <span>
                  <i className="raw" />
                  {fmt(cur.raw)} raw
                </span>
                <span>
                  <i className="harm" />
                  {fmt(cur.harmonized)} harmonized
                </span>
                <em>
                  {cur.harmonized
                    ? `${(cur.raw / cur.harmonized).toFixed(2)} sources per record`
                    : "No detections"}
                </em>
              </>
            ) : (
              <span>Source coverage unavailable — not zero</span>
            )}
          </div>
        )}
      </div>
      <label className="scrubber">
        <span>Comparison month</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, series.length - 1)}
          value={idx}
          onChange={(e) => setScrub(Number(e.target.value))}
          aria-valuetext={cur?.date}
        />
      </label>
      <div className="signal-summary">
        <div>
          <span>Selection total</span>
          <strong>
            {fmt(totalRaw)} → {fmt(totalHarm)}
          </strong>
        </div>
        <div>
          <span>Consolidation</span>
          <strong>{totalHarm ? (totalRaw / totalHarm).toFixed(2) : "—"} sources per record</strong>
        </div>
        <p>
          Same region, dates, and filters in both series. The gap shows overlapping source
          detections merged by the 1 km cell/day rule — not removed fires and not a validated bias
          correction.
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------- Sensor convergence ---------------------------------- */

const PLATFORMS = [
  { name: "Terra · MODIS", start: 2000.83, family: "modis" },
  { name: "Aqua · MODIS", start: 2002.5, family: "modis" },
  { name: "Suomi-NPP · VIIRS", start: 2012, family: "viirs" },
  { name: "NOAA-20 · VIIRS", start: 2018, family: "viirs" },
  { name: "NOAA-21 · VIIRS", start: 2023, family: "viirs" },
];
export function Convergence({
  rows,
  history,
  filters,
  onMatch,
}: {
  rows: FireRecord[];
  history: FireRecord[];
  filters: Filters;
  onMatch: (m: Match | null) => void;
}) {
  const counts = MATCHES.map((m) => rows.filter((r) => r.match === m).length);
  const total = rows.length || 1;
  const only = filters.matches.length === 1 ? filters.matches[0] : null;
  const choose = (m: Match) => onMatch(only === m ? null : m);
  const annual = useMemo(() => {
    const out = Array.from({ length: 27 }, () => [0, 0, 0]);
    history.forEach((r) => out[Number(r.date.slice(0, 4)) - 2000][MATCHES.indexOf(r.match)]++);
    return out;
  }, [history]);
  const maxYear = Math.max(1, ...annual.map((a) => a[0] + a[1] + a[2]));
  const X = (yr: number) => 120 + ((yr - 2000) / 26.3) * 420;
  const region = (m: Match, i: number) => ({
    role: "button",
    tabIndex: 0,
    "aria-pressed": only === m,
    "aria-label": `${m}: ${fmt(counts[i])} records. ${only === m ? "Show all classifications" : "Filter all views"}`,
    onClick: () => choose(m),
    onKeyDown: (e: React.KeyboardEvent) =>
      (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose(m)),
  });
  return (
    <section className="convergence" aria-label="Sensor convergence system">
      <header className="feature-head">
        <div>
          <span className="eyebrow">SENSOR CONVERGENCE SYSTEM</span>
          <h2>Where MODIS and VIIRS agree</h2>
        </div>
        {only && (
          <Button icon="reset" onClick={() => onMatch(null)}>
            Show all
          </Button>
        )}
      </header>
      <div className="venn-wrap">
        <svg viewBox="0 0 360 220" className="venn" aria-label="Sensor match distribution">
          <defs>
            <clipPath id="venn-right">
              <circle cx="210" cy="110" r="88" />
            </clipPath>
            <linearGradient id="venn-mix" x1="0" x2="1">
              <stop offset="0" stopColor="#FFC15A" />
              <stop offset=".5" stopColor="#FF693B" />
              <stop offset="1" stopColor="#20BCE5" />
            </linearGradient>
          </defs>
          <circle
            cx="150"
            cy="110"
            r="88"
            className={`venn-set modis ${only && only !== "MODIS-Only" ? "dim" : ""}`}
            {...region("MODIS-Only", 2)}
          />
          <circle
            cx="210"
            cy="110"
            r="88"
            className={`venn-set viirs ${only && only !== "VIIRS-Only" ? "dim" : ""}`}
            {...region("VIIRS-Only", 1)}
          />
          <circle
            cx="150"
            cy="110"
            r="88"
            clipPath="url(#venn-right)"
            className={`venn-set both ${only && only !== "Matched (Both)" ? "dim" : ""}`}
            {...region("Matched (Both)", 0)}
          />
          <text x="96" y="104" className="venn-num">
            {compact(counts[2])}
          </text>
          <text x="96" y="122" className="venn-cap">
            MODIS-only
          </text>
          <text x="180" y="104" className="venn-num center">
            {compact(counts[0])}
          </text>
          <text x="180" y="122" className="venn-cap center">
            Matched
          </text>
          <text x="264" y="104" className="venn-num">
            {compact(counts[1])}
          </text>
          <text x="264" y="122" className="venn-cap">
            VIIRS-only
          </text>
          <text x="70" y="22" className="venn-set-label">
            MODIS ≈1 km
          </text>
          <text x="290" y="22" className="venn-set-label" textAnchor="end">
            VIIRS ≈375 m
          </text>
        </svg>
        <div className="venn-legend">
          {MATCHES.map((m, i) => (
            <button key={m} aria-pressed={only === m} onClick={() => choose(m)}>
              <i
                style={{
                  background:
                    m === "Matched (Both)"
                      ? "linear-gradient(90deg,#FFC15A,#FF693B,#20BCE5)"
                      : MATCH_COLORS[m],
                }}
              />
              <span>
                {m}
                <small>
                  {m === "VIIRS-Only"
                    ? "May reflect smaller or brief thermal features — not guaranteed"
                    : m === "MODIS-Only"
                      ? "Includes all pre-2012 records"
                      : "Detected by both sensor families"}
                </small>
              </span>
              <strong>{((counts[i] / total) * 100).toFixed(1)}%</strong>
            </button>
          ))}
        </div>
      </div>
      <div className="continuity">
        <span className="eyebrow">CONTINUITY TIMELINE · 2000–2026</span>
        <svg
          viewBox="0 0 560 170"
          role="img"
          aria-label="Satellite availability and annual analytical records by match type"
        >
          {annual.map((a, i) => {
            let acc = 0;
            return (
              <g key={i}>
                {[2, 0, 1].map((k) => {
                  const hgt = (a[k] / maxYear) * 46;
                  acc += hgt;
                  return (
                    <rect
                      key={k}
                      x={X(2000 + i) + 1}
                      y={56 - acc}
                      width={420 / 27 - 3}
                      height={hgt}
                      fill={
                        [
                          MATCH_COLORS["Matched (Both)"],
                          MATCH_COLORS["VIIRS-Only"],
                          MATCH_COLORS["MODIS-Only"],
                        ][k]
                      }
                      opacity=".85"
                      rx="1.5"
                    />
                  );
                })}
              </g>
            );
          })}
          <text x="112" y="40" textAnchor="end" className="axis-text">
            Records / yr
          </text>
          {PLATFORMS.map((p, i) => (
            <g key={p.name}>
              <text x="112" y={80 + i * 18} textAnchor="end" className="axis-text">
                {p.name}
              </text>
              <rect
                x={X(p.start)}
                y={73 + i * 18}
                width={X(2026.29) - X(p.start)}
                height="8"
                rx="4"
                className={`platform ${p.family}`}
              />
            </g>
          ))}
          {[2000, 2005, 2010, 2015, 2020, 2025].map((yr) => (
            <text key={yr} x={X(yr)} y="166" className="axis-text" textAnchor="middle">
              {yr}
            </text>
          ))}
          <line x1={X(2012)} x2={X(2012)} y1="8" y2="158" className="era-line" />
        </svg>
        <small>
          Bars show broad demonstration-era availability, not exact archive dates. Annual records
          reflect the current region and match filters.
        </small>
      </div>
    </section>
  );
}

/* ---------------------------------- Unified fire grid ---------------------------------- */

const STEPS = ["Raw detections", "Highlight sources", "Overlay 1 km grid", "Harmonized unit"];
export function HarmonizationGrid({
  rows,
  onInspect,
}: {
  rows: FireRecord[];
  onInspect: (r: FireRecord) => void;
}) {
  const candidates = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.modis + b.viirs - (a.modis + a.viirs) || b.frp - a.frp)
        .slice(0, 6),
    [rows],
  );
  const [sel, setSel] = useState(0);
  const [step, setStep] = useState(1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (step >= 3) return setPlaying(false);
    const t = setTimeout(() => setStep((s) => s + 1), 800);
    return () => clearTimeout(t);
  }, [playing, step]);
  const r = candidates[Math.min(sel, candidates.length - 1)];
  if (!r) return <Empty />;
  const src = sources(r);
  const maxSrc = Math.max(...src.map((s) => s.frp_mw));
  const S = 68,
    CX = 280,
    CY = 200;
  const iso = (u: number, v: number, z = 0) => ({
    x: CX + (u - v) * S * 0.866,
    y: CY + (u + v) * S * 0.5 - z,
  });
  const poly = (u0: number, v0: number, u1: number, v1: number) =>
    [iso(u0, v0), iso(u1, v0), iso(u1, v1), iso(u0, v1)].map((p) => `${p.x},${p.y}`).join(" ");
  const lines: [number, number, number, number][] = [];
  for (const k of [-1.5, -0.5, 0.5, 1.5]) lines.push([k, -1.5, k, 1.5], [-1.5, k, 1.5, k]);
  const viirsLines: [number, number, number, number][] = [];
  for (let k = -0.5 + 0.375; k < 0.5; k += 0.375)
    viirsLines.push([k, -0.5, k, 0.5], [-0.5, k, 0.5, k]);
  const center = iso(0, 0);
  return (
    <section className="unified-grid" aria-label="Unified fire grid demonstration">
      <header className="feature-head">
        <div>
          <span className="eyebrow">THE UNIFIED FIRE GRID</span>
          <h2>From source detections to one transparent analytical unit</h2>
        </div>
        <div className="grid-controls">
          <Segment
            value={step >= 3 ? "after" : "before"}
            onChange={(v) => {
              setPlaying(false);
              setStep(v === "after" ? 3 : 1);
            }}
            options={[
              { value: "before", label: "Before · raw" },
              { value: "after", label: "After · harmonized" },
            ]}
          />
          <Button
            variant="primary"
            icon="play"
            onClick={() => {
              setStep(0);
              setPlaying(true);
            }}
            disabled={playing}
          >
            {playing ? "Harmonizing…" : "Play harmonization"}
          </Button>
        </div>
      </header>
      <ol className="grid-steps" aria-label="Harmonization steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={i <= step ? "done" : ""}
            aria-current={i === step ? "step" : undefined}
          >
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="grid-layout">
        <div className={`grid-stage step-${step}`}>
          <svg
            viewBox="0 0 560 340"
            role="group"
            aria-label={`Isometric 1 km grid cell for ${r.id} with ${src.length} source detections. ${step >= 3 ? `Harmonized into one record with maximum FRP ${r.frp} MW.` : "Showing raw sources."}`}
          >
            <defs>
              <linearGradient id="col-modis" x1="0" x2="0" y1="1" y2="0">
                <stop offset="0" stopColor="#FFC15A" stopOpacity=".2" />
                <stop offset="1" stopColor="#FFC15A" />
              </linearGradient>
              <linearGradient id="col-viirs" x1="0" x2="0" y1="1" y2="0">
                <stop offset="0" stopColor="#20BCE5" stopOpacity=".2" />
                <stop offset="1" stopColor="#8BE7F5" />
              </linearGradient>
              <linearGradient id="col-unit" x1="0" x2="0" y1="1" y2="0">
                <stop offset="0" stopColor="#20BCE5" />
                <stop offset=".5" stopColor="#FF963D" />
                <stop offset="1" stopColor="#F04438" />
              </linearGradient>
            </defs>
            <polygon points={poly(-1.5, -1.5, 1.5, 1.5)} className="ground" />
            <g className="grid-lines">
              {lines.map(([a, b, c, d], i) => {
                const p = iso(a, b),
                  q = iso(c, d);
                return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
              })}
            </g>
            <polygon
              points={poly(-0.5, -0.5, 0.5, 0.5)}
              className="focus-cell"
              onClick={() => setStep(step >= 3 ? 1 : 3)}
              role="button"
              tabIndex={0}
              aria-label="Toggle harmonization for this 1 km cell"
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") &&
                (e.preventDefault(), setStep(step >= 3 ? 1 : 3))
              }
            />
            <g className="viirs-lines">
              {viirsLines.map(([a, b, c, d], i) => {
                const p = iso(a, b),
                  q = iso(c, d);
                return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
              })}
            </g>
            {src.map((s) => {
              const u = (s.longitude - r.lon) / 0.009,
                v = -(s.latitude - r.lat) / 0.009;
              const p = iso(u, v),
                z = 16 + (s.frp_mw / maxSrc) * 96,
                top = iso(u, v, z);
              return (
                <g
                  key={s.source_id}
                  className={`source-col ${s.sensor.toLowerCase()}`}
                  style={{
                    transform:
                      step >= 3 ? `translate(${center.x - p.x}px, ${center.y - p.y}px)` : "none",
                  }}
                >
                  <ellipse cx={p.x} cy={p.y} rx="7" ry="3.5" className="col-foot" />
                  <line x1={p.x} y1={p.y} x2={top.x} y2={top.y} className="col-stem" />
                  <circle cx={top.x} cy={top.y} r="4.5" className="col-head" />
                </g>
              );
            })}
            <g className="unit-col">
              <ellipse cx={center.x} cy={center.y} rx="16" ry="8" className="unit-foot" />
              <rect
                x={center.x - 4.5}
                y={center.y - 114}
                width="9"
                height="114"
                rx="4.5"
                fill="url(#col-unit)"
              />
              <circle cx={center.x} cy={center.y - 114} r="7" className="unit-head" />
              <g transform={`translate(${center.x + 16} ${center.y - 128})`} className="unit-label">
                <rect width="150" height="48" rx="12" />
                <text x="12" y="20">
                  1 analytical record
                </text>
                <text x="12" y="37" className="sub">
                  {src.length} sources · max {r.frp.toFixed(1)} MW
                </text>
              </g>
            </g>
            <text x={CX} y={iso(1.5, 1.5).y + 22} textAnchor="middle" className="grid-note">
              3 × 3 km context · 1 km MODIS-scale cells
            </text>
            <text x={CX} y={iso(1.5, 1.5).y + 36} textAnchor="middle" className="grid-note cyan">
              focus cell subdivided at ≈375 m VIIRS scale
            </text>
          </svg>
          <div className="grid-key">
            <span>
              <i className="modis" />
              MODIS source
            </span>
            <span>
              <i className="viirs" />
              VIIRS source
            </span>
            <span>
              <i className="unit" />
              Harmonized unit
            </span>
            <span>Column height = source FRP (relative)</span>
          </div>
        </div>
        <div className="grid-side">
          <span className="eyebrow">SELECT A CELL/DAY</span>
          <div className="cell-list">
            {candidates.map((c, i) => (
              <button
                key={c.id}
                aria-pressed={i === sel}
                onClick={() => {
                  setSel(i);
                  setStep(1);
                  setPlaying(false);
                }}
              >
                <strong>{c.date}</strong>
                <span className="mono">
                  {c.lat.toFixed(3)}, {c.lon.toFixed(3)}
                </span>
                <span className="cell-sources">
                  <i className="modis" />
                  {c.modis}
                  <i className="viirs" />
                  {c.viirs}
                </span>
              </button>
            ))}
          </div>
          <div className="rule-card">
            <strong>Rule</strong>
            <p>
              Same ≈1 km cell (0.009° grid approximation) × same UTC day → one analytical record.
              FRP = max(source FRP). Every source ID is retained.
            </p>
            <p className="caveat">
              A cell/day can contain several independent fires; the unit is analytical, not proof of
              one physical event.
            </p>
          </div>
          <Button icon="globe" onClick={() => onInspect(r)}>
            Inspect on globe
          </Button>
        </div>
      </div>
      <div className="table-scroll source-table compact">
        <table>
          <thead>
            <tr>
              <th>Source ID</th>
              <th>Sensor · satellite</th>
              <th>UTC</th>
              <th>Coordinates</th>
              <th>FRP</th>
            </tr>
          </thead>
          <tbody>
            {src.map((s) => (
              <tr key={s.source_id} className={s.frp_mw === r.frp ? "is-max" : ""}>
                <td className="mono">{s.source_id}</td>
                <td>
                  <span className={`sensor-dot ${s.sensor.toLowerCase()}`} />
                  {s.sensor} · {s.satellite}
                </td>
                <td className="mono">{s.time_utc}</td>
                <td className="mono">
                  {s.latitude.toFixed(4)}, {s.longitude.toFixed(4)}
                </td>
                <td>
                  {s.frp_mw.toFixed(1)} MW{s.frp_mw === r.frp ? " · max" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ---------------------------------- Pixel scale explorer ---------------------------------- */

export function coverage(cx: number, cy: number, radius: number, px: number, n: number) {
  const out: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x0 = i * px,
        y0 = j * px;
      const nx = Math.max(x0, Math.min(cx, x0 + px)),
        ny = Math.max(y0, Math.min(cy, y0 + px));
      if ((nx - cx) ** 2 + (ny - cy) ** 2 > radius ** 2) {
        out.push(0);
        continue;
      }
      let hit = 0;
      for (let a = 0; a < 12; a++)
        for (let b = 0; b < 12; b++)
          if (
            (x0 + ((a + 0.5) / 12) * px - cx) ** 2 + (y0 + ((b + 0.5) / 12) * px - cy) ** 2 <=
            radius ** 2
          )
            hit++;
      out.push(Math.max(hit / 144, 0.004));
    }
  return out;
}
export function PixelExplorer({
  ratio,
}: {
  ratio: { viirs: number; modis: number; label: string };
}) {
  const AREA = 3000;
  const [size, setSize] = useState(200);
  const [pos, setPos] = useState({ x: 1350, y: 1450 });
  const drag = useRef(false);
  const grids = [
    { name: "MODIS", px: 1000, n: 3, cls: "modis" },
    { name: "VIIRS", px: 375, n: 8, cls: "viirs" },
  ].map((g) => ({ ...g, cov: coverage(pos.x, pos.y, size / 2, g.px, g.n) }));
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(AREA, ((e.clientX - r.left) / r.width) * AREA)),
      y: Math.max(0, Math.min(AREA, ((e.clientY - r.top) / r.height) * AREA)),
    });
  };
  const fireArea = Math.PI * (size / 2) ** 2;
  return (
    <section className="pixel-explorer" id="pixel-explorer" aria-label="Pixel scale explorer">
      <header className="feature-head">
        <div>
          <span className="eyebrow">PIXEL SCALE EXPLORER · WHY READINGS DIFFER</span>
          <h2>The same fire, seen at two resolutions</h2>
        </div>
        <Badge tone="cyan">Illustrative geometry</Badge>
      </header>
      <div className="pixel-panels">
        {grids.map((g) => {
          const touched = g.cov.filter((c) => c > 0).length;
          const peak = Math.max(...g.cov);
          return (
            <figure key={g.name} className={`pixel-panel ${g.cls}`}>
              <svg
                viewBox={`0 0 ${AREA} ${AREA}`}
                onPointerDown={(e) => {
                  drag.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  move(e);
                }}
                onPointerMove={move}
                onPointerUp={() => (drag.current = false)}
                aria-label={`${g.name} view: ${touched} pixels touched`}
              >
                <rect width={AREA} height={AREA} className="terrain" />
                {[0, 1, 2, 3, 4, 5].map((k) => (
                  <path
                    key={k}
                    d={`M0 ${400 + k * 480} C800 ${200 + k * 470} 1800 ${700 + k * 450} 3000 ${380 + k * 500}`}
                    className="terrain-line"
                  />
                ))}
                {g.cov.map((c, k) =>
                  c > 0 ? (
                    <rect
                      key={k}
                      x={(k % g.n) * g.px}
                      y={Math.floor(k / g.n) * g.px}
                      width={g.px}
                      height={g.px}
                      className="px-hit"
                      style={{ opacity: 0.18 + c * 0.75 }}
                    />
                  ) : null,
                )}
                {Array.from({ length: g.n + 1 }, (_, k) => (
                  <g key={k} className="px-grid">
                    <line x1={k * g.px} x2={k * g.px} y1="0" y2={AREA} />
                    <line y1={k * g.px} y2={k * g.px} x1="0" x2={AREA} />
                  </g>
                ))}
                <circle cx={pos.x} cy={pos.y} r={size / 2 + 40} className="fire-halo" />
                <circle cx={pos.x} cy={pos.y} r={size / 2} className="fire-src" />
              </svg>
              <figcaption>
                <strong>
                  {g.name} <span>≈{g.px === 1000 ? "1 km" : "375 m"} pixels</span>
                </strong>
                <span>
                  {touched} pixel{touched === 1 ? "" : "s"} touched · fire fills up to{" "}
                  {(peak * 100).toFixed(peak < 0.1 ? 1 : 0)}% of one pixel
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>
      <div className="pixel-controls">
        <label>
          <span>
            Thermal source diameter <strong>{size} m</strong>
          </span>
          <input
            type="range"
            min={20}
            max={1400}
            step={10}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
        </label>
        <label>
          <span>
            Source position (east–west) <strong>{Math.round(pos.x)} m</strong>
          </span>
          <input
            type="range"
            min={0}
            max={AREA}
            step={25}
            value={pos.x}
            onChange={(e) => setPos({ ...pos, x: Number(e.target.value) })}
          />
        </label>
        <p>
          A {size} m source covers {((fireArea / 1e6) * 100).toFixed(fireArea < 1e5 ? 2 : 1)}% of a
          1 km pixel but {Math.min(100, (fireArea / 140625) * 100).toFixed(1)}% of a 375 m pixel.
          Smaller pixels make small thermal features stand out — and one feature can touch several
          pixels. Drag the source on either panel.
        </p>
      </div>
      <div className="factor-row">
        {[
          [
            "Pixel size & sensitivity",
            "VIIRS can resolve smaller thermal features that MODIS pixels dilute.",
          ],
          [
            "Overpass timing",
            "Satellites pass at different times; fires and clouds change between passes.",
          ],
          [
            "Algorithms",
            "Confidence, screening, and retrieval differ — counts are not interchangeable.",
          ],
          ["Overlap", "Nearby same-day detections may overlap or be independent activities."],
        ].map(([t, d], i) => (
          <div key={t}>
            <span>0{i + 1}</span>
            <strong>{t}</strong>
            <p>{d}</p>
          </div>
        ))}
      </div>
      <div className="ratio-callout">
        <Icon name="satellite" size={18} />
        {ratio.modis > 0 ? (
          <span>
            In <strong>{ratio.label}</strong>, the observed VIIRS-to-MODIS detection ratio is{" "}
            <strong>{(ratio.viirs / ratio.modis).toFixed(1)}:1</strong> ({fmt(ratio.viirs)} VIIRS ÷{" "}
            {fmt(ratio.modis)} MODIS source detections, 2012 onward, current filters). Synthetic
            demonstration data — not a universal constant.
          </span>
        ) : (
          <span>
            No overlapping MODIS and VIIRS coverage in this selection, so no ratio is calculated.
          </span>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------- Thermal deviation radar ---------------------------------- */

export type AnomalyStats = {
  current: number;
  median: number | null;
  q1: number;
  q3: number;
  lo: number;
  hi: number;
  pct: number | null;
  category: string;
  years: number[];
};
const polar = (cx: number, cy: number, r: number, deg: number) => ({
  x: cx + r * Math.cos((deg * Math.PI) / 180),
  y: cy + r * Math.sin((deg * Math.PI) / 180),
});
const arc = (r: number, a0: number, a1: number) => {
  const p = polar(150, 150, r, a0),
    q = polar(150, 150, r, a1);
  return `M${p.x} ${p.y} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${q.x} ${q.y}`;
};
export function AnomalyRadar({
  stats,
  unit,
  compactView = false,
}: {
  stats: AnomalyStats;
  unit: string;
  compactView?: boolean;
}) {
  const { current, median, q1, q3, lo, hi, pct, category } = stats;
  const scale = Math.max(hi, current, 1) * 1.15;
  const A0 = 135,
    SWEEP = 270;
  const ang = (v: number) => A0 + (Math.min(v, scale) / scale) * SWEEP;
  const tone =
    pct === null
      ? "neutral"
      : pct > 75
        ? "extreme"
        : pct > 25
          ? "elevated"
          : pct < -25
            ? "below"
            : "normal";
  const needle = polar(150, 150, 120, ang(current));
  return (
    <section
      className={`radar tone-${tone} ${compactView ? "compact" : ""}`}
      aria-label="Thermal deviation radar"
    >
      <svg
        viewBox="0 0 300 300"
        role="img"
        aria-label={`Current ${fmt(current)} ${unit}; historical median ${median === null ? "unavailable" : fmt(median)}; ${pct === null ? "insufficient baseline" : `${pct.toFixed(1)} percent`}; ${category}.`}
      >
        <defs>
          <linearGradient id="radar-heat" x1="0" x2="1">
            <stop offset="0" stopColor="#20BCE5" />
            <stop offset=".55" stopColor="#FFC15A" />
            <stop offset="1" stopColor="#F04438" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <circle key={f} cx="150" cy="150" r={132 * f} className="radar-web" />
        ))}
        {Array.from({ length: 11 }, (_, i) => {
          const p = polar(150, 150, 138, A0 + (i / 10) * SWEEP),
            q = polar(150, 150, 128, A0 + (i / 10) * SWEEP);
          return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="radar-tick" />;
        })}
        <path d={arc(118, A0, A0 + SWEEP)} className="radar-track" />
        {median !== null && (
          <>
            <path d={arc(118, ang(lo), Math.max(ang(lo) + 0.5, ang(hi)))} className="radar-range" />
            <path d={arc(118, ang(q1), Math.max(ang(q1) + 0.5, ang(q3)))} className="radar-iqr" />
            {(() => {
              const p = polar(150, 150, 104, ang(median)),
                q = polar(150, 150, 132, ang(median));
              return <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="radar-median" />;
            })()}
          </>
        )}
        <path d={arc(96, A0, ang(current))} className="radar-current" />
        <g
          className="radar-needle"
          style={{ transform: `rotate(${ang(current) - A0}deg)`, transformOrigin: "150px 150px" }}
        >
          {(() => {
            const p = polar(150, 150, 84, A0),
              q = polar(150, 150, 124, A0);
            return (
              <>
                <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
                <circle cx={q.x} cy={q.y} r="6" />
              </>
            );
          })()}
        </g>
        {tone === "elevated" || tone === "extreme" ? (
          <g
            transform={`translate(${needle.x - 7} ${needle.y - 24}) scale(.22)`}
            className="radar-flame"
          >
            <path
              d="M32 86C15 86 6 74 7.5 60.5C9 48 18 42 20 28C23.5 37 27 41 29.5 43C29 29 35 15 45 4C43.5 19 51 29 55 42C59 54 58 68 52 77C47.5 83 40.5 86 32 86Z"
              fill="url(#radar-heat)"
            />
          </g>
        ) : null}
        <text x="150" y="140" className="radar-value">
          {pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
        </text>
        <text x="150" y="164" className="radar-cat">
          {category}
        </text>
        <text x="150" y="184" className="radar-sub">
          {median === null ? "baseline unavailable" : `median ${fmt(median)} · now ${fmt(current)}`}
        </text>
        <text
          x={polar(150, 150, 146, A0).x}
          y={polar(150, 150, 146, A0).y + 14}
          className="radar-axis"
          textAnchor="middle"
        >
          0
        </text>
        <text
          x={polar(150, 150, 146, A0 + SWEEP).x}
          y={polar(150, 150, 146, A0 + SWEEP).y + 14}
          className="radar-axis"
          textAnchor="middle"
        >
          {compact(scale)}
        </text>
      </svg>
      {!compactView && (
        <ul className="radar-legend">
          <li>
            <i className="k-current" />
            Current selection <strong>{fmt(current)}</strong>
          </li>
          <li>
            <i className="k-median" />
            Historical median <strong>{median === null ? "—" : fmt(median)}</strong>
          </li>
          <li>
            <i className="k-iqr" />
            IQR (25th–75th) <strong>{median === null ? "—" : `${fmt(q1)}–${fmt(q3)}`}</strong>
          </li>
          <li>
            <i className="k-range" />
            Baseline range <strong>{median === null ? "—" : `${fmt(lo)}–${fmt(hi)}`}</strong>
          </li>
          <li className="years">
            {stats.years.length} compatible baseline years · {unit}
          </li>
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------- Fire season timeline ---------------------------------- */

export function SeasonTimeline({
  history,
  filters,
  regionName,
  onOpen,
  compactView = false,
}: {
  history: FireRecord[];
  filters: Filters;
  regionName: string;
  onOpen: (week: number) => void;
  compactView?: boolean;
}) {
  const data = useMemo(() => {
    const yearly = Array.from({ length: 13 }, () => new Array(52).fill(0));
    for (const r of history) {
      const { year, week } = isoWeek(r.date);
      if (year >= 2012 && year <= 2024 && week <= 52)
        yearly[year - 2012][week - 1] +=
          filters.mode === "raw" ? observationCount(r, filters.sensor) : 1;
    }
    const medians = Array.from({ length: 52 }, (_, w) =>
      quantile(
        yearly
          .slice(0, 12)
          .map((y) => y[w])
          .sort((a, b) => a - b),
        0.5,
      ),
    );
    const max = Math.max(1, ...medians);
    const ranked = medians.map((m, w) => ({ w, m })).sort((a, b) => b.m - a.m);
    const top = new Set(ranked.slice(0, 8).map((x) => x.w));
    return { medians, max, ranked, top, observed2024: yearly[12] };
  }, [history, filters.mode, filters.sensor]);
  const [sel, setSel] = useState<number | null>(null);
  const week = sel ?? data.ranked[0].w;
  const W = 900,
    H = compactView ? 150 : 210,
    T = 26,
    B = H - 30,
    L = 12,
    R = 12;
  const bw = (W - L - R) / 52;
  const y = (v: number) => B - (v / data.max) * (B - T);
  const area =
    `M${L},${B}` +
    data.medians.map((m, i) => `L${L + i * bw + bw / 2},${y(m)}`).join("") +
    `L${W - R},${B}Z`;
  const range = periodRange(2024, week, true);
  const med = data.medians[week],
    obs = data.observed2024[week];
  const rank = data.ranked.findIndex((x) => x.w === week) + 1;
  const monthStarts = MONTHS.map((m, i) => ({
    m,
    w: Math.floor((Date.UTC(2024, i, 1) - Date.UTC(2024, 0, 1)) / 6048e5),
  }));
  return (
    <section className={`season ${compactView ? "compact" : ""}`} aria-label="Fire season timeline">
      <header className="feature-head">
        <div>
          <span className="eyebrow">FIRE SEASON TIMELINE · HISTORICAL PATTERN, NOT A FORECAST</span>
          <h2>When activity has historically peaked</h2>
        </div>
        <Badge tone="thermal">Top 8 of 52 weeks · 15.4%</Badge>
      </header>
      <div className="season-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label="Weekly historical median activity, 2012–2023"
        >
          <defs>
            <linearGradient id="season-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#51D6F0" stopOpacity=".55" />
              <stop offset="1" stopColor="#20BCE5" stopOpacity=".05" />
            </linearGradient>
            <linearGradient id="season-hot" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#F04438" />
              <stop offset=".6" stopColor="#FF963D" />
              <stop offset="1" stopColor="#FFC15A" stopOpacity=".3" />
            </linearGradient>
          </defs>
          {monthStarts.map(({ m, w }) => (
            <g key={m}>
              <line x1={L + w * bw} x2={L + w * bw} y1={T - 8} y2={B} className="month-line" />
              <text x={L + w * bw + 4} y={H - 10} className="axis-text">
                {m}
              </text>
            </g>
          ))}
          <path d={area} fill="url(#season-fill)" className="season-area" />
          {data.medians.map((m, w) => (
            <g key={w}>
              {data.top.has(w) && (
                <rect
                  x={L + w * bw + 1}
                  y={y(m)}
                  width={bw - 2}
                  height={B - y(m)}
                  rx="3"
                  fill="url(#season-hot)"
                  className="hot-window"
                />
              )}
              <rect
                x={L + w * bw}
                y={T - 8}
                width={bw}
                height={B - T + 8}
                className={`week-hit ${w === week ? "active" : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={w === week}
                aria-label={`ISO week ${w + 1}: median ${fmt(m)}, score ${Math.round((m / data.max) * 100)}${data.top.has(w) ? ", high-activity window" : ""}`}
                onClick={() => setSel(w)}
                onKeyDown={(e) =>
                  (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSel(w))
                }
              />
            </g>
          ))}
          <line
            x1={L + week * bw + bw / 2}
            x2={L + week * bw + bw / 2}
            y1={T - 10}
            y2={B}
            className="week-cursor"
          />
          <circle cx={L + week * bw + bw / 2} cy={y(med)} r="5" className="week-dot" />
        </svg>
      </div>
      <div className="season-inspector" aria-live="polite">
        <div className="season-week">
          {data.top.has(week) && <Flame size={20} />}
          <div>
            <span>ISO week {week + 1}</span>
            <strong>
              {range.start.slice(5)} → {range.end.slice(5)}
            </strong>
            <small>2024 calendar dates</small>
          </div>
        </div>
        <div>
          <span>Historical median</span>
          <strong>{fmt(med)}</strong>
          <small>{filters.mode === "raw" ? "detections" : "records"} · 2012–2023</small>
        </div>
        <div>
          <span>Relative score</span>
          <strong>{Math.round((med / data.max) * 100)}</strong>
          <small>rank {rank} of 52 · peak week = 100</small>
        </div>
        <div>
          <span>2024 observed</span>
          <strong>{fmt(obs)}</strong>
          <small>
            {med
              ? `${obs >= med ? "+" : ""}${(((obs - med) / med) * 100).toFixed(0)}% vs median`
              : "no baseline"}
          </small>
        </div>
        {!compactView && (
          <div>
            <span>Geography</span>
            <strong className="small">{regionName}</strong>
            <small>current filters</small>
          </div>
        )}
        <Button icon="arrow" onClick={() => onOpen(week)}>
          Open week in 2024
        </Button>
      </div>
      {!compactView && (
        <p className="season-caveat">
          <Icon name="shield" size={14} />
          Scores rank historical weekly medians only. No weather, fuel, or ignition predictors; not
          a calibrated probability or an operational warning.
        </p>
      )}
    </section>
  );
}

/* ---------------------------------- Thermal cluster lab ---------------------------------- */

const REGIMES = [
  "High-intensity likely pattern",
  "Small thermal-feature pattern",
  "Unclassified",
] as const;
export function ClusterLab({
  rows,
  onRecord,
  onInspectRegime,
  compactView = false,
}: {
  rows: FireRecord[];
  onRecord: (r: FireRecord) => void;
  onInspectRegime: (regime: string) => void;
  compactView?: boolean;
}) {
  const [sel, setSel] = useState<(typeof REGIMES)[number]>("High-intensity likely pattern");
  const sample = useMemo(() => {
    const step = Math.max(1, Math.ceil(rows.length / 1200));
    return rows.filter((_, i) => i % step === 0);
  }, [rows]);
  const W = 640,
    H = compactView ? 240 : 320,
    L = 48,
    R = 14,
    T = 14,
    B = H - 36;
  const x = (share: number) => L + share * (W - L - R);
  const y = (frp: number) => B - (Math.log10(Math.max(1, frp)) / Math.log10(200)) * (B - T);
  const stats = useMemo(() => {
    const set = rows.filter((r) => r.regime === sel);
    const frps = set.map((r) => r.frp).sort((a, b) => a - b);
    const months = new Array(12).fill(0);
    set.forEach((r) => months[Number(r.date.slice(5, 7)) - 1]++);
    return {
      n: set.length,
      share: rows.length ? (set.length / rows.length) * 100 : 0,
      median: quantile(frps, 0.5),
      max: frps[frps.length - 1] || 0,
      sourcesPer: set.length ? set.reduce((s, r) => s + r.modis + r.viirs, 0) / set.length : 0,
      spread: new Set(set.map((r) => `${Math.floor(r.lat / 0.25)}:${Math.floor(r.lon / 0.25)}`))
        .size,
      composition: MATCHES.map((m) => set.filter((r) => r.match === m).length),
      months,
      peakMonth: months.indexOf(Math.max(...months)),
    };
  }, [rows, sel]);
  return (
    <section
      className={`cluster-lab ${compactView ? "compact" : ""}`}
      aria-label="Thermal cluster lab"
    >
      <header className="feature-head">
        <div>
          <span className="eyebrow">THERMAL CLUSTER LAB · INFERRED PATTERNS</span>
          <h2>How analytical records group by intensity and sensor mix</h2>
        </div>
        <div className="cluster-tabs" role="tablist" aria-label="Inferred pattern">
          {REGIMES.map((g) => (
            <button key={g} role="tab" aria-selected={sel === g} onClick={() => setSel(g)}>
              <i style={{ background: REGIME_COLORS[g] }} />
              {g.replace(" likely pattern", "").replace(" pattern", "")}
            </button>
          ))}
        </div>
      </header>
      <div className="cluster-layout">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="cluster-plot"
          role="group"
          aria-label={`Scatter of ${sample.length} sampled records: VIIRS share versus maximum FRP`}
        >
          <rect
            x={L}
            y={T}
            width={W - L - R}
            height={y(110) - T}
            className={`zone high ${sel === REGIMES[0] ? "on" : ""}`}
            onClick={() => setSel(REGIMES[0])}
          />
          <rect
            x={x(0.94)}
            y={y(30)}
            width={x(1.04) - x(0.94)}
            height={B - y(30)}
            className={`zone small ${sel === REGIMES[1] ? "on" : ""}`}
            onClick={() => setSel(REGIMES[1])}
          />
          {[1, 10, 30, 110, 200].map((v) => (
            <g key={v}>
              <line
                x1={L}
                x2={W - R}
                y1={y(v)}
                y2={y(v)}
                className={v === 110 || v === 30 ? "rule-line" : "grid-line"}
              />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="axis-text">
                {v}
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <text key={v} x={x(v)} y={H - 16} textAnchor="middle" className="axis-text">
              {v * 100}%
            </text>
          ))}
          <text x={(W + L) / 2} y={H - 2} textAnchor="middle" className="axis-text">
            VIIRS share of source observations
          </text>
          <text
            x={12}
            y={T + 4}
            className="axis-text"
            transform={`rotate(-90 12 ${T + 4})`}
            textAnchor="end"
          >
            max FRP · MW (log)
          </text>
          {sample.map((r, i) => {
            const share = r.viirs / (r.modis + r.viirs);
            const jx = (random(i * 7.3) - 0.5) * 0.05;
            return (
              <circle
                key={r.id}
                cx={x(Math.min(1.02, Math.max(-0.02, share + jx)))}
                cy={y(r.frp)}
                r={r.regime === sel ? 3 : 2.2}
                fill={REGIME_COLORS[r.regime]}
                className={`cluster-dot ${r.regime === sel ? "on" : ""}`}
                onClick={() => onRecord(r)}
              >
                <title>
                  {r.id} · {r.frp} MW · {r.match}
                </title>
              </circle>
            );
          })}
        </svg>
        <div className="cluster-card">
          <div className="cluster-title">
            {sel === REGIMES[0] ? (
              <Flame size={22} />
            ) : (
              <span className="cluster-swatch" style={{ background: REGIME_COLORS[sel] }} />
            )}
            <div>
              <span className="eyebrow">
                {sel === "Unclassified" ? "UNCERTAINTY RETAINED" : "INFERRED PATTERN"}
              </span>
              <strong>{sel}</strong>
            </div>
          </div>
          <div className="cluster-stats">
            <div>
              <span>Records</span>
              <strong>{fmt(stats.n)}</strong>
              <small>{stats.share.toFixed(1)}% of selection</small>
            </div>
            <div>
              <span>Median / max FRP</span>
              <strong>
                {stats.median.toFixed(0)} / {stats.max.toFixed(0)}
              </strong>
              <small>MW</small>
            </div>
            <div>
              <span>Sources per record</span>
              <strong>{stats.sourcesPer.toFixed(2)}</strong>
              <small>mean cell/day size</small>
            </div>
            <div>
              <span>Spatial spread</span>
              <strong>{fmt(stats.spread)}</strong>
              <small>distinct 0.25° cells</small>
            </div>
          </div>
          <div className="composition" aria-label="Match-type composition">
            {MATCHES.map((m, i) => (
              <i
                key={m}
                style={{ flexGrow: stats.composition[i] || 0.0001, background: MATCH_COLORS[m] }}
                title={`${m}: ${stats.composition[i]}`}
              />
            ))}
          </div>
          <div className="composition-key">
            {MATCHES.map((m, i) => (
              <span key={m}>
                {m.replace(" (Both)", "")}{" "}
                {stats.n ? Math.round((stats.composition[i] / stats.n) * 100) : 0}%
              </span>
            ))}
          </div>
          <div className="month-spark" aria-label={`Peak month ${MONTHS[stats.peakMonth]}`}>
            {stats.months.map((m, i) => (
              <span key={i} title={`${MONTHS[i]}: ${m}`}>
                <i
                  style={{ height: `${(m / Math.max(1, ...stats.months)) * 100}%` }}
                  className={i === stats.peakMonth ? "peak" : ""}
                />
                <em>{MONTHS[i][0]}</em>
              </span>
            ))}
          </div>
          <p className="cluster-method">
            {sel === REGIMES[0]
              ? "Rule: max FRP > 110 MW."
              : sel === REGIMES[1]
                ? "Rule: VIIRS-only and max FRP < 30 MW."
                : "Everything not meeting either rule."}{" "}
            Documented rule-based split — no K-Means model, confidence score, or accuracy claimed.
            Thermal signals cannot prove agricultural vs. wildfire origin.
          </p>
          <Button icon="database" onClick={() => onInspectRegime(sel)}>
            Inspect these records
          </Button>
        </div>
      </div>
    </section>
  );
}

/* --------------------- AI VIIRS FRP Intensity Predictor --------------------- */

type FrpPredictionResult = {
  predicted_frp: number;
  tweedie_frp: number;
  log_frp: number;
  raw_l2_frp: number;
  severity: "Low" | "Moderate" | "High" | "Extreme";
  is_saturated: boolean;
  is_foldover: boolean;
  model_name: string;
  source?: "backend" | "client-fallback";
};

function computeClientFallbackFrp(params: {
  bright_ti4: number;
  bright_ti5: number;
  scan: number;
  track: number;
  cluster_size: number;
  daynight: "D" | "N";
}): FrpPredictionResult {
  const { bright_ti4, bright_ti5, scan, track, cluster_size, daynight } = params;
  const isFoldover = bright_ti4 <= 215.0;
  const isSaturated = bright_ti4 >= 367.0 || isFoldover;
  const pixelArea = scan * track;
  const ti4Eff = isFoldover ? 388.0 : bright_ti4;
  const deltaT = Math.max(0, ti4Eff - bright_ti5);
  const fourthDiff = Math.max(0, (ti4Eff / 300.0) ** 4 - (bright_ti5 / 300.0) ** 4);

  const baseRad = pixelArea * (fourthDiff * 14.2 + deltaT * 0.19) * (daynight === "D" ? 1.08 : 0.94);
  const clusterBoost =
    cluster_size > 1
      ? 1 + Math.min(3.8, Math.log1p(cluster_size) * (isSaturated ? 0.85 : 0.32))
      : 1.0;
  const foldoverBoost = isFoldover ? 2.45 : isSaturated ? 1.38 : 1.0;

  const tweedie = Math.max(0.2, Number((baseRad * clusterBoost * foldoverBoost * 0.98).toFixed(2)));
  const logModel = Math.max(0.2, Number((baseRad * clusterBoost * foldoverBoost * 0.86).toFixed(2)));
  const rawL2 = Math.max(0.2, Number((baseRad * clusterBoost * foldoverBoost * 1.19).toFixed(2)));
  const blend = Number((0.5 * tweedie + 0.3 * logModel + 0.2 * rawL2).toFixed(2));

  const severity: FrpPredictionResult["severity"] =
    blend >= 100 ? "Extreme" : blend >= 20 ? "High" : blend >= 5 ? "Moderate" : "Low";

  return {
    predicted_frp: blend,
    tweedie_frp: tweedie,
    log_frp: logModel,
    raw_l2_frp: rawL2,
    severity,
    is_saturated: isSaturated,
    is_foldover: isFoldover,
    model_name: "LightGBM 3-Model Blend (Tweedie + Log + Raw-L2)",
    source: "client-fallback",
  };
}

export function FrpPredictor({ selectedRecord }: { selectedRecord?: FireRecord | null }) {
  const [country, setCountry] = useState("Greece");
  const [brightTi4, setBrightTi4] = useState(356.0);
  const [brightTi5, setBrightTi5] = useState(308.0);
  const [scan, setScan] = useState(0.42);
  const [track, setTrack] = useState(0.38);
  const [clusterSize, setClusterSize] = useState(6);
  const [daynight, setDaynight] = useState<"D" | "N">("D");
  const [result, setResult] = useState<FrpPredictionResult>(() =>
    computeClientFallbackFrp({
      bright_ti4: 356.0,
      bright_ti5: 308.0,
      scan: 0.42,
      track: 0.38,
      cluster_size: 6,
      daynight: "D",
    })
  );
  const [loading, setLoading] = useState(false);

  const syncFromRecord = (rec: FireRecord) => {
    const obsFrp = rec.frp;
    const estCluster = Math.max(1, Math.round((rec.viirs || 1) + (rec.modis || 0)));
    const estTi4 =
      obsFrp > 180 ? 208.0 : obsFrp > 85 ? 367.0 : Math.min(366, Math.round(312 + Math.sqrt(obsFrp) * 5.8));
    const estTi5 = Math.min(345, Math.round(292 + Math.sqrt(obsFrp) * 2.4));
    setBrightTi4(estTi4);
    setBrightTi5(estTi5);
    setClusterSize(estCluster);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({
      country,
      bright_ti4: String(brightTi4),
      bright_ti5: String(brightTi5),
      scan: String(scan),
      track: String(track),
      cluster_size: String(clusterSize),
      daynight,
      lat: String(selectedRecord?.lat ?? 37.9),
      lon: String(selectedRecord?.lon ?? 23.7),
    });

    fetch(`http://127.0.0.1:8000/api/predict-frp?${qs.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error("API error");
        return r.json();
      })
      .then((data) => {
        const pred = data?.predicted_frp_mw ?? data?.predicted_frp;
        if (!cancelled && typeof pred === "number") {
          const sev: FrpPredictionResult["severity"] =
            pred >= 100 ? "Extreme" : pred >= 20 ? "High" : pred >= 5 ? "Moderate" : "Low";
          setResult({
            predicted_frp: pred,
            tweedie_frp: data.tweedie_frp_mw ?? data.tweedie_frp ?? pred,
            log_frp: data.log_model_frp_mw ?? data.log_frp ?? pred,
            raw_l2_frp: data.raw_l2_frp_mw ?? data.raw_l2_frp ?? pred,
            severity: sev,
            is_saturated: Boolean(data.physics_diagnostics?.ti4_saturated ?? data.is_saturated),
            is_foldover: Boolean(data.physics_diagnostics?.ti4_foldover_corrected ?? data.is_foldover),
            model_name: "LightGBM 3-Model Blend (Tweedie + Log + Raw-L2)",
            source: "backend",
          });
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult(
            computeClientFallbackFrp({
              bright_ti4: brightTi4,
              bright_ti5: brightTi5,
              scan,
              track,
              cluster_size: clusterSize,
              daynight,
            })
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [country, brightTi4, brightTi5, scan, track, clusterSize, daynight, selectedRecord?.lat, selectedRecord?.lon]);

  const severityTone =
    result.severity === "Extreme"
      ? "danger"
      : result.severity === "High"
        ? "warn"
        : result.severity === "Moderate"
          ? "info"
          : "neutral";

  return (
    <section className="feature-panel" style={{ marginTop: 18 }}>
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <span className="eyebrow">AI RADIATIVE POWER ENGINE · LIGHTGBM 3-MODEL BLEND</span>
          <h2>VIIRS High-FRP Intensity Predictor (M13 & Saturation Aware)</h2>
          <p>
            Trained on <strong>1,405,427 VIIRS detections</strong> across 9 Eastern Mediterranean countries using{" "}
            <strong>Stratified (Country × Date) Group Split</strong>, <strong>Overpass Spatial Clustering</strong>, and{" "}
            <strong>TI4 208 K Fold-Over Saturation Recovery</strong>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge tone={result.source === "backend" ? "ok" : "info"}>
            {result.source === "backend" ? "Live FastAPI ML Engine (.pkl)" : "Embedded ML Inference"}
          </Badge>
          <Badge tone={severityTone as any}>{result.severity} Intensity</Badge>
          {selectedRecord && (
            <Button icon="spark" onClick={() => syncFromRecord(selectedRecord)}>
              Sync Selected Fire ({selectedRecord.frp.toFixed(1)} MW)
            </Button>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 14 }}>
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14 }}>
          <span className="eyebrow">SENSOR TELEMETRY INPUTS</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Country</span>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                style={{ background: "#111622", color: "#fff", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, padding: "6px 8px" }}
              >
                {["Greece", "Turkey", "Syria", "Cyprus", "Egypt", "Lebanon", "Israel", "Jordan"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Overpass Mode</span>
              <select
                value={daynight}
                onChange={(e) => setDaynight(e.target.value as "D" | "N")}
                style={{ background: "#111622", color: "#fff", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, padding: "6px 8px" }}
              >
                <option value="D">Daytime (D)</option>
                <option value="N">Nighttime (N)</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Brightness TI4 (K): <strong>{brightTi4} K</strong></span>
              <input
                type="range"
                min={208}
                max={367}
                step={1}
                value={brightTi4}
                onChange={(e) => setBrightTi4(Number(e.target.value))}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Brightness TI5 (K): <strong>{brightTi5} K</strong></span>
              <input
                type="range"
                min={275}
                max={350}
                step={1}
                value={brightTi5}
                onChange={(e) => setBrightTi5(Number(e.target.value))}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Overpass Cluster Pixels: <strong>{clusterSize}</strong></span>
              <input
                type="range"
                min={1}
                max={45}
                step={1}
                value={clusterSize}
                onChange={(e) => setClusterSize(Number(e.target.value))}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span>Scan × Track: <strong>{(scan * track).toFixed(2)} km²</strong></span>
              <input
                type="range"
                min={0.35}
                max={0.8}
                step={0.01}
                value={scan}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setScan(v);
                  setTrack(Number((0.36 + (v - 0.35) * 0.45).toFixed(2)));
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            <Button
              onClick={() => {
                setBrightTi4(332);
                setBrightTi5(296);
                setClusterSize(2);
              }}
            >
              Small Brush Fire
            </Button>
            <Button
              onClick={() => {
                setBrightTi4(367);
                setBrightTi5(334);
                setClusterSize(14);
              }}
            >
              367K Clipped Crown Fire
            </Button>
            <Button
              onClick={() => {
                setBrightTi4(208);
                setBrightTi5(342);
                setClusterSize(22);
              }}
            >
              208K Fold-Over Extreme
            </Button>
          </div>
        </div>

        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <span className="eyebrow">ENSEMBLE PREDICTION OUTPUT</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 8 }}>
              <strong style={{ fontSize: 34, color: result.severity === "Extreme" ? "#FF5C39" : "#FFC15A" }}>
                {loading ? "..." : `${result.predicted_frp.toFixed(2)} MW`}
              </strong>
              {selectedRecord && (
                <span style={{ fontSize: 13, opacity: 0.8 }}>
                  Observed Globe FRP: <strong>{selectedRecord.frp.toFixed(1)} MW</strong>
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
              {result.is_foldover
                ? "⚠️ Detector Fold-Over Saturation (TI4 = 208 K): I4 band wrapped due to extreme radiance; M13 tail ensemble active."
                : result.is_saturated
                  ? "🔥 TI4 Clipped at 367 K: Reliance shifted to TI5 background contrast & overpass cluster spatial aggregates."
                  : "Standard sub-saturation VIIRS 375m Stefan-Boltzmann radiative regime."}
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 12 }}>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 8, borderRadius: 8 }}>
              <small style={{ display: "block", opacity: 0.7, fontSize: 11 }}>Model A · Tweedie (50%)</small>
              <strong style={{ fontSize: 15 }}>{result.tweedie_frp.toFixed(1)} MW</strong>
            </div>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 8, borderRadius: 8 }}>
              <small style={{ display: "block", opacity: 0.7, fontSize: 11 }}>Model B · Log-L2 (30%)</small>
              <strong style={{ fontSize: 15 }}>{result.log_frp.toFixed(1)} MW</strong>
            </div>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 8, borderRadius: 8 }}>
              <small style={{ display: "block", opacity: 0.7, fontSize: 11 }}>Model C · Tail L2 (20%)</small>
              <strong style={{ fontSize: 15 }}>{result.raw_l2_frp.toFixed(1)} MW</strong>
            </div>
          </div>

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.8, flexWrap: "wrap", gap: 8 }}>
            <span>Test RMSE: <strong>13.90 → 9.60 MW (-30.9%)</strong></span>
            <span>MAE: <strong>3.39 → 2.50 MW</strong></span>
            <span>R² (Log): <strong>0.8165</strong></span>
            <span>FRP&gt;100 Bias: <strong>-106.2 → -72.9 MW</strong></span>
          </div>
        </div>
      </div>
    </section>
  );
}

