import {
  SNAPSHOT,
  isoWeek,
  observationCount,
  quantile,
  sources,
  type FireRecord,
  type Mode,
} from "./data.ts";

/**
 * THERMAL ANOMALY ENGINE — documented, seasonally matched methodology.
 *  • Baseline: the same calendar period (7-day window, ISO week, month, or year) in 2012–2023,
 *    the multi-sensor era, excluding the evaluated year (leave-one-out). ≥5 baseline years required.
 *  • Anomaly % = (observed − median) / median × 100; undefined when the median is 0.
 *  • Modified z = (observed − median) / (MAD / 0.6745) (Iglewicz & Hoaglin); mean-absolute-deviation
 *    fallback (×1.2533) when MAD = 0.
 *  • Classes (illustrative, not validated): Elevated = z ≥ 2 and ≥ +25%; Extreme = z ≥ 3.5 and ≥ +75%;
 *    Below = z ≤ −2 and ≤ −25%. Missing or incompatible coverage is never treated as normal.
 *  • A day is anomalous when its centred 7-day window (sparse daily counts are smoothed) is Elevated/Extreme.
 */
export const BASE_START = 2012,
  BASE_END = 2023,
  MIN_YEARS = 5;
export const DATA_START = "2000-11-01";
export type Resolution = "day" | "week" | "month" | "year";
export type Cls = "extreme" | "elevated" | "normal" | "below" | "nobase" | "nodata" | "partial";
export const isAnomalous = (c: Cls) => c === "elevated" || c === "extreme";
export type Baseline = { median: number; q1: number; q3: number; mad: number; n: number };
export type Run = { len: number; start: string; end: string; peak: number | null };
export type APoint = {
  key: string;
  res: Resolution;
  label: string;
  start: string;
  end: string;
  year: number;
  index: number; // month 0–11 or ISO week 0–52 (for calendar sync)
  observed: number | null;
  base: Baseline | null;
  pct: number | null;
  z: number | null;
  cls: Cls;
  anomDays: number;
  run: Run | null;
  firstAnom: string | null;
  lastAnom: string | null;
  missingDays: number;
};
export type Day = {
  date: string;
  count: number;
  window: number | null;
  base: Baseline | null;
  pct: number | null;
  z: number | null;
  cls: Cls;
};

const DAY = 86400000;
const dateAt = (t: number) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.parse(`${DATA_START}T00:00:00Z`),
  T1 = Date.parse(`${SNAPSHOT}T00:00:00Z`);
export const dayIndex = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - T0) / DAY);
const N = Math.round((T1 - T0) / DAY) + 1;
const DATES = Array.from({ length: N }, (_, i) => dateAt(T0 + i * DAY));

export function baseline(values: number[]): Baseline | null {
  if (values.length < MIN_YEARS) return null;
  const v = [...values].sort((a, b) => a - b);
  const median = quantile(v, 0.5);
  const dev = v.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  return {
    median,
    q1: quantile(v, 0.25),
    q3: quantile(v, 0.75),
    mad: quantile(dev, 0.5),
    n: v.length,
  };
}
export function classify(
  observed: number,
  b: Baseline | null,
  values?: number[],
): { pct: number | null; z: number | null; cls: Cls } {
  if (!b) return { pct: null, z: null, cls: "nobase" };
  let spread = b.mad / 0.6745;
  if (!spread && values?.length)
    spread = (values.reduce((s, x) => s + Math.abs(x - b.median), 0) / values.length) * 1.2533;
  const z = spread > 0 ? (observed - b.median) / spread : null;
  if (b.median <= 0) return { pct: null, z, cls: "nobase" }; // percentage undefined at a zero median
  const pct = ((observed - b.median) / b.median) * 100;
  const cls: Cls =
    z !== null && z >= 3.5 && pct >= 75
      ? "extreme"
      : z !== null && z >= 2 && pct >= 25
        ? "elevated"
        : z !== null && z <= -2 && pct <= -25
          ? "below"
          : "normal";
  return { pct, z, cls };
}
const sameDay = (year: number, date: string) => {
  const md = date.slice(5);
  const d = `${year}-${md === "02-29" ? "02-28" : md}`;
  return dayIndex(d);
};

