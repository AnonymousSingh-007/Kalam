/**
 * launchSite.ts — the fixed launch pad's geodetic latitude and the
 * rotational velocity that gives the rocket at T-0.
 *
 * Part of the frames branch (feature/eci-ecef-frames). Before this branch,
 * "launch-site frame" had no latitude at all -- it was treated as a generic
 * point on a non-rotating planet, so the rocket always started at rest
 * (zero velocity) in that frame. That was never actually true of a real
 * launch: a pad fixed to the rotating Earth is itself moving through
 * inertial (ECI) space at the planet's own rotational speed at that
 * latitude -- about 465 m/s eastward at the equator, less at higher
 * latitudes (OMEGA_EARTH * R_EARTH * cos(latitude)). This file is the one
 * place that speed is computed from the site's chosen latitude, so
 * rocketPhysics.ts's T-0 initial state can add it to the rocket's ECI
 * velocity instead of starting from a literal zero.
 *
 * WHY A SEPARATE FILE FROM earthRotation.ts: earthRotation.ts is about
 * Earth's rotation as a general physical fact (true anywhere on the
 * planet, needs no site chosen). This file is about ONE SPECIFIC site's
 * properties derived from that fact -- a different kind of thing, and one
 * that would need to become a parameter (not a constant) the day Kalam
 * ever supports launching from more than one site. Keeping it separate
 * means that future change touches only this file, not earthRotation.ts's
 * already-verified rotation math.
 *
 * SITE CHOSEN: Sriharikota, India (SDSC SHAR, ISRO's spaceport) -- fits
 * the project's APJ Abdul Kalam naming and Indian launch-site theme.
 * Latitude used: 13.7 deg N (the real site's actual latitude is
 * 13.72 deg N; this project doesn't need more precision than that, and a
 * named, round value is easier to recognize in logs/tests than a
 * six-decimal one).
 */

import { EARTH_RADIUS_M } from './scale'
import { OMEGA_EARTH, polarAxisInLocalFrame, siderealAngle, ecefToEciLocal } from './earthRotation'
import type { Vec3 } from '../physics/vec3'
import * as V3 from '../physics/vec3'

/** The launch pad's geodetic latitude, degrees. Positive = Northern
 *  hemisphere. Sriharikota is at ~13.72 deg N; 13.7 is close enough for
 *  this project's fidelity level and easier to recognize/verify by hand. */
export const LAUNCH_SITE_LATITUDE_DEG = 13.7

/** Same latitude, radians -- what every trig call in this file and
 *  earthRotation.ts actually needs. Converted once here rather than at
 *  every call site. */
export const LAUNCH_SITE_LATITUDE_RAD = (LAUNCH_SITE_LATITUDE_DEG * Math.PI) / 180

/** Earth's rotation axis, expressed in the launch site's own local
 *  (East, Up, North) frame -- see earthRotation.ts's polarAxisInLocalFrame
 *  for the derivation and the sign/handedness caveat. Exposed here as a
 *  convenience so rocketPhysics.ts (and anything else that needs "this
 *  site's polar axis") doesn't have to import earthRotation.ts AND
 *  recompute this from LAUNCH_SITE_LATITUDE_RAD itself. */
export const LAUNCH_SITE_POLAR_AXIS: Vec3 = polarAxisInLocalFrame(LAUNCH_SITE_LATITUDE_RAD)

/** The launch pad's rotational speed through inertial (ECI) space, m/s,
 *  purely from being fixed to the rotating Earth at this latitude --
 *  the textbook surface-rotation-speed formula OMEGA_EARTH * R_EARTH *
 *  cos(latitude). ~465 m/s at the equator, ~452 m/s at Sriharikota's
 *  13.7 deg N (cos(13.7deg) ~ 0.9716 -- the latitude cost is small this
 *  close to the equator, which is part of why equatorial/near-equatorial
 *  sites are preferred for real orbital launches: more of this speed is
 *  "free" eastward delta-v toward an eastward orbit). */
export const LAUNCH_SITE_ROTATIONAL_SPEED_MPS =
  OMEGA_EARTH * EARTH_RADIUS_M * Math.cos(LAUNCH_SITE_LATITUDE_RAD)

/** The launch pad's velocity through inertial (ECI) space at T-0, as a
 *  full 3-vector in the site's local (East, Up, North) basis. This is
 *  PURE EAST by construction -- verified in earthRotation.ts's own tests
 *  that OMEGA x LocalUp has zero Up/North leakage at any latitude, which
 *  is exactly the vector relationship this value is: the velocity of a
 *  point (the pad, effectively at "zero altitude" in this local frame)
 *  being carried by Earth's rotation is OMEGA x r, and r here is purely
 *  radial (straight "Up" from the pad, i.e. from the planet's centre
 *  through the pad) -- any amount of altitude above the pad changes the
 *  magnitude slightly (a taller r means a faster carried speed) but never
 *  the direction; this constant uses r = EARTH_RADIUS_M (the pad itself,
 *  zero altitude) as the reference case rocketPhysics.ts adds to its T-0
 *  state, since a rocket sitting on the pad before launch IS at that
 *  radius. */
