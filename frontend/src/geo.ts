/**
 * Offline geographic intelligence built on Natural Earth (public domain):
 * 1:50m countries, 1:10m admin-1 regions (simplified), 1:10m populated places.
 * Data is fetched lazily from /geo and cached; no external geocoding service is called.
 */
export type Rings = number[][]; // each ring: flat [lon, lat, lon, lat, ...]
export type Polys = Rings[];
export type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat
export type Country = {
  n: string;
  nl: string;
  alt: string;
  f: string;
  iso: string;
  a3: string;
  cont: string;
  sub: string;
  lx: number;
  ly: number;
  b: BBox;
  cap: string | null;
  p: Polys;
};
export type Admin1 = {
  id: string;
  n: string;
  ln: string;
  alt: string;
  t: string;
  iso: string;
  c: string;
  lx: number;
  ly: number;
  b: BBox;
};
type PlaceRow = [string, string, string, string, string, string, number, number, number, number];
export type Place = {
  name: string;
  adm1: string;
  iso: string;
  country: string;
  lat: number;
  lon: number;
  pop: number;
  cls: number;
};
export type GeoIndex = {
  countries: Country[];
  admin1: Admin1[];
  places: Place[];
  byIso: Map<string, Country>;
  adminByName: Map<string, Admin1>;
  search: SearchEntry[];
};
export type GeoKind = "country" | "region" | "city" | "coordinates";
export type GeoEntity = {
  key: string;
  kind: GeoKind;
  name: string;
  type: string;
  lat: number;
  lon: number;
  bbox?: BBox;
  iso?: string;
  country?: string;
  region?: string; // admin-1 display name for cities
  regionId?: string;
  pop?: number;
  capital?: boolean;
  /** Parent context shown in suggestions (e.g. "South America" for countries). */
  context?: string;
};
type SearchEntry = { entity: GeoEntity; terms: string[]; boost: number };

