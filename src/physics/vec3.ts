// vec3.ts
export type Vec3 = readonly [number, number, number]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0]*k, a[1]*k, a[2]*k]
export const dot = (a: Vec3, b: Vec3): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]
]
export const length = (a: Vec3): number => Math.sqrt(dot(a, a))
export const normalize = (a: Vec3): Vec3 => { const l = Math.max(length(a), 1e-12); return scale(a, 1/l) }

// quat.ts  (x, y, z, w — Hamilton convention, unit quaternion = orientation)
export type Quat = readonly [number, number, number, number]
export const qIdentity: Quat = [0, 0, 0, 1]
export const qMul = (a: Quat, b: Quat): Quat => [ /* standard Hamilton product */ ]
export const qNormalize = (q: Quat): Quat => { /* divide by norm */ }
export const qFromAxisAngle = (axis: Vec3, angle: number): Quat => { /* ... */ }
export const qRotate = (q: Quat, v: Vec3): Vec3 => { /* rotate vector v by q */ }
export const qDerivative = (q: Quat, omegaBody: Vec3): Quat => {
  // dq/dt = 0.5 * q ⊗ [omega, 0]   (omega expressed in body frame)
}