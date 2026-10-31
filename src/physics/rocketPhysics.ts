/**
 * rocketPhysics.ts — full 6-DOF rigid-body rocket flight simulator.
 *
 * State (13 scalars): px,py,pz (position) | vx,vy,vz (velocity) |
 * qx,qy,qz,qw (orientation quaternion, body->local) | wx,wy,wz (body-frame
 * angular velocity). RK4 at <=200 Hz, quaternion renormalized every step.
 *
 *  FRAME        local launch-site tangent frame, inertial, origin at the pad.
 *               +Y = up, +Z = north, +X = east. NOT rotating (no Coriolis,
 *               no Earth-rotation boost — see 6dof-spec.md "Deferred").
 *  BODY AXES    +Y_body = nose-first (thrust/symmetry axis), +X_body =
 *               pitch-plane normal (today's old "n"), +Z_body = yaw-plane
 *               normal (new). Gimbal/fin pitch acts in the X_body-Y_body
 *               plane; gimbal/fin yaw acts in the Y_body-Z_body plane.
 *  ATMOSPHERE   ISA 1976, unchanged from the planar model.
 *  WIND         altitude profile + Ornstein-Uhlenbeck gusts, applied along
 *               local +X only (unchanged) — aerodynamics use air-relative
 *               velocity in 3D.
 *  GRAVITY      true inverse-square vector toward a planet centre sitting
 *               directly below the pad at local (0, -R_EARTH, 0); resolves
 *               in all 3 dimensions now, not just the old X-Y plane.
 *  INERTIA      diagonal body-frame tensor I = diag(Ixx, Iyy, Izz).
 *               Ixx = Izz = the old scalar pitch inertia (axisymmetric
 *               rocket, pitch plane == yaw plane by symmetry). Iyy (roll,
 *               along the long axis) is a separate, much smaller term from
 *               each mass lump's own radius. Euler's equation carries the
 *               new ω×(I·ω) gyroscopic coupling term, zero in the old
 *               planar model and non-zero whenever roll and pitch/yaw
 *               coexist.
 *  AERO         same tables (Cd(mach), CN, Barrowman CP) as the planar
 *               model, now evaluated at a true 3D angle of attack and
 *               resolved into independent pitch-plane and yaw-plane
 *               components. No passive aerodynamic roll torque (flagged
 *               Phase-1 simplification — real for a lumped-CN fin model).
 *  PROPULSION   unchanged scalar thrust model; thrust DIRECTION is now the
 *               body +Y axis rotated by (gimbalPitch, gimbalYaw) before
 *               being rotated into the local frame by the body quaternion.
 *  CONTROL      rate-command attitude hold, independently on each of
 *               pitch/yaw/roll. Pitch/yaw torque is allocated across TVC
 *               and movable aero fins exactly as before (now per-axis);
 *               roll has no TVC or fin authority (single-engine vehicle)
 *               and is RCS-only. RCS is a 3-axis torque vector sharing one
 *               finite cold-gas budget. Arrow-key UI input stays pitch-only
 *               (setYawInput/setRollInput are new API surface for later UI
 *               work).
 *  RECOVERY     drogue/main chute at the nose, forces evaluated at the
 *               attachment point's 3D velocity.
 *  GROUND       launch rail, hold-down, soft landing vs crash — now checks
 *               tilt/spin magnitude across all three rotational axes.
 *
 * Collapse guarantee: with zero yaw/roll input and zero initial roll, this
 * engine's px,py,vx,vy and the pitch component of orientation/rate must
 * match the old 3-DOF engine's x,y,vx,vy,theta,omega exactly (6dof-spec.md
 * §9, acceptance test 1). See the sign-convention notes below.
 *
 * Sign conventions (standard right-hand 3D, NOT the old clockwise-positive
 * 2D convention):
 *   - Positive wz (body) = CCW about +Z_body = nose tilts toward -X (left in
 *     the old 2D telemetry sense). The old engine's omega was clockwise-
 *     positive (nose-right positive), so wz = -omega_old, and torque about
 *     Z_body maps as tau_z = -tau_old.
 *   - bodyAngle telemetry (kept "nose-right positive" for compatibility)
 *     is computed as atan2(bodyDir.x, bodyDir.y) where bodyDir is the body
 *     +Y axis expressed in the local frame — this matches the old
 *     atan2-based sign exactly when yaw/roll are zero.
 *   - Positive wy (roll rate) = CCW about +Y_body looking from the tail
 *     toward the nose (down the thrust axis).
 */

import type { RocketParams, Telemetry, FlightStage } from '../types'
import * as V3 from './vec3'
import * as Q from './quat'
import type { Vec3 } from './vec3'
import type { Quat } from './quat'

// ═══════════════════════════ constants ═══════════════════════════

const G0 = 9.80665
const R_EARTH = 6_371_000
const R_ISA = 6_356_766
const R_AIR = 287.05287
const GAMMA = 1.4
const P_SL = 101325
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const wrapPi = (a: number) => {
  let r = (a + Math.PI) % (2 * Math.PI)
  if (r < 0) r += 2 * Math.PI
  return r - Math.PI
}
const smoothstep = (t: number) => {
  const c = clamp(t, 0, 1)
  return c * c * (3 - 2 * c)
}
const round = (v: number, d = 2) => {
  const k = 10 ** d
  const r = Math.round(v * k) / k
  return r === 0 ? 0 : r
}

// ═══════════════════════════ spherical gravity (3D) ═══════════════════════════
// The planet centre sits directly below the pad in the local frame. Gravity
// points from the vehicle's position toward that centre, magnitude
// g0 * (R_earth / r)^2 — now resolves properly in X, Y, AND Z, so
// out-of-plane (Z) drift also tilts gravity toward the true centre, same as
// the existing X-direction fix.
const PLANET_CENTER: Vec3 = [0, -R_EARTH, 0]

function gravityVector3(p: Vec3): { g: Vec3; mag: number; r: number } {
  const d = V3.sub(p, PLANET_CENTER)
  const r = Math.max(V3.length(d), 1)
  const mag = G0 * (R_EARTH / r) ** 2
  return { g: V3.scale(d, -mag / r), mag, r }
}

// ═══════════════════════════ ISA 1976 ═══════════════════════════

const ISA_H = [0, 11000, 20000, 32000, 47000, 51000, 71000]
const ISA_T = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65]
const ISA_L = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002]
const ISA_TOP_H = 84852

function layerAt(i: number, dh: number, pBase: number): { T: number; p: number } {
  const L = ISA_L[i]
  const Tb = ISA_T[i]
  if (Math.abs(L) < 1e-12) {
    return { T: Tb, p: pBase * Math.exp((-G0 * dh) / (R_AIR * Tb)) }
  }
  const T = Tb + L * dh
  return { T, p: pBase * Math.pow(T / Tb, -G0 / (R_AIR * L)) }
}

const ISA_P: number[] = [P_SL]
for (let i = 0; i < ISA_H.length - 1; i++) {
  ISA_P.push(layerAt(i, ISA_H[i + 1] - ISA_H[i], ISA_P[i]).p)
}
const ISA_TOP = layerAt(6, ISA_TOP_H - ISA_H[6], ISA_P[6])

export interface Atmosphere {
  T: number
  p: number
  rho: number
  a: number
}

export function isa1976(geometricAlt: number): Atmosphere {
  const hg = Math.max(geometricAlt, 0)
  const h = (R_ISA * hg) / (R_ISA + hg)
  let T: number
  let p: number
  if (h <= ISA_TOP_H) {
    let i = ISA_H.length - 1
    while (i > 0 && h < ISA_H[i]) i--
    const r = layerAt(i, h - ISA_H[i], ISA_P[i])
    T = r.T
    p = r.p
  } else {
    T = ISA_TOP.T
    p = ISA_TOP.p * Math.exp((-G0 * (h - ISA_TOP_H)) / (R_AIR * T))
  }
  return { T, p, rho: p / (R_AIR * T), a: Math.sqrt(GAMMA * R_AIR * T) }
}

