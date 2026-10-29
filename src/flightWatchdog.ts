/**
 * flightWatchdog.ts — local, rule-based flight-termination watchdog.
 *
 * NOT a 3rd-party API, NOT a hosted model — a small deterministic set of
 * threshold/rate checks run entirely on this machine, in-browser, against
 * the telemetry the engine already produces every frame. Mirrors what a
 * real rocket's flight termination system (FTS) does: watch a handful of
 * flight-safety signals, and if any crosses a hard limit, cut thrust and
 * trigger recovery before the vehicle (or, here, the integrator) does
 * something worse.
 *
 * Context: at extreme thrust-to-weight ratios (TWR > ~15, see
 * flightSanity.ts's pre-launch warning) the 6-DOF control loop can lose
 * its grip once angle of attack swings past 90 degrees — gimbal/fin
 * actuators saturate chasing a target that outruns their own rate limits,
 * and yaw/pitch rates run away into the thousands of deg/s within a
 * couple seconds. flightSanity.ts warns about this BEFORE launch; this
 * watchdog catches it DURING flight, for the case where the user launched
 * anyway (their call, per the warning) but still wants the sim to recover
 * gracefully instead of running the integrator into garbage numbers.
 *
 * Usage: call `checkWatchdog(telemetry)` every frame (or every sampled
 * tick) with the latest Telemetry snapshot. If it returns a non-null
 * verdict, call `engine.abort()` and surface `verdict.reason` to the user.
 * The watchdog itself holds no state across calls — one snapshot in, one
 * verdict out — so it's trivial to unit test and impossible to leak state
 * between flights (each new engine.launch() / telemetryLogger.startSession()
 * naturally starts the watchdog fresh too, since there's nothing to reset).
 */

import type { Telemetry } from './types'

/** Thresholds are deliberately generous relative to normal flight (a
 *  realistic rocket under aggressive stick input still stays well under
 *  these, per the realistic-TWR stability test), but well below the
 *  runaway values seen in the reproduced extreme-TWR blowups (rates in the
 *  thousands to hundreds of thousands of deg/s, altitude/velocity hitting
 *  non-finite or astronomically large values). */
const MAX_SANE_RATE_DEG_S = 2000       // any axis — pitch/yaw/roll rate
const MAX_SANE_ANGVEL_SUM_DEG_S = 3000 // combined magnitude across axes, catches coupled tumbles
const MAX_SANE_MACH = 500              // well past any realistic vehicle, short of the 10^4+ seen in blowups
const MAX_SANE_ALTITUDE_M = 5_000_000  // 5,000 km — generous, but catches the 10^8+ runaway case

export type AbortReason =
  | 'non_finite_telemetry'
  | 'angular_rate_runaway'
  | 'mach_runaway'
  | 'altitude_runaway'

export interface WatchdogVerdict {
  reason: AbortReason
  message: string
}

/** Returns null when telemetry looks sane, or a verdict describing what
 *  tripped. Pure function — no side effects, no state. Caller is
 *  responsible for acting on a non-null result (calling engine.abort()). */
export function checkWatchdog(t: Telemetry): WatchdogVerdict | null {
  // non-finite check first — any NaN/Infinity anywhere in the core state
  // means the integrator has already gone off the rails, independent of
  // any particular threshold
  const coreFields: number[] = [
    t.altitude, t.velocity, t.lateralOffset, t.positionZ,
    t.bodyAngle, t.angularVelocity, t.yawAngle, t.yawRate, t.rollAngle, t.rollRate,
    t.machNumber, t.dynamicPressure,
  ]
  if (coreFields.some((v) => !Number.isFinite(v))) {
    return {
      reason: 'non_finite_telemetry',
      message: 'Flight telemetry produced a non-finite value (NaN/Infinity) — aborting before it propagates further.',
    }
  }

  const rateSum = Math.abs(t.angularVelocity) + Math.abs(t.yawRate) + Math.abs(t.rollRate)
  if (
    Math.abs(t.angularVelocity) > MAX_SANE_RATE_DEG_S ||
    Math.abs(t.yawRate) > MAX_SANE_RATE_DEG_S ||
    Math.abs(t.rollRate) > MAX_SANE_RATE_DEG_S ||
    rateSum > MAX_SANE_ANGVEL_SUM_DEG_S
  ) {
    return {
      reason: 'angular_rate_runaway',
      message: `Angular rate runaway (pitch ${t.angularVelocity.toFixed(0)}°/s, yaw ${t.yawRate.toFixed(0)}°/s, roll ${t.rollRate.toFixed(0)}°/s) — the control loop has lost attitude control.`,
    }
  }

  if (t.machNumber > MAX_SANE_MACH) {
    return {
      reason: 'mach_runaway',
      message: `Mach number (${t.machNumber.toFixed(0)}) is far beyond any realistic flight regime — likely a runaway acceleration from an unstable control loop.`,
    }
  }

  if (Math.abs(t.altitude) > MAX_SANE_ALTITUDE_M) {
    return {
      reason: 'altitude_runaway',
      message: `Altitude (${(t.altitude / 1000).toFixed(0)} km) is far beyond any realistic flight regime.`,
    }
  }

  return null
}