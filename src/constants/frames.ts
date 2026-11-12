/**
 * frames.ts — explicit coordinate-frame convention for Kalam.
 *
 * Previously this convention existed only as prose in rocketPhysics.ts's
 * header comment ("local launch-site tangent frame... +Y=up, +Z=north,
 * +X=east... planet centre at local (0,-R_EARTH,0)"). That comment was
 * accurate, but nothing enforced it: Scene.tsx never referenced it at all
 * and instead re-derived its own flat 2D projection inline
 * (`cgX = telemetry.lateralOffset * ALTITUDE_SCALE`, etc.), so the render
 * frame's relationship to the physics frame lived only in a human reading
 * two files side by side and trusting they still agreed. A future change
 * to either file (e.g. adding real lateral/north motion, or a rotating
 * launch site) had no type-level signal that the other file's assumptions
 * would break.
 *
 * This module makes the three frames in play, and the fixed relationships
 * between them, explicit and checkable:
 *
 *   1. LAUNCH-SITE FRAME  (what rocketPhysics.ts's State13 actually is)
 *      Inertial, non-rotating, origin at the pad, metres.
 *      Basis: +X = East, +Y = Up, +Z = North.
 *      This is the frame the physics engine integrates in. It is NOT the
 *      ECEF/planet-centred frame — it's a local tangent-plane frame fixed
 *      at one point on the (currently non-rotating) planet surface.
 *
 *   2. PLANET-CENTRED FRAME  (where the planet's own sphere lives)
 *      Same orientation/scale as the launch-site frame (both are inertial
 *      and currently non-rotating, so there's no attitude transform
 *      between them — only a translation), origin at the planet's centre.
 *      A launch-site-frame position converts to planet-centred by
 *      subtracting LAUNCH_SITE_ORIGIN_IN_PLANET_FRAME (equivalently:
 *      adding R_EARTH to the Y component), exactly what
 *      rocketPhysics.ts's gravityVector3() already did inline via
 *      PLANET_CENTER — that local point *is* this frame's origin,
 *      expressed in launch-site coordinates.
 *
 *   3. RENDER FRAME  (what Three.js actually draws, scene units)
 *      Same basis orientation as the other two (+X East, +Y Up, +Z North)
 *      but scaled by ALTITUDE_SCALE from metres to scene units. Right now
 *      Scene.tsx only ever populates the X/Y plane (no real north/south
 *      motion exists in the simulation yet), but every position this
 *      module hands back is a full 3-vector so that changes.
 *
 * Why metres->scene-units conversion is pulled in from scale.ts rather
 * than redefined here: ALTITUDE_SCALE is still the single source of truth
 * for that factor (see scale.ts's own header for why). This file is about
 * frame ORIGIN and BASIS, scale.ts is about frame SCALE — composing them
 * is launchSiteToRender() below.
 *
 * UPDATE (feature/eci-ecef-frames branch): "LAUNCH-SITE FRAME" above is
 * now understood as ECI WITH A TRANSLATED ORIGIN, not its own separate
 * inertial concept. Earth's rotation is modeled starting this branch (see
 * constants/earthRotation.ts and constants/launchSite.ts) — the frame
 * rocketPhysics.ts actually integrates in (what State13[0..2]/[3..5] are)
 * is a true Earth-Centered Inertial frame, just expressed with its origin
 * placed at the pad and its basis fixed to the pad's local East/Up/North
 * at t=0, rather than the standard ECI convention of origin-at-planet-
 * centre with a basis fixed to the stars/equinox. Both are equally valid,
 * equally inertial frames (a translated, fixed-orientation copy of an
 * inertial frame is itself inertial) — "launch-site frame" was always
 * this, it just didn't have a name for "which inertial frame" until this
 * branch added ECEF as a second, genuinely different (rotating) frame to
 * distinguish it from. EciPos/EciVel below are the properly-named aliases
 * for what LaunchSitePos already was; LaunchSitePos is kept (not removed)
 * since renaming it would touch every existing call site in
 * rocketPhysics.ts/Scene.tsx for no behavioural change — new code in this
 * branch should prefer the Eci* names since they say what the frame IS,
 * but LaunchSitePos is not deprecated, just a synonym with an established
 * meaning before this branch had the ECI/ECEF vocabulary to describe it
 * precisely. See earthRotation.ts's header for what's actually NEW here:
 * the rotating ECEF frame, and the explicit rotation between the two.
 */

