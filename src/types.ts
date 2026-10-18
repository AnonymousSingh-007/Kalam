// Shared types across modules. Single source of truth for data shapes
// that cross module boundaries.

export type LaunchPhase = 'idle' | 'counting' | 'armed' | 'launching' | 'flight' | 'complete'

export type FlightStage = 'pre-launch' | 'powered-ascent' | 'coast' | 'apogee' | 'descent'

export interface HandCountResult {
  count: number          // 0-5, -1 if no hand detected
  confidence: number     // 0-1
  timestamp: number
}

export interface RocketParams {
  thrust: number          // Newtons (sea-level reference thrust)
  dryMass: number         // kg (empty structure + engine)
  propellantMass: number  // kg
  burnRate: number        // kg/s (legacy — physics engine now derives mdot from Isp)
  dragCoefficient: number // legacy — physics engine now uses Mach-dependent Cd
  crossSectionArea: number // m² — legacy, physics engine uses computed A_REF
}

export interface Telemetry {
  time: number
  altitude: number        // m
  velocity: number        // m/s (vertical)
  acceleration: number    // m/s² (vertical)
  mass: number            // kg (current total)
  stage: FlightStage

  // Lateral
  lateralOffset: number   // m
  lateralVelocity: number // m/s

  // Attitude
  bodyAngle: number       // deg from vertical (+ve = tilted right)
  angularVelocity: number // deg/s
  gimbalAngle: number     // deg (nozzle deflection relative to body)
  angleOfAttack: number   // deg (absolute value)

  // Aero & propulsion (new high-fidelity fields)
  dynamicPressure: number // Pa (q-bar)
  machNumber: number
  thrustNewtons: number   // N (current thrust accounting for altitude Isp)
  isp: number             // s (current specific impulse)
  twr: number             // thrust-to-weight ratio
  maxQ: number            // Pa (max dynamic pressure seen so far)
  maxMach: number         // max Mach seen so far
  propellantRemaining: number // kg
}

export interface LaunchParams {
  thrust: number          // Newtons
  dryMass: number         // kg
  fuelMass: number        // kg
  launchAngle: number     // degrees from vertical
}

export interface TelemetryFrame {
  altitude: number        // meters
  velocity: number        // m/s
  stage: 'pre-launch' | 'ascent' | 'max-q' | 'stage-sep' | 'apogee' | 'descent' | 'landed'
  timestamp: number
}