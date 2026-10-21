import * as THREE from 'three'
import type { VehicleId, QualityTier } from '../types'

export type { VehicleId, QualityTier }

// Procedural launch-vehicle kit. Four original designs built entirely from
// code: lathe profiles for bodies, domes, ogives and bells; extruded, bevelled
// shapes for fins; instanced rivets. No image files.
//
// Look: a small shader patch adds panel seams, mottling and exhaust soot per
// pixel (no textures), PBR materials pick up the scene environment map, and
// every static part is merged into one mesh per material.
//
// Performance: three quality tiers. 'low' is meant for integrated GPUs.
// Typical cost per vehicle (see the render report): well under 40 draw calls
// and under ~30k triangles even on 'high'.
//
// Contract with the scene: the group origin is the base of the engine skirt,
// the rocket is built upright along +Y, and `nozzleGroup` is pivoted at the
// engine mount so rotating it about Z gimbals the main engine(s).

export interface VehicleInfo {
  id: VehicleId
  name: string
  role: string
  blurb: string
}

export const VEHICLES: VehicleInfo[] = [
  { id: 'strap', name: 'K-1 Strap', role: 'Strap-on heavy lifter', blurb: 'Stout grey core, twin strap-on boosters, bulbous payload fairing.' },
  { id: 'reuse', name: 'K-2 Reuse', role: 'Reusable single stack', blurb: 'Slender white stack, tail control fins, stowed landing struts.' },
  { id: 'tower', name: 'K-3 Tower', role: 'Tall tank with side boosters', blurb: 'Wide graphite tank, white bands, twin cream boosters.' },
  { id: 'steel', name: 'K-4 Steel', role: 'Bare-metal two-stage', blurb: 'Polished steel skin, weld rings, sharp conical nose.' },
]

export const DEFAULT_VEHICLE: VehicleId = 'reuse'

// Realistic heights in metres for each vehicle, used to scale the procedural
// models to true-scale relative to the 6 371 km planet globe.
// At ALTITUDE_SCALE 0.05, 1 scene unit = 20 m.
const REALISTIC_HEIGHT_M: Record<VehicleId, number> = {
  strap: 50,   // compact strap-on heavy lifter (≈GSLV class)
  reuse: 70,   // reusable single-stack (≈Falcon 9 class)
  tower: 98,   // tall with side boosters (≈SLS class)
  steel: 120,  // bare-metal super-heavy (≈Starship class)
}
const HEIGHT_TO_SCENE = 0.05 // same as ALTITUDE_SCALE: metres → scene units

export interface VehicleModel {
  rocket: THREE.Group
  nozzleGroup: THREE.Group
  height: number
  dispose: () => void
}

// ═══════════════════════════ quality tiers ═══════════════════════════

interface TierCfg {
  radial: number            // segments around every lathe body
  physical: boolean         // clearcoat on painted surfaces
  detail: 0 | 1 | 2         // 0 seams, 1 + soot, 2 + mottling
  rivets: boolean
  bevel: boolean
}

const TIERS: Record<QualityTier, TierCfg> = {
  low:    { radial: 24, physical: false, detail: 0, rivets: false, bevel: false },
  medium: { radial: 40, physical: false, detail: 1, rivets: false, bevel: true },
  high:   { radial: 72, physical: true,  detail: 2, rivets: true,  bevel: true },
}

// ═══════════════════════════ materials ═══════════════════════════

type Kind = 'white' | 'grey' | 'graphite' | 'cream' | 'stainless' | 'dark' | 'engine' | 'accent' | 'nozzle'

interface MatSpec {
  color: number
  rough: number
  metal: number
  coat: number
  seams: number
  mottle: number
  double?: boolean
}

