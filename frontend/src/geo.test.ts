import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  areaFor,
  buildIndex,
  hierarchy,
  parseCoordinates,
  reverseLookup,
  searchGeo,
} from "./geo.ts";

const load = (n: string) =>
  JSON.parse(readFileSync(new URL(`../public/geo/${n}`, import.meta.url), "utf8"));
const index = buildIndex(load("countries.json"), load("admin1-index.json"), load("places.json"));
const shapes = load("admin1-shapes.json");

test("search distinguishes same-named places by country and type", () => {
  const r = searchGeo(index, "Alexandria");
  const egypt = r.find((e) => e.kind === "city" && e.country === "Egypt");
  assert.ok(egypt, "Alexandria, Egypt");
  assert.equal(r[0].country, "Egypt", "most populous Alexandria ranks first");
  assert.ok(
    r.some(
      (e) =>
        e.kind === "region" &&
        e.country === "Egypt" &&
        /Alexandria/.test(e.name) &&
        e.type === "Governorate",
    ),
  );
  assert.ok(
    r.some(
      (e) =>
        e.kind === "city" && e.country === "United States of America" && e.region === "Virginia",
    ),
  );
  assert.ok(r.every((e) => e.country && e.type));
});

test("countries, regions, diacritics, ISO codes and coordinates are searchable", () => {
  assert.equal(searchGeo(index, "brazil")[0].kind, "country");
  assert.equal(searchGeo(index, "BR")[0].name, "Brazil");
  assert.ok(
    searchGeo(index, "mato grosso").some((e) => e.kind === "region" && e.country === "Brazil"),
  );
  assert.ok(
    searchGeo(index, "sao paulo").some((e) => e.kind === "city" && e.name.includes("Paulo")),
  );
  const c = searchGeo(index, "31.2N 29.9E")[0];
  assert.equal(c.kind, "coordinates");
  assert.ok(Math.abs(c.lat - 31.2) < 1e-9 && Math.abs(c.lon - 29.9) < 1e-9);
  assert.deepEqual(parseCoordinates("-12.5, -55.25"), { lat: -12.5, lon: -55.25 });
  assert.equal(parseCoordinates("95, 10"), null);
  assert.deepEqual(searchGeo(index, "zzqxw"), []);
});

test("reverse geocoding resolves country, admin-1 and settlement with honest precision", () => {
  const alex = reverseLookup(index, shapes, 31.2, 29.92);
  assert.equal(alex.country?.n, "Egypt");
  assert.equal(alex.admin?.n, "Alexandria");
  assert.equal(alex.place?.name, "Alexandria");
  assert.equal(alex.precision, "city");
  const amazon = reverseLookup(index, shapes, -9.5, -61);
  assert.equal(amazon.country?.n, "Brazil");
  assert.ok(amazon.admin);
  const ocean = reverseLookup(index, shapes, -30, -20);
  assert.equal(ocean.country, undefined);
  assert.equal(ocean.precision, "none");
  const h = hierarchy(
    index,
    { key: "pt", kind: "coordinates", name: "x", type: "Coordinates", lat: 31.2, lon: 29.92 },
    alex,
  );
  assert.deepEqual(
    h.map((e) => e.kind),
    ["country", "region", "city"],
  );
});

test("areas frame and contain correctly; cities use a 30 km radius", () => {
  const brazil = areaFor(index, shapes, searchGeo(index, "Brazil")[0])!;
  assert.ok(brazil.has({ id: "a", lat: -10, lon: -55 }));
  assert.ok(!brazil.has({ id: "b", lat: 40, lon: -100 }));
  const region = areaFor(
    index,
    shapes,
    searchGeo(index, "Mato Grosso").find((e) => e.kind === "region")!,
  )!;
  assert.ok(region.dist < brazil.dist, "regions frame closer than countries");
  const city = areaFor(index, shapes, searchGeo(index, "Alexandria")[0])!;
  assert.ok(city.dist < region.dist);
  assert.ok(city.has({ id: "c", lat: 31.25, lon: 29.95 }));
  assert.ok(!city.has({ id: "d", lat: 30.05, lon: 31.24 }));
});

test("area filter replaces the pilot-region filter and spans pilot regions", async () => {
  const { DEFAULT_FILTERS, filterRecords } = await import("./data.ts");
  const brazil = areaFor(index, shapes, searchGeo(index, "Brazil")[0])!;
  const all = filterRecords({ ...DEFAULT_FILTERS, area: brazil });
  assert.ok(
    all.some((r) => r.region === "amazon") && all.some((r) => r.region === "cerrado"),
    "Brazil spans two pilot regions",
  );
  assert.ok(all.every((r) => brazil.has(r)));
  const egypt = areaFor(index, shapes, searchGeo(index, "Egypt")[0])!;
  assert.equal(
    filterRecords({ ...DEFAULT_FILTERS, area: egypt }).length,
    0,
    "outside demonstration coverage",
  );
});
