import type { DetectedHand } from '../types'
import { countFingers } from './fingerCount'

// Swipe and clap detection from hand landmarks. Coordinates are the raw
// (un-mirrored) camera image, normalised 0..1. A user moving a hand toward
// their own right appears as x DEcreasing in the raw image.

export type GestureEvent = 'swipe-right' | 'swipe-left' | 'clap' | null

const SWIPE_WINDOW_MS = 450
const SWIPE_MIN_DX = 0.25          // fraction of image width
const SWIPE_MAX_SLOPE = 0.6        // |dy| must stay under this × |dx|
const SWIPE_COOLDOWN_MS = 700

const CLAP_WINDOW_MS = 500
const CLAP_APART = 3.0             // palm distance / hand size before the clap
const CLAP_CLOSE = 1.6             // ...and after
const CLAP_LOST_CLOSE = 2.6        // hands vanishing (overlap) counts if last seen this close
const CLAP_COOLDOWN_MS = 1200

interface Pt { t: number; x: number; y: number }
interface Pair { t: number; r: number }

const PALM = [0, 5, 9, 13, 17]

function palmCentre(h: DetectedHand): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const i of PALM) {
    x += h.landmarks[i].x
    y += h.landmarks[i].y
  }
  return { x: x / PALM.length, y: y / PALM.length }
}

function handSize(h: DetectedHand): number {
  const a = h.landmarks[0]
  const b = h.landmarks[9]
  return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1e-3)
}

export class GestureDetector {
  private trail: Pt[] = []
  private pairs: Pair[] = []
  private swipeCooldownUntil = 0
  private clapCooldownUntil = 0

  info = ''

  reset(): void {
    this.trail = []
    this.pairs = []
  }

  update(hands: DetectedHand[], nowMs: number): GestureEvent {
    // ---- two hands: track closing distance ----
    if (hands.length >= 2) {
      this.trail = []
      const a = palmCentre(hands[0])
      const b = palmCentre(hands[1])
      const size = (handSize(hands[0]) + handSize(hands[1])) / 2
      const r = Math.hypot(a.x - b.x, a.y - b.y) / size
      this.pairs.push({ t: nowMs, r })
      this.pairs = this.pairs.filter((p) => nowMs - p.t <= CLAP_WINDOW_MS)
      this.info = `two hands r=${r.toFixed(2)}`
      if (nowMs >= this.clapCooldownUntil && r < CLAP_CLOSE) {
        const maxR = Math.max(...this.pairs.map((p) => p.r))
        if (maxR > CLAP_APART) return this.fireClap(nowMs)
      }
      return null
    }

    // ---- hands vanished right after closing: overlapped palms ----
    if (hands.length === 0 || this.pairs.length > 0) {
      const last = this.pairs[this.pairs.length - 1]
      if (last && nowMs - last.t <= 250 && nowMs >= this.clapCooldownUntil) {
        const maxR = Math.max(...this.pairs.map((p) => p.r))
        if (last.r < CLAP_LOST_CLOSE && maxR > CLAP_APART) return this.fireClap(nowMs)
      }
      if (!last || nowMs - last.t > 250) this.pairs = []
    }
    if (hands.length === 0) {
      this.trail = []
      this.info = 'no hand'
      return null
    }

    // ---- one open hand: horizontal swipe ----
    const hand = hands[0]
    const fingers = countFingers(hand)
    const c = palmCentre(hand)
    if (fingers === null || fingers < 4) {
      this.trail = []
      this.info = `hand closed (${fingers})`
      return null
    }
    this.trail.push({ t: nowMs, x: c.x, y: c.y })
    this.trail = this.trail.filter((p) => nowMs - p.t <= SWIPE_WINDOW_MS)
    this.info = `open hand x=${c.x.toFixed(2)}`

    if (nowMs < this.swipeCooldownUntil || this.trail.length < 4) return null
    const first = this.trail[0]
    const dx = c.x - first.x
    const dy = c.y - first.y
    if (Math.abs(dx) >= SWIPE_MIN_DX && Math.abs(dy) <= SWIPE_MAX_SLOPE * Math.abs(dx)) {
      this.swipeCooldownUntil = nowMs + SWIPE_COOLDOWN_MS
      this.trail = []
      // raw x decreasing = user's hand moving to the user's right
      return dx < 0 ? 'swipe-right' : 'swipe-left'
    }
    return null
  }

  private fireClap(nowMs: number): GestureEvent {
    this.clapCooldownUntil = nowMs + CLAP_COOLDOWN_MS
    this.swipeCooldownUntil = nowMs + SWIPE_COOLDOWN_MS
    this.pairs = []
    this.trail = []
    return 'clap'
  }
}