export const LAUNCH_SITE_ECI_VELOCITY: Vec3 = [LAUNCH_SITE_ROTATIONAL_SPEED_MPS, 0, 0]

/** The pad's fixed position relative to the planet's centre, in the SAME
 *  axes frames.ts's PLANET_CENTER_IN_LAUNCH_SITE_FRAME uses -- i.e. the pad
 *  sits at local Up * EARTH_RADIUS_M from the planet's centre, by
 *  definition (it's a point on the surface, at "zero altitude" relative to
 *  itself). This is a plain geometric fact, not a time-varying one -- the
 *  pad's position relative to the CENTRE doesn't change; what changes is
 *  which direction that position points in ECI space as Earth turns (see
 *  padEciPositionRelCenter() below). Not imported from frames.ts to avoid a
 *  circular import (frames.ts already imports LAUNCH_SITE_POLAR_AXIS from
 *  this file) -- this is the one place that offset is independently
 *  defined; it must stay numerically identical to frames.ts's own
 *  PLANET_CENTER_IN_LAUNCH_SITE_FRAME (negated), which it is by
 *  construction (both are [0, EARTH_RADIUS_M, 0] / [0, -EARTH_RADIUS_M, 0]
 *  respectively). */
const PAD_REL_PLANET_CENTER: Vec3 = [0, EARTH_RADIUS_M, 0]

/** BUG THIS FIXES: LAUNCH_SITE_ECI_VELOCITY above is a FROZEN, constant
 *  velocity -- a straight-line approximation to what is actually CIRCULAR
 *  motion (the pad traces a circle around Earth's axis as the planet
 *  turns). That approximation is excellent for the first few seconds, but
 *  it diverges from the true path with time: verified numerically, a
 *  rocket held on the rail using this constant velocity to stay "fixed to
 *  the pad" ends up at a position about 57 metres away from the pad's TRUE
 *  location by t=60s, growing roughly with t^2 (a classic
 *  straight-line-vs-arc divergence) -- NOT because of any error in
 *  frames.ts's eciToEcef/ecefToEci conversions (those were independently
 *  verified exact against the pad's true position, out to 300 seconds),
 *  but because the rail-hold state itself was using the wrong velocity for
 *  "staying still relative to a rotating pad" for anything beyond a few
 *  seconds pre-launch.
 *
 *  This function gives the pad's TRUE, exact ECI position (relative to the
 *  planet's centre) at any mission-elapsed time `t`, by rotating the pad's
 *  fixed ECEF-relative-to-centre position forward by the sidereal angle --
 *  exactly the same ECEF->ECI rotation earthRotation.ts already provides,
 *  just applied to the pad's own location instead of the rocket's. */
export function padEciPositionRelCenter(missionElapsedSeconds: number): Vec3 {
  const theta = siderealAngle(missionElapsedSeconds)
  return ecefToEciLocal(PAD_REL_PLANET_CENTER, LAUNCH_SITE_POLAR_AXIS, theta)
}

/** The pad's TRUE, exact ECI velocity at mission-elapsed time `t` -- i.e.
 *  the actual velocity a point fixed to the rotating ground has, as a
 *  function of time, rather than LAUNCH_SITE_ECI_VELOCITY's frozen
 *  snapshot at t=0. This is omega x r_pad,ECI(t): the same carrying-
 *  velocity relationship used everywhere else in this branch
 *  (inertialDynamics.ts's atmosphereEciVelocity, frames.ts's velocity
 *  conversions), evaluated at the pad's own (moving, in ECI) position
 *  rather than the rocket's.
 *
 *  USE THIS, not LAUNCH_SITE_ECI_VELOCITY, anywhere the rocket needs to
 *  stay genuinely fixed to the pad for more than an instant -- the
 *  rail-hold constraint in rocketPhysics.ts, specifically. The T-0 initial
 *  condition can still use the plain LAUNCH_SITE_ECI_VELOCITY constant,
 *  since t=0 by definition there and padEciVelocity(0) equals it exactly
 *  (verified: both reduce to the same OMEGA_EARTH * R_EARTH * cos(lat)
 *  eastward value at theta=0) -- but using this function instead costs
 *  nothing and removes the risk of the two ever silently disagreeing. */
export function padEciVelocity(missionElapsedSeconds: number): Vec3 {
  const theta = siderealAngle(missionElapsedSeconds)
  const omegaVec = V3.scale(LAUNCH_SITE_POLAR_AXIS, OMEGA_EARTH)
  const padPos = ecefToEciLocal(PAD_REL_PLANET_CENTER, LAUNCH_SITE_POLAR_AXIS, theta)
  return V3.cross(omegaVec, padPos)
}