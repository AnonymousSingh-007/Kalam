import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { metresToScene } from '../constants/scale'
import type { QualityTier } from '../types'
import { PAD_RADIUS, PIT_HALF_X, PIT_HALF_Z, PIT_DEPTH, surfaceY } from './padFootprint'

// Launch site hardware around the rocket, and the release sequence that
// frees the rocket at liftoff:
//   * fixed service tower: lattice truss, X-bracing, decks every few
//     metres with railings, ladder, hammerhead crane, lightning mast and a
//     parked rotating-service-structure frame
//   * 4 truss swing arms with umbilical hoses (retract on release)
//   * launch mount table over the flame-trench pit, deflector wedge,
//     concrete pit walls/floor/exit ramps, 4 hold-down clamps
//   * 3 lightning-protection masts with guy wires + catenary wire
//   * 2 water towers + deluge pipework; steam nozzle positions exported so
//     Scene.tsx can spawn steam from them at ignition
//   * red/white blinking aviation lights
//
// Everything is VISUAL ONLY: the rocket's pose always comes from telemetry.
// Sizes come from the vehicle (rocketHeight, measured surface), the pad
// footprint (padFootprint.ts) and real-world metres via metresToScene.
// fit() rebuilds per vehicle / quality tier.
//
// Draw calls: steel 1, rust accent 1, white tanks 1, concrete 1, arms 4,
// clamp pedestals 1, clamp jaws 1, hoses 1, red lights 1, white strobes 1,
// guy/catenary wires 1  = 14.

// ---- release sequence timing (sim seconds, telemetry.time) ----
export const PAD_RELEASE = {
  /** Clamps release at this sim time, or at physics liftoff if that is earlier. */
  RELEASE_T: 1.5,
  /** Clamp jaws open (eased) over this long. */
  CLAMP_OPEN_S: 0.45,
  /** Delay after release before the first arm starts to swing. */
  ARM_DELAY_S: 0.1,
  /** Extra delay per arm, bottom to top. */
  ARM_STAGGER_S: 0.18,
  /** Each arm swings away over this long. */
  ARM_SWING_S: 1.0,
  /** Swing angle, radians (arms fold back along the tower face). */
  ARM_SWING_ANGLE: 1.62,
  /** Jaw opening angle, radians. */
  CLAMP_OPEN_ANGLE: 1.25,
}

const ARM_HEIGHTS = [0.2, 0.42, 0.63, 0.84]  // fractions of rocket height
const CABLES_PER_ARM = 2
const CABLE_SEGMENTS = 6
const CLAMP_COUNT = 4
const GRAVITY = metresToScene(9.81)          // scene units / s^2
const DECK_SPACING_M = 7                     // tower platform spacing
const MAST_ANGLES = [2.62, 4.1, 5.32]        // lightning masts (rad, XZ), kept off the camera side (+Z)
const WATER_TOWER_ANGLES = [3.55, 3.95]
const WATER_TOWER_DIST = PAD_RADIUS * 3.6

export interface SteamNozzle { x: number; y: number; z: number; dx: number; dz: number }

export interface LaunchPadRig {
  group: THREE.Group
  /** Deluge steam outlets (world), filled by fit(). */
  readonly steamNozzles: SteamNozzle[]
  /** Rebuild for a vehicle. Rocket must be at the origin, upright. */
  fit(rocket: THREE.Object3D, rocketHeight: number, quality: QualityTier): void
  /** Pre-launch: arms/clamps ease toward attached (true) or stowed/open (false). */
  updateIdle(attached: boolean, dt: number, rocket: THREE.Object3D): void
  /** In flight: sequence from sim time and the release time. */
  updateFlight(time: number, releaseT: number, dt: number, rocket: THREE.Object3D): void
  /** Aviation light blink, wall-clock seconds. */
  blink(t: number): void
  /** Stowed arms, open clamps, cables hanging -- the selection-screen state. */
  reset(): void
  dispose(): void
}

const ease = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1)
  return c * c * (3 - 2 * c)
}

const _up = new THREE.Vector3(0, 1, 0)
function beam(a: THREE.Vector3, b: THREE.Vector3, thick: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = Math.max(d.length(), 1e-4)
  const g = new THREE.BoxGeometry(thick, len, thick)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}
function pipe(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = Math.max(d.length(), 1e-4)
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}
function box(cx: number, cy: number, cz: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(cx, cy, cz)
  return g
}
/** Box slab from a to b in the XY plane (tilted about Z), `width` along Z. */
function slab(ax: number, ay: number, bx: number, by: number, z: number, width: number, thick: number): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay)
  const g = new THREE.BoxGeometry(len, thick, width)
  g.rotateZ(Math.atan2(by - ay, bx - ax))
  g.translate((ax + bx) / 2, (ay + by) / 2, z)
  return g
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) return new THREE.BufferGeometry()
  const flat = parts.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') ng.deleteAttribute(name)
    }
    return ng
  })
  const out = mergeGeometries(flat) ?? new THREE.BufferGeometry()
  for (const g of parts) g.dispose()
  for (const g of flat) g.dispose()
  out.computeBoundingSphere()
  return out
}

