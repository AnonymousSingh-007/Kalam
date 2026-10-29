// Minimal, dependency-free quaternion math for the physics engine.
// Convention: [x, y, z, w], Hamilton product, unit quaternion = orientation
// that rotates a vector from BODY frame into the local launch-site frame
// (see 6dof-spec.md section 2). Same convention three.js's own Quaternion
// uses internally, so the one conversion point in Scene.tsx is a direct
// field copy, not a re-derivation.

import { type Vec3, length as length3 } from './vec3'

export type Quat = readonly [number, number, number, number]

export const qIdentity: Quat = [0, 0, 0, 1]

export const qFromArray = (x: number, y: number, z: number, w: number): Quat => [x, y, z, w]

/** Hamilton product a ⊗ b. NOT commutative — order matters. */
export const qMul = (a: Quat, b: Quat): Quat => {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export const qConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]

export const qLength = (q: Quat): number =>
  Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])

/**
 * Renormalize to the unit sphere. MUST be called after every RK4 step on
 * the orientation component of state (see 6dof-spec.md section 7) — without
 * this, numerical drift grows |q| away from 1 over a long flight and the
 * rotation it represents slowly becomes invalid (introduces spurious
 * scaling/shear into qRotate).
 */
export const qNormalize = (q: Quat): Quat => {
  const l = qLength(q)
  if (l < 1e-12) return qIdentity
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export const qFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const l = length3(axis)
  if (l < 1e-12) return qIdentity
  const [ax, ay, az] = [axis[0] / l, axis[1] / l, axis[2] / l]
  const half = angle / 2
  const s = Math.sin(half)
  return [ax * s, ay * s, az * s, Math.cos(half)]
}

/** Rotate vector v (treated as a pure quaternion [v,0]) by q: q ⊗ v ⊗ q⁻¹. */
export const qRotate = (q: Quat, v: Vec3): Vec3 => {
  const vq: Quat = [v[0], v[1], v[2], 0]
  const r = qMul(qMul(q, vq), qConjugate(q))
  return [r[0], r[1], r[2]]
}

/**
 * Inverse rotation: rotate v by q⁻¹ — used to bring a local-frame vector
 * (e.g. air-relative velocity) INTO the body frame for the aero model
 * (6dof-spec.md section 5). For a unit quaternion, q⁻¹ == conjugate(q), so
 * this is cheaper than a general inverse.
 */
export const qRotateInverse = (q: Quat, v: Vec3): Vec3 => qRotate(qConjugate(q), v)

/**
 * Quaternion time-derivative for a given BODY-frame angular velocity:
 *     dq/dt = 0.5 * q ⊗ [omegaBody, 0]
 * This is the quaternion-kinematics term fed into the RK4 integrator for
 * the orientation slice of state (6dof-spec.md section 7). The result is
 * NOT itself a unit quaternion (it's a derivative) — do not normalize this;
 * normalize the integrated state afterward with qNormalize.
 */
export const qDerivative = (q: Quat, omegaBody: Vec3): Quat => {
  const omegaQuat: Quat = [omegaBody[0], omegaBody[1], omegaBody[2], 0]
  const dq = qMul(q, omegaQuat)
  return [dq[0] * 0.5, dq[1] * 0.5, dq[2] * 0.5, dq[3] * 0.5]
}

/** Dot product between two quaternions (used for shortest-path checks, slerp, etc. if ever needed). */
export const qDot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

/**
 * Extract pitch/yaw/roll-style Euler angles for telemetry display only
 * (6dof-spec.md section 8). This assumes the body-axis convention from the
 * spec: +Y_body = nose-first, +X_body = pitch-plane normal, +Z_body =
 * yaw-plane normal. Angles are in radians; callers convert to degrees.
 * Not used internally by the integrator — quaternion state is authoritative,
 * this is a one-way readout for the HUD/telemetry snapshot.
 */
export const qToPitchYawRoll = (q: Quat): { pitch: number; yaw: number; roll: number } => {
  const [x, y, z, w] = q
  // Rotation matrix elements needed for a Y-X-Z (yaw-pitch-roll about the
  // nose-first +Y body axis) decomposition.
  const m02 = 2 * (x * z - w * y)
  const m12 = 2 * (y * z + w * x)
  const m22 = 1 - 2 * (x * x + y * y)
  const m01 = 2 * (x * y - w * z)
  const m00 = 1 - 2 * (y * y + z * z)

  const pitch = Math.asin(Math.max(-1, Math.min(1, -m12)))
  const yaw = Math.atan2(m02, m22)
  const roll = Math.atan2(m01, m00)
  return { pitch, yaw, roll }
}