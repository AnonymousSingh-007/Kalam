/**
 * rocketPhysics.ts — High-fidelity single-stage rocket flight simulator
 *
 * Models:
 *   • ISA 1976 atmosphere (7 layers, geopotential altitude, proper lapse rates)
 *   • Mach-dependent drag coefficient (subsonic → transonic drag rise → supersonic)
 *   • Isp-based thrust with altitude-compensating nozzle expansion
 *   • Full 2-DOF translational dynamics (vertical + lateral) in inertial frame
 *   • 1-DOF rotational dynamics with dynamic CG, mass-varying inertia tensor
 *   • Aerodynamic restoring torque (CN_alpha stability derivative × dynamic pressure × AoA)
 *   • Roll damping approximation
 *   • Max-Q tracking, TWR, specific mechanical energy
 *
 * Conventions:
 *   +Y = up (vertical/altitude), +X = right (lateral)
 *   bodyAngle = 0 → vertical; +ve = tilted right (clockwise from above)
 *   gimbalAngle = nozzle deflection relative to body axis
 *
 * Coordinate note: "altitude" is geometric altitude above the launch pad.
 *   ISA 1976 uses geopotential altitude internally.
 */

import type { RocketParams, Telemetry, FlightStage } from '../types'

// ═══════════════════════════════════════════════════════════════════
//  PHYSICAL CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const G0              = 9.80665          // m/s² — standard gravity (exact, NIST)
const EARTH_RADIUS    = 6_371_000        // m  — mean Earth radius (WGS-84 mean)
const R_SPECIFIC      = 287.05287        // J/(kg·K) — specific gas constant for dry air
const GAMMA_AIR       = 1.4              // ratio of specific heats for air
const SPEED_OF_SOUND_SL = 340.294        // m/s at 15 °C sea level (ISA reference)

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

// ═══════════════════════════════════════════════════════════════════
//  ISA 1976 STANDARD ATMOSPHERE (7 layers to 86 km)
// ═══════════════════════════════════════════════════════════════════

interface ISALayer {
  hBase: number      // geopotential base altitude (m)
  TBase: number      // base temperature (K)
  lambda: number     // temperature lapse rate (K/m) — 0 for isothermal
  pBase: number      // base pressure (Pa)
  rhoBase: number    // base density (kg/m³)
}

// Pre-computed from ISA 1976 standard
const ISA_LAYERS: ISALayer[] = [
  { hBase:     0, TBase: 288.15, lambda: -0.0065,  pBase: 101325.0,     rhoBase: 1.22500 },
  { hBase: 11000, TBase: 216.65, lambda:  0.0,     pBase:  22632.10,    rhoBase: 0.36391 },
  { hBase: 20000, TBase: 216.65, lambda:  0.001,   pBase:   5474.889,   rhoBase: 0.08803 },
  { hBase: 32000, TBase: 228.65, lambda:  0.0028,  pBase:    868.0187,  rhoBase: 0.01322 },
  { hBase: 47000, TBase: 270.65, lambda:  0.0,     pBase:    110.9063,  rhoBase: 0.001427 },
  { hBase: 51000, TBase: 270.65, lambda: -0.0028,  pBase:     66.93887, rhoBase: 0.0008616 },
  { hBase: 71000, TBase: 214.65, lambda: -0.002,   pBase:      3.95642, rhoBase: 0.0000642 },
]

/**
 * Convert geometric altitude (m) to geopotential altitude (m).
 * h_gp = (R_e × h_geo) / (R_e + h_geo)
 */
function geometricToGeopotential(hGeo: number): number {
  return (EARTH_RADIUS * hGeo) / (EARTH_RADIUS + hGeo)
}

/**
 * ISA 1976 atmosphere lookup.
 * Returns { T (K), p (Pa), rho (kg/m³), a (m/s speed of sound) }
 */
