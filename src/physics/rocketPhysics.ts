/**
 * rocketPhysics.ts — planar (3-DOF) rigid-body rocket flight simulator.
 *
 * State: x, y, vx, vy, theta (pitch), omega (pitch rate). RK4 at <=200 Hz.
 *
 *  ATMOSPHERE   ISA 1976, 7 layers, exact base pressures chained from sea
 *               level, density from the ideal-gas law, geopotential altitude
 *               (r0 = 6,356,766 m), isothermal exponential tail above 84.85 km.
 *  WIND         altitude profile (jet-stream peak near 11 km) + Ornstein-
 *               Uhlenbeck gusts. Aerodynamics use AIR-RELATIVE velocity.
 *  GEOMETRY     derived from the launch params: reference area -> diameter,
 *               fineness ratio 12, 4 swept fins, ogive nose.
 *  AERO         axial force (Mach-dependent Cd, separate tail-first Cd),
 *               normal force over the FULL angle-of-attack range 0..180 deg
 *               (potential-flow term sin(a)|cos(a)| for nose + fins, cross-flow
 *               term sin(a)|sin(a)|), Barrowman CN_alpha and CP, Mach-corrected
 *               fin effectiveness, pitch damping from the same station sums.
 *               Tail-first flight is naturally unstable; no clamps anywhere.
 *  PROPULSION   F = f*F_vac - p_ambient*A_exit, mdot = f*mdot0 (burn rate from
 *               the params), ignition ramp, tail-off, jet damping.
 *  MASS         structure + propellant + RCS gas, CG and pitch inertia from
 *               the parallel-axis theorem, dI/dt term in the rotational eqn.
 *  CONTROL      rate-command attitude hold (flight computer): arrow keys
 *               command a pitch rate; on release it holds attitude. Torque is
 *               allocated across TVC (+-6 deg) and movable aerodynamic
 *               control fins (+-15 deg, authority ~ dynamic pressure), shared
 *               in proportion to available authority; RCS cold gas (finite
 *               budget) mops up whatever is left. All actuators are rate and
 *               lag limited.
 *  RECOVERY     drogue then main chute attached at the nose, forces evaluated
 *               at the attachment point velocity (gives real damping).
 *  GROUND       launch rail, hold-down, soft landing vs crash from impact
 *               speed / tilt / spin.
 *
 * Conventions: +Y up, +X right. theta = pitch from vertical, CLOCKWISE
 * positive (right = positive). Body axis b = (sin t, cos t), normal
 * n = (cos t, -sin t). Torque about the CG, clockwise-positive, of a force F
 * applied at station x (measured from the nose, aft positive):
 *     tau = -(x - x_cg) * (F . n)
 * Positive telemetry gimbalAngle = nozzle swung right = nose torque to the right.
 */

import type { RocketParams, Telemetry, FlightStage } from '../types'

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
  I: number
}

// ═══════════════════════════ control / actuator constants ═══════════════════════════

const GIMBAL_MAX = 6 * RAD
const GIMBAL_RATE = 25 * RAD
const GIMBAL_TAU = 0.05
const OMEGA_MAX = 30 * RAD           // commanded pitch rate at full key deflection
const K_THETA = 1.8                  // attitude-hold outer loop (1/s)
const K_OMEGA = 6.0                  // rate inner loop (1/s)
const RCS_ACCEL = 30 * RAD           // RCS angular-acceleration authority
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

type Vec6 = [number, number, number, number, number, number]

interface Ctx {
  m: number
  xcg: number
  I: number
  Idot: number
  T: number
  gimbal: number
  fin: number
  thrustFrac: number
  mdot: number
  tauRcs: number
  gust: number
  chuteCdS: number
}

interface Diag {
  q: number
  mach: number
  alpha: number
  V: number
  cdAxial: number
  sfAxialG: number
  sfLatG: number
  tauPassive: number
  windX: number
  ax: number
  ay: number
}

