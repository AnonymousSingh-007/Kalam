/**
 * renderInterp.ts — fixed-step physics accumulator + render-state
 * interpolation, sitting between App.tsx's single rAF loop and
 * RocketPhysicsEngine.
 *
 * Why this exists: previously App.tsx and Scene.tsx each ran their own
 * requestAnimationFrame loop. Both read the *same* mutable telemetryRef,
 * but nothing synchronized which simulation tick either loop saw on a
 * given paint — two rAF callbacks queued for the same frame can still
 * fire in either order relative to each other and relative to a third
 * party (React's own commit), and there was no guarantee the rocket pose,
 * the chase camera, and the exhaust timestamp Scene.tsx used on any one
 * frame all came from the same physics step. That's what caused the
 * jitter/inconsistency: three different consumers of state that could
 * each be "ahead" or "behind" by one tick relative to each other.
 *
 * Fix: one rAF loop (now solely in App.tsx). Physics is advanced in fixed
 * FIXED_DT increments inside an accumulator — decoupling simulation rate
 * from display refresh rate entirely, per requirement 1. Between physics
 * ticks, render consumers (rocket pose, camera, exhaust) read a single
 * interpolated RenderSnapshot, built once per paint from the previous and
 * current physics states — requirement 4. Position uses linear
 * interpolation (requirement 2); orientation uses quaternion SLERP on the
 * raw quaternion, with Euler-style telemetry angles (bodyAngle, yawAngle,
 * rollAngle) *re-derived* from the interpolated quaternion rather than
 * interpolated directly — interpolating already-decomposed atan2 angles
 * independently can take the wrong way around a ±180° wrap or distort
 * through the decomposition's own projection, which plain quaternion
 * SLERP does not suffer from (requirement 3). The non-pose telemetry
 * fields (thrust, mass, Q, Mach, HUD numbers, stage, outcome, ...) are
 * taken from the current tick as-is -- "the last integrated value" is the
 * physically correct thing to show a HUD for a discrete/near-discrete
 * quantity, and SLERPing a FlightStage enum or an outcome string makes no
 * sense -- only the continuous spatial pose benefits from (and needs)
 * interpolation for visual smoothness.
 */

import * as THREE from 'three'
import type { RocketPhysicsEngine, PoseSnapshot } from './physics/rocketPhysics'
import type { Telemetry } from './types'

/** 120 Hz fixed physics tick — independent of display refresh rate
 *  (requirement 1). Matches the physics engine's own MAX_SUB_DT ballpark,
 *  so this accumulator step and the engine's internal RK4 substep cadence
 *  stay in the same regime; the engine still substeps further internally
 *  if needed (see RocketPhysicsEngine.step), this is just how often the
 *  render side asks it to advance. */
export const FIXED_DT = 1 / 120

/** Hard ceiling on a single frame's elapsed time before it's fed to the
 *  accumulator. Without this, returning to a backgrounded/throttled tab
 *  (rAF pauses while a tab is hidden) hands the very next frame a
 *  multi-second gap, which would otherwise unroll into hundreds of
 *  physics substeps in one go — a stutter/freeze at best, a runaway
 *  integrator step at worst. Clamping means time lost while the tab was
 *  hidden is simply not simulated (the flight effectively pauses with
 *  it), which is the correct behavior, not a glitch (requirement 7). */
const MAX_FRAME_DT = 1 / 4

/** Belt-and-suspenders cap on substeps actually run in one rAF callback,
 *  independent of the MAX_FRAME_DT clamp above. If a single physics
 *  substep itself ever takes unusually long (slow device, dev-tools
 *  profiler attached), this still guarantees the accumulator drains in
 *  bounded work and never locks up the main thread trying to catch up. */
const MAX_SUBSTEPS_PER_FRAME = 240

export interface RenderPose {
  /** Interpolation fraction in [0,1) between the previous and current
   *  physics tick — exposed mainly for debugging/telemetry overlays. */
  alpha: number
  /** Scene-space position (same units/axes as Telemetry's
   *  lateralOffset/altitude/positionZ: x=lateral, y=altitude, z=out-of-plane). */
  px: number; py: number; pz: number
  /** Interpolated (SLERPed) orientation, body->local, same convention as
   *  the physics engine's own quaternion. */
  quat: THREE.Quaternion
  /** Euler-style angles re-derived from `quat` (not interpolated
   *  directly) — degrees, same sign convention as Telemetry.bodyAngle /
   *  yawAngle / rollAngle, so existing render code that reads those three
   *  fields off a Telemetry-shaped object keeps working unchanged. */
  bodyAngleDeg: number
  yawAngleDeg: number
  rollAngleDeg: number
  /** Simulation time this pose corresponds to (interpolated between the
   *  previous and current tick's `time`), for anything timestamp-driven
   *  (shader `time` uniforms, particle emission) that needs to stay
   *  consistent with the pose it's being drawn alongside — requirement 5. */
  simTime: number
}

/** A Telemetry snapshot whose *spatial* fields (lateralOffset, altitude,
 *  positionZ, bodyAngle, yawAngle, rollAngle, time) have been overwritten
 *  with the interpolated render pose; every other field is the latest
 *  physics tick's value, untouched. This is deliberately still shaped
 *  exactly like `Telemetry` so Scene.tsx's existing `telemetry.xxx` reads
 *  do not need to change at all -- only what produces the object changes. */
export type RenderSnapshot = Telemetry

const DEG = 180 / Math.PI