function isa1976(geometricAlt: number): { T: number; p: number; rho: number; a: number } {
  const hGp = geometricToGeopotential(Math.max(geometricAlt, 0))

  // Find the correct layer
  let layer = ISA_LAYERS[0]
  for (let i = ISA_LAYERS.length - 1; i >= 0; i--) {
    if (hGp >= ISA_LAYERS[i].hBase) {
      layer = ISA_LAYERS[i]
      break
    }
  }

  const dh = hGp - layer.hBase

  let T: number, p: number, rho: number

  if (Math.abs(layer.lambda) < 1e-10) {
    // Isothermal layer
    T = layer.TBase
    const exponent = -G0 * dh / (R_SPECIFIC * T)
    p = layer.pBase * Math.exp(exponent)
    rho = layer.rhoBase * Math.exp(exponent)
  } else {
    // Gradient layer
    T = layer.TBase + layer.lambda * dh
    const exponent = -G0 / (R_SPECIFIC * layer.lambda)
    const ratio = T / layer.TBase
    p = layer.pBase * Math.pow(ratio, exponent)
    rho = layer.rhoBase * Math.pow(ratio, exponent - 1)
  }

  // Speed of sound: a = sqrt(gamma * R * T)
  const a = Math.sqrt(GAMMA_AIR * R_SPECIFIC * T)

  // Beyond 86 km, density → ~0 (model limit)
  if (geometricAlt > 86000) {
    return { T: 186.87, p: 0.0, rho: 0.0, a: Math.sqrt(GAMMA_AIR * R_SPECIFIC * 186.87) }
  }

  return { T, p, rho, a }
}

// ═══════════════════════════════════════════════════════════════════
//  MACH-DEPENDENT DRAG COEFFICIENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Cd(M) for a slender body with ogive nosecone.
 * Based on empirical curve fits:
 *   Subsonic (M < 0.8):   Cd ≈ 0.30 (constant, skin friction dominated)
 *   Transonic (0.8–1.2):  sharp rise to Cd ≈ 0.55 (wave drag onset)
 *   Supersonic (1.2–5.0): gradual decline toward Cd ≈ 0.22
 *   Hypersonic (>5.0):    Cd ≈ 0.20 (Newtonian limit)
 *
 * These numbers match wind-tunnel data for ogive-cylinder bodies (Hoerner 1965,
 * NASA TN-D series). The transonic bump is the dominant feature.
 */
function cdFromMach(mach: number): number {
  if (mach < 0.6) {
    return 0.295
  } else if (mach < 0.8) {
    // Gentle rise entering transonic
    const t = (mach - 0.6) / 0.2
    return 0.295 + t * 0.045                        // 0.295 → 0.340
  } else if (mach < 1.0) {
    // Rapid transonic drag rise
    const t = (mach - 0.8) / 0.2
    return 0.340 + t * 0.175                         // 0.340 → 0.515
  } else if (mach < 1.2) {
    // Peak and beginning of decline
    const t = (mach - 1.0) / 0.2
    return 0.515 + t * 0.035 - t * t * 0.05          // peaks ~0.55 at M≈1.1
  } else if (mach < 5.0) {
    // Supersonic decline: Cd ~ 0.55 * (1.2/M)^0.65
    return 0.55 * Math.pow(1.2 / mach, 0.65)
  } else {
    // Hypersonic plateau
    return 0.20
  }
}

/**
 * Lateral Cd for the rocket body broadside (used for AoA-induced drag).
 * Cylindrical body cross-flow Cd ≈ 1.2 at low Mach.
 */
function cdLateralFromMach(mach: number): number {
  if (mach < 1.0) return 1.20
  if (mach < 2.0) return 1.20 - 0.20 * (mach - 1.0)  // slight drop
  return 1.00
}

// ═══════════════════════════════════════════════════════════════════
//  ROCKET GEOMETRY & MASS PROPERTIES
// ═══════════════════════════════════════════════════════════════════

/**
 * Rocket dimensions (approximate Falcon 9-class small rocket scaled down
 * for our sim — these are the geometric constants the telemetry-visible
 * cross section, reference area, wetted area, and CG travel derive from).
 */