import { ALTITUDE_SCALE, EARTH_RADIUS_M, metresToScene } from './scale'
import { siderealAngle, eciToEcefLocal, ecefToEciLocal, OMEGA_EARTH } from './earthRotation'
import { LAUNCH_SITE_POLAR_AXIS } from './launchSite'
import * as V3 from '../physics/vec3'

// ─────────────────────────── basis vectors ───────────────────────────

/** A plain 3-tuple [x, y, z]. Deliberately not a class — this module has
 *  zero framework dependencies (no three.js), matching rocketPhysics.ts's
 *  own deliberately headless design, so both it and Scene.tsx (which
 *  converts to THREE.Vector3 only at the render boundary) can import it. */
export type Vec3Tuple = [number, number, number]

/** East — the launch-site/render frame's +X axis. */
export const EAST: Vec3Tuple = [1, 0, 0]
/** Up — the launch-site/render frame's +Y axis. */
export const UP: Vec3Tuple = [0, 1, 0]
/** North — the launch-site/render frame's +Z axis. */
export const NORTH: Vec3Tuple = [0, 0, 1]

// ─────────────────────────── frame tags ───────────────────────────
//
// Branded types: a bare [number,number,number] can't accidentally be
// passed where a specific frame is expected, without an explicit
// conversion call, because the brand field only exists at the type level
// (it's `declare`d, never actually written), but TypeScript's structural
// typing still requires the literal brand property name to be present on
// the static type for an assignment to type-check. That's enough to make
// "I passed a planet-centred point into a function expecting launch-site"
// a compile error instead of a silent unit mix-up — which is exactly the
// class of bug ALTITUDE_SCALE triplication (fixed in scale.ts) was.

interface Branded<Tag extends string> {
  readonly __frame?: Tag
}

/** A position in the launch-site tangent frame, metres. +X East, +Y Up,
 *  +Z North, origin at the pad. This is what rocketPhysics.ts's
 *  State13[0..2] (px,py,pz) and Telemetry's lateralOffset/altitude/
 *  positionZ already are — launchSite() below is how any other module
 *  gets a value of this branded type from those raw numbers. */
export type LaunchSitePos = Vec3Tuple & Branded<'launch-site'>

/** A position in the planet-centred frame, metres. Same basis as the
 *  launch-site frame (no rotation between them yet — see this file's
 *  header), origin at the planet's centre. */
export type PlanetCenteredPos = Vec3Tuple & Branded<'planet-centered'>

/** A position in the render frame, scene units. Same basis as the
 *  launch-site frame, scaled by ALTITUDE_SCALE. What Scene.tsx should
 *  hand to THREE.Object3D.position.set(...). */
export type RenderPos = Vec3Tuple & Branded<'render'>

/** A position in the true Earth-Centered Inertial frame, metres, with the
 *  SAME origin-at-the-pad convention as LaunchSitePos (see this file's
 *  header for why these are the same underlying frame). Prefer this name
 *  in new code written as part of or after the feature/eci-ecef-frames
 *  branch, since it says what the frame physically IS rather than where
 *  its origin happens to sit. */
export type EciPos = LaunchSitePos & Branded<'eci'>

/** A velocity in the true ECI frame, metres/second, same basis as EciPos.
 *  Velocities don't have a translatable "origin" the way positions do, so
 *  this is NOT branded as a LaunchSitePos-compatible type — a velocity is
 *  frame-basis-dependent but not frame-origin-dependent, and keeping that
 *  distinction at the type level (rather than reusing EciPos's brand)
 *  avoids a position and a velocity in the same basis being accidentally
 *  type-compatible with each other, which they are NOT (you can't add a
 *  position to a velocity and get something meaningful). */
export type EciVel = Vec3Tuple & Branded<'eci-velocity'>

/** A position in the Earth-Centered Earth-Fixed frame, metres, origin at
 *  the planet's centre (matching PlanetCenteredPos's origin — ECEF and
 *  the planet-centred frame share an origin, they differ only in
 *  ORIENTATION: ECEF rotates with the Earth, planet-centred/ECI does
 *  not). See earthRotation.ts for the rotation between this and ECI. */
export type EcefPos = Vec3Tuple & Branded<'ecef'>

