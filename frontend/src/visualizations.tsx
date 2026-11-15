import { useEffect, useMemo, useRef, useState } from "react";
import { Heading, Icon, IconButton } from "./ui";
import { REGIONS, MATCHES, sources, type Bounds, type Filters, type FireRecord } from "./data";

type RawCountry = { n: string; p?: number[][][] };
let cachedCountries: RawCountry[] | null = null;

const project = (lon: number, lat: number, zoom: number) => ({
  x: ((lon + 180) / 360) * 256 * 2 ** zoom,
  y: ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 256 * 2 ** zoom,
});
const unproject = (x: number, y: number, zoom: number) => ({
  lon: (x / (256 * 2 ** zoom)) * 360 - 180,
  lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (256 * 2 ** zoom)))) * 180) / Math.PI,
});
const matchColor = (match: string) =>
  match === "Matched (Both)"
    ? "var(--matched)"
    : match === "VIIRS-Only"
      ? "var(--viirs)"
      : "var(--modis)";

export function FireMap({
  rows,
  filters,
  onSelect,
  onBounds,
  full = false,
  defaultDraw = false,
  onExpand,
  regimeLayer = false,
  onLocation,
}: {
  rows: FireRecord[];
  filters: Filters;
  onSelect: (r: FireRecord) => void;
  onBounds: (b: Bounds | null) => void;
  full?: boolean;
  defaultDraw?: boolean;
  onExpand?: () => void;
  regimeLayer?: boolean;
  onLocation?: (lat: number, lon: number) => void;
}) {
  const region = REGIONS.find((r) => r.id === filters.region)!;
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draw, setDraw] = useState(defaultDraw);
  const [countries, setCountries] = useState<RawCountry[]>(cachedCountries || []);

  useEffect(() => {
    if (cachedCountries) return;
    let alive = true;
    fetch("/geo/countries.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: RawCountry[]) => {
        cachedCountries = list;
        if (alive) setCountries(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const countryPaths = useMemo(() => {
    if (!countries.length) return [];
    const paths: { key: string; d: string }[] = [];
    for (let ci = 0; ci < countries.length; ci++) {
      const c = countries[ci];
      if (!c.p) continue;
      for (let pi = 0; pi < c.p.length; pi++) {
        const poly = c.p[pi];
        let d = "";
        for (let ri = 0; ri < poly.length; ri++) {
          const ring = poly[ri];
          if (!ring || ring.length < 4) continue;
          for (let k = 0; k < ring.length; k += 2) {
            const pt = project(ring[k], ring[k + 1], region.zoom);
            d += `${k === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
          }
          d += "Z";
        }
        if (d) paths.push({ key: `${ci}-${pi}`, d });
      }
    }
    return paths;
  }, [countries, region.zoom]);
  const [layers, setLayers] = useState(false);
  const [visible, setVisible] = useState([...MATCHES]);
  const [frp, setFrp] = useState(false);
  const [drag, setDrag] = useState<{
    x: number;
    y: number;
    sx: number;
    sy: number;
    px: number;
    py: number;
  } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [tileError, setTileError] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const center = project(region.lon, region.lat, region.zoom);
  const width = 710 / scale,
    height = (full ? 530 : 330) / scale;
  const view = { x: center.x - width / 2 + pan.x, y: center.y - height / 2 + pan.y };
  const tx = Math.floor((view.x + width / 2) / 256),
    ty = Math.floor((view.y + height / 2) / 256);
  const clusters = useMemo(() => {
    const groups = new Map<string, { x: number; y: number; rows: FireRecord[]; sensor?: string }>();
    const size = Math.max(4, 7 / scale);
    rows
      .filter((r) => visible.includes(r.match))
      .forEach((r) => {
        const points =
          filters.mode === "raw"
            ? sources(r)
                .filter((s) => filters.sensor === "All sensors" || s.sensor === filters.sensor)
                .map((s) => ({ lon: s.longitude, lat: s.latitude, sensor: s.sensor }))
            : [{ lon: r.lon, lat: r.lat, sensor: undefined }];
        points.forEach((source) => {
          const p = project(source.lon, source.lat, region.zoom);
          const key = `${Math.floor(p.x / size)},${Math.floor(p.y / size)},${source.sensor || r.match}`;
          const group = groups.get(key);
          if (group) group.rows.push(r);
          else groups.set(key, { ...p, rows: [r], sensor: source.sensor });
        });
      });
    return Array.from(groups.values())
      .sort((a, b) => b.rows.length - a.rows.length || b.rows[0].frp - a.rows[0].frp)
      .slice(0, 1200);
  }, [rows, visible, region.zoom, scale, filters.mode, filters.sensor]);
  function point(e: React.PointerEvent<SVGSVGElement>) {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return { x: view.x + width / 2, y: view.y + height / 2 };
    const p = svg.current!.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(ctm.inverse());
  }
  function endDraw(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    // A click (no drag) on empty map identifies the location, mirroring the 3D globe.
    if (!draw && onLocation && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 5) {
      const pt = point(e);
      const ll = unproject(pt.x, pt.y, region.zoom);
      onLocation(ll.lat, ll.lon);
    }
    if (draw && rect && rect.w > 3 && rect.h > 3) {
      const a = unproject(rect.x, rect.y, region.zoom),
        b = unproject(rect.x + rect.w, rect.y + rect.h, region.zoom);
      onBounds({
        minLat: Math.min(a.lat, b.lat),
        maxLat: Math.max(a.lat, b.lat),
        minLon: Math.min(a.lon, b.lon),
        maxLon: Math.max(a.lon, b.lon),
      });
      setDraw(false);
    }
    setRect(null);
    setDrag(null);
    if (svg.current?.hasPointerCapture(e.pointerId)) svg.current.releasePointerCapture(e.pointerId);
  }
  const b1 = filters.bounds && project(filters.bounds.minLon, filters.bounds.maxLat, region.zoom);
  const b2 = filters.bounds && project(filters.bounds.maxLon, filters.bounds.minLat, region.zoom);
  return (
    <div className={`fire-map ${full ? "full-map" : ""} ${draw ? "drawing" : ""}`}>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${width} ${height}`}
        preserveAspectRatio="xMidYMid slice"
        role="group"
        aria-label={`Interactive map of ${region.name}, ${rows.length} harmonized analytical records. Drag to pan, select markers for details.`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = point(e);
          setDrag({ x: p.x, y: p.y, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
          svg.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          if (draw) {
            const p = point(e);
            setRect({
              x: Math.min(drag.x, p.x),
              y: Math.min(drag.y, p.y),
              w: Math.abs(p.x - drag.x),
              h: Math.abs(p.y - drag.y),
            });
          } else {
            const bounds = svg.current!.getBoundingClientRect();
            setPan({
              x: drag.px - ((e.clientX - drag.sx) / bounds.width) * width,
              y: drag.py - ((e.clientY - drag.sy) / bounds.height) * height,
            });
          }
        }}
        onPointerUp={endDraw}
        onPointerCancel={() => {
          setDrag(null);
          setRect(null);
        }}
        onWheel={(e) => {
          e.preventDefault();
          setScale((s) => Math.min(6, Math.max(0.5, s * (e.deltaY < 0 ? 1.15 : 0.87))));
        }}
      >
        <defs>
          <radialGradient id={`heat-${full}`}>
            <stop offset="0" stopColor="#ff963d" stopOpacity=".65" />
            <stop offset="1" stopColor="#ff693b" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x={view.x} y={view.y} width={width} height={height} fill="#0c1722" />
        {countryPaths.map((cp) => (
          <path
            key={cp.key}
            d={cp.d}
            fill="#162634"
            stroke="#2c485e"
            strokeWidth={0.75 / scale}
            fillRule="evenodd"
          />
        ))}
        {!tileError && [-1, 0, 1].flatMap((dx) =>
          [-1, 0, 1].map((dy) => (
            <image
              key={`${dx}-${dy}`}
              href={`/tiles/${region.zoom}-${tx + dx}-${ty + dy}.png`}
              x={(tx + dx) * 256}
              y={(ty + dy) * 256}
              width="256"
              height="256"
              opacity=".55"
              onError={() => setTileError(true)}
            />
          )),
        )}
        {b1 && b2 && (
          <rect
            x={Math.min(b1.x, b2.x)}
            y={Math.min(b1.y, b2.y)}
            width={Math.max(0, Math.abs(b2.x - b1.x))}
            height={Math.max(0, Math.abs(b2.y - b1.y))}
            fill="var(--cyan)"
            fillOpacity=".04"
            stroke="var(--cyan)"
            strokeWidth={1 / scale}
            strokeDasharray={`${5 / scale} ${3 / scale}`}
          />
        )}
        {clusters.map((c, i) => {
          const row = c.rows[0],
            n = c.rows.length;
          const color = regimeLayer
            ? row.regime === "Unclassified"
              ? "var(--muted)"
              : row.regime.startsWith("High")
                ? "var(--orange)"
                : "var(--cyan)"
            : c.sensor
              ? c.sensor === "MODIS"
                ? "var(--modis)"
                : "var(--viirs)"
              : matchColor(row.match);
          const radius =
            (frp ? 1.2 + row.frp / 50 : n > 4 ? 3.3 : 1.6 + Math.min(n, 5) * 0.24) / scale;
          return (
            <g
              key={i}
              className="map-marker"
              pointerEvents={draw ? "none" : undefined}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (n > 4 && scale < 3) {
                  setPan({ x: c.x - center.x, y: c.y - center.y });
                  setScale(Math.min(scale * 1.6, 4));
                } else onSelect(row);
              }}
              tabIndex={i < 28 ? 0 : undefined}
              role="button"
              aria-label={`${row.date}: ${row.match}, ${row.frp} MW${n > 1 ? `, cluster of ${n} records` : ""}`}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(row)}
            >
              <title>
                {row.date} · {c.sensor || row.match} · {row.frp} MW · {n}{" "}
                {filters.mode === "raw" ? "source detections" : "analytical records"}
              </title>
              <circle
                cx={c.x}
                cy={c.y}
                r={radius * 3.3}
                fill={`url(#heat-${full})`}
                opacity={row.match === "Matched (Both)" ? ".6" : ".1"}
              />
              <circle
                cx={c.x}
                cy={c.y}
                r={radius}
                fill={color}
                opacity=".88"
                stroke={n > 4 ? "#ffd6a4" : "none"}
                strokeWidth=".5"
              />
              <circle cx={c.x} cy={c.y} r={8 / scale} fill="transparent" />
            </g>
          );
        })}
        {region.labels.map((l) => {
            const p = project(l.lon, l.lat, region.zoom);
            return (
              <text
                key={l.name}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                className={l.name === l.name.toUpperCase() ? "country-label" : "city-label"}
                fontSize={(l.name === l.name.toUpperCase() ? 9 : 8) / scale}
              >
                {l.name}
              </text>
            );
          })}
        {rect && (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill="var(--cyan)"
            fillOpacity=".12"
            stroke="var(--cyan)"
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${2 / scale}`}
          />
        )}
      </svg>
      <div className="map-top-left">
        <span className="map-region">
          <span className="live-dot orange" />
          {region.name}
          <span className="map-separator">/</span>
          {filters.mode === "harmonized" ? "Harmonized" : "Raw detections"}
        </span>
      </div>
      <div className="map-top-right">
        <IconButton icon="layers" label="Map layers" onClick={() => setLayers(!layers)} />
        {onExpand && <IconButton icon="expand" label="Open full map explorer" onClick={onExpand} />}
      </div>
      {layers && (
        <div className="map-layer-popover">
          <Heading level={3}>Visible map layers</Heading>
          {MATCHES.map((m) => (
            <label key={m}>
              <input
                type="checkbox"
                checked={visible.includes(m)}
                onChange={() =>
                  setVisible(visible.includes(m) ? visible.filter((x) => x !== m) : [...visible, m])
                }
              />
              <span className="legend-dot" style={{ background: matchColor(m) }} />
              {m}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={frp} onChange={(e) => setFrp(e.target.checked)} />
            Size markers by max FRP
          </label>
          <small>
            Clusters group nearby analytical records. Layer visibility only affects the map.
          </small>
        </div>
      )}
      <div className="map-controls">
        <IconButton
          icon="plus"
          label="Zoom in"
          onClick={() => setScale(Math.min(scale * 1.35, 4))}
        />
        <IconButton
          icon="minus"
          label="Zoom out"
          onClick={() => setScale(Math.max(scale / 1.35, 0.8))}
        />
        <span />
        <IconButton
          icon="target"
          label="Reset map position"
          onClick={() => {
            setScale(1);
            setPan({ x: 0, y: 0 });
          }}
        />
        <IconButton
          icon="box"
          label={draw ? "Cancel bounding-box drawing" : "Draw area of interest"}
          onClick={() => {
            setDraw(!draw);
            setRect(null);
          }}
        />
      </div>
      {draw && (
        <div className="draw-instruction">
          <Icon name="box" size={16} />
          Drag on the map to select an area.{" "}
          <button onClick={() => setDraw(false)}>Switch to Pan</button>
        </div>
      )}
      {filters.bounds && (
        <div className="map-selection">
          <Icon name="box" size={14} />
          Custom area selected
          <button onClick={() => onBounds(null)} aria-label="Clear custom area">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {!rows.length && (
        <div className="map-empty">
          <Icon name="search" />
          No records match the active filters.
        </div>
      )}
      {tileError && !countryPaths.length && (
        <div className="map-error">
          Some basemap tiles are unavailable. Fire coordinates remain interactive.
          <button
            onClick={() => {
              setTileError(false);
              setScale(1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="map-bottom">
        <div className="map-legend">
          {(regimeLayer
            ? ["High-intensity", "Small thermal feature", "Unclassified"]
            : filters.mode === "raw"
              ? ["MODIS", "VIIRS"]
              : MATCHES
          ).map((m) => (
            <span key={m}>
              <i
                style={{
                  background: regimeLayer
                    ? m === "High-intensity"
                      ? "var(--orange)"
                      : m === "Unclassified"
                        ? "var(--muted)"
                        : "var(--cyan)"
                    : m === "MODIS"
                      ? "var(--modis)"
                      : m === "VIIRS"
                        ? "var(--viirs)"
                        : matchColor(m),
                }}
              />
              {m === "Matched (Both)" ? "Matched" : m}
            </span>
          ))}
        </div>
        <span className="map-attribution">Basemap: Esri, HERE, Garmin, © OpenStreetMap</span>
      </div>
      <div className="map-scale">
        <span />
        {Math.round(200 / scale)} km <span className="north-arrow">N ↑</span>
      </div>
    </div>
  );
}
