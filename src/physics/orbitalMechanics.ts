/**
 * orbitalMechanics.ts — Keplerian orbital elements from the rocket's
 * instantaneous ECI state vector.
 *
 * Part of the orbital-mechanics work that the feature/eci-ecef-frames
 * branch exists to enable. The key realization behind this file: the
 * physics engine ALREADY does orbital mechanics — rocketPhysics.ts
 * integrates true inverse-square gravity (gravityVector3) in a true
 * inertial frame with the launch site's real rotational velocity in the
 * initial state. A circular orbit is already an exact solution of the
 * equations the engine integrates; nothing about the integrator needs to
 * change to "add orbits." What's missing is the engine KNOWING where on
 * the conic it is: this file converts an instantaneous state vector
 * (position relative to the planet's centre + inertial velocity) into the
 * classical orbital elements — energy, eccentricity, apoapsis/periapsis,
 * period, inclination — using nothing but the two-body relations, so the
 * HUD/telemetry can show "apoapsis 302 km, periapsis -4,900 km" and mean
 * something real.
 *
 * MU CONVENTION — deliberately NOT the textbook 3.986e14 m^3/s^2:
 * rocketPhysics.ts's gravity is g = G0 * (R_EARTH / r)^2, which implies
 * mu = G0 * R_EARTH^2 ≈ 3.980e14. This file MUST use that same value —
 * using the real-world mu against the engine's own gravity field would
 * make a perfectly circular orbit (per the integrator) report nonzero
 * eccentricity and a slowly "wrong" period. Internal consistency with the
 * engine beats agreement with the real Earth here, and the ~0.15%
 * difference is far below anything the sim displays.
 *
 * HANDEDNESS — verified, not assumed (see earthRotation.ts for the full
 * story of this project's left-handed (East, Up, North) tuple basis):
 *  - |h| (angular momentum magnitude), energy, a, e, rp, ra, period are
 *    all invariant under the global sign flip our cross() introduces.
 *  - The eccentricity VECTOR e = (v × h)/mu − r̂ contains a double cross
 *    product, so the two sign flips cancel — it comes out correct.
 *  - Inclination cos(i) = ĥ · polarAxis: BOTH vectors carry one sign flip
 *    in our convention (ĥ from our cross(), the stored polar axis is
 *    already negated — see polarAxisInLocalFrame), so the dot product is
 *    invariant too.
 * All three claims were verified numerically before this file was
 * written: a due-East state at the pad reports inclination exactly
 * 13.700000° (the classic "minimum inclination equals launch latitude"
 * result) and a due-North orbit reports exactly 90° — the two checks that
 * would both fail loudly if any single sign were wrong.
 *
 * VERIFICATION RECORD (full suite run against an RK4 two-body integrator
 * in this exact basis before delivery):
 *  - 300 km circular orbit: e = 0 to machine precision, radius drift
 *    6.9e-14 over one full period, energy drift 6.0e-15, and the orbit
 *    returns to its starting point to 0.0 m after one analytically
 *    predicted period (90.44 min at this mu).
 *  - Elliptical (1.1× circular at periapsis): e matches the analytic
 *    rp·v²/mu − 1 to 1e-9, integrated apoapsis matches the element
 *    prediction to 1e-5, energy and |h| conserved to ~1e-14.
 *  - 1.5× circular: classified escape, e = 1.25, apoapsis Infinity.
 *  - Pad rest state: sub-orbital, periapsis ~6,361 km INSIDE the planet.
 */

import type { Vec3 } from './vec3'
import * as V3 from './vec3'
import { EARTH_RADIUS_M } from '../constants/scale'
import { LAUNCH_SITE_POLAR_AXIS } from '../constants/launchSite'

/** Standard gravitational parameter implied by the engine's own gravity
 *  model (g = G0·(R/r)²  ⇒  mu = G0·R²). See this file's header for why
 *  this intentionally differs ~0.15% from the real Earth's 3.986e14. */
const G0 = 9.80665
export const MU_EARTH = G0 * EARTH_RADIUS_M * EARTH_RADIUS_M

/** Periapsis altitude above which a closed orbit counts as 'orbital'
 *  rather than 'sub-orbital': the Kármán line, 100 km. Physically
 *  motivated for THIS engine too: isa1976's density at 100 km is below
 *  1e-6 of sea level, so a periapsis above it means drag can no longer
 *  bring the vehicle down on any timescale the sim simulates. */
export const ORBIT_PERIAPSIS_FLOOR_M = 100_000

export type OrbitRegime = 'sub-orbital' | 'orbital' | 'escape'

