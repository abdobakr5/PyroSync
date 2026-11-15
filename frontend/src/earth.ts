import * as THREE from "three";

/** Shared Earth geometry, shaders, and thermal helpers used by the dashboard globe and the landing scene. */
export const toVec = (lat: number, lon: number, r = 1) => {
  const phi = ((90 - lat) * Math.PI) / 180,
    th = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(th),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(th),
  );
};

export const ATMOS_VERTEX = `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`;
export const HALO_FRAGMENT = `varying vec3 vN; varying vec3 vP; void main(){ float i=pow(max(0.0,0.66-dot(vN,vec3(0.0,0.0,1.0))),2.6); gl_FragColor=vec4(0.32,0.84,0.95,1.0)*i*1.5; }`;
export const RIM_FRAGMENT = `varying vec3 vN; varying vec3 vP; void main(){ float r=pow(1.0-max(dot(vN,normalize(-vP)),0.0),3.2); gl_FragColor=vec4(0.45,0.88,1.0,r*0.6); }`;

/** Rotation that maps a flat XY-plane object (facing +Z) onto the surface tangent plane at `normal`. */
export const tangentQuaternion = (normal: THREE.Vector3) =>
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());

/** Soft radial sprite texture for halos and particles. */
export function glowTexture(stops: [number, string][]) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Thermal ring on the surface tangent plane; scale/opacity are animated by the caller. */
export function surfaceRing(color: number, inner = 0.86) {
  return new THREE.Mesh(
    new THREE.RingGeometry(inner, 1, 72),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}

export type FlameTier = "low" | "moderate" | "high";
/**
 * Visual intensity tier from maximum FRP (MW). Thresholds match the inferred-pattern rules (30 / 110 MW).
 * This is a normalized display encoding, not a physical simulation of fire size.
 */
export const flameTier = (frp: number): FlameTier =>
  frp > 110 ? "high" : frp >= 30 ? "moderate" : "low";
export const FLAME_SIZE: Record<FlameTier, number> = { low: 28, moderate: 36, high: 46 };

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