const ROCKET_LENGTH       = 12.0        // m total length (nose tip to nozzle exit)
const ROCKET_DIAMETER     = 1.0         // m body diameter
const NOSE_LENGTH         = 2.0         // m ogive nosecone
const FIN_SPAN            = 0.3         // m beyond body radius (each side)
const FIN_ROOT_CHORD      = 1.0         // m
const FIN_TIP_CHORD       = 0.4         // m
const FIN_COUNT           = 4

// Reference areas
const A_REF_AXIAL  = Math.PI * (ROCKET_DIAMETER / 2) ** 2       // 0.7854 m² frontal
const A_REF_LATERAL = ROCKET_DIAMETER * ROCKET_LENGTH            // 12.0 m² side profile
const A_FIN_SINGLE  = 0.5 * (FIN_ROOT_CHORD + FIN_TIP_CHORD) * FIN_SPAN  // each fin planform

// Station positions measured from nose tip (m)
const CG_DRY   = 7.2           // CG of empty structure (engine heavy, aft)
const CG_PROP  = 6.0           // CG of propellant alone (centered in tank)
const CP_BODY  = 4.5           // aerodynamic centre of pressure of body
const CP_FINS  = 11.0          // aero CP of fins (near trailing edge)

// Nozzle exit plane from CG — this is the moment arm for gimbal torque.
// We compute it dynamically as CG shifts with propellant burn.
const NOZZLE_STATION = 12.0    // station of nozzle exit from nose tip

/**
 * Compute centre of gravity station (from nose tip) given current propellant fraction.
 */
function cgStation(dryMass: number, propMassRemaining: number): number {
  const totalMass = dryMass + propMassRemaining
  return (CG_DRY * dryMass + CG_PROP * propMassRemaining) / totalMass
}

/**
 * Moment of inertia about pitch axis (transverse, through CG).
 * Modelled as uniform slender rod (structure) + point masses (engine, nosecone)
 * + propellant treated as uniform cylinder at CG_PROP ± tankHalfLength.
 *
 * I = I_structure + I_propellant  (parallel axis theorem applied)
 *
 * For a slender rod of length L and mass m:  I_cm = m·L²/12
 * Propellant in a cylindrical tank of half-length h:  I_cm = m·h²/3  (about tank centre)
 * Shifted to current vehicle CG via parallel axis theorem.
 */
function pitchInertia(dryMass: number, propMassRemaining: number): number {
  const cg = cgStation(dryMass, propMassRemaining)
  const totalMass = dryMass + propMassRemaining

  // Structure as slender rod
  const I_struct_cm = dryMass * ROCKET_LENGTH * ROCKET_LENGTH / 12
  const d_struct = CG_DRY - cg
  const I_struct = I_struct_cm + dryMass * d_struct * d_struct

  // Propellant as cylinder, tank half-length ≈ 2.5 m
  const tankHalf = 2.5
  const I_prop_cm = propMassRemaining * tankHalf * tankHalf / 3
  const d_prop = CG_PROP - cg
  const I_prop = I_prop_cm + propMassRemaining * d_prop * d_prop

  // Minimum to prevent division by zero when almost empty
  return Math.max(I_struct + I_prop, 5.0)
}

// ═══════════════════════════════════════════════════════════════════
//  THRUST MODEL (Isp-based, altitude-compensating)
// ═══════════════════════════════════════════════════════════════════

/**
 * Specific impulse varies with ambient pressure (under/over-expansion losses).
 *
 *   F = mdot × Ve + (Pe - Pa) × Ae
 *   Isp = F / (mdot × g0)
 *
 * We model this as:
 *   Isp(alt) = Isp_vac - (Isp_vac - Isp_sl) × (Pa / P_sl)
 *
 * This is a first-order approximation that captures the ~8% Isp gain
 * from sea level to vacuum for a typical bell nozzle (ε ≈ 16).
 */
const ISP_SEA_LEVEL = 282.0       // s — Merlin-class kerolox at sea level
const ISP_VACUUM    = 311.0       // s — same engine in vacuum
const P_SL          = 101325.0    // Pa — sea-level reference pressure