export type Engine = {
  days: Day[];
  month: APoint[];
  week: APoint[];
  year: APoint[];
  covStart: string;
  viirsOnly: boolean;
};

/** Builds every resolution once per (history, mode, sensor) so chart interactions stay cheap. */
export function buildEngine(
  history: FireRecord[],
  mode: Mode,
  sensor: string,
  viirsOnly: boolean,
): Engine {
  const covStart = viirsOnly ? "2012-01-01" : DATA_START;
  const c0 = dayIndex(covStart);
  const counts = new Float64Array(N);
  for (const r of history) {
    const i = dayIndex(r.date);
    if (i >= 0 && i < N) counts[i] += mode === "raw" ? observationCount(r, sensor) : 1;
  }
  const win: (number | null)[] = new Array(N).fill(null);
  for (let i = c0 + 3; i < N - 3; i++) {
    let s = 0;
    for (let k = -3; k <= 3; k++) s += counts[i + k];
    win[i] = s;
  }
  const days: Day[] = DATES.map((date, i) => {
    const y = Number(date.slice(0, 4));
    if (i < c0)
      return { date, count: 0, window: null, base: null, pct: null, z: null, cls: "nodata" as Cls };
    if (win[i] === null)
      return {
        date,
        count: counts[i],
        window: null,
        base: null,
        pct: null,
        z: null,
        cls: "partial" as Cls,
      };
    if (y < BASE_START)
      return {
        date,
        count: counts[i],
        window: win[i],
        base: null,
        pct: null,
        z: null,
        cls: "nobase" as Cls,
      };
    const vals: number[] = [];
    for (let by = BASE_START; by <= BASE_END; by++) {
      if (by === y) continue;
      const v = win[sameDay(by, date)];
      if (v !== null && v !== undefined) vals.push(v);
    }
    const b = baseline(vals);
    return { date, count: counts[i], window: win[i], base: b, ...classify(win[i]!, b, vals) };
  });

  const runIn = (
    a: number,
    z: number,
  ): {
    run: Run | null;
    anom: number;
    first: string | null;
    last: string | null;
    missing: number;
  } => {
    let best: Run | null = null,
      cur = 0,
      curStart = a,
      peak: number | null = null,
      curPeak: number | null = null,
      anom = 0,
      first: string | null = null,
      last: string | null = null,
      missing = 0;
    for (let i = Math.max(0, a); i <= Math.min(N - 1, z); i++) {
      const d = days[i];
      if (d.cls === "nodata" || d.cls === "nobase" || d.cls === "partial") missing++;
      if (isAnomalous(d.cls)) {
        anom++;
        first ??= d.date;
        last = d.date;
        if (!cur) ((curStart = i), (curPeak = null));
        cur++;
        curPeak = Math.max(curPeak ?? -Infinity, d.pct ?? -Infinity);
        if (!best || cur > best.len)
          best = { len: cur, start: days[curStart].date, end: d.date, peak: curPeak };
      } else cur = 0; // non-anomalous AND missing days both break continuity
      peak = peak;
    }
    return { run: best, anom, first, last, missing };
  };
  const total = (a: number, z: number) => {
    let s = 0;
    for (let i = a; i <= z; i++) s += counts[i];
    return s;
  };
  const point = (
    res: Resolution,
    key: string,
    label: string,
    start: string,
    end: string,
    year: number,
    index: number,
    baseVals: () => number[],
  ): APoint => {
    const a = dayIndex(start),
      z = dayIndex(end);
    const covered = a >= c0 && z <= N - 1;
    const partial = z > N - 1 || (a < c0 && z >= c0);
    const stats = runIn(Math.max(a, c0), Math.min(z, N - 1));
    const base = {
      key,
      res,
      label,
      start,
      end,
      year,
      index,
      anomDays: stats.anom,
      run: stats.run,
      firstAnom: stats.first,
      lastAnom: stats.last,
      missingDays: stats.missing,
    };
    if (z < c0)
      return {
        ...base,
        observed: null,
        base: null,
        pct: null,
        z: null,
        cls: "nodata",
        missingDays: z - a + 1,
      };
    const observed = total(Math.max(a, c0), Math.min(z, N - 1));
    if (!covered || partial)
      return { ...base, observed, base: null, pct: null, z: null, cls: "partial" };
    if (year < BASE_START)
      return { ...base, observed, base: null, pct: null, z: null, cls: "nobase" };
    const vals = baseVals();
    const b = baseline(vals);
    return { ...base, observed, base: b, ...classify(observed, b, vals) };
  };
  const monthEnd = (y: number, m: number) =>
    new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  const month: APoint[] = [];
  for (let y = 2000; y <= Number(SNAPSHOT.slice(0, 4)); y++)
    for (let m = 0; m < 12; m++) {
      const start = `${y}-${String(m + 1).padStart(2, "0")}-01`;
      if (start < DATA_START || start > SNAPSHOT) continue;
      month.push(
        point(
          "month",
          start.slice(0, 7),
          new Date(`${start}T12:00:00Z`).toLocaleDateString("en-GB", {
            month: "short",
            year: "numeric",
          }),
          start,
          monthEnd(y, m),
          y,
          m,
          () => {
            const v: number[] = [];
            for (let by = BASE_START; by <= BASE_END; by++)
              if (by !== y)
                v.push(total(dayIndex(`${by}-${start.slice(5, 7)}-01`), dayIndex(monthEnd(by, m))));
            return v;
          },
        ),
      );
    }
  const weekStart = (iy: number, w: number) => {
    const jan4 = new Date(Date.UTC(iy, 0, 4));
    jan4.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (w - 1) * 7);
    return jan4.toISOString().slice(0, 10);
  };
  const week: APoint[] = [];
  const firstW = isoWeek(DATA_START),
    lastW = isoWeek(SNAPSHOT);
  for (let iy = firstW.year; iy <= lastW.year; iy++) {
    const weeks = isoWeek(`${iy}-12-28`).week;
    for (let w = 1; w <= weeks; w++) {
      if (iy === firstW.year && w < firstW.week) continue;
      if (iy === lastW.year && w > lastW.week) break;
      const start = weekStart(iy, w),
        end = dateAt(Date.parse(`${start}T00:00:00Z`) + 6 * DAY);
      week.push(
        point(
          "week",
          `${iy}-W${String(w).padStart(2, "0")}`,
          `W${w} ${iy}`,
          start,
          end,
          iy,
          w - 1,
          () => {
            const v: number[] = [];
            for (let by = BASE_START; by <= BASE_END; by++) {
              if (by === iy || isoWeek(`${by}-12-28`).week < w) continue;
              const s = weekStart(by, w);
              v.push(total(dayIndex(s), dayIndex(s) + 6));
            }
            return v;
          },
        ),
      );
    }
  }
  const year: APoint[] = [];
  for (let y = 2000; y <= Number(SNAPSHOT.slice(0, 4)); y++)
    year.push(
      point("year", String(y), String(y), `${y}-01-01`, `${y}-12-31`, y, 0, () => {
        const v: number[] = [];
        for (let by = BASE_START; by <= BASE_END; by++)
          if (by !== y) v.push(total(dayIndex(`${by}-01-01`), dayIndex(`${by}-12-31`)));
        return v;
      }),
    );
  return { days, month, week, year, covStart, viirsOnly };
}

