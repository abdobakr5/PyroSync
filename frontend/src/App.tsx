import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Empty,
  Heading,
  Icon,
  IconButton,
  Input,
  Logo,
  Modal,
  Segment,
  Select,
} from "./ui";
import { Flame } from "./flame";
import { ExportDialog } from "./export";
import {
  GeoInspector,
  LocationSearch,
  nearbyRecords,
  useGeoIndex,
  type GeoScope,
  type GeoSelection,
} from "./geoUI";
import { ThermalAnomalyTimeline } from "./anomalyUI";
import {
  areaFor,
  bboxOverlap,
  coordinateEntity,
  countryEntity,
  hierarchy,
  inBBox,
  loadAdminShapes,
  loadGeoIndex,
  radiusArea,
  regionEntity,
  rememberLocation,
  reverseGeocode,
  type GeoEntity,
  type GeoIndex,
  type Polys,
} from "./geo";
import { GlobeExplorer, MATCH_COLORS, ObservationInspector, type RecordContext } from "./globe";
import { HeatCalendar, metricUnit, type PeriodRef } from "./calendar";
import {
  AnomalyRadar,
  ClusterLab,
  Convergence,
  DualSignal,
  FrpPredictor,
  HarmonizationGrid,
  IntelligenceStrip,
  PixelExplorer,
  ROLES,
  RoleSelectPage,
  SeasonTimeline,
  type AnomalyStats,
} from "./features";
import {
  DEFAULT_FILTERS,
  MATCHES,
  MONTHS,
  REGIONS,
  SNAPSHOT,
  filterRecords,
  fmt,
  isoWeek,
  maximumFrp,
  nearestPlace,
  observationCount,
  periodRange,
  quantile,
  valueOf,
  type Bounds,
  type Filters,
  type FireRecord,
  type Match,
  type Metric,
} from "./data";

type Page =
  | "Overview"
  | "Explore Map"
  | "Activity Calendar"
  | "Sensor Harmonization"
  | "Anomaly Intelligence"
  | "Seasonal Risk"
  | "Fire Regimes"
  | "Data Explorer"
  | "Methodology";
const NAV: { page: Page; icon: string; group?: string }[] = [
  { page: "Overview", icon: "overview" },
  { page: "Explore Map", icon: "globe" },
  { page: "Activity Calendar", icon: "calendar" },
  { page: "Sensor Harmonization", icon: "layers" },
  { page: "Anomaly Intelligence", icon: "anomaly", group: "INTELLIGENCE" },
  { page: "Seasonal Risk", icon: "seasonal" },
  { page: "Fire Regimes", icon: "regime" },
  { page: "Data Explorer", icon: "database", group: "DATA & RESOURCES" },
  { page: "Methodology", icon: "book" },
];
const COPY: Record<Page, [string, string, string]> = {
  Overview: [
    "DIGITAL EARTH · FIRE INTELLIGENCE",
    "One Earth. A unified view of fire.",
    "Explore harmonized MODIS and VIIRS thermal observations across space, seasons, and decades.",
  ],
  "Explore Map": [
    "SPATIAL EXPLORATION",
    "Follow the heat across the globe.",
    "Rotate, zoom, and select any thermal marker to trace it back to its source observations.",
  ],
  "Activity Calendar": [
    "THERMAL HISTORY MATRIX",
    "Every season leaves a signature.",
    "Twenty-six years of activity, one period at a time — with coverage gaps shown honestly.",
  ],
  "Sensor Harmonization": [
    "FROM OBSERVATIONS TO INSIGHT",
    "Different sensors. Common ground.",
    "Watch source detections become transparent, comparable analytical units.",
  ],
  "Anomaly Intelligence": [
    "THERMAL DEVIATION RADAR",
    "Beyond the expected.",
    "Compare the selection with a seasonally matched, sensor-compatible historical baseline.",
  ],
  "Seasonal Risk": [
    "FIRE SEASON TIMELINE",
    "Know the historical windows.",
    "Historical patterns for informed planning — not a forecast or an operational warning.",
  ],
  "Fire Regimes": [
    "THERMAL CLUSTER LAB",
    "Patterns, not assumptions.",
    "Explore inferred thermal patterns without claiming confirmed fire types.",
  ],
  "Data Explorer": [
    "OBSERVATION INSPECTOR",
    "Go deeper into every record.",
    "Filter, inspect provenance, and export exactly the observations behind your view.",
  ],
  Methodology: [
    "SCIENCE YOU CAN INSPECT",
    "Clarity starts at the source.",
    "The data, the harmonization rules, and the limits of interpretation.",
  ],
};
const ROLE_ORDER: Record<string, string[]> = {
  Scientist: ["calendar", "signal", "anomaly"],
  Responder: ["anomaly", "calendar", "signal"],
  "Land Manager": ["regimes", "calendar", "anomaly"],
  Custom: ["calendar", "signal", "anomaly"],
};
const HARM_FIELDS = [
  "event_id",
  "date",
  "lat_grid",
  "lon_grid",
  "match_type",
  "modis_count",
  "viirs_count",
  "max_frp_mw",
  "inferred_pattern",
  "source_ids",
  "provenance",
];
const RAW_FIELDS = [
  "source_id",
  "event_id",
  "date",
  "time_utc",
  "latitude",
  "longitude",
  "sensor",
  "satellite",
  "frp_mw",
  "confidence",
  "match_type",
  "provenance",
];