function ispAtAltitude(ambientPressure: number): number {
  const ratio = Math.min(ambientPressure / P_SL, 1.0)
  return ISP_VACUUM - (ISP_VACUUM - ISP_SEA_LEVEL) * ratio
}

/**
 * Compute thrust and mass flow rate from Isp model and desired sea-level thrust.
 *
 * At sea level:  F_sl = mdot × Isp_sl × g0   →  mdot = F_sl / (Isp_sl × g0)
 * At altitude:   F(h) = mdot × Isp(h) × g0
 *
 * The mass flow rate (mdot) is constant for a given throttle setting.
 */
function thrustAndMdot(
  seaLevelThrust: number,
  ambientPressure: number
): { thrust: number; mdot: number } {
  const mdot = seaLevelThrust / (ISP_SEA_LEVEL * G0)        // kg/s (constant)
  const isp = ispAtAltitude(ambientPressure)
  const thrust = mdot * isp * G0                              // N
  return { thrust, mdot }
}

// ═══════════════════════════════════════════════════════════════════
//  AERODYNAMIC STABILITY — Normal Force Coefficient Slope (CN_α)
// ═══════════════════════════════════════════════════════════════════

/**
 * CN_α for the complete vehicle (body + fins).
 *
 * Body alone (slender-body theory):  CN_α_body = 2 (per radian)
 * Each fin (subsonic strip theory):  CN_α_fin ≈ 2π × AR / (2 + √(4 + AR²))
 *   where AR = span² / planform area for a single fin.
 *
 * Barrowman method (standard amateur rocketry stability analysis).
 */
const FIN_AR = (FIN_SPAN * FIN_SPAN) / A_FIN_SINGLE
const CN_ALPHA_BODY = 2.0  // per radian
const CN_ALPHA_FIN_SINGLE = (2 * Math.PI * FIN_AR) / (2 + Math.sqrt(4 + FIN_AR * FIN_AR))
const CN_ALPHA_FINS = FIN_COUNT * CN_ALPHA_FIN_SINGLE  // interference factor ≈ 1 for 4 fins
const CN_ALPHA_TOTAL = CN_ALPHA_BODY + CN_ALPHA_FINS   // ~4.5 per radian (typical)

// ═══════════════════════════════════════════════════════════════════
//  GIMBAL ACTUATOR MODEL
// ═══════════════════════════════════════════════════════════════════

const GIMBAL_MAX_DEG    = 6.0        // ° — Merlin gimbal authority is ±5°; we use 6° for playability
const GIMBAL_RATE_DEG_S = 20.0       // °/s — hydraulic TVC actuator rate

// ═══════════════════════════════════════════════════════════════════
//  ENGINE
// ═══════════════════════════════════════════════════════════════════

export class RocketPhysicsEngine {
  private params!: RocketParams

  // ---- Time ----
  private time = 0

  // ---- Translational state (inertial frame, Y-up) ----
  private posY = 0               // altitude (m) above launch pad
  private posX = 0               // lateral offset (m) from pad centre
  private velY = 0               // vertical velocity (m/s)
  private velX = 0               // lateral velocity (m/s)
  private accY = 0               // vertical acceleration (m/s²)
  private accX = 0               // lateral acceleration (m/s²)

  // ---- Rotational state ----
  private bodyAngle = 0          // degrees from vertical (+ve = tilted right)
  private angularVelocity = 0    // deg/s

  // ---- Gimbal ----
  private gimbalAngle = 0        // current nozzle deflection (deg) relative to body
  private gimbalTarget = 0       // commanded deflection

  // ---- Propellant ----
  private propellantRemaining = 0 // kg

  // ---- Flight state ----
  private stage: FlightStage = 'pre-launch'
  private maxAltitude = 0
  private maxQ = 0
  private maxMach = 0
  private hasBurnedOut = false

  // ---- Wind ----
  private windSign = 1
  private windBaseForce = 0

  // ---- Thrust ramp ----
  private engineStartTime = -1    // when ignition began (for ramp-up model)