export function dayPoints(e: Engine, start: string, end: string): APoint[] {
  const a = Math.max(0, dayIndex(start)),
    z = Math.min(e.days.length - 1, dayIndex(end));
  const out: APoint[] = [];
  for (let i = a; i <= z; i++) {
    const d = e.days[i];
    const anom = isAnomalous(d.cls);
    out.push({
      key: d.date,
      res: "day",
      label: d.date,
      start: d.date,
      end: d.date,
      year: Number(d.date.slice(0, 4)),
      index: 0,
      observed: d.window,
      base: d.base,
      pct: d.pct,
      z: d.z,
      cls: d.cls,
      anomDays: anom ? 1 : 0,
      run: anom ? { len: 1, start: d.date, end: d.date, peak: d.pct } : null,
      firstAnom: anom ? d.date : null,
      lastAnom: anom ? d.date : null,
      missingDays: d.cls === "nodata" || d.cls === "nobase" || d.cls === "partial" ? 1 : 0,
    });
  }
  return out;
}

export const inScope = (p: { start: string; end: string }, s: { start: string; end: string }) =>
  p.start >= s.start && p.end <= s.end;

export type Kpis = {
  anomalyDays: number;
  previous: { days: number; comparable: boolean; start: string; end: string } | null;
  missingDays: number;
  totalDays: number;
  month: APoint | null;
  year: APoint | null;
  maxFrp: {
    record: FireRecord;
    frp: number;
    sensor: string;
    satellite: string;
    time: string;
  } | null;
  run: Run | null;
};
/** Five anomaly KPIs for a scope (analysis range or a selected period). */
export function computeKpis(
  e: Engine,
  history: FireRecord[],
  scope: { start: string; end: string },
): Kpis {
  const a = Math.max(0, dayIndex(scope.start)),
    z = Math.min(e.days.length - 1, dayIndex(scope.end));
  let anomalyDays = 0,
    missing = 0,
    cur = 0,
    curStart = a,
    curPeak = -Infinity;
  let run: Run | null = null;
  for (let i = a; i <= z; i++) {
    const d = e.days[i];
    if (d.cls === "nodata" || d.cls === "nobase" || d.cls === "partial") missing++;
    if (isAnomalous(d.cls)) {
      anomalyDays++;
      if (!cur) ((curStart = i), (curPeak = -Infinity));
      cur++;
      curPeak = Math.max(curPeak, d.pct ?? -Infinity);
      if (!run || cur > run.len)
        run = {
          len: cur,
          start: e.days[curStart].date,
          end: d.date,
          peak: Number.isFinite(curPeak) ? curPeak : null,
        };
    } else cur = 0;
  }
  const len = z - a + 1;
  let previous: Kpis["previous"] = null;
  if (a - len >= 0) {
    let n = 0,
      gaps = 0;
    for (let i = a - len; i < a; i++) {
      if (isAnomalous(e.days[i].cls)) n++;
      if (e.days[i].cls === "nodata" || e.days[i].cls === "nobase") gaps++;
    }
    previous = {
      days: n,
      comparable: gaps === 0,
      start: e.days[a - len].date,
      end: e.days[a - 1].date,
    };
  }
  const valid = (p: APoint) => p.pct !== null && inScope(p, scope);
  const month = e.month
    .filter(valid)
    .reduce<APoint | null>(
      (m, p) => (!m || p.pct! > m.pct! || (p.pct === m.pct && (p.z ?? 0) > (m.z ?? 0)) ? p : m),
      null,
    );
  // A single selected period sits inside one year: report that (complete) year's annual anomaly.
  const years = e.year.filter(
    (p) =>
      p.pct !== null &&
      p.end >= scope.start &&
      p.start <= scope.end &&
      (inScope(p, scope) || len < 366),
  );
  const year = years.reduce<APoint | null>((m, p) => (!m || p.pct! > m.pct! ? p : m), null);
  let maxFrp: Kpis["maxFrp"] = null;
  for (const r of history) {
    if (r.date < scope.start || r.date > scope.end) continue;
    if (!maxFrp || r.frp > maxFrp.frp) {
      const s = sources(r).reduce((x, y) => (y.frp_mw > x.frp_mw ? y : x));
      maxFrp = {
        record: r,
        frp: r.frp,
        sensor: s.sensor,
        satellite: s.satellite,
        time: s.time_utc,
      };
    }
  }
  return { anomalyDays, previous, missingDays: missing, totalDays: len, month, year, maxFrp, run };
}

