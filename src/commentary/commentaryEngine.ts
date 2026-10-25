import type { Telemetry, CommentaryTrigger } from '../types'
import { getLine, type CommentaryData } from './lines'

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

  tick(telemetry: Telemetry, airDensity: number): string | null {
    const data = this.buildData(telemetry)
    let line: string | null = null

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
      if (trigger) line = this.fire(trigger, data)
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
    // on the way down.
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
    }

    // ---- Event-reactive: steep angle of attack ----
    if (
      !line &&
      !this.highAoaFired &&
      telemetry.angleOfAttack > HIGH_AOA_THRESHOLD
    ) {
      this.highAoaFired = true
      line = this.fire('high-aoa', data)
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
    }

    return line
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