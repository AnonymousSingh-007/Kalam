/**
 * earthRotation.ts — Earth's angular velocity and the ECI<->ECEF rotation.
 *
 * Part of the frames branch (feature/eci-ecef-frames): establishing a true
 * Earth-Centered Inertial frame and a true Earth-Centered Earth-Fixed frame,
 * with an explicit, checkable rotation between them, rather than treating
 * "launch-site frame" as inertial-by-assumption (which is what the physics
 * engine did before this branch — correct only because Earth's rotation was
 * never modeled at all).
 *
 * WHY THIS IS ITS OWN FILE, separate from frames.ts and rocketPhysics.ts:
 * Earth's rotation is a single, self-contained physical fact (one constant,
 * one angle that grows linearly with time, one rotation matrix built from
 * that angle) that several very different consumers need independently —
 * the physics engine (Coriolis/centrifugal terms, launch velocity), a
 * future ground-track/sidereal-time display, and any future ECEF-based
 * geodetic math (lat/lon from a position). Folding it into frames.ts would
 * mix "what frames exist and how do positions convert between them" with
 * "what IS Earth's rotation, numerically" — two different kinds of fact
 * that happen to compose, not one. Folding it into rocketPhysics.ts would
 * put the one shared Earth-rotation definition behind that file's
 * deliberately headless/no-framework-dependency boundary for consumers
 * (like a future UI readout) that have no reason to import the whole
 * physics engine just to ask "what's the current sidereal angle."
 *
 * THE ROTATION ITSELF: Earth rotates about its own polar axis at a constant
 * angular rate (ignoring precession/nutation/polar motion — not relevant at
 * Kalam's fidelity level). ECI is the non-rotating frame (fixed relative to
 * the stars); ECEF is the frame that rotates WITH the Earth (fixed relative
 * to the ground). A position's ECEF coordinates equal its ECI coordinates
 * rotated by -theta(t) about the polar axis, where theta(t) = OMEGA_EARTH *
 * t is how far the Earth has turned since t=0 (see sidereal angle below).
 *
 * THE POLAR AXIS IN THIS PROJECT'S BASIS: frames.ts's launch-site/ECI basis
 * is LOCAL to the launch pad (+X East, +Y Up, +Z North at the pad), not a
 * global East/Up/North valid everywhere on the planet (there's no such
 * global ENU basis -- East/Up/North are only defined relative to a specific
 * point on a sphere). The vector this project uses to represent Earth's
 * rotation axis, in this local basis, is NOT simply "the direction toward
 * the geographic North pole" -- see polarAxisInLocalFrame()'s own doc
 * comment for why: this codebase's (East, Up, North) tuple, read as a raw
 * (x,y,z) by vec3.ts's cross() (which rotateAboutAxis() below uses
 * unmodified), is a LEFT-handed basis, so the axis has to point toward
 * local SOUTH, not local North, for Rodrigues' rotation formula to produce
 * physically correct results -- i.e. for a point held above the launch
 * pad to actually move East as Earth's rotation carries it along, matching
 * the real, textbook surface-rotational-speed formula (OMEGA*R*cos(lat)).
 * This was gotten wrong on the first attempt and caught by direct
 * numerical testing (see git history / conversation record if curious) --
 * worth knowing if this axis is ever touched again: don't reason about its
 * sign from "which way does the North pole point," verify with
 * cross(axis, LocalUp) and confirm the East component comes out positive.
 */

import type { Vec3 } from '../vec3'
import * as V3 from '../vec3'

/** Earth's mean angular velocity, rad/s. One sidereal day (23h 56m 4.1s =
 *  86164.1 s) is the correct period to use here -- NOT the 24h solar day,
 *  which is about 4 minutes longer because it also accounts for Earth's
 *  motion around the Sun. Getting this wrong by using 2*pi/86400 would be a
 *  ~0.27% error in rotation rate -- small per-second, but it compounds over
 *  any multi-orbit propagation the orbital-mechanics work after this branch
 *  will do, so it's worth getting exactly right now rather than retrofitting
 *  later. */
export const OMEGA_EARTH = 7.292_115_0e-5 // rad/s

/** Current sidereal rotation angle, radians, given mission-elapsed time in
 *  seconds since the simulation's own t=0. This is a SIMULATION-LOCAL
 *  angle (t=0 is "whenever this flight's countdown hit zero", not a real
 *  calendar epoch) -- Kalam doesn't model real-world sidereal time-of-day
 *  for the launch (no real launch window/day-of-year concept exists), so
 *  theta(0)=0 by definition: the ECI and ECEF frames are defined to
 *  coincide at the moment the simulated flight begins, and diverge by
 *  OMEGA_EARTH*t from there. This is the one function every ECI<->ECEF
 *  conversion below calls to get its rotation angle -- no other code
 *  should compute OMEGA_EARTH * t inline. */