export type PeriodDetail = {
  records: FireRecord[];
  maxFrp: FireRecord | null;
  meanFrp: number | null;
  composition: {
    matched: number;
    viirsOnly: number;
    modisOnly: number;
    modis: number;
    viirs: number;
  };
  interpretation: string;
};
const clsWord: Record<Cls, string> = {
  extreme: "Extreme",
  elevated: "Elevated",
  normal: "Within the normal range",
  below: "Below baseline",
  nobase: "Not classifiable (no compatible baseline)",
  nodata: "No data",
  partial: "Partial coverage",
};
export const clsLabel = (c: Cls) => clsWord[c];
export function periodDetail(
  p: APoint,
  history: FireRecord[],
  mode: Mode,
  unit: string,
  scopeName: string,
): PeriodDetail {
  const records = history.filter((r) => r.date >= p.start && r.date <= p.end);
  const maxFrp = records.reduce<FireRecord | null>((m, r) => (!m || r.frp > m.frp ? r : m), null);
  const frps =
    mode === "raw"
      ? records.flatMap((r) => sources(r).map((s) => s.frp_mw))
      : records.map((r) => r.frp);
  const meanFrp = frps.length ? frps.reduce((s, x) => s + x, 0) / frps.length : null;
  const composition = {
    matched: records.filter((r) => r.match === "Matched (Both)").length,
    viirsOnly: records.filter((r) => r.match === "VIIRS-Only").length,
    modisOnly: records.filter((r) => r.match === "MODIS-Only").length,
    modis: records.reduce((s, r) => s + r.modis, 0),
    viirs: records.reduce((s, r) => s + r.viirs, 0),
  };
  const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const obsWord = p.res === "day" ? `The 7-day window centred on ${p.label}` : p.label;
  let interpretation: string;
  if (p.cls === "nodata")
    interpretation = `${p.label} is outside the available source coverage for ${scopeName}; no observations exist, which is different from zero activity.`;
  else if (p.cls === "partial")
    interpretation = `${p.label} is only partially covered (the demonstration snapshot ends 15 Apr 2026 or coverage starts mid-period), so it is not compared with the baseline.`;
  else if (p.cls === "nobase")
    interpretation =
      p.year < BASE_START
        ? `${p.label} predates the 2012–2023 multi-sensor baseline, so an anomaly is not computed for ${scopeName}.`
        : `${obsWord} cannot be classified: fewer than ${MIN_YEARS} comparable baseline years or a zero median for ${scopeName}.`;
  else {
    const dir = p.pct! >= 0 ? "above" : "below";
    interpretation = `${obsWord} recorded ${f(p.observed!)} ${unit}, ${f(Math.abs(p.pct!))}% ${dir} the 2012–2023 median of ${f(p.base!.median)} for the same seasonal period (modified z = ${p.z === null ? "n/a" : p.z.toFixed(1)}), classified as ${clsWord[p.cls]} for ${scopeName}.`;
    if (p.res !== "day")
      interpretation += p.anomDays
        ? ` ${p.anomDays} day${p.anomDays === 1 ? " was" : "s were"} individually anomalous${p.run && p.run.len > 1 ? `, including a ${p.run.len}-day run from ${p.run.start} to ${p.run.end}` : ""}.`
        : " No individual day reached anomaly thresholds.";
    if (maxFrp)
      interpretation += ` The strongest signal was ${f(maxFrp.frp)} MW (${maxFrp.id}) on ${maxFrp.date}.`;
  }
  return { records, maxFrp, meanFrp, composition, interpretation };
}