const SPECS: Record<Kind, MatSpec> = {
  white:     { color: 0xe9ebee, rough: 0.36, metal: 0.04, coat: 0.55, seams: 0.40, mottle: 0.06 },
  grey:      { color: 0x9ba1a9, rough: 0.44, metal: 0.10, coat: 0.35, seams: 0.45, mottle: 0.08 },
  graphite:  { color: 0x3b3e46, rough: 0.50, metal: 0.15, coat: 0.30, seams: 0.55, mottle: 0.10 },
  cream:     { color: 0xe7ddc4, rough: 0.50, metal: 0.04, coat: 0.30, seams: 0.40, mottle: 0.10 },
  stainless: { color: 0xc6cbd1, rough: 0.26, metal: 0.92, coat: 0.00, seams: 0.70, mottle: 0.12 },
  dark:      { color: 0x17181b, rough: 0.78, metal: 0.30, coat: 0.00, seams: 0.20, mottle: 0.05, double: true },
  engine:    { color: 0x26272c, rough: 0.46, metal: 0.85, coat: 0.00, seams: 0.00, mottle: 0.00 },
  accent:    { color: 0x2f6fdc, rough: 0.40, metal: 0.05, coat: 0.40, seams: 0.00, mottle: 0.00 },
  nozzle:    { color: 0x53483e, rough: 0.38, metal: 0.92, coat: 0.00, seams: 0.00, mottle: 0.04, double: true },
}

const NOISE_GLSL = /* glsl */ `
float rkHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float rkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rkHash(i), rkHash(i + vec2(1.0, 0.0)), f.x),
             mix(rkHash(i + vec2(0.0, 1.0)), rkHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`

function patchMaterial(mat: THREE.Material, detail: number, det: [number, number, number, number]): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDet = { value: new THREE.Vector4(det[0], det[1], det[2], det[3]) }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aPan;\nvarying vec3 vPan;\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPan = aPan;\nvObj = position;')
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n#define RK_DETAIL ${detail}\nuniform vec4 uDet;\nvarying vec3 vPan;\nvarying vec3 vObj;\nfloat gSeam = 0.0;\nfloat gSoot = 0.0;\n${NOISE_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          float flag = vPan.z;
          vec2 g = vPan.xy;
          float row = floor(g.y);
          float cx = g.x + 0.5 * mod(row, 2.0);
          float dR = abs(fract(g.y + 0.5) - 0.5);
          float dC = abs(fract(cx + 0.5) - 0.5);
          float fwR = max(fwidth(g.y), 1e-4);
          float fwC = max(fwidth(cx), 1e-4);
          float lineR = 1.0 - smoothstep(0.0, 1.5 * fwR + 0.010, dR);
          float lineC = (1.0 - smoothstep(0.0, 1.5 * fwC + 0.007, dC)) * 0.7;
          gSeam = max(lineR, lineC) * flag * uDet.x;
          diffuseColor.rgb *= 1.0 - 0.5 * gSeam;
          #if RK_DETAIL >= 1
          float streak = rkNoise(vec2(vPan.x * 3.0, vObj.y * 0.35));
          gSoot = clamp(uDet.y * smoothstep(uDet.w, 0.0, vObj.y) * (0.5 + 0.9 * streak), 0.0, 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.025, 0.02), gSoot);
          #endif
          #if RK_DETAIL >= 2
          diffuseColor.rgb *= 1.0 + uDet.z * (rkNoise(vec2(vPan.x * 0.5, vObj.y * 0.8)) - 0.5);
          #endif
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + 0.25 * gSeam + 0.4 * gSoot, 0.0, 1.0);'
      )
  }
  mat.customProgramCacheKey = () => `rk-d${detail}`
}

// ═══════════════════════════ geometry helpers ═══════════════════════════

type Profile = Array<[number, number]>   // [radius, height], height increasing

function frustum(r0: number, r1: number, h: number, c = 0.012): Profile {
  return [[Math.max(r0 - c, 0.001), 0], [r0, c], [r1, h - c], [Math.max(r1 - c, 0.001), h]]
}