// ═══════════════════════════ aerodynamics tables ═══════════════════════════

const CD_TABLE: Array<[number, number]> = [
  [0.0, 0.295], [0.6, 0.295], [0.8, 0.340], [0.9, 0.415], [1.0, 0.505],
  [1.1, 0.550], [1.2, 0.550], [1.5, 0.476], [2.0, 0.395], [3.0, 0.303],
  [5.0, 0.200], [10.0, 0.170],
]

function interp(table: Array<[number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1]
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1]
      const [x1, y1] = table[i]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return table[table.length - 1][1]
}

/** Cd(M) relative to the subsonic value, so the user's Cd scales the whole curve. */
const cdRatio = (mach: number) => interp(CD_TABLE, mach) / 0.295

/** Compressibility effect on fin normal-force slope (Prandtl-Glauert / supersonic). */
function finMachFactor(m: number): number {
  if (m < 0.8) return 1 / Math.sqrt(1 - m * m)
  if (m < 1.2) return 1 / Math.sqrt(1 - 0.64)
  return (1 / Math.sqrt(1 - 0.64)) * (0.663 / Math.sqrt(m * m - 1))
}

const CNA_NOSE = 2.0          // per rad, slender-body theory
const CA_REAR = 0.95          // axial coefficient flying tail-first (blunt base)
const CD_CROSS = 1.1          // finite-cylinder cross-flow drag coefficient
const BASE_RELIEF = 0.12      // power-on base-drag reduction (plume fills the base)

// ═══════════════════════════ vehicle geometry ═══════════════════════════

const FINENESS = 12
const NOSE_LEN_D = 3.0
const FIN_N = 4
const FIN_ROOT_D = 2.0
const FIN_TIP_D = 0.5
const FIN_SPAN_D = 0.8
const FIN_SWEEP_D = 1.1

const STRUCT_CG = 0.62        // fraction of length from nose
const PROP_CG = 0.45
const PROP_LEN = 0.40
const RCS_TANK = 0.12
const RCS_ARM = 0.60          // separation of the RCS couple, fraction of L

interface Geometry {
  D: number
  L: number
  Aref: number
  Aplan: number
  cnaFin: number
  xNose: number
  xFin: number
  xCross: number
  xStruct: number
  xProp: number
  xRcs: number
  tankLen: number
  tankR: number
  rcsCouple: number
}

function buildGeometry(p: RocketParams): Geometry {
  const Aref = Math.max(p.crossSectionArea, 0.005)
  const D = Math.sqrt((4 * Aref) / Math.PI)
  const L = FINENESS * D
  const Cr = FIN_ROOT_D * D
  const Ct = FIN_TIP_D * D
  const s = FIN_SPAN_D * D
  const xs = FIN_SWEEP_D * D
  const R = D / 2
  const Lm = Math.hypot(s, xs + (Ct - Cr) / 2)
  const cnaFin =
    ((1 + R / (s + R)) * (4 * FIN_N * (s / D) ** 2)) /
    (1 + Math.sqrt(1 + ((2 * Lm) / (Cr + Ct)) ** 2))
  const xFinLE = L - Cr
  const xFin =
    xFinLE + (xs * (Cr + 2 * Ct)) / (3 * (Cr + Ct)) + (1 / 6) * (Cr + Ct - (Cr * Ct) / (Cr + Ct))
  return {
    D, L, Aref,
    Aplan: L * D,
    cnaFin,
    xNose: 0.466 * NOSE_LEN_D * D,
    xFin,
    xCross: 0.55 * L,
    xStruct: STRUCT_CG * L,
    xProp: PROP_CG * L,
    xRcs: RCS_TANK * L,
    tankLen: PROP_LEN * L,
    tankR: 0.4 * D,
    rcsCouple: RCS_ARM * L,
  }
}

interface MassProps {
  m: number
  xcg: number
  I: number       // Ixx = Izz (pitch/yaw inertia, axisymmetric)
  Iyy: number      // roll inertia, about the body long axis
}

// ═══════════════════════════ control / actuator constants ═══════════════════════════

const GIMBAL_MAX = 6 * RAD
const GIMBAL_RATE = 25 * RAD
const GIMBAL_TAU = 0.05
const OMEGA_MAX = 30 * RAD           // commanded rate at full key deflection, per axis
const K_THETA = 1.8                  // attitude-hold outer loop (1/s)
const K_OMEGA = 6.0                  // rate inner loop (1/s)
const RCS_ACCEL = 30 * RAD           // RCS angular-acceleration authority, per axis
const RCS_DEADBAND = 0.04
// Movable aerodynamic control fins (grid-fin / all-moving-fin class). Their
// authority scales with dynamic pressure, so they take over from TVC exactly
// where TVC runs out of torque against the airframe's own stiffness.
const FIN_CTRL_MAX = 15 * RAD
const FIN_CTRL_RATE = 80 * RAD
const FIN_CTRL_TAU = 0.03
const FIN_CTRL_EFF = 0.75           // control effectiveness relative to fin CN_alpha
const ISP_COLD = 65

// ═══════════════════════════ propulsion constants ═══════════════════════════

const ISP_VAC_RATIO = 311 / 282      // vacuum/sea-level Isp of a bell nozzle
const IGN_TIME = 0.6
const IGN_FLOOR = 0.1
const TAILOFF = 0.25

// ═══════════════════════════ recovery / landing constants ═══════════════════════════

const CD_CHUTE = 1.5
const CHUTE_INFLATE = 2.0
const DROGUE_FRACTION = 0.025
const CHUTE_Q_MAX = 800
const MAIN_ALT = 350
const MAIN_Q_MAX = 1500
const LAND_V_MAX = 9
const LAND_TILT_MAX = 30 * RAD
const LAND_SPIN_MAX = 45 * RAD

// ═══════════════════════════ wind ═══════════════════════════

const WIND_H = [0, 10, 100, 500, 2000, 6000, 11000, 16000, 25000, 50000, 86000]
const WIND_M = [0.7, 1.0, 1.35, 1.8, 2.6, 4.6, 7.2, 4.2, 2.2, 1.2, 0.8]
const GUST_TAU = 3.0

const MAX_SUB_DT = 1 / 200

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ═══════════════════════════ types ═══════════════════════════

// 13-scalar flat state, matching 6dof-spec.md §2 exactly:
//  0: px  1: py  2: pz        position, local frame, metres
//  3: vx  4: vy  5: vz        velocity, local frame
//  6: qx  7: qy  8: qz  9: qw  orientation quaternion, body -> local
// 10: wx 11: wy 12: wz        angular velocity, BODY frame, rad/s
type State13 = [
  number, number, number,
  number, number, number,
  number, number, number, number,
  number, number, number,
]

const STATE_LEN = 13

/** Minimal raw pose for render-side fixed-step interpolation (see
 *  RocketPhysicsEngine.poseSnapshot()). px/py/pz match Telemetry's
 *  lateralOffset/altitude/positionZ exactly (same state slots, unrounded);
 *  qx/qy/qz/qw is the body->local orientation quaternion, unrounded and
 *  not yet decomposed into any Euler-style angle. */
export interface PoseSnapshot {
  time: number
  px: number; py: number; pz: number
  qx: number; qy: number; qz: number; qw: number
}

interface Ctx {
  m: number
  xcg: number
  Ixx: number       // = Izz, pitch/yaw
  Iyy: number       // roll
  IxxDot: number
  IyyDot: number
  T: number
  gimbalPitch: number
  gimbalYaw: number
  finPitch: number
  finYaw: number
  thrustFrac: number
  mdot: number
  tauRcs: Vec3       // body-frame RCS torque [x, y, z]
  gust: number
  chuteCdS: number
}

