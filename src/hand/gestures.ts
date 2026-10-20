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