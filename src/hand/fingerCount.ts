import type { DetectedHand, FingerCount } from '../types'

/**
 * COLLEAGUE'S TASK (Phase 1):
 * Take a detected hand's 21 landmarks and return how many fingers are
 * extended (0-5), or null if not confident.
 */

const FINGER_TIPS = [8, 12, 16, 20] // index, middle, ring, pinky
const FINGER_PIPS = [6, 10, 14, 18]

const MIN_CONFIDENCE = 0.5

export function countFingers(hand: DetectedHand): FingerCount {
  if (!hand || !hand.landmarks || hand.landmarks.length !== 21) {
    return null
  }

  if (hand.score < MIN_CONFIDENCE) {
    return null
  }

  const lm = hand.landmarks
  let count = 0

  // Four fingers: tip above pip (smaller y = higher/extended in image space)
  for (let i = 0; i < 4; i++) {
    if (lm[FINGER_TIPS[i]].y < lm[FINGER_PIPS[i]].y) {
      count++
    }
  }

  // Thumb: compare x-distance from wrist, direction depends on handedness
  // (mirrors camera view — MediaPipe reports handedness from subject's perspective)
  const thumbTip = lm[4]
  const thumbIp = lm[3]
  const wrist = lm[0]

  const thumbExtended =
    hand.handedness === 'Right'
      ? thumbTip.x < thumbIp.x // right hand: thumb extends toward smaller x
      : thumbTip.x > thumbIp.x // left hand: thumb extends toward larger x

  // fallback check: tip must also be meaningfully farther from wrist than ip joint
  const distTip = Math.abs(thumbTip.x - wrist.x)
  const distIp = Math.abs(thumbIp.x - wrist.x)

  if (thumbExtended && distTip > distIp) {
    count++
  }

  return count as FingerCount
}