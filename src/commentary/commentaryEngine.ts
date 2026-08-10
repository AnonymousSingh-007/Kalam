import type { Telemetry, CommentaryTrigger } from '../types'
import { getRandomLine } from './lines'

const PERIODIC_INTERVAL = 8 // fire a periodic line every ~8 seconds during long phases

export class CommentaryEngine {
  private lastStage: Telemetry['stage'] | null = null
  private maxQFired = false
  private maxDynamicPressure = 0
  private lastPeriodicTime = 0

  reset(): void {
    this.lastStage = null
    this.maxQFired = false
    this.maxDynamicPressure = 0
    this.lastPeriodicTime = 0
  }

  tick(telemetry: Telemetry, airDensity: number): string | null {
    let line: string | null = null

    // Max-Q detection
    const dynamicPressure = 0.5 * airDensity * telemetry.velocity * telemetry.velocity
    if (dynamicPressure > this.maxDynamicPressure) {
      this.maxDynamicPressure = dynamicPressure
    } else if (
      !this.maxQFired &&
      telemetry.stage === 'powered-ascent' &&
      dynamicPressure < this.maxDynamicPressure * 0.85
    ) {
      this.maxQFired = true
      line = getRandomLine('max-q')
    }

    // Stage transition lines
    if (telemetry.stage !== this.lastStage) {
      const fired = this.fireForStageChange(telemetry.stage)
      if (fired) line = fired
      this.lastStage = telemetry.stage
      this.lastPeriodicTime = telemetry.time
    }

    // Periodic lines during long phases (coast, descent) so it
    // doesn't go silent for 30+ seconds between stage events
    if (
      !line &&
      (telemetry.stage === 'coast' || telemetry.stage === 'descent') &&
      telemetry.time - this.lastPeriodicTime >= PERIODIC_INTERVAL
    ) {
      const trigger: CommentaryTrigger =
        telemetry.stage === 'coast' ? 'coast' : 'descent'
      line = getRandomLine(trigger)
      this.lastPeriodicTime = telemetry.time
    }

    return line
  }

  private fireForStageChange(stage: Telemetry['stage']): string | null {
    const map: Partial<Record<Telemetry['stage'], CommentaryTrigger>> = {
      'powered-ascent': 'ignition',
      coast: 'burnout',
      apogee: 'apogee',
      descent: 'descent'
    }
    const trigger = map[stage]
    return trigger ? getRandomLine(trigger) : null
  }

  fireLanded(): string {
    return getRandomLine('landed')
  }

  firePreLaunch(): string {
    return getRandomLine('pre-launch')
  }
}