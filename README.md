# Kalam

An interactive rocket-launch simulator driven by hand gestures, a full 6-DOF rigid-body flight model, and rule-based spoken commentary. You arm the launch by counting down from 5 to 0 with your hand, configure the vehicle, then fly it: hold the arrow keys to command pitch rate and the flight computer allocates torque between thrust vectoring, aerodynamic control fins and cold-gas thrusters. Everything runs in the browser.

Physics comes first. The renderer is a view of the telemetry stream; it never feeds anything back into the simulation.

---

## Contents

1. [Features](#features)
2. [Architecture and data flow](#architecture-and-data-flow)
3. [Conventions](#conventions)
4. [Flight model](#flight-model)
5. [Flight safety: sanity checks and the watchdog](#flight-safety-sanity-checks-and-the-watchdog)
6. [Telemetry](#telemetry)
7. [Rendering](#rendering)
8. [Vehicle selection and gestures](#vehicle-selection-and-gestures)
9. [Hand tracking and countdown](#hand-tracking-and-countdown)
10. [Commentary engine](#commentary-engine)
11. [Launch parameters](#launch-parameters)
12. [Reference flight and validation](#reference-flight-and-validation)
13. [Known limitations](#known-limitations)
14. [Setup](#setup)
15. [How to fly](#how-to-fly)
16. [Project structure](#project-structure)
17. [Tuning constants](#tuning-constants)
18. [Sponsorship](#sponsorship)
19. [License](#license)

---

## Features

- **Gesture-driven pre-launch.** In-browser hand landmark detection drives the whole pre-flight sequence: swipe to browse vehicles, clap to confirm, then a finger count (5, 4, 3, 2, 1, fist) steps the state machine `idle -> selecting -> counting -> armed -> launched`. Keyboard and on-screen controls work as fallbacks.
- **Four selectable vehicles.** Four original, fully procedural launch-vehicle models (no image or model files), in three quality tiers with automatic step-down on slow GPUs. Vehicles are cosmetic for now: they share one flight model.
- **Full 6-DOF rigid-body physics.** State is a 13-scalar vector — position, velocity, orientation quaternion and body-frame angular velocity — integrated with RK4 in sub-steps of at most 5 ms, with quaternion renormalization every step. Pitch, yaw and roll are all independently modelled, with real gyroscopic coupling between axes.
- **Spherical gravity.** True inverse-square gravity toward a planet centre sitting below the pad, resolved in all three dimensions, so lateral and out-of-plane drift both correctly tilt gravity toward the true centre instead of pointing straight down.
- **ISA 1976 atmosphere** (seven layers, chained base pressures, density from the ideal-gas law, geopotential altitude) with an altitude wind profile and mean-reverting gusts. Aerodynamics use air-relative velocity.
- **Geometry derived from the launch parameters.** Reference area sets diameter and length; nose, fins, centre of gravity, centre of pressure, inertia and static margin all follow from it.
- **Full-angle, full-3D aerodynamics.** Normal force is valid from 0 to 180 degrees total angle of attack, resolved independently into pitch-plane and yaw-plane components, so tail-first flight is modelled in any axis and is naturally unstable. Mach-dependent axial drag, fin compressibility correction, cross-flow term, pitch/yaw damping.
- **Altitude-compensated propulsion.** `F = f * F_vac - p_ambient * A_exit`, mass flow from the burn rate, ignition ramp, tail-off, jet damping. Thrust direction follows a 2-axis gimbal (pitch and yaw).
- **Moving mass properties.** Centre of gravity and the full diagonal inertia tensor (shared pitch/yaw inertia, plus a separate, smaller roll inertia) are recomputed every step from structure, propellant and cold-gas masses, including the `dI/dt` terms in the rotational equation.
- **Independent per-axis flight computer.** Arrow keys command pitch rate; `setYawInput`/`setRollInput` are live on the physics engine for yaw and roll (not yet wired to a key — see Known limitations). On release the vehicle holds attitude on each axis independently. Demanded torque for pitch and yaw is shared between thrust vectoring and movable aerodynamic control fins in proportion to the authority each has at that instant; roll has no TVC or fin authority (single-engine vehicle) and is cold-gas only. A finite cold-gas budget, shared across all three axes, covers whatever the other actuators cannot.
- **Flight sanity check and runaway watchdog.** Before launch, a quick check flags thrust-to-weight, burn-time or geometry combinations well outside the simulator's tuned envelope and asks for confirmation rather than silently clamping what you typed. During flight, a local rule-based watchdog — no external API, just threshold checks against the engine's own telemetry — detects a control loop that has lost attitude authority and triggers a flight-termination abort: thrust cuts immediately and the main parachute deploys, the same idea as a real rocket's flight termination system. See [Flight safety](#flight-safety-sanity-checks-and-the-watchdog).
- **Recovery.** Drogue then main parachute, attached at the nose, with forces evaluated at the attachment-point velocity in full 3D (real swing damping follows from this). Deployment is gated by dynamic pressure and altitude, or forced immediately to main by a termination abort.
- **Touchdown classification** by impact speed, tilt (the true 3D angle from vertical) and spin rate magnitude across all three axes: `landed` or `crashed`.
- **3D renderer.** Selectable procedural rocket model pivoted about its centre of gravity, launch complex, plume expansion shader, flame trench flow, heat shimmer, a true-scale (6,371 km radius) procedural planet with atmosphere rim, starfield, volumetric clouds, bloom, chromatic aberration.
- **True-scale planet.** The globe is rendered at Earth's real radius, with a logarithmic depth buffer so a 3 m rocket and a 6,371 km planet share one depth range without z-fighting. A dynamic chase camera pulls back with altitude (log-ramped, user-adjustable) so the globe's curvature becomes visible as the vehicle climbs.
- **Realistic per-vehicle scale.** Each of the four vehicles is scaled to a distinct real-world height (50 to 120 m) instead of sharing one arbitrary size, so they read as different classes of rocket against the true-scale planet.
- **User zoom control.** The scroll wheel adjusts a zoom multiplier on top of the automatic altitude pullback.
- **Live instruments** for altitude, velocity, axial g, angle of attack, Mach, dynamic pressure, cold-gas remaining and nozzle deflection.
- **Telemetry-aware commentary**, spoken with the Web Speech API.

---

## Architecture and data flow

```
 webcam --> hand tracker --+--> gesture detector (swipe / clap) --> vehicle choice
                           |                                            |
                           +--> finger count --> countdown state machine <-+
                                                     |
                                                  (armed)
                                                     v
 launch parameters --> checkFlightSanity() --> RocketPhysicsEngine.launch()
                                                     |
 arrow keys --> setGimbalInput(-1..+1) --> step(dt) --+--> Telemetry snapshot
                                                          |        |        |
                                                          v        v        v
                                                   checkWatchdog()  Scene   commentary
                                                   (abort if tripped) (Three.js) (speech)
                                                          |             |
                                                          v             v
                                                   instruments (HUD)
```

- `App.tsx` owns the loop. Each animation frame it runs hand detection, advances the countdown machine, passes the held arrow-key state to the engine, calls `engine.step(min(dt, 1/30))`, checks the resulting telemetry against the local watchdog, and publishes the `Telemetry` object by ref (to the renderer) and by throttled React state (to the HUD, refreshed every 100 ms of wall-clock time so the final landed-or-crashed frame is never skipped).
- The engine is a plain TypeScript class with no DOM, React or three.js dependency — `vec3.ts` and `quat.ts` are small hand-rolled math primitives so the physics module stays headless and can be driven from a script for validation.
- Telemetry is the only contract between the engine and everything else. Values are rounded to 0.01 only when the snapshot is taken; internal state stays in full double precision.

---

## Conventions

| Item | Convention |
|---|---|
| Frame | Local launch-site tangent frame, inertial, origin at the pad. `+Y` = up, `+Z` = north, `+X` = east. Not rotating — Earth's rotation is not modelled (see Known limitations) |
| Body axes | `+Y_body` = nose-first (the primary thrust/symmetry axis), `+X_body` = pitch-plane normal, `+Z_body` = yaw-plane normal |
| Orientation | A quaternion `[x, y, z, w]` (Hamilton convention) rotating a vector from the body frame into the local frame — the same layout three.js's own `Quaternion` uses, so the renderer's one conversion point is a direct field copy |
| Pitch angle `bodyAngle` | From vertical, **clockwise positive** (nose right = positive), computed from the body `+Y` axis expressed in the local frame. Kept in this exact legacy sign so it reads the same as the pre-6-DOF planar model when yaw and roll are zero |
| Yaw angle `yawAngle` | Analogous construction in the `Y`-`Z` body plane, nose-toward-`+Z` positive |
| Roll angle `rollAngle` | Standard right-hand rotation about the body `+Y` (nose-first) axis |
| Angular velocity (internal) | Body-frame `[wx, wy, wz]` in rad/s, standard right-hand convention. Telemetry rates map back to the legacy sign for pitch (`angularVelocity = -wz`, deg/s) and directly for yaw (`yawRate = wx`) and roll (`rollRate = wy`) |
| Stations | Measured from the nose, aft positive |
| Gimbal | `(gimbalPitch, gimbalYaw)`, each independently rate/lag/travel limited, same nose-right-positive sign on both axes |
| Control fin | `(finPitch, finYaw)`, same sign convention as the matching gimbal axis |
| Angle of attack | Total 3D angle between the body `+Y` axis and the air-relative velocity, decomposed into independent pitch-plane and yaw-plane components (`alphaPitch`, `alphaYaw`) for the aero model. Reported total is `abs(alphaTotal)` in 0..180 degrees; 180 degrees means tail-first |
| G-loads | Specific force (what an accelerometer reads); gravity is excluded |

The arrow keys map to the same sign as `bodyAngle`: right arrow is +1 (nose right), left arrow is -1 (nose left). `setYawInput`/`setRollInput` follow the same `-1..+1` convention on their own axes.

---

## Flight model

All of this lives in `src/physics/rocketPhysics.ts`, with math primitives in `src/physics/vec3.ts` and `src/physics/quat.ts`.

### State and integration

- State vector, 13 scalars: `[px, py, pz, vx, vy, vz, qx, qy, qz, qw, wx, wy, wz]` — position and velocity in the local frame, orientation quaternion (body to local), and angular velocity in the body frame.
- `step(dt)` clamps `dt` to 0.1 s and divides it into `ceil(dt / 5 ms)` equal sub-steps. Each sub-step: engine state, mass properties, recovery logic, flight computer, gust update, RK4, quaternion renormalization, then ground and rail constraints.
- Mass properties, including the full inertia tensor, are evaluated at the start and end of the sub-step and averaged for the RK4 stage, with `dI/dt` taken from the difference, per axis.
- Equations of motion:

```
Translational (local inertial frame):
  dp/dt = v
  dv/dt = (F_thrust + F_aero + F_chute) / m  +  g(p)

Rotational (body frame):
  dq/dt = 0.5 * q (x) [omega, 0]                                  // quaternion kinematics
  I * dw/dt = tau_thrust + tau_aero + tau_damp + tau_fin + tau_rcs + tau_jet
              - w x (I * w)                                        // gyroscopic coupling
```

  `I` is a diagonal 3x3 tensor `diag(Ixx, Iyy, Izz)` with `Ixx = Izz` (pitch/yaw inertia, by axisymmetry) and `Iyy` a separate, smaller roll inertia. The `w x (I*w)` gyroscopic term is zero when only one rotational axis is active and becomes non-zero exactly when roll rate and pitch/yaw rate coexist — a real, measurable precession effect, not an approximation.
- **Quaternion renormalization.** `|q|` is renormalized to the unit sphere after every RK4 sub-step, since numerical drift would otherwise push the rotation it represents slowly out of validity over a long flight.
- **Collapse guarantee.** With zero yaw/roll input and zero initial roll, this engine's `px, py, vx, vy` and the pitch component of orientation/rate match the original planar 3-DOF model's `x, y, vx, vy, theta, omega` to within integration tolerance — this was the acceptance test for the 6-DOF rewrite.

### Atmosphere

- ISA 1976 with seven layers (base geopotential heights 0, 11, 20, 32, 47, 51, 71 km). Base pressures are chained from sea level exactly, not tabulated.
- Geometric altitude is converted to geopotential altitude with `r0 = 6,356,766 m`. Above 84.852 km the layer is isothermal and pressure decays exponentially.
- Density is `rho = p / (R_air * T)`, speed of sound `a = sqrt(gamma * R_air * T)`.
- Spot checks: 11,019.03 m geometric gives 216.65 K and 22,632.17 Pa; 20,062.98 m geometric gives 5,475.00 Pa.

### Gravity

- True inverse-square gravity toward a planet centre sitting directly below the pad in the local frame (`PLANET_CENTER = (0, -R_earth, 0)`), resolved as a full 3D vector: `g(p) = -G0 * (R_earth / r)^2 * (p - center) / r`, where `r` is the distance from the planet centre.
- Unlike a flat-Earth model, this correctly tilts gravity toward the true centre as the vehicle moves laterally (`X`) or out-of-plane (`Z`), not just vertically.

### Wind

- A tabulated profile (11 altitude nodes from 0 to 86 km, peaking at 7.2 times the surface scale near 11 km) is multiplied by a random per-launch surface scale of 2 to 6 m/s with a random sign, applied along local `+X`.
- Gusts follow a mean-reverting (Ornstein-Uhlenbeck type) process with a 3 s time constant and `sigma = 0.1 * |wind(h)| + 0.25 m/s`.
- Wind enters the aerodynamics through the air-relative velocity `v_rel = v - wind`, resolved in 3D. It is deterministic given the random seed drawn at `launch()`.

### Geometry

Everything derives from the user's reference area `A`:

```
D = sqrt(4 A / pi)        body diameter
L = 12 D                  body length (fineness ratio 12)
nose length = 3 D         (ogive)
4 swept fins: root chord 2.0 D, tip chord 0.5 D, span 0.8 D, sweep 1.1 D
```

Fin normal-force slope is computed by component build-up from the planform. Nose slope is `CN_alpha = 2.0 per rad` (slender-body theory). The four fins are not individually modelled for roll authority — see Known limitations.

### Aerodynamics

- **Total angle of attack.** The air-relative velocity is rotated into the body frame (`v_body = q^-1 * v_rel`), and the total angle of attack is the angle between `v_body` and the body `+Y` axis: `alphaTotal = acos(v_body.y / |v_body|)`. This is decomposed into `alphaPitch = atan2(v_body.x, v_body.y)` and `alphaYaw = atan2(v_body.z, v_body.y)` for resolving forces into the pitch and yaw planes independently.
- **Axial force.** `Fa = -q * A * Cd_axial * cos(alphaTotal)`. For nose-first flow, `Cd_axial = Cd_user * cdRatio(Mach) * (1 - 0.12 * thrustFraction)`, where `cdRatio` is a Mach drag-rise table normalised to its subsonic value (subsonic 0.295, peak 0.55 at Mach 1.1 to 1.2, falling to 0.17 by Mach 10) and the 0.12 term is power-on base-drag relief. For tail-first flow the axial coefficient is a separate constant 0.95 (blunt base).
- **Normal force**, valid over the whole 0..180 degree total-angle-of-attack range, computed at the same magnitude as the original planar model's tables, then split between the pitch-plane and yaw-plane components in proportion to `sin(alphaPitch)` and `sin(alphaYaw)`:

```
Fn_nose  = q A CN_nose            * sin(alphaTotal) |cos(alphaTotal)|
Fn_fins  = q A CN_fin * k(Mach)   * sin(alphaTotal) |cos(alphaTotal)|
Fn_cross = q A_planform * 1.1     * sin(alphaTotal) |sin(alphaTotal)|
```

  `k(Mach)` is the fin compressibility factor: `1/sqrt(1 - M^2)` below Mach 0.8, constant from 0.8 to 1.2, then a supersonic `0.663 / sqrt(M^2 - 1)` scaling. Fin lift falls by roughly 2.5 times between Mach 1.2 and Mach 2, which moves the centre of pressure forward.
- **Torque.** Each normal-force component acts at its own station (nose at 0.466 nose lengths, fins at the planform centroid station, cross-flow at 0.55 L), giving independent pitch-axis and yaw-axis aero torque about the instantaneous centre of gravity.
- **Pitch/yaw damping.** Evaluated per axis using that axis's own body-frame rate: `tau_damp = -q A (CN_nose dn^2 + CN_fin k df^2) / max(V, 5) * rate`.
- **Roll.** No passive aerodynamic roll torque — the fins are modelled as a lumped `CN_fin`, not individually, so there is nothing to produce a restoring or damping moment about the roll axis. This is a deliberate simplification (most real rockets have near-zero passive roll torque by design), not an oversight.
- **Stability.** Nose-first (`alphaTotal = 0`) is the stable equilibrium whenever the centre of pressure is aft of the centre of gravity; tail-first (`alphaTotal = 180`) is unstable in either the pitch or yaw plane. Nothing in the model is clamped to enforce this.
- **Static margin** in telemetry is `(x_cp - x_cg) / D`, evaluated with the current Mach-dependent fin factor, so it falls as the vehicle goes supersonic.

### Propulsion

```
F_vac  = F_sl * (311 / 282)               vacuum thrust from the user's sea-level thrust
A_exit = (F_vac - F_sl) / P_sl            exit area implied by that ratio
F      = f * F_vac - p_ambient * A_exit   altitude-compensated thrust
mdot   = f * burnRate                     mass flow
Isp_sl = F_sl / (burnRate * g0)           specific impulse follows from the parameters
```

- `f` is the throttle fraction: a smooth ramp from 10 percent to 100 percent over 0.6 s at ignition, 1 during burn, and a linear 0.25 s tail-off after propellant depletion.
- Thrust direction is the body `+Y` axis deflected by the gimbal angles — `thrustDirBody = [-sin(gimbalPitch), cos(gimbalPitch)*cos(gimbalYaw), cos(gimbalPitch)*sin(gimbalYaw)]` — then rotated into the local frame by the body quaternion. Thrust acts at the nozzle station (`L`), and its torque is a true 3D cross product `tau_thrust = r_nozzle x F_thrust`, so it naturally couples into whichever axes the gimbal actually deflects.
- Jet damping generalises to independent pitch and yaw terms, both proportional to `-mdot * (L - x_cg)^2 * rate` on their own axis; roll gets zero jet damping (the exhaust plume carries no roll moment of its own).

### Mass properties

Three lumps, each with its own station:

| Lump | Mass | Station | Pitch/yaw inertia | Roll inertia |
|---|---|---|---|---|
| Structure | `dryMass - coldGas` | 0.62 L from the nose | uniform rod about its own centre of gravity | `0.5 * m * (D/2)^2` |
| Propellant | `propellantMass`, decreasing | 0.45 L | cylinder, length 0.4 L, radius 0.4 D | `0.5 * m * tankR^2` |
| Cold gas | `max(0.25 kg, 0.04 * dryMass)` | 0.12 L | point mass | `0.5 * m * (0.15 D)^2` |

The cold-gas mass is carved out of the user's dry mass so total mass at ignition is exactly what the user entered. As propellant burns, the centre of gravity moves **aft**, which reduces static margin through the flight. Pitch/yaw inertia (`Ixx = Izz`) comes from the parallel-axis theorem, reused unchanged for both axes by the vehicle's axisymmetry. Roll inertia (`Iyy`) is a separate, much smaller sum — each lump's own radius-based term, with no parallel-axis contribution since the long axis passes through every lump's own centre.

### Flight computer

The flight computer is a rate-command, attitude-hold controller with dynamic inversion, applied independently on each of the pitch, yaw and roll axes.

1. **Command.** While a key is held, the demanded rate on that axis is `+/-30 deg/s` and the attitude target tracks the current attitude (leading by `0.3 s * rate`). On release, the outer loop holds that attitude: `rateCmd = clamp(1.8 * wrap(attitudeHold - attitude), +/-30 deg/s)`. Roll's attitude-hold target defaults to holding the current roll, since no particular roll orientation matters for an unguided ascent.
2. **Torque demand.** `tauNeed = I * 6 * (rateCmd - rate) - tauPassive` on pitch and yaw (using `Ixx`); `tauNeed = Iyy * 6 * (rateCmd - rate)` on roll (no passive torque to feed forward, since roll has none). The `- tauPassive` term feeds forward the exact passive aerodynamic, damping, jet and parachute torque on that axis, so the controller cancels the airframe's own stiffness instead of fighting it.
3. **Allocation (pitch and yaw only).** Two actuators share each axis's demand in proportion to the authority each has right now:

```
tvc_authority = T * (L - x_cg) * sin(gimbal_max)                       // zero when the engine is off
fin_authority = q * A * CN_fin * k(Mach) * 0.75 * (x_fin - x_cg) * fin_max   // zero with no airflow
```

   TVC dominates at low dynamic pressure and on the pad; the fins dominate in dense, fast air. Their combined authority is what lets the vehicle rotate against the airframe's own aerodynamic restoring torque at any launch time. Roll has no TVC or fin allocation — a single-engine vehicle's gimbal cannot produce roll torque, matching real vehicles (Falcon 9 also uses cold-gas/grid-fin roll control, not engine gimbal, for roll).
4. **Cold gas.** Any torque pitch or yaw cannot supply (saturation, engine off, thin air), plus all of roll's demand, goes to a 3-axis cold-gas thruster couple, capped at `30 deg/s^2 * I` (or `* Iyy` for roll), with a 4 percent deadband per axis. All three axes share one finite cold-gas budget — gas use sums across whichever axes are firing, `2 * F_thruster / (Isp_cold * g0) * dt` per firing axis, with `Isp_cold = 65 s`; torque is scaled down proportionally across all firing axes as the tank empties.
5. **Actuators.** Gimbal and fins are each first-order lag plus rate limit plus travel limit, independently on pitch and yaw: gimbal +/-6 degrees, 25 deg/s, 0.05 s lag; control fins +/-15 degrees, 80 deg/s, 0.03 s lag. After parachute deployment the flight computer is disabled.

A raw mode (`setAssist(false)`) maps the keys directly to gimbal and fin deflection on pitch and yaw, and to a roll RCS command, without attitude hold.

Arrow-key UI input remains pitch-only (matches the existing interface); `setYawInput` and `setRollInput` are live physics-engine API that the UI does not yet drive — see Known limitations.

### Recovery

- **Drogue**: deploys after burnout plus tail-off when descending, above 20 m, with dynamic pressure below 800 Pa. Area is 2.5 percent of the main canopy area.
- **Main**: deploys below 350 m while descending with dynamic pressure below 1,500 Pa. Canopy area is sized for a 5.5 m/s steady descent at dry mass: `A_main = 2 m_dry g0 / (rho0 * 1.5 * 5.5^2)`.
- Inflation follows a smoothstep over 2 s. The canopy force acts at the **nose** and uses the full 3D velocity of the attachment point (`v + q * (w x r)`), so a swinging vehicle experiences real damping in any direction. The attachment lever produces a true 3D torque about the centre of gravity.
- A flight-termination abort (see [Flight safety](#flight-safety-sanity-checks-and-the-watchdog)) bypasses the normal gates and forces deployment straight to the main chute.

### Ground, rail and landing

- **Rail.** Until `py >= L`, position, lateral/out-of-plane velocity, orientation and angular velocity are constrained to zero (the vehicle is guided, upright, non-rotating). The hold-down keeps it on the pad until thrust exceeds weight.
- **Touchdown** is detected when `py <= 0` with `vy <= 0` after lift-off and rail clearance. Classification: `landed` if impact speed is at most 9 m/s, tilt (the true 3D angle from vertical, `acos(bodyDir.y)`) is at most 30 degrees and spin magnitude (`|w|` across all three body axes) is at most 45 deg/s; otherwise `crashed`. After touchdown the state is frozen and `outcome` and `impactSpeed` are reported.
- The flight stage after touchdown stays `descent`; the application watches `outcome`.

### Stages

`pre-launch -> powered-ascent -> coast -> apogee -> descent`. Powered ascent persists while propellant remains or thrust is above zero; coast needs `vy > 0.5 m/s`; apogee is declared within 0.5 m/s of the maximum altitude; anything else after lift-off is descent.

---

## Flight safety: sanity checks and the watchdog

Two independent, purely local safety layers sit around the 6-DOF engine — neither calls any external service or model; both are plain deterministic checks against values the engine already computes.

### Pre-launch: `flightSanity.ts`

The flight computer's gains were tuned for realistic rocket thrust-to-weight ratios (roughly 1.2 to 4). Launch parameters are currently free-entry and not yet clamped to per-vehicle ranges, so nothing stops a wildly unrealistic combination — extreme thrust against a light dry mass, a near-instant burn, or a degenerate cross-section. `checkFlightSanity(params)` flags:

- **Thrust-to-weight above 15:1.** Real launch vehicles fly at 1.2 to 4:1. Above roughly 15:1 the control loop can lose its grip once angle of attack swings past 90 degrees, because the gimbal and fin actuators saturate chasing a target that outruns their own rate limits.
- **Burn time under 50 ms.** The ignition ramp (0.6 s to reach full thrust) barely has time to engage before burnout.
- **Degenerate cross-section area** (under 0.001 m²), which makes the derived body geometry nonsensical.

If any check fails, `App.tsx` shows a plain confirmation dialog listing the specific warnings and lets the user launch anyway — a heads-up, not a hard block, since the parameter ranges aren't rocket-specific yet and extreme values are sometimes exactly what someone wants to explore.

### In-flight: `flightWatchdog.ts`

`checkWatchdog(telemetry)` runs every frame against the live telemetry snapshot. It is a stateless pure function — one snapshot in, one verdict (or `null`) out — checking:

- Any non-finite value (`NaN`/`Infinity`) in the core state.
- Angular rate above 2,000 deg/s on any single axis, or a combined magnitude above 3,000 deg/s across pitch, yaw and roll together.
- Mach number above 500.
- Altitude magnitude above 5,000 km.

These thresholds sit well above anything a realistic flight produces (confirmed by replaying realistic thrust-to-weight configurations under continuous aggressive stick input — rates stayed in the tens of deg/s even under hard maneuvering) and well below the values an actual control-loop runaway reaches within a couple of seconds (rates in the thousands to hundreds of thousands of deg/s, altitude reaching astronomically large or non-finite values).

When the watchdog trips, `App.tsx` calls `engine.abort()`:

- Propellant is set to zero — thrust cuts immediately (subject to the normal tail-off ramp, same as a nominal burnout).
- The parachute is forced straight to the main-canopy stage, bypassing the normal altitude/dynamic-pressure/descent-rate gates, since this is an emergency termination, not a nominal recovery sequence.
- Rotation itself is **not** force-zeroed — a real flight termination system doesn't reset the vehicle's attitude either; it just kills the engine and lets aerodynamic drag and the chute bring things back under control, which is exactly what happens here.
- `engine.isAborted()` reports the termination so the UI can show a banner; the call is idempotent, so a watchdog that keeps tripping on subsequent frames does nothing further.

This mirrors a real rocket's flight termination system in spirit: watch a small set of flight-safety signals, and if one crosses a hard limit, cut thrust and trigger recovery before things get worse — entirely offline, entirely deterministic, with no model or network call in the loop.

---

## Telemetry

`Telemetry` (see `src/types.ts`) is the single shape published each step.

| Group | Fields |
|---|---|
| Flight state | `time`, `altitude`, `velocity`, `acceleration`, `mass`, `stage`, `lateralOffset`, `lateralVelocity`, `positionZ`, `velocityZ`, `maxAltitude`, `airspeed`, `flightPathAngle` |
| Attitude (pitch) | `bodyAngle` (+/-180), `angularVelocity`, `gimbalAngle`, `finAngle` |
| Attitude (yaw) | `yawAngle`, `yawRate`, `gimbalYawAngle`, `finYawAngle` |
| Attitude (roll) | `rollAngle`, `rollRate` |
| Attitude (combined) | `angleOfAttack` (0..180, total 3D) |
| Aero and propulsion | `dynamicPressure`, `machNumber`, `thrustNewtons`, `isp`, `twr`, `maxQ`, `maxMach`, `propellantRemaining`, `cdAxial` |
| Loads | `axialGLoad`, `lateralGLoad` (specific force, in g) |
| Flight computer | `pitchRateCommand`, `attitudeTarget`, `gimbalCommand`, `rcsFuel`, `rcsTorque` (pitch), `rcsTorqueYaw`, `rcsTorqueRoll` |
| Vehicle | `staticMargin`, `centerOfGravity`, `centerOfPressure`, `momentOfInertia` (pitch/yaw), `bodyLength` |
| Environment | `airDensity`, `airPressure`, `airTemperature`, `speedOfSound`, `windSpeed` |
| Recovery and outcome | `chuteState` (0 stowed, 1 drogue, 2 main), `outcome` (`flying`, `landed`, `crashed`), `impactSpeed` |

`EMPTY_TELEMETRY` is exported from the physics module and is used for pre-launch display. `bodyAngle`, `angularVelocity`, `gimbalAngle`, `finAngle` and `rcsTorque` keep their exact original meaning (pitch) from the pre-6-DOF model — the 6-DOF fields above are purely additive, so nothing downstream broke when they were introduced.

---

## Rendering

The renderer reads the telemetry ref each frame. It contains no physics.

- **Scale.** Altitude and lateral offset are multiplied by `ALTITUDE_SCALE = 0.05`, so one scene unit represents 20 m. The planet, sky dome, starfield and camera far plane are all built at this same true scale (see Planet, below); the launch pad and support structure are drawn at a larger, cinematic scale so they stay legible up close.
- **Logarithmic depth buffer.** The renderer is created with `logarithmicDepthBuffer: true`. A linear depth buffer cannot represent both a few-metre rocket and a 318,550-unit-radius planet in one range without z-fighting; the log buffer resolves the full span from 0.1 to 800,000 scene units. `CloudPass` decodes depth accordingly (`viewZ = exp2(depth * log2(far + 1)) - 1`) instead of the standard linear formula.
- **Pose.** The model's origin is at the base of its engine section, but the physics state describes the centre of gravity. The CG's world position is `(lateralOffset, altitude + cgHeightAboveBase, positionZ)` where `cgHeightAboveBase = (1 - centerOfGravity / bodyLength) * modelHeight`. The group's rotation currently still reads `bodyAngle` (pitch) only; yaw and roll are tracked in telemetry but not yet applied to the render pose — see Known limitations. A ground clamp prevents any tilted body from sinking below the pad.
- **Camera.** A dynamic chase camera, not a fixed offset. The base offset is `(4, 3.5, 16)` from the CG, nearly side-on, so left and right pitch stay mirror images and the vehicle rotates about the centre of the frame. That offset is scaled by `(1 + log1p(altitudeKm * 0.5) * 2.5) * userZoom`, so the camera pulls back smoothly as altitude climbs. `userZoom` is a multiplier (clamped 0.15 to 6) driven by the mouse wheel.
- **Rocket models.** Four vehicles are built by `buildVehicle(id, quality, envMap)` in `buildRocket.ts`. Bodies, domes, ogives and engine bells are lathe-revolved profiles; fins are bevelled extrusions; struts are cylinders; rivets are instanced spheres. All static parts are merged into one mesh per material, so a vehicle costs roughly 9 draw calls. A small shader patch adds per-pixel panel seams, exhaust soot, and low-frequency mottling, with no textures. Materials are PBR and use the scene environment map; the high tier adds clearcoat on painted surfaces and rivets. Tone mapping is ACES filmic. The nozzle group pivots at the engine mount, so the gimbal animation is the same for every vehicle. After building, each model is uniformly scaled so its bounding-box height matches a realistic real-world height for that vehicle class (K-1 Strap 50 m, K-2 Reuse 70 m, K-3 Tower 98 m, K-4 Steel 120 m), converted to scene units; the `height` returned to the scene is measured after scaling, so centre-of-gravity placement and chute position are unaffected.
- **Quality tiers.** `low`, `medium`, `high` change radial segment counts, clearcoat, soot and mottle detail, rivets and fin bevels. Measured with all four vehicles in one scene: low 36 draw calls / 20k triangles, medium 36 / 33k, high 40 / 82k (only one vehicle is ever shown at a time). While on the pad, if the average frame time exceeds about 33 ms over 90 frames, the scene rebuilds the vehicle one tier lower.
- **Launch complex.** Textured pad, support legs, flame deflector, hold-down arms, tower, scorch decal. At ignition a dual-sided flame-trench shader fans out horizontally and a ground ignition cloud billows independent of rocket altitude.
- **Plume.** A shader-deformed cone whose radius follows an expansion factor `1 - exp(-altitude / 8500 m)`: shock-disc structure at sea level, widening to a vacuum cone with altitude. Fresnel rim fade softens the silhouette. Exhaust particles are spawned at the nozzle and travel opposite to the body axis, so they follow the rocket through a flip.
- **Planet.** True Earth radius: 6,371 km, scaled to 318,550 scene units. Two meshes share one set of noise-based colour uniforms: a coarse globe sphere (256 x 128 segments) visible from orbital altitude and used as the natural horizon, and a high-resolution near patch — a 160 x 160 flat grid covering a 20 km radius, each vertex projected onto the sphere surface in the vertex shader for metre-scale ground detail close to the pad, fading out between 8,000 m and 40,000 m as the coarse globe takes over. Colour comes from five-octave domain-warped 3D noise evaluated on the sphere normal: ocean, coastal foam, sand, lowland, highland and rock bands, biased so the launch site is always on land. Because only colour varies and the near patch is projected onto the same sphere radius as the globe, the physics ground (`py = 0`) always matches what is drawn. White cloud patches fade in on the globe from 300 to 4,000 m. A back-faced, additive atmosphere shell (80 km thick) supplies the blue limb glow from orbit.
- **Sky and stars.** Three-stop gradient dome, radius 600,000 scene units. 2,000 stars on a 500,000-unit shell fade in between 5 and 15 km altitude. There is no scene fog — at true planetary scale, fog would hide the globe entirely — so haze is handled by the atmosphere shell and cloud layers instead.
- **Volumetric clouds.** Three layers (stratus 0 to 600 m, cumulus 600 m to 2 km, cirrus 6 to 12 km) raymarched against a gradient and cellular noise volume with exponential extinction and height-based colour, composited via the log-depth-aware `CloudPass`.
- **Post-processing.** Heat scintillation pass masked around the rocket (peaks near 1,200 m, decays with an 8.5 km scale height), bloom, chromatic aberration ramping from 6 to 15 km, output pass.

**Known shader issue.** The near-patch ground shader currently fails to compile (`'uPatchRadius' : undeclared identifier`), which breaks the planet render. This is tracked separately from the 6-DOF work and is not yet fixed — see Known limitations.

---

## Vehicle selection and gestures

After the camera starts, the state machine enters `selecting`: the chosen vehicle turns slowly on the pad under a framing camera, with a name card, dot indicator and confirm button.

| Input | Action |
|---|---|
| Open hand moved sideways | Next / previous vehicle (user's right = next) |
| Clap (two hands) | Confirm and start the countdown |
| Left / right arrow, Enter | Previous or next, confirm |
| On-screen arrows and button | Same, for mouse and touch |

Detection (`hand/gestures.ts`) works on raw, un-mirrored normalised landmark coordinates:

- **Palm centre** is the mean of landmarks 0, 5, 9, 13, 17. **Hand size** is the wrist-to-middle-knuckle distance, which makes clap detection independent of distance from the camera.
- **Swipe.** One hand with at least four fingers extended. Over a 450 ms window the palm centre must travel at least 0.25 of the image width, with vertical drift under 0.6 of the horizontal travel. A 700 ms cooldown follows.
- **Clap.** Two hands present; palm-to-palm distance divided by mean hand size must fall below 1.6 after having exceeded 3.0 within the previous 500 ms. If the hands disappear within 250 ms of being seen closing (landmark detectors often lose overlapping palms), that also counts when the last distance was below 2.6. A 1.2 s cooldown follows.
- Detector thresholds are constants at the top of the file and will need tuning for a given camera and room.

The vehicle choice is cosmetic: all vehicles currently share one aerodynamic and propulsion model. Selection is frozen once the countdown starts.

---

## Hand tracking and countdown

- **Detection.** In-browser landmark detection with the GPU delegate, configured for two hands (needed by the clap gesture); the finger countdown reads the first hand. Each frame yields 21 landmarks per hand with handedness and a confidence score.
- **Finger count.** A joint-angle heuristic per finger, handedness-aware for the thumb, returning 0 to 5 or `null` when no hand is present.
- **State machine.**

```
idle -> selecting -> counting(expected, heldFrames) -> armed -> launched
```

  `selecting` ends with a clap or an explicit confirm.

  In `counting`, the expected digit steps 5, 4, 3, 2, 1, 0 (fist). The reading must match for a minimum number of consecutive frames (about 0.5 s) before the machine advances. `armed` unlocks the parameter panel and the Launch button.

---

## Commentary engine

- Rule-based trigger engine with 12 trigger types: `countdown`, `pre-launch`, `ignition`, `max-q`, `burnout`, `coast`, `apogee`, `descent`, `landed`, `high-g`, `high-aoa`, `fast-descent`.
- Stage-transition triggers fire once on entry. Event triggers (high g, steep angle of attack, fast descent) fire when telemetry crosses a threshold. Periodic lines fill long coast and descent phases. The engine is given the live air density each tick.
- Lines are templates filled with live telemetry values. A 12-entry no-repeat ring buffer prevents the same line twice in a row.
- Speech uses the Web Speech API (`rate 1.05`, `pitch 0.9`); the currently spoken line is cancelled when a new one fires.

---

## Launch parameters

| Parameter | Unit | Meaning |
|---|---|---|
| `thrust` | N | Sea-level thrust |
| `dryMass` | kg | Structure, engine and cold-gas tank |
| `propellantMass` | kg | Propellant at ignition |
| `burnRate` | kg/s | Mass flow at full throttle; sets `Isp = thrust / (burnRate * g0)` and burn time |
| `dragCoefficient` | - | Subsonic axial drag coefficient; the Mach drag-rise curve is scaled by it |
| `crossSectionArea` | m^2 | Reference area; sets body diameter, length, fin size and inertia |

Launch is blocked when thrust-to-weight at ignition is below 1. Derived values shown live in the panel: thrust-to-weight and burn duration. A thrust-to-weight above roughly 15, a near-instant burn, or a degenerate cross-section triggers the pre-launch sanity warning described in [Flight safety](#flight-safety-sanity-checks-and-the-watchdog) — launch is still allowed after confirmation.

---

## Reference flight and validation

Reference vehicle: thrust 2,200 N, dry mass 15 kg, propellant 20 kg, burn rate 1.2 kg/s, drag coefficient 0.5, reference area 0.05 m^2.

| Quantity | Value |
|---|---|
| Sea-level / vacuum Isp | 187 s / about 206 s |
| Diameter / length | 0.252 m / 3.02 m |
| Burn time | about 17 s |
| Peak Mach | about 1.1 |
| Apogee | about 6.1 km |
| Max dynamic pressure | about 53 kPa |
| Descent | soft touchdown at roughly 6 m/s after about 250 s |

Validation performed headlessly against the engine:

- **Step-size convergence.** Re-running the same flight from 30 Hz to 1 kHz frame rates changes apogee by 1.7 m out of 6,100 m.
- **Impulse bracket.** Delivered impulse (about 37.6 kN s) sits between the ideal sea-level and ideal vacuum values (about 36.7 and 40.4 kN s).
- **ISA.** Spot checks listed above, with layer base pressures chained so pressure is continuous across every layer boundary by construction.
- **Collapse test (6-DOF acceptance).** With zero yaw/roll input and zero initial roll, the 6-DOF engine's apogee on the reference flight comes out at 6,102 m against the pre-6-DOF model's 6,100 m, with left/right pitch behaviour matching the original symmetry test; out-of-plane position and yaw stay at exactly zero throughout.
- **New-physics sanity.** A constant yaw-gimbal input produces symmetric out-of-plane drift in both directions (mirror-image magnitude for `+0.5` versus `-0.5` yaw input), with pitch staying essentially undisturbed.
- **Gyroscopic coupling.** Spinning the vehicle about its roll axis via RCS, then commanding a pitch input, produces a measurable induced yaw rate — confirming the `w x (I*w)` term in Euler's equation is actually wired in and non-trivial, not a placeholder.
- **Left/right symmetry (pitch).** Mirrored runs (left key with one wind sign versus right key with the opposite sign) agree to within gust noise: time to rotate through 150 degrees differs by at most 0.2 s across launch times from 0.5 s to 20 s.
- **Controllability (pitch).** Holding a pitch key rotates the vehicle 180 degrees in about 5.5 to 7.3 s at any launch time, across five different parameter sets (light, heavy, fat, slim and high-thrust). Flipping in the first seconds sends the vehicle into the ground at roughly 250 to 290 m/s; flipping later in the burn or in the coast leaves it flying inverted. Peak lateral load during a high-dynamic-pressure flip is about 21 g, which a real airframe would not survive; there is no structural failure model yet.
- **Stability across configurations.** Nominal (no key input) flights land softly for all five parameter sets, including one that reaches Mach 2.6. Realistic thrust-to-weight configurations (1.8 to 6.4) under continuous aggressive pitch/yaw stick input stayed numerically stable (no non-finite values, no runaway rates) through thousands of integration steps; low/mid thrust-to-weight configurations under sustained hard maneuvering crashed, which is expected rocket behaviour under those inputs rather than a stability bug.
- **Cold-gas-only pitch.** At low dynamic pressure the cold-gas couple alone achieves the commanded 30 deg/s using about 0.07 kg of gas.
- **Parachute swing.** Pendulum motion under canopy settles in about 4 s.
- **Watchdog verification.** Replaying the exact parameter set that produced a real control-loop runaway (thrust 992,200 N against a 535 kg vehicle, thrust-to-weight around 190) with sustained yaw input: the watchdog tripped at t=3.03 s on an angular-rate-runaway verdict (yaw rate past -2,000 deg/s), thrust fell to zero within roughly 0.3 s via the tail-off ramp, the main chute deployed immediately, yaw rate collapsed from the thousands of deg/s down to the tens within about 2 s, and altitude settled into a stable, slowly descending state — no non-finite values were reached at any point after the abort.

---

## Known limitations

- **Yaw and roll have no UI input yet.** `setYawInput`/`setRollInput` are live on the physics engine and fully functional, but the arrow-key handling in `App.tsx` still only drives pitch. Wiring a second axis (or a controller/gamepad) to yaw and roll is a UI-only task, not a physics one.
- **The renderer does not yet apply yaw or roll to the model's pose.** `Scene.tsx` still rotates the vehicle model by `bodyAngle` (pitch) only; `yawAngle` and `rollAngle` are present in telemetry but not yet read by the render pose. This is an intentional seam — rendering catches up once the control UI exists to actually produce yaw and roll in normal play.
- **No passive aerodynamic roll torque or roll control authority beyond cold gas.** The fins are a lumped `CN_fin`, not modelled individually, so there is no restoring or damping moment about roll, and no gimbal or fin roll authority exists for a single-engine vehicle (matching real rockets, which use cold gas or grid fins for roll).
- **Earth's rotation is not modelled.** The local frame is inertial but stationary — no Coriolis effect, no eastward launch-site velocity boost, no rotating-frame vs. inertial-frame distinction for orbital work.
- **The planet is a sphere, not an ellipsoid.** WGS84 geodetic correction is a small quantitative refinement on top of the current spherical-gravity model, not implemented.
- **No structural failure model**: loads are reported, but nothing breaks.
- **The wind sign is random per launch**, so two otherwise identical launches can drift differently.
- **The Mach-dependent nose slope is held constant**; only the fins carry the compressibility correction.
- **Vehicle models are cosmetic**: they do not change mass properties, aerodynamics or propulsion, and the drag, fin and centre-of-gravity geometry is still derived from the reference area. The fin planform in the physics does not match each model's drawn fins. Each model's real-world height (used for render scale) is likewise independent of the physics geometry derived from the reference area.
- **Gesture thresholds are tuned on synthetic landmark data only** and need calibration on real cameras; swipe direction depends on the camera not being mirrored in the raw feed.
- **The control fins are modelled in the physics and reported in telemetry** (`finAngle`, `finYawAngle`) but are not yet animated on the 3D model.
- **Left/right arrow input commands a pitch *rate*, not lateral translation.** Because the attitude-hold loop re-centres pitch quickly and lateral drift is a second-order, lagged consequence of thrust/drag tilt (not a direct force), a short tap reads mostly as the nose tipping rather than as sideways motion — the vehicle does genuinely drift sideways once the tilt has had time to act on its mass, matching real gravity-turn behaviour, but it is not an arcade-style strafe.
- **Launch parameters are not yet clamped to per-vehicle or physically plausible ranges.** The pre-launch sanity check (see [Flight safety](#flight-safety-sanity-checks-and-the-watchdog)) warns on extreme thrust-to-weight, burn time or geometry, but does not block launch — at the extremes, the control loop can still lose attitude authority, which is what the in-flight watchdog's abort sequence exists to catch.
- **The near-patch ground shader currently fails to compile** (`'uPatchRadius' : undeclared identifier` in the vertex shader), which breaks the planet render. This is a separate, open issue from the 6-DOF physics work and is not yet fixed.

---

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and allow webcam access when prompted. A production build is a static bundle:

```bash
npm run build      # outputs dist/
npm run preview
```

---

## How to fly

1. **Choose a vehicle.** Swipe an open hand sideways to browse, then clap (or press Enter) to confirm.
2. **Count down** with one hand: hold 5 fingers steady until it steps to 4, then 3, 2, 1, fist. Each digit must be held for about 0.5 s.
3. **Set parameters** once armed. Watch the derived thrust-to-weight and burn time update. Launch is blocked below thrust-to-weight 1; well above thrust-to-weight 15 you'll get a warning dialog first.
4. **Launch.**
5. **Steer.** Hold the left or right arrow key to command a pitch rate of up to 30 deg/s in that direction. Release to hold the current attitude. Holding for about 6 s turns the vehicle through 180 degrees.
6. Watch the telemetry. Compare burn, coast, apogee, descent and touchdown against the reference flight, then change parameters and fly again. If a flight's control loop loses authority (most likely at an extreme thrust-to-weight ratio you launched anyway), the watchdog will terminate it automatically — thrust cuts and the main chute deploys, and a banner reports why.

---

## Project structure

```
src/
├── types.ts                    # Shared data shapes: hand types, countdown state, vehicle ids, rocket params, telemetry, commentary
├── flightSanity.ts             # Pre-launch check: flags extreme thrust-to-weight, burn time, or geometry before launch
├── flightWatchdog.ts           # In-flight check: local rule-based detection of a runaway control loop
├── hand/
│   ├── handTracker.ts          # Hand landmark detector wrapper (two hands)
│   ├── fingerCount.ts          # Landmark-based finger count (0-5)
│   └── gestures.ts             # Swipe and clap detection
├── state/
│   └── countdownMachine.ts     # idle -> selecting -> counting -> armed -> launched
├── physics/
│   ├── rocketPhysics.ts        # 6-DOF flight model: atmosphere, gravity, aero, propulsion, mass, flight computer, recovery, abort
│   ├── vec3.ts                 # Minimal dependency-free 3D vector math
│   └── quat.ts                 # Minimal dependency-free quaternion math
├── render/
│   ├── Scene.tsx               # Scene, shaders, post-processing, pose, dynamic chase camera, zoom
│   ├── buildRocket.ts          # Procedural vehicle kit: four vehicles at realistic scale, quality tiers, panel/soot shader
│   ├── buildGround.ts          # True-scale planet (globe + near patch), atmosphere rim
│   ├── buildSun.ts             # Sun disc matched to the scene light, scaled for true-scale sky
│   └── CloudPass.ts            # Volumetric cloud post-process pass (stratus, cumulus, cirrus), log-depth aware
├── commentary/
│   ├── commentaryEngine.ts     # Stage-transition and event trigger logic
│   └── lines.ts                # Line bank: telemetry-aware templates for all triggers
├── ui/
│   ├── VehicleSelect.tsx       # Vehicle picker overlay (name card, arrows, confirm)
│   ├── VehicleSelect.css
│   ├── ParamPanel.tsx          # Launch parameter inputs with live derived stats
│   └── InstrumentPanel.tsx     # Gauges: altitude, velocity, axial g, AoA, Mach, q, cold gas, nozzle deflection
└── App.tsx                     # Pipeline: webcam -> hand -> sanity check -> physics -> watchdog -> render -> commentary
```

---

## Tuning constants

The values below live at the top of `rocketPhysics.ts` unless noted otherwise.

| Constant | Value | Role |
|---|---|---|
| `FINENESS` | 12 | Length over diameter |
| `NOSE_LEN_D` | 3.0 | Nose length in diameters |
| `FIN_ROOT_D` / `FIN_TIP_D` / `FIN_SPAN_D` / `FIN_SWEEP_D` | 2.0 / 0.5 / 0.8 / 1.1 | Fixed-fin planform in diameters |
| `CNA_NOSE` | 2.0 per rad | Nose normal-force slope |
| `CD_CROSS` | 1.1 | Cross-flow drag coefficient |
| `CA_REAR` | 0.95 | Axial coefficient, tail-first |
| `BASE_RELIEF` | 0.12 | Power-on base-drag reduction |
| `ISP_VAC_RATIO` | 311 / 282 | Vacuum to sea-level thrust ratio |
| `IGN_TIME` / `IGN_FLOOR` / `TAILOFF` | 0.6 s / 0.1 / 0.25 s | Ignition ramp and tail-off |
| `GIMBAL_MAX` / `GIMBAL_RATE` / `GIMBAL_TAU` | 6 deg / 25 deg/s / 0.05 s | Thrust-vector actuator, pitch and yaw |
| `FIN_CTRL_MAX` / `FIN_CTRL_RATE` / `FIN_CTRL_TAU` / `FIN_CTRL_EFF` | 15 deg / 80 deg/s / 0.03 s / 0.75 | Control-fin actuator and effectiveness, pitch and yaw |
| `OMEGA_MAX` | 30 deg/s | Commanded rate at full key deflection, per axis |
| `K_THETA` / `K_OMEGA` | 1.8 / 6.0 per s | Attitude-hold and rate loop gains, all three axes |
| `RCS_ACCEL` / `RCS_DEADBAND` / `ISP_COLD` | 30 deg/s^2 / 4 percent / 65 s | Cold-gas couple, shared budget across pitch/yaw/roll |
| `STRUCT_CG` / `PROP_CG` / `PROP_LEN` / `RCS_TANK` / `RCS_ARM` | 0.62 / 0.45 / 0.40 / 0.12 / 0.60 | Mass station fractions of length |
| `GUST_TAU` | 3.0 s | Gust correlation time |
| `MAX_SUB_DT` | 1/200 s | Integrator sub-step |
| `CD_CHUTE` / `CHUTE_INFLATE` / `DROGUE_FRACTION` | 1.5 / 2.0 s / 0.025 | Parachute |
| `CHUTE_Q_MAX` / `MAIN_ALT` / `MAIN_Q_MAX` | 800 Pa / 350 m / 1,500 Pa | Deployment gates (bypassed on a termination abort) |
| `LAND_V_MAX` / `LAND_TILT_MAX` / `LAND_SPIN_MAX` | 9 m/s / 30 deg / 45 deg/s | Landed versus crashed (tilt and spin now true 3D magnitudes) |
| `TWR_WARN` (in `flightSanity.ts`) | 15 | Thrust-to-weight above which the pre-launch warning fires |
| `MAX_SANE_RATE_DEG_S` / `MAX_SANE_ANGVEL_SUM_DEG_S` (in `flightWatchdog.ts`) | 2,000 / 3,000 deg/s | Per-axis and combined angular-rate abort thresholds |
| `MAX_SANE_MACH` / `MAX_SANE_ALTITUDE_M` (in `flightWatchdog.ts`) | 500 / 5,000,000 m | Mach and altitude abort thresholds |

---

## Sponsorship

Kalam is an independent, open-source project. It is built and maintained in spare time, and sponsorship is what lets the next stages of work happen faster and stay free for everyone to use and learn from.

### What sponsorship funds

- **Yaw and roll control UI.** Wiring `setYawInput`/`setRollInput` (already live on the physics engine) into the keyboard, a gamepad, or an on-screen control, and extending the render pose to apply yaw and roll to the model.
- **Vehicle-specific physics.** Per-vehicle mass properties, staging, boosters, engine clusters and throttle profiles, so the four models stop being cosmetic.
- **Structural failure model.** Load limits, breakup and debris, so a high-g flip or an aborted flight actually costs you the vehicle.
- **Earth rotation and orbital mechanics.** Coriolis effects, launch-site eastward velocity, and real downrange/orbital tracking on top of the spherical-gravity 6-DOF model now in place.
- **Higher-fidelity rendering.** A fix for the current ground-shader compile error, cloud and plume improvements, an opt-in path-traced preview, per-vehicle launch pads, and control fins that move on the model.
- **Hosting and distribution.** Keeping the hosted demo online and fast, including model and asset delivery.
- **Calibration and accessibility.** Testing gesture detection across cameras, lighting and skin tones, adding touch and keyboard parity, and a low-power mode for older hardware.
- **Education.** Lesson plans, a guided "why did my rocket flip?" mode, and documentation for classrooms and clubs.

### Ways to support

| Tier | Good for | What you get |
|---|---|---|
| **Supporter** | Individuals | Name in the credits, early access to builds |
| **Builder** | Clubs, small teams | Everything above, plus a say in the roadmap order and a logo in the README |
| **Launch Partner** | Companies, institutions | Everything above, plus a named vehicle livery or launch-pad branding in the simulator, and a short co-written write-up |
| **In-kind** | Anyone | Cloud credits, hosting, GPUs for render testing, devices for camera calibration, or expert review of the physics |

Sponsors never get control over the physics or the code. Branding is always clearly labelled, and sponsored content is optional and can be switched off by the user.

### Research and academic collaboration

The flight model is open for inspection and the validation scripts are reproducible. Universities, labs and student chapters interested in using Kalam for teaching or in extending the dynamics (orbital mechanics, aeroelasticity, guidance laws, Monte Carlo dispersion studies) are welcome to get in touch about collaboration, co-authorship and shared datasets.

### How to get involved

Open an issue or discussion in the repository titled "Sponsorship", or use the sponsor button on the repository page once it is enabled. Please include who you are, which tier or in-kind contribution you have in mind, and any timelines. Contributions of code, bug reports, and validation data are equally valuable and need no tier.

---

## License

Apache 2.0. See [LICENSE](LICENSE).