/** Re-derive bodyAngle/yawAngle exactly the way RocketPhysicsEngine.snapshot()
 *  does (atan2 of the body +Y axis expressed in the local frame), and
 *  rollAngle via the same Y-X-Z decomposition — kept in lockstep with
 *  rocketPhysics.ts's own qToPitchYawRoll/bodyAngle math so interpolated
 *  frames and physics-tick frames never disagree on sign convention. */
function eulerFromQuat(q: THREE.Quaternion): { bodyAngleDeg: number; yawAngleDeg: number; rollAngleDeg: number } {
  // body +Y axis rotated into the local frame
  const bodyDir = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const bodyAngle = Math.atan2(bodyDir.x, bodyDir.y)
  const yawAngle = Math.atan2(bodyDir.z, bodyDir.y)

  // Same Y-X-Z decomposition as quat.ts's qToPitchYawRoll, for roll only.
  const x = q.x, y = q.y, z = q.z, w = q.w
  const m01 = 2 * (x * y - w * z)
  const m00 = 1 - 2 * (y * y + z * z)
  const rollAngle = Math.atan2(m01, m00)

  return {
    bodyAngleDeg: bodyAngle * DEG,
    yawAngleDeg: yawAngle * DEG,
    rollAngleDeg: rollAngle * DEG,
  }
}

/** Result of one `advance()` call. `render` is the single interpolated
 *  snapshot every visual consumer (rocket pose, camera, exhaust) should
 *  read for this paint — requirement 4/5. `ticks` is every *raw* physics
 *  tick that actually ran this frame, in order, un-interpolated — use
 *  this for discrete/event-detection logic (watchdog, commentary,
 *  landing/crash detection) that must trigger off a real simulated
 *  instant, never off a lerped-between-ticks value. At low frame rates
 *  with the fixed step catching up, `ticks` can hold more than one entry
 *  in a single frame; at high frame rates it can be empty (no physics
 *  tick completed this paint, only accumulator progress) — callers should
 *  iterate it rather than assume exactly one. */
export interface AdvanceResult {
  render: RenderSnapshot
  ticks: Telemetry[]
}

/**
 * Drives a RocketPhysicsEngine with a fixed-step accumulator and produces
 * one interpolated RenderSnapshot per call to `advance`. Owns the
 * previous/current pose pair so callers never see a half-updated state.
 */
export class FixedStepDriver {
  private accumulator = 0
  private prevPose: PoseSnapshot | null = null
  private currPose: PoseSnapshot | null = null
  private currTelemetry: Telemetry | null = null
  private readonly qPrev = new THREE.Quaternion()
  private readonly qCurr = new THREE.Quaternion()
  private readonly qOut = new THREE.Quaternion()

  reset(): void {
    this.accumulator = 0
    this.prevPose = null
    this.currPose = null
    this.currTelemetry = null
  }

  /** Advance the simulation by `frameDt` seconds (wall-clock time since
   *  the last rAF callback) and return the interpolated render snapshot
   *  plus every raw physics tick that ran this frame. Returns null if the
   *  engine has never ticked yet (pre-launch, before the first step). */
  advance(engine: RocketPhysicsEngine, frameDt: number): AdvanceResult | null {
    const clampedDt = Math.min(Math.max(frameDt, 0), MAX_FRAME_DT)
    this.accumulator += clampedDt

    const ticks: Telemetry[] = []
    let substeps = 0
    while (this.accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS_PER_FRAME) {
      this.prevPose = this.currPose ?? engine.poseSnapshot()
      this.currTelemetry = engine.step(FIXED_DT)
      this.currPose = engine.poseSnapshot()
      ticks.push(this.currTelemetry)
      this.accumulator -= FIXED_DT
      substeps++
    }
    // If the accumulator still has a backlog after MAX_SUBSTEPS_PER_FRAME
    // (pathological case — see MAX_SUBSTEPS_PER_FRAME's comment), drop the
    // remainder rather than let it carry over and force the same wall of
    // substeps again next frame.
    if (substeps >= MAX_SUBSTEPS_PER_FRAME) this.accumulator = 0

    if (!this.currPose || !this.currTelemetry) return null
    if (!this.prevPose) this.prevPose = this.currPose

    const alpha = THREE.MathUtils.clamp(this.accumulator / FIXED_DT, 0, 1)

    const px = THREE.MathUtils.lerp(this.prevPose.px, this.currPose.px, alpha)
    const py = THREE.MathUtils.lerp(this.prevPose.py, this.currPose.py, alpha)
    const pz = THREE.MathUtils.lerp(this.prevPose.pz, this.currPose.pz, alpha)
    const simTime = THREE.MathUtils.lerp(this.prevPose.time, this.currPose.time, alpha)

    this.qPrev.set(this.prevPose.qx, this.prevPose.qy, this.prevPose.qz, this.prevPose.qw)
    this.qCurr.set(this.currPose.qx, this.currPose.qy, this.currPose.qz, this.currPose.qw)
    this.qOut.copy(this.qPrev).slerp(this.qCurr, alpha)

    const { bodyAngleDeg, yawAngleDeg, rollAngleDeg } = eulerFromQuat(this.qOut)

    // Shallow-copy the latest telemetry tick, then overwrite only the
    // spatial fields with the interpolated pose. Every scalar/enum field
    // (thrust, mass, stage, outcome, HUD numbers, ...) stays exactly what
    // the physics engine computed for the current tick — only position
    // and orientation are smoothed between ticks.
    const snapshot: RenderSnapshot = {
      ...this.currTelemetry,
      time: round2(simTime),
      lateralOffset: px,
      altitude: py,
      positionZ: pz,
      bodyAngle: bodyAngleDeg,
      yawAngle: yawAngleDeg,
      rollAngle: rollAngleDeg,
    }
    return { render: snapshot, ticks }
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}