/**
 * postFlightReport.ts — post-flight debrief: stats, plain-language
 * feedback explaining WHY the flight landed or crashed, and concrete
 * suggestions for the next launch.
 *
 * Same shape as flightSanity.ts and flightWatchdog.ts: a pure function,
 * no state, no DOM/React dependency, callable headlessly for testing.
 * Takes the FINAL telemetry snapshot (the one captured the instant
 * outcome transitions to 'landed' or 'crashed' — see App.tsx), the
 * RocketParams that flew, the watchdog abort message (if any), and an
 * optional sampled history of Telemetry across the whole flight (also
 * captured by App.tsx, downsampled to ~10/s) — and returns one
 * PostFlightReport object, now including per-phase SeriesData for the
 * dashboard's graphs alongside the plain stats/feedback/suggestions.
 * This module never reads live/current telemetry or holds any reference
 * to the engine; it's handed snapshots and returns one report, so
 * building a report is trivial to unit test and cannot accidentally
 * depend on timing. `history` defaults to [] so existing callers/tests
 * written before the dashboard existed still compile unchanged — the
 * resulting report just has empty series/phases, which the UI treats as
 * "no dashboard data, fall back to stat tiles."
 *
 * Why landed-vs-crashed needs its OWN explanation, not just the verdict:
 * rocketPhysics.ts's touchdown() already decides 'landed' or 'crashed'
 * from three independent thresholds (impact speed, tilt from vertical,
 * spin rate — see LANDING_LIMITS, exported from rocketPhysics.ts so this
 * module checks the SAME numbers the engine actually used, not a second
 * guessed copy). A crash from "came in 40 m/s too fast, dead vertical,
 * no spin" and a crash from "landed gently but tipped over" are both
 * `outcome: 'crashed'` with very different real causes and very
 * different fixes — this module's job is to say which one actually
 * happened.
 */

import type { Telemetry, RocketParams, FlightStage } from './types'
import { LANDING_LIMITS } from './physics/rocketPhysics'

const G0 = 9.80665

export interface FlightStat {
  label: string
  value: string
}

/** One named curve for the dashboard, already in display units. `points`
 *  is [time, value] pairs in flight-time order — the chart component
 *  just maps these to pixel space, no unit conversion of its own. */
export interface SeriesData {
  label: string
  unit: string
  color: string
  points: [number, number][]
}

/** A labeled time range the dashboard shades/divides the graphs by —
 *  derived from Telemetry.stage transitions in the sampled history, so
 *  "which phase was this" always matches what the physics engine itself
 *  was doing at that instant, never a second guessed segmentation. */
export interface FlightPhase {
  stage: FlightStage
  label: string
  startTime: number
  endTime: number
}

export interface PostFlightReport {
  outcome: 'landed' | 'crashed'
  /** True when the flight ended via the in-flight watchdog's abort(),
   *  not a normal touchdown — changes which feedback sentences apply
   *  (a watchdog abort is a control-loop failure, not a landing-quality
   *  issue, even though it still ends in outcome: 'crashed' most of the
   *  time). */
  wasAborted: boolean
  abortMessage: string | null
  stats: FlightStat[]
  /** Plain technical language explaining what happened and why —
   *  3 to 6 short sentences, each standalone (no "however"/"but"
   *  chaining across sentences), ordered most-important-first. */
  feedback: string[]
  /** Concrete, actionable suggestions for the NEXT launch, derived from
   *  which specific thing went wrong — empty array for a clean landed
   *  flight with nothing to suggest changing. */
  suggestions: string[]
  /** Per-phase time series for the dashboard's graphs. Empty when no
   *  history was sampled (e.g. the flight ended on literally the first
   *  tick) — the UI falls back to the plain stat tiles in that case. */
  series: SeriesData[]
  phases: FlightPhase[]
}

const STAGE_LABEL: Record<FlightStage, string> = {
  'pre-launch': 'Pre-Launch',
  'powered-ascent': 'Powered Ascent',
  coast: 'Coast',
  apogee: 'Apogee',
  descent: 'Descent',
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals)
}

