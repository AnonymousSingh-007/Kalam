import type { DetectedHand, FingerCount } from '../types'

/**
 * COLLEAGUE'S TASK (Phase 1):
 * Take a detected hand's 21 landmarks and return how many fingers are
 * extended (0-5), or null if not confident.
 *
 * Approach: for each finger, compare the tip landmark's distance/angle
 * from the palm/MCP joint against the corresponding PIP/MCP joint to
 * decide extended vs curled. Thumb needs a different check (x-axis
 * relative to hand orientation) than the other four fingers.
 *
 * MediaPipe landmark indices reference:
 * 0 wrist | 4 thumb tip | 8 index tip | 12 middle tip | 16 ring tip | 20 pinky tip
 * https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
 *
 * Keep this function pure (no state) so it's easy to unit test against
 * saved landmark samples.
 */
export function countFingers(_hand: DetectedHand): FingerCount {
  // TODO: implement joint-angle heuristic
  return null
}