// ─────────────────────── in-flight pitch control ───────────────────────
//
// Raised-hand pitch input, used only during flight (App.tsx gates this to
// phase === 'launched'; GestureDetector above is reset and ignored during
// flight, since swipe/clap/cooldown bookkeeping has no meaning once a
// rocket is in the air). Deliberately NOT part of the GestureDetector
// class: swipe and clap are edge-triggered events with cooldowns and
// multi-frame trails, but "is a hand currently raised" is a plain
// per-frame level condition -- there's no trail to accumulate and no
// cooldown to respect, so giving it its own state would only have added
// unused fields to every call site that doesn't need them.
//
// RAISE_THRESHOLD_Y: MediaPipe landmarks are normalized image coordinates
// with y=0 at the TOP of frame and y=1 at the bottom (standard image
// convention, not a math/screen-space one) -- so "raised" means a palm
// centre Y *below* this threshold, not above it. 0.35 puts the trigger
// zone in roughly the upper third of the frame: high enough that a hand
// held at a normal resting/typing height in front of the webcam doesn't
// accidentally trigger it, low enough that raising a hand to about
// shoulder-to-head height (the natural "raise your hand" motion) clears
// it without the player having to stretch to the very top of frame.
const RAISE_THRESHOLD_Y = 0.35

/** Debug helper only — exposes the raw palmCentre().y a hand would be
 *  tested against in raisedHandPitch(), so App.tsx's diagnostics line
 *  can show real numbers instead of guessing why a raise isn't
 *  registering. Not used by any control-logic path itself. */
export function debugRaiseY(h: DetectedHand): number {
  return palmCentre(h).y
}

/** Binary (matches held-key magnitude, per design decision) pitch input
 *  from a raised hand: -1 = user's left hand raised (pitch left, same
 *  sign as Left arrow), +1 = user's right hand raised (pitch right, same
 *  as Right arrow), 0 = no hand raised, or both hands raised at once
 *  (ambiguous input is treated as no input, not averaged or
 *  last-write-wins -- there's no sign convention that would make "both
 *  raised" meaningful as a pitch command). Needs at least 4 visible
 *  landmarks' worth of an open-enough hand to read a stable palm centre;
 *  a closed fist is still readable here (unlike swipe, which requires an
 *  open hand) since this only needs hand POSITION, not a flat palm
 *  shape, to detect "raised."
 *
 *  HANDEDNESS IS FLIPPED FROM MediaPipe's OWN LABEL, DELIBERATELY: the
 *  on-screen webcam preview is CSS-mirrored (App.css's .webcam-pip has
 *  `transform: scaleX(-1)`) for a natural selfie view, but that mirror
 *  is a display-only CSS transform -- the raw, UNMIRRORED camera frame
 *  is what actually reaches HandTracker.detect() (a CSS transform on the
 *  <video> element doesn't touch the pixel data another API reads from
 *  it). MediaPipe's handedness classifier is trained assuming a
 *  mirrored/selfie-view input, so on an unmirrored frame its "Left"/
 *  "Right" label comes out swapped relative to the hand the user is
 *  actually looking at raise in their own (mirrored) preview. Bug found
 *  by the user testing this live: raising a hand had no visible effect,
 *  traced to this swap meaning `h.handedness === 'Right'` was true when
 *  the user's physically LEFT hand was raised, and vice versa -- so the
 *  `=== 0` keyboard-priority guard in App.tsx was never the problem,
 *  this mislabeling was. Flipped in the two branches below rather than
 *  in HandTracker.detect() itself or fingerCount.ts, since neither of
 *  those currently branches on handedness at all (fingerCount.ts is
 *  explicitly handedness-agnostic by its own comment) -- this function
 *  is the first and only consumer of handedness in this codebase, so the
 *  correction belongs here, not upstream. */
export function raisedHandPitch(hands: DetectedHand[]): -1 | 0 | 1 {
  let leftRaised = false
  let rightRaised = false
  for (const h of hands) {
    const { y } = palmCentre(h)
    if (y >= RAISE_THRESHOLD_Y) continue
    // Flipped: MediaPipe's 'Right' means the user's actual LEFT hand on
    // this unmirrored-input pipeline (see the long comment above).
    if (h.handedness === 'Right') leftRaised = true
    else if (h.handedness === 'Left') rightRaised = true
  }
  if (leftRaised && rightRaised) return 0
  if (leftRaised) return -1
  if (rightRaised) return 1
  return 0
}