export const normalize = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const BASE = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env.BASE_URL : "/";
async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}geo/${name}`);
  if (!res.ok) throw new Error(`Geographic data unavailable (${res.status})`);
  return res.json();
}

// Append the type only where it is part of common usage ("Alexandria Governorate", "Teleorman County"), not "Virginia State".
const SUFFIX_TYPES =
  /^(governorate|county|prefecture|oblast|emirate|department|canton|voivodeship)$/i;
export const regionLabel = (a: Admin1) =>
  SUFFIX_TYPES.test(a.t) && !new RegExp(a.t, "i").test(a.n) ? `${a.n} ${a.t}` : a.n;

export function buildIndex(countries: Country[], admin1: Admin1[], rows: PlaceRow[]): GeoIndex {
  const byIso = new Map(countries.filter((c) => c.iso).map((c) => [c.iso, c]));
  const places: Place[] = rows.map((r) => ({
    name: r[0],
    adm1: r[3],
    iso: r[4],
    country: byIso.get(r[4])?.n ?? r[5],
    lat: r[6],
    lon: r[7],
    pop: r[8],
    cls: r[9],
  }));
  const adminByName = new Map<string, Admin1>();
  admin1.forEach((a) => {
    adminByName.set(`${a.iso}|${normalize(a.ln)}`, a);
    adminByName.set(`${a.iso}|${normalize(a.n)}`, a);
  });
  const search: SearchEntry[] = [];
  countries.forEach((c) =>
    search.push({
      entity: countryEntity(c),
      terms: [c.n, c.nl, c.f, ...(c.alt || "").split("|")].filter(Boolean).map(normalize),
      boost: 30,
    }),
  );
  admin1.forEach((a) =>
    search.push({
      entity: regionEntity(a),
      terms: [a.n, a.ln, ...(a.alt || "").split("|")].filter(Boolean).map(normalize),
      boost: 12,
    }),
  );
  rows.forEach((r, i) => {
    const p = places[i];
    const adm = adminByName.get(`${p.iso}|${normalize(p.adm1)}`);
    search.push({
      entity: {
        key: `city:${p.iso}:${normalize(p.name)}:${p.lat.toFixed(2)}`,
        kind: "city",
        name: p.name,
        type: p.cls === 2 ? "Capital city" : "City",
        lat: p.lat,
        lon: p.lon,
        iso: p.iso,
        country: p.country,
        region: adm ? regionLabel(adm) : p.adm1 || undefined,
        regionId: adm?.id,
        pop: p.pop,
        capital: p.cls === 2,
      },
      terms: [r[0], r[1], ...(r[2] || "").split("|")].filter(Boolean).map(normalize),
      boost: 4 + Math.log10(Math.max(10, p.pop)) * 3 + p.cls * 4,
    });
  });
  return { countries, admin1, places, byIso, adminByName, search };
}

export const countryEntity = (c: Country): GeoEntity => ({
  key: `country:${c.a3}`,
  kind: "country",
  name: c.n,
  type: "Country",
  lat: c.ly,
  lon: c.lx,
  bbox: c.b,
  iso: c.iso,
  country: c.n,
  context: c.sub || c.cont,
});
export const regionEntity = (a: Admin1, index?: GeoIndex): GeoEntity => ({
  key: `region:${a.id}`,
  kind: "region",
  name: regionLabel(a),
  type: a.t || "Region",
  lat: a.ly,
  lon: a.lx,
  bbox: a.b,
  iso: a.iso,
  country: index?.byIso.get(a.iso)?.n ?? a.c,
  regionId: a.id,
});

let indexPromise: Promise<GeoIndex> | null = null;
export function loadGeoIndex() {
  indexPromise ??= Promise.all([
    getJson<Country[]>("countries.json"),
    getJson<Admin1[]>("admin1-index.json"),
    getJson<PlaceRow[]>("places.json"),
  ])
    .then(([c, a, p]) => buildIndex(c, a, p))
    .catch((e) => {
      indexPromise = null; // allow retry
      throw e;
    });
  return indexPromise;
}
let shapesPromise: Promise<Record<string, Polys>> | null = null;
export function loadAdminShapes() {
  shapesPromise ??= getJson<Record<string, Polys>>("admin1-shapes.json").catch((e) => {
    shapesPromise = null;
    throw e;
  });
  return shapesPromise;
}

/** Parses "31.2, 29.9", "31.2N 29.9E", "31°12'N 29°55'E". Returns null when not coordinates. */
export function parseCoordinates(q: string): { lat: number; lon: number } | null {
  const s = q.trim().toUpperCase();
  const part = String.raw`(-?\d+(?:\.\d+)?)(?:\s*[°º]\s*(\d+(?:\.\d+)?)?\s*['′]?\s*(\d+(?:\.\d+)?)?\s*["″]?)?\s*([NSEW])?`;
  const m = s.match(new RegExp(`^${part}\\s*[,;\\s]\\s*${part}$`));
  if (!m) return null;
  const val = (d: string, mi?: string, se?: string, h?: string) => {
    let v = Math.abs(Number(d)) + (mi ? Number(mi) / 60 : 0) + (se ? Number(se) / 3600 : 0);
    if (d.startsWith("-") || h === "S" || h === "W") v = -v;
    return v;
  };
  let a = val(m[1], m[2], m[3], m[4]),
    b = val(m[5], m[6], m[7], m[8]);
  if (m[4] === "E" || m[4] === "W" || m[8] === "N" || m[8] === "S") [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b };
}
export const formatCoord = (lat: number, lon: number, d = 4) =>
  `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? "E" : "W"}`;

export function coordinateEntity(lat: number, lon: number): GeoEntity {
  return {
    key: `pt:${lat.toFixed(4)},${lon.toFixed(4)}`,
    kind: "coordinates",
    name: formatCoord(lat, lon),
    type: "Coordinates",
    lat,
    lon,
  };
}

/** Ranked, diacritic-insensitive search; results always carry type and parent geography. */
export function searchGeo(index: GeoIndex, query: string, limit = 8): GeoEntity[] {
  const coords = parseCoordinates(query);
  if (coords) return [coordinateEntity(coords.lat, coords.lon)];
  const q = normalize(query);
  if (q.length < 2) return [];
  const scored: { e: GeoEntity; s: number }[] = [];
  for (const entry of index.search) {
    let best = 0;
    for (const t of entry.terms) {
      const s =
        t === q
          ? 100
          : t.startsWith(q)
            ? 78
            : q.length >= 3 && ` ${t}`.includes(` ${q}`)
              ? 60
              : q.length >= 4 && t.includes(q)
                ? 30
                : 0;
      if (s > best) best = s;
      if (best === 100) break;
    }
    if (best) scored.push({ e: entry.entity, s: best + entry.boost });
  }
  if (q.length <= 3) {
    const iso = index.countries.find((c) => c.iso.toLowerCase() === q || c.a3.toLowerCase() === q);
    if (iso) scored.push({ e: countryEntity(iso), s: 140 });
  }
  scored.sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  return scored
    .filter(({ e }) => !seen.has(e.key) && seen.add(e.key))
    .slice(0, limit)
    .map((x) => x.e);
}

export function pointInRings(rings: Rings, lon: number, lat: number) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i],
        yi = r[i + 1],
        xj = r[j],
        yj = r[j + 1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
  return inside;
}
export const inBBox = (b: BBox, lon: number, lat: number, pad = 0) =>
  lon >= b[0] - pad && lon <= b[2] + pad && lat >= b[1] - pad && lat <= b[3] + pad;
