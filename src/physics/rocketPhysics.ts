import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY_SEA_LEVEL = 9.81
const EARTH_RADIUS = 6_371_000
const AIR_DENSITY_SEA_LEVEL = 1.225
const SCALE_HEIGHT = 8500
const RAD_TO_DEG = 180 / Math.PI

// ---- Gravity turn ----
// Rocket rises purely vertically until it clears the pad/tower by a modest
// margin, then the thrust vector begins pitching toward horizontal. Pitch
// rate is proportional to current velocity (faster rocket turns faster) —
// the standard simplified gravity-turn approximation, producing a natural
// parabolic-ish arc without needing a scripted angle-vs-time schedule.
const GRAVITY_TURN_START_ALTITUDE = 120 // meters
// rad/s per m/s of velocity. Tuned against this app's default RocketParams
// (thrust 2200N / dryMass 15kg / propellant 20kg / burnRate 1.2kg/s, ~16.7s
// burn) to reach a visible ~60-75° pitch by burnout — since thrust/mass are
// user-adjustable in ParamPanel, this is a judgment call to re-check live
// against whatever params someone actually flies with.
const PITCH_RATE_COEFFICIENT = 0.0003
// Clamp — this is a stylized single-axis sim, not a real ascent to a
// horizontal orbital-insertion angle, so a near-90° pitch would look wrong.
const MAX_PITCH_ANGLE = (75 * Math.PI) / 180

export class RocketPhysicsEngine {
  private params: RocketParams
  private time = 0
  private altitude = 0
  private velocity = 0
  private acceleration = 0
  private stage: FlightStage = 'pre-launch'
  private maxAltitudeReached = 0
  private hasBurnedOut = false

  private windDirection = 1
  private windStrength = 0
  private lateralVelocity = 0
  private lateralAcceleration = 0
  private lateralOffset = 0
  private pitchAngle = 0 // radians, 0 = vertical thrust vector

  constructor(params: RocketParams) {
    this.params = params
  }

  reset(params: RocketParams): void {
    this.params = params
    this.time = 0
    this.altitude = 0
    this.velocity = 0
    this.acceleration = 0
    this.stage = 'pre-launch'
    this.maxAltitudeReached = 0
    this.hasBurnedOut = false
    this.lateralVelocity = 0
    this.lateralAcceleration = 0
    this.lateralOffset = 0
    this.pitchAngle = 0
  }

  private currentMass(): number {
    const { dryMass, propellantMass, burnRate } = this.params
    const burned = burnRate * this.time
    const remainingPropellant = Math.max(propellantMass - burned, 0)
    return dryMass + remainingPropellant
  }

  private isBurning(): boolean {
    const { propellantMass, burnRate } = this.params
    return burnRate * this.time < propellantMass
  }

  private gravityAt(altitude: number): number {
    const ratio = EARTH_RADIUS / (EARTH_RADIUS + altitude)
    return GRAVITY_SEA_LEVEL * ratio * ratio
  }

  private airDensityAt(altitude: number): number {
    if (altitude < 0) return AIR_DENSITY_SEA_LEVEL
    return AIR_DENSITY_SEA_LEVEL * Math.exp(-altitude / SCALE_HEIGHT)
  }

  private thrustRampFactor(): number {
    const RAMP_TIME = 0.4
    if (this.time >= RAMP_TIME) return 1
    return this.time / RAMP_TIME
  }

