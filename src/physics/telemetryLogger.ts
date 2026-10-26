/**
 * telemetryLogger.ts — per-session flight-telemetry logger (DEV-ONLY).
 *
 * Writes a plain-text .log file straight into a `logs/` folder inside the
 * project, using the browser's File System Access API (Chrome/Edge only —
 * no polyfill for Firefox/Safari, this is explicitly a local dev tool for
 * chasing the current 6-DOF instability, not something that ships to the
 * deployed build). Each flight session REWRITES logs/current-flight.log
 * from scratch — that's the "rewritten for every session" behavior — and
 * samples telemetry once every 0.5s of SIM TIME (not wall clock, since the
 * rAF loop's dt varies and is capped).
 *
 * One-time setup per browser tab: call `telemetryLogger.chooseLogFolder()`
 * once (e.g. from a dev-only button, or the browser console) to grant
 * permission to the project's `logs/` folder. After that, every launch
 * writes straight to disk with no download/save-as dialog. If permission
 * was never granted (or the browser doesn't support the API), this falls
 * back to a one-shot browser download of the same plain-text content, so
 * nothing silently does nothing.
 *
 * IMPORTANT: add `logs/` to the project's .gitignore so these never get
 * committed — this logger exists only to debug the current branch's 6-DOF
 * work and goes away before this app is ever deployed.
 */

import type { Telemetry } from '../types'

const SAMPLE_INTERVAL = 0.5 // seconds of SIM time between log rows
const LOG_FILENAME = 'current-flight.log'

/** Flat field list so the log's column line and each row stay in lockstep.
 *  Named out explicitly so a future Telemetry field addition doesn't
 *  silently vanish from new logs without a deliberate decision to add it. */
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

// Minimal structural types for the File System Access API — not in every
// TS lib.dom.d.ts version yet, so declared locally rather than depending
// on a specific lib target.
interface FsFileHandle {
  createWritable(): Promise<FsWritable>
}
interface FsWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
}
interface FsDirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>
}
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FsDirHandle>
  }
}

export class TelemetryLogger {
  private rows: LogRow[] = []
  private nextSampleAt = 0
  private sessionStartWall = 0
  private sessionId = ''
  private meta: SessionMeta = {}
  private flushed = false
  private dirHandle: FsDirHandle | null = null

  /** One-time per tab: ask the browser for write access to a folder (pick
   *  the project's `logs/` folder, creating it first in VS Code's file
   *  explorer if it doesn't exist yet). Call this from a dev button or the
   *  console — browsers require a user gesture for showDirectoryPicker, so
   *  it can't be triggered automatically on page load. Silently does
   *  nothing if the API isn't available (non-Chromium browser). */
  async chooseLogFolder(): Promise<boolean> {
    if (!window.showDirectoryPicker) {
      console.warn('[telemetryLogger] File System Access API not available in this browser — falling back to download.')
      return false
    }
    try {
      this.dirHandle = await window.showDirectoryPicker({ id: 'kalam-logs', mode: 'readwrite' })
      console.info('[telemetryLogger] Log folder granted — flights will write logs/current-flight.log directly.')
      return true
    } catch {
      console.warn('[telemetryLogger] Log folder permission was not granted — falling back to download.')
      return false
    }
  }

  /** Call this exactly where the engine is launched (handleLaunch in
   *  App.tsx). Wipes the in-memory buffer — every new flight's log
   *  REWRITES current-flight.log from scratch once flushed, so nothing
   *  from a previous session lingers in the file. */
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
   *  or whenever you want the current buffer written out. Writes (or
   *  re-writes) logs/current-flight.log and marks the session flushed so
   *  repeated calls (outcome checked every frame after landing) don't
   *  write over and over. */
  flushIfDone(t: Telemetry): void {
    if (this.flushed) return
    if (t.outcome === 'flying') return
    this.record(t) // make sure the final state is captured even off-cadence
    void this.write()
    this.flushed = true
  }

  /** Write the current buffer out now, regardless of outcome — useful to
   *  pull a partial log mid-flight from the console:
   *  `telemetryLogger.write()`. Writes to logs/current-flight.log if a
   *  folder handle was granted via chooseLogFolder(); otherwise falls back
   *  to a one-shot browser download of the identical text so nothing is
   *  silently lost. */
  async write(): Promise<void> {
    if (this.rows.length === 0) return
    const text = this.toLog()

    if (this.dirHandle) {
      try {
        const fileHandle = await this.dirHandle.getFileHandle(LOG_FILENAME, { create: true })
        const writable = await fileHandle.createWritable() // truncates — full rewrite each flush
        await writable.write(text)
        await writable.close()
        console.info(`[telemetryLogger] Wrote logs/${LOG_FILENAME} (${this.rows.length} rows).`)
        return
      } catch (err) {
        console.warn('[telemetryLogger] Failed to write to the granted log folder, falling back to download.', err)
      }
    }
    this.downloadFallback(text)
  }

  private downloadFallback(text: string): void {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = LOG_FILENAME
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Raw rows for inline debugging (e.g. console.table(logger.rowsForDebug())). */
  rowsForDebug(): LogRow[] {
    return this.rows
  }

  private toLog(): string {
    const metaLine = `session=${this.sessionId} vehicle=${this.meta.vehicleId ?? ''} params=${JSON.stringify(this.meta.params ?? {})}`
    const header = ['wallTimeMs', ...LOG_FIELDS].join('\t')
    const lines = this.rows.map((row) => {
      const cells = [row.wallTime.toFixed(0)]
      for (const f of LOG_FIELDS) {
        cells.push(String(row.t[f]))
      }
      return cells.join('\t')
    })
    return [metaLine, header, ...lines].join('\n') + '\n'
  }
}

/** One shared instance — mirrors how `machine`/`gestures` are module-level
 *  singletons in App.tsx. Import this directly rather than constructing
 *  your own, so there's exactly one logger per app instance. */
export const telemetryLogger = new TelemetryLogger()