// ─────────────────────────── constructors ───────────────────────────

/** Tag a raw [x,y,z] (metres, launch-site basis) as a LaunchSitePos.
 *  Use this at the one place raw physics-engine numbers enter frame-aware
 *  code (e.g. from Telemetry/PoseSnapshot), rather than passing bare
 *  tuples around untagged. */
export function launchSite(x: number, y: number, z: number): LaunchSitePos {
  return [x, y, z] as LaunchSitePos
}

// ─────────────────────────── planet geometry ───────────────────────────

/** The planet's centre, expressed as a launch-site-frame position. This
 *  is the single definition of what was previously rocketPhysics.ts's
 *  own inline `const PLANET_CENTER: Vec3 = [0, -R_EARTH, 0]` — kept here
 *  so buildGround.ts and Scene.tsx (which both also need "where is the
 *  planet's centre, relative to the pad") read the same value instead of
 *  each re-deriving "straight down by one Earth radius" on their own. */
export const PLANET_CENTER_IN_LAUNCH_SITE_FRAME: LaunchSitePos =
  launchSite(0, -EARTH_RADIUS_M, 0)

// ─────────────────────────── conversions ───────────────────────────

/** Launch-site -> planet-centred: translate by the planet's centre offset.
 *  No rotation — see this file's header for why (both frames are
 *  currently inertial and non-rotating, basis-aligned). */
export function launchSiteToPlanetCentered(p: LaunchSitePos): PlanetCenteredPos {
  const [cx, cy, cz] = PLANET_CENTER_IN_LAUNCH_SITE_FRAME
  return [p[0] - cx, p[1] - cy, p[2] - cz] as PlanetCenteredPos
}

/** Planet-centred -> launch-site: the inverse translation. */
export function planetCenteredToLaunchSite(p: PlanetCenteredPos): LaunchSitePos {
  const [cx, cy, cz] = PLANET_CENTER_IN_LAUNCH_SITE_FRAME
  return [p[0] + cx, p[1] + cy, p[2] + cz] as LaunchSitePos
}

/** Launch-site (metres) -> render (scene units): same basis, just scaled.
 *  This is the one place `* ALTITUDE_SCALE` should be applied to a
 *  position vector — Scene.tsx previously did this inline, separately,
 *  for X, Y (and never Z, since nothing used Z) at each of several call
 *  sites (cgX, cgY, rocketWorldPos, chaseOffset math, trench-progress
 *  altitude checks, etc.), with no single function guaranteeing all of
 *  them apply the same factor the same way. */
export function launchSiteToRender(p: LaunchSitePos): RenderPos {
  return [metresToScene(p[0]), metresToScene(p[1]), metresToScene(p[2])] as RenderPos
}

/** Render (scene units) -> launch-site (metres): the inverse scale. */
export function renderToLaunchSite(p: RenderPos): LaunchSitePos {
  return [p[0] / ALTITUDE_SCALE, p[1] / ALTITUDE_SCALE, p[2] / ALTITUDE_SCALE] as LaunchSitePos
}

/** Planet-centred (metres) -> render (scene units). Composes the two
 *  conversions above; this is what buildGround.ts needs for drawing the
 *  globe sphere (whose geometry is naturally planet-centred: every vertex
 *  is at distance PLANET_RADIUS from the sphere's own origin) at its
 *  correct position relative to the pad in the render frame. */
export function planetCenteredToRender(p: PlanetCenteredPos): RenderPos {
  return launchSiteToRender(planetCenteredToLaunchSite(p))
}

// ─────────────────────────── ECI <-> ECEF ───────────────────────────
//
// Added on the feature/eci-ecef-frames branch. Unlike every conversion
// above (pure translation or pure scale, both time-independent), going
// between ECI and ECEF needs the current sidereal angle theta(t) — see
// earthRotation.ts's header for why — so every function here takes a
// `missionElapsedSeconds` argument the translate/scale conversions don't
// need. EciPos is a LaunchSitePos-compatible alias (see this file's header
// update above for why they're the same underlying frame); EcefPos is a
// genuinely new, planet-centred-origin, rotating-basis frame.
//
// Because EciPos shares LaunchSitePos's pad-relative origin while EcefPos
// shares PlanetCenteredPos's planet-centre origin, converting between them
// is translation AND rotation, not rotation alone — these functions
// compose the existing launchSiteToPlanetCentered/planetCenteredToLaunchSite
// translation with earthRotation.ts's rotation, in the order that keeps
// each intermediate step physically meaningful (translate to a
// planet-centred origin first, since the rotation axis passes through the
// planet's centre, not the pad).

