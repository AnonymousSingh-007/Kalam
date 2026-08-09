// Landmark from MediaPipe HandLandmarker: normalized x, y, z per joint
export interface HandLandmark {
  x: number
  y: number
  z: number
}

// One detected hand: 21 landmarks + handedness
export interface DetectedHand {
  landmarks: HandLandmark[]
  handedness: 'Left' | 'Right'
  score: number
}

// Output of fingerCount.ts (colleague's module)
export type FingerCount = 0 | 1 | 2 | 3 | 4 | 5 | null // null = no confident reading

// Countdown state machine states
export type CountdownState =
  | { phase: 'idle' }
  | { phase: 'counting'; expected: FingerCount; heldFrames: number }
  | { phase: 'armed' }
  | { phase: 'launched' }

  // Phase 2: Rocket physics
export interface RocketParams {
  thrust: number // Newtons
  dryMass: number // kg — rocket structure, no fuel
  propellantMass: number // kg — fuel at launch
  burnRate: number // kg/s — propellant consumed per second
  dragCoefficient: number // unitless, typical rockets ~0.3-0.75
  crossSectionArea: number // m^2 — frontal area for drag calc
}

export type FlightStage = 'pre-launch' | 'powered-ascent' | 'coast' | 'apogee' | 'descent'

export interface Telemetry {
  time: number
  altitude: number
  velocity: number
  acceleration: number
  mass: number
  stage: FlightStage
  lateralOffset: number // meters, horizontal drift from wind
}

// Phase 3: Sarcastic commentary
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

export interface CommentaryLine {
  trigger: CommentaryTrigger
  text: string
}