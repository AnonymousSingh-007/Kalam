// Minimal, dependency-free 3D vector math for the physics engine.
// Deliberately NOT importing three.js here — see 6dof-spec.md section 1:
// keeps rocketPhysics.ts headless/portable, matching the project's existing
// design (plain TypeScript class, no DOM/render dependency). Scene.tsx
// converts to/from three.js's own Vector3 at the render boundary only.

export type Vec3 = readonly [number, number, number]

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z]

export const zero3: Vec3 = [0, 0, 0]

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]

/** a + b*k — fused add-scale, used heavily by the RK4 stage builder. */
export const addScaled = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
]

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

export const length = (a: Vec3): number => Math.sqrt(dot(a, a))

export const lengthSq = (a: Vec3): number => dot(a, a)

/** Safe normalize — returns the zero vector (not NaN) for a near-zero input. */
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a)
  if (l < 1e-12) return [0, 0, 0]
  return [a[0] / l, a[1] / l, a[2] / l]
}

export const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]]

/** Component-wise product (used for a diagonal inertia tensor: I·ω). */
export const mulComponents = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]

/** Element-wise reciprocal (used for I^-1·τ with a diagonal tensor). */
export const reciprocal = (a: Vec3): Vec3 => [1 / a[0], 1 / a[1], 1 / a[2]]