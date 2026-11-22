<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React 18" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Three.js-r170-000000?logo=threedotjs&logoColor=white" alt="Three.js" />
  <img src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white" alt="Vite 5" />
  <img src="https://img.shields.io/badge/MediaPipe-Hands-4285F4?logo=google&logoColor=white" alt="MediaPipe" />
  <img src="https://img.shields.io/github/license/AnonymousSingh-007/Kalam?color=blue" alt="License" />
  <img src="https://img.shields.io/github/last-commit/AnonymousSingh-007/Kalam" alt="Last commit" />
</p>

<h1 align="center">Kalam</h1>

<p align="center">
  <em>An interactive rocket-launch simulator — gesture-driven, physically accurate, entirely in the browser.</em>
</p>

<p align="center">
  Named after <strong>Dr APJ Abdul Kalam</strong>, aerospace scientist and 11th President of India, whose life's work proved that rockets can be built anywhere ambition meets rigour.
</p>

---

## What is Kalam?

Kalam is a real-time rocket flight simulator that runs in your browser. You design a vehicle by entering its thrust, mass, fuel load and drag profile, then fly it — using your keyboard or your bare hands in front of a webcam.

The physics are not faked. Under the hood sits a full six-degree-of-freedom rigid-body engine: inverse-square gravity toward a true-scale Earth, a seven-layer atmosphere model, Mach-dependent aerodynamics valid from nose-first through tail-first flight, altitude-compensated propulsion, moving mass properties, and an independent three-axis flight computer that shares torque between a gimballed engine, aerodynamic control fins and cold-gas thrusters. The whole simulation ticks at a fixed 120 Hz regardless of your screen's frame rate, integrated with fourth-order Runge-Kutta, with quaternion orientation so there are no gimbal-lock singularities.

The renderer is a view of the telemetry stream. It never feeds anything back into the simulation.

**No plugins, no downloads, no account.** Open the page and fly.

---

## Table of contents

