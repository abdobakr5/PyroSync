import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_RECORDS,
  DEFAULT_FILTERS,
  MATCHES,
  REGIONS,
  SNAPSHOT,
  buildCsv,
  calendarValue,
  filterRecords,
  maximumFrp,
  observationCount,
  periodRange,
  setRealRecords,
  sources,
  valueOf,
  type Filters,
  type FireRecord,
} from "./data.ts";

setRealRecords(
  JSON.parse(
    readFileSync(new URL("../public/data/pyrosync_records.json", import.meta.url), "utf8"),
  ) as FireRecord[],
);

test("synthetic source availability respects platform eras and snapshot", () => {
  assert.ok(ALL_RECORDS.length > 10000);
  for (const row of ALL_RECORDS) {
    assert.ok(row.date >= "2000-11-01" && row.date <= SNAPSHOT);
    if (row.date < "2012-01-01") {
      assert.equal(row.viirs, 0);
      assert.equal(row.match, "MODIS-Only");
    }
    for (const source of sources(row)) {
      if (source.satellite === "Aqua") assert.ok(row.date >= "2002-07-01");
      if (source.satellite === "NOAA-20") assert.ok(row.date >= "2018-01-01");
      if (source.satellite === "NOAA-21") assert.ok(row.date >= "2023-01-01");
    }
  }
});

test("each analytical unit retains source counts, identifiers, and true maximum FRP", () => {
  const ids = new Set<string>();
  for (const row of filterRecords(DEFAULT_FILTERS)) {
    const source = sources(row);
    assert.equal(source.length, row.modis + row.viirs);
    assert.equal(source.filter((s) => s.sensor === "MODIS").length, row.modis);
    assert.equal(Math.max(...source.map((s) => s.frp_mw)), row.frp);
    for (const s of source) {
      assert.ok(!ids.has(s.source_id));
      ids.add(s.source_id);
    }
  }
});

test("region, date, sensor, match, and area filters compose consistently", () => {
  const bounds = { minLat: -11, maxLat: -3, minLon: -66, maxLon: -50 };
  const f: Filters = {
    ...DEFAULT_FILTERS,
    region: "amazon",
    start: "2024-08-01",
    end: "2024-08-31",
    bounds,
    matches: ["Matched (Both)"],
    sensor: "VIIRS",
  };
  const rows = filterRecords(f);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.region, "amazon");
    assert.equal(r.match, "Matched (Both)");
    assert.ok(r.date >= f.start && r.date <= f.end && r.viirs > 0);
    assert.ok(
      r.lat >= bounds.minLat &&
        r.lat <= bounds.maxLat &&
        r.lon >= bounds.minLon &&
        r.lon <= bounds.maxLon,
    );
  }
  assert.equal(
    valueOf(rows, "raw", "VIIRS"),
    rows.reduce((n, r) => n + r.viirs, 0),
  );
  assert.equal(valueOf(rows, "harmonized"), rows.length);
});

test("match distributions partition records without implying physical-event identity", () => {
  const rows = filterRecords(DEFAULT_FILTERS);
  assert.equal(
    MATCHES.reduce((n, m) => n + rows.filter((r) => r.match === m).length, 0),
    rows.length,
  );
  assert.ok(valueOf(rows, "raw") >= valueOf(rows, "harmonized"));
  assert.equal(filterRecords({ ...DEFAULT_FILTERS, matches: [] }).length, 0);
});

test("calendar counts reconcile with active-period totals and distinguish unavailable baselines", () => {
  const rows = filterRecords(DEFAULT_FILTERS);
  for (const mode of ["raw", "harmonized"] as const) {
    const monthly = Array.from({ length: 12 }, (_, i) =>
      rows.filter((r) => Number(r.date.slice(5, 7)) === i + 1),
    );
    assert.equal(
      monthly.reduce((n, r) => n + (calendarValue(r, "count", mode, "All sensors", 0) || 0), 0),
      valueOf(rows, mode),
    );
  }
  assert.equal(calendarValue([], "count", "harmonized", "All sensors", 0), 0);
  assert.equal(calendarValue([], "anomaly", "harmonized", "All sensors", 0), null);
});

