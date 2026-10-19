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
  burnRate: number        // kg/s — sets mass flow, hence Isp = thrust / (burnRate · g0)
  dragCoefficient: number // subsonic axial Cd; scaled by the Mach drag-rise curve
  crossSectionArea: number // m² reference area; sets body diameter and length
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

  // G-loads: specific force (what an accelerometer reads, gravity excluded)
  axialGLoad: number      // g along the body axis
  lateralGLoad: number    // g perpendicular to the body axis

  // Flight state
  airspeed: number        // m/s relative to the air mass
  flightPathAngle: number // deg from vertical of the ground-relative velocity
  maxAltitude: number     // m

  // Flight computer / actuators
  rcsFuel: number         // kg of cold gas remaining
  rcsTorque: number       // N·m currently applied by RCS (signed)
  pitchRateCommand: number // deg/s
  attitudeTarget: number  // deg (hold target)
  gimbalCommand: number   // deg

  // Vehicle properties
  staticMargin: number    // calibers (CP - CG) / diameter, low-speed
  centerOfGravity: number // m from nose
  centerOfPressure: number // m from nose
  momentOfInertia: number // kg·m² (pitch)

  // Environment (ISA 1976 + wind)
  airDensity: number      // kg/m³
  airPressure: number     // Pa
  airTemperature: number  // K
  speedOfSound: number    // m/s
  windSpeed: number       // m/s along +X at current altitude (incl. gusts)
  cdAxial: number         // current axial drag coefficient

  // Recovery / outcome
  chuteState: 0 | 1 | 2   // 0 stowed, 1 drogue, 2 main
  outcome: 'flying' | 'landed' | 'crashed'
  impactSpeed: number     // m/s at touchdown (0 until touchdown)
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