/** Walk the sampled history and collapse consecutive same-stage samples
 *  into named phase ranges. Pure function of the history array — reads
 *  nothing else, so it's trivial to feed a hand-built history in a test. */
function derivePhases(history: Telemetry[]): FlightPhase[] {
  const phases: FlightPhase[] = []
  for (const t of history) {
    const last = phases[phases.length - 1]
    if (last && last.stage === t.stage) {
      last.endTime = t.time
    } else {
      phases.push({ stage: t.stage, label: STAGE_LABEL[t.stage], startTime: t.time, endTime: t.time })
    }
  }
  return phases
}

function buildSeries(history: Telemetry[]): SeriesData[] {
  if (history.length === 0) return []
  const pick = (f: (t: Telemetry) => number): [number, number][] =>
    history.map((t) => [t.time, f(t)])

  return [
    { label: 'Altitude', unit: 'm', color: '#00f0ff', points: pick((t) => t.altitude) },
    { label: 'Velocity', unit: 'm/s', color: '#ff2bd6', points: pick((t) => t.velocity) },
    { label: 'Acceleration', unit: 'm/s²', color: '#7cff6b', points: pick((t) => t.acceleration) },
    { label: 'Mach', unit: '', color: '#ffd166', points: pick((t) => t.machNumber) },
    { label: 'Dynamic Pressure', unit: 'kPa', color: '#a06bff', points: pick((t) => t.dynamicPressure / 1000) },
    { label: 'Throttle', unit: '%', color: '#ff7a00', points: pick((t) => t.throttle * 100) },
  ]
}

