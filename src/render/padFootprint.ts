import * as THREE from 'three'
import { PLANET_RADIUS } from '../constants/scale'

// Shared launch-pad footprint: the pad disc, the flame-trench pit cut
// through it (running along X), and helpers so the pad mesh, the ground
// shader's pit cut-out, the scorch decal and the concrete apron all agree
// on exactly the same outline.

/** Launch pad (concrete disc) radius, scene units. */
export const PAD_RADIUS = 2.2
/** Flame-trench pit half-extents and depth (pit runs along X). */
export const PIT_HALF_X = PAD_RADIUS * 1.25
export const PIT_HALF_Z = PAD_RADIUS * 0.2
export const PIT_DEPTH = PAD_RADIUS * 0.25

/** Height of the curved planet surface below the tangent plane at (x, z),
 *  same sphere the ground meshes are projected onto (buildGround.ts). */
export function surfaceY(x: number, z: number): number {
  const r2 = x * x + z * z
  return Math.sqrt(Math.max(PLANET_RADIUS * PLANET_RADIUS - r2, 0)) - PLANET_RADIUS
}

/** Outline (in shape XY = world X, -Z) of pad disc UNION trench pit: the
 *  hole that ground-level decals (apron, scorch) must leave open. */
export function padPitHolePath(segments = 48): THREE.Path {
  const R = PAD_RADIUS
  const t0 = Math.asin(Math.min(PIT_HALF_Z / R, 0.999))
  const path = new THREE.Path()
  const pts: THREE.Vector2[] = []
  // upper arc (z > band), then pit's -X end, lower arc, pit's +X end
  const arc = (a0: number, a1: number) => {
    const n = Math.max(4, Math.round((segments * (a1 - a0)) / (Math.PI * 2)))
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n
      pts.push(new THREE.Vector2(Math.cos(a) * R, Math.sin(a) * R))
    }
  }
  arc(t0, Math.PI - t0)
  pts.push(new THREE.Vector2(-PIT_HALF_X, PIT_HALF_Z), new THREE.Vector2(-PIT_HALF_X, -PIT_HALF_Z))
  arc(Math.PI + t0, Math.PI * 2 - t0)
  pts.push(new THREE.Vector2(PIT_HALF_X, -PIT_HALF_Z), new THREE.Vector2(PIT_HALF_X, PIT_HALF_Z))
  path.setFromPoints(pts)
  return path
}

/** The pad disc minus the pit band: two circular segments (z > band, z < -band). */
export function padShapes(segments = 48): THREE.Shape[] {
  const R = PAD_RADIUS
  const t0 = Math.asin(Math.min(PIT_HALF_Z / R, 0.999))
  const seg = (a0: number, a1: number) => {
    const s = new THREE.Shape()
    const n = Math.max(6, Math.round((segments * (a1 - a0)) / (Math.PI * 2)))
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n
      if (i === 0) s.moveTo(Math.cos(a) * R, Math.sin(a) * R)
      else s.lineTo(Math.cos(a) * R, Math.sin(a) * R)
    }
    s.closePath()
    return s
  }
  return [seg(t0, Math.PI - t0), seg(Math.PI + t0, Math.PI * 2 - t0)]
}

/** Planar shape in world XZ (shape y = -world z) -> geometry lying flat at y=0. */
export function flatShapeGeometry(shape: THREE.Shape, uvScale: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape, 32)
  g.rotateX(-Math.PI / 2)
  const pos = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * uvScale + 0.5, pos.getZ(i) * uvScale + 0.5)
  return g
}
