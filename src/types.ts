// Shared types across modules. Single source of truth for data shapes
// that cross module boundaries.

// ───────────────────────── hand tracking / countdown ─────────────────────────

// Landmark from MediaPipe HandLandmarker: normalized x, y, z per joint
export interface HandLandmark {
  x: number
  y: number
  z: number
}

export interface DetectedHand {
  landmarks: HandLandmark[]
  handedness: 'Left' | 'Right'
  score: number
}

export type FingerCount = 0 | 1 | 2 | 3 | 4 | 5 | null

export type CountdownState =
  | { phase: 'idle' }
  | { phase: 'selecting' }
  | { phase: 'counting'; expected: FingerCount; heldFrames: number }
  | { phase: 'armed' }
  | { phase: 'launched' }

// ───────────────────────── vehicles ─────────────────────────

export type VehicleId = 'strap' | 'reuse' | 'tower' | 'steel'

export type QualityTier = 'low' | 'medium' | 'high'

// ───────────────────────── rocket physics ─────────────────────────

export interface RocketParams {
  thrust: number           // N, sea-level thrust
  dryMass: number          // kg, structure + engine + RCS tank
  propellantMass: number   // kg, fuel at launch
  burnRate: number         // kg/s, sets mass flow and therefore Isp = thrust / (burnRate · g0)
  dragCoefficient: number  // subsonic axial Cd, scaled by the Mach drag-rise curve
  crossSectionArea: number // m², reference area; sets body diameter and length
}

export type FlightStage =
  | 'pre-launch'
  | 'powered-ascent'
  | 'coast'
  | 'apogee'
  | 'descent'

export interface Telemetry {
  time: number
  altitude: number         // m
  velocity: number         // m/s (vertical)
  acceleration: number     // m/s² (vertical, inertial)
  mass: number             // kg (current total)
  stage: FlightStage

  // Lateral
  lateralOffset: number    // m
  lateralVelocity: number  // m/s

  // Attitude
  bodyAngle: number        // deg from vertical, wrapped to ±180 (+ve = tilted right)
  angularVelocity: number  // deg/s
  gimbalAngle: number      // deg, nozzle deflection relative to body
  angleOfAttack: number    // deg, 0..180 (180 = flying tail-first)

  // Aero & propulsion
  dynamicPressure: number  // Pa
  machNumber: number
  thrustNewtons: number    // N, current thrust (altitude compensated)
  isp: number              // s, current specific impulse
  twr: number              // thrust-to-weight ratio
  maxQ: number             // Pa, max dynamic pressure so far
  maxMach: number
  propellantRemaining: number // kg

  // G-loads: specific force (what an accelerometer reads, gravity excluded)
  axialGLoad: number       // g along the body axis
  lateralGLoad: number     // g perpendicular to the body axis

  // Flight state
  airspeed: number         // m/s relative to the air mass
  flightPathAngle: number  // deg from vertical of the ground-relative velocity
  maxAltitude: number      // m

  // Flight computer / actuators
  rcsFuel: number          // kg of cold gas remaining
  rcsTorque: number        // N·m currently applied by RCS (signed)
  pitchRateCommand: number // deg/s
  attitudeTarget: number   // deg, attitude-hold target
  gimbalCommand: number    // deg
  finAngle: number         // deg, movable aerodynamic control-fin deflection (+ve = nose-right torque)

  // 6-DOF additions (Phase 1) — pitch-only fields above keep their exact meaning
  positionZ: number        // m, out-of-plane position (0 when nothing yaws)
  velocityZ: number        // m/s
  yawAngle: number         // deg, body yaw from the local frame
  rollAngle: number        // deg, body roll
  yawRate: number          // deg/s
  rollRate: number         // deg/s
  gimbalYawAngle: number   // deg
  finYawAngle: number      // deg
  rcsTorqueYaw: number     // N·m
  rcsTorqueRoll: number    // N·m

  // Vehicle properties
  staticMargin: number     // calibers, (CP - CG) / diameter, low-speed
  centerOfGravity: number  // m from nose
  centerOfPressure: number // m from nose
  momentOfInertia: number  // kg·m², pitch
  bodyLength: number       // m, physical rocket length (derived from reference area)

  // Environment (ISA 1976 + wind)
  airDensity: number       // kg/m³
  airPressure: number      // Pa
  airTemperature: number   // K
  speedOfSound: number     // m/s
  windSpeed: number        // m/s along +X at current altitude (incl. gusts)
  cdAxial: number          // current axial drag coefficient

  // Recovery / outcome
  chuteState: 0 | 1 | 2    // 0 stowed, 1 drogue, 2 main
  outcome: 'flying' | 'landed' | 'crashed'
  impactSpeed: number      // m/s at touchdown (0 until touchdown)
}

// ───────────────────────── commentary ─────────────────────────

export type CommentaryTrigger =
  | 'countdown'
  | 'pre-launch'
  | 'ignition'
  | 'ascent'
  | 'max-q'
  | 'burnout'
  | 'coast'
  | 'apogee'
  | 'descent'
  | 'landed'
  | 'high-g'
  | 'high-aoa'
  | 'fast-descent'

export interface CommentaryLine {
  trigger: CommentaryTrigger
  text: string
}