interface Diag {
  q: number
  mach: number
  alphaTotal: number   // total 3D angle of attack, radians
  alphaPitch: number
  alphaYaw: number
  V: number
  cdAxial: number
  sfAxialG: number
  sfLatG: number
  tauPassivePitch: number  // Z_body-axis passive torque (maps to old pitch)
  tauPassiveYaw: number    // X_body-axis passive torque
  windX: number
  a: Vec3                  // inertial acceleration, local frame
}

const ZERO_DIAG: Diag = {
  q: 0, mach: 0, alphaTotal: 0, alphaPitch: 0, alphaYaw: 0, V: 0, cdAxial: 0,
  sfAxialG: 0, sfLatG: 0, tauPassivePitch: 0, tauPassiveYaw: 0, windX: 0,
  a: [0, 0, 0],
}

export const EMPTY_TELEMETRY: Telemetry = {
  time: 0, altitude: 0, velocity: 0, acceleration: 0, mass: 0, stage: 'pre-launch',
  lateralOffset: 0, lateralVelocity: 0, bodyAngle: 0, angularVelocity: 0,
  gimbalAngle: 0, angleOfAttack: 0, dynamicPressure: 0, machNumber: 0,
  thrustNewtons: 0, isp: 0, twr: 0, maxQ: 0, maxMach: 0, propellantRemaining: 0,
  axialGLoad: 0, lateralGLoad: 0,
  airspeed: 0, flightPathAngle: 0, maxAltitude: 0,
  rcsFuel: 0, rcsTorque: 0, pitchRateCommand: 0, attitudeTarget: 0, gimbalCommand: 0,
  finAngle: 0, bodyLength: 0,
  positionZ: 0, velocityZ: 0, yawAngle: 0, rollAngle: 0, yawRate: 0, rollRate: 0,
  gimbalYawAngle: 0, finYawAngle: 0, rcsTorqueYaw: 0, rcsTorqueRoll: 0,
  staticMargin: 0, centerOfGravity: 0, centerOfPressure: 0, momentOfInertia: 0,
  airDensity: 1.225, airPressure: 101325, airTemperature: 288.15, speedOfSound: 340.29,
  windSpeed: 0, cdAxial: 0, chuteState: 0, outcome: 'flying', impactSpeed: 0,
}

// ═══════════════════════════ engine ═══════════════════════════

export class RocketPhysicsEngine {
  private params!: RocketParams
  private geom!: Geometry

  // vehicle constants derived from params
  private mdot0 = 0
  private fVac = 0
  private ae = 0
  private ispSl = 0
  private rcsGas0 = 0
  private structMass = 0
  private tauRcsMax = 0           // pitch/yaw RCS torque authority (uses Ixx)
  private tauRcsMaxRoll = 0       // roll RCS torque authority (uses Iyy)
  private chuteMainArea = 0