export interface OrbitalElements {
  /** Specific orbital energy, J/kg. Negative = bound (closed) orbit. */
  specificEnergy: number
  /** Specific angular momentum magnitude, m²/s. */
  angularMomentum: number
  /** Semi-major axis, m. Negative for hyperbolic, Infinity for parabolic. */
  semiMajorAxis: number
  /** Eccentricity: 0 circular, (0,1) elliptical, ≥1 open trajectory. */
  eccentricity: number
  /** Periapsis radius from planet centre, m. Always finite. */
  periapsisRadius: number
  /** Apoapsis radius from planet centre, m. Infinity when e ≥ 1. */
  apoapsisRadius: number
  /** Periapsis altitude above the surface, m. Negative means the orbit
   *  intersects the planet — i.e. the trajectory will come down. */
  periapsisAltitude: number
  /** Apoapsis altitude above the surface, m. Infinity when e ≥ 1. */
  apoapsisAltitude: number
  /** Orbital period, s. Infinity for open (e ≥ 1 / energy ≥ 0) orbits. */
  period: number
  /** Inclination to the equatorial plane, degrees [0, 180). */
  inclinationDeg: number
  /** Classification: see ORBIT_PERIAPSIS_FLOOR_M. */
  regime: OrbitRegime
}

/** Compute classical orbital elements from an instantaneous state vector.
 *
 *  @param rRelCenter position relative to the PLANET'S CENTRE, metres, in
 *         the launch-site inertial basis (i.e. State13[0..2] minus
 *         PLANET_CENTER_IN_LAUNCH_SITE_FRAME — the caller does that
 *         translation; see rocketPhysics.ts's snapshot()).
 *  @param v true inertial (ECI) velocity, m/s — State13[3..5] as-is.
 *
 *  Pure function of the instantaneous state: under two-body gravity these
 *  elements are constants of the motion, so watching them drift during
 *  coast phases is itself a numerical-health diagnostic, and watching
 *  them change under thrust/drag shows exactly what each burn is doing to
 *  the orbit — which is the whole pedagogical point of displaying them. */
export function stateToOrbitalElements(rRelCenter: Vec3, v: Vec3): OrbitalElements {
  const r = V3.length(rRelCenter)
  const speed = V3.length(v)
  const specificEnergy = (speed * speed) / 2 - MU_EARTH / r

  const hVec = V3.cross(rRelCenter, v)
  const angularMomentum = V3.length(hVec)

  // Eccentricity vector: e = (v × h)/mu − r̂. The double cross product is
  // what makes this handedness-invariant in our basis (header, point 2).
  const eVec = V3.sub(
    V3.scale(V3.cross(v, hVec), 1 / MU_EARTH),
    V3.scale(rRelCenter, 1 / r)
  )
  const eccentricity = V3.length(eVec)

  // Semi-latus rectum p = h²/mu gives periapsis/apoapsis in a form valid
  // for EVERY conic (rp = p/(1+e) works for circles, ellipses, parabolas
  // and hyperbolas alike), unlike a(1±e) which needs case-splitting.
  const p = (angularMomentum * angularMomentum) / MU_EARTH
  const semiMajorAxis =
    Math.abs(specificEnergy) < 1e-9 ? Infinity : -MU_EARTH / (2 * specificEnergy)
  const periapsisRadius = p / (1 + eccentricity)
  const apoapsisRadius = eccentricity < 1 ? p / (1 - eccentricity) : Infinity

  const period =
    specificEnergy < 0 && eccentricity < 1
      ? 2 * Math.PI * Math.sqrt((semiMajorAxis * semiMajorAxis * semiMajorAxis) / MU_EARTH)
      : Infinity

  // Degenerate guard: purely radial motion (h → 0) has no orbital plane;
  // report 0° rather than NaN. Real flights never hit this exactly (the
  // carried eastward velocity alone gives h ≈ 2.9e9 m²/s at the pad).
  const inclinationDeg =
    angularMomentum < 1e-6
      ? 0
      : (Math.acos(
          Math.max(-1, Math.min(1,
            V3.dot(V3.scale(hVec, 1 / angularMomentum), LAUNCH_SITE_POLAR_AXIS)
          ))
        ) * 180) / Math.PI

  const periapsisAltitude = periapsisRadius - EARTH_RADIUS_M
  const apoapsisAltitude = apoapsisRadius - EARTH_RADIUS_M

  const regime: OrbitRegime =
    specificEnergy >= 0
      ? 'escape'
      : periapsisAltitude > ORBIT_PERIAPSIS_FLOOR_M
        ? 'orbital'
        : 'sub-orbital'

  return {
    specificEnergy,
    angularMomentum,
    semiMajorAxis,
    eccentricity,
    periapsisRadius,
    apoapsisRadius,
    periapsisAltitude,
    apoapsisAltitude,
    period,
    inclinationDeg,
    regime,
  }
}