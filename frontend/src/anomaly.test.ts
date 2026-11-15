import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_FILTERS, SNAPSHOT, filterRecords, setRealRecords, type FireRecord } from "./data.ts";
import {
  baseline,
  buildEngine,
  classify,
  computeKpis,
  dayIndex,
  dayPoints,
  isAnomalous,
  periodDetail,
} from "./anomaly.ts";

setRealRecords(
  JSON.parse(
    readFileSync(new URL("../public/data/pyrosync_records.json", import.meta.url), "utf8"),
  ) as FireRecord[],
);

const history = filterRecords(DEFAULT_FILTERS, true);
const e = buildEngine(history, "harmonized", "All sensors", false);

test("anomaly % and modified z follow the documented formulas; zero medians never divide", () => {
  const b = baseline([10, 12, 8, 11, 9, 10, 13])!;
  assert.equal(b.median, 10);
  const c = classify(20, b);
  assert.equal(c.pct, 100);
  assert.ok(Math.abs(c.z! - (20 - 10) / (b.mad / 0.6745)) < 1e-9);
  assert.equal(c.cls, "extreme");
  assert.equal(classify(5, baseline([0, 0, 0, 0, 0])).cls, "nobase");
  assert.equal(classify(5, baseline([1, 2, 3])).cls, "nobase", "needs ≥5 baseline years");
});

test("coverage gaps are never normal: pre-2012 has no baseline, pre-Nov-2000 has no data", () => {
  assert.equal(e.month.find((p) => p.key === "2005-08")!.cls, "nobase");
  assert.equal(e.year.find((p) => p.key === "2000")!.cls, "partial");
  const viirs = buildEngine(history, "harmonized", "VIIRS", true);
  assert.equal(viirs.days[dayIndex("2010-06-01")].cls, "nodata");
  for (const p of e.month) if (p.cls === "normal") assert.notEqual(p.pct, null);
});

test("monthly observed counts reconcile with records and baselines exclude the evaluated year", () => {
  const aug = e.month.find((p) => p.key === "2024-08")!;
  assert.equal(aug.observed, history.filter((r) => r.date.startsWith("2024-08")).length);
  const aug2015 = e.month.find((p) => p.key === "2015-08")!;
  assert.equal(aug2015.base!.n, 11, "leave-one-out baseline");
  assert.equal(aug.base!.n, 12);
});

test("KPIs: anomaly days, consecutive runs on real calendar dates, max FRP, most anomalous month/year", () => {
  const scope = { start: "2012-01-01", end: SNAPSHOT };
  const k = computeKpis(e, history, scope);
  const manual = e.days.filter(
    (d) => d.date >= scope.start && d.date <= scope.end && isAnomalous(d.cls),
  ).length;
  assert.equal(k.anomalyDays, manual);
  if (k.run) {
    const span = (Date.parse(k.run.end) - Date.parse(k.run.start)) / 86400000 + 1;
    assert.equal(span, k.run.len, "run uses consecutive calendar dates");
    for (let i = dayIndex(k.run.start); i <= dayIndex(k.run.end); i++)
      assert.ok(isAnomalous(e.days[i].cls));
  }
  assert.equal(
    k.maxFrp!.frp,
    Math.max(...history.filter((r) => r.date >= scope.start).map((r) => r.frp)),
  );
  assert.ok(
    k.month &&
      k.month.pct ===
        Math.max(
          ...e.month
            .filter((p) => p.pct !== null && p.start >= scope.start && p.end <= scope.end)
            .map((p) => p.pct!),
        ),
  );
  assert.ok(k.year && k.year.cls !== "partial");
  const one = computeKpis(e, history, { start: "2024-08-01", end: "2024-08-31" });
  assert.ok(one.anomalyDays <= 31);
  assert.equal(one.year?.key, "2024");
});

test("daily points expose window-smoothed values; period detail derives interpretation from measurements", () => {
  const d = dayPoints(e, "2024-08-01", "2024-08-31");
  assert.equal(d.length, 31);
  const aug = e.month.find((p) => p.key === "2024-08")!;
  const det = periodDetail(aug, history, "harmonized", "analytical records", "Amazon Basin");
  assert.equal(det.records.length, aug.observed);
  assert.equal(
    det.composition.matched + det.composition.viirsOnly + det.composition.modisOnly,
    det.records.length,
  );
  assert.match(det.interpretation, /Aug 2024/);
  assert.match(
    periodDetail(
      e.month.find((p) => p.key === "2005-08")!,
      history,
      "harmonized",
      "records",
      "X",
    ).interpretation,
    /predates/,
  );
});