/** EciPos (pad-origin inertial) -> EcefPos, at sidereal time
 *  `missionElapsedSeconds` since this flight's own t=0.
 *
 *  BUG FIXED HERE (found via a live "altitude: 6371000m" flight-termination
 *  report -- exactly EARTH_RADIUS_M, the signature of a translate step that
 *  ran once but never got undone): the first version of this function
 *  translated to the planet-centred origin, rotated, and RETURNED that
 *  planet-centred result directly, instead of translating back to a
 *  pad-relative origin. Fixed by adding a translate-back step
 *  (planetCenteredToLaunchSite), using the SAME constant
 *  PLANET_CENTER_IN_LAUNCH_SITE_FRAME offset the rest of this file already
 *  uses for every other translation.
 *
 *  A SECOND, UNRELATED BUG was briefly chased here and ruled out: a live
 *  "Earth moves too fast, rocket slides off" report (gradual, growing
 *  drift -- ~57m by t=60s for a rocket resting on the pad) looked like it
 *  might mean this function needed to subtract the pad's TIME-VARYING true
 *  ECI position instead of this constant offset. Direct numerical testing
 *  disproved that: feeding this function the pad's EXACT true physical ECI
 *  position (via launchSite.ts's padEciPositionRelCenter(t)) gives EXACTLY
 *  zero ground-relative drift at every t tested, out to 300 seconds -- this
 *  function was already perfectly correct. The real bug was one layer up,
 *  in rocketPhysics.ts: the rail-hold/pre-launch state was feeding this
 *  function a STRAIGHT-LINE approximation of the pad's motion
 *  (LAUNCH_SITE_ECI_VELOCITY * t) instead of the true circular path, and
 *  that approximation -- not this conversion -- is what diverges over
 *  time. See rocketPhysics.ts's rail-hold constraint for the actual fix;
 *  this function was correctly left unchanged. */
export function eciToEcef(p: EciPos, missionElapsedSeconds: number): EcefPos {
  const centred = launchSiteToPlanetCentered(p as LaunchSitePos)
  const theta = siderealAngle(missionElapsedSeconds)
  const rotated = eciToEcefLocal(centred, LAUNCH_SITE_POLAR_AXIS, theta)
  return planetCenteredToLaunchSite(rotated as PlanetCenteredPos) as unknown as EcefPos
}

/** The inverse of eciToEcef(): EcefPos -> EciPos at the same sidereal time.
 *  Mirrors eciToEcef()'s structure in reverse: un-translate to the
 *  planet-centred origin (same constant PLANET_CENTER_IN_LAUNCH_SITE_FRAME
 *  offset eciToEcef() uses, via launchSiteToPlanetCentered -- NOT a
 *  time-varying pad position; see eciToEcef()'s doc comment above for why
 *  that would be wrong here), rotate forward (ECEF->ECI), then translate to
 *  the pad-relative (EciPos) origin convention the rest of the codebase
 *  uses for State13. */
export function ecefToEci(p: EcefPos, missionElapsedSeconds: number): EciPos {
  const centred = launchSiteToPlanetCentered(p as unknown as LaunchSitePos)
  const theta = siderealAngle(missionElapsedSeconds)
  const rotated = ecefToEciLocal(centred, LAUNCH_SITE_POLAR_AXIS, theta)
  return planetCenteredToLaunchSite(rotated as PlanetCenteredPos) as EciPos
}

