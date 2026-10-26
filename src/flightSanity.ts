/**
 * flightSanity.ts — pre-launch sanity check on user-entered RocketParams.
 *
 * The flight computer's gains (K_THETA, K_OMEGA, gimbal/fin rate limits in
 * rocketPhysics.ts) were tuned for realistic rocket thrust-to-weight ratios
 * (roughly 1.2-4). Params are currently free-entry and not yet clamped to
 * per-vehicle ranges, so nothing stops a user from entering, say, 992,200 N
 * of thrust on a 15 kg dry mass — a TWR around 190. At that TWR the vehicle
 * crosses Mach 1000+ and hundreds of km of altitude within seconds, which is
 * far outside the regime the control loop (or the aero/atmosphere tables,
 * for that matter) were designed to hold attitude through; the actuators
 * overshoot once angle of attack crosses 90 degrees and the integration
 * runs away. This isn't a bug to silently clamp around — it's explicitly
 * out of the simulator's tuned envelope, so the right move is to warn and
 * let the user decide, not quietly rewrite what they typed.
 *
 * This module does NOT touch rocketPhysics.ts or clamp any param. It's a
 * pure, standalone check the UI calls right before launch() to decide
 * whether to show a confirmation dialog.
 */

import type { RocketParams } from './types'

const G0 = 9.80665

export interface SanityResult {
  ok: boolean
  twr: number
  warnings: string[]
}

/** Thresholds are deliberately generous — real rockets run TWR 1.2-4;
 *  anything past ~15 is already well beyond any crewed or uncrewed launch
 *  vehicle ever flown, and is where the control loop starts to struggle. */
const TWR_WARN = 15
const BURN_TIME_WARN_MIN = 0.05 // s — burns out almost instantly, ignition ramp barely engages
const AREA_WARN_MIN = 0.001     // m^2 — degenerate cross-section

export function checkFlightSanity(params: RocketParams): SanityResult {
  const warnings: string[] = []
  const totalMass = Math.max(params.dryMass + params.propellantMass, 0.001)
  const twr = params.thrust / (totalMass * G0)

  if (twr > TWR_WARN) {
    warnings.push(
      `Thrust-to-weight ratio is ${twr.toFixed(0)}:1 — real rockets fly at 1.2-4:1. ` +
      `Above about ${TWR_WARN}:1 the flight computer's gains can't keep up and the ` +
      `simulation may tumble or produce runaway numbers.`
    )
  }

  const burnTime = params.burnRate > 1e-6 ? params.propellantMass / params.burnRate : Infinity
  if (burnTime < BURN_TIME_WARN_MIN) {
    warnings.push(
      `Burn time is only ${(burnTime * 1000).toFixed(0)} ms at this burn rate — ` +
      `the ignition ramp barely has time to engage before burnout.`
    )
  }

  if (params.crossSectionArea < AREA_WARN_MIN) {
    warnings.push(`Cross-section area (${params.crossSectionArea} m²) is tiny enough to make the vehicle geometry degenerate.`)
  }

  return { ok: warnings.length === 0, twr, warnings }
}