function ogive(R: number, L: number, kind: 'tangent' | 'min' | 'cone', n = 14): Profile {
  const pts: Profile = []
  const rho = (R * R + L * L) / (2 * R)
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * L
    let r: number
    if (kind === 'tangent') r = Math.sqrt(Math.max(rho * rho - y * y, 0)) + R - rho
    else if (kind === 'cone') r = R * (1 - y / L)
    else {
      const x = L - y
      const th = Math.acos(Math.min(Math.max(1 - (2 * x) / L, -1), 1))
      r = (R / Math.sqrt(Math.PI)) * Math.sqrt(Math.max(th - Math.sin(2 * th) / 2, 0))
    }
    pts.push([Math.max(r, 0.004), y])
  }
  return pts
}

function dome(R: number, h: number, n = 8): Profile {
  const pts: Profile = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * (Math.PI / 2)
    pts.push([Math.max(R * Math.cos(a), 0.004), h * Math.sin(a)])
  }
  return pts
}

function bell(rThroat: number, rExit: number, len: number, n = 12): Profile {
  const pts: Profile = []
  for (let i = 0; i <= n; i++) {
    const t = i / n                                   // 0 = exit, 1 = throat
    const r = rThroat + (rExit - rThroat) * Math.pow(1 - t, 1.8)
    pts.push([r, -len * (1 - t)])
  }
  return pts
}

function addPan(g: THREE.BufferGeometry, lathe: { nPts: number; segs: number; cols: number; rowH: number } | null): void {
  const pos = g.getAttribute('position')
  const a = new Float32Array(pos.count * 3)
  if (lathe) {
    for (let i = 0; i < pos.count; i++) {
      const col = Math.floor(i / lathe.nPts)            // LatheGeometry vertex layout: column-major
      a[i * 3] = (col / lathe.segs) * lathe.cols
      a[i * 3 + 1] = pos.getY(i) / lathe.rowH
      a[i * 3 + 2] = 1
    }
  }
  g.setAttribute('aPan', new THREE.BufferAttribute(a, 3))
}

function latheGeo(profile: Profile, segs: number, panelW = 0.46, panelH = 0.5): { geo: THREE.BufferGeometry; rowH: number; rows: number; cols: number; rMax: number } {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segs)
  let rMax = 0
  for (const [r] of profile) rMax = Math.max(rMax, r)
  const h = profile[profile.length - 1][1] - profile[0][1]
  const rows = Math.max(1, Math.round(h / panelH))
  const rowH = h / rows
  const cols = Math.max(6, Math.round((Math.PI * 2 * rMax) / panelW))
  addPan(g, { nPts: profile.length, segs, cols, rowH })
  return { geo: g, rowH, rows, cols, rMax }
}

function finGeo(R: number, span: number, rootChord: number, tipChord: number, sweep: number, thick: number, bevel: boolean): THREE.BufferGeometry {
  // x = radial, y = along the body (up). Root trailing edge at y = 0.
  const yTop = rootChord
  const yTopTip = yTop - sweep
  const s = new THREE.Shape()
  s.moveTo(R - 0.02, 0)
  s.lineTo(R + span, yTopTip - tipChord)
  s.lineTo(R + span, yTopTip)
  s.lineTo(R - 0.02, yTop)
  s.lineTo(R - 0.02, 0)
  const g = new THREE.ExtrudeGeometry(s, {
    depth: thick,
    bevelEnabled: bevel,
    bevelThickness: bevel ? thick * 0.35 : 0,
    bevelSize: bevel ? thick * 0.35 : 0,
    bevelSegments: 1,
  })
  g.translate(0, 0, -thick / 2)
  addPan(g, null)
  return g
}

function cylBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, segs = 8): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const g = new THREE.CylinderGeometry(r, r, len, segs, 1)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  addPan(g, null)
  return g
}

function boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  addPan(g, null)
  return g
}