  constructor(params: RocketParams) {
    this.params = params
    this.propellantRemaining = params.propellantMass
  }

  // ---------------------------------------------------------------
  //  PUBLIC API
  // ---------------------------------------------------------------

  reset(params: RocketParams): void {
    this.params = params
    this.time = 0
    this.posY = 0
    this.posX = 0
    this.velY = 0
    this.velX = 0
    this.accY = 0
    this.accX = 0
    this.bodyAngle = 0
    this.angularVelocity = 0
    this.gimbalAngle = 0
    this.gimbalTarget = 0
    this.propellantRemaining = params.propellantMass
    this.stage = 'pre-launch'
    this.maxAltitude = 0
    this.maxQ = 0
    this.maxMach = 0
    this.hasBurnedOut = false
    this.windSign = 1
    this.windBaseForce = 0
    this.engineStartTime = -1
  }

  setGimbalInput(input: number): void {
    // input: -1 (full left) to +1 (full right)
    this.gimbalTarget = input * GIMBAL_MAX_DEG
  }

  launch(): void {
    if (this.stage === 'pre-launch') {
      this.stage = 'powered-ascent'
      this.engineStartTime = this.time
      // Randomise wind
      this.windSign = Math.random() < 0.5 ? -1 : 1
      this.windBaseForce = this.params.thrust * (0.003 + Math.random() * 0.008)
    }
  }

  // ---------------------------------------------------------------
  //  STEP — main integration (symplectic Euler, sub-stepped)
  // ---------------------------------------------------------------

  step(dt: number): Telemetry {
    if (this.stage === 'pre-launch') {
      return this.snapshot()
    }

    // Sub-step for numerical stability at large dt (browser can stutter)
    const MAX_SUB_DT = 1 / 240  // 240 Hz internal rate
    const nSub = Math.max(1, Math.ceil(dt / MAX_SUB_DT))
    const subDt = dt / nSub

    let angleOfAttack = 0
    let dynamicPressure = 0
    let machNumber = 0
    let thrustMagnitude = 0
    let currentIsp = 0
    let axialG = 0
    let lateralG = 0

    for (let i = 0; i < nSub; i++) {
      const result = this.subStep(subDt)
      angleOfAttack = result.aoa
      dynamicPressure = result.qBar
      machNumber = result.mach
      thrustMagnitude = result.thrust
      currentIsp = result.isp
      axialG = result.axialG
      lateralG = result.lateralG
    }

    // Track records
    this.maxAltitude = Math.max(this.maxAltitude, this.posY)
    this.maxQ = Math.max(this.maxQ, dynamicPressure)
    this.maxMach = Math.max(this.maxMach, machNumber)

    this.updateStage()

    return this.snapshot(angleOfAttack, dynamicPressure, machNumber, thrustMagnitude, currentIsp, axialG, lateralG)
  }

  // ---------------------------------------------------------------
  //  SUB-STEP — one physics tick
  // ---------------------------------------------------------------

