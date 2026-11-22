import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { metresToScene } from '../constants/scale'
import type { QualityTier } from '../types'
import { PAD_RADIUS, padPitHolePath, flatShapeGeometry, surfaceY, PIT_HALF_X } from './padFootprint'

// Static launch-center backdrop around the pad: assembly building,
// blockhouse, hangars, fuel farm, second pad, tracking dishes, crawlerway,
// fence, light poles, flag, concrete apron, grass patches, ponds, soot.
//
// Placement: real-world metres (metresToScene), polar around the pad with
// angles chosen on the far side from the chase camera (camera sits on +Z),
// so nothing comes between the camera and the rocket. Every footprint sits
// on the curved planet surface (surfaceY, same sphere as buildGround).
//
// Draw calls (all static, built once):
//   buildings (merged, vertex colours) 1, lamp heads (instanced) 1,
//   fence wires 1, crawlerway 1, apron 1, ponds 1, soot decals 1  = 7
// 'low' quality skips dishes, fence, light poles, flag, hangar detail and
// the second pad's tower detail.
//
// Scene has no fog (it would hide the true-scale planet), so distant
// buildings rely on their muted colours rather than fog falloff.

export interface LaunchComplex {
  group: THREE.Group
  dispose(): void
}

const m = metresToScene

// polar (angle rad in XZ, distance metres) -> scene XZ
function polar(angle: number, distM: number): [number, number] {
  return [Math.cos(angle) * m(distM), Math.sin(angle) * m(distM)]
}

class ColoredParts {
  parts: THREE.BufferGeometry[] = []
  private c = new THREE.Color()
  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): void {
    const ng = g.index ? g.toNonIndexed() : g
    if (ng !== g) g.dispose()
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position' && name !== 'normal') ng.deleteAttribute(name)
    }
    this.c.set(color)
    const n = ng.getAttribute('position').count
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { col[i * 3] = this.c.r; col[i * 3 + 1] = this.c.g; col[i * 3 + 2] = this.c.b }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3))
    this.parts.push(ng)
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts) ?? new THREE.BufferGeometry()
    for (const p of this.parts) p.dispose()
    this.parts = []
    g.computeBoundingSphere()
    return g
  }
}

/** Box with its BASE at (x, y, z), rotated rotY about its own vertical axis. */
function boxAt(x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0, lx = 0, ly = 0, lz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(lx, ly + h / 2, lz)
  g.rotateY(rotY)
  g.translate(x, y, z)
  return g
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat: [number, number]): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  draw(cv.getContext('2d')!)
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeat[0], repeat[1])
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

// Deterministic PRNG so the layout is identical every session.
function rng(seed: number) {
  let s = seed
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
}

