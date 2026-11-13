import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { metresToScene } from '../constants/scale'

// Launch tower + swing arms + umbilicals + hold-down clamps, and the
// release sequence that frees the rocket at liftoff.
//
// Everything here is VISUAL ONLY: the rocket's pose always comes from
// telemetry (Scene.tsx); the clamps and arms just animate around it.
//
// Sizes derive from the vehicle (rocketHeight + the rocket's measured
// surface) and from the pad radius passed in -- fit() rebuilds the
// geometry for each vehicle.
//
// Draw calls: tower frame 1 (merged lattice), arms 1 each (3), clamp
// pedestals 1 + clamp jaws 1 (InstancedMesh), cables 1 (InstancedMesh).

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

const ARM_HEIGHTS = [0.3, 0.58, 0.84]       // fractions of rocket height
const CABLES_PER_ARM = 2
const CABLE_SEGMENTS = 5
const CLAMP_COUNT = 4
const GRAVITY = metresToScene(9.81)         // scene units / s^2

export interface LaunchPadRig {
  group: THREE.Group
  /** Rebuild for a vehicle. Rocket must be at the origin, upright. */
  fit(rocket: THREE.Object3D, rocketHeight: number): void
  /** Pre-launch: arms/clamps ease toward attached (true) or stowed/open (false). */
  updateIdle(attached: boolean, dt: number, rocket: THREE.Object3D): void
  /** In flight: sequence from sim time and the release time. */
  updateFlight(time: number, releaseT: number, dt: number, rocket: THREE.Object3D): void
  /** Stowed arms, open clamps, cables hanging -- the selection-screen state. */
  reset(): void
  dispose(): void
}

const ease = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1)
  return c * c * (3 - 2 * c)
}

