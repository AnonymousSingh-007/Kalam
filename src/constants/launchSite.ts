/**
 * launchSite.ts â€” the fixed launch pad's geodetic latitude and the
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
import { OMEGA_EARTH, polarAxisInLocalFrame } from './earthRotation'
import type { Vec3 } from '../physics/vec3'

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