export function generateReport(
  telemetry: Telemetry,
  params: RocketParams,
  abortMessage: string | null,
  history: Telemetry[] = []
): PostFlightReport {
  const outcome = telemetry.outcome === 'crashed' ? 'crashed' : 'landed'
  const wasAborted = abortMessage !== null
  const totalMass = Math.max(params.dryMass + params.propellantMass, 0.001)
  const twr = params.thrust / (totalMass * G0)
  const burnTime = params.burnRate > 1e-6 ? params.propellantMass / params.burnRate : Infinity

  const stats: FlightStat[] = [
    { label: 'Outcome', value: outcome === 'landed' ? 'Landed' : 'Crashed' },
    { label: 'Apogee', value: `${fmt(telemetry.maxAltitude, 0)} m` },
    { label: 'Max velocity', value: `${fmt(telemetry.maxVelocity, 0)} m/s` },
    { label: 'Max Mach', value: fmt(telemetry.maxMach, 2) },
    { label: 'Max dynamic pressure', value: `${fmt(telemetry.maxQ / 1000, 1)} kPa` },
    { label: 'Thrust-to-weight', value: `${fmt(twr, 1)}:1` },
    { label: 'Burn time', value: Number.isFinite(burnTime) ? `${fmt(burnTime, 1)} s` : 'n/a' },
    { label: 'Impact speed', value: `${fmt(telemetry.impactSpeed, 1)} m/s` },
    { label: 'Touchdown tilt', value: `${fmt(telemetry.touchdownTilt, 0)}° from vertical` },
    { label: 'Touchdown spin', value: `${fmt(telemetry.touchdownSpin, 0)}°/s` },
    { label: 'Flight time', value: `${fmt(telemetry.time, 1)} s` },
  ]

  const feedback: string[] = []
  const suggestions: string[] = []

  // ---- Abort takes priority in the explanation, even if the eventual
  // outcome also happens to read 'crashed' — the actual cause was the
  // control loop losing authority, not a landing-quality problem, and
  // telling the player "you landed too fast" when the real story is
  // "the watchdog had to terminate the flight" would point them at the
  // wrong fix.
  if (wasAborted) {
    feedback.push(
      `Flight terminated automatically: ${abortMessage}.`,
      'This is a safety abort, not a landing judgment — the control loop lost the ability to hold attitude before it reached the ground.'
    )
    if (twr > 15) {
      suggestions.push(
        `Thrust-to-weight was ${fmt(twr, 1)}:1 — real rockets fly at 1.2 to 4:1. Lowering thrust or adding mass toward that range gives the flight computer a fighting chance to hold attitude through the whole burn.`
      )
    } else {
      suggestions.push(
        'The parameters were within a normally stable range, so this termination is likely from sustained aggressive steering rather than the vehicle design itself. Try shorter, lighter inputs on the pitch axis instead of holding a key for the whole ascent.'
      )
    }
  } else if (outcome === 'landed') {
    feedback.push(
      `Touchdown at ${fmt(telemetry.impactSpeed, 1)} m/s, ${fmt(telemetry.touchdownTilt, 0)}° from vertical, spinning at ${fmt(telemetry.touchdownSpin, 0)}°/s — all three are within the limits for a soft landing (${LANDING_LIMITS.maxImpactSpeedMs} m/s, ${LANDING_LIMITS.maxTiltDeg}°, ${LANDING_LIMITS.maxSpinDegS}°/s).`
    )
  } else {
    // Crashed, not aborted — explain which threshold(s) it actually
    // broke, since that's the part the bare 'crashed' outcome doesn't
    // say. More than one can be true at once; report every one that
    // applies rather than stopping at the first.
    const brokeSpeed = telemetry.impactSpeed > LANDING_LIMITS.maxImpactSpeedMs
    const brokeTilt = telemetry.touchdownTilt > LANDING_LIMITS.maxTiltDeg
    const brokeSpin = telemetry.touchdownSpin > LANDING_LIMITS.maxSpinDegS

    if (brokeSpeed) {
      feedback.push(
        `Impact speed was ${fmt(telemetry.impactSpeed, 1)} m/s against a ${LANDING_LIMITS.maxImpactSpeedMs} m/s limit — the vehicle came down too fast for the recovery system to absorb.`
      )
      suggestions.push(
        'Check that the drogue and main parachute actually deployed before touchdown (chuteState in telemetry) — a chute that never opens, or opens too late, is the most common cause of an over-speed landing. If it did deploy, a lighter dry mass gives the same canopy a lower terminal descent rate.'
      )
    }
    if (brokeTilt) {
      feedback.push(
        `Touchdown tilt was ${fmt(telemetry.touchdownTilt, 0)}° from vertical against a ${LANDING_LIMITS.maxTiltDeg}° limit — the vehicle landed leaning too far over to count as upright.`
      )
      suggestions.push(
        'A tilted touchdown usually traces back to attitude that was never fully corrected during descent. Avoid steering inputs late in the flight that you don\'t hold long enough to settle — a brief tap right before landing can leave the vehicle still rotating when it touches down.'
      )
    }
    if (brokeSpin) {
      feedback.push(
        `Touchdown spin was ${fmt(telemetry.touchdownSpin, 0)}°/s against a ${LANDING_LIMITS.maxSpinDegS}°/s limit — the vehicle was still rotating too fast to count as a controlled landing.`
      )
      suggestions.push(
        'Residual spin at touchdown usually means a steering input was released too close to the ground for the attitude-hold loop to finish settling it. Release pitch input earlier in the descent so the vehicle has time to stop rotating before it reaches the ground.'
      )
    }
    if (!brokeSpeed && !brokeTilt && !brokeSpin) {
      // Shouldn't normally happen (touchdown() only sets 'crashed' when
      // at least one threshold is broken), but telemetry is rounded for
      // display while the engine's own check uses unrounded state, so a
      // value sitting exactly on a threshold can display as "within
      // limits" after rounding even though the unrounded check crossed
      // it. State this plainly rather than claim a cause with no
      // supporting number.
      feedback.push(
        'The flight was classified as a crash, but no individual touchdown value in this report reads clearly over its limit — it likely sat right at the boundary before rounding for display.'
      )
    }
  }

  return {
    outcome,
    wasAborted,
    abortMessage,
    stats,
    feedback,
    suggestions,
    series: buildSeries(history),
    phases: derivePhases(history),
  }
}