export function siderealAngle(missionElapsedSeconds: number): number {
  return OMEGA_EARTH * missionElapsedSeconds
}

/** Rodrigues' rotation formula: rotate vector `v` by angle `theta` about
 *  unit axis `axis`. This is the general building block both ECI<->ECEF
 *  conversion functions below use -- the launch site's rotation axis is
 *  generally NOT local Up (see this file's header), so the simple
 *  rotateAboutY() above only covers the polar-launch-site special case and
 *  isn't used directly by the exported conversions. */
function rotateAboutAxis(v: Vec3, axis: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const k = axis // assumed already unit length by every caller below
  const kCrossV = V3.cross(k, v)
  const kDotV = V3.dot(k, v)
  // v*cos(theta) + (k x v)*sin(theta) + k*(k.v)*(1-cos(theta))
  return V3.add(
    V3.add(V3.scale(v, c), V3.scale(kCrossV, s)),
    V3.scale(k, kDotV * (1 - c))
  )
}

/** Earth's rotation axis, expressed as a unit vector in the launch site's
 *  LOCAL (East, Up, North) tuple basis -- see frames.ts -- for a launch
 *  site at geodetic latitude `latitudeRad`. latitudeRad is signed
 *  (positive = Northern hemisphere), matching launchSite.ts's convention
 *  for Sriharikota's ~13.7 deg N.
 *
 *  SIGN, verified numerically rather than by intuition: this project's
 *  (East, Up, North) tuple, read as raw (x,y,z) by vec3.ts's cross(), is a
 *  LEFT-handed basis -- East x North = -Up in that convention (confirmed:
 *  cross([1,0,0],[0,0,1]) = [0,-1,0], whereas the real, geocentrically-
 *  validated ENU relation is East x North = +Up). That's a pre-existing,
 *  load-bearing property of this whole codebase's coordinate convention
 *  (gravity, torques, everything already built against it), not something
 *  this file can or should change -- so the axis below is defined to
 *  point toward the geographic SOUTH pole's local direction, i.e. the
 *  NEGATIVE of the naive (0, sin(lat), cos(lat)) "toward geographic
 *  North" vector. Negating it is what makes vec3.ts's cross() -- used
 *  by rotateAboutAxis() below, unmodified -- produce a physically correct
 *  result in THIS basis: a point held fixed above the launch pad, carried
 *  by Earth's own rotation, must move East (ground moves east under a
 *  prograde-spinning Earth), and only this sign gives that. Verified
 *  numerically at several latitudes (0, 13.7, 45, 89.9 deg): axis x Up
 *  always comes out pure +East with magnitude OMEGA_EARTH*cos(lat), i.e.
 *  the textbook surface rotational-speed formula, with zero spurious
 *  Up/North leakage at any latitude. */
export function polarAxisInLocalFrame(latitudeRad: number): Vec3 {
  return [0, -Math.sin(latitudeRad), -Math.cos(latitudeRad)]
}

/** Rotate a LOCAL-frame vector from ECI to ECEF by sidereal angle `theta`,
 *  about the given polar axis (itself expressed in the same local frame --
 *  see polarAxisInLocalFrame()). Works equally for a position vector
 *  (relative to the planet's centre) or a velocity vector -- Rodrigues'
 *  rotation is linear, so it composes correctly with the frames.ts
 *  translation step either before or after calling this, as long as
 *  position and velocity are each rotated consistently (this function
 *  doesn't itself know or care which one it's given).
 *  ECI->ECEF uses -theta: as time advances, the ECEF frame has rotated
 *  +theta AHEAD of ECI in the direction Earth spins, so expressing the
 *  SAME physical vector in the now-rotated ECEF basis requires rotating it
 *  by -theta relative to its ECI coordinates. */
export function eciToEcefLocal(v: Vec3, polarAxis: Vec3, theta: number): Vec3 {
  return rotateAboutAxis(v, polarAxis, -theta)
}

/** The inverse of eciToEcefLocal() -- ECEF back to ECI, by +theta. */
export function ecefToEciLocal(v: Vec3, polarAxis: Vec3, theta: number): Vec3 {
  return rotateAboutAxis(v, polarAxis, theta)
}