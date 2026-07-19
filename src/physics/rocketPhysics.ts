import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY_SEA_LEVEL = 9.81 // m/s^2
const EARTH_RADIUS = 6_371_000 // m, for gravity falloff at altitude
const AIR_DENSITY_SEA_LEVEL = 1.225 // kg/m^3
const SCALE_HEIGHT = 8500 // m, atmospheric scale height for exponential falloff

export class RocketPhysicsEngine {
  private params: RocketParams
  private time = 0
  private altitude = 0
  private velocity = 0
  private acceleration = 0
  private stage: FlightStage = 'pre-launch'
  private maxAltitudeReached = 0
  private hasBurnedOut = false

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

  // Gravity weakens slightly with altitude — negligible for model rockets,
  // but keeps the model honest at higher altitudes.
  private gravityAt(altitude: number): number {
    const ratio = EARTH_RADIUS / (EARTH_RADIUS + altitude)
    return GRAVITY_SEA_LEVEL * ratio * ratio
  }

  // Exponential atmospheric density falloff (simplified barometric formula)
  private airDensityAt(altitude: number): number {
    if (altitude < 0) return AIR_DENSITY_SEA_LEVEL
    return AIR_DENSITY_SEA_LEVEL * Math.exp(-altitude / SCALE_HEIGHT)
  }

  step(dt: number): Telemetry {
    if (this.stage === 'pre-launch') {
      return this.snapshot()
    }

    const mass = this.currentMass()
    const burning = this.isBurning()
    const g = this.gravityAt(this.altitude)
    const rho = this.airDensityAt(this.altitude)

    const thrustForce = burning ? this.params.thrust : 0
    const weightForce = mass * g

    const dragForce =
      0.5 *
      rho *
      this.velocity *
      Math.abs(this.velocity) *
      this.params.dragCoefficient *
      this.params.crossSectionArea

    const netForce = thrustForce - weightForce - dragForce
    this.acceleration = netForce / mass

    this.velocity += this.acceleration * dt
    this.altitude += this.velocity * dt
    this.time += dt

    if (!burning && !this.hasBurnedOut) {
      this.hasBurnedOut = true
    }

    if (this.altitude < 0) {
      this.altitude = 0
      this.velocity = 0
    }

    this.maxAltitudeReached = Math.max(this.maxAltitudeReached, this.altitude)
    this.updateStage()

    return this.snapshot()
  }

  private updateStage(): void {
    const burning = this.isBurning()

    if (this.altitude <= 0 && this.hasBurnedOut && this.velocity <= 0) {
      this.stage = 'descent'
      return
    }
    if (burning) {
      this.stage = 'powered-ascent'
      return
    }
    // Not burning past this point
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
    }
  }

  snapshot(): Telemetry {
    return {
      time: this.time,
      altitude: this.altitude,
      velocity: this.velocity,
      acceleration: this.acceleration,
      mass: this.currentMass(),
      stage: this.stage
    }
  }
}