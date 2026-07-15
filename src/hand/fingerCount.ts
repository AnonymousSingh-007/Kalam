import type { DetectedHand, FingerCount } from '../types'

/**
 * Take a detected hand's 21 landmarks and return how many fingers are
 * extended (0-5), or null if not confident.
 */
const FINGER_TIPS = [8, 12, 16, 20] // index, middle, ring, pinky
const FINGER_PIPS = [6, 10, 14, 18]
const MIN_CONFIDENCE = 0.5
const THUMB_EXTEND_RATIO = 1.15 // tip must be at least 15% farther out than base

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

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

  // Thumb: distance-based, handedness-agnostic.
  // Compare thumb tip's distance from the index-finger base (landmark 5)
  // against the thumb's own base joint's distance from the same point.
  // When the thumb is extended outward, the tip sits noticeably farther
  // from the palm than when it's tucked in.
  const thumbTip = lm[4]
  const thumbMcp = lm[2]
  const indexMcp = lm[5]

  const tipDist = distance(thumbTip, indexMcp)
  const baseDist = distance(thumbMcp, indexMcp)

  const thumbExtended = tipDist > baseDist * THUMB_EXTEND_RATIO
  if (thumbExtended) {
    count++
  }

  return count as FingerCount
}