/** Dashboard-range anomaly: equivalent calendar days vs. 2012–2023 baseline years (selected years excluded). */
function rangeAnomaly(history: FireRecord[], filters: Filters, count: number): AnomalyStats {
  // Compare equivalent calendar-day coverage in each compatible baseline year.
  const days = new Map<string, number>();
  const start = new Date(`${filters.start}T00:00:00Z`),
    end = new Date(`${filters.end}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(5, 10);
    days.set(key, (days.get(key) || 0) + 1);
  }
  const years = Array.from({ length: 12 }, (_, j) => 2012 + j).filter(
    (y) => y < Number(filters.start.slice(0, 4)) || y > Number(filters.end.slice(0, 4)),
  );
  const comparable = years.length >= 5 ? years : [];
  const values = comparable
    .map((y) =>
      history
        .filter((r) => r.date.startsWith(String(y)))
        .reduce(
          (n, r) =>
            n +
            (days.get(r.date.slice(5, 10)) || 0) *
              (filters.mode === "raw" ? observationCount(r, filters.sensor) : 1),
          0,
        ),
    )
    .sort((a, b) => a - b);
  const median = values.length ? quantile(values, 0.5) : null;
  const compatible = filters.start >= "2012-01-01" && filters.end <= SNAPSHOT;
  const pct = median && compatible ? ((count - median) / median) * 100 : null;
  return {
    current: count,
    median,
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    lo: values[0] ?? 0,
    hi: values[values.length - 1] ?? 0,
    pct,
    years: comparable,
    category:
      pct === null
        ? "Insufficient baseline"
        : pct > 75
          ? "Extreme anomaly"
          : pct > 25
            ? "Elevated activity"
            : pct < -25
              ? "Below baseline"
              : "Within expected range",
  };
}

const Landing = lazy(() => import("./landing"));
const VISITED_KEY = "pyrosync.visited";

export default function App() {
  // First visit opens the cinematic landing; returning visitors go straight to the workspace.
  const [view, setView] = useState<"landing" | "role-select" | "app">(() => {
    try {
      return localStorage.getItem(VISITED_KEY) ? "app" : "landing";
    } catch {
      return "landing";
    }
  });
  const [page, setPage] = useState<Page>("Overview");
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [metric, setMetric] = useState<Metric>("count");
  const [weekly, setWeekly] = useState(false);
  const [role, setRole] = useState("Scientist");
  const [mobileNav, setMobileNav] = useState(false);
  const [dialog, setDialog] = useState<"export" | "dates" | null>(null);
  const [record, setRecord] = useState<FireRecord | null>(null);
  // Geographic intelligence: an applied area of interest (filters every view) vs. a map-click preview.
  const [geoSel, setGeoSel] = useState<GeoSelection | null>(null);
  const { index: geoIndex } = useGeoIndex(true);
  const countryOptions = useMemo(
    () => (geoIndex ? [...geoIndex.countries].sort((a, b) => a.n.localeCompare(b.n)) : []),
    [geoIndex],
  );
  const [geoData, setGeoData] = useState<{
    index: GeoIndex;
    shapes: Record<string, Polys> | null;
  } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  // Anomaly timeline selection (drives dashboard dates; prev restores them on clear).
  const [anomalySel, setAnomalySel] = useState<{
    key: string;
    prev: { start: string; end: string };
  } | null>(null);
  const [tableRecord, setTableRecord] = useState<FireRecord | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<
    (PeriodRef & { prev: { start: string; end: string } }) | null
  >(null);
  const [search, setSearch] = useState("");
  const [minFrp, setMinFrp] = useState(0);
  const [sort, setSort] = useState<"date" | "frp">("date");
  const [descending, setDescending] = useState(true);
  const [tablePage, setTablePage] = useState(0);
  const [dateStart, setDateStart] = useState(filters.start);
  const [dateEnd, setDateEnd] = useState(filters.end);
  const [dateError, setDateError] = useState("");
  const [manual, setManual] = useState<Bounds>(REGIONS[0].bounds);
  const [boundsError, setBoundsError] = useState("");
  const [customRestore, setCustomRestore] = useState<{
    filters: Filters;
    metric: Metric;
    weekly: boolean;
  } | null>(null);

  const rows = useMemo(() => filterRecords(filters), [filters]);
  const history = useMemo(() => filterRecords(filters, true), [filters]);
  const region = REGIONS.find((r) => r.id === filters.region)!;
  const scopeName = filters.area ? filters.area.label : region.name;
  const rawCount = rows.reduce((n, r) => n + observationCount(r, filters.sensor), 0);
  const count = valueOf(rows, filters.mode, filters.sensor);
  const modisCount = rows.reduce((n, r) => n + r.modis, 0);
  const viirsCount = rows.reduce((n, r) => n + r.viirs, 0);
  const maxFrp = maximumFrp(rows, filters.mode, filters.sensor);
  const matches = rows.filter((r) => r.match === MATCHES[0]).length;
  const dateLabel = `${new Date(`${filters.start}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} – ${new Date(`${filters.end}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? "" : n)), 6500);
  };
  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setTablePage(0);
    setLoading(true);
    window.setTimeout(() => setLoading(false), 220);
  };
  const navigate = (next: Page) => {
    setPage(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const reset = () => {
    setFilters({ ...DEFAULT_FILTERS });
    setGeoSel(null);
    setAnomalySel(null);
    setSearch("");
    setMinFrp(0);
    setPeriod(null);
    setTablePage(0);
    flash("Filters reset to Eastern Mediterranean · 2021 · harmonized data.");
  };
  const toggleMatch = (m: Match) => {
    if (filters.matches.length === MATCHES.length) {
      update({ matches: [m] });
    } else if (filters.matches.length === 1 && filters.matches[0] === m) {
      update({ matches: [...MATCHES] });
    } else {
      const next = filters.matches.includes(m)
        ? filters.matches.filter((x) => x !== m)
        : [...filters.matches, m];
      update({ matches: next.length ? next : [...MATCHES] });
    }
  };
  const selectPeriod = (year: number, index: number, week: boolean) => {
    const range = periodRange(year, index, week);
    setPeriod({
      year,
      index,
      weekly: week,
      prev: period?.prev ?? anomalySel?.prev ?? { start: filters.start, end: filters.end },
    });
    setAnomalySel(null);
    update(range);
  };
  const clearPeriod = () => {
    if (period) update(period.prev);
    setPeriod(null);
    setAnomalySel(null);
  };
  const ensureGeo = async (withShapes: boolean) => {
    const [index, shapes] = await Promise.all([
      loadGeoIndex(),
      withShapes ? loadAdminShapes() : Promise.resolve(geoData?.shapes ?? null),
    ]);
    const d = { index, shapes: shapes ?? geoData?.shapes ?? null };
    setGeoData(d);
    return d;
  };
  /** Search result or breadcrumb: becomes the dashboard's area of interest (dates and mode preserved). */
  const applyArea = async (e: GeoEntity) => {
    if (e.kind === "coordinates") return previewLocation(e.lat, e.lon);
    setGeoBusy(true);
    try {
      const { index, shapes } = await ensureGeo(e.kind === "region" || e.kind === "city");
      const area = areaFor(index, shapes, e);
      if (!area) throw new Error("boundary unavailable");
      setRecord(null);
      update({ area, bounds: null });
      setGeoSel({ entity: e, mode: "area" });
      rememberLocation(e);
      flash(
        `Exploring ${area.label} — globe, KPIs, calendar, anomaly timeline, and events are scoped to this area.`,
      );
    } catch (err) {
      flash(
        `Could not load geographic boundaries (${err instanceof Error ? err.message : "error"}). Your current view is unchanged.`,
      );
    } finally {
      setGeoBusy(false);
    }
  };
  /** Map click on terrain: identify the location without changing dashboard filters. */
  const previewLocation = async (lat: number, lon: number) => {
    const entity = coordinateEntity(lat, lon);
    setRecord(null);
    setGeoSel({ entity, mode: "preview", pending: true });
    try {
      const [lookup] = await Promise.all([reverseGeocode(lat, lon), ensureGeo(true)]);
      setGeoSel((s) =>
        s && s.entity.key === entity.key ? { entity, mode: "preview", lookup } : s,
      );
    } catch {
      setGeoSel((s) =>
        s && s.entity.key === entity.key
          ? {
              ...s,
              pending: false,
              error: "Geographic data could not be loaded; the coordinates are still valid.",
            }
          : s,
      );
    }
  };
  const clearGeo = () => {
    if (geoSel?.mode === "preview" && filters.area)
      return setGeoSel({ entity: filters.area.entity, mode: "area" });
    if (filters.area) {
      update({ area: null });
      flash(`Area reset — exploring the ${region.name} pilot region again.`);
    }
    setGeoSel(null);
  };
  const selectAnomaly = (
    p: { key: string; res: string; start: string; end: string; year: number; index: number } | null,
  ) => {
    if (!p) {
      if (anomalySel) update(anomalySel.prev);
      else if (period) update(period.prev);
      setAnomalySel(null);
      setPeriod(null);
      return;
    }
    const prev = anomalySel?.prev ?? period?.prev ?? { start: filters.start, end: filters.end };
    // Month and ISO-week selections also highlight the matching Thermal History Matrix cell.
    setPeriod(
      p.res === "month" || p.res === "week"
        ? { year: p.year, index: p.index, weekly: p.res === "week", prev }
        : null,
    );
    setAnomalySel({ key: p.key, prev });
    update({ start: p.start, end: p.end > SNAPSHOT ? SNAPSHOT : p.end });
  };
  const applyRole = (next: string) => {
    if (next === "Custom") {
      if (customRestore) {
        setFilters(customRestore.filters);
        setMetric(customRestore.metric);
        setWeekly(customRestore.weekly);
        setCustomRestore(null);
      }
      setRole(next);
      flash("Custom view restored. Your area and date selections are preserved.");
      return;
    }
    if (!customRestore) setCustomRestore({ filters, metric, weekly });
    setRole(next);
    if (next === "Responder") {
      setMetric("anomaly");
      setWeekly(true);
      update({ start: "2024-01-01", end: SNAPSHOT, mode: "harmonized" });
      flash(
        "Responder mode: weekly cadence + anomaly emphasis + seasonal windows first.",
      );
    }
    if (next === "Scientist") {
      setMetric("count");
      setWeekly(false);
      setPeriod(null);
      update({ start: "2000-11-01", end: SNAPSHOT, mode: "raw" });
      flash(
        "Scientist mode: monthly matrix + full 2000–2025 record + raw vs. harmonized transparency.",
      );
    }
    if (next === "Land Manager") {
      setMetric("frp");
      setWeekly(false);
      update({ mode: "harmonized" });
      flash(
        "Land Manager mode: FRP intensity + inferred regimes on 3D globe + spatial spread.",
      );
    }
  };

  const monthly = useMemo(() => {
    const m = new Map<string, number>();
    history.forEach((r) => m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) || 0) + 1));
    return m;
  }, [history]);
  const context = useCallback(
    (r: FireRecord): RecordContext => {
      const y = Number(r.date.slice(0, 4)),
        mm = r.date.slice(5, 7);
      if (y < 2012 || r.date.slice(0, 7) >= SNAPSHOT.slice(0, 7))
        return {
          anomalyPct: null,
          anomalyNote: "Month predates the multi-sensor baseline or is partial.",
        };
      const vals = Array.from({ length: 12 }, (_, j) => 2012 + j)
        .filter((v) => v !== y)
        .map((v) => monthly.get(`${v}-${mm}`) || 0)
        .sort((a, b) => a - b);
      const med = quantile(vals, 0.5),
        cur = monthly.get(r.date.slice(0, 7)) || 0;
      return {
        anomalyPct: med ? ((cur - med) / med) * 100 : null,
        anomalyNote: `${MONTHS[Number(mm) - 1]} ${y}: ${fmt(cur)} records vs. ${fmt(med)} median (2012–2023, current filters).`,
      };
    },
    [monthly],
  );

  const anomaly: AnomalyStats = useMemo(
    () => rangeAnomaly(history, filters, count),
    [filters.start, filters.end, filters.mode, filters.sensor, history, count],
  );

  const ratio = useMemo(() => {
    const overlap = rows.filter((r) => r.date >= "2012-01-01");
    return {
      viirs: overlap.reduce((n, r) => n + r.viirs, 0),
      modis: overlap.reduce((n, r) => n + r.modis, 0),
      label: `${scopeName}, ${dateLabel}`,
    };
  }, [rows, scopeName, dateLabel]);

  const periodStats = useMemo(() => {
    if (!period) return null;
    const vals = Array.from({ length: 12 }, (_, j) => 2012 + j)
      .filter((y) => y !== period.year)
      .map(
        (y) =>
          history.filter((r) => {
            if (period.weekly) {
              const w = isoWeek(r.date);
              return w.year === y && w.week === period.index + 1;
            }
            return r.date.startsWith(`${y}-${String(period.index + 1).padStart(2, "0")}`);
          }).length,
      )
      .sort((a, b) => a - b);
    const median = quantile(vals, 0.5);
    const harmonized = rows.length;
    return {
      median,
      pct:
        median && period.year >= 2012 && filters.end <= SNAPSHOT
          ? ((harmonized - median) / median) * 100
          : null,
      harmonized,
    };
  }, [period, history, rows.length, filters.end]);

  const filteredTable = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.frp >= minFrp &&
            `${r.id} ${r.date} ${r.match} ${r.lat} ${r.lon} ${r.confidence} ${r.regime}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort(
          (a, b) =>
            (sort === "frp" ? a.frp - b.frp : a.date.localeCompare(b.date)) * (descending ? -1 : 1),
        ),
    [rows, search, minFrp, sort, descending],
  );
  const isTableExport = page === "Data Explorer";
  const exportRows = isTableExport ? filteredTable : rows;
  const availableFields = filters.mode === "harmonized" ? HARM_FIELDS : RAW_FIELDS;
  const activeFilters = [
    filters.matches.length < MATCHES.length ? `Match: ${filters.matches.join(", ") || "none"}` : "",
    filters.sensor !== "All sensors" ? `Sensor: ${filters.sensor}` : "",
    filters.bounds ? "Custom bounding box" : "",
    filters.regime !== "All patterns" ? `Pattern: ${filters.regime}` : "",
    filters.anomalyOnly ? "Peak season (Aug–Oct)" : "",
    isTableExport && minFrp ? `FRP ≥ ${minFrp} MW` : "",
    isTableExport && search ? `Search: “${search}”` : "",
  ].filter(Boolean);
  const openExport = () => {
    setMobileNav(false);
    setDialog("export");
  };
  const enterApp = (target?: Page) => {
    try {
      localStorage.setItem(VISITED_KEY, "1");
    } catch {
      /* storage unavailable: landing simply shows again next visit */
    }
    if (target) {
      setView("app");
      setPage(target);
    } else {
      setView("role-select");
    }
    window.scrollTo({ top: 0 });
  };
  const closeDialog = useCallback(() => setDialog(null), []);
  const whyReadings = () => {
    navigate("Sensor Harmonization");
    window.setTimeout(
      () =>
        document
          .getElementById("pixel-explorer")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      120,
    );
  };
  useEffect(() => {
    if (!mobileNav) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setMobileNav(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileNav]);
  useEffect(() => {
    if (tableRecord && !filteredTable.includes(tableRecord)) setTableRecord(null);
  }, [filteredTable, tableRecord]);

  // Location-level statistics for the inspector (area of interest, or the previewed point's admin area).
  const geoScope: GeoScope | null = useMemo(() => {
    if (!geoSel || geoSel.pending) return null;
    let area = geoSel.mode === "area" ? (filters.area ?? null) : null;
    const lk = geoSel.lookup;
    if (geoSel.mode === "preview" && lk && geoData) {
      const ent = lk.admin
        ? regionEntity(lk.admin, geoData.index)
        : lk.country
          ? countryEntity(lk.country)
          : null;
      area = ent ? areaFor(geoData.index, geoData.shapes, ent) : null;
    }
    const scoped = { ...filters, bounds: null, area };
    const records = area ? filterRecords(scoped) : [];
    const hist = area ? filterRecords(scoped, true) : [];
    const { lat, lon } = geoSel.entity;
    const covered = area
      ? REGIONS.some((r) =>
          bboxOverlap(area!.bbox, [
            r.bounds.minLon,
            r.bounds.minLat,
            r.bounds.maxLon,
            r.bounds.maxLat,
          ]),
        )
      : REGIONS.some((r) =>
          inBBox([r.bounds.minLon, r.bounds.minLat, r.bounds.maxLon, r.bounds.maxLat], lon, lat),
        );
    const pointLike = geoSel.mode === "preview" || geoSel.entity.kind === "city";
    const radiusKm = geoSel.mode === "preview" ? 50 : 30;
    const nearby = pointLike
      ? nearbyRecords(
          filterRecords({ ...filters, bounds: null, area: radiusArea(lat, lon, radiusKm) }),
          lat,
          lon,
          radiusKm,
        )
      : [];
    const an = rangeAnomaly(hist, filters, valueOf(records, filters.mode, filters.sensor));
    return {
      records,
      history: hist,
      label: area?.label ?? (lk?.country?.n || "this location"),
      covered: covered || records.length > 0,
      anomaly: { pct: an.pct, category: an.category },
      nearby,
      radiusKm,
    };
  }, [geoSel, geoData, filters]);
  const emphasis = useMemo(() => {
    if (geoSel?.mode === "preview" && geoScope) return new Set(geoScope.nearby.map((r) => r.id));
    if (anomalySel)
      return new Set(
        [...rows]
          .sort((a, b) => b.frp - a.frp)
          .slice(0, 5)
          .map((r) => r.id),
      );
    return undefined;
  }, [geoSel, geoScope, anomalySel, rows]);
  const geoFocus =
    geoSel?.mode === "preview"
      ? {
          lat: geoSel.entity.lat,
          lon: geoSel.entity.lon,
          key: geoSel.entity.key,
          dist: "keep" as const,
        }
      : filters.area
        ? {
            lat: filters.area.entity.lat,
            lon: filters.area.entity.lon,
            key: filters.area.key,
            dist: filters.area.dist,
          }
        : undefined;
  const previewArea = useMemo(() => {
    const lk = geoSel?.mode === "preview" ? geoSel.lookup : undefined;
    if (!lk || !geoData) return null;
    const ent = lk.admin
      ? regionEntity(lk.admin, geoData.index)
      : lk.country
        ? countryEntity(lk.country)
        : null;
    return ent ? areaFor(geoData.index, geoData.shapes, ent) : null;
  }, [geoSel, geoData]);
  const geoPanel = geoSel ? (
    <GeoInspector
      sel={geoSel}
      scope={geoScope}
      filters={filters}
      dateLabel={dateLabel}
      onBreadcrumb={applyArea}
      onApply={() => {
        if (!geoData || !geoSel) return;
        const chain = hierarchy(geoData.index, geoSel.entity, geoSel.lookup);
        if (chain.length) applyArea(chain[chain.length - 1]);
      }}
      onClear={clearGeo}
      onRecord={(r) => setRecord(r)}
      onPilot={(id) => {
        setGeoSel(null);
        update({ region: id, area: null, bounds: null });
      }}
    />
  ) : undefined;
  const globe = (height: number, opts: { regimeLayer?: boolean; title?: string } = {}) => (
    <GlobeExplorer
      rows={rows}
      filters={filters}
      record={record}
      onRecord={setRecord}
      onBounds={(b) => update({ bounds: b })}
      context={context}
      height={height}
      regimeLayer={opts.regimeLayer}
      title={opts.title}
      geo={{
        search: <LocationSearch onSelect={applyArea} />,
        scopeName,
        focus: geoFocus,
        highlight:
          geoSel?.mode === "preview" ? (previewArea?.rings ?? null) : (filters.area?.rings ?? null),
        pin:
          geoSel?.mode === "preview"
            ? { lat: geoSel.entity.lat, lon: geoSel.entity.lon }
            : filters.area?.kind === "city"
              ? { lat: filters.area.entity.lat, lon: filters.area.entity.lon }
              : null,
        emphasis,
        onLocation: previewLocation,
        panel: geoPanel,
        hidePilotOutline: !!filters.area,
      }}
    />
  );
  const periodInspector = period && periodStats && (
    <div className="period-inspector" aria-live="polite">
      <div className="period-title">
        {periodStats.pct !== null && periodStats.pct > 25 ? (
          <Flame size={22} />
        ) : (
          <Icon name="target" size={20} />
        )}
        <div>
          <span className="eyebrow-dark">SELECTED PERIOD · ALL VIEWS FILTERED</span>
          <strong>
            {period.weekly ? `ISO week ${period.index + 1}` : MONTHS[period.index]} {period.year}
          </strong>
          <small>
            {dateLabel} · {scopeName}
          </small>
        </div>
      </div>
      <div className="period-metrics">
        <div>
          <span>{filters.mode === "raw" ? "Raw detections" : "Analytical records"}</span>
          <strong>{fmt(count)}</strong>
        </div>
        <div>
          <span>Maximum FRP</span>
          <strong>
            {maxFrp.toFixed(1)} <small>MW</small>
          </strong>
        </div>
        <div>
          <span>Same period median</span>
          <strong>{fmt(periodStats.median)}</strong>
          <small>records · 2012–2023</small>
        </div>
        <div>
          <span>Historical context</span>
          <strong>
            {periodStats.pct === null
              ? "—"
              : `${periodStats.pct >= 0 ? "+" : ""}${periodStats.pct.toFixed(0)}%`}
          </strong>
          <small>
            {periodStats.pct === null
              ? filters.end > SNAPSHOT
                ? "partial coverage"
                : "pre-baseline era"
              : "vs. median records"}
          </small>
        </div>
      </div>
      <div className="period-actions">
        <Button variant="primary" icon="globe" onClick={() => navigate("Explore Map")}>
          View on globe
        </Button>
        <Button icon="reset" onClick={clearPeriod}>
          Clear period
        </Button>
      </div>
    </div>
  );
  const calendar = (full = false) => (
    <HeatCalendar
      history={history}
      filters={filters}
      metric={metric}
      onMetric={setMetric}
      weekly={weekly}
      onWeekly={setWeekly}
      full={full}
      selected={period}
      onPeriod={selectPeriod}
      onClearPeriod={clearPeriod}
      onExpand={() => navigate("Activity Calendar")}
      inspector={periodInspector}
    />
  );
  const strip = (
    <IntelligenceStrip
      mode={filters.mode}
      rawCount={rawCount}
      records={rows.length}
      matches={matches}
      maxFrp={maxFrp}
      modisCount={modisCount}
      viirsCount={viirsCount}
      sensor={filters.sensor}
      partial={filters.end > SNAPSHOT}
    />
  );
  const radarBlock = (compactView: boolean) => (
    <div className={`radar-block ${compactView ? "compact" : ""}`}>
      <div className="radar-copy">
        <span className="eyebrow">THERMAL DEVIATION RADAR</span>
        <h2>
          {anomaly.pct === null
            ? "A valid baseline comes first."
            : `${anomaly.pct >= 0 ? "+" : ""}${anomaly.pct.toFixed(1)}% vs. historical baseline`}
        </h2>
        <p>
          {anomaly.category} · {scopeName} · {dateLabel}.{" "}
          {anomaly.pct === null
            ? "Needs ≥5 non-overlapping 2012–2023 years and complete coverage."
            : `Equivalent calendar days across ${anomaly.years.length} baseline years.`}
        </p>
        <Badge tone={anomaly.pct !== null && anomaly.pct > 25 ? "warning" : "muted"}>
          PyroSync Gold · NASA MODIS & VIIRS (2003–2025)
        </Badge>
        {compactView && (
          <button className="text-link light" onClick={() => navigate("Anomaly Intelligence")}>
            Open anomaly intelligence
            <Icon name="arrow" size={14} />
          </button>
        )}
      </div>
      <AnomalyRadar
        stats={anomaly}
        unit={metricUnit("count", filters.mode)}
        compactView={compactView}
      />
    </div>
  );
  const season = (compactView: boolean) => (
    <SeasonTimeline
      history={history}
      filters={filters}
      regionName={scopeName}
      compactView={compactView}
      onOpen={(w) => {
        setWeekly(true);
        selectPeriod(2024, w, true);
        navigate("Activity Calendar");
      }}
    />
  );
  const overviewSections: Record<string, ReactNode> = {
    calendar: <div key="calendar">{calendar()}</div>,
    signal: (
      <div key="signal" className="pair">
        <DualSignal rows={rows} filters={filters} />
        <Convergence
          rows={rows}
          history={history}
          filters={filters}
          onMatch={(m) => update({ matches: m ? [m] : [...MATCHES] })}
        />
      </div>
    ),
    anomaly: (
      <div key="anomaly" className="pair uneven">
        {radarBlock(true)}
        {season(true)}
      </div>
    ),
    regimes: (
      <div key="regimes">
        <ClusterLab
          rows={rows}
          compactView
          onRecord={setRecord}
          onInspectRegime={(g) => {
            update({ regime: g });
            navigate("Data Explorer");
          }}
        />
      </div>
    ),
  };
  const order = role === "Land Manager" ? [...ROLE_ORDER[role], "signal"] : ROLE_ORDER[role];

  function dataTable() {
    const visible = filteredTable.slice(tablePage * 12, tablePage * 12 + 12);
    return (
      <section className="table-panel" aria-label="Observation records">
        <header className="feature-head">
          <div>
            <span className="eyebrow">OBSERVATION INSPECTOR</span>
            <h2>
              {filters.mode === "harmonized"
                ? "Harmonized analytical records"
                : "Raw source observations, grouped by cell/day"}
            </h2>
          </div>
          <div className="head-actions">
            <Badge>{fmt(filteredTable.length)} groups</Badge>
            <Button icon="download" onClick={openExport}>
              Export CSV
            </Button>
          </div>
        </header>
        <div className="table-filters">
          <div className="search-wrap">
            <Icon name="search" size={16} />
            <Input
              placeholder="Search ID, date, coordinates, match, pattern…"
              aria-label="Search observations"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setTablePage(0);
              }}
            />
          </div>
          <Select
            aria-label="Data explorer sensor filter"
            value={filters.sensor}
            onChange={(e) => update({ sensor: e.target.value })}
          >
            <option>All sensors</option>
            <option>MODIS</option>
            <option>VIIRS</option>
          </Select>
          <Select
            aria-label="Filter by inferred pattern"
            value={filters.regime}
            onChange={(e) => update({ regime: e.target.value })}
          >
            <option>All patterns</option>
            <option>High-intensity likely pattern</option>
            <option>Small thermal-feature pattern</option>
            <option>Unclassified</option>
          </Select>
          <label className="range-filter">
            <span>
              Min FRP <strong>{minFrp} MW</strong>
            </span>
            <input
              type="range"
              min={0}
              max={150}
              step={5}
              value={minFrp}
              onChange={(e) => {
                setMinFrp(Number(e.target.value));
                setTablePage(0);
              }}
              aria-label="Minimum FRP"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={filters.anomalyOnly}
              onChange={(e) => update({ anomalyOnly: e.target.checked })}
            />
            Peak season (Aug–Oct)
          </label>
        </div>
        {filters.mode === "raw" && (
          <p className="inline-note">
            <Icon name="info" size={14} />
            Rows group raw sources by cell/day for readability; CSV export contains one row per
            source observation.
          </p>
        )}
        {visible.length ? (
          <>
            <div className="table-scroll">
              <table className="records">
                <thead>
                  <tr>
                    <th>Record · provenance</th>
                    <th>
                      <button
                        onClick={() => {
                          setSort("date");
                          setDescending(sort === "date" ? !descending : true);
                        }}
                      >
                        Acquired (UTC) <Icon name="sort" size={12} />
                      </button>
                    </th>
                    <th>Location</th>
                    <th>Sensors</th>
                    <th>Match</th>
                    <th>
                      <button
                        onClick={() => {
                          setSort("frp");
                          setDescending(sort === "frp" ? !descending : true);
                        }}
                      >
                        Thermal signal <Icon name="sort" size={12} />
                      </button>
                    </th>
                    <th>Inferred pattern</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.id}
                      className={tableRecord === r ? "selected" : ""}
                      onClick={() => setTableRecord(r)}
                      aria-selected={tableRecord === r}
                    >
                      <td>
                        <button
                          className="record-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTableRecord(r);
                          }}
                        >
                          {r.id}
                        </button>
                        <small>{r.modis + r.viirs} source IDs</small>
                      </td>
                      <td>{r.date}</td>
                      <td>
                        <span className="mono">
                          {r.lat.toFixed(3)}, {r.lon.toFixed(3)}
                        </span>
                        <small>{nearestPlace(r)}</small>
                      </td>
                      <td>
                        <span className="sensor-pair">
                          <span className="sensor-pill modis small">
                            <i />M {r.modis}
                          </span>
                          <span className="sensor-pill viirs small">
                            <i />V {r.viirs}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span
                          className="match-pill"
                          style={{ "--c": MATCH_COLORS[r.match] } as React.CSSProperties}
                        >
                          {r.match}
                        </span>
                      </td>
                      <td>
                        <span className="thermal-cell">
                          <span className="mini-thermo">
                            <i style={{ width: `${Math.min(100, (r.frp / 180) * 100)}%` }} />
                          </span>
                          {r.frp.toFixed(1)} MW
                          {r.frp > 110 && (
                            <Flame size={10} animated={false} label="High intensity" />
                          )}
                        </span>
                      </td>
                      <td className="pattern-cell">
                        {r.regime.replace(" likely pattern", "").replace(" pattern", "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-pagination">
              <span>
                Showing {fmt(tablePage * 12 + 1)}–
                {fmt(Math.min(tablePage * 12 + 12, filteredTable.length))} of{" "}
                {fmt(filteredTable.length)} · PyroSync Gold data
              </span>
              <div>
                <Button disabled={tablePage === 0} onClick={() => setTablePage(tablePage - 1)}>
                  Previous
                </Button>
                <Badge>Page {tablePage + 1}</Badge>
                <Button
                  disabled={(tablePage + 1) * 12 >= filteredTable.length}
                  onClick={() => setTablePage(tablePage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : (
          <Empty onReset={reset} />
        )}
        {tableRecord && (
          <ObservationInspector
            key={tableRecord.id}
            record={tableRecord}
            context={context(tableRecord)}
            related={[]}
            onSelect={setTableRecord}
            onClose={() => setTableRecord(null)}
            onLocate={() => {
              setRecord(tableRecord);
              navigate("Explore Map");
            }}
          />
        )}
      </section>
    );
  }

  if (view === "landing")
    return (
      <Suspense
        fallback={
          <div className="landing-loading" role="status">
            <Logo />
            <span>Preparing the living Earth…</span>
          </div>
        }
      >
        <Landing onLaunch={enterApp} />
      </Suspense>
    );
  if (view === "role-select")
    return (
      <RoleSelectPage
        activeRole={role}
        onSelect={(r) => {
          applyRole(r);
          setView("app");
          setPage("Overview");
          window.scrollTo({ top: 0 });
        }}
        onBack={() => setView("landing")}
      />
    );
  const [eyebrow, title, subtitle] = COPY[page];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace content
      </a>
      {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <button
          className="brand-button"
          onClick={() => {
            setMobileNav(false);
            setView("landing");
            window.scrollTo({ top: 0 });
          }}
          aria-label="About PYROSYNC — open the platform introduction"
        >
          <Logo />
        </button>
        <div className="sidebar-workspace">
          <span className="workspace-orbit">
            <Icon name="globe" size={16} />
          </span>
          <div>
            Earth intelligence<small>Research · demo data</small>
          </div>
        </div>
        <div className="nav-group-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {NAV.map((n) => (
            <div key={n.page}>
              {n.group && <div className="nav-group-label">{n.group}</div>}
              <button
                className={`nav-item ${page === n.page ? "active" : ""}`}
                onClick={() => navigate(n.page)}
                aria-current={page === n.page ? "page" : undefined}
              >
                <Icon name={n.icon} size={18} />
                <span>{n.page}</span>
                {page === n.page && <i />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${dialog === "export" ? "active" : ""}`}
            onClick={openExport}
            aria-haspopup="dialog"
          >
            <Icon name="download" size={18} />
            <span>Export data & reports</span>
          </button>
          <div className="source-note">
            <Flame size={20} animated={false} />
            <strong>Built on Earth observation.</strong>
            <p>Inspired by NASA FIRMS data. Independent by design — not affiliated with NASA.</p>
            <button onClick={() => navigate("Methodology")}>
              Our data & methodology
              <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="sidebar-footer">
            <span className="live-dot" />
            Prototype v2.0<span>UTC</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-menu">
              <IconButton icon="menu" label="Open navigation" onClick={() => setMobileNav(true)} />
            </span>
            <span className="crumb-home">Workspace</span>
            <Icon name="chevron" size={13} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="snapshot-indicator">
              <span className="live-dot" />
              Demo snapshot <strong>15 Apr 2026</strong>
            </span>
            <IconButton
              icon="help"
              label="Read data methodology"
              onClick={() => navigate("Methodology")}
            />
            <button
              type="button"
              className="mode-chip"
              onClick={() => setView("role-select")}
              title="View Settings — change your workspace view"
              style={{ cursor: "pointer" }}
            >
              <Icon name="layers" size={14} />
              {role} view · Settings
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span className="tiny-ember" />
                  {eyebrow}
                </div>
                <Heading level={1}>{title}</Heading>
                <p>{subtitle}</p>
                <div className={`geo-context ${filters.area ? "is-area" : ""}`} role="status">
                  <Icon name="pin" size={14} />
                  <span>
                    Currently exploring:{" "}
                    <strong>
                      {filters.area ? filters.area.label : `${region.name} · pilot region`}
                    </strong>
                    {filters.area && (
                      <em>
                        {filters.area.kind === "city"
                          ? " · 30 km city area"
                          : filters.area.kind === "region"
                            ? " · admin-1 boundary"
                            : " · national boundary"}
                      </em>
                    )}
                  </span>
                  {filters.area && <button onClick={clearGeo}>Reset area</button>}
                  {geoBusy && <span className="geo-spinner" aria-label="Loading boundaries" />}
                </div>
              </div>
              <Button variant="primary" icon="download" onClick={openExport}>
                Export data
              </Button>
            </div>
          }
          {
            <div className="control-deck">
              <div className="deck-row">
                <label className="deck-field">
                  <span>
                    <Icon name="pin" size={14} />
                    Area of interest
                  </span>
                  <Select
                    aria-label="Geographic region or country"
                    value={
                      filters.area
                        ? filters.area.kind === "country"
                          ? filters.area.entity.key
                          : "__area"
                        : filters.region
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "__area") return;
                      if (val.startsWith("country:") && geoIndex) {
                        const a3 = val.slice("country:".length);
                        const c = geoIndex.countries.find((x) => x.a3 === a3);
                        if (c) void applyArea(countryEntity(c));
                        return;
                      }
                      setRecord(null);
                      setGeoSel(null);
                      update({ region: val, bounds: null, area: null });
                      setManual(REGIONS.find((r) => r.id === val)!.bounds);
                    }}
                  >
                    {filters.area && filters.area.kind !== "country" && (
                      <option value="__area">Searched: {filters.area.label}</option>
                    )}
                    <optgroup label="Pilot regions">
                      {REGIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </optgroup>
                    {countryOptions.length > 0 && (
                      <optgroup label="Countries">
                        {countryOptions.map((c) => (
                          <option key={c.a3} value={`country:${c.a3}`}>
                            {c.n}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </label>
                <div className="deck-field">
                  <span>
                    <Icon name="calendar" size={14} />
                    Time context · UTC
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      className="date-button"
                      onClick={() => {
                        setDateStart(filters.start);
                        setDateEnd(filters.end);
                        setDateError("");
                        setDialog("dates");
                      }}
                    >
                      {dateLabel}
                      <Icon name="down" size={13} />
                    </button>
                    <button
                      type="button"
                      aria-pressed={filters.start === "2000-11-01" && filters.end === SNAPSHOT}
                      className={`match-chip ${filters.start === "2000-11-01" && filters.end === SNAPSHOT ? "enabled" : ""}`}
                      onClick={() => update({ start: "2000-11-01", end: SNAPSHOT })}
                      title="Show all time data (2000–2025)"
                    >
                      All time
                    </button>
                  </div>
                </div>
                <div className="deck-field">
                  <span>
                    <Icon name="layers" size={14} />
                    Data mode
                  </span>
                  <Segment
                    className="mode-segment"
                    value={filters.mode}
                    onChange={(mode) => update({ mode })}
                    options={[
                      { value: "raw", label: "Raw data", icon: "satellite" },
                      { value: "harmonized", label: "Harmonized data", icon: "layers" },
                    ]}
                  />
                </div>
              </div>
              <div className="deck-row secondary">
                <div className="match-filters">
                  <span className="filter-by">Sensor match</span>
                  <button
                    aria-pressed={filters.matches.length === MATCHES.length}
                    className={`match-chip ${filters.matches.length === MATCHES.length ? "enabled" : ""}`}
                    onClick={() => update({ matches: [...MATCHES] })}
                    title="Show all sensor match categories"
                  >
                    All
                  </button>
                  {MATCHES.map((m, i) => (
                    <button
                      key={m}
                      aria-pressed={filters.matches.includes(m)}
                      className={`match-chip match-${i} ${filters.matches.includes(m) ? "enabled" : ""}`}
                      onClick={() => toggleMatch(m)}
                      title={
                        m === "VIIRS-Only"
                          ? "Seen only by VIIRS; may indicate a smaller or brief thermal feature, but not guaranteed."
                          : m === "MODIS-Only"
                            ? "Seen only by MODIS (includes all pre-2012 records)."
                            : "Seen by both MODIS and VIIRS in the same cell/day."
                      }
                    >
                      <span className="chip-dot" />
                      {i === 0 ? "Matched" : m}
                      {filters.matches.includes(m) && <Icon name="check" size={11} />}
                    </button>
                  ))}
                </div>
                <span className="active-mode-note">
                  {filters.mode === "harmonized"
                    ? "Showing 1 km cell/day analytical records"
                    : "Showing original source detections"}
                </span>
                <button className="why-button" onClick={whyReadings}>
                  <Icon name="info" size={15} />
                  Why readings differ
                </button>
              </div>
            </div>
          }
          <div className={`content-area ${loading ? "is-loading" : ""}`} aria-busy={loading}>
            {page === "Overview" && (() => {
              const roleInfo = ROLES.find((r) => r.id === role);
              const primaryAction: Record<string, { label: string; target: Page }> = {
                Responder: { label: "Open Anomaly Intelligence", target: "Anomaly Intelligence" },
                Scientist: { label: "Open Sensor Harmonization", target: "Sensor Harmonization" },
                "Land Manager": { label: "Open Fire Regimes", target: "Fire Regimes" },
              };
              const act = primaryAction[role];
              return (
                <>
                  {roleInfo && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "12px 16px",
                        borderRadius: 12,
                        background: "rgba(16, 42, 68, 0.85)",
                        border: `1px solid ${roleInfo.accent}55`,
                        borderLeft: `4px solid ${roleInfo.accent}`,
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <strong style={{ fontSize: 14, color: "#eef6fc" }}>
                          {roleInfo.id} View · {roleInfo.tag}
                        </strong>
                        <span style={{ fontSize: 12, color: "#a9c5de" }}>
                          {roleInfo.items.join(" · ")} — {roleInfo.summary}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {act && (
                          <Button variant="primary" icon="arrow" onClick={() => navigate(act.target)}>
                            {act.label}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {strip}
                  {role === "Responder" ? (
                    <>
                      {order.map((k) => overviewSections[k])}
                      {globe(520, { title: `${scopeName} · rapid situational globe` })}
                    </>
                  ) : role === "Land Manager" ? (
                    <>
                      {globe(540, {
                        regimeLayer: true,
                        title: `${scopeName} · spatial spread & inferred fire regimes`,
                      })}
                      {order.map((k) => overviewSections[k])}
                    </>
                  ) : (
                    <>
                      {globe(540)}
                      {order.map((k) => overviewSections[k])}
                    </>
                  )}
                  <div className="bottom-status">
                    <span>
                      <Icon name="shield" size={15} />
                      Source-aware. Footprint-harmonized. NASA MODIS & VIIRS Gold data (2003–2025).
                    </span>
                    <button onClick={() => navigate("Methodology")}>
                      Understand the data
                      <Icon name="arrow" size={13} />
                    </button>
                  </div>
                </>
              );
            })()}
            {page === "Explore Map" && (
              <>
                <div className="explorer-layout">
                  {globe(640, { title: `${scopeName} · spatial explorer` })}
                  <aside className="aoi-panel">
                    <span className="eyebrow">AREA OF INTEREST</span>
                    <h2>
                      <Icon name="box" size={17} />
                      Define your bounds
                    </h2>
                    <p>
                      Use “Flat · draw area” to drag a bounding box, or enter decimal-degree bounds.
                      The amber outline appears on the globe.
                    </p>
                    <div className="bounds-inputs">
                      {(
                        [
                          ["minLat", "Min latitude"],
                          ["maxLat", "Max latitude"],
                          ["minLon", "Min longitude"],
                          ["maxLon", "Max longitude"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <Input
                            type="number"
                            step=".001"
                            value={manual[key]}
                            onChange={(e) =>
                              setManual({ ...manual, [key]: Number(e.target.value) })
                            }
                          />
                        </label>
                      ))}
                    </div>
                    {boundsError && (
                      <p className="error-text" role="alert">
                        {boundsError}
                      </p>
                    )}
                    <Button
                      variant="primary"
                      icon="target"
                      onClick={() => {
                        if (
                          manual.minLat >= manual.maxLat ||
                          manual.minLon >= manual.maxLon ||
                          manual.minLat < -85 ||
                          manual.maxLat > 85 ||
                          manual.minLon < -180 ||
                          manual.maxLon > 180
                        ) {
                          setBoundsError(
                            "Enter valid bounds: minimum below maximum; latitude ±85°, longitude ±180°.",
                          );
                          return;
                        }
                        setBoundsError("");
                        update({ bounds: manual });
                        flash("Area of interest applied to every view.");
                      }}
                    >
                      Apply area
                    </Button>
                    {filters.bounds && (
                      <Button icon="reset" onClick={() => update({ bounds: null })}>
                        Clear custom area
                      </Button>
                    )}
                    <label className="deck-field stacked">
                      <span>Source family</span>
                      <Select
                        aria-label="Filter sensor family"
                        value={filters.sensor}
                        onChange={(e) => update({ sensor: e.target.value })}
                      >
                        <option>All sensors</option>
                        <option>MODIS</option>
                        <option>VIIRS</option>
                      </Select>
                    </label>
                    <div className="aoi-summary">
                      <Icon name="pin" size={17} />
                      <div>
                        <strong>{scopeName}</strong>
                        <span>
                          {filters.bounds ? "Custom bounding box" : "Pilot region preset"} ·{" "}
                          {fmt(rows.length)} analytical records
                        </span>
                      </div>
                    </div>
                    <div className="kbd-help">
                      <strong>Globe controls</strong>
                      <span>
                        Drag / arrows: rotate · wheel, pinch, +/−: zoom · click a cluster to expand
                        · Esc: reset
                      </span>
                    </div>
                  </aside>
                </div>
                <DualSignal rows={rows} filters={filters} />
              </>
            )}
            {page === "Activity Calendar" && (
              <>
                {calendar(true)}
                <div className="pair">
                  <DualSignal rows={rows} filters={filters} />
                  {radarBlock(true)}
                </div>
              </>
            )}
            {page === "Sensor Harmonization" && (
              <>
                <div className="harmonization-summary">
                  {[
                    ["Raw MODIS detections", fmt(modisCount), "modis"],
                    ["Raw VIIRS detections", fmt(viirsCount), "viirs"],
                    ["Harmonized records", fmt(rows.length), "harm"],
                    ["Matched", fmt(matches), "matched"],
                    [
                      "VIIRS-only",
                      fmt(rows.filter((r) => r.match === "VIIRS-Only").length),
                      "viirs",
                    ],
                    [
                      "MODIS-only",
                      fmt(rows.filter((r) => r.match === "MODIS-Only").length),
                      "modis",
                    ],
                  ].map(([l, v, c]) => (
                    <div key={l} className={`hs-item ${c}`}>
                      <span>{l}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                  <dl className="hs-rule">
                    <div>
                      <dt>Aggregation</dt>
                      <dd>max(FRP)</dd>
                    </div>
                    <div>
                      <dt>Spatial resolution</dt>
                      <dd>≈1 km cell</dd>
                    </div>
                    <div>
                      <dt>Time window</dt>
                      <dd>UTC calendar day</dd>
                    </div>
                    <div>
                      <dt>Last processing</dt>
                      <dd>15 Apr 2026 · demo</dd>
                    </div>
                  </dl>
                </div>
                <HarmonizationGrid
                  rows={rows}
                  onInspect={(r) => {
                    setRecord(r);
                    navigate("Explore Map");
                  }}
                />
                <div className="pair">
                  <Convergence
                    rows={rows}
                    history={history}
                    filters={filters}
                    onMatch={(m) => update({ matches: m ? [m] : [...MATCHES] })}
                  />
                  <DualSignal rows={rows} filters={filters} />
                </div>
                <FrpPredictor selectedRecord={record} />
                <PixelExplorer ratio={ratio} />
              </>
            )}
            {page === "Anomaly Intelligence" && (
              <>
                <FrpPredictor selectedRecord={record} />
                <ThermalAnomalyTimeline
                  history={history}
                  filters={filters}
                  scopeName={scopeName}
                  selectedKey={
                    anomalySel?.key ??
                    (period
                      ? period.weekly
                        ? `${period.year}-W${String(period.index + 1).padStart(2, "0")}`
                        : `${period.year}-${String(period.index + 1).padStart(2, "0")}`
                      : undefined)
                  }
                  onSelect={selectAnomaly}
                  markDate={record?.date}
                  onEvent={(r) => {
                    setRecord(r);
                    navigate("Explore Map");
                  }}
                  loading={geoBusy}
                />
                <div className="pair">
                  {radarBlock(true)}
                  <section className="method-panel">
                    <span className="eyebrow">HOW THE COMPARISONS WORK</span>
                    <h2>Seasonally matched, sensor-compatible</h2>
                    <p>
                      Every period is compared with the <strong>same seasonal period</strong> in
                      2012–2023, excluding the evaluated year. At least five baseline years and
                      complete coverage are required; zero medians produce no percentage.
                    </p>
                    <div className="formula">
                      (observed − median) ÷ median × 100 · z = (observed − median) ÷ (MAD ÷ 0.6745)
                    </div>
                    <p>
                      Illustrative thresholds — Elevated: ≥ +25% and z ≥ 2 · Extreme: ≥ +75% and z ≥
                      3.5 — <strong>not validated alert thresholds</strong>. The radar compares the
                      dashboard date range on equivalent calendar days.
                    </p>
                    <p className="caveat">
                      <Icon name="shield" size={14} />
                      Historical intelligence, not an emergency warning or forecast.
                    </p>
                  </section>
                </div>
                {calendar()}
              </>
            )}
            {page === "Seasonal Risk" && (
              <>
                {season(false)}
                <div className="pair">
                  {radarBlock(true)}
                  <section className="method-panel">
                    <span className="eyebrow">MODEL & LIMITATIONS</span>
                    <h2>Historical patterns ≠ predictions</h2>
                    <p>
                      Each ISO week's score is its 2012–2023 median normalized to the highest weekly
                      median (=100) for the current region and filters. The top 8 of 52 weeks
                      (15.4%) are highlighted.
                    </p>
                    <p>
                      This is <strong>not a calibrated fire probability</strong>. It ignores
                      weather, fuel, and ignition drivers and is not an operational alerting system.
                    </p>
                  </section>
                </div>
              </>
            )}
            {page === "Fire Regimes" && (
              <>
                <ClusterLab
                  rows={rows}
                  onRecord={setRecord}
                  onInspectRegime={(g) => {
                    update({ regime: g });
                    navigate("Data Explorer");
                  }}
                />
                {globe(500, {
                  regimeLayer: true,
                  title: "Spatial distribution of inferred patterns",
                })}
              </>
            )}
            {page === "Data Explorer" && <>{dataTable()}</>}
            {page === "Methodology" && <Methodology />}
          </div>
          <footer className="app-footer">
            <span>
              <span className="live-dot orange" />
              PYROSYNC GOLD ARCHIVE (2003–2025)
              <span className="footer-detail">
                Harmonized NASA MODIS & VIIRS Gold detections (rule match-1.1.0, footprint mode).
              </span>
            </span>
            <span>
              PYROSYNC<span className="footer-detail">One Earth. A unified view of fire.</span>
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          <span>{notice}</span>
          <IconButton icon="close" label="Dismiss notification" onClick={() => setNotice("")} />
        </div>
      )}
      {dialog === "dates" && (
        <Modal title="Set your time context" onClose={closeDialog}>
          <p className="modal-description">
            The same range applies to the globe, KPIs, trends, and export. The thermal history
            matrix keeps its long-term context.
          </p>
          <div className="date-presets">
            {[
              { label: "All time", start: "2000-11-01", end: SNAPSHOT },
              { label: "2024 season", start: "2024-01-01", end: "2024-12-31" },
              { label: "2025 season", start: "2025-01-01", end: "2025-12-31" },
            ].map((p) => {
              const active = dateStart === p.start && dateEnd === p.end;
              return (
                <Button
                  key={p.label}
                  variant={active ? "primary" : "secondary"}
                  onClick={() => {
                    setDateStart(p.start);
                    setDateEnd(p.end);
                    setDateError("");
                  }}
                >
                  {p.label}
                </Button>
              );
            })}
          </div>
          <div className="date-inputs">
            <label>
              Start date · UTC
              <Input
                type="date"
                min="2000-01-01"
                max="2026-12-31"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
              />
            </label>
            <label>
              End date · UTC
              <Input
                type="date"
                min="2000-01-01"
                max="2026-12-31"
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
              />
            </label>
          </div>
          {dateError && (
            <p className="error-text" role="alert">
              {dateError}
            </p>
          )}
          <p className="inline-note">
            <Icon name="info" size={14} />
            Data after 15 Apr 2026 is unavailable, not zero.
          </p>
          <div className="modal-actions">
            <Button onClick={closeDialog}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (
                  !dateStart ||
                  !dateEnd ||
                  dateStart > dateEnd ||
                  dateStart < "2000-01-01" ||
                  dateEnd > "2026-12-31"
                ) {
                  setDateError(
                    "Select valid dates between 2000 and 2026. The end must not precede the start.",
                  );
                  return;
                }
                setPeriod(null);
                setAnomalySel(null);
                update({ start: dateStart, end: dateEnd });
                closeDialog();
              }}
            >
              Apply date range
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "export" && (
        <ExportDialog
          onClose={closeDialog}
          rows={exportRows}
          filters={filters}
          region={`${scopeName}${filters.bounds ? " · custom area" : ""}`}
          dateLabel={dateLabel}
          activeFilters={activeFilters}
          availableFields={availableFields}
        />
      )}
    </div>
  );
}

function MethodCard({
  number,
  title,
  icon,
  children,
}: {
  number: string;
  title: string;
  icon: string;
  children: ReactNode;
}) {
  return (
    <section className="method-card">
      <div className="method-card-top">
        <Icon name={icon} size={22} />
        <span>{number}</span>
      </div>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Methodology() {
  return (
    <>
      <section className="methodology-intro">
        <div>
          <Badge tone="cyan">TRANSPARENCY IS PART OF THE PRODUCT</Badge>
          <h2>
            Understand the observation.
            <br />
            Respect the uncertainty.
          </h2>
          <p>
            PyroSync harmonizes NASA FIRMS MODIS (1 km) and VIIRS (375 m) active-fire detections across the Eastern Mediterranean (2003–2025) using satellite footprint geometry.
          </p>
        </div>
        <Flame size={64} particles />
      </section>
      <div className="methodology-grid">
        <MethodCard number="01" title="Source products & coverage" icon="satellite">
          <p>
            MODIS active-fire products commonly use ≈1 km pixels; VIIRS active-fire products use
            ≈375 m pixels. Real coverage depends on platform and product.
          </p>
          <div className="coverage-table">
            {[
              ["Terra / MODIS", "2000 onward"],
              ["Aqua / MODIS", "2002 onward"],
              ["Suomi-NPP / VIIRS", "2012 onward"],
              ["NOAA-20 / VIIRS", "2018 onward*"],
              ["NOAA-21 / VIIRS", "2023 onward*"],
            ].map(([a, b]) => (
              <div key={a}>
                <strong>{a}</strong>
                <span>{b}</span>
              </div>
            ))}
          </div>
          <small>*Broad demonstration-era boundaries, not exact product-availability dates.</small>
        </MethodCard>
        <MethodCard number="02" title="The cell/day harmonizer" icon="layers">
          <p>
            Coordinates are assigned to an approximate 0.009° grid and grouped by UTC day; source
            IDs are preserved and the unified FRP is the <strong>maximum</strong> source FRP.
          </p>
          <p>
            A production implementation needs an equal-area metric grid; a degree approximation is{" "}
            <strong>not exactly 1 km</strong> at every latitude.
          </p>
          <p>
            Each unit may include multiple independent fire activities. No physical-event identity
            or universal reduction ratio is claimed.
          </p>
        </MethodCard>
        <MethodCard number="03" title="Missing is not zero" icon="calendar">
          <p>
            Hatched cells mean the source is unavailable. Zero is an available period with no
            matching observations. VIIRS data never appears before 2012.
          </p>
          <p>
            January 2003 is the MODIS archive start; the Gold dataset covers through December 2025,
            so 2026 is partial.
          </p>
          <div className="legend-states dark">
            <span>
              <i className="state zero" />
              Zero
            </span>
            <span>
              <i className="state missing" />
              Unavailable
            </span>
            <span>
              <i className="state partial" />
              Partial
            </span>
          </div>
        </MethodCard>
        <MethodCard number="04" title="Anomalies & seasonal context" icon="anomaly">
          <p>
            Anomalies compare equivalent calendar days with a 2012–2023 median, excluding selected
            years, requiring at least five baseline years.
          </p>
          <p>
            The radar's IQR and range are descriptive. Thresholds (+25% / +75%) are illustrative and
            not empirically validated. Seasonal rankings describe history, not future probability.
          </p>
        </MethodCard>
        <MethodCard number="05" title="Validation & limitations" icon="shield">
          <p>
            Reconciliation & calibration validation passed (10/10 audit checks in reconciliation.json; r = 0.986 in Greece/Turkey calibration).
          </p>
          <p>
            FRP is not burned area. VIIRS-only does not guarantee a smaller fire. Thermal patterns
            do not prove land use, ignition source, or fire type. Not for emergency response.
          </p>
        </MethodCard>
        <MethodCard number="06" title="Traceable by design" icon="database">
          <p>
            Select any globe marker or table row to inspect its source observations and satellites.
            Exports preserve full sensor provenance and Gold matching rule metadata (match-1.1.0).
          </p>
          <p>
            The 15 April 2026 processing date is a fixed simulated snapshot. Basemap imagery: NASA
            Blue Marble (public domain) and Esri/OpenStreetMap tiles for the 2D view.
          </p>
          <div className="resource-links">
            <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer">
              NASA FIRMS documentation
              <Icon name="external" size={14} />
            </a>
            <a href="https://www.earthdata.nasa.gov/" target="_blank" rel="noreferrer">
              NASA Earthdata
              <Icon name="external" size={14} />
            </a>
          </div>
        </MethodCard>
      </div>
      <div className="scientific-notice">
        <Icon name="globe" size={20} />
        <div>
          <strong>Independent by design.</strong>
          <p>
            PYROSYNC is not owned, endorsed, or operated by NASA. No official NASA logos or
            branding are used.
          </p>
        </div>
      </div>
    </>
  );
}