1.  [Quick start](#quick-start)
2.  [How to fly](#how-to-fly)
3.  [Features](#features)
4.  [Architecture and data flow](#architecture-and-data-flow)
5.  [Conventions](#conventions)
6.  [Flight model](#flight-model)
7.  [Flight safety: sanity checks and the watchdog](#flight-safety-sanity-checks-and-the-watchdog)
8.  [Telemetry](#telemetry)
9.  [Rendering](#rendering)
10. [Vehicle selection and gestures](#vehicle-selection-and-gestures)
11. [Hand tracking and countdown](#hand-tracking-and-countdown)
12. [Commentary engine](#commentary-engine)
13. [Launch parameters](#launch-parameters)
14. [Reference flight and validation](#reference-flight-and-validation)
15. [Project structure](#project-structure)
16. [Tuning constants](#tuning-constants)
17. [Changelog](#changelog)
18. [Known limitations](#known-limitations)
19. [Sponsorship](#sponsorship)
20. [License](#license)

---

## Quick start

```bash
git clone https://github.com/AnonymousSingh-007/Kalam.git
cd Kalam
npm install
npm run dev
```

Open `http://localhost:5173` and allow webcam access when prompted. A production build is a static bundle:

```bash
npm run build      # outputs dist/
npm run preview
```

> **Requirements:** Node 18+, a modern browser with WebGL 2, and a webcam for gesture control (keyboard works without one).

---

## How to fly

| Step | What to do |
|------|-----------|
| **1. Choose a vehicle** | Swipe an open hand sideways to browse, then clap (or press Enter) to confirm. |
| **2. Count down** | Hold up 5 fingers, wait for it to register, then 4, 3, 2, 1, fist. Each digit must be held for about 0.5 s. |
| **3. Set parameters** | Adjust thrust, mass, fuel and drag once armed. Watch thrust-to-weight and burn time update live. Launch is blocked below TWR 1; above ~15 you'll get a safety warning first. |
| **4. Launch** | Press the Launch button. |
| **5. Steer** | Hold left/right arrow (or raise your left/right hand) to pitch. Release to hold attitude. ~6 s of held input flips the vehicle 180 degrees. |
| **6. Throttle** | Hold up/down arrow to ramp throttle toward 100% or 0% over ~2 s. |
| **7. Observe** | Watch the instruments, listen to mission-control commentary, and compare your flight against the reference data — then change parameters and fly again. |

> If the control loop loses authority (most likely at extreme thrust-to-weight), the watchdog terminates the flight automatically — thrust cuts, the main chute deploys, and a banner tells you why.

---

## Features

### Interaction

- **Gesture-driven pre-launch.** In-browser hand landmark detection (MediaPipe) drives vehicle selection (swipe to browse, clap to confirm) and the countdown state machine (5-4-3-2-1-fist). Keyboard and on-screen controls work as fallbacks.
- **In-flight gesture pitch control.** Raise your left or right hand to command the same pitch rate as the arrow keys. Keyboard takes priority when both are active.
- **Manual throttle.** Up/down arrow ramps a throttle lever from 0 to 100% over 2 s. Pulling throttle down extends burn time proportionally — it scales thrust and fuel consumption together. Full cutoff and re-ignition are possible while propellant remains.
- **Four selectable vehicles.** Procedurally generated launch vehicles in three quality tiers with automatic step-down on slow GPUs. Vehicles are cosmetic for now — they share one flight model.

### Physics

- **Full 6-DOF rigid-body dynamics.** 13-scalar state vector (position, velocity, orientation quaternion, body-frame angular velocity) integrated with RK4 at a fixed 120 Hz in sub-steps of at most 5 ms. Pitch, yaw and roll are all independently modelled with real gyroscopic coupling.
- **Spherical gravity.** True inverse-square gravity toward a planet centre at Earth's real radius, resolved in all three dimensions.
- **ISA 1976 atmosphere.** Seven layers, chained base pressures, density from the ideal-gas law, geopotential altitude, with altitude wind profile and mean-reverting gusts.
- **Full-angle, full-3D aerodynamics.** Normal force valid from 0 to 180 degrees angle of attack, resolved independently into pitch and yaw planes. Mach-dependent axial drag, fin compressibility correction, cross-flow term, pitch/yaw damping.
- **Altitude-compensated propulsion.** Vacuum thrust derived from sea-level thrust, nozzle exit area implied by the ratio, ignition ramp, tail-off, jet damping. Thrust direction follows a 2-axis gimbal.
- **Moving mass properties.** CG and the full diagonal inertia tensor (separate pitch/yaw and roll inertia) recomputed every step from structure, propellant and cold-gas masses, including dI/dt terms.
- **Independent per-axis flight computer.** Rate-command, attitude-hold controller with dynamic inversion on each axis. Torque demand is shared between TVC, control fins and cold-gas RCS in proportion to each actuator's current authority. A finite cold-gas budget is shared across all three axes.
- **Recovery.** Drogue then main parachute with forces evaluated at the nose attachment point in full 3D, producing real swing damping. Flight-termination abort bypasses normal deployment gates.
- **Touchdown classification.** Impact speed, true 3D tilt and spin rate magnitude classify landing as `landed` or `crashed`.

### Rendering

- **True-scale planet.** Earth at its real 6,371 km radius with logarithmic depth buffer — a 3 m rocket and a 6,371 km planet share one depth range.
- **Procedural rocket models** with PBR materials, panel seams, exhaust soot, environment-mapped surfaces, and per-vehicle real-world scale (50 m to 120 m).
- **Launch complex.** Pad, support legs, flame deflector, hold-down arms, tower, scorch decal, dual-sided flame-trench shader, ground ignition cloud.
- **Plume expansion shader.** Shock-disc structure at sea level, widening to vacuum cone with altitude. Fresnel rim fade, flutter turbulence synced to simulation time.
- **Volumetric clouds.** Three layers (stratus, cumulus, cirrus) raymarched with exponential extinction, composited via log-depth-aware cloud pass.
- **Dynamic chase camera.** Log-ramped pullback with altitude, user-adjustable zoom via scroll wheel.
- **Post-processing.** Heat scintillation, bloom, chromatic aberration ramping with altitude.

### Safety and feedback

- **Pre-launch sanity check.** Flags extreme TWR, near-instant burns or degenerate geometry before launch — warns, doesn't block.
- **In-flight watchdog.** Stateless, deterministic checks for NaN, runaway angular rates, extreme Mach or altitude. Triggers automatic flight termination: engine cut + immediate chute deployment + post-abort angular rate decay.
- **Mission-control commentary.** Rule-based trigger engine with fixed, pre-written callouts read aloud via Web Speech API. Stage transitions queue; filler is dropped while speech is active; important events wait for a gap.
- **Live instruments.** Altitude, velocity, axial g, angle of attack, Mach, dynamic pressure, cold-gas remaining, nozzle deflection.

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
                                      FixedStepDriver.advance(engine, frameDt)
                                                     |
                                   accumulator drains at FIXED_DT = 1/120 s
                                                     |
                                engine.step(FIXED_DT)  (0 or more raw ticks)
                                                     |
                              +----------------------+----------------------+
                              |                                             |
                              v                                             v
                       raw ticks[]                           lerp(position) + SLERP(quat)
                  (watchdog, commentary,                      between the last two ticks
                   landing/crash detection)                               |
                              |                                            v
                              v                                  interpolated RenderSnapshot
                       checkWatchdog()                          (rocket pose + camera + exhaust
                       (abort if tripped)                        all read this one object)
                                                                            |
                                                                            v
                                                                    Scene (Three.js)
                                                                            |
                                                                            v
                                                                    instruments (HUD)
```

**Key design decisions:**

- `App.tsx` owns a single `requestAnimationFrame` loop. Physics is driven by `FixedStepDriver` (`renderInterp.ts`): wall-clock `frameDt` feeds an accumulator drained in fixed 1/120 s ticks, so the simulation advances at a constant rate independent of display frame rate.
- Backgrounded or throttled tabs cannot produce a burst of catch-up ticks — `frameDt` is clamped, and a `visibilitychange` listener resets the baseline on resume.
- Raw physics ticks go to event-detection logic (watchdog, commentary, landing). The render driver builds one interpolated `RenderSnapshot` per paint: position is linearly interpolated, orientation is SLERPed on the raw quaternion (not on decomposed Euler angles, which avoids wrong-way-around artifacts near wraps).
- The engine is a plain TypeScript class with no DOM, React or Three.js dependency. `vec3.ts` and `quat.ts` are small hand-rolled math primitives so the physics module stays headless.
- Telemetry is the only contract between the engine and everything else. Internal state stays in full double precision; values are rounded only when `snapshot()` is taken.

---

## Conventions

| Item | Convention |
|------|-----------|
| **Frame** | Local launch-site tangent frame, inertial, origin at the pad. +Y up, +Z north, +X east. Not rotating (Earth's rotation is not modelled). |
| **Body axes** | +Y_body nose-first (thrust/symmetry axis), +X_body pitch-plane normal, +Z_body yaw-plane normal. |
| **Orientation** | Quaternion `[x, y, z, w]` (Hamilton convention) rotating body frame into local frame — same layout as Three.js. |
| **Pitch angle** | From vertical, clockwise positive (nose right = positive). Legacy sign preserved from the pre-6-DOF model. |
| **Yaw / Roll** | Analogous constructions in their respective planes. |
| **Angular velocity** | Body-frame `[wx, wy, wz]` rad/s, right-hand convention. Telemetry maps: `angularVelocity = -wz` (pitch), `yawRate = wx`, `rollRate = wy`. |
| **Stations** | From the nose, aft positive. |
| **Gimbal / Fin** | `(pitch, yaw)`, independently rate/lag/travel limited, nose-right-positive sign on both axes. |
| **Angle of attack** | Total 3D angle between body +Y and air-relative velocity, decomposed into pitch-plane and yaw-plane components. 0-180 degrees; 180 = tail-first. |
| **G-loads** | Specific force (accelerometer reading); gravity excluded. |

Arrow keys map to the same sign as `bodyAngle`: right arrow = +1 (nose right), left arrow = -1. Raised hand follows the user's own left/right, matching the keys exactly.

---

## Flight model

All physics lives in `src/physics/rocketPhysics.ts`, with math primitives in `src/physics/vec3.ts` and `src/physics/quat.ts`.

### State and integration

State vector, 13 scalars: `[px, py, pz, vx, vy, vz, qx, qy, qz, qw, wx, wy, wz]`.

`step(dt)` clamps dt to 0.1 s and divides it into `ceil(dt / 5 ms)` equal sub-steps. Each sub-step runs: engine state, mass properties, recovery logic, flight computer, gust update, RK4, quaternion renormalization, then ground and rail constraints.

Mass properties (including the full inertia tensor) are evaluated at the start and end of the sub-step and averaged, with dI/dt from the difference.

**Equations of motion:**

```
Translational (local inertial frame):
  dp/dt = v
  dv/dt = (F_thrust + F_aero + F_chute) / m  +  g(p)

Rotational (body frame):
  dq/dt = 0.5 * q ⊗ [omega, 0]
  I * dw/dt = tau_thrust + tau_aero + tau_damp + tau_fin + tau_rcs + tau_jet
              - w × (I * w)
```

`I` is diagonal `diag(Ixx, Iyy, Izz)` with `Ixx = Izz` (axisymmetry) and a separate, smaller roll inertia `Iyy`. The gyroscopic term `w × (I*w)` produces real precession when roll and pitch/yaw coexist.

Quaternion is renormalized to the unit sphere after every RK4 sub-step. With zero yaw/roll input, the 6-DOF engine collapses to the original planar 3-DOF model to within integration tolerance.

### Atmosphere

ISA 1976 with seven layers (base geopotential heights 0, 11, 20, 32, 47, 51, 71 km). Base pressures chained from sea level. Geometric-to-geopotential conversion with r0 = 6,356,766 m. Above 84.852 km: isothermal with exponential pressure decay. Density: `rho = p / (R_air * T)`, speed of sound: `a = sqrt(gamma * R_air * T)`.

### Gravity

True inverse-square toward planet centre at `(0, -R_earth, 0)`:

```
g(p) = -G0 * (R_earth / r)^2 * (p - center) / r
```

Correctly tilts gravity toward the true centre as the vehicle moves laterally or out-of-plane.

### Wind

Tabulated altitude profile (11 nodes, 0 to 86 km, peaking near 11 km) multiplied by a random per-launch surface scale of 2-6 m/s with random sign, applied along local +X. Gusts follow a mean-reverting Ornstein-Uhlenbeck process with 3 s time constant.

### Geometry

Everything derives from the user's reference area A:

```
D = sqrt(4A / pi)         body diameter
L = 12D                   body length
nose = 3D                 ogive
4 swept fins: root 2.0D, tip 0.5D, span 0.8D, sweep 1.1D
```

### Aerodynamics

- **Total angle of attack** decomposed into `alphaPitch` and `alphaYaw` for independent force resolution.
- **Axial force** with Mach drag-rise table and power-on base-drag relief. Separate tail-first coefficient (0.95).
- **Normal force**, valid 0-180 degrees:

```
Fn_nose  = q A CN_nose         * sin(alpha) |cos(alpha)|
Fn_fins  = q A CN_fin * k(M)  * sin(alpha) |cos(alpha)|
Fn_cross = q A_planform * 1.1  * sin(alpha) |sin(alpha)|
```

- **Fin compressibility** `k(M)`: Prandtl-Glauert below Mach 0.8, constant through transonic, supersonic `0.663/sqrt(M^2 - 1)`.
- **Torque** from each component at its own station about the instantaneous CG.
- **Pitch/yaw damping** per axis: `tau = -q A (CN_nose * dn^2 + CN_fin * k * df^2) / max(V, 5) * rate`.
- **No passive roll torque** — fins are lumped, not individually modelled.
- **Static margin** `(x_cp - x_cg) / D`, evaluated with Mach-dependent fin factor.

### Propulsion

```
F_vac  = F_sl * (311 / 282)
A_exit = (F_vac - F_sl) / P_sl
F      = f * F_vac - p_ambient * A_exit     altitude-compensated
mdot   = f * burnRate
```

`f` is ignition ramp * tail-off * manual throttle lever. Thrust direction is body +Y deflected by the gimbal, rotated into the local frame. Torque is a true 3D cross product at the nozzle station. Jet damping: `-mdot * (L - x_cg)^2 * rate` per axis.

### Mass properties

Three lumps with individual stations:

| Lump | Station | Pitch/yaw inertia | Roll inertia |
|------|---------|-------------------|-------------|
| **Structure** (dryMass - coldGas) | 0.62 L | Uniform rod | 0.5 m (D/2)^2 |
| **Propellant** (decreasing) | 0.45 L | Cylinder, length 0.4 L, radius 0.4 D | 0.5 m tankR^2 |
| **Cold gas** (carved from dry mass) | 0.12 L | Point mass | 0.5 m (0.15 D)^2 |

CG moves aft as propellant burns, reducing static margin. Pitch/yaw inertia via parallel-axis theorem; roll inertia is a separate, much smaller sum.

### Flight computer

Rate-command, attitude-hold controller with dynamic inversion, applied independently on each axis:

1. **Command.** Key held: demanded rate = ±30 deg/s, attitude target tracks current (leading by 0.3 s × rate). On release: outer loop holds attitude with `rateCmd = clamp(1.8 * wrap(hold - attitude), ±30 deg/s)`.
2. **Torque demand.** `tauNeed = I * 6 * (rateCmd - rate) - tauPassive` on pitch/yaw; `tauNeed = Iyy * 6 * (rateCmd - rate)` on roll. The feedforward term cancels the airframe's own stiffness.
3. **Allocation (pitch/yaw).** Two actuators share demand in proportion to current authority:

```
tvc_authority = T * (L - x_cg) * sin(gimbal_max)
fin_authority = q * A * CN_fin * k(M) * 0.75 * (x_fin - x_cg) * fin_max
```

4. **Cold gas.** Residual demand goes to 3-axis cold-gas couple, capped at 30 deg/s^2 × current inertia, with 4% deadband. All three axes share one finite budget.
5. **Actuators.** Gimbal: ±6 deg, 25 deg/s, 0.05 s lag. Fins: ±15 deg, 80 deg/s, 0.03 s lag.

A raw mode (`setAssist(false)`) maps keys directly to gimbal/fin/RCS without attitude hold.

### Recovery

- **Drogue:** deploys after burnout, descending, above 20 m, q < 800 Pa. Area = 2.5% of main canopy.
- **Main:** deploys below 350 m, descending, q < 1,500 Pa. Canopy sized for 5.5 m/s terminal at dry mass.
- Inflation follows smoothstep over 2 s. Force acts at nose with full 3D attachment-point velocity for real swing damping.
- Flight-termination abort bypasses all gates and forces immediate main deployment.

### Ground, rail and landing

- **Rail:** until py >= L, the vehicle is constrained vertical and non-rotating. Hold-down releases when thrust exceeds weight.
- **Touchdown:** py <= 0 with vy <= 0 after rail clearance. Landed if impact <= 9 m/s, tilt <= 30 deg, spin <= 45 deg/s; otherwise crashed.
- **Stages:** `pre-launch -> powered-ascent -> coast -> apogee -> descent`.

---

## Flight safety: sanity checks and the watchdog

Two independent, purely local safety layers — no external service, no model, just deterministic checks.

### Pre-launch: `flightSanity.ts`

Flags configurations outside the tuned envelope:

| Check | Threshold | Why |
|-------|-----------|-----|
| TWR too high | > 15:1 | Actuators saturate chasing targets that outrun their rate limits |
| Burn too short | < 50 ms | Ignition ramp barely engages before burnout |
| Degenerate geometry | A < 0.001 m^2 | Derived body geometry becomes nonsensical |

Shows a confirmation dialog listing specific warnings — a heads-up, not a hard block.

### In-flight: `flightWatchdog.ts`

Stateless pure function, one telemetry snapshot in, one verdict out:

| Check | Threshold |
|-------|-----------|
| Non-finite state | Any NaN or Infinity |
| Angular rate (per axis) | > 2,000 deg/s |
| Angular rate (combined) | > 3,000 deg/s |
| Mach | > 500 |
| Altitude | > 5,000 km |

When tripped, `engine.abort()` cuts thrust (via normal tail-off), forces main chute, and applies exponential angular-rate decay (tau = 0.4 s) so tumble visibly winds down regardless of altitude.

### RCS torque authority scaling

Cold-gas torque authority is recomputed every sub-step from the vehicle's current inertia, not frozen at launch. Without this, the same torque applied to a nearly-dry vehicle (inertia potentially 100x smaller than at launch) would spin it to thousands of degrees per second.

---

## Telemetry

`Telemetry` (see `src/types.ts`) is the single shape published each step.

| Group | Fields |
|-------|--------|
| **Flight state** | `time`, `altitude`, `velocity`, `acceleration`, `mass`, `stage`, `lateralOffset`, `lateralVelocity`, `positionZ`, `velocityZ`, `maxAltitude`, `airspeed`, `flightPathAngle` |
| **Pitch** | `bodyAngle`, `angularVelocity`, `gimbalAngle`, `finAngle` |
| **Yaw** | `yawAngle`, `yawRate`, `gimbalYawAngle`, `finYawAngle` |
| **Roll** | `rollAngle`, `rollRate` |
| **Combined** | `angleOfAttack` (0-180, total 3D) |
| **Aero / Propulsion** | `dynamicPressure`, `machNumber`, `thrustNewtons`, `throttle`, `isp`, `twr`, `maxQ`, `maxMach`, `propellantRemaining`, `cdAxial` |
| **Loads** | `axialGLoad`, `lateralGLoad` (specific force, in g) |
| **Flight computer** | `pitchRateCommand`, `attitudeTarget`, `gimbalCommand`, `rcsFuel`, `rcsTorque`, `rcsTorqueYaw`, `rcsTorqueRoll` |
| **Vehicle** | `staticMargin`, `centerOfGravity`, `centerOfPressure`, `momentOfInertia`, `bodyLength` |
| **Environment** | `airDensity`, `airPressure`, `airTemperature`, `speedOfSound`, `windSpeed` |
| **Recovery** | `chuteState` (0 stowed, 1 deployed), `outcome` (`flying` / `landed` / `crashed`), `impactSpeed` |

---

## Rendering

The renderer reads the interpolated `RenderSnapshot` ref each frame. It contains no physics.

- **Scale.** `ALTITUDE_SCALE = 0.05` — one scene unit = 20 m. Planet, sky, camera far plane all at true scale; launch pad at cinematic scale for legibility.
- **Logarithmic depth buffer.** Resolves 0.1 to 800,000 scene units without z-fighting. Cloud pass decodes depth accordingly.
- **Pose.** Model origin at engine base; physics state describes CG. Ground clamp prevents sinking.
- **Camera.** Dynamic chase with base offset `(4, 3.5, 16)`, scaled by `(1 + log1p(altKm * 0.5) * 2.5) * userZoom`. Zoom: scroll wheel, clamped 0.15-6x.
- **Rocket models.** Four vehicles from `buildRocket.ts`. Lathe-revolved profiles, bevelled fin extrusions, instanced rivets. All static parts merged into one mesh per material (~9 draw calls). PBR + environment map + ACES filmic tone mapping.
- **Quality tiers.** Low: 36 draws / 20k tris. Medium: 36 / 33k. High: 40 / 82k. Auto-downgrade if average frame time exceeds ~33 ms over 90 frames.
- **Launch complex.** Textured pad, support legs, flame deflector, hold-down arms, tower, scorch decal, flame-trench shader, ground ignition cloud.
- **Plume.** Shader cone with expansion factor `1 - exp(-altitude / 8500)`. Parented to the nozzle group (inherits gimbal tilt automatically). Marked `frustumCulled = false`. Exhaust particles travel opposite to body axis and are never re-anchored to the rocket after spawn.
- **Planet.** Two meshes: coarse globe (256 x 128) for orbital views + high-resolution near patch (160 x 160, 20 km radius) projected onto the sphere in the vertex shader. Five-octave noise colouring. Cloud patches fade in on the globe. Atmosphere shell (80 km) for limb glow.
- **Sky.** Three-stop gradient dome (600,000 unit radius). 2,000 stars fade in between 5-15 km.
- **Volumetric clouds.** Three layers raymarched against gradient and cellular noise, exponential extinction, log-depth compositing.
- **Post-processing.** Heat scintillation (peaks ~1,200 m, 8.5 km scale height), bloom, chromatic aberration (6-15 km ramp).

---

## Vehicle selection and gestures

After the camera starts, the state machine enters `selecting`: the chosen vehicle turns slowly under a framing camera.

| Input | Action |
|-------|--------|
| Open hand moved sideways | Next / previous vehicle |
| Clap (two hands) | Confirm and start countdown |
| Left / right arrow, Enter | Previous / next, confirm |
| On-screen controls | Same, for mouse and touch |

**Swipe detection:** one hand, four+ fingers extended, palm travels >= 0.25 image width in 450 ms with limited vertical drift. 700 ms cooldown.

**Clap detection:** two hands, palm distance / mean hand size falls below 1.6 after exceeding 3.0 within 500 ms. Handles lost palms on overlap. 1.2 s cooldown.

### In-flight raised-hand pitch control

| Input | Action |
|-------|--------|
| Raise right hand | Pitch right (+1) |
| Raise left hand | Pitch left (-1) |
| Both or neither | No input (0) |

Per-frame level check (not edge-triggered). Handedness is read inverted from MediaPipe's label to correct for the CSS-mirrored preview. Keyboard always takes priority over gesture.

---

## Hand tracking and countdown

- **Detection:** in-browser MediaPipe landmark detection with GPU delegate, two hands. 21 landmarks per hand with handedness and confidence.
- **Finger count:** joint-angle heuristic per finger; thumb uses handedness-agnostic distance check. Returns 0-5 or null.
- **State machine:**

```
idle -> selecting -> counting(expected, heldFrames) -> armed -> launched
```

Each digit held ~0.5 s before advancing.

---

## Commentary engine

- 12 trigger types: countdown, pre-launch, ignition, max-q, burnout, coast, apogee, descent, landed, high-g, high-aoa, fast-descent.
- Fixed, pre-written mission-control-style callouts — no live telemetry values in the text.
- 12-entry no-repeat ring buffer.
- `tick()` returns `{ text, important }`. Important events (stage transitions, max-Q, threshold crossings) are held in a one-slot pending queue while speech is active; filler is dropped.
- Web Speech API: rate 1.05, pitch 0.9. Lines queue rather than interrupt. Flight-termination is the one exception that interrupts immediately.

---

## Launch parameters

| Parameter | Unit | Meaning |
|-----------|------|---------|
| `thrust` | N | Sea-level thrust |
| `dryMass` | kg | Structure, engine and cold-gas tank |
| `propellantMass` | kg | Propellant at ignition |
| `burnRate` | kg/s | Mass flow at full throttle |
| `dragCoefficient` | — | Subsonic axial Cd; Mach curve scales from it |
| `crossSectionArea` | m^2 | Reference area; sets diameter, length, fins, inertia |

Derived values shown live: thrust-to-weight, burn duration, Isp.

---

## Reference flight and validation

**Reference vehicle:** thrust 2,200 N, dry mass 15 kg, propellant 20 kg, burn rate 1.2 kg/s, Cd 0.5, area 0.05 m^2.

| Quantity | Value |
|----------|-------|
| Isp (sea level / vacuum) | 187 s / ~206 s |
| Diameter / length | 0.252 m / 3.02 m |
| Burn time | ~17 s |
| Peak Mach | ~1.1 |
| Apogee | ~6.1 km |
| Max dynamic pressure | ~53 kPa |
| Descent | Soft touchdown at ~6 m/s after ~250 s |

**Validation tests performed headlessly:**

- **Step-size convergence:** 30 Hz to 1 kHz changes apogee by 1.7 m out of 6,100 m.
- **Impulse bracket:** delivered impulse sits between ideal sea-level and vacuum values.
- **ISA spot checks:** layer base pressures chained so pressure is continuous by construction.
- **6-DOF collapse test:** with zero yaw/roll, 6-DOF apogee = 6,102 m vs. original 3-DOF = 6,100 m.
- **Yaw symmetry:** constant yaw-gimbal input produces mirror-image drift in both directions.
- **Gyroscopic coupling:** roll + pitch input produces measurable induced yaw rate, confirming `w × (I*w)` is real.
- **Left/right pitch symmetry:** mirrored runs agree to within gust noise.
- **Controllability:** 180 degrees in ~5.5-7.3 s across five parameter sets.
- **Stability across configurations:** all nominal flights land softly; aggressive maneuvering crashes as expected.
- **Cold-gas-only pitch:** 30 deg/s achieved using ~0.07 kg of gas at low dynamic pressure.
- **Parachute swing:** pendulum settles in ~4 s.
- **Watchdog verification:** runaway at TWR ~190 caught at t=3.03 s, thrust cut, main chute deployed, rate decayed.
- **Fix #3 stability (headless harness):** controller stable under wind disturbance, 2-degree and 10-degree pitch perturbations (2000 steps each, no divergence).

---

## Project structure

```
src/
├── App.tsx                     # Main loop: webcam -> hand -> physics -> watchdog -> render -> commentary
├── types.ts                    # Shared types: hand, countdown, vehicles, params, telemetry, commentary
├── flightSanity.ts             # Pre-launch sanity check
├── flightWatchdog.ts           # In-flight runaway detection
├── renderInterp.ts             # Fixed-step accumulator + lerp/SLERP interpolation
│
├── physics/
│   ├── rocketPhysics.ts        # 6-DOF engine: atmosphere, gravity, aero, propulsion, mass, controller, recovery
│   ├── vec3.ts                 # Dependency-free 3D vector math
│   └── quat.ts                 # Dependency-free quaternion math
│
├── constants/
│   ├── scale.ts                # Altitude scale, Earth radius
│   ├── frames.ts               # Coordinate frame types
│   ├── earthRotation.ts        # Earth angular velocity (stub)
│   └── launchSite.ts           # Launch site position
│
├── hand/
│   ├── handTracker.ts          # MediaPipe hand landmark detector
│   ├── fingerCount.ts          # Joint-angle finger counting
│   └── gestures.ts             # Swipe, clap (pre-launch); raised-hand pitch (in-flight)
│
├── state/
│   └── countdownMachine.ts     # idle -> selecting -> counting -> armed -> launched
│
├── render/
│   ├── Scene.tsx               # Three.js scene, shaders, camera, post-processing
│   ├── buildRocket.ts          # Procedural vehicle models at realistic scale
│   ├── buildGround.ts          # True-scale planet with near patch
│   ├── buildSun.ts             # Sun disc
│   └── CloudPass.ts            # Volumetric cloud post-process
│
├── commentary/
│   ├── commentaryEngine.ts     # Trigger logic
│   └── lines.ts                # Mission-control callout bank
│
└── ui/
    ├── VehicleSelect.tsx        # Vehicle picker overlay
    ├── VehicleSelect.css
    ├── ParamPanel.tsx           # Launch parameter inputs
    └── InstrumentPanel.tsx      # Live flight gauges
```

---

## Tuning constants

Values live at the top of `rocketPhysics.ts` unless noted otherwise.

<details>
<summary>Click to expand full constant table</summary>

| Constant | Value | Role |
|----------|-------|------|
| `FINENESS` | 12 | Length / diameter |
| `NOSE_LEN_D` | 3.0 | Nose length in diameters |
| `FIN_ROOT_D` / `TIP` / `SPAN` / `SWEEP` | 2.0 / 0.5 / 0.8 / 1.1 | Fin planform in diameters |
| `CNA_NOSE` | 2.0 /rad | Nose normal-force slope |
| `CD_CROSS` | 1.1 | Cross-flow drag coefficient |
| `CA_REAR` | 0.95 | Tail-first axial coefficient |
| `BASE_RELIEF` | 0.12 | Power-on base-drag reduction |
| `ISP_VAC_RATIO` | 311/282 | Vacuum-to-sea-level thrust ratio |
| `IGN_TIME` / `IGN_FLOOR` / `TAILOFF` | 0.6 s / 0.1 / 0.25 s | Ignition ramp and tail-off |
| `GIMBAL_MAX` / `RATE` / `TAU` | 6 deg / 25 deg/s / 0.05 s | TVC actuator |
| `FIN_CTRL_MAX` / `RATE` / `TAU` / `EFF` | 15 deg / 80 deg/s / 0.03 s / 0.75 | Control-fin actuator |
| `OMEGA_MAX` | 30 deg/s | Max commanded rate per axis |
| `THROTTLE_RATE` | 0.5 /s | Lever rate (2 s full sweep) |
| `K_THETA` / `K_OMEGA` | 1.8 / 6.0 | Attitude-hold / rate loop gains |
| `RCS_ACCEL` / `DEADBAND` / `ISP_COLD` | 30 deg/s^2 / 4% / 65 s | Cold-gas couple |
| `POST_ABORT_RATE_TAU` | 0.4 s | Post-termination rate decay |
| `STRUCT_CG` / `PROP_CG` / `PROP_LEN` / `RCS_TANK` / `RCS_ARM` | 0.62 / 0.45 / 0.40 / 0.12 / 0.60 | Mass stations (fraction of L) |
| `GUST_TAU` | 3.0 s | Gust correlation time |
| `MAX_SUB_DT` | 1/200 s | Max integrator sub-step |
| `CD_CHUTE` / `INFLATE` / `DROGUE_FRAC` | 1.5 / 2.0 s / 0.025 | Parachute |
| `CHUTE_Q_MAX` / `MAIN_ALT` / `MAIN_Q_MAX` | 800 Pa / 350 m / 1,500 Pa | Deployment gates |
| `LAND_V_MAX` / `TILT_MAX` / `SPIN_MAX` | 9 m/s / 30 deg / 45 deg/s | Landed vs. crashed |
| `TWR_WARN` | 15 | Pre-launch warning threshold |
| `MAX_SANE_RATE` / `ANGVEL_SUM` | 2,000 / 3,000 deg/s | Watchdog angular-rate thresholds |
| `MAX_SANE_MACH` / `ALTITUDE` | 500 / 5,000 km | Watchdog Mach / altitude thresholds |

</details>

---

## Changelog

### Rendering pipeline fixes

- **Logarithmic depth buffer.** Enabled `logarithmicDepthBuffer: true` on the WebGL renderer, eliminating z-fighting between the rocket and the true-scale planet. `CloudPass` updated to decode log depth correctly.
- **Stale telemetry elimination.** Unified physics and rendering into a single `requestAnimationFrame` loop driven by `FixedStepDriver`, replacing two unsynchronised RAF callbacks that read a shared mutable ref with no ordering guarantee. Render pose is now interpolated (position lerp + quaternion SLERP) from the last two physics ticks.
- **Planet-centre type fix.** Corrected the `PLANET_CENTER` constant in `frames.ts` from a type-assertion on the wrong frame to a properly typed `LaunchSitePos` value.

### Plume and launch complex overhaul

- **Plume parenting.** Plume mesh re-parented from a standalone scene object (manually synced every frame) to the nozzle group, inheriting gimbal tilt and vehicle scale through the Three.js matrix stack automatically.
- **Frustum culling fix.** Plume marked `frustumCulled = false` to prevent incorrect culling when scale and position change every frame.
- **Exhaust particle independence.** Particles spawned at the nozzle store their own world-space position and velocity, never re-anchoring to the rocket after spawn — they follow the rocket through a flip and then continue on their own trajectory.
- **Launch complex.** Added pad, support legs, flame deflector, hold-down arms, tower, scorch decal, dual-sided flame-trench shader, and ground ignition cloud.
- **Smoke visibility.** Ground-level smoke and ignition effects tuned for visibility against the planet surface.

### Physics engine fixes

- **Fix #1: RCS torque authority staleness.** Cold-gas torque clamp now recomputed every sub-step from the vehicle's current inertia instead of using the frozen launch-time value. Prevents the same torque from producing catastrophically large angular accelerations on a nearly-dry vehicle.
- **Fix #2: Unused yaw/roll command fields.** Removed dead `yawCommand` and `rollCommand` fields that were shadowing the actual control path.
- **Fix #3: TVC allocator `tauGim` sign.** The `allocate()` closure's bookkeeping variable `tauGim` was computed with the wrong sign (`T * sin(gim) * arm` instead of `-T * sin(gim) * arm`). This caused the feedforward term (`tauPassive`) and RCS residual calculation to receive incorrect torque information. Verified stable under wind disturbance, 2-degree and 10-degree pitch perturbations in a headless reproduction harness (2000 integration steps each, no divergence). Full torque sign chain confirmed: pitch error → negative rate command → negative torque demand → negative gimbal → positive corrective torque → error reduction.

---

## Known limitations

- **Yaw and roll have no UI input yet.** `setYawInput`/`setRollInput` are live on the engine, but arrow-key handling only drives pitch. Wiring a gamepad or second axis is a UI-only task.
- **Render pose is pitch-only.** `Scene.tsx` applies `bodyAngle` but not `yawAngle` or `rollAngle` to the model. Intentional seam until the control UI exists.
- **No passive roll torque.** Fins are lumped, so there is no roll restoring or damping moment. Roll control is cold-gas only, matching real single-engine vehicles.
- **No Earth rotation.** The local frame is inertial but stationary — no Coriolis effect or eastward velocity boost.
- **Spherical planet.** WGS84 ellipsoid not implemented.
- **No structural failure.** Loads are reported but nothing breaks.
- **Random wind sign per launch.** Two otherwise identical launches can drift differently.
- **Constant Mach-dependent nose slope.** Only fins carry the compressibility correction.
- **Vehicles are cosmetic.** All four share one flight model. Fin geometry on the model does not match the physics.
- **Gesture thresholds need per-camera tuning.** Swipe direction depends on the camera not being mirrored in the raw feed.
- **Control fins not animated** on the 3D model (reported in telemetry only).
- **Pitch input commands rate, not translation.** Matching real gravity-turn behaviour, not arcade-style strafe.
- **Launch parameters not clamped** to per-vehicle or physically plausible ranges.

---

## Sponsorship

Kalam is an independent, open-source project built and maintained in spare time. Sponsorship lets the next stages happen faster and stay free for everyone.

### What sponsorship funds

- **Yaw and roll control UI** — wiring the existing physics API to gamepad, keyboard and render pose.
- **Vehicle-specific physics** — per-vehicle mass, staging, boosters, engine clusters, throttle profiles.
- **Structural failure model** — load limits, breakup, debris.
- **Orbital mechanics** — Earth rotation, Coriolis effects, downrange tracking.
- **Higher-fidelity rendering** — cloud and plume improvements, path-traced preview, animated control fins, per-vehicle launch pads.
- **Hosting and distribution** — keeping the demo online and fast.
- **Calibration and accessibility** — testing gesture detection across cameras, lighting and skin tones; touch and keyboard parity; low-power mode.
- **Education** — lesson plans, guided "why did my rocket flip?" mode, classroom documentation.

### Tiers

| Tier | For | You get |
|------|-----|---------|
| **Supporter** | Individuals | Name in credits, early access |
| **Builder** | Clubs, small teams | Above + roadmap input + logo in README |
| **Launch Partner** | Companies, institutions | Above + named vehicle livery or launch-pad branding + co-written write-up |
| **In-kind** | Anyone | Cloud credits, hosting, GPUs, devices, expert physics review |

Sponsors never get control over the physics or the code. Branding is clearly labelled and user-optional.

### Research and academic collaboration

The flight model is open for inspection and validation scripts are reproducible. Universities, labs and student chapters interested in using Kalam for teaching, or in extending the dynamics, are welcome to get in touch about collaboration, co-authorship and shared datasets.

### How to get involved

Open an issue or discussion titled "Sponsorship", or use the sponsor button when it is enabled. Contributions of code, bug reports and validation data are equally valuable and need no tier.

---

## License

Apache 2.0. See [LICENSE](LICENSE).