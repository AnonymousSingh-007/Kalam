import type { DetectedHand, FingerCount } from '../types'

/**
 * Take a detected hand's 21 landmarks and return how many fingers are
 * extended (0-5), or null if not confident.
 */
const FINGER_TIPS = [8, 12, 16, 20] // index, middle, ring, pinky
const FINGER_PIPS = [6, 10, 14, 18]
const THUMB_EXTEND_RATIO = 1.1 // tip must be at least 10% farther out than base

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

  const lm = hand.landmarks
  let count = 0

  // Four fingers: tip above pip (smaller y = higher/extended in image space)
  for (let i = 0; i < 4; i++) {
    if (lm[FINGER_TIPS[i]].y < lm[FINGER_PIPS[i]].y) {
      count++
    }
  }

  // Thumb: distance-based, handedness-agnostic (Euclidean distance is
  // mirror-invariant, so this works regardless of camera mirroring or
  // reported handedness — no hand.handedness branch needed).
  // Reference point is the pinky-finger base (landmark 17) rather than the
  // index base (landmark 5): it sits much farther across the palm from the
  // thumb, so folded-vs-extended produces a bigger, more reliable distance
  // swing than a reference right next to the thumb's own base.
  const thumbTip = lm[4]
  const thumbMcp = lm[2]
  const pinkyMcp = lm[17]

  const tipDist = distance(thumbTip, pinkyMcp)
  const baseDist = distance(thumbMcp, pinkyMcp)

  const thumbExtended = tipDist > baseDist * THUMB_EXTEND_RATIO
  if (thumbExtended) {
    count++
  }

  return count as FingerCount
}