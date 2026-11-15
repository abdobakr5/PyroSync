import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as THREE from "three";
import { Flame } from "./flame";
import {
  ATMOS_VERTEX,
  FLAME_SIZE,
  HALO_FRAGMENT,
  RIM_FRAGMENT,
  flameTier,
  glowTexture,
  surfaceRing,
  tangentQuaternion,
  toVec,
} from "./earth";
import { Badge, Button, Heading, Icon, IconButton } from "./ui";
import { FireMap } from "./visualizations";
import { EventGeography } from "./geoUI";
import {
  MATCHES,
  REGIONS,
  acquisitionTime,
  compact,
  distanceKm,
  fmt,
  nearestPlace,
  recordQuality,
  sources,
  type Bounds,
  type FireRecord,
  type Filters,
} from "./data";

export { SENSOR_COLORS, MATCH_COLORS, REGIME_COLORS } from "./colors";
import { SENSOR_COLORS, MATCH_COLORS, REGIME_COLORS } from "./colors";
const FRP_STOPS = ["#51D6F0", "#FFC15A", "#FF963D", "#FF693B", "#F04438"];
export const frpColor = (v: number) => FRP_STOPS[Math.min(4, Math.floor(v / 40))];

export type GlobePoint = { id: string; lat: number; lon: number; color: string; category: string; frp?: number };
type View = { lat: number; lon: number; dist: number };
type Cluster = { lat: number; lon: number; count: number; ids: string[]; pos: THREE.Vector3; maxFrp: number };

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const OVERVIEW = 2.75,
  CLOSE = 1.45;
// Cluster cell size (degrees) per zoom bucket; 0 means individual observations.
const LEVELS = [3.5, 1.4, 0.45, 0];
const bucketOf = (d: number) => (d > 2.45 ? 0 : d > 1.8 ? 1 : d > 1.4 ? 2 : 3);

const POINT_VERTEX = `attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vColor; varying float vFacing;
void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); vFacing=dot(normalize(position), normalize(cameraPosition-position));
gl_PointSize=aSize*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`;
const POINT_FRAGMENT = `varying vec3 vColor; varying float vFacing;
void main(){ if(vFacing<0.06) discard; vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard;
float core=smoothstep(0.24,0.13,d); float ring=smoothstep(0.30,0.27,d)*smoothstep(0.22,0.25,d); float halo=smoothstep(0.5,0.18,d)*0.38;
vec3 col=mix(vColor, vec3(1.0,0.98,0.93), core*0.3); gl_FragColor=vec4(col, max(max(core,ring*0.9),halo)); }`;

function outline(b: Bounds, color: number, opacity: number) {
  const pts: THREE.Vector3[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++)
    pts.push(toVec(b.maxLat, b.minLon + ((b.maxLon - b.minLon) * i) / steps, 1.004));
  for (let i = 0; i <= steps; i++)
    pts.push(toVec(b.maxLat - ((b.maxLat - b.minLat) * i) / steps, b.maxLon, 1.004));
  for (let i = 0; i <= steps; i++)
    pts.push(toVec(b.minLat, b.maxLon - ((b.maxLon - b.minLon) * i) / steps, 1.004));
  for (let i = 0; i <= steps; i++)
    pts.push(toVec(b.minLat + ((b.maxLat - b.minLat) * i) / steps, b.minLon, 1.004));
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
}

type GlobeApi = {
  zoom: (f: number) => void;
  reset: () => void;
  rotate: (dLon: number, dLat: number) => void;
};