// ═══════════════════════════ merge-by-material kit ═══════════════════════════

const ATTRS: Array<[string, number]> = [['position', 3], ['normal', 3], ['uv', 2], ['aPan', 3]]

function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0
  for (const g of list) count += g.getAttribute('position').count
  const out = new THREE.BufferGeometry()
  for (const [name, size] of ATTRS) {
    const arr = new Float32Array(count * size)
    let off = 0
    for (const g of list) {
      const a = g.getAttribute(name)
      if (a) arr.set(a.array as Float32Array, off)
      off += g.getAttribute('position').count * size
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size))
  }
  return out
}

class Kit {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4): void {
    if (m) geo.applyMatrix4(m)
    const ng = geo.index ? geo.toNonIndexed() : geo
    if (ng !== geo) geo.dispose()
    this.buckets.set(mat, [...(this.buckets.get(mat) ?? []), ng])
  }

  build(into: THREE.Object3D): void {
    for (const [mat, list] of this.buckets) {
      const merged = mergeGeos(list)
      for (const g of list) g.dispose()
      const mesh = new THREE.Mesh(merged, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      into.add(mesh)
    }
    this.buckets.clear()
  }
}

// ═══════════════════════════ build context ═══════════════════════════

interface Ctx {
  tier: TierCfg
  kit: Kit
  nozzleKit: Kit
  nozzleMountY: number
  mat: (kind: Kind, soot?: number, sootH?: number) => THREE.Material
  rivets: Array<[number, number, number]>
}

interface BodyOpts {
  soot?: number
  sootH?: number
  rivets?: boolean
}

function body(c: Ctx, kind: Kind, x: number, y0: number, profile: Profile, o: BodyOpts = {}): void {
  const { geo, rowH, rows, cols, rMax } = latheGeo(profile, c.tier.radial)
  geo.translate(x, y0, 0)
  c.kit.add(geo, c.mat(kind, o.soot ?? 0, o.sootH ?? 1))
  if (o.rivets && c.tier.rivets) {
    const n = cols * 2
    for (let k = 0; k <= rows; k++) {
      const y = y0 + k * rowH
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2
        c.rivets.push([x + (rMax + 0.003) * Math.sin(a), y, (rMax + 0.003) * Math.cos(a)])
      }
    }
  }
}

function nozzle(c: Ctx, gimbal: boolean, x: number, z: number, mountY: number, rThroat: number, rExit: number, len: number): void {
  const g = new THREE.LatheGeometry(bell(rThroat, rExit, len, 12).map(([r, y]) => new THREE.Vector2(r, y)), Math.max(16, Math.round(c.tier.radial * 0.7)))
  addPan(g, null)
  if (gimbal) {
    g.translate(x, 0, z)
    c.nozzleKit.add(g, c.mat('nozzle'))
  } else {
    g.translate(x, mountY, z)
    c.kit.add(g, c.mat('nozzle'))
  }
  // bright lip at the exit plane
  const lip = new THREE.TorusGeometry(rExit, rExit * 0.05, 5, Math.max(16, Math.round(c.tier.radial * 0.7)))
  lip.rotateX(Math.PI / 2)
  addPan(lip, null)
  if (gimbal) {
    lip.translate(x, -len, z)
    c.nozzleKit.add(lip, c.mat('engine'))
  } else {
    lip.translate(x, mountY - len, z)
    c.kit.add(lip, c.mat('engine'))
  }
}

function cluster(c: Ctx, n: number, ringR: number, mountY: number, rThroat: number, rExit: number, len: number): void {
  if (n === 1) {
    nozzle(c, true, 0, 0, mountY, rThroat, rExit, len)
    return
  }
  nozzle(c, true, 0, 0, mountY, rThroat, rExit, len)
  for (let i = 0; i < n - 1; i++) {
    const a = (i / (n - 1)) * Math.PI * 2 + Math.PI / 4
    nozzle(c, true, Math.cos(a) * ringR, Math.sin(a) * ringR, mountY, rThroat, rExit, len)
  }
}

