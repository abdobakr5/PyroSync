import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import "flag-icons/css/flag-icons.min.css";
import { Badge, Button, Icon, IconButton } from "./ui";
import { MATCH_COLORS } from "./colors";
import { REGIONS, fmt, observationCount, sources, type FireRecord, type Filters } from "./data";
import {
  CITY_RADIUS_KM,
  distanceKm,
  flagClass,
  formatCoord,
  hierarchy,
  loadGeoIndex,
  recentLocations,
  regionLabel,
  reverseGeocode,
  searchGeo,
  type GeoEntity,
  type GeoIndex,
  type GeoLookup,
} from "./geo";

export function useGeoIndex(enabled = true) {
  const [index, setIndex] = useState<GeoIndex | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError("");
    loadGeoIndex().then(
      (i) => live && setIndex(i),
      (e) => live && setError(e instanceof Error ? e.message : "Geographic data unavailable"),
    );
    return () => {
      live = false;
    };
  }, [enabled, attempt]);
  return { index, error, retry: () => setAttempt((a) => a + 1) };
}

export function Flag({ iso, kind, size = 20 }: { iso?: string; kind?: string; size?: number }) {
  const cls = flagClass(iso);
  if (cls && kind !== "coordinates")
    return (
      <span
        className={`geo-flag ${cls}`}
        style={{ width: size * 1.33, height: size }}
        aria-hidden="true"
      />
    );
  return (
    <span className="geo-glyph" style={{ width: size * 1.33, height: size }} aria-hidden="true">
      <Icon
        name={kind === "city" ? "pin" : kind === "coordinates" ? "target" : "globe"}
        size={size * 0.75}
      />
    </span>
  );
}

const kindLabel = (e: GeoEntity) => e.type;
const parentOf = (e: GeoEntity) =>
  e.kind === "city"
    ? [e.region, e.country].filter(Boolean).join(", ")
    : e.kind === "region"
      ? e.country
      : e.kind === "country"
        ? (e.context ?? "Sovereign state")
        : "Reverse-geocoded on selection";