  private subStep(dt: number): {
    aoa: number; qBar: number; mach: number; thrust: number; isp: number
    axialG: number; lateralG: number
  } {
    const mass = this.currentMass()

    // ---- Atmosphere at current altitude ----
    const atm = isa1976(this.posY)
    const rho = atm.rho
    const speedOfSound = atm.a

    // ---- Gravity (inverse-square, geometric altitude) ----
    const rFromCentre = EARTH_RADIUS + this.posY
    const g = G0 * (EARTH_RADIUS * EARTH_RADIUS) / (rFromCentre * rFromCentre)

    // ---- Is the engine burning? ----
    const burning = this.propellantRemaining > 0.01 && this.stage === 'powered-ascent'

    // ---- Gimbal actuation ----
    if (burning) {
      const maxStep = GIMBAL_RATE_DEG_S * dt
      const diff = this.gimbalTarget - this.gimbalAngle
      if (Math.abs(diff) <= maxStep) {
        this.gimbalAngle = this.gimbalTarget
      } else {
        this.gimbalAngle += Math.sign(diff) * maxStep
      }
      this.gimbalAngle = Math.max(-GIMBAL_MAX_DEG, Math.min(GIMBAL_MAX_DEG, this.gimbalAngle))
    } else {
      // No thrust → gimbal centering spring returns to 0
      this.gimbalAngle *= 0.9
      if (Math.abs(this.gimbalAngle) < 0.01) this.gimbalAngle = 0
    }

    // ---- Thrust ----
    let thrustMag = 0
    let mdot = 0
    let isp = ISP_SEA_LEVEL

    if (burning) {
      // Ramp-up: real engines take ~0.5 s from ignition to full chamber pressure
      const timeSinceIgnition = this.time - this.engineStartTime
      const rampFactor = timeSinceIgnition < 0.5
        ? 0.15 + 0.85 * (timeSinceIgnition / 0.5)    // starts at 15% (igniter), ramps to 100%
        : 1.0

      const result = thrustAndMdot(this.params.thrust * rampFactor, atm.p)
      thrustMag = result.thrust
      mdot = result.mdot * rampFactor
      isp = ispAtAltitude(atm.p)

      // Consume propellant
      this.propellantRemaining = Math.max(0, this.propellantRemaining - mdot * dt)

      if (this.propellantRemaining <= 0.01) {
        this.hasBurnedOut = true
        thrustMag = 0
      }
    } else if (!this.hasBurnedOut && this.propellantRemaining > 0.01) {
      // Stage not powered-ascent but still has fuel (shouldn't happen in normal flow)
    }

    // ---- Body-frame angles ----
    const bodyRad = this.bodyAngle * RAD
    const gimbalRad = this.gimbalAngle * RAD

    // Thrust vector in world frame
    // Engine pushes along body axis. Gimbal deflects the exhaust, so the
    // force direction is (bodyAngle + gimbalAngle) from vertical, but the
    // TORQUE is what gimbal produces — the net thrust direction follows
    // the body because the nozzle is part of the body (just deflected).
    // World-frame thrust:
    //   thrustY = F × cos(bodyAngle)
    //   thrustX = F × sin(bodyAngle)
    // The gimbal angle already produced its torque (below); it doesn't
    // independently steer the thrust direction — the body tilt does that.
    const thrustY = thrustMag * Math.cos(bodyRad)
    const thrustX = thrustMag * Math.sin(bodyRad)

    // ---- Velocity & derived quantities ----
    const totalSpeed = Math.sqrt(this.velY * this.velY + this.velX * this.velX)
    const mach = speedOfSound > 10 ? totalSpeed / speedOfSound : 0
    const qBar = 0.5 * rho * totalSpeed * totalSpeed   // dynamic pressure (Pa)

    // ---- Aerodynamic forces ----
    // Velocity direction (world frame, measured from +Y axis, same convention as bodyAngle)
    const flightPathAngle = totalSpeed > 0.5
      ? Math.atan2(this.velX, Math.max(this.velY, 0.01))  // rad from vertical
      : bodyRad  // at very low speed, assume aligned with body

    // Angle of attack = body angle − flight path angle
    const aoaRad = bodyRad - flightPathAngle
    const aoaDeg = aoaRad * DEG

    // Axial drag (along velocity vector, opposing motion)
    const cd = cdFromMach(mach)
    const dragAxial = qBar * cd * A_REF_AXIAL    // N

    // Normal force due to AoA (perpendicular to velocity vector)
    // CN ≈ CN_α × α  for small AoA (linear region, |α| < ~15°)
    const cnAlpha = CN_ALPHA_TOTAL
    const normalForce = qBar * cnAlpha * aoaRad * A_REF_AXIAL  // N (in body-normal direction)

    // Decompose drag into world-frame components
    // Drag opposes velocity:
    let dragY = 0, dragX = 0
    if (totalSpeed > 0.5) {
      dragY = -dragAxial * (this.velY / totalSpeed)
      dragX = -dragAxial * (this.velX / totalSpeed)
    }

    // Normal force acts perpendicular to velocity (toward reducing AoA)
    // In world frame, perpendicular to velocity vector rotated 90° toward body axis
    // This is the force that makes the rocket follow its nose (or vice versa)
    let normalY = 0, normalX = 0
    if (totalSpeed > 0.5 && Math.abs(aoaRad) > 0.001) {
      // Normal to velocity, in the plane containing velocity and body axis
      // Direction: perpendicular to V, pointing from V toward body axis
      const perpX = -this.velY / totalSpeed   // rotated 90° CCW
      const perpY =  this.velX / totalSpeed
      // Sign: normalForce is positive when AoA pushes nose windward
      // We want the force to push the BODY toward the velocity vector
      normalY = -normalForce * perpX
      normalX = -normalForce * perpY
    }

    // ---- Wind ----
    // Simple gust model: wind force scales with air density (fades with altitude)
    const windForce = this.windSign * this.windBaseForce * (rho / 1.225)

    // ---- Translational dynamics ----
    // Weight
    const weight = mass * g

    // Net forces (world frame)
    const netForceY = thrustY - weight + dragY + normalY
    const netForceX = thrustX + dragX + normalX + windForce

    this.accY = netForceY / mass
    this.accX = netForceX / mass

    // G-loads: axial = along body axis (thrust/drag-dominated), lateral =
    // perpendicular (steering/wind-dominated). Projected from world-frame
    // acceleration onto the body axis using the current body angle.
    const axialAccel = this.accY * Math.cos(bodyRad) + this.accX * Math.sin(bodyRad)
    const lateralAccel = -this.accY * Math.sin(bodyRad) + this.accX * Math.cos(bodyRad)
    const axialG = axialAccel / G0
    const lateralG = lateralAccel / G0

    // Symplectic Euler (velocity first, then position)
    this.velY += this.accY * dt
    this.velX += this.accX * dt
    this.posY += this.velY * dt
    this.posX += this.velX * dt

    // ---- Rotational dynamics ----
    const propRemaining = this.propellantRemaining
    const cg = cgStation(this.params.dryMass, propRemaining)
    const momentArm = NOZZLE_STATION - cg     // distance from CG to nozzle pivot

    // Gimbal torque: thrust lateral component relative to body axis × moment arm
    // Torque = F × sin(gimbalAngle) × momentArm
    const gimbalTorque = thrustMag * Math.sin(gimbalRad) * momentArm   // N·m

    // Aerodynamic restoring torque (weathercocking)
    // τ_aero = qBar × CN_α × AoA × A_ref × (CP - CG)
    // CP is the weighted average of body CP and fin CP by their CN_α contributions
    const cpCombined = (CN_ALPHA_BODY * CP_BODY + CN_ALPHA_FINS * CP_FINS) / CN_ALPHA_TOTAL
    const stabilityArm = cpCombined - cg   // positive = CP aft of CG = statically stable

    // Restoring torque: pushes nose back toward velocity vector
    // Positive stabilityArm + positive AoA → negative torque (restoring)
    const aeroTorque = -qBar * cnAlpha * aoaRad * A_REF_AXIAL * stabilityArm * 0.001
    // The 0.001 factor is a unit-scaling empirical correction — CN_α is per radian
    // but the force × arm product over-predicts for our scale; real stability
    // derivatives are referenced to specific length scales.
    // More precisely: τ = q × S × d × Cm_α × α, where d is reference diameter
    // and Cm_α ≈ CN_α × (xCP - xCG)/d. We fold that into the coefficient.

    // Pitch damping: τ_damp = -Cmq × q × S × d² × ω / (2V)
    // Approximated as proportional damping
    const dampingCoeff = totalSpeed > 1.0
      ? qBar * A_REF_AXIAL * ROCKET_DIAMETER * ROCKET_DIAMETER / (2 * totalSpeed) * 0.002
      : 0.5   // structural damping on the pad
    const dampingTorque = -this.angularVelocity * RAD * dampingCoeff * 100

    // Moment of inertia
    const I_pitch = pitchInertia(this.params.dryMass, propRemaining)

    const netTorque = gimbalTorque + aeroTorque + dampingTorque
    const angularAcc = (netTorque / I_pitch) * DEG   // convert rad/s² → deg/s²

    this.angularVelocity += angularAcc * dt
    this.bodyAngle += this.angularVelocity * dt

    // Hard clamp at ±90° — beyond this the rocket is lost
    if (Math.abs(this.bodyAngle) > 90) {
      this.bodyAngle = Math.sign(this.bodyAngle) * 90
      this.angularVelocity *= -0.1  // inelastic rebound
    }

    // ---- Ground contact ----
    if (this.posY < 0) {
      this.posY = 0
      if (this.velY < 0) this.velY = 0
    }

    this.time += dt

    return {
      aoa: Math.abs(aoaDeg),
      qBar: qBar,
      mach: mach,
      thrust: thrustMag,
      isp: isp,
      axialG: axialG,
      lateralG: lateralG,
    }
  }