export function Globe({
  points,
  selected,
  focus,
  bounds,
  regionBounds,
  onPick,
  onLocation,
  highlight = null,
  pin = null,
  emphasis,
  onFail,
  height,
  autoRotateDefault = false,
  label,
}: {
  points: GlobePoint[];
  selected: { lat: number; lon: number; frp: number; id: string } | null;
  focus: { lat: number; lon: number; key: string; dist?: number | "keep" };
  bounds: Bounds | null;
  regionBounds: Bounds | null;
  onPick: (id: string | null) => void;
  /** Click on terrain without a fire marker (reverse-geocoded by the caller). */
  onLocation?: (lat: number, lon: number) => void;
  /** Selected geographic area outline: flat [lon, lat, …] rings. */
  highlight?: number[][] | null;
  /** Previewed map location (distinct from a selected fire event). */
  pin?: { lat: number; lon: number } | null;
  /** Fire records to emphasize (nearby detections / anomalous events). */
  emphasis?: Set<string>;
  onFail: () => void;
  height: number;
  autoRotateDefault?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);
  const connectorRef = useRef<SVGPathElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const api = useRef<GlobeApi | null>(null);
  const pointsRef = useRef(points);
  const dirty = useRef(true);
  const selectedRef = useRef(selected);
  const view = useRef<View>({ lat: focus.lat, lon: focus.lon - 35, dist: 3.1 });
  const target = useRef<View>({ lat: focus.lat, lon: focus.lon, dist: OVERVIEW });
  const autoRef = useRef(autoRotateDefault);
  const callbacks = useRef({ onPick, onFail, onLocation });
  callbacks.current = { onPick, onFail, onLocation };
  const outlines = useRef<THREE.Group | null>(null);
  const highlightGroup = useRef<THREE.Group | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const emphasisRef = useRef(emphasis);
  const focusDist = (f: typeof focus) => (typeof f.dist === "number" ? f.dist : OVERVIEW);
  const [auto, setAuto] = useState(autoRotateDefault);
  const [labels, setLabels] = useState<{ key: string; count: number }[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "texture-error">("loading");
  const [zoomPct, setZoomPct] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      callbacks.current.onFail();
      return;
    }
    const canvas = renderer.domElement;
    canvas.className = "globe-canvas";
    canvas.setAttribute("aria-hidden", "true");
    el.prepend(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    scene.add(camera);
    scene.add(new THREE.AmbientLight(0xcfe9ff, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-2.2, 1.5, 1.4);
    camera.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const material = new THREE.MeshPhongMaterial({
      color: 0xe3f2ff,
      shininess: 9,
      specular: new THREE.Color(0x183a55),
    });
    const loader = new THREE.TextureLoader();
    const base = import.meta.env.BASE_URL;
    loader.load(
      `${base}textures/earth-day.jpg`,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        material.map = t;
        material.needsUpdate = true;
        disposables.push(t);
        setStatus("ready");
      },
      undefined,
      () => {
        material.color.set(0x24658f);
        setStatus("texture-error");
      },
    );
    loader.load(`${base}textures/earth-bump.jpg`, (t) => {
      material.bumpMap = t;
      material.bumpScale = 2;
      material.needsUpdate = true;
      disposables.push(t);
    });
    const sphere = new THREE.SphereGeometry(1, 96, 64);
    const earthMesh = new THREE.Mesh(sphere, material);
    scene.add(earthMesh);

    const grat: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3) => grat.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (let lat = -75; lat <= 75; lat += 15)
      for (let lon = -180; lon < 180; lon += 3)
        push(toVec(lat, lon, 1.002), toVec(lat, lon + 3, 1.002));
    for (let lon = -180; lon < 180; lon += 15)
      for (let lat = -87; lat < 87; lat += 3)
        push(toVec(lat, lon, 1.002), toVec(lat + 3, lon, 1.002));
    const gratGeo = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(grat, 3),
    );
    const gratMat = new THREE.LineBasicMaterial({
      color: 0x8be7f5,
      transparent: true,
      opacity: 0.1,
    });
    scene.add(new THREE.LineSegments(gratGeo, gratMat));

    const haloGeo = new THREE.SphereGeometry(1.13, 64, 48);
    const haloMat = new THREE.ShaderMaterial({
      vertexShader: ATMOS_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(haloGeo, haloMat));
    const rimGeo = new THREE.SphereGeometry(1.003, 64, 48);
    const rimMat = new THREE.ShaderMaterial({
      vertexShader: ATMOS_VERTEX,
      fragmentShader: RIM_FRAGMENT,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(rimGeo, rimMat));

    const group = new THREE.Group();
    scene.add(group);
    outlines.current = group;
    const hl = new THREE.Group();
    scene.add(hl);
    highlightGroup.current = hl;
    // Location pin: a white ring with a cyan core — visually distinct from the fire-event flame.
    const pinGroup = new THREE.Group();
    const pinRing = surfaceRing(0xf8fafc, 0.8),
      pinPulse = surfaceRing(0x51d6f0, 0.9);
    const pinTex = glowTexture([
      [0, "rgba(255,255,255,1)"],
      [0.3, "rgba(81,214,240,0.9)"],
      [1, "rgba(32,188,229,0)"],
    ]);
    const pinDot = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pinTex, transparent: true, depthWrite: false }),
    );
    pinDot.scale.setScalar(0.03);
    pinGroup.add(pinRing, pinPulse);
    scene.add(pinGroup, pinDot);
    pinGroup.visible = pinDot.visible = false;
    let pinClock = 0;
    const raycaster = new THREE.Raycaster();

    // Selected-event emphasis lives on the Earth's surface so it stays anchored during rotation.
    const selGroup = new THREE.Group();
    selGroup.visible = false;
    const ringA = surfaceRing(0xff963d, 0.84),
      ringB = surfaceRing(0x51d6f0, 0.92);
    const coreTex = glowTexture([
      [0, "rgba(255,244,218,1)"],
      [0.25, "rgba(255,150,61,0.85)"],
      [1, "rgba(240,68,56,0)"],
    ]);
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: coreTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    core.scale.setScalar(0.035);
    selGroup.add(ringA, ringB);
    scene.add(selGroup, core);
    core.visible = false;
    disposables.push(
      ringA.geometry,
      ringA.material as THREE.Material,
      ringB.geometry,
      ringB.material as THREE.Material,
      coreTex,
      core.material,
    );
    const anchor = new THREE.Vector3(),
      aim = new THREE.Vector3();
    let anchorSet = false,
      ringClock = 0,
      lastSel = "";

    const pointGeo = new THREE.BufferGeometry();
    const pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: { uScale: { value: 10 } },
      transparent: true,
      depthWrite: false,
    });
    const pointMesh = new THREE.Points(pointGeo, pointMat);
    pointMesh.frustumCulled = false;
    scene.add(pointMesh);
    disposables.push(
      sphere,
      material,
      gratGeo,
      gratMat,
      haloGeo,
      haloMat,
      rimGeo,
      rimMat,
      pointGeo,
      pointMat,
    );

    let clusters: Cluster[] = [];
    let labelClusters: Cluster[] = [];
    let bucket = -1;
    function rebuild() {
      const size = LEVELS[bucket];
      const map = new Map<
        string,
        {
          lat: number;
          lon: number;
          count: number;
          ids: string[];
          maxFrp: number;
          cats: Map<string, number>;
          colors: Map<string, string>;
        }
      >();
      pointsRef.current.forEach((p, i) => {
        const key = size ? `${Math.floor(p.lat / size)}:${Math.floor(p.lon / size)}` : `${i}`;
        let c = map.get(key);
        if (!c)
          map.set(
            key,
            (c = { lat: 0, lon: 0, count: 0, ids: [], maxFrp: 0, cats: new Map(), colors: new Map() }),
          );
        c.lat += p.lat;
        c.lon += p.lon;
        c.count++;
        c.ids.push(p.id);
        if ((p.frp ?? 0) > c.maxFrp) c.maxFrp = p.frp ?? 0;
        if (emphasisRef.current?.has(p.id)) (c as { hot?: boolean }).hot = true;
        c.cats.set(p.category, (c.cats.get(p.category) || 0) + 1);
        c.colors.set(p.category, p.color);
      });
      const pos: number[] = [],
        col: number[] = [],
        sz: number[] = [];
      const color = new THREE.Color();
      clusters = [];
      map.forEach((c) => {
        const lat = c.lat / c.count,
          lon = c.lon / c.count;
        const v = toVec(lat, lon, 1.006);
        const dominant = [...c.cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
        color.set(c.colors.get(dominant)!);
        const hot = (c as { hot?: boolean }).hot;
        if (hot) color.lerp(new THREE.Color(0xffffff), 0.35);
        pos.push(v.x, v.y, v.z);
        col.push(color.r, color.g, color.b);
        // Marker size encodes grouped observations (log scale); emphasized detections get a fixed +0.8 boost.
        sz.push(1 + Math.min(2.4, Math.log10(c.count) * 1.15) + (hot ? 0.8 : 0));
        clusters.push({ lat, lon, count: c.count, ids: c.ids, pos: v, maxFrp: c.maxFrp });
      });
      pointGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      pointGeo.setAttribute("aColor", new THREE.Float32BufferAttribute(col, 3));
      pointGeo.setAttribute("aSize", new THREE.Float32BufferAttribute(sz, 1));
      pointGeo.computeBoundingSphere();
      labelClusters = clusters
        .filter((c) => c.count >= 4)
        .sort((a, b) => b.count - a.count)
        .slice(0, 18);
      setLabels(
        labelClusters.map((c, i) => ({ key: `${bucket}-${i}-${c.count}`, count: c.count })),
      );
    }

    let w = 1,
      h = 1;
    const resize = () => {
      w = el.clientWidth || 1;
      h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pointMat.uniforms.uScale.value = h * renderer.getPixelRatio() * 0.0125;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const tmp = new THREE.Vector3(),
      toCam = new THREE.Vector3();
    const place = (v: THREE.Vector3) => {
      tmp.copy(v).project(camera);
      toCam.copy(camera.position).sub(v).normalize();
      return {
        x: ((tmp.x + 1) / 2) * w,
        y: ((1 - tmp.y) / 2) * h,
        front: v.clone().normalize().dot(toCam) > 0.08,
      };
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0,
      pinch = 0,
      dragging = false,
      visible = true,
      lastZoom = -1;
    const stopAuto = () => {
      if (autoRef.current) {
        autoRef.current = false;
        setAuto(false);
      }
    };
    const findClusterAt = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const mx = clientX - r.left,
        my = clientY - r.top;
      let best: Cluster | null = null,
        bd = 26 * 26;
      for (const c of clusters) {
        const p = place(c.pos);
        if (!p.front) continue;
        const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d < bd) [best, bd] = [c, d];
      }
      return { best, r, mx, my };
    };
    const pick = (clientX: number, clientY: number, inspectDirect = false) => {
      const { best, r, mx, my } = findClusterAt(clientX, clientY);
      if (!best) {
        // No marker under the pointer: resolve the clicked terrain coordinate on the sphere.
        if (!callbacks.current.onLocation) return;
        raycaster.setFromCamera(
          new THREE.Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1),
          camera,
        );
        const hit = raycaster.intersectObject(earthMesh, false)[0];
        if (!hit) return;
        const v = hit.point.clone().normalize();
        const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, v.y))) * 180) / Math.PI;
        let lon = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
        if (lon < -180) lon += 360;
        callbacks.current.onLocation(lat, lon);
        return;
      }
      const c: Cluster = best;
      if (c.count > 1 && bucket < 2 && !inspectDirect) {
        // Expand a cluster by flying toward it and zooming closer.
        target.current = {
          lat: c.lat,
          lon: c.lon,
          dist: Math.max(CLOSE, target.current.dist * 0.45),
        };
      } else callbacks.current.onPick(c.ids[0]);
    };
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      dragging = true;
      canvas.style.cursor = "grabbing";
      setHoverInfo(null);
      stopAuto();
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (!dragging) {
          const { best, mx, my } = findClusterAt(e.clientX, e.clientY);
          if (best) {
            canvas.style.cursor = "pointer";
            setHoverInfo({
              x: mx,
              y: my,
              text:
                best.count > 1 && bucket < 2
                  ? `${best.count} records · Max ${best.maxFrp.toFixed(0)} MW · Click to zoom (Shift+Click to inspect)`
                  : `${best.count > 1 ? `${best.count} records · ` : ""}Max ${best.maxFrp.toFixed(1)} MW · Click to inspect`,
            });
          } else {
            canvas.style.cursor = "grab";
            setHoverInfo(null);
          }
        }
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) target.current.dist = clamp((target.current.dist * pinch) / d, 1.16, 4.2);
        pinch = d;
        moved += 10;
        return;
      }
      const dx = e.clientX - prev.x,
        dy = e.clientY - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      const k = ((target.current.dist - 1) * 42) / Math.max(h, 1);
      target.current.lon -= dx * k;
      target.current.lat = clamp(target.current.lat + dy * k, -80, 80);
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!pointers.size) {
        dragging = false;
        canvas.style.cursor = "grab";
      }
      if (moved < 6) pick(e.clientX, e.clientY, e.shiftKey);
    };
    const onLeave = () => {
      setHoverInfo(null);
      canvas.style.cursor = "grab";
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAuto();
      target.current.dist = clamp(target.current.dist * Math.exp(e.deltaY * 0.0012), 1.16, 4.2);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const io = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
    io.observe(el);

    api.current = {
      zoom: (f) => {
        stopAuto();
        target.current.dist = clamp(target.current.dist * f, 1.16, 4.2);
      },
      rotate: (dLon, dLat) => {
        stopAuto();
        target.current.lon += dLon;
        target.current.lat = clamp(target.current.lat + dLat, -80, 80);
      },
      reset: () => {},
    };

    let raf = 0,
      last = performance.now();
    const tick = (now = performance.now()) => {
      raf = requestAnimationFrame(tick);
      // Frame-rate independent easing: the same wall-clock duration on any device.
      const frames = Math.min(6, Math.max(0, (now - last) / 16.67));
      last = now;
      if (!visible) return;
      const v = view.current,
        t = target.current;
      if (autoRef.current && !dragging && !selectedRef.current) t.lon += 0.035 * frames;
      const ease = 1 - Math.pow(1 - (dragging ? 0.32 : 0.075), frames);
      const dl = ((((t.lon - v.lon) % 360) + 540) % 360) - 180;
      v.lon += dl * ease;
      v.lat += (t.lat - v.lat) * ease;
      v.dist += (t.dist - v.dist) * ease;
      camera.position.copy(toVec(v.lat, v.lon, v.dist));
      camera.lookAt(0, 0, 0);
      const b = bucketOf(v.dist);
      if (b !== bucket || dirty.current) {
        bucket = b;
        dirty.current = false;
        rebuild();
      }
      const pn = pinRef.current;
      pinGroup.visible = pinDot.visible = !!pn;
      if (pn) {
        pinClock += frames / 60;
        const pv = toVec(pn.lat, pn.lon, 1);
        pinGroup.position.copy(pv).multiplyScalar(1.004);
        pinGroup.quaternion.copy(tangentQuaternion(pv));
        pinDot.position.copy(pv).multiplyScalar(1.008);
        pinRing.scale.setScalar(0.022);
        (pinRing.material as THREE.MeshBasicMaterial).opacity = 0.95;
        const q = (pinClock % 2) / 2;
        pinPulse.scale.setScalar(0.02 + q * 0.05);
        (pinPulse.material as THREE.MeshBasicMaterial).opacity = (1 - q) * 0.7;
      }
      renderer.render(scene, camera);
      const z = Math.round(((4.2 - v.dist) / (4.2 - 1.16)) * 100);
      if (z !== lastZoom) {
        lastZoom = z;
        setZoomPct(z);
      }
      const labelEls = labelsRef.current?.children;
      if (labelEls)
        for (let i = 0; i < labelEls.length; i++) {
          const c = labelClusters[i],
            node = labelEls[i] as HTMLElement;
          if (!c) continue;
          const p = place(c.pos);
          node.style.transform = `translate(${p.x}px, ${p.y}px)`;
          node.style.opacity = p.front ? "1" : "0";
        }
      const s = selectedRef.current;
      selGroup.visible = core.visible = !!s;
      if (!s) anchorSet = false;
      if (s && selRef.current) {
        aim.copy(toVec(s.lat, s.lon, 1));
        const key = `${s.lat},${s.lon}`;
        if (key !== lastSel) {
          lastSel = key;
          ringClock = 0;
        }
        // Glide along the surface between consecutive selections instead of jumping.
        if (!anchorSet) (anchor.copy(aim), (anchorSet = true));
        else anchor.lerp(aim, 1 - Math.pow(1 - 0.12, frames)).normalize();
        ringClock += frames / 60;
        selGroup.position.copy(anchor).multiplyScalar(1.004);
        selGroup.quaternion.copy(tangentQuaternion(anchor));
        const k = (ringClock % 2.4) / 2.4,
          k2 = ((ringClock + 1.2) % 2.4) / 2.4;
        ringA.scale.setScalar(0.012 + k * 0.07);
        (ringA.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
        ringB.scale.setScalar(0.012 + k2 * 0.05);
        (ringB.material as THREE.MeshBasicMaterial).opacity = (1 - k2) * 0.6;
        core.position.copy(anchor).multiplyScalar(1.008);
        core.scale.setScalar(0.03 + Math.sin(ringClock * 3.2) * 0.004);
        const p = place(anchor.clone().multiplyScalar(1.006));
        selRef.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
        selRef.current.style.opacity = p.front ? "1" : "0";
        connectorRef.current?.setAttribute(
          "d",
          p.front
            ? `M${p.x} ${p.y + 14} C${p.x} ${(p.y + h) / 2} ${p.x} ${(p.y + h) / 2} ${p.x} ${h}`
            : "",
        );
      }
    };
    tick();

    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__emberGlobe = () => {
        const r = canvas.getBoundingClientRect();
        return clusters
          .map((c) => ({ ...place(c.pos), count: c.count, id: c.ids[0], bucket }))
          .filter((p) => p.front && p.x > 40 && p.y > 60 && p.x < w - 60 && p.y < h - 60)
          .map((p) => ({ ...p, x: p.x + r.left, y: p.y + r.top }));
      };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      group.children.forEach((o) => {
        (o as THREE.LineLoop).geometry.dispose();
        ((o as THREE.LineLoop).material as THREE.Material).dispose();
      });
      hl.children.forEach((o) => {
        (o as THREE.Line).geometry.dispose();
        ((o as THREE.Line).material as THREE.Material).dispose();
      });
      [pinRing, pinPulse].forEach(
        (m) => (m.geometry.dispose(), (m.material as THREE.Material).dispose()),
      );
      pinTex.dispose();
      pinDot.material.dispose();
      highlightGroup.current = null;
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      outlines.current = null;
      api.current = null;
    };
  }, []);

  useEffect(() => {
    pointsRef.current = points;
    dirty.current = true;
  }, [points]);
  useEffect(() => {
    emphasisRef.current = emphasis;
    dirty.current = true;
  }, [emphasis]);
  useEffect(() => {
    const g = highlightGroup.current;
    if (!g) return;
    g.children.slice().forEach((o) => {
      g.remove(o);
      (o as THREE.Line).geometry.dispose();
      ((o as THREE.Line).material as THREE.Material).dispose();
    });
    if (!highlight?.length) return;
    // Densify long edges so boundary lines follow the curved surface instead of cutting through it.
    const ringPoints = (ring: number[], r: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < ring.length; i += 2) {
        const x0 = ring[i],
          y0 = ring[i + 1],
          x1 = ring[(i + 2) % ring.length],
          y1 = ring[(i + 3) % ring.length];
        const steps = Math.min(40, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.2)));
        for (let k = 0; k < steps; k++)
          pts.push(toVec(y0 + ((y1 - y0) * k) / steps, x0 + ((x1 - x0) * k) / steps, r));
      }
      return pts;
    };
    for (const ring of highlight) {
      if (ring.length < 6) continue;
      g.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ringPoints(ring, 1.0035)),
          new THREE.LineBasicMaterial({
            color: 0xb7f0fa,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
          }),
        ),
      );
      g.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ringPoints(ring, 1.008)),
          new THREE.LineBasicMaterial({
            color: 0x20bce5,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
          }),
        ),
      );
    }
  }, [highlight]);
  useEffect(() => {
    const had = selectedRef.current;
    selectedRef.current = selected;
    if (selected) {
      autoRef.current = false;
      setAuto(false);
      target.current = { lat: selected.lat, lon: selected.lon, dist: CLOSE };
    } else if (had)
      target.current = {
        ...target.current,
        dist: focus.dist === "keep" ? target.current.dist : focusDist(focus),
      };
  }, [selected?.lat, selected?.lon]);
  useEffect(() => {
    // A selected record takes precedence over the region overview (e.g. "Locate on globe").
    const s = selectedRef.current;
    target.current = s
      ? { lat: s.lat, lon: s.lon, dist: CLOSE }
      : {
          lat: focus.lat,
          lon: focus.lon,
          dist: focus.dist === "keep" ? target.current.dist : focusDist(focus),
        };
  }, [focus.key]);
  useEffect(() => {
    const g = outlines.current;
    if (!g) return;
    g.children.slice().forEach((o) => {
      g.remove(o);
      (o as THREE.LineLoop).geometry.dispose();
      ((o as THREE.LineLoop).material as THREE.Material).dispose();
    });
    if (regionBounds) g.add(outline(regionBounds, 0x8be7f5, 0.45));
    if (bounds) g.add(outline(bounds, 0xffc15a, 0.95));
  }, [regionBounds, bounds]);

  const resetView = () => {
    onPick(null);
    target.current = { lat: focus.lat, lon: focus.lon, dist: focusDist(focus) };
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const a = api.current;
    if (!a || e.target !== e.currentTarget) return;
    const map: Record<string, () => void> = {
      ArrowLeft: () => a.rotate(-8, 0),
      ArrowRight: () => a.rotate(8, 0),
      ArrowUp: () => a.rotate(0, 6),
      ArrowDown: () => a.rotate(0, -6),
      "+": () => a.zoom(0.8),
      "=": () => a.zoom(0.8),
      "-": () => a.zoom(1.25),
      Escape: resetView,
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
  };

  return (
    <div
      className="globe"
      ref={host}
      style={{ height }}
      tabIndex={0}
      role="application"
      aria-label={`${label}. Drag or use arrow keys to rotate, plus and minus to zoom, Escape to reset.`}
      onKeyDown={onKey}
      data-status={status}
    >
      <div className="globe-labels" ref={labelsRef} aria-hidden="true">
        {labels.map((l) => (
          <span key={l.key} className="cluster-label">
            {compact(l.count)}
          </span>
        ))}
      </div>
      {hoverInfo && (
        <div
          style={{
            position: "absolute",
            left: hoverInfo.x,
            top: hoverInfo.y - 14,
            transform: "translate(-50%, -100%)",
            pointerEvents: "none",
            background: "rgba(10, 22, 34, 0.92)",
            border: "1px solid rgba(81, 214, 240, 0.45)",
            color: "#e6f2fa",
            fontSize: 12,
            fontWeight: 500,
            padding: "5px 10px",
            borderRadius: 8,
            whiteSpace: "nowrap",
            zIndex: 12,
            boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
          }}
        >
          {hoverInfo.text}
        </div>
      )}
      <svg className="globe-connector" aria-hidden="true">
        <path ref={connectorRef} />
      </svg>
      <div className="globe-selection" ref={selRef} hidden={!selected} aria-hidden="true">
        <svg className="target-ring" viewBox="0 0 60 60">
          <circle cx="30" cy="30" r="22" />
          <path d="M30 2v10M30 48v10M2 30h10M48 30h10" />
        </svg>
        {selected &&
          (() => {
            const tier = flameTier(selected.frp),
              size = FLAME_SIZE[tier];
            // Anchor the flame's base (y = 86/90 of its viewBox) on the projected surface point.
            return (
              <span
                key={selected.id}
                className="selection-flame"
                data-tier={tier}
                style={{ left: -size / 2, top: -size * 1.4 * 0.955 }}
              >
                <Flame size={size} intensity={tier} particles />
              </span>
            );
          })()}
      </div>
      <div className="globe-controls" role="group" aria-label="Globe controls">
        <IconButton icon="plus" label="Zoom in" onClick={() => api.current?.zoom(0.75)} />
        <span className="zoom-meter" aria-hidden="true">
          <i style={{ height: `${Math.max(6, zoomPct)}%` }} />
        </span>
        <IconButton icon="minus" label="Zoom out" onClick={() => api.current?.zoom(1.33)} />
        <IconButton icon="target" label="Reset view" onClick={resetView} />
        <IconButton
          icon={auto ? "pause" : "play"}
          label={auto ? "Pause rotation" : "Start gentle rotation"}
          onClick={() => {
            autoRef.current = !auto;
            setAuto(!auto);
          }}
        />
      </div>
      {status === "loading" && <div className="globe-loading">Loading Earth surface…</div>}
      {status === "texture-error" && (
        <div className="globe-note">Surface texture unavailable · coordinates remain accurate</div>
      )}
    </div>
  );
}

