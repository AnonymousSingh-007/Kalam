import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY_SEA_LEVEL = 9.81
const EARTH_RADIUS = 6_371_000
const AIR_DENSITY_SEA_LEVEL = 1.225
const SCALE_HEIGHT = 8500
const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180

const GIMBAL_MAX_DEG = 25.0       // maximum nozzle deflection degrees
const GIMBAL_RATE_DEG_S = 30.0   // degrees per second gimbal travel rate

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

  // Gimbal state — driven externally via setGimbalInput()
  private gimbalAngle = 0      // current actual angle in degrees
  private gimbalTarget = 0     // target angle driven by keyboard input

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
  }

  // Called every frame from App.tsx with keyboard state
  // input: -1 = left arrow held, +1 = right arrow held, 0 = no input
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

    // ---- Gimbal angle tracking ----
    // Only active during powered ascent — gimbal returns to zero
    // immediately when engine cuts out
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
      // No engine = no gimbal authority, snap back to zero
      this.gimbalAngle = 0
      this.gimbalTarget = 0
    }

    const gimbalRad = this.gimbalAngle * DEG_TO_RAD

    // ---- Thrust force split by gimbal angle ----
    // Vertical component: thrust * cos(gimbalAngle)
    // Lateral component:  thrust * sin(gimbalAngle)
    // At 6° max: cos(6°)=0.9945 (barely loses vertical thrust),
    // sin(6°)=0.1045 (meaningful lateral force)
    const rawThrust = burning ? this.params.thrust * this.thrustRampFactor() : 0
    const thrustVertical = rawThrust * Math.cos(gimbalRad)
    const thrustLateral  = rawThrust * Math.sin(gimbalRad)

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
    // Gimbal lateral force + wind force, both opposed by lateral drag
    const lateralDragForce =
      0.5 * rho * this.lateralVelocity * Math.abs(this.lateralVelocity) *
      this.params.dragCoefficient * this.params.crossSectionArea * 0.6

    const windForce = this.windDirection * this.windStrength
    const totalLateralForce = thrustLateral + windForce - lateralDragForce
    this.lateralAcceleration = totalLateralForce / mass
    this.lateralVelocity += this.lateralAcceleration * dt
    this.lateralOffset += this.lateralVelocity * dt

    // ---- Derived instruments ----
    const speed = Math.sqrt(
      this.velocity * this.velocity + this.lateralVelocity * this.lateralVelocity
    )
    const angleOfAttack = speed > 0.1
      ? Math.atan2(Math.abs(this.lateralVelocity), Math.abs(this.velocity)) * RAD_TO_DEG
      : 0

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
      gimbalAngle: this.gimbalAngle
    }
  }
}