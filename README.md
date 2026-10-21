# Kalam

An interactive rocket-launch simulator driven by hand gestures, a planar rigid-body flight model, and rule-based spoken commentary. You arm the launch by counting down from 5 to 0 with your hand, configure the vehicle, then fly it: hold the arrow keys to command pitch rate and the flight computer allocates the torque between thrust vectoring, aerodynamic control fins and cold-gas thrusters. Everything runs in the browser.

Physics comes first. The renderer is a view of the telemetry stream; it never feeds anything back into the simulation.

---

## Contents

1. [Features](#features)
2. [Architecture and data flow](#architecture-and-data-flow)
3. [Conventions](#conventions)
4. [Flight model](#flight-model)
5. [Telemetry](#telemetry)
6. [Rendering](#rendering)
7. [Vehicle selection and gestures](#vehicle-selection-and-gestures)
8. [Hand tracking and countdown](#hand-tracking-and-countdown)
9. [Commentary engine](#commentary-engine)
10. [Launch parameters](#launch-parameters)
11. [Reference flight and validation](#reference-flight-and-validation)
12. [Known limitations](#known-limitations)
13. [Setup](#setup)
14. [How to fly](#how-to-fly)
15. [Project structure](#project-structure)
16. [Tuning constants](#tuning-constants)
17. [Sponsorship](#sponsorship)
18. [License](#license)

---

## Features

- **Gesture-driven pre-launch.** In-browser hand landmark detection drives the whole pre-flight sequence: swipe to browse vehicles, clap to confirm, then a finger count (5, 4, 3, 2, 1, fist) steps the state machine `idle -> selecting -> counting -> armed -> launched`. No buttons are needed (keyboard and on-screen controls are available as fallbacks).
- **Four selectable vehicles.** Four original, fully procedural launch-vehicle models (no image or model files) with panel seams, soot and clearcoat, built in three quality tiers with automatic step-down on slow GPUs. Vehicles are cosmetic for now: they share one flight model.
- **Planar 3-DOF rigid-body physics.** State is `(x, y, vx, vy, theta, omega)`, integrated with RK4 in sub-steps of at most 5 ms.
- **ISA 1976 atmosphere** (seven layers, chained base pressures, density from the ideal-gas law, geopotential altitude) with an altitude wind profile and mean-reverting gusts. Aerodynamics use air-relative velocity.
- **Geometry derived from the launch parameters.** Reference area sets diameter and length; nose, fins, centre of gravity (CG), centre of pressure (CP), inertia and static margin all follow from it.
- **Full-angle aerodynamics.** Normal force is valid from 0 to 180 degrees angle of attack, so tail-first flight is modelled and is naturally unstable. Mach-dependent axial drag, fin compressibility correction, cross-flow term, pitch damping.
- **Altitude-compensated propulsion.** `F = f * F_vac - p_ambient * A_exit`, mass flow from the burn rate, ignition ramp, tail-off, jet damping.
- **Moving mass properties.** CG and pitch inertia are recomputed every step from structure, propellant and cold-gas masses, including the `dI/dt` term in the rotational equation.
- **Three-actuator flight computer.** Arrow keys command a pitch rate; on release the vehicle holds attitude. Demanded torque is shared between thrust vectoring and movable aerodynamic control fins in proportion to the authority each has at that instant; a finite cold-gas budget covers any remainder.
- **Recovery.** Drogue then main parachute, attached at the nose, with forces evaluated at the attachment-point velocity (this produces real swing damping). Deployment is gated by dynamic pressure and altitude.
- **Touchdown classification** by impact speed, tilt and spin rate: `landed` or `crashed`.
- **3D renderer.** Selectable procedural rocket model pivoted about its centre of gravity, launch complex, plume expansion shader, flame trench flow, heat shimmer, a true-scale (6,371 km radius) procedural planet with atmosphere rim, starfield, volumetric clouds, bloom, chromatic aberration.
- **True-scale planet.** The globe is rendered at Earth's real radius, with a logarithmic depth buffer so a 3 m rocket and a 6,371 km planet share one depth range without z-fighting. A dynamic chase camera pulls back with altitude (log-ramped, user-adjustable) so the globe's curvature becomes visible as the vehicle climbs.
- **Realistic per-vehicle scale.** Each of the four vehicles is scaled to a distinct real-world height (50 to 120 m) instead of sharing one arbitrary size, so they read as different classes of rocket against the true-scale planet.
- **User zoom control.** The scroll wheel adjusts a zoom multiplier on top of the automatic altitude pullback, so the view can be tightened or widened at any point in flight.
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
 launch parameters --> RocketPhysicsEngine.launch()
                                                     |
 arrow keys --> setGimbalInput(-1..+1) --> step(dt) --+--> Telemetry snapshot
                                                          |        |        |
                                                          v        v        v
                                                     instruments  Scene   commentary
                                                      (HUD)     (Three.js) (speech)
```

- `App.tsx` owns the loop. Each animation frame it runs hand detection, advances the countdown machine, passes the held arrow-key state to the engine, calls `engine.step(min(dt, 1/30))`, and publishes the resulting `Telemetry` object by ref (to the renderer) and by throttled React state (to the HUD, refreshed every 100 ms of wall-clock time so the final landed or crashed frame is never skipped).
- The engine is a plain TypeScript class with no DOM or React dependencies. It can be driven headlessly from a script for validation.
- Telemetry is the only contract between the engine and everything else. Values are rounded to 0.01 only when the snapshot is taken; internal state stays in full double precision.

---

## Conventions

| Item | Convention |
|---|---|
| Axes | +Y up, +X right, planar motion in the X-Y plane |
| Pitch angle `theta` | From vertical, **clockwise positive** (nose right = positive). Telemetry `bodyAngle` is wrapped to +/-180 degrees |
| Body axis | `b = (sin(theta), cos(theta))`, normal `n = (cos(theta), -sin(theta))` |
| Stations | Measured from the nose, aft positive |
| Torque | About the CG, clockwise positive. For a force `F` at station `x`: `tau = -(x - x_cg) * (F . n)` |
| Gimbal | Positive angle = nozzle swung right = nose-right torque |
| Control fin | Positive deflection = nose-right torque |
| Angle of attack | `alpha = wrap(theta - phi)` where `phi = atan2(v_rel_x, v_rel_y)` is the air-relative flight direction. Reported as `abs(alpha)` in 0..180 degrees; 180 degrees means tail-first |
| G-loads | Specific force (what an accelerometer reads); gravity is excluded |

The arrow keys map to the same sign as `theta`: right arrow is +1 (nose right), left arrow is -1 (nose left).

---

## Flight model

All of this lives in `src/physics/rocketPhysics.ts`.

### State and integration

- State vector `s = [x, y, vx, vy, theta, omega]`.
- `step(dt)` clamps `dt` to 0.1 s and divides it into `ceil(dt / 5 ms)` equal sub-steps. Each sub-step: engine state, mass properties, recovery logic, flight computer, gust update, RK4, ground and rail constraints.
- Mass properties are evaluated at the start and end of the sub-step and averaged for the RK4 stage, with `dI/dt` taken from the difference.
- Equations of motion (rotational part):

```
omega_dot = ( tau_aero + tau_damp + tau_jet + tau_chute      // passive
            + tau_thrust + tau_fin + tau_rcs                  // controlled
            - I_dot * omega ) / I
```

### Atmosphere

- ISA 1976 with seven layers (base geopotential heights 0, 11, 20, 32, 47, 51, 71 km). Base pressures are chained from sea level exactly, not tabulated.
- Geometric altitude is converted to geopotential altitude with `r0 = 6,356,766 m`. Above 84.852 km the layer is isothermal and pressure decays exponentially.
- Density is `rho = p / (R_air * T)`, speed of sound `a = sqrt(gamma * R_air * T)`.
- Spot checks: 11,019.03 m geometric gives 216.65 K and 22,632.17 Pa; 20,062.98 m geometric gives 5,475.00 Pa.
- Gravity varies with altitude: `g = g0 * (R_earth / (R_earth + y))^2`.

### Wind

- A tabulated profile (11 altitude nodes from 0 to 86 km, peaking at 7.2 times the surface scale near 11 km) is multiplied by a random per-launch surface scale of 2 to 6 m/s with a random sign.
- Gusts follow a mean-reverting (Ornstein-Uhlenbeck type) process with a 3 s time constant and `sigma = 0.1 * |wind(h)| + 0.25 m/s`.
- Wind enters the aerodynamics through the air-relative velocity `v_rel = v - wind`. It is deterministic given the random seed drawn at `launch()`.

### Geometry

Everything derives from the user's reference area `A`:

```
D = sqrt(4 A / pi)        body diameter
L = 12 D                  body length (fineness ratio 12)
nose length = 3 D         (ogive)
4 swept fins: root chord 2.0 D, tip chord 0.5 D, span 0.8 D, sweep 1.1 D
```

Fin normal-force slope is computed by component build-up from the planform (root and tip chord, span, mid-chord sweep length, body-interference factor). Nose slope is `CN_alpha = 2.0 per rad` (slender-body theory).

### Aerodynamics

- **Axial force.** `Fa = -q * A * Cd_axial * cos(alpha)`. For nose-first flow, `Cd_axial = Cd_user * cdRatio(Mach) * (1 - 0.12 * thrustFraction)`, where `cdRatio` is a Mach drag-rise table normalised to its subsonic value so the user's Cd scales the whole curve (subsonic 0.295, peak 0.55 at Mach 1.1 to 1.2, falling to 0.17 by Mach 10) and the 0.12 term is power-on base-drag relief. For tail-first flow the axial coefficient is a separate constant 0.95 (blunt base).
- **Normal force**, valid over the whole 0..180 degree range:

```
Fn_nose  = q A CN_nose            * sin(alpha) |cos(alpha)|
Fn_fins  = q A CN_fin * k(Mach)   * sin(alpha) |cos(alpha)|
Fn_cross = q A_planform * 1.1     * sin(alpha) |sin(alpha)|
```

  `k(Mach)` is the fin compressibility factor: `1/sqrt(1 - M^2)` below Mach 0.8, constant from 0.8 to 1.2, then a supersonic `0.663 / sqrt(M^2 - 1)` scaling. Fin lift therefore falls by roughly 2.5 times between Mach 1.2 and Mach 2, which moves the centre of pressure forward.
- **Torque.** Each normal-force component acts at its own station (nose at 0.466 nose lengths, fins at the planform centroid station, cross-flow at 0.55 L), giving `tau_aero` about the instantaneous CG.
- **Pitch damping.** `tau_damp = -q A (CN_nose dn^2 + CN_fin k df^2) * omega / max(V, 5)`, from the same station sums.
- **Stability.** Nose-first (`alpha = 0`) is the stable equilibrium whenever CP is aft of CG; tail-first (`alpha = 180`) is unstable, so a tail-first vehicle flips unless actively held. Nothing in the model is clamped to enforce this.
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
- Jet damping `tau_jet = -mdot * (L - x_cg)^2 * omega` models the angular-momentum drain of exhaust leaving the nozzle plane.
- Thrust acts at the nozzle (station `L`) along the body axis rotated by the gimbal angle.

### Mass properties

Three lumps, each with its own station:

| Lump | Mass | Station | Inertia |
|---|---|---|---|
| Structure | `dryMass - coldGas` | 0.62 L from the nose | uniform rod about its own CG |
| Propellant | `propellantMass`, decreasing | 0.45 L | cylinder, length 0.4 L, radius 0.4 D |
| Cold gas | `max(0.25 kg, 0.04 * dryMass)` | 0.12 L | point mass |

The cold-gas mass is carved out of the user's dry mass so total mass at ignition is exactly what the user entered. As propellant burns, the CG moves **aft**, which reduces static margin through the flight. CG and pitch inertia come from the parallel-axis theorem.

### Flight computer

The flight computer is a rate-command, attitude-hold controller with dynamic inversion.

1. **Command.** While a key is held, the demanded pitch rate is `+/-30 deg/s` and the attitude target tracks the current attitude (leading by `0.3 s * omega`). On release, the outer loop holds that attitude: `omega_cmd = clamp(1.8 * wrap(theta_hold - theta), +/-30 deg/s)`.
2. **Torque demand.** `tau_need = I * 6 * (omega_cmd - omega) - tau_passive`. The `- tau_passive` term feeds forward the exact passive aerodynamic, damping, jet and parachute torque, so the controller cancels the airframe's own stiffness instead of fighting it.
3. **Allocation.** Two actuators share the demand in proportion to the authority each has right now:

```
tvc_authority = T * (L - x_cg) * sin(gimbal_max)                       // zero when the engine is off
fin_authority = q * A * CN_fin * k(Mach) * 0.75 * (x_fin - x_cg) * fin_max   // zero with no airflow
```

   TVC dominates at low dynamic pressure and on the pad; the fins dominate in dense, fast air. Their combined authority is what lets the vehicle rotate against the airframe's own aerodynamic restoring torque at any launch time.
4. **Cold gas.** Any torque the two actuators cannot supply (saturation, engine off, thin air) goes to a cold-gas thruster couple, capped at `30 deg/s^2 * I`, with a 4 percent deadband. Gas use is `2 * F_thruster / (Isp_cold * g0) * dt`, with `Isp_cold = 65 s`; torque is scaled down as the tank empties.
5. **Actuators.** Both are first-order lag plus rate limit plus travel limit: gimbal +/-6 degrees, 25 deg/s, 0.05 s lag; control fins +/-15 degrees, 80 deg/s, 0.03 s lag. After parachute deployment the flight computer is disabled.

A raw mode (`setAssist(false)`) maps the key directly to gimbal and fin deflection without attitude hold.

### Recovery

- **Drogue**: deploys after burnout plus tail-off when descending, above 20 m, with dynamic pressure below 800 Pa. Area is 2.5 percent of the main canopy area.
- **Main**: deploys below 350 m while descending with dynamic pressure below 1,500 Pa. Canopy area is sized for a 5.5 m/s steady descent at dry mass: `A_main = 2 m_dry g0 / (rho0 * 1.5 * 5.5^2)`.
- Inflation follows a smoothstep over 2 s. The canopy force acts at the **nose** and uses the velocity of the attachment point (`v + omega x r`), so a swinging vehicle experiences real damping. The attachment lever produces `tau_chute`.

### Ground, rail and landing

- **Rail.** Until `y >= L`, position, lateral velocity, pitch and pitch rate are constrained to zero (the vehicle is guided). The hold-down keeps it on the pad until thrust exceeds weight.
- **Touchdown** is detected when `y <= 0` with `vy <= 0` after lift-off and rail clearance. Classification: `landed` if impact speed is at most 9 m/s, tilt at most 30 degrees and spin at most 45 deg/s; otherwise `crashed`. After touchdown the state is frozen and `outcome` and `impactSpeed` are reported.
- The flight stage after touchdown stays `descent`; the application watches `outcome`.

### Stages

`pre-launch -> powered-ascent -> coast -> apogee -> descent`. Powered ascent persists while propellant remains or thrust is above zero; coast needs `vy > 0.5 m/s`; apogee is declared within 0.5 m/s of the maximum altitude; anything else after lift-off is descent.

---

## Telemetry

`Telemetry` (see `src/types.ts`) is the single shape published each step.

| Group | Fields |
|---|---|
| Flight state | `time`, `altitude`, `velocity`, `acceleration`, `mass`, `stage`, `lateralOffset`, `lateralVelocity`, `maxAltitude`, `airspeed`, `flightPathAngle` |
| Attitude | `bodyAngle` (+/-180), `angularVelocity`, `angleOfAttack` (0..180), `gimbalAngle`, `finAngle` |
| Aero and propulsion | `dynamicPressure`, `machNumber`, `thrustNewtons`, `isp`, `twr`, `maxQ`, `maxMach`, `propellantRemaining`, `cdAxial` |
| Loads | `axialGLoad`, `lateralGLoad` (specific force, in g) |
| Flight computer | `pitchRateCommand`, `attitudeTarget`, `gimbalCommand`, `rcsFuel`, `rcsTorque` |
| Vehicle | `staticMargin`, `centerOfGravity`, `centerOfPressure`, `momentOfInertia`, `bodyLength` |
| Environment | `airDensity`, `airPressure`, `airTemperature`, `speedOfSound`, `windSpeed` |
| Recovery and outcome | `chuteState` (0 stowed, 1 drogue, 2 main), `outcome` (`flying`, `landed`, `crashed`), `impactSpeed` |

`EMPTY_TELEMETRY` is exported from the physics module and is used for pre-launch display.

---

## Rendering

The renderer reads the telemetry ref each frame. It contains no physics.

- **Scale.** Altitude and lateral offset are multiplied by `ALTITUDE_SCALE = 0.05`, so one scene unit represents 20 m. The planet, sky dome, starfield and camera far plane are all built at this same true scale (see Planet, below); the launch pad and support structure are drawn at a larger, cinematic scale so they stay legible up close.
- **Logarithmic depth buffer.** The renderer is created with `logarithmicDepthBuffer: true`. A linear depth buffer cannot represent both a few-metre rocket and a 318,550-unit-radius planet in one range without z-fighting; the log buffer resolves the full span from 0.1 to 800,000 scene units. `CloudPass` decodes depth accordingly (`viewZ = exp2(depth * log2(far + 1)) - 1`) instead of the standard linear formula.
- **Pose.** The model's origin is at the base of its engine section, but the physics state describes the CG. The CG's world position is `(lateralOffset, altitude + cgHeightAboveBase)` where `cgHeightAboveBase = (1 - centerOfGravity / bodyLength) * modelHeight`. The group is rotated by `-bodyAngle` and its position is solved so the CG lands exactly where the physics puts it, so a flip rotates the model about its CG. A ground clamp prevents any tilted body from sinking below the pad (no effect for an upright rocket).
- **Camera.** A dynamic chase camera, not a fixed offset. The base offset is `(4, 3.5, 16)` from the CG, nearly side-on, so left and right pitch stay mirror images and the vehicle rotates about the centre of the frame. That offset is scaled by `(1 + log1p(altitudeKm * 0.5) * 2.5) * userZoom`, so the camera pulls back smoothly as altitude climbs and the globe comes into frame, without the jump a linear scale would give. `userZoom` is a multiplier (clamped 0.15 to 6) driven by the mouse wheel: scroll to zoom in or out at any point in flight, on top of the automatic pullback.
- **Rocket models.** Four vehicles are built by `buildVehicle(id, quality, envMap)` in `buildRocket.ts`. Bodies, domes, ogives and engine bells are lathe-revolved profiles; fins are bevelled extrusions; struts are cylinders; rivets are instanced spheres. All static parts are merged into one mesh per material, so a vehicle costs roughly 9 draw calls. A small shader patch adds per-pixel panel seams (an offset brick pattern from a per-vertex panel-coordinate attribute), exhaust soot that streaks up from the engine end, and low-frequency mottling, with no textures. Materials are PBR and use the scene environment map; the high tier adds clearcoat on painted surfaces and rivets. Tone mapping is ACES filmic. The model origin is the base of the engine skirt and the nozzle group pivots at the engine mount, so the gimbal animation is the same for every vehicle. After building, each model is uniformly scaled so its bounding-box height matches a realistic real-world height for that vehicle class (K-1 Strap 50 m, K-2 Reuse 70 m, K-3 Tower 98 m, K-4 Steel 120 m), converted to scene units at `ALTITUDE_SCALE`; the `height` returned to the scene is measured after scaling, so CG placement and chute position are unaffected.
- **Quality tiers.** `low`, `medium`, `high` change radial segment counts, clearcoat, soot and mottle detail, rivets and fin bevels. Measured with all four vehicles in one scene: low 36 draw calls / 20k triangles, medium 36 / 33k, high 40 / 82k (only one vehicle is ever shown at a time). While on the pad, if the average frame time exceeds about 33 ms over 90 frames, the scene rebuilds the vehicle one tier lower.
- **Launch complex.** Textured pad, support legs, flame deflector, hold-down arms, tower, scorch decal. At ignition a dual-sided flame-trench shader fans out horizontally and a ground ignition cloud billows independent of rocket altitude.
- **Plume.** A shader-deformed cone whose radius follows an expansion factor `1 - exp(-altitude / 8500 m)`: shock-disc structure at sea level, widening to a vacuum cone with altitude. Fresnel rim fade softens the silhouette. Exhaust particles are spawned at the nozzle and travel opposite to the body axis, so they follow the rocket through a flip.
- **Planet.** True Earth radius: 6,371 km, scaled to 318,550 scene units at `ALTITUDE_SCALE`. Two meshes share one set of noise-based colour uniforms:
  1. A coarse globe sphere (256 x 128 segments) for the whole planet, visible from orbital altitude and used as the natural horizon — there is no separate horizon mesh.
  2. A high-resolution near patch: a 160 x 160 flat grid covering a 20 km radius, with each vertex projected onto the sphere surface in the vertex shader, giving metre-scale ground detail close to the pad. It fades out between 8,000 m and 40,000 m altitude as the coarse globe takes over.

  Colour comes from five-octave domain-warped 3D noise evaluated on the sphere normal: deep and shallow ocean, coastal foam, sand, lowland, highland and rock bands. Land is biased around the pad so the launch site is always on land. Because only colour varies and the near patch is projected onto the exact same sphere radius as the globe, the physics ground (`y = 0`) always matches what is drawn. White cloud patches fade in on the globe from 300 to 4,000 m. A back-faced, additive atmosphere shell (80 km thick) supplies the blue limb glow, fading in from 2,000 to 60,000 m — visible as a rim from orbit, invisible from the ground where the camera sits inside the shell.
- **Sky and stars.** Three-stop gradient dome, radius 600,000 scene units (true-scale sky, matching the camera's 800,000-unit far plane). 2,000 stars on a 500,000-unit shell fade in between 5 and 15 km altitude. There is no scene fog: at true planetary scale, fog would hide the globe entirely, so haze is handled by the atmosphere shell and the cloud layers instead.
- **Volumetric clouds.** Three layers (stratus 0 to 600 m, cumulus 600 m to 2 km, cirrus 6 to 12 km) raymarched against a gradient and cellular noise volume with exponential extinction and height-based colour, composited against the true opaque depth via the log-depth-aware `CloudPass`.
- **Post-processing.** Heat scintillation pass masked around the rocket (peaks near 1,200 m, decays with a 8.5 km scale height), bloom, chromatic aberration ramping from 6 to 15 km, output pass.

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

Launch is blocked when thrust-to-weight at ignition is below 1. Derived values shown live in the panel: thrust-to-weight and burn duration.

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
- **Left/right symmetry.** Mirrored runs (left key with one wind sign versus right key with the opposite sign) agree to within gust noise: time to rotate through 150 degrees differs by at most 0.2 s across launch times from 0.5 s to 20 s.
- **Controllability.** Holding a pitch key rotates the vehicle 180 degrees in about 5.5 to 7.3 s at any launch time, across five different parameter sets (light, heavy, fat, slim and high-thrust). Flipping in the first seconds sends the vehicle into the ground at roughly 250 to 290 m/s; flipping later in the burn or in the coast leaves it flying inverted. Peak lateral load during a high-dynamic-pressure flip is about 21 g, which a real airframe would not survive; there is no structural failure model yet.
- **Stability across configurations.** Nominal (no key input) flights land softly for all five parameter sets, including one that reaches Mach 2.6.
- **Cold-gas-only pitch.** At low dynamic pressure the cold-gas couple alone achieves the commanded 30 deg/s using about 0.07 kg of gas.
- **Parachute swing.** Pendulum motion under canopy settles in about 4 s.

---

## Known limitations

- The model is planar (pitch only): no yaw, roll, Earth rotation, or horizontal curvature. Gravity varies with altitude but the ground is flat for the dynamics.
- No structural failure model: loads are reported, but nothing breaks.
- The wind sign is random per launch, so two otherwise identical launches can drift differently.
- The Mach-dependent nose slope is held constant; only the fins carry the compressibility correction.
- Vehicle models are cosmetic: they do not change mass properties, aerodynamics or propulsion, and the drag, fin and centre-of-gravity geometry is still derived from the reference area. The fin planform in the physics does not match each model's drawn fins. Each model's real-world height (used for render scale) is likewise independent of the physics geometry derived from the reference area.
- Gesture thresholds are tuned on synthetic landmark data only and need calibration on real cameras; swipe direction depends on the camera not being mirrored in the raw feed.
- The control fins are modelled in the physics and reported in telemetry (`finAngle`) but are not yet animated on the 3D model.
- Left/right arrow input commands a pitch *rate*, not lateral translation. Because the attitude-hold loop re-centres pitch quickly and lateral drift is a second-order, lagged consequence of thrust/drag tilt (not a direct force), a short tap reads mostly as the nose tipping rather than as sideways motion — the vehicle does genuinely drift sideways once the tilt has had time to act on its mass, matching real gravity-turn behaviour, but it is not an arcade-style strafe.
- The flight model is planar (pitch only, no yaw or roll) with flat-Earth gravity; the rendered planet is true-scale and curved, but the physics ground is still a flat plane at `y = 0` and gravity points straight down rather than toward a planet centre. Spherical gravity, Earth rotation and full 6-DOF are planned (see Sponsorship).

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
3. **Set parameters** once armed. Watch the derived thrust-to-weight and burn time update. Launch is blocked below thrust-to-weight 1.
4. **Launch.**
5. **Steer.** Hold the left or right arrow key to command a pitch rate of up to 30 deg/s in that direction. Release to hold the current attitude. Holding for about 6 s turns the vehicle through 180 degrees.
6. Watch the telemetry. Compare burn, coast, apogee, descent and touchdown against the reference flight, then change parameters and fly again.

---

## Project structure

```
src/
├── types.ts                    # Shared data shapes: hand types, countdown state, vehicle ids, rocket params, telemetry, commentary
├── hand/
│   ├── handTracker.ts          # Hand landmark detector wrapper (two hands)
│   ├── fingerCount.ts          # Landmark-based finger count (0-5)
│   └── gestures.ts             # Swipe and clap detection
├── state/
│   └── countdownMachine.ts     # idle -> selecting -> counting -> armed -> launched
├── physics/
│   └── rocketPhysics.ts        # Flight model: atmosphere, wind, aero, propulsion, mass, flight computer, recovery
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
└── App.tsx                     # Pipeline: webcam -> hand -> physics -> render -> commentary
```

---

## Tuning constants

The values below live at the top of `rocketPhysics.ts`.

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
| `GIMBAL_MAX` / `GIMBAL_RATE` / `GIMBAL_TAU` | 6 deg / 25 deg/s / 0.05 s | Thrust-vector actuator |
| `FIN_CTRL_MAX` / `FIN_CTRL_RATE` / `FIN_CTRL_TAU` / `FIN_CTRL_EFF` | 15 deg / 80 deg/s / 0.03 s / 0.75 | Control-fin actuator and effectiveness |
| `OMEGA_MAX` | 30 deg/s | Commanded pitch rate at full key deflection |
| `K_THETA` / `K_OMEGA` | 1.8 / 6.0 per s | Attitude-hold and rate loop gains |
| `RCS_ACCEL` / `RCS_DEADBAND` / `ISP_COLD` | 30 deg/s^2 / 4 percent / 65 s | Cold-gas couple |
| `STRUCT_CG` / `PROP_CG` / `PROP_LEN` / `RCS_TANK` / `RCS_ARM` | 0.62 / 0.45 / 0.40 / 0.12 / 0.60 | Mass station fractions of length |
| `GUST_TAU` | 3.0 s | Gust correlation time |
| `MAX_SUB_DT` | 1/200 s | Integrator sub-step |
| `CD_CHUTE` / `CHUTE_INFLATE` / `DROGUE_FRACTION` | 1.5 / 2.0 s / 0.025 | Parachute |
| `CHUTE_Q_MAX` / `MAIN_ALT` / `MAIN_Q_MAX` | 800 Pa / 350 m / 1,500 Pa | Deployment gates |
| `LAND_V_MAX` / `LAND_TILT_MAX` / `LAND_SPIN_MAX` | 9 m/s / 30 deg / 45 deg/s | Landed versus crashed |

---

## Sponsorship

Kalam is an independent, open-source project. It is built and maintained in spare time, and sponsorship is what lets the next stages of work happen faster and stay free for everyone to use and learn from.

### What sponsorship funds

- **Spherical gravity and 6-DOF.** Replacing flat-Earth gravity with `mu/r^2` toward a true planet centre, adding yaw and roll so the rendered true-scale globe and the physics finally agree, plus Earth rotation and real downrange/orbital tracking.
- **Vehicle-specific physics.** Per-vehicle mass properties, staging, boosters, engine clusters and throttle profiles, so the four models stop being cosmetic.
- **Structural failure model.** Load limits, breakup and debris, so a 21 g flip actually costs you the vehicle.
- **Higher-fidelity rendering.** Cloud and plume improvements, an opt-in path-traced preview, per-vehicle launch pads, and control fins that move on the model.
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

The flight model is open for inspection and the validation scripts are reproducible. Universities, labs and student chapters interested in using Kalam for teaching or in extending the dynamics (6-DOF, aeroelasticity, guidance laws, Monte Carlo dispersion studies) are welcome to get in touch about collaboration, co-authorship and shared datasets.

### How to get involved

Open an issue or discussion in the repository titled "Sponsorship", or use the sponsor button on the repository page once it is enabled. Please include who you are, which tier or in-kind contribution you have in mind, and any timelines. Contributions of code, bug reports, and validation data are equally valuable and need no tier.

---

## License

Apache 2.0. See [LICENSE](LICENSE).