export type RecordContext = { anomalyPct: number | null; anomalyNote: string };

export function GlobeExplorer({
  rows,
  filters,
  record,
  onRecord,
  onBounds,
  context,
  height = 520,
  regimeLayer = false,
  minimal = false,
  autoRotate = false,
  title = "Fire activity, in context",
  extra,
  geo,
}: {
  rows: FireRecord[];
  filters: Filters;
  record: FireRecord | null;
  onRecord: (r: FireRecord | null) => void;
  onBounds: (b: Bounds | null) => void;
  context: (r: FireRecord) => RecordContext;
  height?: number;
  regimeLayer?: boolean;
  minimal?: boolean;
  autoRotate?: boolean;
  title?: string;
  extra?: ReactNode;
  /** Geographic intelligence wiring: search slot, focus/outline/pin state, and the location inspector. */
  geo?: {
    search?: ReactNode;
    scopeName?: string;
    focus?: { lat: number; lon: number; key: string; dist?: number | "keep" };
    highlight?: number[][] | null;
    pin?: { lat: number; lon: number } | null;
    emphasis?: Set<string>;
    onLocation?: (lat: number, lon: number) => void;
    panel?: ReactNode;
    hidePilotOutline?: boolean;
  };
}) {
  const region = REGIONS.find((r) => r.id === filters.region)!;
  const [supported] = useState(webglAvailable);
  const [failed, setFailed] = useState(false);
  const [flat, setFlat] = useState(false);
  const [intensity, setIntensity] = useState(false);
  const categories = regimeLayer
    ? Object.keys(REGIME_COLORS)
    : filters.mode === "raw"
      ? ["MODIS", "VIIRS"]
      : MATCHES;
  const [hidden, setHidden] = useState<string[]>([]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const points = useMemo(() => {
    const out: GlobePoint[] = [];
    for (const r of rows) {
      if (regimeLayer) {
        if (!hidden.includes(r.regime))
          out.push({
            id: r.id,
            lat: r.lat,
            lon: r.lon,
            category: r.regime,
            color: REGIME_COLORS[r.regime],
            frp: r.frp,
          });
      } else if (filters.mode === "raw") {
        for (const s of sources(r))
          if (
            (filters.sensor === "All sensors" || s.sensor === filters.sensor) &&
            !hidden.includes(s.sensor)
          )
            out.push({
              id: r.id,
              lat: s.latitude,
              lon: s.longitude,
              category: s.sensor,
              color: intensity ? frpColor(s.frp_mw) : SENSOR_COLORS[s.sensor],
              frp: s.frp_mw,
            });
      } else if (!hidden.includes(r.match))
        out.push({
          id: r.id,
          lat: r.lat,
          lon: r.lon,
          category: r.match,
          color: intensity ? frpColor(r.frp) : MATCH_COLORS[r.match],
          frp: r.frp,
        });
    }
    return out;
  }, [rows, filters.mode, filters.sensor, hidden, intensity, regimeLayer]);
  const strongest = useMemo(() => [...rows].sort((a, b) => b.frp - a.frp).slice(0, 6), [rows]);
  const related = useMemo(
    () =>
      record
        ? rows
            .filter(
              (r) =>
                r !== record &&
                Math.abs(Date.parse(r.date) - Date.parse(record.date)) <= 3 * 86400000 &&
                distanceKm(r.lat, r.lon, record.lat, record.lon) <= 120,
            )
            .sort(
              (a, b) =>
                distanceKm(a.lat, a.lon, record.lat, record.lon) -
                distanceKm(b.lat, b.lon, record.lat, record.lon),
            )
            .slice(0, 6)
        : [],
    [rows, record],
  );
  const use3d = supported && !failed && !flat;
  const sectionRef = useRef<HTMLElement>(null);
  // Return focus to the map surface so keyboard users are not dropped to <body>.
  const clearSelection = () => {
    onRecord(null);
    requestAnimationFrame(() =>
      sectionRef.current?.querySelector<HTMLElement>(".globe, .fire-map svg")?.focus(),
    );
  };
  const legendColor = (c: string) =>
    regimeLayer ? REGIME_COLORS[c] : filters.mode === "raw" ? SENSOR_COLORS[c] : MATCH_COLORS[c];
  return (
    <section
      ref={sectionRef}
      className={`globe-explorer ${minimal ? "minimal" : ""}`}
      aria-label={title}
    >
      {!minimal && (
        <div className="globe-head">
          <div>
            <div className="eyebrow">
              <span className="live-dot" />
              DIGITAL EARTH · {(geo?.scopeName ?? region.name).toUpperCase()}
            </div>
            <Heading>{title}</Heading>
          </div>
          {geo?.search && <div className="globe-search-slot">{geo.search}</div>}
          <div className="globe-head-actions">
            <Badge tone="thermal">
              {fmt(points.length)}{" "}
              {filters.mode === "raw" && !regimeLayer ? "source detections" : "analytical records"}
            </Badge>
            {supported && !failed && (
              <div className="view-switch" role="group" aria-label="Map projection">
                <button aria-pressed={!flat} onClick={() => setFlat(false)}>
                  <Icon name="globe" size={14} />
                  3D globe
                </button>
                <button aria-pressed={flat} onClick={() => setFlat(true)}>
                  <Icon name="map" size={14} />
                  Flat · draw area
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="globe-stage">
        {use3d ? (
          <Globe
            points={points}
            selected={
              record ? { lat: record.lat, lon: record.lon, frp: record.frp, id: record.id } : null
            }
            focus={geo?.focus ?? { lat: region.lat, lon: region.lon, key: region.id }}
            bounds={filters.bounds}
            regionBounds={geo?.hidePilotOutline ? null : region.bounds}
            onLocation={geo?.onLocation}
            highlight={geo?.highlight}
            pin={geo?.pin}
            emphasis={geo?.emphasis}
            onPick={(id) => onRecord(id ? byId.get(id) || null : null)}
            onFail={() => setFailed(true)}
            height={height}
            autoRotateDefault={autoRotate}
            label={`Interactive 3D globe of ${region.name} with ${points.length} harmonized NASA fire markers`}
          />
        ) : (
          <div className="flat-stage" style={{ height }}>
            <FireMap
              rows={rows}
              filters={filters}
              onSelect={(r) => onRecord(r)}
              onBounds={onBounds}
              onLocation={geo?.onLocation}
              full
              defaultDraw
              regimeLayer={regimeLayer}
            />
            {!supported || failed ? (
              <div className="globe-note">
                3D rendering is unavailable on this device · showing the 2D map
              </div>
            ) : null}
          </div>
        )}
        {!minimal && (
          <div className="globe-legend" role="group" aria-label="Map layers">
            {categories.map((c) => (
              <button
                key={c}
                className="layer-btn"
                aria-pressed={!hidden.includes(c)}
                onClick={() =>
                  setHidden(hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c])
                }
              >
                <i
                  style={{
                    background: intensity && !regimeLayer ? "transparent" : legendColor(c),
                    borderColor: legendColor(c),
                  }}
                />
                {c === "Matched (Both)"
                  ? "Matched"
                  : c.replace(" likely pattern", "").replace(" pattern", "")}
              </button>
            ))}
            {!regimeLayer && (
              <button
                aria-pressed={intensity}
                onClick={() => setIntensity(!intensity)}
                className="intensity-toggle"
              >
                <span className="frp-ramp" />
                Color by FRP
              </button>
            )}
            <span className="legend-note">
              Marker size = grouped observations · selected flame size = FRP tier (&lt;30 · 30–110 ·
              &gt;110 MW), not physical fire size
            </span>
          </div>
        )}
      </div>
      {!minimal &&
        (record ? (
          <ObservationInspector
            key={record.id}
            record={record}
            context={context(record)}
            related={related}
            onSelect={onRecord}
            onClose={clearSelection}
          />
        ) : geo?.panel ? (
          geo.panel
        ) : (
          <div className="inspector-placeholder">
            <div className="placeholder-copy">
              <Icon name="target" size={18} />
              <span>
                <strong>
                  Select a thermal marker to inspect it, or click anywhere on the Earth to identify
                  a location.
                </strong>{" "}
                Clusters expand as you zoom. Or start with the strongest signals in view:
              </span>
            </div>
            <div className="related-list">
              {strongest.map((r) => (
                <button key={r.id} onClick={() => onRecord(r)} className="related-chip">
                  <span className="chip-swatch" style={{ background: MATCH_COLORS[r.match] }} />
                  <span>
                    {r.date}
                    <small>
                      {r.frp.toFixed(1)} MW · {r.match}
                    </small>
                  </span>
                </button>
              ))}
              {!strongest.length && (
                <span className="muted">No observations match the active filters.</span>
              )}
            </div>
          </div>
        ))}
      {extra}
    </section>
  );
}

export function ObservationInspector({
  record,
  context,
  related,
  onSelect,
  onClose,
  onLocate,
}: {
  record: FireRecord;
  context: RecordContext;
  related: FireRecord[];
  onSelect: (r: FireRecord) => void;
  onClose: () => void;
  onLocate?: () => void;
}) {
  const src = sources(record);
  const quality = recordQuality(record);
  const satellites = [...new Set(src.map((s) => s.satellite))];
  const high = record.frp > 110;
  return (
    <section
      className="inspector"
      aria-label={`Observation inspector for ${record.id}`}
      aria-live="polite"
    >
      <header className="inspector-head">
        <Flame size={30} particles={high} />
        <div>
          <span className="eyebrow">OBSERVATION INSPECTOR · CELL/DAY ANALYTICAL UNIT</span>
          <Heading>{record.id}</Heading>
        </div>
        <Badge
          tone={
            record.match === "Matched (Both)"
              ? "thermal"
              : record.match === "VIIRS-Only"
                ? "cyan"
                : "gold"
          }
        >
          {record.match}
        </Badge>
        <span className="inspector-actions">
          {onLocate && (
            <Button icon="globe" onClick={onLocate}>
              Locate on globe
            </Button>
          )}
          <IconButton icon="close" label="Clear selection" onClick={onClose} />
        </span>
      </header>
      <div className="inspector-grid">
        <div className="inspector-group">
          <h3>Geographic identity</h3>
          <dl>
            <div>
              <dt>Event coordinates</dt>
              <dd className="mono">
                {record.lat.toFixed(3)}°, {record.lon.toFixed(3)}°
              </dd>
            </div>
            <EventGeography lat={record.lat} lon={record.lon} />
          </dl>
        </div>
        <div className="inspector-group thermal-group">
          <h3>Thermal signal</h3>
          <div className="frp-readout">
            <strong>{record.frp.toFixed(1)}</strong>
            <span>MW · max FRP</span>
          </div>
          <div className="frp-scale" aria-hidden="true">
            <i style={{ left: `${Math.min(100, (record.frp / 180) * 100)}%` }} />
          </div>
          <div className="frp-scale-labels">
            <span>0</span>
            <span>90</span>
            <span>180+ MW</span>
          </div>
          <dl>
            <div>
              <dt>Source confidence</dt>
              <dd>{record.confidence}</dd>
            </div>
          </dl>
        </div>
        <div className="inspector-group">
          <h3>Sensors</h3>
          <div className="sensor-counts">
            <span className="sensor-pill modis">
              <i />
              MODIS <strong>{record.modis}</strong>
            </span>
            <span className="sensor-pill viirs">
              <i />
              VIIRS <strong>{record.viirs}</strong>
            </span>
          </div>
          <dl>
            <div>
              <dt>Acquisition (UTC)</dt>
              <dd className="mono">
                {record.date} · {acquisitionTime(record)}
              </dd>
            </div>
            <div>
              <dt>Satellites</dt>
              <dd>{satellites.join(", ")}</dd>
            </div>
            <div>
              <dt>Match classification</dt>
              <dd>{record.match}</dd>
            </div>
          </dl>
        </div>
        <div className="inspector-group">
          <h3>Analysis</h3>
          <dl>
            <div>
              <dt>Month vs. baseline</dt>
              <dd>
                {context.anomalyPct === null
                  ? "Insufficient baseline"
                  : `${context.anomalyPct >= 0 ? "+" : ""}${context.anomalyPct.toFixed(0)}%`}
              </dd>
            </div>
            <div>
              <dt>Inferred pattern</dt>
              <dd>{record.regime}</dd>
            </div>
            <div>
              <dt>Data quality</dt>
              <dd>
                <span className={`quality q${quality.score}`}>
                  {[0, 1, 2].map((i) => (
                    <i key={i} className={i < quality.score ? "on" : ""} />
                  ))}
                </span>
                {quality.label}
              </dd>
            </div>
          </dl>
          <small>
            {context.anomalyNote} Quality = high confidence + ≥2 sources + cross-sensor match
            (rule-based, not validated accuracy).
          </small>
        </div>
      </div>
      <h3 className="source-title">
        Underlying source observations <span>{src.length} retained · Gold archive</span>
      </h3>
      <div className="table-scroll source-table">
        <table>
          <thead>
            <tr>
              <th>Source ID</th>
              <th>Sensor</th>
              <th>Satellite</th>
              <th>UTC</th>
              <th>Source coordinates</th>
              <th>FRP</th>
            </tr>
          </thead>
          <tbody>
            {src.map((s) => (
              <tr key={s.source_id}>
                <td className="mono">{s.source_id}</td>
                <td>
                  <span className={`sensor-dot ${s.sensor.toLowerCase()}`} />
                  {s.sensor}
                </td>
                <td>{s.satellite}</td>
                <td className="mono">{s.time_utc}</td>
                <td className="mono">
                  {s.latitude.toFixed(4)}, {s.longitude.toFixed(4)}
                </td>
                <td>{s.frp_mw.toFixed(1)} MW</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="inspector-foot">
        <span className="inline-caveat">
          <Icon name="info" size={14} />A cell/day may contain multiple independent fire activities;
          this is not a confirmed single physical event.
        </span>
        {related.length > 0 && (
          <div className="related-list">
            <span className="related-label">Nearby · ±3 days · 120 km</span>
            {related.map((r) => (
              <button key={r.id} className="related-chip" onClick={() => onSelect(r)}>
                <span className="chip-swatch" style={{ background: MATCH_COLORS[r.match] }} />
                <span>
                  {r.date}
                  <small>
                    {Math.round(distanceKm(r.lat, r.lon, record.lat, record.lon))} km ·{" "}
                    {r.frp.toFixed(0)} MW
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