  step(dt: number): Telemetry {
    if (this.stage === 'pre-launch') {
      return this.snapshot()
    }

    const mass = this.currentMass()
    const burning = this.isBurning()
    const g = this.gravityAt(this.altitude)
    const rho = this.airDensityAt(this.altitude)

    // ---- Gravity turn ----
    // Only accumulates while burning — once thrust ends there's nothing
    // left to steer the vehicle, so it freezes at whatever pitch it reached
    // and coasts ballistically from there.
    if (burning && this.altitude >= GRAVITY_TURN_START_ALTITUDE) {
      const pitchRate = PITCH_RATE_COEFFICIENT * Math.max(this.velocity, 0)
      this.pitchAngle = Math.min(this.pitchAngle + pitchRate * dt, MAX_PITCH_ANGLE)
    }

    // ---- Vertical axis ----
    const thrustForce = burning ? this.params.thrust * this.thrustRampFactor() : 0
    const verticalThrust = thrustForce * Math.cos(this.pitchAngle)
    const weightForce = mass * g
    const dragForce =
      0.5 * rho * this.velocity * Math.abs(this.velocity) *
      this.params.dragCoefficient * this.params.crossSectionArea
    const netForce = verticalThrust - weightForce - dragForce
    this.acceleration = netForce / mass

    this.velocity += this.acceleration * dt
    this.altitude += this.velocity * dt
    this.time += dt

    // ---- Lateral axis ----
    // Gravity-turn thrust component adds to (doesn't replace) the existing
    // stochastic wind-drift force — wind is a small perturbation riding on
    // top of the programmed pitch-over trajectory.
    const horizontalThrust = thrustForce * Math.sin(this.pitchAngle)
    const lateralDragForce =
      0.5 * rho * this.lateralVelocity * Math.abs(this.lateralVelocity) *
      this.params.dragCoefficient * this.params.crossSectionArea * 0.6
    const lateralForce =
      this.windDirection * this.windStrength + horizontalThrust - lateralDragForce
    this.lateralAcceleration = lateralForce / mass
    this.lateralVelocity += this.lateralAcceleration * dt
    this.lateralOffset += this.lateralVelocity * dt

    // ---- Derived instruments ----
    // Angle of Attack: angle between body axis (vertical) and velocity vector.
    // atan2(lateralVelocity, verticalVelocity) gives the flow angle in radians.
    // At zero vertical velocity (apogee) this would spike — clamp to ±90 deg.
    const speed = Math.sqrt(this.velocity * this.velocity + this.lateralVelocity * this.lateralVelocity)
    const angleOfAttack = speed > 0.1
      ? Math.atan2(Math.abs(this.lateralVelocity), Math.abs(this.velocity)) * RAD_TO_DEG
      : 0

    // Axial g-load: specific force along thrust axis = (thrust - drag) / mass / g0
    // This is what an accelerometer bolted to the rocket actually reads.
    // Gravity is NOT included — an accelerometer in free fall reads 0g.
    // At rest on the pad it reads +1g (normal force from ground).
    const specificForceAxial = (thrustForce - dragForce) / mass
    const axialGLoad = specificForceAxial / GRAVITY_SEA_LEVEL

    // Lateral g-load: specific force on lateral axis
    const specificForceLateral = this.lateralAcceleration
    const lateralGLoad = specificForceLateral / GRAVITY_SEA_LEVEL

    if (!burning && !this.hasBurnedOut) {
      this.hasBurnedOut = true
    }

    if (this.altitude < 0) {
      this.altitude = 0
      this.velocity = 0
    }

    this.maxAltitudeReached = Math.max(this.maxAltitudeReached, this.altitude)
    this.updateStage()

    return this.snapshot(angleOfAttack, axialGLoad, lateralGLoad)
  }

  private updateStage(): void {
    const burning = this.isBurning()
    if (this.altitude <= 0 && this.hasBurnedOut && this.velocity <= 0) {
      this.stage = 'descent'; return
    }
    if (burning) { this.stage = 'powered-ascent'; return }
    const nearPeak = this.altitude >= this.maxAltitudeReached - 0.05
    if (this.velocity > 0.5) {
      this.stage = 'coast'
    } else if (nearPeak && Math.abs(this.velocity) <= 0.5) {
      this.stage = 'apogee'
    } else {
      this.stage = 'descent'
    }
  }

  launch(): void {
    if (this.stage === 'pre-launch') {
      this.stage = 'powered-ascent'
      this.windDirection = Math.random() < 0.5 ? -1 : 1
      this.windStrength = this.params.thrust * (0.005 + Math.random() * 0.015)
    }
  }

  snapshot(
    angleOfAttack = 0,
    axialGLoad = 0,
    lateralGLoad = 0
  ): Telemetry {
    return {
      time: this.time,
      altitude: this.altitude,
      velocity: this.velocity,
      acceleration: this.acceleration,
      mass: this.currentMass(),
      stage: this.stage,
      lateralOffset: this.lateralOffset,
      lateralVelocity: this.lateralVelocity,
      angleOfAttack,
      axialGLoad,
      lateralGLoad
    }
  }
}