import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Flame, useReducedMotion } from "./flame";
import { SEQ } from "./calendar";
import { coverage } from "./features";
import { ATMOS_VERTEX, glowTexture, surfaceRing, tangentQuaternion, toVec } from "./earth";
import { Badge, Button, Icon, Logo } from "./ui";
import { ALL_RECORDS, MONTHS, fmt, sources } from "./data";

type Target = "Overview" | "Methodology" | "Activity Calendar" | "Sensor Harmonization";
const STORY = [
  { key: "Observe", text: "MODIS and VIIRS pass over the same fire and scan it." },
  { key: "Resolve", text: "Each sensor records it at its own resolution: ≈1 km vs ≈375 m." },
  { key: "Converge", text: "Detections in the same cell and UTC day flow into one unit." },
  { key: "Unify", text: "One harmonized thermal event — every source still traceable." },
];
const CYCLE = 20; // seconds per story loop = one satellite orbit
const PHASE = CYCLE / STORY.length;

/** The landing's focal event: the strongest matched record in the synthetic Amazon 2024 data. */
const EVENT = (() => {
  const pool = ALL_RECORDS.filter(
    (r) => r.region === "amazon" && r.date.startsWith("2024") && r.match === "Matched (Both)",
  );
  return pool.reduce((a, b) => (b.frp > a.frp ? b : a), pool[0]);
})();