/** BUG FIXED HERE (caught in external review, confirmed by direct numerical
 *  test): this function used to be a PURE ROTATION of the velocity vector,
 *  with no correction for the fact that the ECEF axes themselves are
 *  rotating. That's wrong, and it's not a cosmetic wrongness — a point
 *  genuinely fixed to the ground has a REAL, non-zero ECI velocity
 *  (omega x r, same relationship launchSite.ts and inertialDynamics.ts
 *  already use), and a pure rotation of that non-zero vector does NOT come
 *  out to zero in ECEF. Verified numerically: at t=100s after epoch, the
 *  old pure-rotation version reported a ground-fixed point as moving at
 *  ~451 m/s in ECEF -- its own full ECI speed, essentially unchanged by
 *  the rotation -- when the physically correct answer is exactly zero (a
 *  point fixed to the ground is not moving relative to the ground). This
 *  silently corrupted every display quantity that went through it:
 *  lateralVelocity, velocity (vertical), velocityZ, maxVelocity, and
 *  impactSpeed (which gates the landed-vs-crashed check against
 *  LAND_V_MAX) all read this function's wrong output for any flight where
 *  real time had passed since theta=0 -- i.e. every flight, since theta=0
 *  only holds at the very first instant.
 *
 *  The correct relationship (standard rotating-frame kinematics -- see
 *  e.g. the derivative of r_ECEF = R(-theta) r_ECI, which picks up a
 *  d(theta)/dt term precisely because R itself depends on time):
 *
 *    v_ECEF = R(-theta) * (v_ECI - omega x r_ECI)
 *    v_ECI  = R(theta)  * v_ECEF + omega x r_ECI
 *
 *  Both directions now require the matching ECI-frame POSITION as well as
 *  velocity (signature change from the old position-independent version)
 *  -- physically necessary, since the omega x r correction term is itself
 *  a function of where the object is, not just how fast it's moving.
 *  `r_ECI` here is the full planet-centred ECI position (not the pad-
 *  relative EciPos) -- same convention inertialDynamics.ts's
 *  atmosphereEciVelocity() already uses for its own omega x r term, so
 *  this is now consistent with that file rather than introducing a THIRD
 *  slightly-different omega x r calculation into the codebase. */
export function eciVelToEcef(v: EciVel, pEci: EciPos, missionElapsedSeconds: number): Vec3Tuple {
  const theta = siderealAngle(missionElapsedSeconds)
  const rEciCentred = launchSiteToPlanetCentered(pEci as LaunchSitePos)
  const omegaVec = V3.scale(LAUNCH_SITE_POLAR_AXIS, OMEGA_EARTH)
  const carryingVel = V3.cross(omegaVec, rEciCentred)
  const vMinusCarrying = V3.sub(v, carryingVel)
  return eciToEcefLocal(vMinusCarrying, LAUNCH_SITE_POLAR_AXIS, theta) as Vec3Tuple
}

/** The inverse of eciVelToEcef() -- see that function's doc comment for the
 *  full derivation and the bug this replaces. `pEci` here is the SAME
 *  ECI-frame position the caller is converting velocity at (consistent
 *  with v_ECI = R(theta)*v_ECEF + omega x r_ECI using r_ECI, not r_ECEF --
 *  if you only have the ECEF position, convert it to ECI with ecefToEci()
 *  first and pass that). */
export function ecefVelToEci(v: Vec3Tuple, pEci: EciPos, missionElapsedSeconds: number): EciVel {
  const theta = siderealAngle(missionElapsedSeconds)
  const rEciCentred = launchSiteToPlanetCentered(pEci as LaunchSitePos)
  const omegaVec = V3.scale(LAUNCH_SITE_POLAR_AXIS, OMEGA_EARTH)
  const carryingVel = V3.cross(omegaVec, rEciCentred)
  const rotated = ecefToEciLocal(v, LAUNCH_SITE_POLAR_AXIS, theta)
  return V3.add(rotated, carryingVel) as EciVel
}

// ─────────────────────────── vector helpers ───────────────────────────
//
// Pure arithmetic helpers that work on any of the three branded types
// (frame-arithmetic, as opposed to frame-conversion, doesn't care which
// frame you're in as long as both operands are the same one — these are
// intentionally generic over the Vec3Tuple shape rather than duplicated
// per branded type).

/** Euclidean length of a frame vector (works for a position relative to
 *  its frame's origin, e.g. distance from the pad or from the planet's
 *  centre). */
export function frameVecLength(v: Vec3Tuple): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

/** Unit vector in the same direction as v. Returns [0,1,0] (Up) for a
 *  zero-length input rather than producing NaN components, matching
 *  rocketPhysics.ts's own `Math.max(V3.length(d), 1)` convention of
 *  never dividing by an unclamped near-zero radius. */
export function frameVecNormalize(v: Vec3Tuple): Vec3Tuple {
  const len = frameVecLength(v)
  if (len < 1e-9) return [...UP]
  return [v[0] / len, v[1] / len, v[2] / len]
}