function strut(c: Ctx, kind: Kind, a: [number, number, number], b: [number, number, number], r: number): void {
  c.kit.add(cylBetween(new THREE.Vector3(...a), new THREE.Vector3(...b), r, 6), c.mat(kind))
}

function fins(c: Ctx, kind: Kind, n: number, R: number, y0: number, span: number, root: number, tip: number, sweep: number, thick: number, offset = 0): void {
  for (let i = 0; i < n; i++) {
    const g = finGeo(R, span, root, tip, sweep, thick, c.tier.bevel)
    const a = (i / n) * Math.PI * 2 + offset
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(a))
    g.translate(0, y0, 0)
    c.kit.add(g, c.mat(kind))
  }
}

// ═══════════════════════════ the four vehicles ═══════════════════════════

function buildStrap(c: Ctx): void {
  const R = 0.30
  c.nozzleMountY = 0.40
  cluster(c, 1, 0, 0.40, 0.07, 0.21, 0.62)

  body(c, 'dark', 0, 0, frustum(0.36, R, 0.5), { soot: 0.9, sootH: 0.9 })
  body(c, 'grey', 0, 0.5, frustum(R, R, 2.6), { soot: 0.45, sootH: 2.4, rivets: true })
  body(c, 'dark', 0, 3.1, frustum(R, R, 0.22))
  body(c, 'grey', 0, 3.32, frustum(R, 0.38, 0.25))
  body(c, 'white', 0, 3.57, frustum(0.38, 0.38, 0.8), { rivets: true })
  body(c, 'accent', 0, 3.77, frustum(0.384, 0.384, 0.1, 0.004))
  body(c, 'white', 0, 4.37, ogive(0.38, 1.2, 'tangent'))

  for (const s of [-1, 1]) {
    const x = s * 0.55
    body(c, 'dark', x, 0.42, frustum(0.18, 0.13, 0.42), { soot: 0.9, sootH: 0.9 })
    body(c, 'cream', x, 0.84, frustum(0.13, 0.13, 2.0), { soot: 0.4, sootH: 1.8, rivets: true })
    body(c, 'cream', x, 2.84, ogive(0.13, 0.6, 'tangent'))
    nozzle(c, false, x, 0, 0.5, 0.04, 0.10, 0.32)
    strut(c, 'engine', [s * 0.30, 0.95, 0], [x - s * 0.13, 0.95, 0], 0.025)
    strut(c, 'engine', [s * 0.30, 2.55, 0], [x - s * 0.13, 2.55, 0], 0.025)
    strut(c, 'engine', [s * 0.28, 0.7, 0], [x - s * 0.1, 1.3, 0], 0.015)
  }
  // umbilical trunk on the core
  c.kit.add(boxGeo(0.05, 2.4, 0.04), c.mat('dark'), new THREE.Matrix4().makeTranslation(0, 1.7, R + 0.02))
}