export const pointInPolys = (p: Polys, lon: number, lat: number) =>
  p.some((rings) => pointInRings(rings, lon, lat));
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180,
    dLat = (bLat - aLat) * r,
    dLon = (bLon - aLon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Precision = "city" | "settlement" | "region" | "country" | "none";
export type GeoLookup = {
  lat: number;
  lon: number;
  country?: Country;
  admin?: Admin1;
  place?: Place & { km: number };
  precision: Precision;
  note: string;
};
const lookupCache = new Map<string, GeoLookup>();
/** Reverse geocode: country & admin-1 by point-in-polygon, settlement by nearest populated place. */
export function reverseLookup(
  index: GeoIndex,
  shapes: Record<string, Polys> | null,
  lat: number,
  lon: number,
): GeoLookup {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}:${shapes ? 1 : 0}`;
  const hit = lookupCache.get(key);
  if (hit) return hit;
  const country = index.countries.find(
    (c) => c.b && inBBox(c.b, lon, lat) && pointInPolys(c.p, lon, lat),
  );
  let admin: Admin1 | undefined;
  if (shapes)
    admin = index.admin1.find(
      (a) =>
        (!country || a.iso === country.iso) &&
        a.b &&
        inBBox(a.b, lon, lat, 0.02) &&
        shapes[a.id] &&
        pointInPolys(shapes[a.id], lon, lat),
    );
  let place: (Place & { km: number }) | undefined;
  for (const p of index.places) {
    if (Math.abs(p.lat - lat) > 3) continue;
    const km = distanceKm(lat, lon, p.lat, p.lon);
    if (!place || km < place.km) place = { ...p, km };
  }
  let inferred = false;
  if (!admin && place && place.km <= 25 && (!country || place.iso === country.iso)) {
    // Simplified coastlines can exclude coastal points; fall back to the nearby settlement's region.
    admin = index.adminByName.get(`${place.iso}|${normalize(place.adm1)}`);
    inferred = !!admin;
  }
  const precision: Precision =
    place && place.km <= 15
      ? "city"
      : place && place.km <= 60
        ? "settlement"
        : admin
          ? "region"
          : country
            ? "country"
            : "none";
  const note =
    precision === "city"
      ? `Within ${Math.max(1, Math.round(place!.km))} km of ${place!.name} (nearest Natural Earth populated place).`
      : precision === "settlement"
        ? `No mapped city at this point; nearest settlement ${place!.name} is ${Math.round(place!.km)} km away.`
        : precision === "region"
          ? `No mapped settlement within 60 km; identified to ${admin!.t || "region"} level by boundary.`
          : precision === "country"
            ? "Identified to country level only; no admin-1 boundary match at this point."
            : "Outside national land boundaries (open water or unmapped area).";
  const result = {
    lat,
    lon,
    country,
    admin,
    place,
    precision,
    note: inferred
      ? `${note} Region inferred from that settlement (boundary simplified near coast).`
      : note,
  };
  lookupCache.set(key, result);
  return result;
}
export async function reverseGeocode(lat: number, lon: number) {
  const [index, shapes] = await Promise.all([loadGeoIndex(), loadAdminShapes().catch(() => null)]);
  return reverseLookup(index, shapes, lat, lon);
}

/** Geographic hierarchy (country → region → city) for breadcrumbs. */
export function hierarchy(index: GeoIndex, e: GeoEntity, lookup?: GeoLookup): GeoEntity[] {
  const out: GeoEntity[] = [];
  const c =
    lookup?.country ??
    (e.iso ? index.byIso.get(e.iso) : undefined) ??
    index.countries.find((x) => x.n === e.country);
  if (c) out.push(countryEntity(c));
  const a =
    lookup?.admin ?? (e.regionId ? index.admin1.find((x) => x.id === e.regionId) : undefined);
  if (a) out.push(regionEntity(a, index));
  if (e.kind === "city") out.push(e);
  else if (lookup?.place && lookup.precision === "city") {
    const p = lookup.place;
    out.push({
      key: `city:${p.iso}:${normalize(p.name)}:${p.lat.toFixed(2)}`,
      kind: "city",
      name: p.name,
      type: p.cls === 2 ? "Capital city" : "City",
      lat: p.lat,
      lon: p.lon,
      iso: p.iso,
      country: p.country,
      region: a ? regionLabel(a) : p.adm1,
      regionId: a?.id,
      pop: p.pop,
      capital: p.cls === 2,
    });
  }
  return out;
}

export const CITY_RADIUS_KM = 30;
export type GeoArea = {
  key: string;
  kind: GeoKind;
  label: string;
  entity: GeoEntity;
  bbox: BBox;
  rings: Rings; // outline rings for globe highlighting
  /** Camera distance suited to the entity's extent (country frames whole country, city zooms close). */
  dist: number;
  has: (r: { id: string; lat: number; lon: number }) => boolean;
};
function circleRing(lat: number, lon: number, km: number) {
  const ring: number[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(
      lon + ((km / 111.32) * Math.cos(a)) / Math.cos((lat * Math.PI) / 180),
      lat + (km / 110.57) * Math.sin(a),
    );
  }
  return ring;
}
const extentDist = (b: BBox, min: number, max: number) => {
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const span = Math.max(b[3] - b[1], (b[2] - b[0]) * Math.cos(midLat));
  return Math.min(max, Math.max(min, 1 + span / 34));
};
/** Builds a filterable area. Regions need admin-1 shapes; cities use a documented radius. */
export function areaFor(
  index: GeoIndex,
  shapes: Record<string, Polys> | null,
  e: GeoEntity,
): GeoArea | null {
  const cache = new Map<string, boolean>();
  const make = (
    bbox: BBox,
    rings: Rings,
    dist: number,
    test: (lat: number, lon: number) => boolean,
    label: string,
  ): GeoArea => ({
    key: e.key,
    kind: e.kind,
    label,
    entity: e,
    bbox,
    rings,
    dist,
    has: (r) => {
      let v = cache.get(r.id);
      if (v === undefined) cache.set(r.id, (v = inBBox(bbox, r.lon, r.lat) && test(r.lat, r.lon)));
      return v;
    },
  });
  if (e.kind === "country") {
    const c =
      index.byIso.get(e.iso ?? "") ?? index.countries.find((x) => `country:${x.a3}` === e.key);
    if (!c) return null;
    return make(
      c.b,
      c.p.flat(),
      extentDist(c.b, 1.35, 3.2),
      (lat, lon) => pointInPolys(c.p, lon, lat),
      c.n,
    );
  }
  if (e.kind === "region") {
    const a = index.admin1.find((x) => x.id === e.regionId);
    const p = a && shapes?.[a.id];
    if (!a || !p) return null;
    return make(
      a.b,
      p.flat(),
      extentDist(a.b, 1.2, 2.6),
      (lat, lon) => pointInPolys(p, lon, lat),
      `${regionLabel(a)}, ${index.byIso.get(a.iso)?.n ?? a.c}`,
    );
  }
  const ring = circleRing(e.lat, e.lon, CITY_RADIUS_KM);
  const xs = ring.filter((_, i) => i % 2 === 0),
    ys = ring.filter((_, i) => i % 2 === 1);
  return make(
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    [ring],
    1.2,
    (lat, lon) => distanceKm(lat, lon, e.lat, e.lon) <= CITY_RADIUS_KM,
    e.country ? `${e.name}, ${e.country}` : e.name,
  );
}

/** Circular search area used for "nearby" queries (not an administrative boundary). */
export function radiusArea(lat: number, lon: number, km: number, label = "Nearby"): GeoArea {
  const e = coordinateEntity(lat, lon);
  const ring = circleRing(lat, lon, km);
  const xs = ring.filter((_, i) => i % 2 === 0),
    ys = ring.filter((_, i) => i % 2 === 1);
  const bbox: BBox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return {
    key: `r:${e.key}:${km}`,
    kind: "coordinates",
    label,
    entity: e,
    bbox,
    rings: [ring],
    dist: 1.25,
    has: (r) => inBBox(bbox, r.lon, r.lat) && distanceKm(lat, lon, r.lat, r.lon) <= km,
  };
}
export const bboxOverlap = (a: BBox, b: BBox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Flag CSS class from the bundled flag-icons set (ISO 3166-1 alpha-2). */
export const flagClass = (iso?: string) =>
  iso && /^[A-Z]{2}$/.test(iso) ? `fi fi-${iso.toLowerCase()}` : "";

const RECENT_KEY = "pyrosync.recentLocations";
export function recentLocations(): GeoEntity[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
export function rememberLocation(e: GeoEntity) {
  try {
    const list = [e, ...recentLocations().filter((x) => x.key !== e.key)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}
