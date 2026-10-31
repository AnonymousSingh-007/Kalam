/**
 * scale.ts — the single source of truth for the metres-to-scene-units
 * conversion and the real-world constants derived from it.
 *
 * Previously this `0.05` scale factor was declared independently in three
 * places — `ALTITUDE_SCALE` in Scene.tsx, `ALTITUDE_SCALE` in
 * buildGround.ts (exported but never actually imported by Scene.tsx,
 * which had its own copy instead), and `HEIGHT_TO_SCENE` in
 * buildRocket.ts — kept in sync only by a code comment ("same as
 * ALTITUDE_SCALE") rather than by the type system. That's a real
 * architectural defect: nothing stops one of the three copies from being
 * edited without the other two, at which point the planet, the rocket
 * model's real-world scale, and the camera/altitude math would silently
 * disagree with each other — a bug that would likely show up as a subtle
 * visual mismatch (rocket the wrong size relative to the globe, or
 * altitude readings not matching where the camera pulls back) rather
 * than a crash, and could be very hard to track down without knowing to
 * look for exactly this.
 *
 * Every module that needs the metres<->scene-units conversion, or any of
 * the physical constants it's built from, imports from here. Nothing
 * outside this file should ever write out `0.05` (or any value derived
 * from it) as its own local constant.
 */

/** Scene units per metre. 1 scene unit = 1 / ALTITUDE_SCALE metres = 20 m.
 *  This is the one number every other export in this file is built from —
 *  changing it rescales the entire simulated world uniformly. */
export const ALTITUDE_SCALE = 0.05

/** Metres per scene unit — the inverse of ALTITUDE_SCALE, for the
 *  (rarer) case of converting a scene-unit quantity back to metres. */
export const SCENE_UNITS_TO_METRES = 1 / ALTITUDE_SCALE

/** Convert a metre quantity to scene units. Prefer this helper over
 *  writing `value * ALTITUDE_SCALE` inline — it reads the same either
 *  way, but a call site makes the unit conversion self-documenting and
 *  greppable (`metresToScene(`) in a way a bare multiply isn't. */
export const metresToScene = (metres: number): number => metres * ALTITUDE_SCALE

/** Convert a scene-unit quantity back to metres. */
export const sceneToMetres = (sceneUnits: number): number => sceneUnits * SCENE_UNITS_TO_METRES

/** Earth's mean radius, metres. The one physical fact the planet's scene
 *  radius, the physics engine's gravity model, and anything else that
 *  needs "how big is the Earth" should all derive from. Previously
 *  duplicated as a second, independent literal (`R_EARTH = 6_371_000`)
 *  inside rocketPhysics.ts's own gravity model — rocketPhysics.ts now
 *  imports this constant instead. This file has zero framework
 *  dependencies (no three.js, no DOM), so importing it does not
 *  compromise the physics module's deliberately headless design. */
export const EARTH_RADIUS_M = 6_371_000

/** Earth's radius in scene units — PLANET_RADIUS from the old
 *  buildGround.ts, now derived here from the single shared scale factor
 *  and the single shared physical radius, instead of each file
 *  recomputing `EARTH_RADIUS_M * 0.05` (or a hand-copied `318_550`) on
 *  its own. */
export const PLANET_RADIUS = EARTH_RADIUS_M * ALTITUDE_SCALE // 318 550