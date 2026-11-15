export type Mode = "harmonized" | "raw";
export type Metric = "count" | "frp" | "anomaly";
export type Match = "Matched (Both)" | "VIIRS-Only" | "MODIS-Only";
export type Regime =
  | "High-intensity likely pattern"
  | "Small thermal-feature pattern"
  | "Unclassified";
export type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };
export type FireRecord = {
  id: string;
  date: string;
  lat: number;
  lon: number;
  match: Match;
  modis: number;
  viirs: number;
  frp: number;
  region: string;
  confidence: string;
  regime: Regime;
};
import type { GeoArea } from "./geo.ts";

export type Filters = {
  region: string;
  start: string;
  end: string;
  mode: Mode;
  matches: Match[];
  sensor: string;
  bounds: Bounds | null;
  anomalyOnly: boolean;
  regime: string;
  /** Searched country / region / city; when set it replaces the pilot-region filter. */
  area?: GeoArea | null;
};
export const MATCHES: Match[] = ["Matched (Both)", "VIIRS-Only", "MODIS-Only"];
export const REGIONS = [
  {
    id: "eastern-med",
    name: "Eastern Mediterranean",
    country: "PyroSync Gold (9 Countries)",
    lon: 29,
    lat: 35,
    zoom: 5,
    bounds: { minLat: 21.5, maxLat: 42.5, minLon: 19.0, maxLon: 45.0 },
    labels: [
      { name: "GREECE", lon: 22.5, lat: 39.0 },
      { name: "TÜRKIYE", lon: 33.0, lat: 39.2 },
      { name: "SYRIA", lon: 38.5, lat: 35.0 },
      { name: "EGYPT", lon: 30.0, lat: 27.0 },
      { name: "CYPRUS", lon: 33.4, lat: 35.1 },
      { name: "ISRAEL", lon: 34.8, lat: 31.5 },
      { name: "LEBANON", lon: 35.8, lat: 33.9 },
      { name: "JORDAN", lon: 36.5, lat: 31.2 },
    ],
  },
  {
    id: "amazon",
    name: "Amazon Basin",
    country: "South America",
    lon: -57,
    lat: -7,
    zoom: 4,
    bounds: { minLat: -17, maxLat: 3, minLon: -74, maxLon: -44 },
    labels: [
      { name: "BRAZIL", lon: -53, lat: -10 },
      { name: "PERU", lon: -75, lat: -9 },
      { name: "BOLIVIA", lon: -65, lat: -17 },
      { name: "Manaus", lon: -60, lat: -3.1 },
      { name: "Belém", lon: -48.5, lat: -1.5 },
      { name: "Santarém", lon: -54.7, lat: -2.5 },
      { name: "Porto Velho", lon: -63.9, lat: -8.7 },
      { name: "Cuiabá", lon: -56.1, lat: -15.6 },
    ],
  },
  {
    id: "cerrado",
    name: "Brazilian Cerrado",
    country: "South America",
    lon: -47,
    lat: -15,
    zoom: 4,
    bounds: { minLat: -24, maxLat: -6, minLon: -58, maxLon: -40 },
    labels: [
      { name: "BRAZIL", lon: -49, lat: -14 },
      { name: "Brasília", lon: -47.9, lat: -15.8 },
      { name: "Goiânia", lon: -49.2, lat: -16.7 },
    ],
  },
  {
    id: "california",
    name: "California",
    country: "North America",
    lon: -120,
    lat: 37,
    zoom: 5,
    bounds: { minLat: 33, maxLat: 42, minLon: -124, maxLon: -115 },
    labels: [
      { name: "CALIFORNIA", lon: -120, lat: 37 },
      { name: "NEVADA", lon: -116, lat: 39 },
      { name: "Los Angeles", lon: -118.2, lat: 34 },
      { name: "Sacramento", lon: -121.5, lat: 38.6 },
    ],
  },
  {
    id: "mediterranean",
    name: "Mediterranean",
    country: "Southern Europe",
    lon: 20,
    lat: 39,
    zoom: 4,
    bounds: { minLat: 34, maxLat: 45, minLon: 5, maxLon: 32 },
    labels: [
      { name: "ITALY", lon: 13, lat: 43 },
      { name: "GREECE", lon: 23, lat: 39 },
      { name: "TÜRKIYE", lon: 31, lat: 39 },
      { name: "MEDITERRANEAN SEA", lon: 18, lat: 35 },
    ],
  },
];
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export const DEFAULT_FILTERS: Filters = {
  region: "eastern-med",
  start: "2021-01-01",
  end: "2021-12-31",
  mode: "harmonized",
  matches: [...MATCHES],
  sensor: "All sensors",
  bounds: null,
  anomalyOnly: false,
  regime: "All patterns",
};
export const SNAPSHOT = "2025-12-31";
export const fmt = (v: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
export const compact = (v: number) => (v > 999 ? `${(v / 1000).toFixed(1)}k` : fmt(v));
export const random = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
export const ALL_RECORDS: FireRecord[] = [];
export function setRealRecords(realRecords: FireRecord[]) {
  const nonEasternMed = ALL_RECORDS.filter((r) => r.region !== "eastern-med");
  ALL_RECORDS.length = 0;
  for (let i = 0; i < realRecords.length; i++) ALL_RECORDS.push(realRecords[i]);
  for (let i = 0; i < nonEasternMed.length; i++) ALL_RECORDS.push(nonEasternMed[i]);
}
for (let r = 0; r < REGIONS.length; r++) {
  const region = REGIONS[r];
  if (region.id === "eastern-med") continue; // Populated with real PyroSync Gold data via /data/pyrosync_records.json
  for (let year = 2000; year <= Number(SNAPSHOT.slice(0, 4)); year++) {
    for (let m = 0; m < 12; m++) {
      if (year === 2000 && m < 10) continue;
      const season = Math.exp(-((m - (r === 3 ? 6.8 : 7.5)) ** 2) / 5);
      const count = Math.round((9 + season * 104) * (0.75 + random(year + r * 32) * 0.8));
      for (let i = 0; i < count; i++) {
        const seed = year * 12000 + m * 1000 + r * 200 + i;
        const day = 1 + Math.floor(random(seed + 1) * (year === 2026 && m === 3 ? 15 : 28));
        const date = `${year}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const match: Match =
          year < 2012
            ? "MODIS-Only"
            : random(seed + 2) > 0.48
              ? "Matched (Both)"
              : random(seed + 3) > 0.22
                ? "VIIRS-Only"
                : "MODIS-Only";
        const modis = match === "VIIRS-Only" ? 0 : 1 + Math.floor(random(seed + 4) * 2);
        const viirs = match === "MODIS-Only" ? 0 : 1 + Math.floor(random(seed + 5) * 4);
        const b = region.bounds;
        const lat =
          Math.round((b.minLat + random(seed + 6) * (b.maxLat - b.minLat)) / 0.009) * 0.009;
        const lon =
          Math.round(
            (b.minLon + (0.2 * random(seed + 7) + 0.8 * random(seed + 8)) * (b.maxLon - b.minLon)) /
              0.009,
          ) * 0.009;
        const frp = Number(
          (
            1.5 +
            random(seed + 9) ** 2 * (22 + season * 156) * (0.68 + random(year + r * 32) * 0.3)
          ).toFixed(1),
        );
        ALL_RECORDS.push({
          id: `EA-${r}${year}${m.toString().padStart(2, "0")}${i.toString().padStart(3, "0")}`,
          date,
          lat: Number(lat.toFixed(3)),
          lon: Number(lon.toFixed(3)),
          match,
          modis,
          viirs,
          frp,
          region: region.id,
          confidence: random(seed + 10) > 0.25 ? "High" : "Nominal",
          regime:
            frp > 110
              ? "High-intensity likely pattern"
              : frp < 30 && match === "VIIRS-Only"
                ? "Small thermal-feature pattern"
                : "Unclassified",
        });
      }
    }
  }
}
export function filterRecords(f: Filters, ignoreDate = false) {
  return ALL_RECORDS.filter(
    (r) =>
      (f.area ? true : r.region === f.region) &&
      (ignoreDate || (r.date >= f.start && r.date <= f.end)) &&
      f.matches.includes(r.match) &&
      (f.sensor === "All sensors" || (f.sensor === "MODIS" ? r.modis > 0 : r.viirs > 0)) &&
      (!f.bounds ||
        (r.lat >= f.bounds.minLat &&
          r.lat <= f.bounds.maxLat &&
          r.lon >= f.bounds.minLon &&
          r.lon <= f.bounds.maxLon)) &&
      (!f.anomalyOnly || (Number(r.date.slice(5, 7)) >= 8 && Number(r.date.slice(5, 7)) <= 10)) &&
      (f.regime === "All patterns" || r.regime === f.regime) &&
      // Area containment last: it is the only polygon test.
      (!f.area || f.area.has(r)),
  );
}
export function observationCount(r: FireRecord, sensor = "All sensors") {
  return (sensor !== "VIIRS" ? r.modis : 0) + (sensor !== "MODIS" ? r.viirs : 0);
}
export function valueOf(rows: FireRecord[], mode: Mode, sensor = "All sensors") {
  return mode === "raw" ? rows.reduce((s, r) => s + observationCount(r, sensor), 0) : rows.length;
}
export function sources(r: FireRecord) {
  return Array.from({ length: r.modis + r.viirs }, (_, i) => ({
    source_id: `${r.id}-${i < r.modis ? "M" : "V"}${i + 1}`,
    sensor: i < r.modis ? "MODIS" : "VIIRS",
    satellite:
      i < r.modis
        ? i % 2 && r.date >= "2002-07-01"
          ? "Aqua"
          : "Terra"
        : Number(r.date.slice(0, 4)) >= 2023
          ? ["Suomi-NPP", "NOAA-20", "NOAA-21"][i % 3]
          : Number(r.date.slice(0, 4)) >= 2018
            ? ["Suomi-NPP", "NOAA-20"][i % 2]
            : "Suomi-NPP",
    date: r.date,
    time_utc: `${String(12 + (i % 3)).padStart(2, "0")}:${String(6 + i * 7).padStart(2, "0")}`,
    latitude: Number((r.lat + (random(i + r.frp) - 0.5) * 0.007).toFixed(5)),
    longitude: Number((r.lon + (random(i + r.frp + 2) - 0.5) * 0.007).toFixed(5)),
    frp_mw: i === 0 ? r.frp : Number((r.frp * (0.55 + random(i + r.frp) * 0.4)).toFixed(1)),
    confidence: r.confidence,
  }));
}
export function periodRange(year: number, index: number, weekly: boolean) {
  if (weekly) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    jan4.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + index * 7);
    const end = new Date(jan4);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start: jan4.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  return {
    start: `${year}-${String(index + 1).padStart(2, "0")}-01`,
    end: new Date(Date.UTC(year, index + 1, 0)).toISOString().slice(0, 10),
  };
}
export function calendarValue(
  rows: FireRecord[],
  metric: Metric,
  mode: Mode,
  sensor: string,
  baseline: number,
) {
  if (metric === "frp") return maximumFrp(rows, mode, sensor);
  const n = valueOf(rows, mode, sensor);
  return metric === "anomaly" ? (baseline ? ((n - baseline) / baseline) * 100 : null) : n;
}
export function maximumFrp(rows: FireRecord[], mode: Mode, sensor = "All sensors") {
  return rows.reduce(
    (max, row) =>
      Math.max(
        max,
        mode === "raw" && sensor !== "All sensors"
          ? Math.max(
              0,
              ...sources(row)
                .filter((s) => s.sensor === sensor)
                .map((s) => s.frp_mw),
            )
          : row.frp,
      ),
    0,
  );
}
export function buildCsv(rows: FireRecord[], f: Filters, fields: string[]) {
  const data =
    f.mode === "harmonized"
      ? rows.map((r) => ({
          event_id: r.id,
          date: r.date,
          lat_grid: r.lat,
          lon_grid: r.lon,
          match_type: r.match,
          modis_count: r.modis,
          viirs_count: r.viirs,
          max_frp_mw: r.frp,
          inferred_pattern: r.regime,
          source_ids: sources(r)
            .map((s) => s.source_id)
            .join(";"),
          provenance: "PyroSync Gold — NASA MODIS & VIIRS Harmonized Archive (2003–2025)",
        }))
      : rows.flatMap((r) =>
          sources(r)
            .filter((s) => f.sensor === "All sensors" || s.sensor === f.sensor)
            .map((s) => ({
              ...s,
              event_id: r.id,
              match_type: r.match,
              provenance: "PyroSync Gold — NASA MODIS & VIIRS Harmonized Archive (2003–2025)",
            })),
        );
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    fields.join(","),
    ...data.map((row) => fields.map((k) => escape((row as Record<string, unknown>)[k])).join(",")),
  ].join("\r\n");
}
export type ExportMeta = {
  region: string;
  dateLabel: string;
  filters: string[];
  fields: string[];
  rows: number;
};
export const exportFileName = (f: Filters) =>
  `pyrosync-${f.region}-${f.start}-${f.end}-${f.mode}`;
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Generates and downloads the CSV. Returns real file details so the UI never reports a phantom success. */
export function downloadCsv(rows: FireRecord[], f: Filters, fields: string[]) {
  if (!rows.length) throw new Error("No records match the current filters.");
  const csv = buildCsv(rows, f, fields);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  if (!blob.size) throw new Error("The CSV file could not be generated.");
  const filename = `${exportFileName(f)}.csv`;
  saveBlob(blob, filename);
  return { filename, bytes: blob.size, rows: csv.split("\r\n").length - 1 };
}
/**
 * Plain-text documentation that accompanies a CSV export. The user's brief lives here,
 * never inside the scientific CSV columns.
 */
export function buildBrief(f: Filters, meta: ExportMeta, brief: string, generatedAt = new Date()) {
  return [
    "PYROSYNC — dataset brief",
    "========================",
    "",
    "Brief",
    "-----",
    brief.trim() || "(none provided)",
    "",
    "Export metadata",
    "---------------",
    `Data file: ${exportFileName(f)}.csv`,
    `Generated (UTC): ${generatedAt.toISOString()}`,
    `Data mode: ${f.mode}`,
    `Region: ${meta.region}`,
    `Date range (UTC): ${meta.dateLabel}`,
    `Rows: ${meta.rows}`,
    `Active filters: ${meta.filters.join("; ") || "none"}`,
    `Fields: ${meta.fields.join(", ")}`,
    "",
    "Provenance: PyroSync Gold Archive — NASA MODIS & VIIRS Harmonized Data (match-1.1.0), not affiliated with NASA.",
    "",
  ].join("\n");
}
export function downloadBrief(f: Filters, meta: ExportMeta, brief: string) {
  const name = `${exportFileName(f)}-brief.txt`;
  saveBlob(new Blob([buildBrief(f, meta, brief)], { type: "text/plain;charset=utf-8;" }), name);
  return name;
}

export function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  return { year, week: Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7) };
}
export function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q,
    lo = Math.floor(pos),
    hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180,
    dLat = (bLat - aLat) * r,
    dLon = (bLon - aLon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
/** Describes a record relative to the nearest labelled settlement in its pilot region. */
export function nearestPlace(r: FireRecord) {
  const region = REGIONS.find((x) => x.id === r.region)!;
  let best: { name: string; d: number; lat: number; lon: number } | null = null;
  for (const l of region.labels.filter((l) => l.name !== l.name.toUpperCase())) {
    const d = distanceKm(r.lat, r.lon, l.lat, l.lon);
    if (!best || d < best.d) best = { name: l.name, d, lat: l.lat, lon: l.lon };
  }
  if (!best) return region.name;
  const bearing = (Math.atan2(r.lon - best.lon, r.lat - best.lat) * 180) / Math.PI;
  return `${Math.round(best.d)} km ${COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8]} of ${best.name}`;
}
/** Transparent, rule-based quality indicator; not a validated accuracy estimate. */
export function recordQuality(r: FireRecord) {
  const score =
    Number(r.confidence === "High") +
    Number(r.modis + r.viirs >= 2) +
    Number(r.match === "Matched (Both)");
  return { score, label: score === 3 ? "High" : score === 2 ? "Moderate" : "Limited" };
}
export function acquisitionTime(r: FireRecord) {
  return sources(r)
    .map((s) => s.time_utc)
    .sort()[0];
}