/** Max extent of the rocket surface along horizontal direction (dx,dz), for
 *  vertices with y in [y0,y1] lying within `tol` of that radial line.
 *  The rocket must be posed at the origin with no rotation. */
function surfaceExtent(rocket: THREE.Object3D, dx: number, dz: number, y0: number, y1: number, tol: number, fallback: number): number {
  let best = -Infinity
  const v = new THREE.Vector3()
  rocket.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) return
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      if (v.y < y0 || v.y > y1) continue
      const perp = Math.abs(-v.x * dz + v.z * dx)
      if (perp > tol) continue
      const along = v.x * dx + v.z * dz
      if (along > best) best = along
    }
  })
  return Number.isFinite(best) ? best : fallback
}

interface Cable {
  arm: number
  zOff: number
  attachLocal: THREE.Vector3      // rocket-local attach point (pre-scale)
  free: THREE.Vector3             // free end when detached (world)
  freePrev: THREE.Vector3         // verlet previous position
  attached: boolean
  restLen: number
}

export function buildLaunchPad(): LaunchPadRig {
  const group = new THREE.Group()

  const steelMat = new THREE.MeshStandardMaterial({ color: 0x46484d, roughness: 0.55, metalness: 0.7 })
  const rustMat = new THREE.MeshStandardMaterial({ color: 0xa4472c, roughness: 0.62, metalness: 0.35 })
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe6e4df, roughness: 0.45, metalness: 0.2 })
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.95, metalness: 0.0 })
  const armMat = new THREE.MeshStandardMaterial({ color: 0x6c7077, roughness: 0.5, metalness: 0.65 })
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x2c2d31, roughness: 0.6, metalness: 0.75 })
  const hoseMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.85 })
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2a2b2e, transparent: true, opacity: 0.8 })
  // Aviation lights: unlit, HDR colour so UnrealBloomPass makes them glow.
  const redBase = new THREE.Color(5.0, 0.35, 0.25)
  const whiteBase = new THREE.Color(6.0, 6.0, 6.5)
  const redMat = new THREE.MeshBasicMaterial({ color: redBase.clone(), toneMapped: false })
  const whiteMat2 = new THREE.MeshBasicMaterial({ color: whiteBase.clone(), toneMapped: false })

  const mk = (mat: THREE.Material, cast = true) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    m.castShadow = cast; m.receiveShadow = true
    group.add(m)
    return m
  }
  const steel = mk(steelMat)
  const rust = mk(rustMat)
  const white = mk(whiteMat)
  const concrete = mk(concreteMat, false)
  const wires = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat)
  group.add(wires)

  const arms: THREE.Group[] = []
  const armMeshes: THREE.Mesh[] = []
  for (let i = 0; i < ARM_HEIGHTS.length; i++) {
    const pivot = new THREE.Group()
    const m = new THREE.Mesh(new THREE.BufferGeometry(), armMat)
    m.castShadow = true; m.receiveShadow = true
    pivot.add(m)
    group.add(pivot)
    arms.push(pivot); armMeshes.push(m)
  }
  const armLen: number[] = ARM_HEIGHTS.map(() => 1)
  const armSwing: number[] = ARM_HEIGHTS.map(() => 1)    // 0 attached .. 1 stowed

  const unitBox = new THREE.BoxGeometry(1, 1, 1)
  const pedestals = new THREE.InstancedMesh(unitBox, clampMat, CLAMP_COUNT)
  const jaws = new THREE.InstancedMesh(unitBox, clampMat, CLAMP_COUNT)
  for (const m of [pedestals, jaws]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; group.add(m) }
  const clampAng: number[] = []
  const clampR: number[] = []
  for (let i = 0; i < CLAMP_COUNT; i++) clampAng.push(Math.PI / 4 + (i * Math.PI * 2) / CLAMP_COUNT)
  let clampW = 0.1, clampH = 0.1, jawLen = 0.1, tableTop = 0
  let clampOpen = 1                                        // 0 closed .. 1 open

  const cableGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)
  const cableCount = ARM_HEIGHTS.length * CABLES_PER_ARM
  const cableMesh = new THREE.InstancedMesh(cableGeo, hoseMat, cableCount * CABLE_SEGMENTS)
  cableMesh.castShadow = true
  cableMesh.frustumCulled = false
  group.add(cableMesh)
  const cables: Cable[] = []
  for (let a = 0; a < ARM_HEIGHTS.length; a++) {
    for (let c = 0; c < CABLES_PER_ARM; c++) {
      cables.push({
        arm: a, zOff: 0, attachLocal: new THREE.Vector3(),
        free: new THREE.Vector3(), freePrev: new THREE.Vector3(),
        attached: false, restLen: 0.3,
      })
    }
  }
  let cableRadius = 0.01
  let freeInit = false

  // Aviation lights (positions filled by fit()).
  const MAX_LIGHTS = 16
  const lightGeo = new THREE.SphereGeometry(1, 8, 6)
  const redLights = new THREE.InstancedMesh(lightGeo, redMat, MAX_LIGHTS)
  const whiteLights = new THREE.InstancedMesh(lightGeo, whiteMat2, MAX_LIGHTS)
  redLights.frustumCulled = whiteLights.frustumCulled = false
  redLights.count = 0; whiteLights.count = 0
  group.add(redLights, whiteLights)

  const steamNozzles: SteamNozzle[] = []

  // scratch (no per-frame allocation)
  const dummy = new THREE.Object3D()
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vP = new THREE.Vector3()
  const vQ = new THREE.Vector3()
  const vD = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)

  let towerX = PAD_RADIUS * 1.18
  let towerInnerX = towerX
  let towerW = 0.4
  let rocketScale = 1
  let armDepthV = 0.1

  function fit(rocket: THREE.Object3D, rocketHeight: number, quality: QualityTier) {
    const detailed = quality !== 'low'
    // Measure with the rocket at the origin, upright, unrotated.
    const savedPos = rocket.position.clone()
    const savedRot = rocket.rotation.clone()
    rocket.position.set(0, 0, 0)
    rocket.rotation.set(0, 0, 0)
    rocket.updateMatrixWorld(true)
    rocketScale = rocket.scale.x

    const H = rocketHeight
    const fallbackR = H * 0.06
    const steelP: THREE.BufferGeometry[] = []
    const rustP: THREE.BufferGeometry[] = []
    const whiteP: THREE.BufferGeometry[] = []
    const concP: THREE.BufferGeometry[] = []
    const wireV: number[] = []
    const reds: THREE.Vector3[] = []
    const whites: THREE.Vector3[] = []
    const line = (a: THREE.Vector3, b: THREE.Vector3) => { wireV.push(a.x, a.y, a.z, b.x, b.y, b.z) }

    // ================= flame-trench pit + launch mount =================
    const wallT = PAD_RADIUS * 0.03
    for (const s of [-1, 1]) {
      concP.push(box(0, -PIT_DEPTH / 2, s * (PIT_HALF_Z + wallT / 2), PIT_HALF_X * 2, PIT_DEPTH, wallT))
    }
    const flatX = PIT_HALF_X * 0.45
    concP.push(box(0, -PIT_DEPTH - wallT / 2, 0, flatX * 2, wallT, PIT_HALF_Z * 2))
    for (const s of [-1, 1]) {
      // exit ramps rising to the surface at the trench mouths
      concP.push(slab(s * flatX, -PIT_DEPTH - wallT / 2, s * PIT_HALF_X, -wallT / 2, 0, PIT_HALF_Z * 2, wallT))
    }
    // flame deflector wedge (steel), splitting the exhaust both ways along X
    {
      const w = PIT_DEPTH * 0.9
      const sh = new THREE.Shape()
      sh.moveTo(-w, -PIT_DEPTH); sh.lineTo(w, -PIT_DEPTH); sh.lineTo(0, -PIT_DEPTH * 0.32); sh.closePath()
      const g = new THREE.ExtrudeGeometry(sh, { depth: PIT_HALF_Z * 1.9, bevelEnabled: false })
      g.translate(0, 0, -PIT_HALF_Z * 0.95)
      steelP.push(g)
    }
    // mount table: square frame around an exhaust hole, top at tableTop
    const baseR = surfaceExtent(rocket, 1, 0, 0, H * 0.05, H, fallbackR)
    const nozzleR = Math.max(
      surfaceExtent(rocket, 1, 0, -H, 0, H, 0),
      surfaceExtent(rocket, 0, 1, -H, 0, H, 0),
    )
    const T = Math.max(PIT_HALF_Z * 1.35, baseR * 1.7)
    const hole = Math.min(Math.max(baseR * 0.78, nozzleR * 1.15), T * 0.8)
    const tt = PAD_RADIUS * 0.05
    tableTop = PAD_RADIUS * 0.006            // just above the pad top (0.01) so the mount reads on top
    const cyT = tableTop - tt / 2
    steelP.push(box(0, cyT, (hole + T) / 2, T * 2, tt, T - hole))
    steelP.push(box(0, cyT, -(hole + T) / 2, T * 2, tt, T - hole))
    steelP.push(box((hole + T) / 2, cyT, 0, T - hole, tt, hole * 2))
    steelP.push(box(-(hole + T) / 2, cyT, 0, T - hole, tt, hole * 2))
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      steelP.push(box(sx * T * 0.85, (-tt - PIT_DEPTH) / 2, sz * PIT_HALF_Z * 0.75, tt * 1.3, PIT_DEPTH - tt, tt * 1.3))
    }

    // ================= deluge pipework + steam nozzles =================
    steamNozzles.length = 0
    const pipeR = PAD_RADIUS * 0.012
    const ringR = PAD_RADIUS * 0.9
    const t0 = Math.asin(Math.min((PIT_HALF_Z + wallT * 2) / ringR, 0.99))
    for (const [a0, a1] of [[t0, Math.PI - t0], [Math.PI + t0, Math.PI * 2 - t0]]) {
      const n = 10
      for (let i = 0; i < n; i++) {
        const aa = a0 + ((a1 - a0) * i) / n, ab = a0 + ((a1 - a0) * (i + 1)) / n
        steelP.push(pipe(V(Math.cos(aa) * ringR, pipeR, -Math.sin(aa) * ringR), V(Math.cos(ab) * ringR, pipeR, -Math.sin(ab) * ringR), pipeR))
      }
      for (let i = 1; i < 4; i++) {
        const a = a0 + ((a1 - a0) * i) / 4
        const x = Math.cos(a) * ringR, z = -Math.sin(a) * ringR
        const top = PAD_RADIUS * 0.12
        steelP.push(pipe(V(x, 0, z), V(x, top, z), pipeR * 0.8))
        steelP.push(box(x, top, z, pipeR * 3, pipeR * 2, pipeR * 3))
        steamNozzles.push({ x, y: top, z, dx: Math.cos(a), dz: -Math.sin(a) })
      }
    }
    // pipes running along the trench walls, nozzles spraying into the pit
    for (const s of [-1, 1]) {
      steelP.push(pipe(V(-PIT_HALF_X * 0.9, -pipeR * 2, s * PIT_HALF_Z * 0.92), V(PIT_HALF_X * 0.9, -pipeR * 2, s * PIT_HALF_Z * 0.92), pipeR))
      for (const x of [-PIT_HALF_X * 0.6, PIT_HALF_X * 0.6]) {
        steamNozzles.push({ x, y: 0, z: s * PIT_HALF_Z * 0.9, dx: Math.sign(x) * 0.5, dz: -s * 0.3 })
      }
    }

    // ================= fixed service tower =================
    towerW = THREE.MathUtils.clamp(H * 0.085, 0.3, 0.6)
    const towerH = H * 1.12
    const maxR = surfaceExtent(rocket, 1, 0, 0, H, H, fallbackR)
    towerX = Math.max(PAD_RADIUS * 1.18, maxR + towerW * 0.5 + H * 0.12)
    towerInnerX = towerX - towerW / 2
    const half = towerW / 2
    const post = towerW * 0.1
    const brace = towerW * 0.045
    const corners: Array<[number, number]> = [[-half, -half], [half, -half], [half, half], [-half, half]]
    for (const [cx, cz] of corners) steelP.push(beam(V(towerX + cx, -0.02, cz), V(towerX + cx, towerH, cz), post))
    const levels = Math.max(4, Math.round(towerH / towerW))
    const lh = towerH / levels
    for (let l = 0; l <= levels; l++) {
      const y = l * lh
      for (let s = 0; s < 4; s++) {
        const [ax, az] = corners[s]
        const [bx, bz] = corners[(s + 1) % 4]
        steelP.push(beam(V(towerX + ax, y, az), V(towerX + bx, y, bz), brace * 1.3))
        if (l < levels) {
          // full X-bracing on every face
          steelP.push(beam(V(towerX + ax, y, az), V(towerX + bx, y + lh, bz), brace))
          if (detailed) steelP.push(beam(V(towerX + bx, y, bz), V(towerX + ax, y + lh, az), brace))
        }
      }
    }
    if (detailed) {
      // Platforms every few metres, cantilevered a little past the frame,
      // with railings on the three sides away from the rocket.
      const deckStep = Math.max(metresToScene(DECK_SPACING_M), lh * 0.5)
      const dw = towerW * 1.35
      const rail = towerW * 0.2
      for (let y = deckStep; y < towerH - deckStep * 0.5; y += deckStep) {
        rustP.push(box(towerX + towerW * 0.1, y, 0, dw, towerW * 0.03, dw))
        const x0 = towerX + towerW * 0.1 - dw / 2, x1 = x0 + dw, z0 = -dw / 2, z1 = dw / 2
        steelP.push(beam(V(x1, y + rail, z0), V(x1, y + rail, z1), brace * 0.6))
        steelP.push(beam(V(x0, y + rail, z0), V(x1, y + rail, z0), brace * 0.6))
        steelP.push(beam(V(x0, y + rail, z1), V(x1, y + rail, z1), brace * 0.6))
        for (const [px, pz] of [[x1, z0], [x1, z1], [x0, z0], [x0, z1]] as Array<[number, number]>) {
          steelP.push(beam(V(px, y, pz), V(px, y + rail, pz), brace * 0.5))
        }
      }
      // ladder up the outer (+X) face
      const lx = towerX + half + towerW * 0.06
      for (const lz of [-towerW * 0.1, towerW * 0.1]) steelP.push(beam(V(lx, 0, lz), V(lx, towerH, lz), brace * 0.5))
      const rung = metresToScene(0.6)
      for (let y = rung; y < towerH; y += Math.max(rung, towerH / 160)) {
        steelP.push(beam(V(lx, y, -towerW * 0.1), V(lx, y, towerW * 0.1), brace * 0.35))
      }
      // parked rotating service structure: open lattice frame beside the tower
      const rw = towerW * 1.6, rd = towerW * 0.9, rh = towerH * 0.72
      const rx = towerX + towerW * 0.3, rz = -half - rd / 2 - towerW * 0.15
      const rc: Array<[number, number]> = [[-rw / 2, -rd / 2], [rw / 2, -rd / 2], [rw / 2, rd / 2], [-rw / 2, rd / 2]]
      for (const [cx, cz] of rc) steelP.push(beam(V(rx + cx, 0, rz + cz), V(rx + cx, rh, rz + cz), post * 0.8))
      const rl = Math.max(3, Math.round(rh / (rw * 0.6)))
      for (let l = 0; l <= rl; l++) {
        const y = (l / rl) * rh
        for (let s = 0; s < 4; s++) {
          const [ax, az] = rc[s], [bx, bz] = rc[(s + 1) % 4]
          steelP.push(beam(V(rx + ax, y, rz + az), V(rx + bx, y, rz + bz), brace))
          if (l < rl && s !== 3) steelP.push(beam(V(rx + ax, y, rz + az), V(rx + bx, y + rh / rl, rz + bz), brace * 0.8))
        }
        if (l > 0 && l < rl) rustP.push(box(rx, y, rz, rw * 0.95, towerW * 0.025, rd * 0.95))
      }
    }
    // hammerhead crane: jib out over the rocket, counter-jib, cab, hook line
    const jibY = towerH + towerW * 0.25
    const jibT = towerW * 0.2
    rustP.push(beam(V(towerX + half * 1.8, jibY, 0), V(towerX - towerX * 0.98, jibY, 0), jibT))
    rustP.push(box(towerX, towerH + towerW * 0.12, 0, towerW * 1.05, towerW * 0.24, towerW * 1.05))
    steelP.push(box(towerX + half * 1.5, jibY - jibT, 0, towerW * 0.45, towerW * 0.35, towerW * 0.5))   // counterweight
    steelP.push(beam(V(towerX, jibY, 0), V(towerX, jibY + towerW * 0.9, 0), brace * 1.2))
    steelP.push(beam(V(towerX, jibY + towerW * 0.9, 0), V(towerX - towerX * 0.98, jibY, 0), brace * 0.6))
    steelP.push(beam(V(towerX, jibY + towerW * 0.9, 0), V(towerX + half * 1.8, jibY, 0), brace * 0.6))
    const hookX = towerX * 0.35
    steelP.push(box(hookX, jibY - jibT, 0, jibT * 1.2, jibT * 0.6, jibT * 1.4))
    line(V(hookX, jibY - jibT, 0), V(hookX, jibY - towerW * 1.6, 0))
    // tower lightning mast + lights
    const mastTop = jibY + towerW * 0.9 + H * 0.12
    steelP.push(beam(V(towerX, jibY + towerW * 0.9, 0), V(towerX, mastTop, 0), brace * 0.8))
    whites.push(V(towerX, mastTop + towerW * 0.04, 0))
    reds.push(V(towerX - towerX * 0.98, jibY + jibT, 0), V(towerX + half, towerH, half), V(towerX + half, towerH, -half))

    // ================= swing arms =================
    const armDepth = H * 0.04
    armDepthV = armDepth
    const armWidth = towerW * 0.55
    for (let i = 0; i < ARM_HEIGHTS.length; i++) {
      const y = H * ARM_HEIGHTS[i]
      const surf = surfaceExtent(rocket, 1, 0, y - armDepth, y + armDepth, armWidth * 0.5, fallbackR)
      const L = Math.max(towerInnerX - surf - H * 0.008, towerW * 0.5)
      armLen[i] = L
      const ap: THREE.BufferGeometry[] = []
      const t = armDepth * 0.16
      for (const zz of [-armWidth / 2, armWidth / 2]) {
        ap.push(beam(V(0, armDepth / 2, zz), V(-L, armDepth / 2, zz), t))
        ap.push(beam(V(0, -armDepth / 2, zz), V(-L, -armDepth / 2, zz), t))
        const bays = Math.max(2, Math.round(L / armDepth))
        for (let b = 0; b <= bays; b++) {
          const x = -(b / bays) * L
          ap.push(beam(V(x, -armDepth / 2, zz), V(x, armDepth / 2, zz), t * 0.8))
          if (b < bays) ap.push(beam(V(x, -armDepth / 2, zz), V(-((b + 1) / bays) * L, armDepth / 2, zz), t * 0.6))
        }
      }
      const deck = new THREE.BoxGeometry(L, t, armWidth)
      deck.translate(-L / 2, -armDepth / 2, 0)
      ap.push(deck)
      const plate = new THREE.BoxGeometry(armDepth * 0.35, armDepth * 1.3, armWidth * 0.8)
      plate.translate(-L + armDepth * 0.17, 0, 0)
      ap.push(plate)
      armMeshes[i].geometry.dispose()
      armMeshes[i].geometry = merged(ap)
      arms[i].position.set(towerInnerX, y, 0)

      // Umbilical hoses: attach points on the rocket, slightly below the arm.
      const drop = H * 0.05
      for (let c = 0; c < CABLES_PER_ARM; c++) {
        const cab = cables[i * CABLES_PER_ARM + c]
        cab.zOff = (c === 0 ? -1 : 1) * armWidth * 0.25
        const sy = y - armDepth / 2 - drop
        const sx = surfaceExtent(rocket, 1, 0, sy - H * 0.02, sy + H * 0.02, armWidth * 0.4, surf)
        cab.attachLocal.set(sx / rocketScale, sy / rocketScale, cab.zOff / rocketScale)
        cab.restLen = Math.hypot(L * 0.12, armDepth / 2 + drop) * 1.3
      }
    }
    cableRadius = H * 0.006

    // ================= hold-down clamps =================
    clampW = H * 0.035
    clampH = H * 0.045
    jawLen = clampW * 0.5 + H * 0.01
    for (let i = 0; i < CLAMP_COUNT; i++) {
      const dx = Math.cos(clampAng[i]), dz = Math.sin(clampAng[i])
      clampR[i] = surfaceExtent(rocket, dx, dz, 0, H * 0.06, H * 0.05, fallbackR) + clampW * 0.8
    }

    // ================= lightning-protection masts =================
    const mastH = Math.max(H * 1.45, towerH * 1.25)
    const mastR = PAD_RADIUS * 1.9
    const mastTops: THREE.Vector3[] = []
    for (const a of MAST_ANGLES) {
      const mx = Math.cos(a) * mastR, mz = Math.sin(a) * mastR
      const y0 = surfaceY(mx, mz)
      const bw = H * 0.02
      steelP.push(box(mx, y0 + bw * 0.5, mz, bw * 4, bw, bw * 4))
      steelP.push(pipe(V(mx, y0, mz), V(mx, y0 + mastH * 0.55, mz), bw * 0.9, 8))
      steelP.push(pipe(V(mx, y0 + mastH * 0.55, mz), V(mx, y0 + mastH * 0.9, mz), bw * 0.6, 8))
      steelP.push(pipe(V(mx, y0 + mastH * 0.9, mz), V(mx, y0 + mastH, mz), bw * 0.25, 6))
      rustP.push(pipe(V(mx, y0 + mastH * 0.5, mz), V(mx, y0 + mastH * 0.55, mz), bw * 1.0, 8))
      const top = V(mx, y0 + mastH, mz)
      mastTops.push(top)
      reds.push(V(mx, y0 + mastH * 0.9, mz))
      whites.push(V(mx, y0 + mastH + bw, mz))
      // guy wires: 3 anchors at 120 degrees, from two heights
      for (let k = 0; k < 3; k++) {
        const ga = a + Math.PI + (k - 1) * (Math.PI * 2 / 3)
        const gr = mastH * 0.42
        const gx = mx + Math.cos(ga) * gr, gz = mz + Math.sin(ga) * gr
        const anchor = V(gx, surfaceY(gx, gz), gz)
        line(anchor, V(mx, y0 + mastH * 0.55, mz))
        line(anchor, V(mx, y0 + mastH * 0.9, mz))
      }
    }
    // sagging catenary wire between mast tops, over the pad
    for (let m = 0; m < mastTops.length; m++) {
      const a = mastTops[m], b = mastTops[(m + 1) % mastTops.length]
      const N = 10
      const sag = a.distanceTo(b) * 0.06
      let prev = a.clone()
      for (let i = 1; i <= N; i++) {
        const t = i / N
        const p = new THREE.Vector3().lerpVectors(a, b, t)
        p.y -= sag * 4 * t * (1 - t)
        line(prev, p)
        prev = p
      }
    }

    // ================= water towers =================
    const tankR = metresToScene(9), tankH = metresToScene(16), legH = metresToScene(55)
    for (const a of WATER_TOWER_ANGLES) {
      const wx = Math.cos(a) * WATER_TOWER_DIST, wz = Math.sin(a) * WATER_TOWER_DIST
      const y0 = surfaceY(wx, wz)
      for (let k = 0; k < 4; k++) {
        const la = (k / 4) * Math.PI * 2 + Math.PI / 4
        steelP.push(beam(V(wx + Math.cos(la) * tankR * 1.1, y0, wz + Math.sin(la) * tankR * 1.1),
          V(wx + Math.cos(la) * tankR * 0.7, y0 + legH, wz + Math.sin(la) * tankR * 0.7), tankR * 0.08))
      }
      for (let k = 1; k <= 3; k++) {
        const yy = y0 + (legH * k) / 4
        const rr = tankR * (1.1 - 0.4 * (k / 4))
        for (let s = 0; s < 4; s++) {
          const a0 = (s / 4) * Math.PI * 2 + Math.PI / 4, a1 = ((s + 1) / 4) * Math.PI * 2 + Math.PI / 4
          steelP.push(beam(V(wx + Math.cos(a0) * rr, yy, wz + Math.sin(a0) * rr), V(wx + Math.cos(a1) * rr, yy, wz + Math.sin(a1) * rr), tankR * 0.05))
        }
      }
      steelP.push(pipe(V(wx, y0, wz), V(wx, y0 + legH, wz), tankR * 0.15, 8))
      const tank = new THREE.CylinderGeometry(tankR, tankR, tankH, 20, 1)
      tank.translate(wx, y0 + legH + tankH / 2, wz)
      whiteP.push(tank)
      const roof = new THREE.ConeGeometry(tankR * 1.02, tankH * 0.35, 20, 1)
      roof.translate(wx, y0 + legH + tankH + tankH * 0.175, wz)
      whiteP.push(roof)
      const bottom = new THREE.ConeGeometry(tankR, tankH * 0.4, 20, 1)
      bottom.rotateX(Math.PI)
      bottom.translate(wx, y0 + legH - tankH * 0.2, wz)
      whiteP.push(bottom)
      rustP.push(pipe(V(wx, y0 + legH + tankH * 0.45, wz), V(wx, y0 + legH + tankH * 0.6, wz), tankR * 1.01, 20))
      reds.push(V(wx, y0 + legH + tankH * 1.4, wz))
    }

    // ---- upload ----
    steel.geometry.dispose(); steel.geometry = merged(steelP)
    rust.geometry.dispose(); rust.geometry = merged(rustP)
    white.geometry.dispose(); white.geometry = merged(whiteP)
    concrete.geometry.dispose(); concrete.geometry = merged(concP)
    wires.geometry.dispose()
    wires.geometry = new THREE.BufferGeometry()
    wires.geometry.setAttribute('position', new THREE.Float32BufferAttribute(wireV, 3))

    const lightR = metresToScene(1.1)
    const place = (mesh: THREE.InstancedMesh, pts: THREE.Vector3[]) => {
      mesh.count = Math.min(pts.length, MAX_LIGHTS)
      for (let i = 0; i < mesh.count; i++) {
        dummy.position.copy(pts[i]); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(lightR)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }
    place(redLights, reds)
    place(whiteLights, whites)

    rocket.position.copy(savedPos)
    rocket.rotation.copy(savedRot)
    rocket.updateMatrixWorld(true)
    freeInit = false
  }

  function applyArms() {
    for (let i = 0; i < arms.length; i++) {
      arms[i].rotation.y = -PAD_RELEASE.ARM_SWING_ANGLE * ease(armSwing[i])
    }
  }

  function applyClamps() {
    const open = ease(clampOpen) * PAD_RELEASE.CLAMP_OPEN_ANGLE
    for (let i = 0; i < CLAMP_COUNT; i++) {
      const a = clampAng[i]
      const r = clampR[i]
      dummy.rotation.order = 'XYZ'
      dummy.position.set(Math.cos(a) * r, tableTop + clampH / 2, Math.sin(a) * r)
      dummy.rotation.set(0, -a, 0)
      dummy.scale.set(clampW, clampH, clampW)
      dummy.updateMatrix()
      pedestals.setMatrixAt(i, dummy.matrix)
      // jaw: hinged at the pedestal's inner top edge, reaching inward over
      // the skirt; opens by tilting its inner end up and away.
      const hinge = r - clampW * 0.5
      vP.set(Math.cos(a) * hinge, tableTop + clampH, Math.sin(a) * hinge)
      dummy.rotation.order = 'YZX'
      dummy.rotation.set(0, -a, -open)
      dummy.scale.set(jawLen, clampW * 0.45, clampW * 0.7)
      vQ.set(-0.5 * jawLen, 0, 0).applyEuler(dummy.rotation)
      dummy.position.copy(vP).add(vQ)
      dummy.updateMatrix()
      jaws.setMatrixAt(i, dummy.matrix)
    }
    dummy.rotation.order = 'XYZ'
    pedestals.instanceMatrix.needsUpdate = true
    jaws.instanceMatrix.needsUpdate = true
  }

  /** Hose anchor on the underside of arm i, a little in from the rocket end (world). */
  function armTip(i: number, zOff: number, out: THREE.Vector3) {
    out.set(-armLen[i] * 0.88, -armDepthV / 2, zOff).applyMatrix4(arms[i].matrixWorld)
    return out
  }

  function updateCables(dt: number, rocket: THREE.Object3D) {
    group.updateMatrixWorld(true)
    rocket.updateMatrixWorld(true)
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    let inst = 0
    for (const cab of cables) {
      armTip(cab.arm, cab.zOff, vA)
      if (cab.attached) {
        vB.copy(cab.attachLocal).applyMatrix4(rocket.matrixWorld)
        cab.free.copy(vB)
        cab.freePrev.copy(vB)
      } else {
        if (!freeInit) {
          cab.free.copy(vA).addScaledVector(UP, -cab.restLen)
          cab.freePrev.copy(cab.free)
        }
        // Verlet pendulum: falls under (scaled) gravity, hose length capped.
        for (let s = 0; s < steps; s++) {
          vD.subVectors(cab.free, cab.freePrev).multiplyScalar(0.985)
          cab.freePrev.copy(cab.free)
          cab.free.add(vD).addScaledVector(UP, -GRAVITY * h * h)
          vD.subVectors(cab.free, vA)
          const d = vD.length()
          if (d > cab.restLen) cab.free.copy(vA).addScaledVector(vD, cab.restLen / d)
        }
        vB.copy(cab.free)
      }
      // Draw as a sagging curve A -> B in CABLE_SEGMENTS straight pieces.
      const span = vA.distanceTo(vB)
      const sag = Math.max(cab.restLen - span, 0) * 0.5 + cab.restLen * 0.06
      for (let s = 0; s < CABLE_SEGMENTS; s++) {
        const t0 = s / CABLE_SEGMENTS, t1 = (s + 1) / CABLE_SEGMENTS
        vP.lerpVectors(vA, vB, t0); vP.y -= sag * 4 * t0 * (1 - t0)
        vQ.lerpVectors(vA, vB, t1); vQ.y -= sag * 4 * t1 * (1 - t1)
        vD.subVectors(vQ, vP)
        const len = Math.max(vD.length(), 1e-4)
        dummy.position.copy(vP).addScaledVector(vD, 0.5)
        dummy.quaternion.setFromUnitVectors(UP, vD.divideScalar(len))
        dummy.scale.set(cableRadius, len, cableRadius)
        dummy.updateMatrix()
        cableMesh.setMatrixAt(inst++, dummy.matrix)
      }
    }
    dummy.quaternion.identity()
    freeInit = true
    cableMesh.instanceMatrix.needsUpdate = true
  }

  function updateIdle(attached: boolean, dt: number, rocket: THREE.Object3D) {
    const rate = dt / PAD_RELEASE.ARM_SWING_S
    for (let i = 0; i < armSwing.length; i++) {
      const target = attached ? 0 : 1
      armSwing[i] += THREE.MathUtils.clamp(target - armSwing[i], -rate, rate)
    }
    const crate = dt / PAD_RELEASE.CLAMP_OPEN_S
    clampOpen += THREE.MathUtils.clamp((attached ? 0 : 1) - clampOpen, -crate, crate)
    for (const cab of cables) {
      // Re-connect once the arm is home; let go as soon as it starts to stow.
      if (attached && armSwing[cab.arm] < 0.01) cab.attached = true
      else if (!attached) cab.attached = false
    }
    applyArms()
    applyClamps()
    updateCables(dt, rocket)
  }

  function updateFlight(time: number, releaseT: number, dt: number, rocket: THREE.Object3D) {
    for (let i = 0; i < armSwing.length; i++) {
      const start = releaseT + PAD_RELEASE.ARM_DELAY_S + i * PAD_RELEASE.ARM_STAGGER_S
      armSwing[i] = THREE.MathUtils.clamp((time - start) / PAD_RELEASE.ARM_SWING_S, 0, 1)
    }
    clampOpen = THREE.MathUtils.clamp((time - releaseT) / PAD_RELEASE.CLAMP_OPEN_S, 0, 1)
    for (const cab of cables) {
      const start = releaseT + PAD_RELEASE.ARM_DELAY_S + cab.arm * PAD_RELEASE.ARM_STAGGER_S
      cab.attached = time < start
    }
    applyArms()
    applyClamps()
    updateCables(dt, rocket)
  }

  function blink(t: number) {
    // Red obstruction lights: slow on/off pulse. White: short strobe flash.
    const ph = (t * 0.6) % 1
    const red = 0.12 + 0.88 * (ph < 0.5 ? 1 - Math.pow(ph * 2, 6) : 0)
    redMat.color.copy(redBase).multiplyScalar(red)
    const sp = (t % 1.4) / 1.4
    whiteMat2.color.copy(whiteBase).multiplyScalar(sp < 0.06 ? 1 : 0.04)
  }

  function reset() {
    for (let i = 0; i < armSwing.length; i++) armSwing[i] = 1
    clampOpen = 1
    for (const cab of cables) cab.attached = false
    freeInit = false
    applyArms()
    applyClamps()
  }

  function dispose() {
    for (const m of [steel, rust, white, concrete, ...armMeshes]) m.geometry.dispose()
    wires.geometry.dispose()
    unitBox.dispose(); cableGeo.dispose(); lightGeo.dispose()
    pedestals.dispose(); jaws.dispose(); cableMesh.dispose(); redLights.dispose(); whiteLights.dispose()
    for (const m of [steelMat, rustMat, whiteMat, concreteMat, armMat, clampMat, hoseMat, wireMat, redMat, whiteMat2]) m.dispose()
  }

  return { group, steamNozzles, fit, updateIdle, updateFlight, blink, reset, dispose }
}
