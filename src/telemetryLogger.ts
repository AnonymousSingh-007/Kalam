/**
 * telemetryLogger.ts — per-session flight-telemetry logger.
 *
 * Standalone module, no dependency on rocketPhysics.ts or React — just
 * plain state + a browser download. One logger instance should live for
 * the whole app lifetime (like `machine`/`gestures` in App.tsx); call
 * `startSession()` at the same point `engine.launch()` is called, and feed
 * it every telemetry snapshot you already compute in the main loop.
 *
 * Sampling is keyed off TELEMETRY SIM TIME (t.time), not wall-clock frame
 * timestamps — the rAF loop's dt varies and is capped, so sim time is the
 * only clock that behaves the same on a fast machine and a slow one. A
 * sample is recorded the first time sim time crosses each 0.5s boundary
 * (0, 0.5, 1.0, 1.5, ...), so the log has one row per half-second of
 * flight regardless of actual frame rate.
 *
 * Each call to startSession() discards whatever was buffered before and
 * begins a brand-new log — "rewritten for every session" per the design
 * intent: nothing carries over between flights, and a session that never
 * reaches a terminal outcome (landed/crashed) just never gets flushed,
 * which is the correct behavior for an aborted run.
 */

import type { Telemetry } from '../types'

const SAMPLE_INTERVAL = 0.5 // seconds of SIM time between log rows

/** The subset of Telemetry fields worth logging — everything, basically,
 *  but named out explicitly so a future Telemetry field addition doesn't
 *  silently vanish from new logs without a deliberate decision to add it
 *  here. Kept as a flat list so the CSV header and row stay in lockstep. */
const LOG_FIELDS: Array<keyof Telemetry> = [
  'time', 'stage', 'outcome',
  'altitude', 'velocity', 'acceleration',
  'lateralOffset', 'lateralVelocity', 'positionZ', 'velocityZ',
  'bodyAngle', 'angularVelocity', 'yawAngle', 'yawRate', 'rollAngle', 'rollRate',
  'gimbalAngle', 'gimbalYawAngle', 'gimbalCommand', 'finAngle', 'finYawAngle',
  'angleOfAttack', 'dynamicPressure', 'machNumber',
  'thrustNewtons', 'isp', 'twr', 'mass', 'propellantRemaining',
  'maxQ', 'maxMach', 'maxAltitude',
  'axialGLoad', 'lateralGLoad',
  'airspeed', 'flightPathAngle',
  'rcsFuel', 'rcsTorque', 'rcsTorqueYaw', 'rcsTorqueRoll',
  'pitchRateCommand', 'attitudeTarget',
  'staticMargin', 'centerOfGravity', 'centerOfPressure', 'momentOfInertia',
  'airDensity', 'airPressure', 'airTemperature', 'speedOfSound', 'windSpeed', 'cdAxial',
  'chuteState', 'impactSpeed',
]

export interface SessionMeta {
  vehicleId?: string
  params?: Record<string, number>
}

interface LogRow {
  wallTime: number // ms since session start, for correlating with console/bug reports
  t: Telemetry
}

export class TelemetryLogger {
  private rows: LogRow[] = []
  private nextSampleAt = 0
  private sessionStartWall = 0
  private sessionId = ''
  private meta: SessionMeta = {}
  private flushed = false

  /** Call this exactly where the engine is launched (handleLaunch in
   *  App.tsx). Wipes any previous session's buffer — "rewritten for every
   *  session" means the OLD in-memory log is discarded here, not that the
   *  old downloaded file is touched; each session produces its own
   *  separately-named file via autoDownload() so nothing overwrites a
   *  prior flight's download on disk. */
  startSession(meta: SessionMeta = {}): void {
    this.rows = []
    this.nextSampleAt = 0
    this.sessionStartWall = performance.now()
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-')
    this.meta = meta
    this.flushed = false
  }

  /** Feed every telemetry snapshot from the main loop. Cheap no-op most
   *  frames — only records a row when sim time has crossed the next 0.5s
   *  boundary. Safe to call even before startSession() (ignored). */
  record(t: Telemetry): void {
    if (!this.sessionId) return
    if (t.time + 1e-9 < this.nextSampleAt) return
    this.rows.push({ wallTime: performance.now() - this.sessionStartWall, t: { ...t } })
    // advance past every boundary the sim may have jumped over in one step
    // (a slow frame can cover more than 0.5s of sim time at once)
    while (this.nextSampleAt <= t.time + 1e-9) this.nextSampleAt += SAMPLE_INTERVAL
  }

  /** Call when the flight reaches a terminal outcome ('landed' | 'crashed')
   *  or whenever you want the current buffer written out. Triggers a
   *  browser download and marks the session flushed so repeated calls
   *  (e.g. outcome checked every frame after landing) don't re-download. */
  flushIfDone(t: Telemetry): void {
    if (this.flushed) return
    if (t.outcome === 'flying') return
    this.record(t) // make sure the final state is captured even off-cadence
    this.download()
    this.flushed = true
  }

  /** Force a download right now regardless of outcome — useful for a
   *  manual "dump telemetry" debug button, or calling this from the
   *  browser console mid-flight to see what's logged so far. */
  download(): void {
    if (this.rows.length === 0) return
    const csv = this.toCsv()
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kalam-flight-${this.sessionId}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Raw rows for inline debugging (e.g. console.table(logger.rowsForDebug())). */
  rowsForDebug(): LogRow[] {
    return this.rows
  }

  private toCsv(): string {
    const header = ['wallTimeMs', ...LOG_FIELDS].join(',')
    const metaLine = `# session=${this.sessionId} vehicle=${this.meta.vehicleId ?? ''} params=${JSON.stringify(this.meta.params ?? {})}`
    const lines = this.rows.map((row) => {
      const cells = [row.wallTime.toFixed(0)]
      for (const f of LOG_FIELDS) {
        const v = row.t[f]
        cells.push(typeof v === 'number' ? String(v) : `"${String(v)}"`)
      }
      return cells.join(',')
    })
    return [metaLine, header, ...lines].join('\n')
  }
}

/** One shared instance — mirrors how `machine`/`gestures` are module-level
 *  singletons in App.tsx. Import this directly rather than constructing
 *  your own, so there's exactly one logger per app instance. */
export const telemetryLogger = new TelemetryLogger()