const ZERO_DIAG: Diag = {
  q: 0, mach: 0, alpha: 0, V: 0, cdAxial: 0, sfAxialG: 0, sfLatG: 0,
  tauPassive: 0, windX: 0, ax: 0, ay: 0,
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
  private tauRcsMax = 0
  private chuteMainArea = 0

  // dynamic state
  private s: Vec6 = [0, 0, 0, 0, 0, 0]
  private time = 0
  private tLaunch = 0
  private tBurnout: number | null = null
  private prop = 0
  private rcsGas = 0
  private gimbal = 0
  private gimbalCmd = 0
  private fin = 0
  private tauRcs = 0
  private lastT = 0
  private lastMdot = 0
  private lastFrac = 0

  // control
  private pitchInput = 0
  private assist = true
  private attHold = 0
  private omegaCmd = 0

  // flight bookkeeping
  private stage: FlightStage = 'pre-launch'
  private maxAltitude = 0
  private maxQ = 0
  private maxMach = 0
  private liftedOff = false
  private railCleared = false
  private outcome: 'flying' | 'landed' | 'crashed' = 'flying'
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

    this.chuteMainArea =
      (2 * Math.max(params.dryMass, 1) * G0) / (1.225 * CD_CHUTE * 5.5 * 5.5)

    this.s = [0, 0, 0, 0, 0, 0]
    this.time = 0
    this.tLaunch = 0
    this.tBurnout = null
    this.gimbal = 0
    this.gimbalCmd = 0
    this.fin = 0
    this.tauRcs = 0
    this.lastT = 0
    this.lastMdot = 0
    this.lastFrac = 0
    this.pitchInput = 0
    this.attHold = 0
    this.omegaCmd = 0
    this.stage = 'pre-launch'
    this.maxAltitude = 0
    this.maxQ = 0
    this.maxMach = 0
    this.liftedOff = false
    this.railCleared = false
    this.outcome = 'flying'
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
    const Is = ms * ((g.L * g.L) / 12 + (g.xStruct - xcg) ** 2)
    const Ip = prop * ((3 * g.tankR * g.tankR + g.tankLen * g.tankLen) / 12 + (g.xProp - xcg) ** 2)
    const Ir = gas * (g.xRcs - xcg) ** 2
    return { m, xcg, I: Math.max(Is + Ip + Ir, 0.5) }
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

  private deriv(s: Vec6, c: Ctx): { d: Vec6; dg: Diag } {
    const g = this.geom
    const y = s[1], vx = s[2], vy = s[3], th = s[4], om = s[5]

    const atm = isa1976(y)
    const windX = this.windProfile(y) + c.gust
    const vrx = vx - windX
    const vry = vy
    const V = Math.hypot(vrx, vry)
    const q = 0.5 * atm.rho * V * V
    const mach = V / atm.a

    const sT = Math.sin(th), cT = Math.cos(th)
    const bx = sT, by = cT
    const nx = cT, ny = -sT
    const xcg = c.xcg

    let Fa = 0, Fn = 0, Fc = 0
    let tauAero = 0, tauDamp = 0, tauFin = 0
    let alpha = 0, cdAxial = 0

    if (V > 0.05) {
      const phi = Math.atan2(vrx, vry)
      alpha = wrapPi(th - phi)
      const sa = Math.sin(alpha), ca = Math.cos(alpha)

      const caFront = this.params.dragCoefficient * cdRatio(mach) * (1 - BASE_RELIEF * c.thrustFrac)
      cdAxial = ca >= 0 ? caFront : CA_REAR
      Fa = -q * g.Aref * cdAxial * ca

      const kM = finMachFactor(mach)
      const sac = sa * Math.abs(ca)
      const Fnn = q * g.Aref * CNA_NOSE * sac
      const Fnf = q * g.Aref * g.cnaFin * kM * sac
      const Fnc = q * g.Aplan * CD_CROSS * sa * Math.abs(sa)
      Fn = Fnn + Fnf + Fnc

      const dn = g.xNose - xcg
      const df = g.xFin - xcg
      tauAero = -(dn * Fnn + (g.xFin - xcg) * Fnf + (g.xCross - xcg) * Fnc)
      tauDamp = (-q * g.Aref * (CNA_NOSE * dn * dn + g.cnaFin * kM * df * df) * om) / Math.max(V, 5)

      // movable control fins: force along +n for delta < 0, so +delta = nose-right torque
      Fc = -q * g.Aref * g.cnaFin * kM * FIN_CTRL_EFF * c.fin
      tauFin = -(g.xFin - xcg) * Fc
    }

    // thrust (force direction = body axis rotated by -gimbal)
    const psi = th - c.gimbal
    const tx = c.T * Math.sin(psi)
    const ty = c.T * Math.cos(psi)
    const tauThrust = -(g.L - xcg) * (tx * nx + ty * ny)
    const tauJet = -c.mdot * (g.L - xcg) ** 2 * om

    // recovery chute, attached at the nose
    let cx = 0, cy = 0, tauChute = 0
    if (c.chuteCdS > 0) {
      const vax = vx + om * xcg * nx - windX
      const vay = vy + om * xcg * ny
      const Va = Math.hypot(vax, vay)
      const k = 0.5 * atm.rho * Va * c.chuteCdS
      cx = -k * vax
      cy = -k * vay
      tauChute = xcg * (cx * nx + cy * ny)
    }

    // non-gravitational force (what an accelerometer would read)
    const ngx = Fa * bx + (Fn + Fc) * nx + tx + cx
    const ngy = Fa * by + (Fn + Fc) * ny + ty + cy

    const rr = R_EARTH / (R_EARTH + y)
    const grav = G0 * rr * rr
    const ax = ngx / c.m
    const ay = ngy / c.m - grav

    const tauPassive = tauAero + tauDamp + tauJet + tauChute
    const tau = tauPassive + tauThrust + tauFin + c.tauRcs
    const dom = (tau - c.Idot * om) / c.I

    return {
      d: [vx, vy, ax, ay, om, dom],
      dg: {
        q, mach, alpha, V, cdAxial,
        sfAxialG: (ngx * bx + ngy * by) / (c.m * G0),
        sfLatG: (ngx * nx + ngy * ny) / (c.m * G0),
        tauPassive, windX, ax, ay,
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
      m: mp0.m, xcg: mp0.xcg, I: mp0.I, Idot: 0, T, gimbal: this.gimbal, fin: this.fin,
      thrustFrac: frac, mdot, tauRcs: 0, gust: this.gust, chuteCdS,
    }
    const pre = this.deriv(s, preCtx)
    let rcsUsed = 0
    this.controlStep(s, pre.dg.tauPassive, mp0, T, h, chuteCdS > 0, (u) => (rcsUsed = u))

    const gasEnd = Math.max(this.rcsGas - rcsUsed, 0)
    const mp1 = this.massProps(propEnd, gasEnd)
    const mpm: MassProps = {
      m: 0.5 * (mp0.m + mp1.m),
      xcg: 0.5 * (mp0.xcg + mp1.xcg),
      I: 0.5 * (mp0.I + mp1.I),
    }

    // ---- gusts (Ornstein-Uhlenbeck) ----
    const sigma = 0.1 * Math.abs(this.windProfile(s[1])) + 0.25
    this.gust += (-this.gust / GUST_TAU) * h + sigma * Math.sqrt((2 * h) / GUST_TAU) * this.randn()

    // ---- RK4 ----
    const ctx: Ctx = {
      m: mpm.m, xcg: mpm.xcg, I: mpm.I, Idot: (mp1.I - mp0.I) / h, T,
      gimbal: this.gimbal, fin: this.fin, thrustFrac: frac, mdot, tauRcs: this.tauRcs,
      gust: this.gust, chuteCdS,
    }
    const k1 = this.deriv(s, ctx)
    const k2 = this.deriv(this.addScaled(s, k1.d, h / 2), ctx)
    const k3 = this.deriv(this.addScaled(s, k2.d, h / 2), ctx)
    const k4 = this.deriv(this.addScaled(s, k3.d, h), ctx)
    for (let i = 0; i < 6; i++) {
      s[i] += (h / 6) * (k1.d[i] + 2 * k2.d[i] + 2 * k3.d[i] + k4.d[i])
    }
    s[4] = wrapPi(s[4])

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

  private addScaled(s: Vec6, d: Vec6, k: number): Vec6 {
    return [s[0] + k * d[0], s[1] + k * d[1], s[2] + k * d[2], s[3] + k * d[3], s[4] + k * d[4], s[5] + k * d[5]]
  }

  // ───────────────────────── flight computer ─────────────────────────

  private controlStep(
    s: Vec6, tauPassive: number, mp: MassProps, T: number, h: number,
    chuteOut: boolean, setRcsUsed: (u: number) => void,
  ): void {
    const g = this.geom
    const th = s[4], om = s[5]
    const arm = g.L - mp.xcg
    let gimCmd = 0
    let finCmd = 0
    let tauRcs = 0
    let rcsUsed = 0

    const active = this.liftedOff || this.railCleared || this.stage === 'powered-ascent'
    if (!chuteOut && active) {
      if (this.assist) {
        let omCmd: number
        if (Math.abs(this.pitchInput) > 0.01) {
          omCmd = this.pitchInput * OMEGA_MAX
          this.attHold = wrapPi(th + om * 0.3)
        } else {
          omCmd = clamp(K_THETA * wrapPi(this.attHold - th), -OMEGA_MAX, OMEGA_MAX)
        }
        this.omegaCmd = omCmd
        const tauNeed = mp.I * K_OMEGA * (omCmd - om) - tauPassive

        // control allocation: share the demanded torque between TVC and the
        // aerodynamic fins in proportion to the authority each has right now
        const sinMax = Math.sin(GIMBAL_MAX)
        const tvcAuth = T > 1 && arm > 0.05 ? T * arm * sinMax : 0
        const finLever = Math.max(g.xFin - mp.xcg, 0)
        const finGain =
          this.diag.q * g.Aref * g.cnaFin * finMachFactor(this.diag.mach) * FIN_CTRL_EFF * finLever // N*m per rad
        const finAuth = finGain * FIN_CTRL_MAX
        const authSum = tvcAuth + finAuth

        let tauGimbal = 0
        let tauFin = 0
        if (authSum > 1e-9) {
          const total = clamp(tauNeed, -authSum, authSum)
          const tauG = (total * tvcAuth) / authSum
          const tauF = (total * finAuth) / authSum
          if (tvcAuth > 0) {
            gimCmd = Math.asin(clamp(tauG / (T * arm), -sinMax, sinMax))
            tauGimbal = T * Math.sin(gimCmd) * arm
          }
          if (finGain > 1e-9) {
            finCmd = clamp(tauF / finGain, -FIN_CTRL_MAX, FIN_CTRL_MAX)
            tauFin = finGain * finCmd
          }
        }

        const resid = tauNeed - tauGimbal - tauFin
        if (Math.abs(resid) > RCS_DEADBAND * this.tauRcsMax && this.rcsGas > 0) {
          tauRcs = clamp(resid, -this.tauRcsMax, this.tauRcsMax)
          const thrusterForce = Math.abs(tauRcs) / g.rcsCouple
          const wanted = ((2 * thrusterForce) / (ISP_COLD * G0)) * h   // kg for the thruster pair
          rcsUsed = Math.min(wanted, this.rcsGas)
          if (wanted > 0) tauRcs *= rcsUsed / wanted                  // gas running out -> less torque
        }
      } else {
        this.omegaCmd = 0
        gimCmd = T > 1 ? this.pitchInput * GIMBAL_MAX : 0
        finCmd = this.pitchInput * FIN_CTRL_MAX
      }
    } else {
      this.omegaCmd = 0
    }

    // gimbal actuator: first-order lag, rate limit, travel limit
    const rate = clamp((gimCmd - this.gimbal) / GIMBAL_TAU, -GIMBAL_RATE, GIMBAL_RATE)
    this.gimbal = clamp(this.gimbal + rate * h, -GIMBAL_MAX, GIMBAL_MAX)
    this.gimbalCmd = gimCmd

    // control-fin actuator: same structure, faster and with its own travel limit
    const frate = clamp((finCmd - this.fin) / FIN_CTRL_TAU, -FIN_CTRL_RATE, FIN_CTRL_RATE)
    this.fin = clamp(this.fin + frate * h, -FIN_CTRL_MAX, FIN_CTRL_MAX)

    this.tauRcs = tauRcs
    setRcsUsed(rcsUsed)
  }

  // ───────────────────────── recovery ─────────────────────────

  private updateChute(q: number, s: Vec6): void {
    const burnedOut = this.prop <= 0 && this.tBurnout !== null && this.time > this.tBurnout + TAILOFF
    if (this.chuteState === 0) {
      if (burnedOut && s[3] < -1 && s[1] > 20 && q < CHUTE_Q_MAX) {
        this.chuteState = 1
        this.tDrogue = this.time
      }
    } else if (this.chuteState === 1) {
      if (s[3] < 0 && s[1] < MAIN_ALT && s[1] > 15 && q < MAIN_Q_MAX) {
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
        s[0] = 0; s[2] = 0; s[4] = 0; s[5] = 0
      }
    }

    if (s[1] <= 0 && s[3] <= 0) {
      if (this.liftedOff && this.railCleared) {
        this.touchdown()
        return
      }
      s[1] = 0
      s[3] = 0
    }
  }

  private touchdown(): void {
    const s = this.s
    this.impactSpeed = Math.hypot(s[2], s[3])
    const tilt = Math.abs(wrapPi(s[4]))
    const spin = Math.abs(s[5])
    this.outcome =
      this.impactSpeed <= LAND_V_MAX && tilt <= LAND_TILT_MAX && spin <= LAND_SPIN_MAX
        ? 'landed'
        : 'crashed'
    s[1] = 0; s[2] = 0; s[3] = 0; s[5] = 0
    this.gimbal = 0; this.gimbalCmd = 0; this.fin = 0; this.tauRcs = 0
    this.lastT = 0; this.lastMdot = 0; this.lastFrac = 0
    this.omegaCmd = 0
  }

  // ───────────────────────── flight stage ─────────────────────────

  private updateStage(): void {
    if (this.outcome !== 'flying') { this.stage = 'descent'; return }
    if (this.prop > 0 || this.lastFrac > 0) { this.stage = 'powered-ascent'; return }
    if (!this.liftedOff) { this.stage = 'descent'; return }
    const vy = this.s[3]
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

    const cnaN = CNA_NOSE
    const cnaF = g.cnaFin * finMachFactor(d.mach)
    const xcp = (cnaN * g.xNose + cnaF * g.xFin) / (cnaN + cnaF)
    const rr = R_EARTH / (R_EARTH + s[1])
    const grav = G0 * rr * rr
    const speed = Math.hypot(s[2], s[3])
    const fpa = speed > 0.5 ? Math.atan2(s[2], s[3]) * DEG : 0

    return {
      time: round(this.time),
      altitude: round(s[1]),
      velocity: round(s[3]),
      acceleration: round(d.ay),
      mass: round(mp.m),
      stage: this.stage,

      lateralOffset: round(s[0]),
      lateralVelocity: round(s[2]),

      bodyAngle: round(s[4] * DEG),
      angularVelocity: round(s[5] * DEG),
      gimbalAngle: round(this.gimbal * DEG),
      angleOfAttack: round(Math.abs(d.alpha) * DEG),

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
      rcsTorque: round(this.tauRcs),
      pitchRateCommand: round(this.omegaCmd * DEG),
      attitudeTarget: round(this.attHold * DEG),
      gimbalCommand: round(this.gimbalCmd * DEG),
      finAngle: round(this.fin * DEG),
      bodyLength: round(g.L, 3),

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
      rcsTorqueMax: this.tauRcsMax,
      chuteMainArea: this.chuteMainArea,
    }
  }
}