function buildReuse(c: Ctx): void {
  const R = 0.28
  c.nozzleMountY = 0.36
  cluster(c, 5, 0.14, 0.36, 0.04, 0.10, 0.55)

  body(c, 'dark', 0, 0, frustum(0.31, R, 0.34), { soot: 0.9, sootH: 0.8 })
  body(c, 'white', 0, 0.34, frustum(R, R, 3.2), { soot: 0.5, sootH: 2.2, rivets: true })
  body(c, 'dark', 0, 3.54, frustum(R, R, 0.3))
  body(c, 'white', 0, 3.84, frustum(R, R, 1.2), { rivets: true })
  body(c, 'dark', 0, 5.04, frustum(R, R * 0.995, 0.1, 0.004))
  body(c, 'white', 0, 5.14, ogive(R, 0.9, 'min'))

  // all-moving tail fins (the physics' control surfaces)
  fins(c, 'grey', 4, R, 0.42, 0.34, 0.62, 0.30, 0.22, 0.03, Math.PI / 4)
  // stowed landing struts hugging the body
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const sx = Math.sin(a), sz = Math.cos(a)
    strut(c, 'engine', [sx * (R + 0.02), 1.55, sz * (R + 0.02)], [sx * (R + 0.16), 0.4, sz * (R + 0.16)], 0.018)
    strut(c, 'engine', [sx * (R + 0.16), 0.4, sz * (R + 0.16)], [sx * (R + 0.2), 0.34, sz * (R + 0.2)], 0.028)
  }
  // cold-gas thruster pods near the top of the booster section
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    c.kit.add(boxGeo(0.07, 0.1, 0.06), c.mat('engine'),
      new THREE.Matrix4().makeRotationY(a).setPosition(Math.sin(a) * (R + 0.02), 4.7, Math.cos(a) * (R + 0.02)))
  }
}

function buildTower(c: Ctx): void {
  const R = 0.36
  c.nozzleMountY = 0.44
  cluster(c, 3, 0.15, 0.44, 0.06, 0.15, 0.66)

  body(c, 'dark', 0, 0, frustum(0.42, R, 0.4), { soot: 0.9, sootH: 0.9 })
  body(c, 'graphite', 0, 0.4, frustum(R, R, 1.8), { soot: 0.45, sootH: 2.0, rivets: true })
  body(c, 'white', 0, 2.2, frustum(R, R, 0.22))
  body(c, 'graphite', 0, 2.42, frustum(R, R, 1.9), { rivets: true })
  body(c, 'white', 0, 4.32, frustum(R, R, 0.16))
  body(c, 'graphite', 0, 4.48, frustum(R, 0.24, 0.5))
  body(c, 'white', 0, 4.98, frustum(0.24, 0.24, 0.8), { rivets: true })
  body(c, 'white', 0, 5.78, ogive(0.24, 0.95, 'tangent'))

  for (const s of [-1, 1]) {
    const x = s * 0.6
    body(c, 'dark', x, 0.46, frustum(0.2, 0.15, 0.46), { soot: 0.9, sootH: 0.9 })
    body(c, 'cream', x, 0.92, frustum(0.15, 0.15, 2.5), { soot: 0.4, sootH: 1.8, rivets: true })
    body(c, 'cream', x, 3.42, ogive(0.15, 0.7, 'cone'))
    nozzle(c, false, x, 0, 0.55, 0.045, 0.11, 0.36)
    strut(c, 'engine', [s * 0.36, 1.1, 0], [x - s * 0.15, 1.1, 0], 0.03)
    strut(c, 'engine', [s * 0.36, 3.0, 0], [x - s * 0.15, 3.0, 0], 0.03)
    strut(c, 'engine', [s * 0.34, 2.28, 0], [x - s * 0.12, 3.2, 0], 0.016)
  }
}

function buildSteel(c: Ctx): void {
  const R = 0.27
  c.nozzleMountY = 0.36
  cluster(c, 3, 0.1, 0.36, 0.045, 0.12, 0.6)

  body(c, 'dark', 0, 0, frustum(0.33, R, 0.34), { soot: 0.95, sootH: 0.9 })
  body(c, 'stainless', 0, 0.34, frustum(R, R, 3.3), { soot: 0.6, sootH: 2.4, rivets: true })
  body(c, 'stainless', 0, 3.64, dome(R, 0.18, 8))
  body(c, 'dark', 0, 3.6, frustum(R + 0.006, R + 0.006, 0.06, 0.004))
  body(c, 'stainless', 0, 3.66, frustum(R, R, 1.35), { rivets: true })
  body(c, 'stainless', 0, 5.01, ogive(R, 1.1, 'cone'))
  fins(c, 'stainless', 3, R, 0.38, 0.3, 0.55, 0.2, 0.3, 0.025, Math.PI / 2)
}

