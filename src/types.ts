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
  | { phase: 'counting'; expected: FingerCount; heldFrames: number }
  | { phase: 'armed' }
  | { phase: 'launched' }

export interface RocketParams {
  thrust: number
  dryMass: number
  propellantMass: number
  burnRate: number
  dragCoefficient: number
  crossSectionArea: number
}

export type FlightStage =
  | 'pre-launch'
  | 'powered-ascent'
  | 'coast'
  | 'apogee'
  | 'descent'

export interface Telemetry {
  time: number
  altitude: number
  velocity: number
  acceleration: number
  mass: number
  stage: FlightStage
  lateralOffset: number
  lateralVelocity: number
  angleOfAttack: number
  axialGLoad: number
  lateralGLoad: number
  gimbalAngle: number     // degrees, nozzle deflection relative to body
  bodyAngle: number       // degrees, rocket body tilt from vertical (world frame)
  angularVelocity: number // degrees/sec, rate of body rotation
}

export type CommentaryTrigger =
  | 'countdown'
  | 'pre-launch'
  | 'ignition'
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