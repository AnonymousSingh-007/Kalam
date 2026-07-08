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