export function buildLaunchComplex(quality: QualityTier): LaunchComplex {
  const group = new THREE.Group()
  const detailed = quality !== 'low'
  const B = new ColoredParts()
  const rnd = rng(42)
  const disposables: Array<{ dispose(): void }> = []

  const CONCRETE = 0xb3afa6, CONCRETE_DK = 0x8e8a83, WHITE = 0xe9e7e2, STEEL = 0x55575c
  const BLUE = 0x2c4f8c, ROOF = 0x6b6e73, GRASS_DK = 0x3f6b33, GRASS_LT = 0x6f9a4a

  // ---------------- Vehicle Assembly Building ----------------
  const vabA = 4.0
  const [vx, vz] = polar(vabA, 1350)
  const vabRot = Math.atan2(-Math.cos(vabA), -Math.sin(vabA))   // local +Z faces the pad
  {
    const y = surfaceY(vx, vz) - m(1)
    const W = m(218), H = m(160), D = m(158)
    B.add(boxAt(vx, y, vz, W, H, D, vabRot), 0xd9d6cf)
    // low-bay annex
    B.add(boxAt(vx, y, vz, m(130), m(64), m(70), vabRot, W * 0.5 + m(60), 0, -m(20)), 0xcfccc4)
    // big vertical door panels on the pad-facing side, with horizontal slats
    for (const off of [-W * 0.22, W * 0.22]) {
      B.add(boxAt(vx, y, vz, m(46), H * 0.86, m(1.5), vabRot, off, 0, D / 2 + m(0.5)), 0x9b9a96)
      if (detailed) {
        for (let k = 1; k < 12; k++) {
          B.add(boxAt(vx, y, vz, m(47), m(1.2), m(2), vabRot, off, (H * 0.86 * k) / 12, D / 2 + m(1)), 0x7d7c79)
        }
      }
    }
    // flag-like stripe panel + top band
    const fw = m(60), fh = m(40)
    const fx = 0, fy = H * 0.55
    B.add(boxAt(vx, y, vz, fw, fh / 3, m(1.5), vabRot, fx, fy, D / 2 + m(1)), BLUE)
    B.add(boxAt(vx, y, vz, fw, fh / 3, m(1.5), vabRot, fx, fy + fh / 3, D / 2 + m(1)), 0xf2f2ee)
    B.add(boxAt(vx, y, vz, fw, fh / 3, m(1.5), vabRot, fx, fy + (2 * fh) / 3, D / 2 + m(1)), BLUE)
    B.add(boxAt(vx, y, vz, W * 1.002, m(6), D * 1.002, vabRot, 0, H - m(10)), BLUE)
  }

  // ---------------- crawlerway: pad apron -> VAB door ----------------
  const crawlerTex = canvasTexture(128, 256, (ctx) => {
    ctx.fillStyle = '#6d6a63'; ctx.fillRect(0, 0, 128, 256)
    // two gravel lanes with a grass median
    for (const [x0, x1] of [[4, 50], [78, 124]]) {
      ctx.fillStyle = '#9a958a'; ctx.fillRect(x0, 0, x1 - x0, 256)
      for (let i = 0; i < 900; i++) {
        const v = 120 + Math.random() * 90
        ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},0.55)`
        ctx.fillRect(x0 + Math.random() * (x1 - x0), Math.random() * 256, 1.5, 1.5)
      }
    }
    ctx.fillStyle = '#4d6b3a'; ctx.fillRect(54, 0, 20, 256)
  }, [1, 40])
  disposables.push(crawlerTex)
  {
    const start = PAD_RADIUS * 3.2, end = Math.hypot(vx, vz) - m(85)
    const dirX = Math.cos(vabA), dirZ = Math.sin(vabA)
    const px = -dirZ, pz = dirX                   // lateral
    const hw = m(20)
    const N = 48
    const pos: number[] = [], uv: number[] = [], idx: number[] = []
    for (let i = 0; i <= N; i++) {
      const d = start + ((end - start) * i) / N
      for (const s of [-1, 1]) {
        const x = dirX * d + px * hw * s, z = dirZ * d + pz * hw * s
        pos.push(x, surfaceY(x, z) + 0.006, z)
        uv.push(s < 0 ? 0 : 1, (d - start) / (end - start))
      }
      if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ map: crawlerTex, roughness: 1, metalness: 0 })
    const mesh = new THREE.Mesh(g, mat)
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(g, mat)
  }

  // ---------------- concrete apron around the pad ----------------
  const apronTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#a9a59c'; ctx.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 2500; i++) {
      const v = 140 + Math.random() * 60
      ctx.fillStyle = `rgba(${v},${v - 3},${v - 8},0.25)`
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2)
    }
    ctx.strokeStyle = 'rgba(70,68,64,0.55)'; ctx.lineWidth = 2
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 256); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(256, i * 64); ctx.stroke()
    }
  }, [1, 1])
  disposables.push(apronTex)
  {
    const R = PAD_RADIUS * 3.2
    const shape = new THREE.Shape()
    const n = 8
    for (let i = 0; i <= n; i++) {        // octagonal hardstand
      const a = (i / n) * Math.PI * 2 + Math.PI / 8
      if (i === 0) shape.moveTo(Math.cos(a) * R, Math.sin(a) * R)
      else shape.lineTo(Math.cos(a) * R, Math.sin(a) * R)
    }
    shape.holes.push(padPitHolePath())
    const g = flatShapeGeometry(shape, 1 / 4)
    g.translate(0, 0.004, 0)
    const mat = new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.95 })
    const mesh = new THREE.Mesh(g, mat)
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(g, mat)
  }

  // ---------------- soot streaks at the flame-trench exits ----------------
  const sootTex = canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(10,8,6,0.85)')
    g.addColorStop(0.5, 'rgba(30,24,18,0.45)')
    g.addColorStop(1, 'rgba(40,32,24,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  }, [1, 1])
  disposables.push(sootTex)
  {
    const parts: THREE.BufferGeometry[] = []
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(PAD_RADIUS * 3.2, PAD_RADIUS * 1.6)
      g.rotateX(-Math.PI / 2)
      g.translate(s * (PIT_HALF_X + PAD_RADIUS * 1.75), 0.03, 0)
      parts.push(g)
    }
    const g = mergeGeometries(parts)!
    for (const p of parts) p.dispose()
    const mat = new THREE.MeshBasicMaterial({ map: sootTex, transparent: true, depthWrite: false })
    const mesh = new THREE.Mesh(g, mat)
    mesh.renderOrder = 2
    group.add(mesh)
    disposables.push(g, mat)
  }

  // ---------------- blockhouse / mission control ----------------
  {
    const a = 5.6
    const [x, z] = polar(a, 420)
    const y = surfaceY(x, z) - m(0.5)
    const rot = Math.atan2(-Math.cos(a), -Math.sin(a))
    B.add(boxAt(x, y, z, m(60), m(12), m(40), rot), CONCRETE)
    const dome = new THREE.SphereGeometry(m(16), 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
    dome.translate(x, y + m(12), z)
    B.add(dome, CONCRETE_DK)
    B.add(boxAt(x, y + m(12), z, m(1.2), m(30), m(1.2), rot, m(22), 0, m(12)), STEEL)
    if (detailed) {
      // flag pole + generic striped flag
      const fx = x + Math.cos(a + 0.5) * m(45), fz = z + Math.sin(a + 0.5) * m(45)
      const fy = surfaceY(fx, fz)
      B.add(boxAt(fx, fy, fz, m(0.6), m(22), m(0.6)), 0xdcdcdc)
      for (let k = 0; k < 3; k++) {
        B.add(boxAt(fx, fy + m(16) + k * m(1.6), fz, m(0.2), m(1.6), m(7), 0, 0, 0, m(3.8)), k === 1 ? 0xf4f4f0 : BLUE)
      }
    }
  }

  // ---------------- hangars / sheds ----------------
  for (const [a, d, len] of [[4.55, 720, 70], [4.75, 820, 90], [5.0, 760, 60], [3.6, 950, 80]] as Array<[number, number, number]>) {
    const [x, z] = polar(a, d)
    const y = surfaceY(x, z) - m(0.5)
    const rot = a + Math.PI / 2
    const w = m(34), h = m(10), L = m(len)
    B.add(boxAt(x, y, z, w, h, L, rot), CONCRETE)
    const roof = new THREE.CylinderGeometry(w / 2, w / 2, L, detailed ? 14 : 8, 1, false, -Math.PI / 2, Math.PI)
    roof.rotateX(-Math.PI / 2)              // half-cylinder arch, opening down, axis along Z
    roof.translate(0, h, 0)
    roof.rotateY(rot)
    roof.translate(x, y, z)
    B.add(roof, ROOF)
    if (detailed) B.add(boxAt(x, y, z, w * 0.6, h * 0.8, m(0.8), rot, 0, 0, L / 2 + m(0.2)), 0x5d5f63)
  }

  // ---------------- fuel farm: spheres + horizontal tanks ----------------
  for (const [a, d, r] of [[3.35, 300, 11], [3.15, 340, 9]] as Array<[number, number, number]>) {
    const [x, z] = polar(a, d)
    const y = surfaceY(x, z)
    const sph = new THREE.SphereGeometry(m(r), 20, 14)
    sph.translate(x, y + m(r) + m(6), z)
    B.add(sph, WHITE)
    for (let k = 0; k < 6; k++) {
      const la = (k / 6) * Math.PI * 2
      B.add(boxAt(x + Math.cos(la) * m(r * 0.85), y, z + Math.sin(la) * m(r * 0.85), m(1.2), m(6 + r * 0.9), m(1.2)), STEEL)
    }
    B.add(boxAt(x, y - m(0.3), z, m(r * 2.6), m(0.8), m(r * 2.6)), CONCRETE_DK)
  }
  for (let k = 0; k < 3; k++) {
    const [x, z] = polar(5.9 + k * 0.035, 320 + k * 6)
    const y = surfaceY(x, z)
    const rot = 5.9 + Math.PI / 2
    const tank = new THREE.CylinderGeometry(m(4), m(4), m(30), 16, 1)
    tank.rotateZ(Math.PI / 2)
    tank.translate(0, m(6), 0)
    tank.rotateY(rot)
    tank.translate(x, y, z)
    B.add(tank, WHITE)
    for (const off of [-m(10), m(10)]) B.add(boxAt(x, y, z, m(2), m(3), m(7), rot + Math.PI / 2, 0, 0, off), CONCRETE_DK)
  }

  // ---------------- second launch pad (distant silhouette) ----------------
  {
    const a = 4.9
    const [x, z] = polar(a, 1500)
    const y = surfaceY(x, z)
    const pad = new THREE.CylinderGeometry(m(60), m(70), m(6), 8, 1)
    pad.translate(x, y + m(1), z)
    B.add(pad, CONCRETE)
    B.add(boxAt(x + m(14), y + m(4), z, m(12), m(110), m(12)), 0x6a4a3c)
    B.add(boxAt(x + m(10), y + m(114), z, m(30), m(5), m(8)), 0x6a4a3c)
    if (detailed) {
      for (const [ma, md] of [[0.5, 70], [2.6, 70], [4.4, 70]]) {
        const mx = x + Math.cos(ma) * m(md), mz = z + Math.sin(ma) * m(md)
        B.add(boxAt(mx, surfaceY(mx, mz), mz, m(2), m(150), m(2)), STEEL)
      }
    }
  }

  // ---------------- tracking dishes ----------------
  if (detailed) {
    for (const [a, d, r] of [[5.2, 1000, 14], [5.32, 1080, 10]] as Array<[number, number, number]>) {
      const [x, z] = polar(a, d)
      const y = surfaceY(x, z)
      B.add(boxAt(x, y, z, m(5), m(r * 1.1), m(5)), CONCRETE)
      const pts: THREE.Vector2[] = []
      for (let i = 0; i <= 10; i++) {
        const rr = (i / 10) * m(r)
        pts.push(new THREE.Vector2(rr, (rr * rr) / (4 * m(r) * 0.45)))
      }
      const dish = new THREE.LatheGeometry(pts, 20)
      dish.rotateX(-0.75)                         // tilted up toward the sky
      dish.rotateY(a + Math.PI)                   // facing back over the site
      dish.translate(x, y + m(r * 1.25), z)
      B.add(dish, 0xe2e2df)
      B.add(boxAt(x, y + m(r * 1.1), z, m(1), m(r * 0.6), m(1)), STEEL)
    }
  }

  // ---------------- light poles (lamp heads glow, bloom) ----------------
  const lampAngles = detailed ? [3.35, 3.85, 4.35, 4.95, 5.45, 5.95] : []
  const lampGeo = new THREE.SphereGeometry(1, 8, 6)
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 3.2, 2.2), toneMapped: false })
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(lampAngles.length, 1))
  lamps.count = lampAngles.length
  lamps.frustumCulled = false
  disposables.push(lampGeo, lampMat, lamps)
  {
    const dummy = new THREE.Object3D()
    lampAngles.forEach((a, i) => {
      const [x, z] = polar(a, 130)
      const y = surfaceY(x, z)
      B.add(boxAt(x, y, z, m(0.8), m(30), m(0.8)), STEEL)
      B.add(boxAt(x, y + m(30), z, m(5), m(1.5), m(2.5)), STEEL)
      dummy.position.set(x, y + m(29.5), z)
      dummy.scale.setScalar(m(1.4))
      dummy.updateMatrix()
      lamps.setMatrixAt(i, dummy.matrix)
    })
    lamps.instanceMatrix.needsUpdate = true
  }
  group.add(lamps)

  // ---------------- perimeter fence (back arc, gap for the crawlerway) ----------------
  const fenceV: number[] = []
  if (detailed) {
    const R = 260
    const a0 = Math.PI + 0.15, a1 = Math.PI * 2 - 0.15
    const steps = Math.round((m(R) * (a1 - a0)) / m(20))
    let prev: [number, number, number] | null = null
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps
      if (Math.abs(a - vabA) < 0.09) { prev = null; continue }
      const [x, z] = polar(a, R)
      const y = surfaceY(x, z)
      B.add(boxAt(x, y, z, m(0.4), m(3), m(0.4)), STEEL)
      if (prev) {
        for (const h of [m(1), m(2), m(2.9)]) fenceV.push(prev[0], prev[1] + h, prev[2], x, y + h, z)
      }
      prev = [x, y, z]
    }
  }
  const fenceGeo = new THREE.BufferGeometry()
  fenceGeo.setAttribute('position', new THREE.Float32BufferAttribute(fenceV, 3))
  const fenceMat = new THREE.LineBasicMaterial({ color: 0x3a3c40, transparent: true, opacity: 0.7 })
  group.add(new THREE.LineSegments(fenceGeo, fenceMat))
  disposables.push(fenceGeo, fenceMat)

  // ---------------- grass patches (vertex-coloured discs) ----------------
  for (let i = 0; i < (detailed ? 40 : 16); i++) {
    const a = Math.PI * 0.95 + rnd() * Math.PI * 1.1
    const d = 180 + rnd() * 1000
    const [x, z] = polar(a, d)
    const disc = new THREE.CircleGeometry(m(25 + rnd() * 60), 10)
    disc.rotateX(-Math.PI / 2)
    disc.scale(1, 1, 0.5 + rnd() * 0.8)
    disc.rotateY(rnd() * Math.PI)
    disc.translate(x, surfaceY(x, z) + 0.008, z)
    B.add(disc, rnd() < 0.5 ? GRASS_DK : GRASS_LT)
  }

  // ---------------- marsh ponds (reflective) ----------------
  {
    const parts: THREE.BufferGeometry[] = []
    for (const [a, d, r] of [[3.8, 520, 70], [4.3, 1100, 110], [5.75, 680, 55], [3.3, 800, 90]] as Array<[number, number, number]>) {
      const [x, z] = polar(a, d)
      const g = new THREE.CircleGeometry(m(r), 20)
      g.rotateX(-Math.PI / 2)
      g.scale(1, 1, 0.55)
      g.rotateY(a)
      g.translate(x, surfaceY(x, z) + 0.01, z)
      parts.push(g)
    }
    const g = mergeGeometries(parts)!
    for (const p of parts) p.dispose()
    const mat = new THREE.MeshStandardMaterial({ color: 0x5b7a8c, roughness: 0.15, metalness: 0.35 })
    group.add(new THREE.Mesh(g, mat))
    disposables.push(g, mat)
  }

  // ---------------- merged buildings mesh ----------------
  const bGeo = B.build()
  const bMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 })
  const buildings = new THREE.Mesh(bGeo, bMat)
  buildings.receiveShadow = true
  group.add(buildings)
  disposables.push(bGeo, bMat)

  return {
    group,
    dispose() { for (const d of disposables) d.dispose() },
  }
}
