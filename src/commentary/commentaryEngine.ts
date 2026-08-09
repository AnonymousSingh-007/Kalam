import type { Telemetry, CommentaryTrigger } from '../types'
import { getRandomLine } from './lines'

export class CommentaryEngine {
  private lastStage: Telemetry['stage'] | null = null
  private maxQFired = false
  private maxDynamicPressure = 0
  private lastAltitude = 0

  reset(): void {
    this.lastStage = null
    this.maxQFired = false
    this.maxDynamicPressure = 0
    this.lastAltitude = 0
  }

  tick(telemetry: Telemetry, airDensity: number): string | null {
    let line: string | null = null

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

    if (telemetry.stage !== this.lastStage) {
      const fired = this.fireForStageChange(telemetry.stage)
      if (fired) line = fired
      this.lastStage = telemetry.stage
    }

    this.lastAltitude = telemetry.altitude
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