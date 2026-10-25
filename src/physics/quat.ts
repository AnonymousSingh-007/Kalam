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