  // dynamic state
  private s: State13 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]
  private time = 0
  private tLaunch = 0
  private tBurnout: number | null = null
  private prop = 0
  private rcsGas = 0
  private gimbalPitch = 0
  private gimbalYaw = 0
  private gimbalCmd = 0           // pitch command, deg telemetry compat
  private gimbalYawCmd = 0
  private finPitch = 0
  private finYaw = 0
  private tauRcs: Vec3 = [0, 0, 0]
  private lastT = 0
  private lastMdot = 0
  private lastFrac = 0

  // control
  private pitchInput = 0
  private yawInput = 0
  private rollInput = 0
  private assist = true
  private attHoldPitch = 0        // rad, old theta convention (nose-right positive)
  private attHoldYaw = 0          // rad, nose-right(+X)-positive, matches pitch convention
  private attHoldRoll = 0         // rad, standard right-hand about +Y_body
  private omegaCmdPitch = 0
  private omegaCmdYaw = 0
  private omegaCmdRoll = 0

  // flight bookkeeping
  private stage: FlightStage = 'pre-launch'
  private maxAltitude = 0
  private maxQ = 0
  private maxMach = 0
  private liftedOff = false
  private railCleared = false
  private outcome: 'flying' | 'landed' | 'crashed' = 'flying'
  private aborted = false
  private impactSpeed = 0
  private chuteState: 0 | 1 | 2 = 0
  private tDrogue = 0
  private tMain = 0

  // environment
  private windScale = 0
  private gust = 0
  private rng: () => number = Math.random
  private diag: Diag = { ...ZERO_DIAG }

  constructor(params: RocketParams) {
    this.init(params)
  }

  reset(params: RocketParams): void {
    this.init(params)
  }

  private init(params: RocketParams): void {
    this.params = params
    this.geom = buildGeometry(params)

    this.mdot0 = params.burnRate > 1e-6 ? params.burnRate : params.thrust / (250 * G0)
    this.ispSl = params.thrust / (this.mdot0 * G0)
    this.fVac = params.thrust * ISP_VAC_RATIO
    this.ae = (this.fVac - params.thrust) / P_SL

    this.rcsGas0 = Math.max(0.25, 0.04 * params.dryMass)
    this.structMass = Math.max(params.dryMass - this.rcsGas0, 0.1)
    this.prop = Math.max(params.propellantMass, 0)
    this.rcsGas = this.rcsGas0

    const mp0 = this.massProps()
    this.tauRcsMax = RCS_ACCEL * mp0.I
    this.tauRcsMaxRoll = RCS_ACCEL * mp0.Iyy

    this.chuteMainArea =
      (2 * Math.max(params.dryMass, 1) * G0) / (1.225 * CD_CHUTE * 5.5 * 5.5)

    this.s = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]
    this.time = 0
    this.tLaunch = 0
    this.tBurnout = null
    this.gimbalPitch = 0
    this.gimbalYaw = 0
    this.gimbalCmd = 0
    this.gimbalYawCmd = 0
    this.finPitch = 0
    this.finYaw = 0
    this.tauRcs = [0, 0, 0]
    this.lastT = 0
    this.lastMdot = 0
    this.lastFrac = 0
    this.pitchInput = 0
    this.yawInput = 0
    this.rollInput = 0
    this.attHoldPitch = 0
    this.attHoldYaw = 0
    this.attHoldRoll = 0
    this.omegaCmdPitch = 0
    this.omegaCmdYaw = 0
    this.omegaCmdRoll = 0
    this.stage = 'pre-launch'
    this.maxAltitude = 0
    this.maxQ = 0
    this.maxMach = 0
    this.liftedOff = false
    this.railCleared = false
    this.outcome = 'flying'
    this.aborted = false
    this.impactSpeed = 0
    this.chuteState = 0
    this.tDrogue = 0
    this.tMain = 0
    this.windScale = 0
    this.gust = 0
    this.diag = { ...ZERO_DIAG }
  }

  // ───────────────────────── public API ─────────────────────────

  /** Arrow keys: -1 = pitch left, +1 = pitch right (commanded rate in assist mode). */
  setGimbalInput(input: number): void {
    this.pitchInput = clamp(input, -1, 1)
  }

  setPitchInput(input: number): void {
    this.setGimbalInput(input)
  }

  /** New in Phase 1 — physics-only; UI does not need to wire this up yet. */
  setYawInput(input: number): void {
    this.yawInput = clamp(input, -1, 1)
  }

  /** New in Phase 1 — physics-only; UI does not need to wire this up yet. */
  setRollInput(input: number): void {
    this.rollInput = clamp(input, -1, 1)
  }

  /** true: flight-computer rate command + attitude hold. false: raw gimbal. */
  setAssist(enabled: boolean): void {
    this.assist = enabled
  }

  launch(): void {
    if (this.stage !== 'pre-launch') return
    this.stage = 'powered-ascent'
    this.tLaunch = this.time
    this.rng = mulberry32((Math.random() * 4294967296) >>> 0)
    const sign = this.rng() < 0.5 ? -1 : 1
    this.windScale = sign * (2 + 4 * this.rng())
  }

  /** Flight termination — cuts thrust immediately and forces main-chute
   *  deployment, bypassing the normal altitude/speed/dynamic-pressure
   *  gates in updateChute(). Intended for a watchdog (flightWatchdog.ts)
   *  that detects runaway telemetry (tumbling, divergent rates) and calls
   *  this instead of letting the integration keep running into garbage
   *  numbers. Mirrors a real rocket's flight termination system: kill the
   *  engine, let aero/chute bring it down — does NOT force-zero rotation,
   *  since a real FTS doesn't either; the vehicle still has to physically
   *  stabilize (or not) under drag and chute forces. Idempotent — calling
   *  it again after an abort is already in progress is a no-op. */
  abort(): void {
    if (this.aborted) return
    if (this.stage === 'pre-launch' || this.outcome !== 'flying') return
    this.aborted = true
    this.prop = 0
    if (this.tBurnout === null) this.tBurnout = this.time
    // skip the drogue stage — force straight to main chute regardless of
    // the normal gates (altitude, descent rate, dynamic pressure), since
    // this is an emergency termination, not a nominal recovery sequence
    if (this.chuteState !== 2) {
      this.chuteState = 2
      this.tDrogue = this.time
      this.tMain = this.time
    }
  }

  /** True once abort() has fired for this flight — UI can show a
   *  termination banner, telemetry/log consumers can flag the session. */
  isAborted(): boolean {
    return this.aborted
  }

  step(dt: number): Telemetry {
    if (this.stage === 'pre-launch' || this.outcome !== 'flying') return this.snapshot()
    const total = clamp(dt, 0, 0.1)
    const n = Math.max(1, Math.ceil(total / MAX_SUB_DT))
    const h = total / n
    for (let i = 0; i < n && this.outcome === 'flying'; i++) this.subStep(h)
    this.updateStage()
    return this.snapshot()
  }

  // ───────────────────────── mass properties ─────────────────────────

  private massProps(prop = this.prop, gas = this.rcsGas): MassProps {
    const g = this.geom
    const ms = this.structMass
    const m = ms + prop + gas
    const xcg = (ms * g.xStruct + prop * g.xProp + gas * g.xRcs) / m

    // Ixx = Izz: pitch/yaw inertia, exactly the old scalar computation
    // (parallel-axis theorem along the body's long axis), reused unchanged
    // for both pitch and yaw planes by axisymmetry (6dof-spec.md §4).
    const Is = ms * ((g.L * g.L) / 12 + (g.xStruct - xcg) ** 2)
    const Ip = prop * ((3 * g.tankR * g.tankR + g.tankLen * g.tankLen) / 12 + (g.xProp - xcg) ** 2)
    const Ir = gas * (g.xRcs - xcg) ** 2
    const I = Math.max(Is + Ip + Ir, 0.5)

    // Iyy: roll inertia, about the body's long axis. Each lump contributes
    // ~0.5*m*r^2 (thin cylindrical shell/rod approximation) — no parallel-
    // axis term since the long axis passes through every lump's own centre.
    const IyyStruct = 0.5 * ms * (g.D / 2) ** 2
    const IyyProp = 0.5 * prop * g.tankR ** 2
    const IyyRcs = 0.5 * gas * (0.15 * g.D) ** 2
    const Iyy = Math.max(IyyStruct + IyyProp + IyyRcs, 0.05)

    return { m, xcg, I, Iyy }
  }

  // ───────────────────────── environment ─────────────────────────

  private windProfile(h: number): number {
    let k = WIND_M[WIND_M.length - 1]
    if (h <= WIND_H[0]) k = WIND_M[0]
    else {
      for (let i = 1; i < WIND_H.length; i++) {
        if (h <= WIND_H[i]) {
          const f = (h - WIND_H[i - 1]) / (WIND_H[i] - WIND_H[i - 1])
          k = WIND_M[i - 1] + f * (WIND_M[i] - WIND_M[i - 1])
          break
        }
      }
    }
    return this.windScale * k
  }

  private randn(): number {
    const u = Math.max(this.rng(), 1e-12)
    const v = this.rng()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  // ───────────────────────── force / torque model ─────────────────────────

  private deriv(s: State13, c: Ctx): { d: State13; dg: Diag } {
    const g = this.geom
    const p: Vec3 = [s[0], s[1], s[2]]
    const v: Vec3 = [s[3], s[4], s[5]]
    const q: Quat = [s[6], s[7], s[8], s[9]]
    const w: Vec3 = [s[10], s[11], s[12]]   // body-frame angular velocity

    const atm = isa1976(p[1])
    const windX = this.windProfile(p[1]) + c.gust
    const vRel: Vec3 = [v[0] - windX, v[1], v[2]]  // air-relative velocity, local frame
    const V = V3.length(vRel)
    const q_dyn = 0.5 * atm.rho * V * V
    const mach = V / atm.a

    // bring air-relative velocity into the body frame for the aero model
    const vBody = Q.qRotateInverse(q, vRel)
    const xcg = c.xcg

    let Fa = 0           // axial force magnitude (along +Y_body)
    let FnPitch = 0, FnYaw = 0   // normal-force components, X_body and Z_body
    let tauAeroPitch = 0, tauAeroYaw = 0
    let tauDampPitch = 0, tauDampYaw = 0
    let tauFinPitch = 0, tauFinYaw = 0
    let alphaTotal = 0, alphaPitch = 0, alphaYaw = 0, cdAxial = 0

    if (V > 0.05) {
      // total angle of attack: angle between body +Y and the air-relative
      // velocity, resolved in body frame (6dof-spec.md §5)
      const vBodyLen = V3.length(vBody)
      const caTotal = vBodyLen > 1e-9 ? clamp(vBody[1] / vBodyLen, -1, 1) : 1
      alphaTotal = Math.acos(caTotal)
      alphaPitch = Math.atan2(vBody[0], vBody[1])
      alphaYaw = Math.atan2(vBody[2], vBody[1])

      const sa = Math.sin(alphaTotal)
      const ca = caTotal

      const caFront = this.params.dragCoefficient * cdRatio(mach) * (1 - BASE_RELIEF * c.thrustFrac)
      cdAxial = ca >= 0 ? caFront : CA_REAR
      Fa = -q_dyn * g.Aref * cdAxial * ca

      const kM = finMachFactor(mach)
      const sac = sa * Math.abs(ca)
      const FnnMag = q_dyn * g.Aref * CNA_NOSE * sac
      const FnfMag = q_dyn * g.Aref * g.cnaFin * kM * sac
      const FncMag = q_dyn * g.Aplan * CD_CROSS * sa * Math.abs(sa)

      // split each force magnitude into pitch-plane (X_body) and yaw-plane
      // (Z_body) components, weighted by the body-frame velocity direction
      // in each plane — this is what makes two of the four fins primarily
      // resist pitch and two primarily resist yaw, with no extra bookkeeping
      const sinSum = Math.abs(Math.sin(alphaPitch)) + Math.abs(Math.sin(alphaYaw))
      const wPitch = sinSum > 1e-9 ? Math.sin(alphaPitch) / sinSum : 0
      const wYaw = sinSum > 1e-9 ? Math.sin(alphaYaw) / sinSum : 0
      // signed magnitude of normal force in each plane (restoring: force
      // direction opposes the local angle of attack, hence the -sign below
      // matching the old planar model's -sin(alpha) convention)
      const FnnP = -FnnMag * Math.abs(wPitch) * Math.sign(Math.sin(alphaPitch) || 1)
      const FnfP = -FnfMag * Math.abs(wPitch) * Math.sign(Math.sin(alphaPitch) || 1)
      const FncP = -FncMag * Math.abs(wPitch) * Math.sign(Math.sin(alphaPitch) || 1)
      const FnnY = -FnnMag * Math.abs(wYaw) * Math.sign(Math.sin(alphaYaw) || 1)
      const FnfY = -FnfMag * Math.abs(wYaw) * Math.sign(Math.sin(alphaYaw) || 1)
      const FncY = -FncMag * Math.abs(wYaw) * Math.sign(Math.sin(alphaYaw) || 1)

      FnPitch = FnnP + FnfP + FncP
      FnYaw = FnnY + FnfY + FncY

      const dn = g.xNose - xcg
      const df = g.xFin - xcg
      const dc = g.xCross - xcg
      // torque about Z_body (pitch axis) and X_body (yaw axis) — note the
      // minus sign matches the old convention's tau = -(x-xcg)*Fn exactly
      tauAeroPitch = -(dn * FnnP + df * FnfP + dc * FncP)
      tauAeroYaw = -(dn * FnnY + df * FnfY + dc * FncY)

      // pitch/yaw damping torque, same formula as the old model, evaluated
      // per axis using each axis's own body-frame rate
      const dampCoeff = (-q_dyn * g.Aref * (CNA_NOSE * dn * dn + g.cnaFin * kM * df * df)) / Math.max(V, 5)
      tauDampPitch = dampCoeff * (-w[2])   // wz maps to old omega with a sign flip
      tauDampYaw = dampCoeff * w[0]

      // movable control fins: force along the normal direction for
      // delta < 0, so +delta = nose-right/nose-out torque (matches old sign)
      const finPitchForce = -q_dyn * g.Aref * g.cnaFin * kM * FIN_CTRL_EFF * c.finPitch
      const finYawForce = -q_dyn * g.Aref * g.cnaFin * kM * FIN_CTRL_EFF * c.finYaw
      tauFinPitch = -df * finPitchForce
      tauFinYaw = -df * finYawForce
    }

    // thrust: body +Y axis deflected by (gimbalPitch about Z_body, gimbalYaw
    // about X_body), then rotated into the local frame by the body
    // quaternion (6dof-spec.md §6 — pitch gimbal deflects in the X_body-
    // Y_body plane, yaw gimbal in the Y_body-Z_body plane)
    const gp = c.gimbalPitch, gy = c.gimbalYaw
    const thrustDirBody: Vec3 = [-Math.sin(gp), Math.cos(gp) * Math.cos(gy), Math.cos(gp) * Math.sin(gy)]
    const Fthrust: Vec3 = V3.scale(thrustDirBody, c.T)
    const rNozzle: Vec3 = [0, -(g.L - xcg), 0]
    const tauThrustBody = V3.cross(rNozzle, Fthrust)

    // jet damping — resists pitch/yaw rate, zero contribution to roll (the
    // exhaust plume carries no roll moment of its own)
    const jetCoeff = -c.mdot * (g.L - xcg) ** 2
    const tauJetPitch = jetCoeff * (-w[2])
    const tauJetYaw = jetCoeff * w[0]

    // recovery chute, attached at the nose; forces/torque evaluated at the
    // attachment point's 3D air-relative velocity
    let Fchute: Vec3 = [0, 0, 0]
    let tauChuteBody: Vec3 = [0, 0, 0]
    if (c.chuteCdS > 0) {
      const rNose: Vec3 = [0, xcg, 0]   // nose relative to CG, along +Y_body
      const vPointLocal = V3.add(v, Q.qRotate(q, V3.cross(w, rNose)))
      const vaLocal: Vec3 = [vPointLocal[0] - windX, vPointLocal[1], vPointLocal[2]]
      const Va = V3.length(vaLocal)
      const k = 0.5 * atm.rho * Va * c.chuteCdS
      Fchute = V3.scale(vaLocal, -k)
      const FchuteBody = Q.qRotateInverse(q, Fchute)
      tauChuteBody = V3.cross(rNose, FchuteBody)
    }

    // non-gravitational force in BODY frame, then rotate to local for dv/dt
    const FnonGravBody: Vec3 = [FnPitch, Fa, FnYaw]
    const FnonGravLocal = V3.add(
      V3.add(Q.qRotate(q, FnonGravBody), Q.qRotate(q, Fthrust)),
      Fchute,
    )

    const { g: gravAccel } = gravityVector3(p)
    const a = V3.add(V3.scale(FnonGravLocal, 1 / c.m), gravAccel)

    // specific force for G-load telemetry — resolved along body axes
    const specificForceBody = V3.add(FnonGravBody, Q.qRotateInverse(q, V3.add(Fthrust, Fchute)))

    // total body-frame torque. tauAeroPitch/tauDampPitch/tauJetPitch/
    // tauFinPitch above are computed in OLD-CONVENTION units (positive =
    // nose-right, matching the planar model's tau = -(x-xcg)*Fn directly);
    // tauThrustBody/tauChuteBody/c.tauRcs are already true body-frame
    // (τx, τy, τz) quantities from actual cross products. Per the header's
    // sign-convention note, τ_z = -τ_old, so the old-convention pitch
    // torques are negated here when folded into the true τ_z axis. τ_x
    // (yaw) has no such old-convention ancestor — tauAeroYaw etc. are
    // defined directly as the X_body-axis torque, so they add unchanged.
    const tauX = tauAeroYaw + tauDampYaw + tauJetYaw + tauFinYaw + tauChuteBody[0] + tauThrustBody[0] + c.tauRcs[0]
    const tauZ = -(tauAeroPitch + tauDampPitch + tauJetPitch + tauFinPitch) + tauChuteBody[2] + tauThrustBody[2] + c.tauRcs[2]
    const tauY = tauChuteBody[1] + tauThrustBody[1] + c.tauRcs[1]
    const tauBody: Vec3 = [tauX, tauY, tauZ]

    // Euler's rotation equation: I*dw/dt = tau - w x (I*w) - dI/dt * w
    const Ivec: Vec3 = [c.Ixx, c.Iyy, c.Ixx]      // diag(Ixx, Iyy, Izz), Izz = Ixx
    const IdotVec: Vec3 = [c.IxxDot, c.IyyDot, c.IxxDot]
    const Iw = V3.mulComponents(Ivec, w)
    const gyro = V3.cross(w, Iw)
    const IdotW = V3.mulComponents(IdotVec, w)
    const netTau = V3.sub(V3.sub(tauBody, gyro), IdotW)
    const dw: Vec3 = [netTau[0] / Ivec[0], netTau[1] / Ivec[1], netTau[2] / Ivec[2]]

    const dq = Q.qDerivative(q, w)

    const d: State13 = [
      v[0], v[1], v[2],
      a[0], a[1], a[2],
      dq[0], dq[1], dq[2], dq[3],
      dw[0], dw[1], dw[2],
    ]

    return {
      d,
      dg: {
        q: q_dyn, mach, alphaTotal, alphaPitch, alphaYaw, V, cdAxial,
        sfAxialG: specificForceBody[1] / (c.m * G0),
        sfLatG: Math.hypot(specificForceBody[0], specificForceBody[2]) / (c.m * G0),
        tauPassivePitch: tauAeroPitch + tauDampPitch + tauJetPitch,
        tauPassiveYaw: tauAeroYaw + tauDampYaw + tauJetYaw,
        windX,
        a,
      },
    }
  }

  // ───────────────────────── one integration step ─────────────────────────

  private subStep(h: number): void {
    const s = this.s

    // ---- engine state ----
    const atm0 = isa1976(s[1])
    const tNow = this.time - this.tLaunch
    let frac = 0
    let mdot = 0
    let consumed = 0
    if (this.prop > 0) {
      frac = tNow < IGN_TIME ? IGN_FLOOR + (1 - IGN_FLOOR) * smoothstep(tNow / IGN_TIME) : 1
      consumed = Math.min(this.prop, this.mdot0 * frac * h)
      mdot = consumed / h
      if (this.prop - consumed <= 1e-9) {
        consumed = this.prop
        this.tBurnout = this.time + h
      }
    } else if (this.tBurnout !== null) {
      frac = Math.max(0, 1 - (this.time - this.tBurnout) / TAILOFF)
    }
    const T = frac > 0 ? Math.max(0, frac * this.fVac - atm0.p * this.ae) : 0

    // ---- mass properties (start, end, midpoint) ----
    const mp0 = this.massProps()
    const propEnd = Math.max(this.prop - consumed, 0)

    // ---- recovery logic ----
    this.updateChute(this.diag.q, s)
    const chuteCdS = this.chuteArea() * CD_CHUTE

    // ---- flight computer ----
    const preCtx: Ctx = {
      m: mp0.m, xcg: mp0.xcg, Ixx: mp0.I, Iyy: mp0.Iyy, IxxDot: 0, IyyDot: 0, T,
      gimbalPitch: this.gimbalPitch, gimbalYaw: this.gimbalYaw,
      finPitch: this.finPitch, finYaw: this.finYaw,
      thrustFrac: frac, mdot, tauRcs: [0, 0, 0], gust: this.gust, chuteCdS,
    }
    const pre = this.deriv(s, preCtx)
    let rcsUsed = 0
    this.controlStep(s, pre.dg.tauPassivePitch, pre.dg.tauPassiveYaw, pre.dg.q, pre.dg.mach, mp0, T, h, chuteCdS > 0, (u) => (rcsUsed = u))

    const gasEnd = Math.max(this.rcsGas - rcsUsed, 0)
    const mp1 = this.massProps(propEnd, gasEnd)
    const mpm: MassProps = {
      m: 0.5 * (mp0.m + mp1.m),
      xcg: 0.5 * (mp0.xcg + mp1.xcg),
      I: 0.5 * (mp0.I + mp1.I),
      Iyy: 0.5 * (mp0.Iyy + mp1.Iyy),
    }

    // ---- gusts (Ornstein-Uhlenbeck) ----
    const sigma = 0.1 * Math.abs(this.windProfile(s[1])) + 0.25
    this.gust += (-this.gust / GUST_TAU) * h + sigma * Math.sqrt((2 * h) / GUST_TAU) * this.randn()

    // ---- RK4 ----
    const ctx: Ctx = {
      m: mpm.m, xcg: mpm.xcg, Ixx: mpm.I, Iyy: mpm.Iyy,
      IxxDot: (mp1.I - mp0.I) / h, IyyDot: (mp1.Iyy - mp0.Iyy) / h, T,
      gimbalPitch: this.gimbalPitch, gimbalYaw: this.gimbalYaw,
      finPitch: this.finPitch, finYaw: this.finYaw,
      thrustFrac: frac, mdot, tauRcs: this.tauRcs,
      gust: this.gust, chuteCdS,
    }
    const k1 = this.deriv(s, ctx)
    const k2 = this.deriv(this.addScaled(s, k1.d, h / 2), ctx)
    const k3 = this.deriv(this.addScaled(s, k2.d, h / 2), ctx)
    const k4 = this.deriv(this.addScaled(s, k3.d, h), ctx)
    for (let i = 0; i < STATE_LEN; i++) {
      s[i] += (h / 6) * (k1.d[i] + 2 * k2.d[i] + 2 * k3.d[i] + k4.d[i])
    }

    // renormalize the orientation quaternion — MUST happen after every RK4
    // step (6dof-spec.md §7); numerical drift otherwise grows |q| off the
    // unit sphere over a long flight
    const qn = Q.qNormalize([s[6], s[7], s[8], s[9]])
    s[6] = qn[0]; s[7] = qn[1]; s[8] = qn[2]; s[9] = qn[3]

    this.prop = propEnd
    this.rcsGas = gasEnd
    this.time += h
    this.lastT = T
    this.lastMdot = mdot
    this.lastFrac = frac
    this.diag = k1.dg

    // ---- rail, pad and ground ----
    this.applyConstraints()

    this.maxAltitude = Math.max(this.maxAltitude, s[1])
    this.maxQ = Math.max(this.maxQ, k1.dg.q)
    this.maxMach = Math.max(this.maxMach, k1.dg.mach)
  }

  private addScaled(s: State13, d: State13, k: number): State13 {
    const out = new Array(STATE_LEN) as State13
    for (let i = 0; i < STATE_LEN; i++) out[i] = s[i] + k * d[i]
    return out
  }

  // ───────────────────────── flight computer ─────────────────────────

  private controlStep(
    s: State13, tauPassivePitch: number, tauPassiveYaw: number, qDyn: number, mach: number,
    mp: MassProps, T: number, h: number,
    chuteOut: boolean, setRcsUsed: (u: number) => void,
  ): void {
    const g = this.geom
    const w: Vec3 = [s[10], s[11], s[12]]
    // old-convention pitch angle/rate: bodyAngle = atan2(bodyDir.x, bodyDir.y)
    const q: Quat = [s[6], s[7], s[8], s[9]]
    const bodyDir = Q.qRotate(q, [0, 1, 0])
    const thPitch = Math.atan2(bodyDir[0], bodyDir[1])
    const thYaw = Math.atan2(bodyDir[2], bodyDir[1])
    const omPitch = -w[2]   // maps body wz to old clockwise-positive omega
    const omYaw = w[0]
    const omRoll = w[1]

    const arm = g.L - mp.xcg
    let gimCmdPitch = 0, gimCmdYaw = 0
    let finCmdPitch = 0, finCmdYaw = 0
    const tauRcsOut: [number, number, number] = [0, 0, 0]
    let rcsUsed = 0

    const active = this.liftedOff || this.railCleared || this.stage === 'powered-ascent'
    if (!chuteOut && active) {
      if (this.assist) {
        // ---- pitch axis ----
        let omCmdPitch: number
        if (Math.abs(this.pitchInput) > 0.01) {
          omCmdPitch = this.pitchInput * OMEGA_MAX
          this.attHoldPitch = wrapPi(thPitch + omPitch * 0.3)
        } else {
          omCmdPitch = clamp(K_THETA * wrapPi(this.attHoldPitch - thPitch), -OMEGA_MAX, OMEGA_MAX)
        }
        this.omegaCmdPitch = omCmdPitch
        const tauNeedPitch = mp.I * K_OMEGA * (omCmdPitch - omPitch) - tauPassivePitch

        // ---- yaw axis (same structure, independent) ----
        let omCmdYaw: number
        if (Math.abs(this.yawInput) > 0.01) {
          omCmdYaw = this.yawInput * OMEGA_MAX
          this.attHoldYaw = wrapPi(thYaw + omYaw * 0.3)
        } else {
          omCmdYaw = clamp(K_THETA * wrapPi(this.attHoldYaw - thYaw), -OMEGA_MAX, OMEGA_MAX)
        }
        this.omegaCmdYaw = omCmdYaw
        const tauNeedYaw = mp.I * K_OMEGA * (omCmdYaw - omYaw) - tauPassiveYaw

        // ---- roll axis — RCS only, no TVC/fin authority (6dof-spec.md §6) ----
        let omCmdRoll: number
        if (Math.abs(this.rollInput) > 0.01) {
          omCmdRoll = this.rollInput * OMEGA_MAX
          this.attHoldRoll = wrapPi(0 + omRoll * 0.3)
        } else {
          omCmdRoll = clamp(K_THETA * wrapPi(this.attHoldRoll - 0), -OMEGA_MAX, OMEGA_MAX)
          // roll has no particular orientation that matters for an unguided
          // ascent — hold current roll by tracking zero relative to itself
          this.attHoldRoll = 0
          omCmdRoll = Math.abs(this.rollInput) > 0.01 ? omCmdRoll : clamp(-K_THETA * 0, -OMEGA_MAX, OMEGA_MAX)
        }
        this.omegaCmdRoll = omCmdRoll
        const tauNeedRoll = mp.Iyy * K_OMEGA * (omCmdRoll - omRoll)

        // control allocation for pitch/yaw: share demanded torque between
        // TVC and aero fins in proportion to current authority
        const sinMax = Math.sin(GIMBAL_MAX)
        const tvcAuth = T > 1 && arm > 0.05 ? T * arm * sinMax : 0
        const finLever = Math.max(g.xFin - mp.xcg, 0)
        const finGain =
          qDyn * g.Aref * g.cnaFin * finMachFactor(mach) * FIN_CTRL_EFF * finLever
        const finAuth = finGain * FIN_CTRL_MAX
        const authSum = tvcAuth + finAuth

        const allocate = (tauNeed: number): { gim: number; fin: number; tauGim: number; tauFin: number } => {
          if (authSum <= 1e-9) return { gim: 0, fin: 0, tauGim: 0, tauFin: 0 }
          const total = clamp(tauNeed, -authSum, authSum)
          const tauG = (total * tvcAuth) / authSum
          const tauF = (total * finAuth) / authSum
          let gim = 0, tauGim = 0
          let fin = 0, tauFin = 0
          if (tvcAuth > 0) {
            gim = Math.asin(clamp(tauG / (T * arm), -sinMax, sinMax))
            tauGim = T * Math.sin(gim) * arm
          }
          if (finGain > 1e-9) {
            fin = clamp(tauF / finGain, -FIN_CTRL_MAX, FIN_CTRL_MAX)
            tauFin = finGain * fin
          }
          return { gim, fin, tauGim, tauFin }
        }

        const allocPitch = allocate(tauNeedPitch)
        const allocYaw = allocate(tauNeedYaw)
        gimCmdPitch = allocPitch.gim
        finCmdPitch = allocPitch.fin
        gimCmdYaw = allocYaw.gim
        finCmdYaw = allocYaw.fin

        const residPitch = tauNeedPitch - allocPitch.tauGim - allocPitch.tauFin
        const residYaw = tauNeedYaw - allocYaw.tauGim - allocYaw.tauFin

        // RCS: pitch/yaw residual (maps to body Z/X axes) plus roll, sharing
        // one finite cold-gas budget (6dof-spec.md §6)
        let tauRcsZ = 0, tauRcsX = 0, tauRcsY = 0
        let gasWanted = 0
        if (Math.abs(residPitch) > RCS_DEADBAND * this.tauRcsMax && this.rcsGas > 0) {
          tauRcsZ = clamp(-residPitch, -this.tauRcsMax, this.tauRcsMax)  // -residPitch: tauZ maps to -old pitch torque
          const force = Math.abs(tauRcsZ) / g.rcsCouple
          gasWanted += ((2 * force) / (ISP_COLD * G0)) * h
        }
        if (Math.abs(residYaw) > RCS_DEADBAND * this.tauRcsMax && this.rcsGas > 0) {
          tauRcsX = clamp(residYaw, -this.tauRcsMax, this.tauRcsMax)
          const force = Math.abs(tauRcsX) / g.rcsCouple
          gasWanted += ((2 * force) / (ISP_COLD * G0)) * h
        }
        if (Math.abs(tauNeedRoll) > RCS_DEADBAND * this.tauRcsMaxRoll && this.rcsGas > 0) {
          tauRcsY = clamp(tauNeedRoll, -this.tauRcsMaxRoll, this.tauRcsMaxRoll)
          const force = Math.abs(tauRcsY) / g.rcsCouple
          gasWanted += ((2 * force) / (ISP_COLD * G0)) * h
        }
        if (gasWanted > 0) {
          const gasAvail = Math.min(gasWanted, this.rcsGas)
          const scale = gasAvail / gasWanted
          tauRcsZ *= scale; tauRcsX *= scale; tauRcsY *= scale
          rcsUsed = gasAvail
        }
        tauRcsOut[0] = tauRcsX
        tauRcsOut[1] = tauRcsY
        tauRcsOut[2] = tauRcsZ
      } else {
        this.omegaCmdPitch = 0
        this.omegaCmdYaw = 0
        this.omegaCmdRoll = 0
        gimCmdPitch = T > 1 ? this.pitchInput * GIMBAL_MAX : 0
        gimCmdYaw = T > 1 ? this.yawInput * GIMBAL_MAX : 0
        finCmdPitch = this.pitchInput * FIN_CTRL_MAX
        finCmdYaw = this.yawInput * FIN_CTRL_MAX
        if (Math.abs(this.rollInput) > 0.01 && this.rcsGas > 0) {
          tauRcsOut[1] = clamp(this.rollInput * this.tauRcsMaxRoll, -this.tauRcsMaxRoll, this.tauRcsMaxRoll)
          const force = Math.abs(tauRcsOut[1]) / g.rcsCouple
          rcsUsed = Math.min(((2 * force) / (ISP_COLD * G0)) * h, this.rcsGas)
        }
      }
    } else {
      this.omegaCmdPitch = 0
      this.omegaCmdYaw = 0
      this.omegaCmdRoll = 0
    }

    // gimbal actuators: first-order lag, rate limit, travel limit — per axis
    const rateP = clamp((gimCmdPitch - this.gimbalPitch) / GIMBAL_TAU, -GIMBAL_RATE, GIMBAL_RATE)
    this.gimbalPitch = clamp(this.gimbalPitch + rateP * h, -GIMBAL_MAX, GIMBAL_MAX)
    this.gimbalCmd = gimCmdPitch

    const rateY = clamp((gimCmdYaw - this.gimbalYaw) / GIMBAL_TAU, -GIMBAL_RATE, GIMBAL_RATE)
    this.gimbalYaw = clamp(this.gimbalYaw + rateY * h, -GIMBAL_MAX, GIMBAL_MAX)
    this.gimbalYawCmd = gimCmdYaw

    // control-fin actuators: same structure, faster, own travel limit
    const frateP = clamp((finCmdPitch - this.finPitch) / FIN_CTRL_TAU, -FIN_CTRL_RATE, FIN_CTRL_RATE)
    this.finPitch = clamp(this.finPitch + frateP * h, -FIN_CTRL_MAX, FIN_CTRL_MAX)

    const frateY = clamp((finCmdYaw - this.finYaw) / FIN_CTRL_TAU, -FIN_CTRL_RATE, FIN_CTRL_RATE)
    this.finYaw = clamp(this.finYaw + frateY * h, -FIN_CTRL_MAX, FIN_CTRL_MAX)

    this.tauRcs = tauRcsOut
    setRcsUsed(rcsUsed)
  }

  // ───────────────────────── recovery ─────────────────────────

  private updateChute(q: number, s: State13): void {
    const burnedOut = this.prop <= 0 && this.tBurnout !== null && this.time > this.tBurnout + TAILOFF
    if (this.chuteState === 0) {
      if (burnedOut && s[4] < -1 && s[1] > 20 && q < CHUTE_Q_MAX) {
        this.chuteState = 1
        this.tDrogue = this.time
      }
    } else if (this.chuteState === 1) {
      if (s[4] < 0 && s[1] < MAIN_ALT && s[1] > 15 && q < MAIN_Q_MAX) {
        this.chuteState = 2
        this.tMain = this.time
      }
    }
  }

  private chuteArea(): number {
    if (this.chuteState === 0) return 0
    const drogue = DROGUE_FRACTION * this.chuteMainArea * smoothstep((this.time - this.tDrogue) / CHUTE_INFLATE)
    const main = this.chuteState === 2
      ? this.chuteMainArea * smoothstep((this.time - this.tMain) / CHUTE_INFLATE)
      : 0
    return drogue + main
  }

  // ───────────────────────── rail / ground ─────────────────────────

  private applyConstraints(): void {
    const s = this.s
    const g = this.geom

    if (s[1] > 0.05) this.liftedOff = true

    if (!this.railCleared) {
      if (s[1] >= g.L) {
        this.railCleared = true
      } else {
        // constrain to vertical motion only, zero all rotation, while on the rail
        s[0] = 0; s[2] = 0; s[3] = 0; s[5] = 0
        s[6] = 0; s[7] = 0; s[8] = 0; s[9] = 1
        s[10] = 0; s[11] = 0; s[12] = 0
      }
    }

    if (s[1] <= 0 && s[4] <= 0) {
      if (this.liftedOff && this.railCleared) {
        this.touchdown()
        return
      }
      s[1] = 0
      s[4] = 0
    }
  }

  private touchdown(): void {
    const s = this.s
    this.impactSpeed = V3.length([s[3], s[4], s[5]])
    const q: Quat = [s[6], s[7], s[8], s[9]]
    const bodyDir = Q.qRotate(q, [0, 1, 0])
    const tiltFromVertical = Math.acos(clamp(bodyDir[1], -1, 1))
    const spin = V3.length([s[10], s[11], s[12]])
    this.outcome =
      this.impactSpeed <= LAND_V_MAX && tiltFromVertical <= LAND_TILT_MAX && spin <= LAND_SPIN_MAX
        ? 'landed'
        : 'crashed'
    s[1] = 0; s[3] = 0; s[4] = 0; s[5] = 0
    s[10] = 0; s[11] = 0; s[12] = 0
    this.gimbalPitch = 0; this.gimbalYaw = 0; this.gimbalCmd = 0; this.gimbalYawCmd = 0
    this.finPitch = 0; this.finYaw = 0; this.tauRcs = [0, 0, 0]
    this.lastT = 0; this.lastMdot = 0; this.lastFrac = 0
    this.omegaCmdPitch = 0; this.omegaCmdYaw = 0; this.omegaCmdRoll = 0
  }

  // ───────────────────────── flight stage ─────────────────────────

  private updateStage(): void {
    if (this.outcome !== 'flying') { this.stage = 'descent'; return }
    if (this.prop > 0 || this.lastFrac > 0) { this.stage = 'powered-ascent'; return }
    if (!this.liftedOff) { this.stage = 'descent'; return }
    const vy = this.s[4]
    const nearPeak = this.s[1] >= this.maxAltitude - 0.05
    if (vy > 0.5) this.stage = 'coast'
    else if (nearPeak && Math.abs(vy) <= 0.5) this.stage = 'apogee'
    else this.stage = 'descent'
  }

  // ───────────────────────── telemetry ─────────────────────────

  snapshot(): Telemetry {
    const g = this.geom
    const s = this.s
    const mp = this.massProps()
    const atm = isa1976(s[1])
    const d = this.diag
    const q: Quat = [s[6], s[7], s[8], s[9]]
    const w: Vec3 = [s[10], s[11], s[12]]

    const cnaN = CNA_NOSE
    const cnaF = g.cnaFin * finMachFactor(d.mach)
    const xcp = (cnaN * g.xNose + cnaF * g.xFin) / (cnaN + cnaF)
    const { g: gravVec } = gravityVector3([s[0], s[1], s[2]])
    const grav = V3.length(gravVec)
    const speed = V3.length([s[3], s[4], s[5]])
    const fpa = speed > 0.5 ? Math.atan2(s[3], s[4]) * DEG : 0

    // old-convention pitch angle/rate: nose-right positive, from body +Y
    // expressed in the local frame — matches the planar model exactly when
    // yaw/roll are zero (6dof-spec.md §2 sign-convention note)
    const bodyDir = Q.qRotate(q, [0, 1, 0])
    const bodyAngle = Math.atan2(bodyDir[0], bodyDir[1])
    const yawAngle = Math.atan2(bodyDir[2], bodyDir[1])
    const { roll: rollAngle } = Q.qToPitchYawRoll(q)
    const omegaPitch = -w[2]
    const omegaYaw = w[0]
    const omegaRoll = w[1]

    return {
      time: round(this.time),
      altitude: round(s[1]),
      velocity: round(s[4]),
      acceleration: round(d.a[1]),
      mass: round(mp.m),
      stage: this.stage,

      lateralOffset: round(s[0]),
      lateralVelocity: round(s[3]),

      bodyAngle: round(bodyAngle * DEG),
      angularVelocity: round(omegaPitch * DEG),
      gimbalAngle: round(this.gimbalPitch * DEG),
      angleOfAttack: round(Math.abs(d.alphaTotal) * DEG),

      dynamicPressure: round(d.q),
      machNumber: round(d.mach, 4),
      thrustNewtons: round(this.lastT),
      isp: round(this.lastMdot > 1e-9 ? this.lastT / (this.lastMdot * G0) : 0),
      twr: round(this.lastT / (mp.m * grav)),
      maxQ: round(this.maxQ),
      maxMach: round(this.maxMach, 4),
      propellantRemaining: round(this.prop),

      axialGLoad: round(d.sfAxialG, 3),
      lateralGLoad: round(d.sfLatG, 3),

      airspeed: round(d.V),
      flightPathAngle: round(fpa),
      maxAltitude: round(this.maxAltitude),

      rcsFuel: round(this.rcsGas, 3),
      rcsTorque: round(this.tauRcs[2]),
      pitchRateCommand: round(this.omegaCmdPitch * DEG),
      attitudeTarget: round(this.attHoldPitch * DEG),
      gimbalCommand: round(this.gimbalCmd * DEG),
      finAngle: round(this.finPitch * DEG),
      bodyLength: round(g.L, 3),

      positionZ: round(s[2]),
      velocityZ: round(s[5]),
      yawAngle: round(yawAngle * DEG),
      rollAngle: round(rollAngle * DEG),
      yawRate: round(omegaYaw * DEG),
      rollRate: round(omegaRoll * DEG),
      gimbalYawAngle: round(this.gimbalYaw * DEG),
      finYawAngle: round(this.finYaw * DEG),
      rcsTorqueYaw: round(this.tauRcs[0]),
      rcsTorqueRoll: round(this.tauRcs[1]),

      staticMargin: round((xcp - mp.xcg) / g.D),
      centerOfGravity: round(mp.xcg),
      centerOfPressure: round(xcp),
      momentOfInertia: round(mp.I),

      airDensity: round(atm.rho, 5),
      airPressure: round(atm.p),
      airTemperature: round(atm.T),
      speedOfSound: round(atm.a),
      windSpeed: round(d.windX),
      cdAxial: round(d.cdAxial, 3),

      chuteState: this.chuteState,
      outcome: this.outcome,
      impactSpeed: round(this.impactSpeed),
    }
  }

  /** Raw render-pose state (position + orientation quaternion), unrounded,
   *  taken directly from the 13-scalar integrator state. Additive only --
   *  Telemetry and snapshot() are untouched. Added so the render loop can
   *  run a fixed-step accumulator with interpolation: snapshot() alone
   *  isn't enough for that, because bodyAngle/yawAngle/rollAngle are
   *  Euler-like *derived* quantities (atan2 projections of the quaternion),
   *  and SLERPing between two decomposed-angle snapshots is not the same
   *  operation as SLERPing the true orientation -- it can take the wrong
   *  short way around near a ±180° wrap or through a projection
   *  singularity the atan2 decomposition introduces. The render side must
   *  interpolate the raw quaternion and re-derive any Euler-style angle
   *  from the *interpolated* quaternion, never interpolate the angles
   *  themselves. */
  poseSnapshot(): PoseSnapshot {
    const s = this.s
    return {
      time: this.time,
      px: s[0], py: s[1], pz: s[2],
      qx: s[6], qy: s[7], qz: s[8], qw: s[9],
    }
  }

  // ───────────────────────── diagnostics for tests ─────────────────────────

  /** Vehicle constants derived from the params (used by the validation script). */
  describe() {
    const mp = this.massProps()
    return {
      diameter: this.geom.D,
      length: this.geom.L,
      finCNalpha: this.geom.cnaFin,
      ispSeaLevel: this.ispSl,
      ispVacuum: this.ispSl * ISP_VAC_RATIO,
      exitArea: this.ae,
      initialMass: mp.m,
      initialInertia: mp.I,
      initialInertiaRoll: mp.Iyy,
      rcsTorqueMax: this.tauRcsMax,
      rcsTorqueMaxRoll: this.tauRcsMaxRoll,
      chuteMainArea: this.chuteMainArea,
    }
  }
}