/** Accessible geographic combobox: countries, regions, cities, and coordinates. */
export function LocationSearch({
  onSelect,
  compact = false,
}: {
  onSelect: (e: GeoEntity) => void;
  compact?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [touched, setTouched] = useState(false);
  const { index, error, retry } = useGeoIndex(touched);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => (index && q.trim() ? searchGeo(index, q, 9) : []), [index, q]);
  const recent = useMemo(() => (open && !q.trim() ? recentLocations() : []), [open, q]);
  // Groups appear in relevance order (best match first); items keep their ranking within a group.
  const options = useMemo(() => {
    if (!q.trim()) return recent;
    const order: string[] = [];
    results.forEach((r) => !order.includes(r.kind) && order.push(r.kind));
    return [...results].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  }, [q, results, recent]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => !wrapRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const choose = (e: GeoEntity) => {
    onSelect(e);
    setQ(
      e.kind === "coordinates"
        ? e.name
        : e.kind === "city"
          ? `${e.name}, ${e.country}`
          : e.kind === "region"
            ? `${e.name}, ${e.country}`
            : e.name,
    );
    setOpen(false);
    inputRef.current?.blur();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown")
      (e.preventDefault(), setOpen(true), setActive((a) => Math.min(options.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter" && options[active]) (e.preventDefault(), choose(options[active]));
    else if (e.key === "Escape") open ? setOpen(false) : setQ("");
  };
  const groups: { label: string; items: GeoEntity[] }[] = [];
  options.forEach((o) => {
    const label = !q.trim()
      ? "Recent locations"
      : o.kind === "country"
        ? "Countries"
        : o.kind === "region"
          ? "States, provinces & regions"
          : o.kind === "city"
            ? "Cities"
            : "Coordinates";
    const g = groups.find((x) => x.label === label);
    g ? g.items.push(o) : groups.push({ label, items: [o] });
  });
  let n = -1;
  return (
    <div
      className={`geo-search ${compact ? "compact" : ""} ${open ? "is-open" : ""}`}
      ref={wrapRef}
    >
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        className="geo-search-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        aria-label="Search country, city, region or coordinates"
        placeholder="Search country, city, region or coordinates..."
        value={q}
        onFocus={() => (setTouched(true), setOpen(true))}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setTouched(true))}
        onKeyDown={onKey}
      />
      {q && (
        <IconButton
          icon="close"
          label="Clear search"
          onClick={() => (setQ(""), inputRef.current?.focus())}
        />
      )}
      {open && (
        <div className="geo-suggest" id={listId} role="listbox" aria-label="Location suggestions">
          {error ? (
            <div className="geo-suggest-state error" role="alert">
              <Icon name="info" size={16} />
              <span>Geographic index could not be loaded. {error}.</span>
              <Button onClick={retry}>Retry</Button>
            </div>
          ) : !index ? (
            <div className="geo-suggest-state" role="status">
              <span className="geo-spinner" />
              Loading geographic index…
            </div>
          ) : !q.trim() && !recent.length ? (
            <div className="geo-suggest-state">
              <Icon name="globe" size={16} />
              Type a country, state, governorate, city — or coordinates like “31.2N 29.9E”.
            </div>
          ) : q.trim() && !options.length ? (
            <div className="geo-suggest-state" role="status">
              <Icon name="search" size={16} />
              No matching places for “{q}”. Try another spelling or enter coordinates.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="geo-suggest-label">{g.label}</div>
                {g.items.map((o) => {
                  n++;
                  const i = n;
                  return (
                    <div
                      key={o.key}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`geo-option ${i === active ? "active" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => (e.preventDefault(), choose(o))}
                    >
                      <Flag iso={o.iso} kind={o.kind} size={16} />
                      <span className="geo-option-name">
                        <strong>{o.name}</strong>
                        <small>{parentOf(o)}</small>
                      </span>
                      <span className={`geo-type t-${o.kind}`}>{kindLabel(o)}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          <div className="geo-suggest-foot">
            Natural Earth · offline gazetteer · no external geocoding
          </div>
        </div>
      )}
    </div>
  );
}

export type GeoSelection = {
  entity: GeoEntity;
  mode: "area" | "preview";
  lookup?: GeoLookup;
  pending?: boolean;
  error?: string;
};
export type GeoScope = {
  records: FireRecord[];
  history: FireRecord[];
  label: string;
  covered: boolean;
  anomaly: { pct: number | null; category: string };
  nearby: FireRecord[];
  radiusKm?: number;
};

function YearSparkline({
  history,
  mode,
  sensor,
}: {
  history: FireRecord[];
  mode: Filters["mode"];
  sensor: string;
}) {
  const years = Array.from({ length: 26 }, (_, i) => 2001 + i);
  const vals = years.map((y) =>
    history
      .filter((r) => r.date.startsWith(String(y)))
      .reduce((s, r) => s + (mode === "raw" ? observationCount(r, sensor) : 1), 0),
  );
  const max = Math.max(1, ...vals);
  return (
    <div className="geo-spark">
      <svg
        viewBox="0 0 260 64"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Annual ${mode} counts 2001–2026: peak ${fmt(max)}`}
      >
        {vals.map((v, i) => (
          <rect
            key={i}
            x={i * 10 + 1}
            y={56 - (v / max) * 50}
            width="7"
            height={Math.max(1, (v / max) * 50)}
            rx="2"
            className={years[i] < 2012 ? "pre" : years[i] === 2026 ? "partial" : ""}
          >
            <title>
              {years[i]}: {fmt(v)}
              {years[i] === 2026
                ? " (partial, to 15 Apr)"
                : years[i] < 2012
                  ? " (MODIS-only era)"
                  : ""}
            </title>
          </rect>
        ))}
        <line x1="110" x2="110" y1="2" y2="60" className="era" />
      </svg>
      <div className="geo-spark-axis">
        <span>2001</span>
        <span>2012 · VIIRS era</span>
        <span>2026</span>
      </div>
    </div>
  );
}

/** Geographic Intelligence Inspector — location-level statistics, clearly separated from event measurements. */
export function GeoInspector({
  sel,
  scope,
  filters,
  dateLabel,
  onBreadcrumb,
  onApply,
  onClear,
  onRecord,
  onPilot,
}: {
  sel: GeoSelection;
  scope: GeoScope | null;
  filters: Filters;
  dateLabel: string;
  onBreadcrumb: (e: GeoEntity) => void;
  onApply: () => void;
  onClear: () => void;
  onRecord: (r: FireRecord) => void;
  onPilot: (id: string) => void;
}) {
  const { index } = useGeoIndex(true);
  const e = sel.entity,
    lk = sel.lookup;
  const chain = index ? hierarchy(index, e, lk) : [];
  const title =
    sel.mode === "preview"
      ? lk?.place && lk.precision === "city"
        ? lk.place.name
        : lk?.admin
          ? regionLabel(lk.admin)
          : (lk?.country?.n ?? e.name)
      : e.name;
  const country = lk?.country ?? (index && e.iso ? index.byIso.get(e.iso) : undefined);
  const iso = country?.iso ?? e.iso;
  const kind =
    sel.mode === "preview"
      ? "Map location"
      : e.kind === "country"
        ? "Country"
        : e.kind === "region"
          ? e.type
          : e.capital
            ? "Capital city"
            : "City";
  const raw = scope
    ? scope.records.reduce((s, r) => s + observationCount(r, filters.sensor), 0)
    : 0;
  const maxRec =
    scope?.records.reduce<FireRecord | null>((m, r) => (!m || r.frp > m.frp ? r : m), null) ?? null;
  const lat = sel.mode === "preview" ? e.lat : e.lat,
    lon = e.lon;
  const admin =
    lk?.admin ?? (index && e.regionId ? index.admin1.find((a) => a.id === e.regionId) : undefined);
  const list = scope
    ? (scope.nearby.length ? scope.nearby : [...scope.records].sort((a, b) => b.frp - a.frp)).slice(
        0,
        6,
      )
    : [];
  return (
    <section
      className="geo-inspector"
      aria-label={`Geographic intelligence for ${title}`}
      aria-live="polite"
    >
      <header className="geo-head">
        <Flag iso={iso} kind={sel.mode === "preview" && !iso ? "coordinates" : e.kind} size={26} />
        <div className="geo-title">
          <span className="eyebrow">
            GEOGRAPHIC INTELLIGENCE ·{" "}
            {sel.mode === "area" ? "AREA OF INTEREST" : "LOCATION PREVIEW"}
          </span>
          <h2>{sel.pending ? "Identifying location…" : title}</h2>
          <nav className="geo-crumbs" aria-label="Geographic hierarchy">
            {chain.length ? (
              chain.map((c, i) => (
                <span key={c.key}>
                  {i > 0 && <Icon name="chevron" size={12} />}
                  <button
                    onClick={() => onBreadcrumb(c)}
                    aria-current={sel.mode === "area" && c.key === e.key ? "location" : undefined}
                    title={`Explore ${c.name} (${c.type})`}
                  >
                    {c.name}
                  </button>
                </span>
              ))
            ) : (
              <span className="muted">
                {sel.pending
                  ? "Reverse geocoding…"
                  : (lk?.note ?? (index ? "No geographic hierarchy" : "Loading hierarchy…"))}
              </span>
            )}
          </nav>
        </div>
        <Badge tone={sel.mode === "area" ? "cyan" : "gold"}>{kind}</Badge>
        <span className="geo-actions">
          {sel.mode === "preview" && chain.length > 0 && (
            <Button variant="primary" icon="target" onClick={onApply}>
              Explore {chain[chain.length - 1].name}
            </Button>
          )}
          <IconButton
            icon="close"
            label={sel.mode === "area" ? "Reset area of interest" : "Clear location"}
            onClick={onClear}
          />
        </span>
      </header>
      {sel.error && (
        <p className="error-text" role="alert">
          {sel.error}
        </p>
      )}
      {scope && !scope.covered && (
        <div className="geo-coverage" role="note">
          <Icon name="info" size={16} />
          <div>
            <strong>Outside demonstration coverage.</strong> Harmonized Gold observations exist only for
            four pilot regions — no records here is a coverage limit, not evidence of zero fire.
            <div className="geo-pilots">
              {REGIONS.map((r) => (
                <button key={r.id} onClick={() => onPilot(r.id)}>
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="geo-body">
        <div className="geo-section">
          <h3>
            Intelligence overview{" "}
            <span>
              location-level · {dateLabel} · {filters.mode}
            </span>
          </h3>
          <div className="geo-stats">
            <div>
              <span>Detected fire events</span>
              <strong>{scope ? fmt(raw) : "—"}</strong>
              <small>source detections</small>
            </div>
            <div>
              <span>Harmonized events</span>
              <strong>{scope ? fmt(scope.records.length) : "—"}</strong>
              <small>cell/day records</small>
            </div>
            <div className="hot">
              <span>Maximum observed FRP</span>
              <strong>
                {maxRec ? `${maxRec.frp.toFixed(1)}` : "—"}
                <em>{maxRec ? " MW" : ""}</em>
              </strong>
              <small>{maxRec ? `single event ${maxRec.id}` : "no events in scope"}</small>
            </div>
            <div>
              <span>Anomaly status</span>
              <strong className="small">
                {scope
                  ? scope.anomaly.pct === null
                    ? "Not classifiable"
                    : `${scope.anomaly.pct >= 0 ? "+" : ""}${scope.anomaly.pct.toFixed(0)}%`
                  : "—"}
              </strong>
              <small>{scope?.anomaly.category ?? "—"}</small>
            </div>
          </div>
          <p className="geo-note">
            Totals describe {scope?.label ?? "this area"} for the active filters. Total FRP is not
            reported: summing instantaneous power across detections does not measure energy.
          </p>
        </div>
        <div className="geo-section">
          <h3>Geographic details</h3>
          <dl className="geo-dl">
            <div>
              <dt>{sel.mode === "preview" ? "Selected point" : "Geographic center"}</dt>
              <dd className="mono">{formatCoord(lat, lon, 3)}</dd>
            </div>
            <div>
              <dt>Country</dt>
              <dd>
                {country
                  ? `${country.n}${country.cont ? ` · ${country.sub || country.cont}` : ""}`
                  : sel.mode === "preview"
                    ? "Outside national boundaries"
                    : (e.country ?? "—")}
              </dd>
            </div>
            {country?.cap && (e.kind === "country" || sel.mode === "preview") && (
              <div>
                <dt>Capital</dt>
                <dd>{country.cap}</dd>
              </div>
            )}
            <div>
              <dt>Administrative area</dt>
              <dd>
                {admin
                  ? regionLabel(admin).toLowerCase().includes(admin.t.toLowerCase())
                    ? regionLabel(admin)
                    : `${regionLabel(admin)} · ${admin.t}`
                  : e.kind === "country"
                    ? "National level"
                    : "Not identified"}
              </dd>
            </div>
            {e.kind === "city" && sel.mode === "area" && (
              <div>
                <dt>Settlement</dt>
                <dd>
                  {e.name}
                  {e.pop ? ` · pop. ≈${fmt(e.pop)}` : ""}
                </dd>
              </div>
            )}
            {lk?.place && sel.mode === "preview" && (
              <div>
                <dt>Nearest settlement</dt>
                <dd>
                  {lk.place.name} · {Math.round(lk.place.km)} km
                </dd>
              </div>
            )}
            {(e.bbox || country?.b) && e.kind !== "city" && sel.mode === "area" && (
              <div>
                <dt>Bounding coordinates</dt>
                <dd className="mono">
                  {(e.bbox ?? country!.b).map((v) => v.toFixed(2)).join(", ")}
                </dd>
              </div>
            )}
            <div>
              <dt>Precision</dt>
              <dd className="prec">
                {sel.mode === "preview"
                  ? (lk?.note ?? "Resolving…")
                  : e.kind === "city"
                    ? `City area = ${CITY_RADIUS_KM} km radius around the Natural Earth place point (not a municipal boundary).`
                    : e.kind === "region"
                      ? "Natural Earth 1:10m admin-1 boundary, simplified."
                      : "Natural Earth 1:50m country boundary, simplified."}
              </dd>
            </div>
          </dl>
        </div>
        <div className="geo-section">
          <h3>
            Activity overview <span>annual {filters.mode} counts</span>
          </h3>
          {scope && scope.history.length ? (
            <YearSparkline history={scope.history} mode={filters.mode} sensor={filters.sensor} />
          ) : (
            <p className="geo-empty">
              No fire observations recorded for this area in any year.
            </p>
          )}
        </div>
        <div className="geo-section">
          <h3>
            {scope?.nearby.length
              ? `Nearby fire events · within ${scope.radiusKm} km`
              : "Strongest fire events in area"}
          </h3>
          {list.length ? (
            <table className="geo-events">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Date</th>
                  <th>FRP</th>
                  <th>Match</th>
                  <th>Conf.</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button className="record-link" onClick={() => onRecord(r)}>
                        {r.id}
                      </button>
                    </td>
                    <td>{r.date}</td>
                    <td>{r.frp.toFixed(1)} MW</td>
                    <td>
                      <span className="match-dot" style={{ background: MATCH_COLORS[r.match] }} />
                      {r.match.replace(" (Both)", "")}
                    </td>
                    <td>{r.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="geo-empty">No fire events match the active filters here.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Geographic identity for a single fire event (async reverse geocode of its coordinates). */
export function EventGeography({ lat, lon }: { lat: number; lon: number }) {
  const [lk, setLk] = useState<GeoLookup | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setLk(null);
    reverseGeocode(lat, lon).then(
      (r) => live && setLk(r),
      () => live && setErr("Geographic data unavailable"),
    );
    return () => {
      live = false;
    };
  }, [lat, lon]);
  if (err)
    return (
      <div>
        <dt>Geography</dt>
        <dd>{err}</dd>
      </div>
    );
  if (!lk)
    return (
      <div>
        <dt>Geography</dt>
        <dd className="muted">Resolving location…</dd>
      </div>
    );
  return (
    <>
      <div>
        <dt>Country</dt>
        <dd className="geo-inline">
          {lk.country ? (
            <>
              <Flag iso={lk.country.iso} kind="country" size={12} />
              {lk.country.n}
            </>
          ) : (
            "Outside national boundaries"
          )}
        </dd>
      </div>
      <div>
        <dt>Administrative region</dt>
        <dd>{lk.admin ? `${regionLabel(lk.admin)} (${lk.admin.t})` : "Not identified"}</dd>
      </div>
      <div>
        <dt>Nearest settlement</dt>
        <dd>{lk.place ? `${lk.place.name} · ${Math.round(lk.place.km)} km` : "—"}</dd>
      </div>
      <div className="prec-row">
        <dt>Location precision</dt>
        <dd className="prec">{lk.note}</dd>
      </div>
    </>
  );
}

export const nearbyRecords = (records: FireRecord[], lat: number, lon: number, km: number) =>
  records
    .map((r) => ({ r, d: distanceKm(lat, lon, r.lat, r.lon) }))
    .filter((x) => x.d <= km)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
export const strongestSource = (r: FireRecord) =>
  sources(r).reduce((a, b) => (b.frp_mw > a.frp_mw ? b : a));