const BUILDERS: Record<VehicleId, (c: Ctx) => void> = {
  strap: buildStrap,
  reuse: buildReuse,
  tower: buildTower,
  steel: buildSteel,
}

// ═══════════════════════════ public API ═══════════════════════════

export function buildVehicle(id: VehicleId, quality: QualityTier = 'medium', envMap: THREE.Texture | null = null): VehicleModel {
  const tier = TIERS[quality]
  const cache = new Map<string, THREE.Material>()
  const mat = (kind: Kind, soot = 0, sootH = 1): THREE.Material => {
    const key = `${kind}|${soot}|${sootH}`
    const hit = cache.get(key)
    if (hit) return hit
    const s = SPECS[kind]
    const base = {
      color: s.color,
      roughness: s.rough,
      metalness: s.metal,
      side: s.double ? THREE.DoubleSide : THREE.FrontSide,
      envMap,
      envMapIntensity: s.metal > 0.5 ? 1.1 : 0.7,
    }
    const m: THREE.Material =
      tier.physical && s.coat > 0
        ? new THREE.MeshPhysicalMaterial({ ...base, clearcoat: s.coat, clearcoatRoughness: 0.18 })
        : new THREE.MeshStandardMaterial(base)
    patchMaterial(m, tier.detail, [s.seams, soot, s.mottle, sootH])
    cache.set(key, m)
    return m
  }

  const ctx: Ctx = { tier, kit: new Kit(), nozzleKit: new Kit(), nozzleMountY: 0.4, mat, rivets: [] }
  BUILDERS[id](ctx)

  const rocket = new THREE.Group()
  ctx.kit.build(rocket)

  const nozzleGroup = new THREE.Group()
  nozzleGroup.position.set(0, ctx.nozzleMountY, 0)
  ctx.nozzleKit.build(nozzleGroup)
  rocket.add(nozzleGroup)

  // Scale the model so its bounding-box height matches the vehicle's
  // realistic height in scene units (REALISTIC_HEIGHT_M * HEIGHT_TO_SCENE).
  const rawHeight = new THREE.Box3().setFromObject(rocket).max.y
  const targetHeight = REALISTIC_HEIGHT_M[id] * HEIGHT_TO_SCENE
  const scaleFactor = targetHeight / Math.max(rawHeight, 0.01)
  rocket.scale.setScalar(scaleFactor)

  if (ctx.rivets.length > 0) {
    const rg = new THREE.SphereGeometry(0.009, 5, 4)
    const rm = new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.4, metalness: 0.9, envMap, envMapIntensity: 0.9 })
    const inst = new THREE.InstancedMesh(rg, rm, ctx.rivets.length)
    const m4 = new THREE.Matrix4()
    ctx.rivets.forEach((p, i) => inst.setMatrixAt(i, m4.makeTranslation(p[0], p[1], p[2])))
    inst.instanceMatrix.needsUpdate = true
    rocket.add(inst)
  }

  const height = new THREE.Box3().setFromObject(rocket).max.y  // post-scale

  const dispose = (): void => {
    rocket.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    for (const m of cache.values()) m.dispose()
  }

  return { rocket, nozzleGroup, height, dispose }
}

/**
 * Drop-in replacement for the previous builder: adds the rocket to the scene
 * and returns the same `{ rocket, nozzleGroup }` pair.
 */
export function buildRocket(
  scene: THREE.Scene,
  envMap?: THREE.Texture | null,
  opts: { vehicle?: VehicleId; quality?: QualityTier } = {}
): { rocket: THREE.Group; nozzleGroup: THREE.Group } {
  const model = buildVehicle(opts.vehicle ?? DEFAULT_VEHICLE, opts.quality ?? 'medium', envMap ?? null)
  model.rocket.position.y = 0
  scene.add(model.rocket)
  return { rocket: model.rocket, nozzleGroup: model.nozzleGroup }
}