test("FRP metric respects selected raw sensor observations", () => {
  const rows = filterRecords({ ...DEFAULT_FILTERS, matches: ["Matched (Both)"] });
  const viirsMax = Math.max(
    ...rows.flatMap((r) =>
      sources(r)
        .filter((s) => s.sensor === "VIIRS")
        .map((s) => s.frp_mw),
    ),
  );
  assert.equal(maximumFrp(rows, "raw", "VIIRS"), viirsMax);
  assert.equal(calendarValue(rows, "frp", "raw", "VIIRS", 0), viirsMax);
  assert.equal(maximumFrp([], "harmonized"), 0);
});

test("harmonized CSV has exact rows, selected fields, source identifiers, and synthetic provenance", () => {
  const rows = filterRecords(DEFAULT_FILTERS).slice(0, 5);
  const csv = buildCsv(rows, DEFAULT_FILTERS, ["event_id", "source_ids", "provenance"]);
  assert.equal(csv.split("\r\n").length, rows.length + 1);
  assert.equal(csv.split("\r\n")[0], "event_id,source_ids,provenance");
  for (const r of rows) {
    assert.ok(csv.includes(r.id));
    assert.ok(csv.includes(sources(r)[0].source_id));
  }
  assert.ok(csv.includes("PyroSync Gold"));
});

test("raw CSV expands exactly the selected source family and escapes quotes", () => {
  const f: Filters = { ...DEFAULT_FILTERS, mode: "raw", sensor: "VIIRS" };
  const rows = filterRecords(f).slice(0, 5);
  const csv = buildCsv(rows, f, ["source_id", "sensor", "satellite", "provenance"]);
  assert.equal(
    csv.split("\r\n").length,
    rows.reduce((n, r) => n + observationCount(r, "VIIRS"), 0) + 1,
  );
  assert.ok(!csv.includes('"MODIS"'));
  const quoted = buildCsv([{ ...rows[0], id: 'EA-"quoted",record' }], DEFAULT_FILTERS, [
    "event_id",
  ]);
  assert.ok(quoted.includes('"EA-""quoted"",record"'));
});

test("monthly and ISO-week date ranges use UTC and leap-year boundaries", () => {
  assert.deepEqual(periodRange(2024, 1, false), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(periodRange(2020, 52, true), { start: "2020-12-28", end: "2021-01-03" });
  assert.deepEqual(periodRange(2024, 0, true), { start: "2024-01-01", end: "2024-01-07" });
  assert.equal(REGIONS.length, 5);
});

test("helper calculations are deterministic and bounded", async () => {
  const { isoWeek, quantile, nearestPlace, recordQuality, distanceKm } = await import("./data.ts");
  assert.deepEqual(isoWeek("2021-01-03"), { year: 2020, week: 53 });
  assert.deepEqual(isoWeek("2024-08-20"), { year: 2024, week: 34 });
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.19) < 0.1);
  const r = filterRecords({ ...DEFAULT_FILTERS, region: "amazon" })[0];
  assert.match(nearestPlace(r), /km (N|NE|E|SE|S|SW|W|NW) of /);
  assert.ok(["High", "Moderate", "Limited"].includes(recordQuality(r).label));
});

test("dataset brief is separate documentation with metadata and synthetic provenance", async () => {
  const { buildBrief } = await import("./data.ts");
  const meta = {
    region: "Amazon Basin",
    dateLabel: "1 Jan 2024 – 31 Dec 2024",
    filters: ["Matched (Both)"],
    fields: ["event_id"],
    rows: 12,
  };
  const txt = buildBrief(
    DEFAULT_FILTERS,
    meta,
    "  Seasonal analysis note  ",
    new Date("2026-04-15T00:00:00Z"),
  );
  assert.match(txt, /Seasonal analysis note/);
  assert.match(txt, /Rows: 12/);
  assert.match(txt, /Generated \(UTC\): 2026-04-15T00:00:00.000Z/);
  assert.match(txt, /PyroSync Gold Archive/);
  assert.match(buildBrief(DEFAULT_FILTERS, meta, ""), /\(none provided\)/);
  // The CSV itself is unaffected by any brief.
  const rows = filterRecords(DEFAULT_FILTERS).slice(0, 2);
  assert.ok(!buildCsv(rows, DEFAULT_FILTERS, ["event_id", "provenance"]).includes("Seasonal"));
});
