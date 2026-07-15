import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY = 9.81 // m/s^2
const AIR_DENSITY_SEA_LEVEL = 1.225 // kg/m^3, simplified constant (no altitude falloff yet)

export class RocketPhysicsEngine {
  private params: RocketParams
  private time = 0
  private altitude = 0
  private velocity = 0
  private acceleration = 0
  private stage: FlightStage = 'pre-launch'
  private maxAltitudeReached = 0

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

  // Call repeatedly with a small fixed timestep (e.g. 1/60s) after launch()
  step(dt: number): Telemetry {
    if (this.stage === 'pre-launch') {
      return this.snapshot()
    }

    const mass = this.currentMass()
    const burning = this.isBurning()

    const thrustForce = burning ? this.params.thrust : 0
    const weightForce = mass * GRAVITY

    const dragForce =
      0.5 *
      AIR_DENSITY_SEA_LEVEL *
      this.velocity *
      Math.abs(this.velocity) *
      this.params.dragCoefficient *
      this.params.crossSectionArea

    // Drag opposes motion, so it subtracts using velocity's own sign (handled by v*|v| above)
    const netForce = thrustForce - weightForce - dragForce
    this.acceleration = netForce / mass

    this.velocity += this.acceleration * dt
    this.altitude += this.velocity * dt
    this.time += dt

    if (this.altitude < 0) {
      this.altitude = 0
      this.velocity = 0
    }

    this.maxAltitudeReached = Math.max(this.maxAltitudeReached, this.altitude)

    // Stage transitions
    if (this.altitude <= 0 && this.time > 0.5) {
      this.stage = this.stage // touched ground — leave as descent, caller can detect via altitude===0
    } else if (!burning && this.velocity > 0) {
      this.stage = 'coast'
    } else if (!burning && this.velocity <= 0 && this.altitude >= this.maxAltitudeReached - 0.01) {
      this.stage = 'apogee'
    } else if (!burning && this.velocity < 0) {
      this.stage = 'descent'
    } else if (burning) {
      this.stage = 'powered-ascent'
    }

    return this.snapshot()
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