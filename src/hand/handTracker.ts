import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult
} from '@mediapipe/tasks-vision'
import type { DetectedHand } from '../types'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'

export class HandTracker {
  private landmarker: HandLandmarker | null = null
  private ready = false

  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    })
    this.ready = true
  }

  isReady(): boolean {
    return this.ready
  }

  // Call this once per animation frame with the current <video> element
  detect(video: HTMLVideoElement, timestampMs: number): DetectedHand[] {
    if (!this.landmarker || !this.ready) return []

    const result: HandLandmarkerResult = this.landmarker.detectForVideo(
      video,
      timestampMs
    )

    if (!result.landmarks || result.landmarks.length === 0) return []

    return result.landmarks.map((landmarks, i) => ({
      landmarks: landmarks.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z })),
      handedness:
        (result.handedness[i]?.[0]?.categoryName as 'Left' | 'Right') ??
        'Right',
      score: result.handedness[i]?.[0]?.score ?? 0
    }))
  }

  dispose(): void {
    this.landmarker?.close()
    this.landmarker = null
    this.ready = false
  }
}