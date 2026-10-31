import type { Telemetry, CommentaryTrigger } from '../types'
import { getLine, type CommentaryData } from './lines'

/** `important`: true for stage transitions, max-Q, and event-reactive
 *  lines (ignition, burnout, high-g, etc.) — one-shot moments worth
 *  queuing for if speech is mid-sentence. false for periodic ascent/
 *  coast/descent filler, which is safe to drop when busy since another
 *  one follows within a few seconds regardless. */
export interface CommentaryResult {
  text: string
  important: boolean
}

const PERIODIC_INTERVAL = 8        // seconds between periodic coast/descent lines
const ASCENT_PERIODIC_INTERVAL = 4 // seconds between periodic powered-ascent lines (burns are short, keep it livelier)
const HIGH_G_THRESHOLD = 7        // axial g-load above this fires high-g event
const HIGH_AOA_THRESHOLD = 15     // degrees above this fires high-aoa event
const FAST_DESCENT_THRESHOLD = 80 // m/s downward above this fires fast-descent event
const RECENT_LINE_MEMORY = 12     // how many recently fired lines are excluded from re-selection

export class CommentaryEngine {
  private lastStage: Telemetry['stage'] | null = null
  private maxQFired = false
  private maxDynamicPressure = 0
  private lastPeriodicTime = 0

  // Event flags — one-shot per launch so events don't spam
  private highGFired = false
  private highAoaFired = false
  private fastDescentFired = false

  // No-repeat queue — ring buffer of recently spoken lines
  private recentLines: string[] = []

  reset(): void {
    this.lastStage = null
    this.maxQFired = false
    this.maxDynamicPressure = 0
    this.lastPeriodicTime = 0
    this.highGFired = false
    this.highAoaFired = false
    this.fastDescentFired = false
    this.recentLines = []
  }

  private buildData(telemetry: Telemetry): CommentaryData {
    return {
      altitude: telemetry.altitude,
      velocity: telemetry.velocity,
      axialGLoad: telemetry.axialGLoad,
      lateralGLoad: telemetry.lateralGLoad,
      angleOfAttack: telemetry.angleOfAttack,
      time: telemetry.time
    }
  }

  private fire(trigger: CommentaryTrigger, data: CommentaryData): string | null {
    const exclude = new Set(this.recentLines)
    const line = getLine(trigger, data, exclude)
    if (!line) return null

    // Add to recent ring buffer
    this.recentLines.push(line)
    if (this.recentLines.length > RECENT_LINE_MEMORY) {
      this.recentLines.shift()
    }
    return line
  }

  tick(telemetry: Telemetry, airDensity: number): CommentaryResult | null {
    const data = this.buildData(telemetry)
    let line: string | null = null
    let important = false

    // ---- Max-Q detection ----
    const dynamicPressure = 0.5 * airDensity * telemetry.velocity * telemetry.velocity
    if (dynamicPressure > this.maxDynamicPressure) {
      this.maxDynamicPressure = dynamicPressure
    } else if (
      !this.maxQFired &&
      telemetry.stage === 'powered-ascent' &&
      dynamicPressure < this.maxDynamicPressure * 0.85
    ) {
      this.maxQFired = true
      line = this.fire('max-q', data)
      important = true
    }

    // ---- Stage transitions ----
    if (telemetry.stage !== this.lastStage) {
      const map: Partial<Record<Telemetry['stage'], CommentaryTrigger>> = {
        'powered-ascent': 'ignition',
        coast: 'burnout',
        apogee: 'apogee',
        descent: 'descent'
      }
      const trigger = map[telemetry.stage]
      if (trigger) { line = this.fire(trigger, data); important = true }
      this.lastStage = telemetry.stage
      this.lastPeriodicTime = telemetry.time

      // Reset event flags on new stage so they can re-fire if conditions
      // persist into a new phase (e.g. high AoA through coast AND descent)
      if (telemetry.stage !== 'powered-ascent') {
        this.highGFired = false
      }
    }

    // ---- Periodic lines during long quiet phases, AND through the burn ----
    // Powered ascent gets its own shorter interval and trigger bank so the
    // commentary stays continuous from ignition through burnout, not just
    // on the way down. These are filler, not important — safe to drop if
    // a previous line is still being read, since another one follows
    // shortly anyway (unlike a stage transition or event, which is a
    // one-shot moment worth queuing for).
    if (!line && telemetry.stage === 'powered-ascent') {
      if (telemetry.time - this.lastPeriodicTime >= ASCENT_PERIODIC_INTERVAL) {
        line = this.fire('ascent', data)
        this.lastPeriodicTime = telemetry.time
      }
    } else if (
      !line &&
      (telemetry.stage === 'coast' || telemetry.stage === 'descent') &&
      telemetry.time - this.lastPeriodicTime >= PERIODIC_INTERVAL
    ) {
      const trigger: CommentaryTrigger =
        telemetry.stage === 'coast' ? 'coast' : 'descent'
      line = this.fire(trigger, data)
      this.lastPeriodicTime = telemetry.time
    }

    // ---- Event-reactive: high G-load ----
    if (
      !line &&
      !this.highGFired &&
      telemetry.stage === 'powered-ascent' &&
      telemetry.axialGLoad > HIGH_G_THRESHOLD
    ) {
      this.highGFired = true
      line = this.fire('high-g', data)
      important = true
    }

    // ---- Event-reactive: steep angle of attack ----
    if (
      !line &&
      !this.highAoaFired &&
      telemetry.angleOfAttack > HIGH_AOA_THRESHOLD
    ) {
      this.highAoaFired = true
      line = this.fire('high-aoa', data)
      important = true
    }

    // ---- Event-reactive: fast descent ----
    if (
      !line &&
      !this.fastDescentFired &&
      telemetry.stage === 'descent' &&
      telemetry.velocity < -FAST_DESCENT_THRESHOLD
    ) {
      this.fastDescentFired = true
      line = this.fire('fast-descent', data)
      important = true
    }

    if (!line) return null
    return { text: line, important }
  }

  fireLanded(telemetry: Telemetry): string {
    return this.fire('landed', this.buildData(telemetry)) ?? ''
  }

  firePreLaunch(telemetry: Telemetry): string {
    return this.fire('pre-launch', this.buildData(telemetry)) ?? ''
  }

  fireCountdown(telemetry: Telemetry): string {
    return this.fire('countdown', this.buildData(telemetry)) ?? ''
  }
}