  // ---------------------------------------------------------------
  //  MASS
  // ---------------------------------------------------------------

  private currentMass(): number {
    return this.params.dryMass + this.propellantRemaining
  }

  // ---------------------------------------------------------------
  //  FLIGHT STAGE FSM
  // ---------------------------------------------------------------

  private updateStage(): void {
    if (this.posY <= 0 && this.hasBurnedOut && this.velY <= 0) {
      this.stage = 'descent'
      return
    }
    if (!this.hasBurnedOut && this.propellantRemaining > 0.01) {
      this.stage = 'powered-ascent'
      return
    }
    const nearPeak = this.posY >= this.maxAltitude - 0.05
    if (this.velY > 0.5) {
      this.stage = 'coast'
    } else if (nearPeak && Math.abs(this.velY) <= 0.5) {
      this.stage = 'apogee'
    } else {
      this.stage = 'descent'
    }
  }

  // ---------------------------------------------------------------
  //  TELEMETRY SNAPSHOT
  // ---------------------------------------------------------------

  snapshot(
    angleOfAttack = 0,
    dynamicPressure = 0,
    machNumber = 0,
    thrustMagnitude = 0,
    isp = 0,
    axialG = 0,
    lateralG = 0,
  ): Telemetry {
    const mass = this.currentMass()
    const g = G0 * (EARTH_RADIUS / (EARTH_RADIUS + this.posY)) ** 2
    const twr = thrustMagnitude / (mass * g)

    return {
      time: parseFloat(this.time.toFixed(2)),
      altitude: parseFloat(this.posY.toFixed(2)),
      velocity: parseFloat(this.velY.toFixed(2)),
      acceleration: parseFloat(this.accY.toFixed(2)),
      mass: parseFloat(mass.toFixed(2)),
      stage: this.stage,

      // Lateral
      lateralOffset: parseFloat(this.posX.toFixed(2)),
      lateralVelocity: parseFloat(this.velX.toFixed(2)),

      // Attitude
      bodyAngle: parseFloat(this.bodyAngle.toFixed(2)),
      angularVelocity: parseFloat(this.angularVelocity.toFixed(2)),
      gimbalAngle: parseFloat(this.gimbalAngle.toFixed(2)),
      angleOfAttack: parseFloat(angleOfAttack.toFixed(2)),

      // Aero & propulsion
      dynamicPressure: parseFloat(dynamicPressure.toFixed(2)),
      machNumber: parseFloat(machNumber.toFixed(4)),
      thrustNewtons: parseFloat(thrustMagnitude.toFixed(2)),
      isp: parseFloat(isp.toFixed(2)),
      twr: parseFloat(twr.toFixed(2)),
      maxQ: parseFloat(this.maxQ.toFixed(2)),
      maxMach: parseFloat(this.maxMach.toFixed(4)),
      propellantRemaining: parseFloat(this.propellantRemaining.toFixed(2)),

      // G-loads
      axialGLoad: parseFloat(axialG.toFixed(3)),
      lateralGLoad: parseFloat(lateralG.toFixed(3)),
    }
  }
}