const EARTH_FRAGMENT = `uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir;
varying vec2 vUv; varying vec3 vNormalW; varying vec3 vViewDir;
void main(){
  vec3 n=normalize(vNormalW); float d=dot(n,normalize(sunDir)); float day=smoothstep(-0.2,0.35,d);
  vec3 dayC=texture2D(dayMap,vUv).rgb; vec3 nightC=texture2D(nightMap,vUv).rgb;
  vec3 lit=dayC*(0.32+1.0*max(d,0.0));
  vec3 night=dayC*0.08+nightC*vec3(1.0,0.78,0.52)*1.25;
  vec3 col=mix(night,lit,day);
  col=mix(col,col*vec3(0.86,0.96,1.1),0.35);
  float fres=pow(1.0-max(dot(n,normalize(vViewDir)),0.0),3.0);
  col+=vec3(0.22,0.68,0.95)*fres*0.32;
  gl_FragColor=vec4(col,1.0);
  #include <colorspace_fragment>
}`;
// Softer atmosphere than the dashboard globe: the landing camera sits much closer to the limb.
const LANDING_HALO = `varying vec3 vN; varying vec3 vP; void main(){ float i=pow(max(0.0,0.62-dot(vN,vec3(0.0,0.0,1.0))),2.9); gl_FragColor=vec4(0.3,0.78,0.95,1.0)*i*0.95; }`;
const EARTH_VERTEX = `varying vec2 vUv; varying vec3 vNormalW; varying vec3 vViewDir;
void main(){ vUv=uv; vNormalW=normalize(mat3(modelMatrix)*normal); vec4 wp=modelMatrix*vec4(position,1.0); vViewDir=normalize(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`;
const CLOUD_FRAGMENT = `uniform sampler2D cloudMap; uniform vec3 sunDir; varying vec2 vUv; varying vec3 vNormalW; varying vec3 vViewDir;
void main(){ float a=texture2D(cloudMap,vUv).r; float d=dot(normalize(vNormalW),normalize(sunDir)); float l=0.22+0.95*smoothstep(-0.25,0.6,d);
gl_FragColor=vec4(vec3(l)*vec3(0.9,0.97,1.0),a*0.5);
#include <colorspace_fragment>
}`;
const POINTS_VERTEX = `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale; varying float vAlpha; varying vec3 vColor;
void main(){ vAlpha=aAlpha; vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`;
const POINTS_FRAGMENT = `varying float vAlpha; varying vec3 vColor; void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard; float a=smoothstep(0.5,0.0,d); gl_FragColor=vec4(vColor*(0.6+a*0.6), a*vAlpha); }`;
const BEAM_FRAGMENT = `uniform vec3 uColor; uniform float uTime; uniform float uOpacity; varying vec2 vUv;
void main(){ float scan=0.55+0.45*sin(vUv.y*26.0+uTime*5.0); float fade=smoothstep(0.0,0.25,vUv.y)*smoothstep(1.0,0.75,vUv.y)+smoothstep(0.85,1.0,1.0-vUv.y)*0.6;
gl_FragColor=vec4(uColor, uOpacity*scan*(0.25+0.75*(1.0-vUv.y))*max(fade,0.35)); }`;
const BEAM_VERTEX = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function makePoints(n: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("aSize", new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute("aColor", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: POINTS_VERTEX,
    fragmentShader: POINTS_FRAGMENT,
    uniforms: { uScale: { value: 300 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function LivingEarth({
  phase,
  playing,
  onPhase,
}: {
  phase: number;
  playing: boolean;
  onPhase: (p: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const flameRef = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const state = useRef({ phase, playing, onPhase });
  state.current = { phase, playing, onPhase };
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [failed, setFailed] = useState(false);
  const [small, setSmall] = useState(false);

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
      setFailed(true);
      return;
    }
    const mobile = window.innerWidth < 760;
    setSmall(mobile);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.className = "living-canvas";
    canvas.setAttribute("aria-hidden", "true");
    el.prepend(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
    const sunDir = new THREE.Vector3(-1.2, 0.9, 1.1).normalize();
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    const base = import.meta.env.BASE_URL;
    const loader = new THREE.TextureLoader();
    const tex = (name: string, srgb = true) => {
      const t = keep(loader.load(`${base}textures/${name}`));
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };

    // World group: Earth and everything anchored to its surface.
    const world = new THREE.Group();
    scene.add(world);
    const earthMat = keep(
      new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX,
        fragmentShader: EARTH_FRAGMENT,
        uniforms: {
          dayMap: { value: tex("earth-day.jpg") },
          nightMap: { value: tex("earth-night.jpg") },
          sunDir: { value: sunDir },
        },
      }),
    );
    world.add(
      new THREE.Mesh(
        keep(new THREE.SphereGeometry(1, mobile ? 72 : 112, mobile ? 48 : 80)),
        earthMat,
      ),
    );
    const clouds = new THREE.Mesh(
      keep(new THREE.SphereGeometry(1.012, 72, 48)),
      keep(
        new THREE.ShaderMaterial({
          vertexShader: EARTH_VERTEX,
          fragmentShader: CLOUD_FRAGMENT,
          uniforms: {
            cloudMap: { value: tex("earth-clouds.jpg", false) },
            sunDir: { value: sunDir },
          },
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    world.add(clouds);
    scene.add(
      new THREE.Mesh(
        keep(new THREE.SphereGeometry(1.17, 64, 48)),
        keep(
          new THREE.ShaderMaterial({
            vertexShader: ATMOS_VERTEX,
            fragmentShader: LANDING_HALO,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
          }),
        ),
      ),
    );

    // Orientation: bring the event to the upper-front of the planet, north kept up.
    const fireLocal = toVec(EVENT.lat, EVENT.lon, 1).normalize();
    const yaw = Math.atan2(-fireLocal.x, fireLocal.z);
    const zr = Math.hypot(fireLocal.x, fireLocal.z);
    const D = new THREE.Vector3(0, 0.62, 0.78).normalize();
    const pitch = -(Math.atan2(D.y, D.z) - Math.atan2(fireLocal.y, zr));
    const baseQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "XYZ"));

    // Fire frame: local XY = surface tangent plane, +Z = surface normal.
    const frame = new THREE.Group();
    frame.position.copy(fireLocal).multiplyScalar(1.002);
    frame.quaternion.copy(tangentQuaternion(fireLocal));
    world.add(frame);
    const haloTex = keep(
      glowTexture([
        [0, "rgba(255,190,110,0.9)"],
        [0.3, "rgba(255,105,59,0.45)"],
        [1, "rgba(240,68,56,0)"],
      ]),
    );
    const halo = new THREE.Sprite(
      keep(
        new THREE.SpriteMaterial({
          map: haloTex,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    halo.position.set(0, 0, 0.03);
    frame.add(halo);
    const scan = [surfaceRing(0xff963d, 0.88), surfaceRing(0x51d6f0, 0.93)];
    const waves = [0, 1, 2].map(() => surfaceRing(0xffc15a, 0.965));
    [...scan, ...waves].forEach(
      (r) => (frame.add(r), keep(r.geometry), keep(r.material as THREE.Material)),
    );
    const lineMat = (color: number) =>
      keep(
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
      );
    const square = (cx: number, cy: number, s: number) => [
      cx - s / 2,
      cy - s / 2,
      cx + s / 2,
      cy - s / 2,
      cx + s / 2,
      cy - s / 2,
      cx + s / 2,
      cy + s / 2,
      cx + s / 2,
      cy + s / 2,
      cx - s / 2,
      cy + s / 2,
      cx - s / 2,
      cy + s / 2,
      cx - s / 2,
      cy - s / 2,
    ];
    const segs = (arr: number[]) =>
      keep(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            arr.flatMap((v, i) => (i % 2 ? [v, 0.004] : [v])),
            3,
          ),
        ),
      );
    const modisFoot = new THREE.LineSegments(segs(square(0, 0, 0.22)), lineMat(0xffc15a));
    const viirsCells: number[] = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) viirsCells.push(...square(i * 0.0825, j * 0.0825, 0.077));
    const viirsFoot = new THREE.LineSegments(segs(viirsCells), lineMat(0x51d6f0));
    const hex = new THREE.LineLoop(
      keep(
        new THREE.BufferGeometry().setFromPoints(
          Array.from(
            { length: 6 },
            (_, i) =>
              new THREE.Vector3(
                Math.cos((i * Math.PI) / 3 + Math.PI / 6) * 0.15,
                Math.sin((i * Math.PI) / 3 + Math.PI / 6) * 0.15,
                0.006,
              ),
          ),
        ),
      ),
      lineMat(0xffe0a3),
    );
    frame.add(modisFoot, viirsFoot, hex);

    // Embers rising from the event.
    const EMBERS = mobile ? 26 : 64;
    const embers = makePoints(EMBERS);
    keep(embers.geometry);
    keep(embers.material as THREE.Material);
    frame.add(embers);
    const life = Array.from({ length: EMBERS }, (_, i) => ({
      t: (i / EMBERS) * 2.6,
      dur: 1.6 + ((i * 37) % 13) / 10,
      x: (((i * 53) % 21) - 10) / 360,
      y: (((i * 29) % 17) - 8) / 360,
      drift: (((i * 71) % 9) - 4) / 260,
      size: 0.6 + ((i * 17) % 7) / 6,
    }));
    const warm = [
      new THREE.Color("#FFC15A"),
      new THREE.Color("#FF963D"),
      new THREE.Color("#FF693B"),
      new THREE.Color("#FFE0A3"),
    ];

    // Data particles: footprints → analytical convergence point.
    const NODE = new THREE.Vector3(0.24, 0.06, 0.4);
    const starts = [
      ...[
        [-0.11, -0.11],
        [0.11, -0.11],
        [0.11, 0.11],
        [-0.11, 0.11],
        [0, 0],
      ].map((p) => ({ p, sensor: 0 })),
      ...Array.from({ length: 9 }, (_, k) => ({
        p: [((k % 3) - 1) * 0.0825, (Math.floor(k / 3) - 1) * 0.0825],
        sensor: 1,
      })),
    ];
    const DATA = starts.length * 2;
    const data = makePoints(DATA);
    keep(data.geometry);
    keep(data.material as THREE.Material);
    frame.add(data);
    const nodeTex = keep(
      glowTexture([
        [0, "rgba(255,255,255,1)"],
        [0.3, "rgba(139,231,245,0.7)"],
        [1, "rgba(32,188,229,0)"],
      ]),
    );
    const node = new THREE.Sprite(
      keep(
        new THREE.SpriteMaterial({
          map: nodeTex,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        }),
      ),
    );
    node.position.copy(NODE);
    node.scale.setScalar(0.09);
    frame.add(node);

    // Satellites on inertial orbits that pass beside the event (not over it, so the flame stays clear).
    const sats = [
      {
        color: 0xffc15a,
        R: 1.24,
        c: new THREE.Vector3(-0.62, 0.34, 0).add(D).normalize(),
        dir: new THREE.Vector3(0.62, 0.62, -0.25),
        offset: 3.5,
      },
      {
        color: 0x51d6f0,
        R: 1.31,
        c: new THREE.Vector3(0.6, 0.24, 0).add(D).normalize(),
        dir: new THREE.Vector3(0.5, -0.7, -0.2),
        offset: 4.6,
      },
    ].map((s) => {
      const w = s.dir
        .clone()
        .sub(s.c.clone().multiplyScalar(s.dir.dot(s.c)))
        .normalize();
      const pts = Array.from({ length: 181 }, (_, i) => {
        const a = (i / 180) * Math.PI * 2;
        return s.c
          .clone()
          .multiplyScalar(Math.cos(a) * s.R)
          .add(w.clone().multiplyScalar(Math.sin(a) * s.R));
      });
      const orbit = new THREE.Line(
        keep(new THREE.BufferGeometry().setFromPoints(pts)),
        keep(
          new THREE.LineDashedMaterial({
            color: s.color,
            dashSize: 0.025,
            gapSize: 0.02,
            transparent: true,
            opacity: 0.45,
          }),
        ),
      );
      orbit.computeLineDistances();
      scene.add(orbit);
      const sat = new THREE.Group();
      const body = new THREE.Mesh(
        keep(new THREE.BoxGeometry(0.026, 0.016, 0.016)),
        keep(new THREE.MeshBasicMaterial({ color: 0xeaf3fa })),
      );
      const panelMat = keep(
        new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.9 }),
      );
      const panelGeo = keep(new THREE.BoxGeometry(0.044, 0.002, 0.016));
      const p1 = new THREE.Mesh(panelGeo, panelMat),
        p2 = new THREE.Mesh(panelGeo, panelMat);
      p1.position.x = 0.038;
      p2.position.x = -0.038;
      const glow = new THREE.Sprite(
        keep(
          new THREE.SpriteMaterial({
            map: nodeTex,
            color: s.color,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        ),
      );
      glow.scale.setScalar(0.07);
      sat.add(body, p1, p2, glow);
      scene.add(sat);
      const beamMat = keep(
        new THREE.ShaderMaterial({
          vertexShader: BEAM_VERTEX,
          fragmentShader: BEAM_FRAGMENT,
          uniforms: {
            uColor: { value: new THREE.Color(s.color) },
            uTime: { value: 0 },
            uOpacity: { value: 0 },
          },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      const beam = new THREE.Mesh(
        keep(new THREE.CylinderGeometry(0.003, 0.05, 1, 24, 1, true)),
        beamMat,
      );
      scene.add(beam);
      return { ...s, w, sat, beam, beamMat };
    });

    // Faint star dust behind the planet (desktop only).
    if (!mobile) {
      const stars = new THREE.Points(
        keep(
          new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
              Array.from({ length: 900 }, (_, i) => {
                const u = ((i * 0.618034) % 1) * 2 - 1,
                  th = i * 2.399963;
                const r = Math.sqrt(1 - u * u);
                return i % 3 === 0
                  ? Math.cos(th) * r * 40
                  : i % 3 === 1
                    ? u * 40
                    : Math.sin(th) * r * 40 - 10;
              }),
              3,
            ),
          ),
        ),
        keep(
          new THREE.PointsMaterial({
            color: 0xb7f0fa,
            size: 0.06,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        ),
      );
      scene.add(stars);
    }

    let w = 1,
      h = 1,
      labelW = [0, 0];
    const resize = () => {
      w = el.clientWidth || 1;
      h = el.clientHeight || 1;
      labelW = [0, 1].map((i) => labels.current[i]?.offsetWidth ?? 0);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const narrow = w < 700;
      camera.fov = narrow ? 40 : 32;
      camera.position.set(0, 0, narrow ? 3.25 : 3.05);
      camera.lookAt(0, narrow ? 0.5 : 0.6, 0);
      camera.updateProjectionMatrix();
      const scale = h * renderer.getPixelRatio() * 0.05;
      (embers.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
      (data.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(el);

    // Gentle drag to look around; springs back to the event-facing view.
    let drag: { x: number; y: number } | null = null;
    const look = { yaw: 0, pitch: 0 };
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      look.yaw = Math.max(-0.7, Math.min(0.7, look.yaw + (e.clientX - drag.x) * 0.004));
      look.pitch = Math.max(-0.3, Math.min(0.3, look.pitch + (e.clientY - drag.y) * 0.003));
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => (drag = null);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    const tmp = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0),
      qa = new THREE.Quaternion(),
      qb = new THREE.Quaternion();
    const project = (v: THREE.Vector3) => {
      tmp.copy(v).project(camera);
      return { x: ((tmp.x + 1) / 2) * w, y: ((1 - tmp.y) / 2) * h, z: tmp.z };
    };
    let clock = state.current.phase * PHASE + PHASE * 0.5,
      elapsed = 0,
      last = performance.now(),
      lastPhase = -1,
      raf = 0;
    const tick = (now = performance.now()) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible) return;
      const still = reducedRef.current;
      const { playing, phase } = state.current;
      if (playing && !still) clock = (clock + dt) % CYCLE;
      else clock = phase * PHASE + PHASE * 0.85;
      if (!still) elapsed += dt;
      const ph = Math.min(3, Math.floor(clock / PHASE)),
        p = (clock % PHASE) / PHASE;
      if (ph !== lastPhase) {
        lastPhase = ph;
        if (playing && !still) state.current.onPhase(ph);
      }
      // Planet sway (not a spin) keeps the event in view; drag offsets ease back to rest.
      if (!drag) {
        look.yaw *= Math.pow(0.04, dt);
        look.pitch *= Math.pow(0.04, dt);
      }
      const sway = still ? 0 : Math.sin(elapsed * ((2 * Math.PI) / 46)) * 0.16;
      qa.setFromAxisAngle(up, sway + look.yaw);
      qb.setFromAxisAngle(new THREE.Vector3(1, 0, 0), look.pitch);
      world.quaternion.copy(qb).multiply(qa).multiply(baseQ);
      clouds.rotation.y = elapsed * 0.006;

      // Surface effects around the event.
      const k = (elapsed % 2.4) / 2.4,
        k2 = ((elapsed + 1.2) % 2.4) / 2.4;
      scan[0].scale.setScalar(0.03 + k * 0.17);
      (scan[0].material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.85;
      scan[1].scale.setScalar(0.03 + k2 * 0.13);
      (scan[1].material as THREE.MeshBasicMaterial).opacity = (1 - k2) * 0.55;
      waves.forEach((r, i) => {
        const q = ((elapsed + i * 2) % 6) / 6;
        r.scale.setScalar(0.06 + q * 0.42);
        (r.material as THREE.MeshBasicMaterial).opacity = (1 - q) * 0.22 * (still ? 0.6 : 1);
      });
      halo.scale.setScalar((ph === 3 ? 0.42 : 0.34) + Math.sin(elapsed * 2.4) * 0.025);
      (halo.material as THREE.SpriteMaterial).opacity = 0.75 + Math.sin(elapsed * 1.7) * 0.15;

      // Story-driven elements.
      const footIn = ph === 1 ? smooth(0, 0.3, p) : ph === 2 ? 1 - smooth(0.2, 0.9, p) : 0;
      const footScale = ph === 2 ? 1 - smooth(0.2, 0.9, p) * 0.7 : 1;
      (modisFoot.material as THREE.LineBasicMaterial).opacity = footIn * 0.95;
      (viirsFoot.material as THREE.LineBasicMaterial).opacity =
        footIn * smooth(0.15, 0.5, ph === 1 ? p : 1) * 0.95;
      modisFoot.scale.setScalar(footScale);
      viirsFoot.scale.setScalar(footScale);
      const unify = ph === 3 ? smooth(0, 0.35, p) : 0;
      (hex.material as THREE.LineBasicMaterial).opacity = unify;
      hex.scale.setScalar(0.6 + unify * 0.4);
      (node.material as THREE.SpriteMaterial).opacity =
        ph === 2 ? smooth(0.3, 1, p) : ph === 3 ? 1 - smooth(0.5, 1, p) * 0.4 : 0;

      const ePos = embers.geometry.attributes.position as THREE.BufferAttribute,
        eA = embers.geometry.attributes.aAlpha as THREE.BufferAttribute,
        eS = embers.geometry.attributes.aSize as THREE.BufferAttribute,
        eC = embers.geometry.attributes.aColor as THREE.BufferAttribute;
      life.forEach((e, i) => {
        if (!still) e.t = (e.t + dt) % e.dur;
        const q = e.t / e.dur;
        ePos.setXYZ(
          i,
          e.x + e.drift * q + Math.sin((elapsed + i) * 3) * 0.004,
          e.y + e.drift * 0.4 * q,
          0.02 + q * (ph === 3 ? 0.42 : 0.32),
        );
        eA.setX(i, Math.sin(Math.PI * q) * 0.9);
        eS.setX(i, e.size * (1 - q * 0.5));
        const c = warm[i % 4];
        eC.setXYZ(i, c.r, c.g, c.b);
      });
      ePos.needsUpdate = eA.needsUpdate = eS.needsUpdate = eC.needsUpdate = true;

      const dPos = data.geometry.attributes.position as THREE.BufferAttribute,
        dA = data.geometry.attributes.aAlpha as THREE.BufferAttribute,
        dS = data.geometry.attributes.aSize as THREE.BufferAttribute,
        dC = data.geometry.attributes.aColor as THREE.BufferAttribute;
      for (let i = 0; i < DATA; i++) {
        const s = starts[i % starts.length],
          lag = (i / DATA) * 0.45 + (i >= starts.length ? 0.2 : 0);
        const q = ph === 2 ? smooth(lag, lag + 0.45, p) : ph === 3 ? 1 : 0;
        const x0 = s.p[0] * footScale,
          y0 = s.p[1] * footScale;
        // Quadratic arc from the footprint up to the convergence node.
        const mx = (x0 + NODE.x) / 2,
          my = (y0 + NODE.y) / 2,
          mz = NODE.z * 1.15;
        const a = 1 - q;
        dPos.setXYZ(
          i,
          a * a * x0 + 2 * a * q * mx + q * q * NODE.x,
          a * a * y0 + 2 * a * q * my + q * q * NODE.y,
          a * a * 0.01 + 2 * a * q * mz + q * q * NODE.z,
        );
        dA.setX(i, ph === 2 && q > 0 && q < 1 ? 0.95 : 0);
        dS.setX(i, 0.9);
        const col = s.sensor ? [0.32, 0.84, 0.94] : [1, 0.76, 0.35];
        dC.setXYZ(i, col[0], col[1], col[2]);
      }
      dPos.needsUpdate = dA.needsUpdate = dS.needsUpdate = dC.needsUpdate = true;

      const fireW = frame.getWorldPosition(new THREE.Vector3());
      sats.forEach((s, i) => {
        const ang = ((clock - s.offset) / CYCLE) * Math.PI * 2;
        const pos = s.c
          .clone()
          .multiplyScalar(Math.cos(ang) * s.R)
          .add(s.w.clone().multiplyScalar(Math.sin(ang) * s.R));
        s.sat.position.copy(pos);
        s.sat.lookAt(0, 0, 0);
        const elev = pos.clone().normalize().dot(fireW.clone().normalize());
        const beamOn = smooth(0.72, 0.9, elev) * (ph === 0 ? 1 : ph === 1 ? 0.75 : 0.35);
        s.beamMat.uniforms.uOpacity.value = beamOn * 0.8;
        s.beamMat.uniforms.uTime.value = elapsed;
        const dir = pos.clone().sub(fireW);
        s.beam.visible = beamOn > 0.01;
        s.beam.position.copy(fireW).add(dir.clone().multiplyScalar(0.5));
        s.beam.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        s.beam.scale.set(1, dir.length(), 1);
        const lab = labels.current[i];
        if (lab) {
          const pr = project(pos);
          const front = pos.z > -0.2 || pos.y > 0.9;
          // Keep satellite labels inside the stage (14px left margin + label width).
          const lx = Math.max(-6, Math.min(pr.x, w - labelW[i] - 22));
          lab.style.transform = `translate(${lx}px, ${Math.max(44, pr.y)}px)`;
          lab.style.opacity = front && pr.z < 1 ? String(0.35 + beamOn * 0.65) : "0";
        }
      });

      renderer.render(scene, camera);
      const fp = project(fireW);
      if (flameRef.current) flameRef.current.style.transform = `translate(${fp.x}px, ${fp.y}px)`;
      const fireLab = labels.current[2];
      if (fireLab) fireLab.style.transform = `translate(${fp.x}px, ${fp.y}px)`;
      const nodeLab = labels.current[3];
      if (nodeLab) {
        const np = project(node.getWorldPosition(new THREE.Vector3()));
        nodeLab.style.transform = `translate(${np.x}px, ${np.y}px)`;
        nodeLab.style.opacity = String(ph === 3 ? smooth(0.1, 0.4, p) : 0);
      }
    };
    tick();
    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__emberLanding = () => {
        const f = frame.getWorldPosition(new THREE.Vector3());
        const r = canvas.getBoundingClientRect();
        const pr = project(f);
        return {
          fire: { x: pr.x + r.left, y: pr.y + r.top },
          quaternion: world.quaternion.toArray(),
          clock,
          sats: sats.map((s) => s.sat.position.toArray()),
        };
      };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  const src = sources(EVENT);
  return (
    <div className={`living-earth ${failed ? "is-fallback" : ""}`} ref={host}>
      {failed && <div className="living-fallback" aria-hidden="true" />}
      <div className="living-overlay" aria-hidden="true">
        <div
          className="sat-label modis"
          ref={(e) => {
            labels.current[0] = e;
          }}
        >
          <i />
          MODIS<span>Terra · Aqua · ≈1 km</span>
        </div>
        <div
          className="sat-label viirs"
          ref={(e) => {
            labels.current[1] = e;
          }}
        >
          <i />
          VIIRS<span>S-NPP · NOAA-20/21 · ≈375 m</span>
        </div>
        <div className="landing-flame" ref={flameRef}>
          {/* Base of the flame (y = 86/90 of its viewBox) sits on the projected surface point. */}
          <span
            className={`landing-flame-inner ${phase === 3 ? "surge" : ""}`}
            style={{ left: -(small ? 58 : 84) / 2, top: -(small ? 58 : 84) * 1.4 * 0.955 }}
          >
            <Flame size={small ? 58 : 84} intensity="high" particles />
          </span>
        </div>
        <div
          className="event-label"
          ref={(e) => {
            labels.current[2] = e;
          }}
        >
          <strong>Thermal anomaly</strong>
          <span>
            {EVENT.date} · {EVENT.frp.toFixed(1)} MW max FRP
          </span>
          <span>
            {EVENT.modis} MODIS + {EVENT.viirs} VIIRS · PyroSync Gold
          </span>
        </div>
        <div
          className="node-label"
          ref={(e) => {
            labels.current[3] = e;
          }}
        >
          <strong>Unified analytical event</strong>
          <span>1 record · {src.length} sources retained</span>
        </div>
      </div>
    </div>
  );
}

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reveal = () => {
      setSeen(true);
      io.disconnect();
      window.removeEventListener("scroll", check);
    };
    const io = new IntersectionObserver(([e]) => e.isIntersecting && reveal(), { threshold: 0.15 });
    // Jumps (anchor links, reduced-motion scrolling) can skip an element without an intersection event.
    const check = () => el.getBoundingClientRect().top < window.innerHeight * 0.9 && reveal();
    io.observe(el);
    window.addEventListener("scroll", check, { passive: true });
    check();
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", check);
    };
  }, []);
  return [ref, seen] as const;
}
function Reveal({
  children,
  className = "",
  id,
  label,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  label?: string;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <section
      ref={ref}
      id={id}
      aria-label={label}
      className={`reveal ${seen ? "in-view" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

/** Section A — split-view resolution comparison of the same three small thermal sources. */
function SensorCompare() {
  const [split, setSplit] = useState(52);
  const [unified, setUnified] = useState(false);
  const AREA = 3000;
  const fires = [
    { x: 1180, y: 1380, r: 110 },
    { x: 1560, y: 1520, r: 80 },
    { x: 1330, y: 1720, r: 95 },
  ];
  const hits = (px: number, n: number) => {
    const set = new Set<number>();
    fires.forEach((f) => coverage(f.x, f.y, f.r, px, n).forEach((c, i) => c > 0 && set.add(i)));
    return [...set];
  };
  const modis = hits(1000, 3),
    viirs = hits(375, 8);
  const cut = (split / 100) * AREA;
  return (
    <div className="sensor-compare">
      <svg
        viewBox={`0 0 ${AREA} ${AREA}`}
        role="img"
        aria-label={`Same three thermal sources: MODIS view on the left touches ${modis.length} pixel, VIIRS view on the right touches ${viirs.length} pixels.`}
      >
        <defs>
          <clipPath id="cmp-left">
            <rect width={cut} height={AREA} />
          </clipPath>
          <clipPath id="cmp-right">
            <rect x={cut} width={AREA - cut} height={AREA} />
          </clipPath>
          <radialGradient id="cmp-fire">
            <stop offset="0" stopColor="#FFE0A3" />
            <stop offset=".45" stopColor="#FF693B" />
            <stop offset="1" stopColor="#F04438" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={AREA} height={AREA} className="cmp-terrain" />
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <path
            key={k}
            d={`M0 ${380 + k * 470} C900 ${200 + k * 460} 1900 ${720 + k * 440} 3000 ${360 + k * 500}`}
            className="cmp-contour"
          />
        ))}
        <g clipPath="url(#cmp-left)">
          {modis.map((i) => (
            <rect
              key={i}
              x={(i % 3) * 1000}
              y={Math.floor(i / 3) * 1000}
              width="1000"
              height="1000"
              className="hit modis"
            />
          ))}
          {[0, 1, 2, 3].map((k) => (
            <g key={k} className="grid modis">
              <line x1={k * 1000} x2={k * 1000} y1="0" y2={AREA} />
              <line y1={k * 1000} y2={k * 1000} x1="0" x2={AREA} />
            </g>
          ))}
        </g>
        <g clipPath="url(#cmp-right)">
          {viirs.map((i) => (
            <rect
              key={i}
              x={(i % 8) * 375}
              y={Math.floor(i / 8) * 375}
              width="375"
              height="375"
              className="hit viirs"
            />
          ))}
          {Array.from({ length: 9 }, (_, k) => (
            <g key={k} className="grid viirs">
              <line x1={k * 375} x2={k * 375} y1="0" y2={AREA} />
              <line y1={k * 375} y2={k * 375} x1="0" x2={AREA} />
            </g>
          ))}
        </g>
        {fires.map((f, i) => (
          <circle key={i} cx={f.x} cy={f.y} r={f.r * 2.2} fill="url(#cmp-fire)" />
        ))}
        {unified && (
          <g className="cmp-unified">
            <polygon
              points={Array.from(
                { length: 6 },
                (_, i) =>
                  `${1500 + Math.cos((i * Math.PI) / 3 + Math.PI / 6) * 640},${1500 + Math.sin((i * Math.PI) / 3 + Math.PI / 6) * 640}`,
              ).join(" ")}
            />
            <text x="1500" y="2330" textAnchor="middle">
              1 harmonized cell/day record
            </text>
          </g>
        )}
        <line x1={cut} x2={cut} y1="0" y2={AREA} className="cmp-divider" />
        <text x={cut - 60} y="160" textAnchor="end" className="cmp-tag modis">
          MODIS ≈1 km
        </text>
        <text x={cut + 60} y="160" className="cmp-tag viirs">
          VIIRS ≈375 m
        </text>
      </svg>
      <label className="cmp-slider">
        <span>Drag to compare resolutions</span>
        <input
          type="range"
          min={8}
          max={92}
          value={split}
          onChange={(e) => setSplit(Number(e.target.value))}
          aria-label="Comparison divider position"
        />
      </label>
      <div className="cmp-readout">
        <span className="sensor-pill modis">
          <i />
          MODIS <strong>{modis.length}</strong> pixel{modis.length === 1 ? "" : "s"}
        </span>
        <span className="sensor-pill viirs">
          <i />
          VIIRS <strong>{viirs.length}</strong> pixels
        </span>
        <Button
          variant={unified ? "secondary" : "primary"}
          icon="layers"
          onClick={() => setUnified(!unified)}
          aria-pressed={unified}
        >
          {unified ? "Show raw detections" : "Harmonize"}
        </Button>
      </div>
      <p className="cmp-note">
        Illustrative geometry: the same three small thermal sources, seen through each sensor's
        pixel grid. Harmonization groups detections by ≈1 km cell and UTC day while keeping every
        source.
      </p>
    </div>
  );
}

/** Section B — animated preview of the thermal history matrix from the synthetic Amazon record. */
function MatrixPreview({ active }: { active: boolean }) {
  const { grid, max, peak } = useMemo(() => {
    const years = Array.from({ length: 14 }, (_, i) => 2012 + i);
    const grid = years.map((y) =>
      MONTHS.map(
        (_, m) =>
          ALL_RECORDS.filter(
            (r) =>
              r.region === "amazon" && r.date.startsWith(`${y}-${String(m + 1).padStart(2, "0")}`),
          ).length,
      ),
    );
    const max = Math.max(...grid.flat());
    let peak = { y: 2012, m: 0, v: 0 };
    grid.forEach((row, i) => row.forEach((v, m) => v > peak.v && (peak = { y: years[i], m, v })));
    return { grid: grid.map((row, i) => ({ y: years[i], row })), max, peak };
  }, []);
  return (
    <div className={`matrix-preview ${active ? "playing" : ""}`}>
      <div
        className="mp-grid"
        role="img"
        aria-label={`Monthly analytical records for the Amazon Basin, 2012–2025. Peak: ${MONTHS[peak.m]} ${peak.y} with ${peak.v} records. Synthetic data.`}
      >
        <div className="mp-row mp-axis">
          <span />
          {MONTHS.map((m) => (
            <span key={m}>{m[0]}</span>
          ))}
        </div>
        {grid.map(({ y, row }, i) => (
          <div className="mp-row" key={y}>
            <span>{y}</span>
            {row.map((v, m) => (
              <i
                key={m}
                style={{
                  backgroundColor: SEQ[Math.min(9, Math.floor((v / max) * 10))],
                  animationDelay: `${i * 70 + m * 18}ms`,
                }}
                className={y === peak.y && m === peak.m ? "peak" : ""}
              />
            ))}
          </div>
        ))}
        <span className="mp-scan" aria-hidden="true" />
      </div>
      <div className="mp-legend">
        <span>Low</span>
        {SEQ.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
        <span>High</span>
      </div>
      <p className="mp-insight">
        <Flame size={14} animated={false} />
        Peak in this preview:{" "}
        <strong>
          {MONTHS[peak.m]} {peak.y}
        </strong>{" "}
        · {fmt(peak.v)} analytical records (PyroSync Gold).
      </p>
    </div>
  );
}

function PipelineArt({ kind }: { kind: number }) {
  if (kind === 0)
    return (
      <svg viewBox="0 0 160 110" aria-hidden="true">
        <ellipse cx="80" cy="96" rx="64" ry="12" className="pa-ground" />
        <path d="M18 34 C 60 6, 100 6, 142 34" className="pa-orbit gold" />
        <path d="M10 52 C 56 20, 104 20, 150 52" className="pa-orbit cyan" />
        <circle cx="44" cy="20" r="5" className="pa-sat gold" />
        <circle cx="122" cy="34" r="5" className="pa-sat cyan" />
        <path d="M44 24 L76 92 L86 92 Z" className="pa-beam gold" />
        <path d="M122 38 L78 92 L90 92 Z" className="pa-beam cyan" />
        <circle cx="82" cy="92" r="4" className="pa-fire" />
      </svg>
    );
  if (kind === 1)
    return (
      <svg viewBox="0 0 160 110" aria-hidden="true">
        <rect x="40" y="20" width="72" height="72" rx="6" className="pa-cell gold" />
        {Array.from({ length: 9 }, (_, i) => (
          <rect
            key={i}
            x={48 + (i % 3) * 20}
            y={28 + Math.floor(i / 3) * 20}
            width="16"
            height="16"
            rx="3"
            className="pa-cell cyan"
          />
        ))}
        {[
          [60, 44],
          [84, 52],
          [70, 70],
          [92, 74],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3.4" className={`pa-dot ${i % 2 ? "cyan" : "gold"}`} />
        ))}
        <path d="M120 56 h22" className="pa-arrow" />
        <polygon points="150,56 142,51 142,61" className="pa-arrowhead" />
      </svg>
    );
  return (
    <svg viewBox="0 0 160 110" aria-hidden="true">
      <path d="M16 90 L16 18 M16 90 L150 90" className="pa-axis" />
      <path d="M20 80 C 40 78, 50 60, 66 62 S 92 30, 108 34 S 132 70, 148 66" className="pa-line" />
      {[26, 38, 50, 62, 74, 86, 98, 110, 122, 134].map((x, i) => (
        <rect
          key={x}
          x={x}
          y={90 - [8, 12, 20, 18, 30, 44, 52, 38, 22, 14][i]}
          width="8"
          height={[8, 12, 20, 18, 30, 44, 52, 38, 22, 14][i]}
          rx="2"
          className="pa-bar"
          style={{ opacity: 0.35 + i * 0.05 }}
        />
      ))}
      <circle cx="108" cy="34" r="5" className="pa-fire" />
    </svg>
  );
}

export default function Landing({ onLaunch }: { onLaunch: (target?: Target) => void }) {
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [menu, setMenu] = useState(false);
  const reduced = useReducedMotion();
  const [timeRef, timeSeen] = useInView<HTMLDivElement>();
  useEffect(() => {
    if (reduced) {
      setPlaying(false);
      setPhase(3);
    }
  }, [reduced]);
  const scrollTo = (id: string) => {
    setMenu(false);
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };
  return (
    <div className="landing">
      <a className="skip-link" href="#landing-main">
        Skip to content
      </a>
      <header className="landing-header">
        <Logo />
        <nav aria-label="Platform" className={menu ? "open" : ""}>
          <button onClick={() => scrollTo("sensors")}>Product</button>
          <button onClick={() => scrollTo("pipeline")}>About the Platform</button>
          <button onClick={() => onLaunch("Methodology")}>Scientific Methodology</button>
        </nav>
        <div className="landing-header-actions">
          <Button
            variant="primary"
            icon="arrow"
            onClick={() => onLaunch()}
            aria-label="Launch Platform"
          >
            Launch<span className="hide-sm">Platform</span>
          </Button>
          <button
            className="landing-menu icon-button"
            aria-label={menu ? "Close menu" : "Open menu"}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? "close" : "menu"} />
          </button>
        </div>
      </header>
      <main id="landing-main" tabIndex={-1}>
        <section className="hero" aria-label="Introduction">
          <div className="hero-copy">
            <div className="hero-eyebrow">
              <span className="live-dot orange" />
              EARTH OBSERVATION · FIRE INTELLIGENCE
            </div>
            <h1>See Beyond the Hotspot.</h1>
            <p className="hero-sub">One Earth. Two Satellites. A Unified View of Fire.</p>
            <p className="hero-desc">
              Explore a harmonized view of global fire activity by bringing MODIS and VIIRS
              observations together into a consistent, spatially aware intelligence experience.
            </p>
            <div className="hero-ctas">
              <Button variant="primary" icon="globe" onClick={() => onLaunch()}>
                Explore Fire Intelligence
              </Button>
              <Button icon="down" onClick={() => scrollTo("sensors")}>
                Discover How It Works
              </Button>
            </div>
          </div>
          <div className="hero-stage">
            <LivingEarth phase={phase} playing={playing} onPhase={setPhase} />
          </div>
          <div className="story" role="group" aria-label="How harmonization works">
            <ol>
              {STORY.map((s, i) => (
                <li key={s.key}>
                  <button
                    aria-pressed={phase === i}
                    onClick={() => {
                      setPhase(i);
                      setPlaying(false);
                    }}
                    className={phase === i ? "active" : ""}
                  >
                    <span className="story-num">0{i + 1}</span>
                    <span className="story-copy">
                      <strong>{s.key}</strong>
                      <small>{s.text}</small>
                    </span>
                    {phase === i && playing && (
                      <span className="story-progress" style={{ animationDuration: `${PHASE}s` }} />
                    )}
                  </button>
                </li>
              ))}
            </ol>
            <button
              className="story-play icon-button"
              onClick={() => setPlaying(!playing)}
              aria-label={
                playing ? "Pause the harmonization story" : "Play the harmonization story"
              }
              disabled={reduced}
            >
              <Icon name={playing ? "pause" : "play"} />
            </button>
          </div>
          <p className="hero-note">
            Built from PyroSync Gold NASA MODIS & VIIRS detections (2003–2025). Footprints and orbits are
            enlarged for clarity. Independent prototype — not affiliated with NASA.
          </p>
        </section>

        <Reveal
          id="sensors"
          className="landing-section sensors"
          label="Two sensors, one unified view"
        >
          <div className="section-copy">
            <span className="section-kicker">A · TWO SENSORS. ONE UNIFIED VIEW.</span>
            <h2>Different eyes on the same fire.</h2>
            <p>
              MODIS offers a long record from 2000 with ≈1 km pixels. VIIRS, from 2012, resolves
              smaller thermal features at ≈375 m. Their counts are not interchangeable — so
              PYROSYNC aligns them on a shared cell/day grid without discarding the originals.
            </p>
            <div className="sensor-cards">
              <div className="sensor-card modis">
                <span className="sensor-pill modis">
                  <i />
                  MODIS
                </span>
                <strong>≈1 km</strong>
                <small>Terra & Aqua · 2000 onward · broad, long record</small>
              </div>
              <div className="sensor-card viirs">
                <span className="sensor-pill viirs">
                  <i />
                  VIIRS
                </span>
                <strong>≈375 m</strong>
                <small>S-NPP, NOAA-20/21 · 2012 onward · finer detail</small>
              </div>
            </div>
          </div>
          <SensorCompare />
        </Reveal>

        <Reveal className="landing-section time" label="Explore fire through time">
          <div ref={timeRef} className="time-inner">
            <MatrixPreview active={timeSeen} />
            <div className="section-copy">
              <span className="section-kicker">B · EXPLORE FIRE THROUGH TIME.</span>
              <h2>Twenty-six years, read like a thermal signature.</h2>
              <p>
                The Thermal History Matrix turns every month or ISO week into a cell. Spot seasonal
                rhythms, compare years, and click any period to filter the globe — with unavailable
                coverage shown honestly, never as zero.
              </p>
              <Button icon="calendar" onClick={() => onLaunch("Activity Calendar")}>
                Open the Thermal History Matrix
              </Button>
            </div>
          </div>
        </Reveal>

        <Reveal
          id="pipeline"
          className="landing-section pipeline"
          label="From detection to intelligence"
        >
          <span className="section-kicker center">C · FROM DETECTION TO INTELLIGENCE.</span>
          <h2 className="center">Observe. Harmonize. Understand.</h2>
          <ol className="pipeline-steps">
            {[
              [
                "Observe",
                "Two satellite systems detect thermal anomalies at different resolutions and overpass times.",
              ],
              [
                "Harmonize",
                "Detections sharing a ≈1 km cell and UTC day become one analytical record, with max FRP and every source ID retained.",
              ],
              [
                "Understand",
                "Explore patterns, anomalies, and seasonal windows — clearly separated from forecasts and confirmed fire types.",
              ],
            ].map(([t, d], i) => (
              <li key={t} style={{ transitionDelay: `${i * 140}ms` }}>
                <PipelineArt kind={i} />
                <span className="step-index">0{i + 1}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
        </Reveal>

        <section className="final-cta" aria-label="Launch PYROSYNC">
          <Flame size={46} intensity="high" particles />
          <h2>Explore the Earth's Fire Patterns</h2>
          <p>
            Harmonized MODIS and VIIRS intelligence — transparent, traceable, and ready to explore.
          </p>
          <Button variant="primary" icon="arrow" onClick={() => onLaunch()}>
            Launch PYROSYNC
          </Button>
        </section>
      </main>
      <footer className="landing-footer">
        <div className="footer-brand">
          <Logo />
          <p>
            PyroSync — NASA Space Apps Challenge 2026 (MODIS & VIIRS Harmonization).
          </p>
        </div>
        <details className="brand-showcase">
          <summary>The PYROSYNC identity</summary>
          <div className="brand-variants">
            <div>
              <Logo />
              <span>Primary horizontal</span>
            </div>
            <div>
              <Logo compact />
              <span>Icon-only</span>
            </div>
            <div>
              <Logo monochrome />
              <span>Monochrome</span>
            </div>
            <div className="light-logo">
              <Logo light />
              <span>Light background</span>
            </div>
            <div className="flame-variant">
              <Flame size={36} particles />
              <span>Signature thermal flame</span>
            </div>
          </div>
        </details>
        <Badge tone="thermal">PyroSync Gold · 2003–2025 Archive</Badge>
      </footer>
    </div>
  );
}
