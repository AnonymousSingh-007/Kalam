import type { RocketParams, Telemetry, FlightStage } from '../types'

const GRAVITY_SEA_LEVEL = 9.81
const EARTH_RADIUS = 6_371_000
const AIR_DENSITY_SEA_LEVEL = 1.225
const SCALE_HEIGHT = 8500

export class RocketPhysicsEngine {
  private params: RocketParams
  private time = 0
  private altitude = 0
  private velocity = 0
  private acceleration = 0
  private stage: FlightStage = 'pre-launch'
  private maxAltitudeReached = 0
  private hasBurnedOut = false

  // Wind drift state
  private windDirection = 1 // +1 or -1, randomized per launch
  private windStrength = 0 // N, randomized per launch, constant through flight
  private lateralVelocity = 0
  private lateralOffset = 0

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
    this.lateralOffset = 0
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

  // Thrust ramps from 0 to full over 0.4s at ignition, instead of snapping —
  // real engines aren't instant-on.
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

    const thrustForce = burning ? this.params.thrust * this.thrustRampFactor() : 0
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

    // Lateral wind drift: constant small force, opposed by lateral drag
    // proportional to lateral speed. Only meaningfully affects the rocket
    // while it's moving slowly (near launch) or during unpowered descent —
    // at high vertical speed the effect is naturally small relative to
    // altitude gained, which matches how real wind drift behaves.
    const lateralDragForce =
      0.5 *
      rho *
      this.lateralVelocity *
      Math.abs(this.lateralVelocity) *
      this.params.dragCoefficient *
      this.params.crossSectionArea *
      0.6 // lateral cross-section is smaller than frontal, rough approximation

    const lateralForce = this.windDirection * this.windStrength - lateralDragForce
    const lateralAccel = lateralForce / mass
    this.lateralVelocity += lateralAccel * dt
    this.lateralOffset += this.lateralVelocity * dt

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
      // Randomize wind per launch: direction and a modest strength band.
      // Strength scaled relative to typical thrust so it's felt but not
      // dominant — roughly 0.5-2% of thrust force as a steady crosswind push.
      this.windDirection = Math.random() < 0.5 ? -1 : 1
      this.windStrength = this.params.thrust * (0.005 + Math.random() * 0.015)
    }
  }

  snapshot(): Telemetry {
    return {
      time: this.time,
      altitude: this.altitude,
      velocity: this.velocity,
      acceleration: this.acceleration,
      mass: this.currentMass(),
      stage: this.stage,
      lateralOffset: this.lateralOffset
    }
  }
}