/**
 * inertialDynamics.ts â€” what the rocket's equations of motion need to know
 * about Earth's rotation, given that they integrate in TRUE ECI.
 *
 * Part of the frames branch (feature/eci-ecef-frames). First subfolder
 * under physics/ -- going forward, new physics-domain files (as opposed to
 * constants/ or render-layer files) land here, rather than piling onto
 * rocketPhysics.ts or sitting at the project root; rocketPhysics.ts and
 * vec3.ts themselves stay where they are for now (not moved, to avoid
 * import churn across the whole codebase for files this branch doesn't
 * otherwise touch).
 *
 * IMPORTANT CORRECTION MADE WHILE SCOPING THIS FILE: this file does NOT
 * contain Coriolis or centrifugal pseudo-force terms, even though "Earth
 * rotation effects on the flight dynamics" sounds like it should. Those
 * pseudo-forces exist ONLY when integrating Newton's laws in a ROTATING
 * reference frame (ECEF) and wanting F=ma to still hold there -- they are
 * a correction for using the wrong (non-inertial) frame, not a separate
 * physical force. rocketPhysics.ts integrates in true ECI (confirmed:
 * gravityVector3() already computes real gravitational acceleration with
 * no rotation assumption, and this branch's launchSite.ts adds the pad's
 * real ECI velocity to the T-0 state) -- in a frame that is ALREADY
 * inertial, adding Coriolis/centrifugal terms on top would double-count
 * the physics: the real effects those terms approximate (eastward range
 * gain from launch-site rotation, the apparent deflection of long-range
 * trajectories) already emerge correctly and exactly from integrating in
 * ECI with the correct initial velocity, with no extra terms required.
 *
 * WHAT THIS FILE ACTUALLY PROVIDES: the one place ECI integration still
 * needs to know Earth is rotating is the ATMOSPHERE. Air is dragged along
 * by the rotating Earth (the ground, the ocean, friction through the
 * boundary layer) -- so "still air" is a concept that only makes sense in
 * ECEF, not ECI. A point of air that has ZERO velocity relative to the
 * ground (ECEF) has a NON-zero velocity in ECI, equal to the local
 * Earth-rotation-carried speed (omega x r) -- the same relationship
 * launchSite.ts uses for the pad's own T-0 velocity, just evaluated at the
 * rocket's CURRENT position instead of a fixed launch-pad radius. Before
 * this branch, rocketPhysics.ts's drag model computed air-relative
 * velocity as `v - windX` (v in the local/launch-site frame, assumed
 * inertial, minus a horizontal wind profile) -- correct ONLY because the
 * frame was never actually rotating. Once the rocket's own v is true ECI
 * velocity (carrying the launch site's real rotational speed), that same
 * subtraction would be wrong: it would compute drag against an
 * "atmosphere" that isn't rotating with the Earth at all, which is
 * unphysical and would show up as a large, wrong, constant eastward
 * headwind for the entire flight (the full ~450 m/s launch-site speed,
 * misread as relative airflow). atmosphereEciVelocity() below is the
 * fix: it gives the LOCAL atmosphere's own ECI velocity at a given ECI
 * position, so the drag model can do `v_rocket_ECI - atmosphereEciVelocity(p) - windX`
 * instead, which correctly treats the air as co-rotating with the ground.
 */

import type { Vec3 } from './vec3'
import * as V3 from './vec3'
import { OMEGA_EARTH, polarAxisInLocalFrame } from '../constants/earthRotation'
import { LAUNCH_SITE_LATITUDE_RAD } from '../constants/launchSite'

/** Earth's full angular velocity vector, in the launch site's local
 *  (East, Up, North) frame -- magnitude OMEGA_EARTH, direction from
 *  polarAxisInLocalFrame() (see that function's doc comment for the
 *  sign/handedness explanation specific to this project's basis). */
const OMEGA_VEC: Vec3 = V3.scale(polarAxisInLocalFrame(LAUNCH_SITE_LATITUDE_RAD), OMEGA_EARTH)

/** The local atmosphere's own ECI velocity at launch-site-frame position
 *  `p` (metres, origin at the pad -- i.e. the same position vector
 *  rocketPhysics.ts's State13[0..2] already is). This is simply
 *  OMEGA x r, where r is p's position relative to the PLANET'S CENTRE,
 *  not the pad -- the rotation carries points around the planet's centre,
 *  not around the pad. Callers pass the rocket's current launch-site-frame
 *  position; this function does the planet-centred translation internally
 *  (via the same PLANET_CENTER_IN_LAUNCH_SITE_FRAME relationship
 *  frames.ts's launchSiteToPlanetCentered() uses) so call sites don't have
 *  to convert frames just to call this.
 *
 *  Returns a velocity in the SAME (East, Up, North) launch-site-frame
 *  basis as `p` and as rocketPhysics.ts's own State13 velocity components
 *  -- directly subtractable from the rocket's ECI velocity with no further
 *  conversion, which is the whole point (a drag calculation needing this
 *  shouldn't have to round-trip through planet-centred or ECEF just to
 *  get a number it immediately subtracts back out in the local frame). */
export function atmosphereEciVelocity(p: Vec3, planetCenterInLaunchSiteFrame: Vec3): Vec3 {
  const r = V3.sub(p, planetCenterInLaunchSiteFrame)
  return V3.cross(OMEGA_VEC, r)
}
