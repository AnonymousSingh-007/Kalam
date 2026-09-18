import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY_SEA_LEVEL = 9.81
const EARTH_RADIUS = 6_371_000
const AIR_DENSITY_SEA_LEVEL = 1.225
const SCALE_HEIGHT = 8500
const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180

const GIMBAL_MAX_DEG = 50.0       // was 25.0 — reduced for less extreme nozzle deflection
const GIMBAL_RATE_DEG_S = 30.0

// ---- Rotational dynamics constants ----
// MOMENT_ARM: effective distance (m) from the rocket's centre of mass to
// the gimbal pivot — determines how much torque a given lateral thrust
// force produces. Larger arm = more torque per degree of gimbal.
const MOMENT_ARM = 5.0
// MOMENT_OF_INERTIA: resistance to angular acceleration. Larger = rocket
// tilts more sluggishly for the same torque. Raised from 40 to 90 so the
// rocket feels controlled and heavy rather than twitchy — a small key tap
// no longer produces a violent snap-tilt.
const MOMENT_OF_INERTIA_BASE = 150.0
// AERO_RESTORING_COEFF: fins + body drag create a torque that pushes the
// nose back toward the velocity vector (weathercocking) — proportional to
// dynamic pressure and the current AoA-like misalignment between body
// angle and velocity direction. Softened from 0.6 to 0.4 so it corrects
// the rocket without fighting the pilot's input too aggressively.
const AERO_RESTORING_COEFF = 0.3  
const ANGULAR_DAMPING = 0.4 // energy loss in the rotational system, prevents oscillation

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

  private gimbalAngle = 0
  private gimbalTarget = 0

  // ---- Body attitude state ----
  private bodyAngle = 0        // degrees from vertical, world frame. +ve = tilted right
  private angularVelocity = 0  // degrees/sec

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
    this.gimbalAngle = 0
    this.gimbalTarget = 0
    this.bodyAngle = 0
    this.angularVelocity = 0
  }

  setGimbalInput(input: number): void {
    this.gimbalTarget = input * GIMBAL_MAX_DEG
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

    // ---- Gimbal angle tracking (nozzle deflection RELATIVE to body) ----
    if (burning && this.stage === 'powered-ascent') {
      const maxStep = GIMBAL_RATE_DEG_S * dt
      const diff = this.gimbalTarget - this.gimbalAngle
      if (Math.abs(diff) <= maxStep) {
        this.gimbalAngle = this.gimbalTarget
      } else {
        this.gimbalAngle += Math.sign(diff) * maxStep
      }
      this.gimbalAngle = Math.max(-GIMBAL_MAX_DEG, Math.min(GIMBAL_MAX_DEG, this.gimbalAngle))
    } else {
      this.gimbalAngle = 0
      this.gimbalTarget = 0
    }

    const rawThrust = burning ? this.params.thrust * this.thrustRampFactor() : 0

    // ---- Rotational dynamics ----
    const gimbalRad = this.gimbalAngle * DEG_TO_RAD
    const gimbalTorque = rawThrust * Math.sin(gimbalRad) * MOMENT_ARM

    const speed = Math.sqrt(this.velocity * this.velocity + this.lateralVelocity * this.lateralVelocity)
    const dynamicPressure = 0.5 * rho * speed * speed
    const velocityAngle = speed > 0.5
      ? Math.atan2(this.lateralVelocity, Math.max(this.velocity, 0.1)) * RAD_TO_DEG
      : this.bodyAngle
    const misalignment = this.bodyAngle - velocityAngle
    const restoringTorque = -misalignment * dynamicPressure * AERO_RESTORING_COEFF * 0.001

    const momentOfInertia = MOMENT_OF_INERTIA_BASE * (mass / 100)
    const netTorque = gimbalTorque + restoringTorque
    const angularAcceleration = netTorque / momentOfInertia

    this.angularVelocity += angularAcceleration * dt
    this.angularVelocity *= (1 - ANGULAR_DAMPING * dt)
    this.bodyAngle += this.angularVelocity * dt

    this.bodyAngle = Math.max(-60, Math.min(60, this.bodyAngle))

    const bodyRad = this.bodyAngle * DEG_TO_RAD

    // ---- Thrust vector in world space ----
    const thrustVertical = rawThrust * Math.cos(bodyRad)
    const thrustLateral  = rawThrust * Math.sin(bodyRad)

    // ---- Vertical axis ----
    const weightForce = mass * g
    const dragForce =
      0.5 * rho * this.velocity * Math.abs(this.velocity) *
      this.params.dragCoefficient * this.params.crossSectionArea
    const netVertical = thrustVertical - weightForce - dragForce
    this.acceleration = netVertical / mass

    this.velocity += this.acceleration * dt
    this.altitude += this.velocity * dt
    this.time += dt

    // ---- Lateral axis ----
    const lateralDragForce =
      0.5 * rho * this.lateralVelocity * Math.abs(this.lateralVelocity) *
      this.params.dragCoefficient * this.params.crossSectionArea * 0.6

    const windForce = this.windDirection * this.windStrength
    const totalLateralForce = thrustLateral + windForce - lateralDragForce
    this.lateralAcceleration = totalLateralForce / mass
    this.lateralVelocity += this.lateralAcceleration * dt
    this.lateralOffset += this.lateralVelocity * dt

    // ---- Derived instruments ----
    const angleOfAttack = Math.abs(misalignment)

    const specificForceAxial = (rawThrust - dragForce) / mass
    const axialGLoad = specificForceAxial / GRAVITY_SEA_LEVEL
    const lateralGLoad = this.lateralAcceleration / GRAVITY_SEA_LEVEL

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
      lateralGLoad,
      gimbalAngle: this.gimbalAngle,
      bodyAngle: this.bodyAngle,
      angularVelocity: this.angularVelocity
    }
  }
}