function beam(a: THREE.Vector3, b: THREE.Vector3, thick: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = d.length()
  const g = new THREE.BoxGeometry(thick, len, thick)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
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

export function buildLaunchPad(padRadius: number): LaunchPadRig {
  const group = new THREE.Group()

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x45464b, roughness: 0.55, metalness: 0.7 })
  const paintMat = new THREE.MeshStandardMaterial({ color: 0xa8432e, roughness: 0.6, metalness: 0.35 })
  const armMat = new THREE.MeshStandardMaterial({ color: 0x6c7077, roughness: 0.5, metalness: 0.65 })
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x2c2d31, roughness: 0.6, metalness: 0.75 })
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.85 })

  const tower = new THREE.Mesh(new THREE.BufferGeometry(), frameMat)
  tower.castShadow = true; tower.receiveShadow = true
  group.add(tower)
  const towerTop = new THREE.Mesh(new THREE.BufferGeometry(), paintMat)
  towerTop.castShadow = true
  group.add(towerTop)

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

  const pedestalGeo = new THREE.BoxGeometry(1, 1, 1)
  const jawGeo = new THREE.BoxGeometry(1, 1, 1)
  const pedestals = new THREE.InstancedMesh(pedestalGeo, clampMat, CLAMP_COUNT)
  const jaws = new THREE.InstancedMesh(jawGeo, clampMat, CLAMP_COUNT)
  pedestals.castShadow = jaws.castShadow = true
  pedestals.receiveShadow = jaws.receiveShadow = true
  pedestals.frustumCulled = jaws.frustumCulled = false
  group.add(pedestals, jaws)
  const clampAng: number[] = []
  const clampR: number[] = []
  for (let i = 0; i < CLAMP_COUNT; i++) clampAng.push(Math.PI / 4 + (i * Math.PI * 2) / CLAMP_COUNT)
  let clampW = 0.1, clampH = 0.1, jawLen = 0.1
  let clampOpen = 1                                        // 0 closed .. 1 open

  const cableGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true)
  const cableCount = ARM_HEIGHTS.length * CABLES_PER_ARM
  const cableMesh = new THREE.InstancedMesh(cableGeo, cableMat, cableCount * CABLE_SEGMENTS)
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

  // scratch (no per-frame allocation)
  const dummy = new THREE.Object3D()
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vP = new THREE.Vector3()
  const vQ = new THREE.Vector3()
  const vD = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)

  let towerX = padRadius * 1.18
  let towerInnerX = towerX
  let towerW = 0.4
  let rocketScale = 1
  let armDepthV = 0.1

  function fit(rocket: THREE.Object3D, rocketHeight: number) {
    // Measure with the rocket at the origin, upright, unrotated.
    const savedPos = rocket.position.clone()
    const savedRot = rocket.rotation.clone()
    rocket.position.set(0, 0, 0)
    rocket.rotation.set(0, 0, 0)
    rocket.updateMatrixWorld(true)
    rocketScale = rocket.scale.x

    const H = rocketHeight
    towerW = THREE.MathUtils.clamp(H * 0.085, 0.3, 0.6)
    const towerH = H * 1.12
    const fallbackR = H * 0.06
    const maxR = surfaceExtent(rocket, 1, 0, 0, H, H, fallbackR)
    towerX = Math.max(padRadius * 1.18, maxR + towerW * 0.5 + H * 0.12)
    towerInnerX = towerX - towerW / 2

    // ---- tower lattice (merged, one draw call) ----
    const post = towerW * 0.11
    const brace = towerW * 0.05
    const half = towerW / 2
    const parts: THREE.BufferGeometry[] = []
    const corners: Array<[number, number]> = [[-half, -half], [half, -half], [half, half], [-half, half]]
    for (const [cx, cz] of corners) {
      parts.push(beam(new THREE.Vector3(towerX + cx, 0, cz), new THREE.Vector3(towerX + cx, towerH, cz), post))
    }
    const levels = Math.max(4, Math.round(towerH / towerW))
    const lh = towerH / levels
    for (let l = 0; l <= levels; l++) {
      const y = l * lh
      for (let s = 0; s < 4; s++) {
        const [ax, az] = corners[s]
        const [bx, bz] = corners[(s + 1) % 4]
        parts.push(beam(new THREE.Vector3(towerX + ax, y, az), new THREE.Vector3(towerX + bx, y, bz), brace * 1.3))
        if (l < levels) {
          const flip = (l + s) % 2 === 0
          parts.push(beam(
            new THREE.Vector3(towerX + (flip ? ax : bx), y, flip ? az : bz),
            new THREE.Vector3(towerX + (flip ? bx : ax), y + lh, flip ? bz : az),
            brace,
          ))
        }
      }
    }
    tower.geometry.dispose()
    tower.geometry = mergeGeometries(parts.map((g) => g.index ? g.toNonIndexed() : g)) ?? new THREE.BufferGeometry()
    for (const g of parts) g.dispose()

    // Hammerhead + lightning mast on top, in the accent paint.
    const topParts = [
      beam(new THREE.Vector3(towerX - half * 1.6, towerH, 0), new THREE.Vector3(towerX + half * 1.2, towerH, 0), towerW * 0.22),
      beam(new THREE.Vector3(towerX, towerH, 0), new THREE.Vector3(towerX, towerH + H * 0.12, 0), towerW * 0.06),
    ]
    towerTop.geometry.dispose()
    towerTop.geometry = mergeGeometries(topParts.map((g) => g.toNonIndexed())) ?? new THREE.BufferGeometry()
    for (const g of topParts) g.dispose()

    // ---- swing arms ----
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
        ap.push(beam(new THREE.Vector3(0, armDepth / 2, zz), new THREE.Vector3(-L, armDepth / 2, zz), t))
        ap.push(beam(new THREE.Vector3(0, -armDepth / 2, zz), new THREE.Vector3(-L, -armDepth / 2, zz), t))
        const bays = Math.max(2, Math.round(L / armDepth))
        for (let b = 0; b <= bays; b++) {
          const x = -(b / bays) * L
          ap.push(beam(new THREE.Vector3(x, -armDepth / 2, zz), new THREE.Vector3(x, armDepth / 2, zz), t * 0.8))
          if (b < bays) {
            const x2 = -((b + 1) / bays) * L
            ap.push(beam(new THREE.Vector3(x, -armDepth / 2, zz), new THREE.Vector3(x2, armDepth / 2, zz), t * 0.6))
          }
        }
      }
      // walkway deck + umbilical plate at the rocket end
      const deck = new THREE.BoxGeometry(L, t, armWidth)
      deck.translate(-L / 2, -armDepth / 2, 0)
      ap.push(deck)
      const plate = new THREE.BoxGeometry(armDepth * 0.35, armDepth * 1.3, armWidth * 0.8)
      plate.translate(-L + armDepth * 0.17, 0, 0)
      ap.push(plate)
      armMeshes[i].geometry.dispose()
      armMeshes[i].geometry = mergeGeometries(ap.map((g) => g.index ? g.toNonIndexed() : g)) ?? new THREE.BufferGeometry()
      for (const g of ap) g.dispose()
      arms[i].position.set(towerInnerX, y, 0)

      // Umbilical attach points on the rocket, slightly below the arm.
      const drop = H * 0.05
      for (let c = 0; c < CABLES_PER_ARM; c++) {
        const cab = cables[i * CABLES_PER_ARM + c]
        cab.zOff = (c === 0 ? -1 : 1) * armWidth * 0.25
        const sy = y - armDepth / 2 - drop
        const sx = surfaceExtent(rocket, 1, 0, sy - H * 0.02, sy + H * 0.02, armWidth * 0.4, surf)
        cab.attachLocal.set(sx / rocketScale, sy / rocketScale, cab.zOff / rocketScale)
        cab.restLen = Math.hypot(L * 0.12, armDepth / 2 + drop) * 1.15
      }
    }
    cableRadius = H * 0.004

    // ---- hold-down clamps ----
    clampW = H * 0.035
    clampH = H * 0.045
    jawLen = clampW * 0.5 + H * 0.01           // just reaches over the skirt edge
    for (let i = 0; i < CLAMP_COUNT; i++) {
      const dx = Math.cos(clampAng[i]), dz = Math.sin(clampAng[i])
      clampR[i] = surfaceExtent(rocket, dx, dz, 0, H * 0.06, H * 0.05, fallbackR) + clampW * 0.8
    }

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
      // pedestal
      dummy.position.set(Math.cos(a) * r, clampH / 2, Math.sin(a) * r)
      dummy.rotation.set(0, -a, 0)
      dummy.scale.set(clampW, clampH, clampW)
      dummy.updateMatrix()
      pedestals.setMatrixAt(i, dummy.matrix)
      // jaw: hinged at the pedestal's inner top edge, reaching inward over
      // the skirt; opens by tilting its inner end up and away.
      const hinge = r - clampW * 0.5
      vP.set(Math.cos(a) * hinge, clampH, Math.sin(a) * hinge)
      dummy.rotation.order = 'YZX'
      dummy.rotation.set(0, -a, -open)
      dummy.scale.set(jawLen, clampW * 0.45, clampW * 0.7)
      // local box spans x in [-0.5,0.5]; shift so it spans [-1,0] from the hinge
      vQ.set(-0.5 * jawLen, 0, 0).applyEuler(dummy.rotation)
      dummy.position.copy(vP).add(vQ)
      dummy.updateMatrix()
      jaws.setMatrixAt(i, dummy.matrix)
      dummy.rotation.order = 'XYZ'
    }
    pedestals.instanceMatrix.needsUpdate = true
    jaws.instanceMatrix.needsUpdate = true
  }

  /** Cable anchor on the underside of arm i, a little in from the rocket end (world). */
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
        // Verlet pendulum: falls under (scaled) gravity, rope length capped.
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
      const sag = Math.max(cab.restLen - span, 0) * 0.5 + cab.restLen * 0.04
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
    dummy.rotation.set(0, 0, 0)
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

  function reset() {
    for (let i = 0; i < armSwing.length; i++) armSwing[i] = 1
    clampOpen = 1
    for (const cab of cables) cab.attached = false
    freeInit = false
    applyArms()
    applyClamps()
  }

  function dispose() {
    tower.geometry.dispose(); towerTop.geometry.dispose()
    for (const m of armMeshes) m.geometry.dispose()
    pedestalGeo.dispose(); jawGeo.dispose(); cableGeo.dispose()
    pedestals.dispose(); jaws.dispose(); cableMesh.dispose()
    frameMat.dispose(); paintMat.dispose(); armMat.dispose(); clampMat.dispose(); cableMat.dispose()
  }

  return { group, fit, updateIdle, updateFlight, reset, dispose }
}
