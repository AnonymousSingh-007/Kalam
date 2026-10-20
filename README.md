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
7. [Hand tracking and countdown](#hand-tracking-and-countdown)
8. [Commentary engine](#commentary-engine)
9. [Launch parameters](#launch-parameters)
10. [Reference flight and validation](#reference-flight-and-validation)
11. [Known limitations](#known-limitations)
12. [Setup](#setup)
13. [How to fly](#how-to-fly)
14. [Project structure](#project-structure)
15. [Tuning constants](#tuning-constants)
16. [License](#license)

---

## Features

- **Gesture-armed countdown.** In-browser hand landmark detection reads a finger count (5, 4, 3, 2, 1, fist) and steps a state machine `idle -> counting -> armed -> launched`. No buttons are needed to arm.
- **Planar 3-DOF rigid-body physics.** State is `(x, y, vx, vy, theta, omega)`, integrated with RK4 in sub-steps of at most 5 ms.
- **ISA 1976 atmosphere** (seven layers, chained base pressures, density from the ideal-gas law, geopotential altitude) with an altitude wind profile and mean-reverting gusts. Aerodynamics use air-relative velocity.
- **Geometry derived from the launch parameters.** Reference area sets diameter and length; nose, fins, centre of gravity (CG), centre of pressure (CP), inertia and static margin all follow from it.
- **Full-angle aerodynamics.** Normal force is valid from 0 to 180 degrees angle of attack, so tail-first flight is modelled and is naturally unstable. Mach-dependent axial drag, fin compressibility correction, cross-flow term, pitch damping.
- **Altitude-compensated propulsion.** `F = f * F_vac - p_ambient * A_exit`, mass flow from the burn rate, ignition ramp, tail-off, jet damping.
- **Moving mass properties.** CG and pitch inertia are recomputed every step from structure, propellant and cold-gas masses, including the `dI/dt` term in the rotational equation.
- **Three-actuator flight computer.** Arrow keys command a pitch rate; on release the vehicle holds attitude. Demanded torque is shared between thrust vectoring and movable aerodynamic control fins in proportion to the authority each has at that instant; a finite cold-gas budget covers any remainder.
- **Recovery.** Drogue then main parachute, attached at the nose, with forces evaluated at the attachment-point velocity (this produces real swing damping). Deployment is gated by dynamic pressure and altitude.
- **Touchdown classification** by impact speed, tilt and spin rate: `landed` or `crashed`.
- **3D renderer.** Multi-section rocket model pivoted about its centre of gravity, launch complex, plume expansion shader, flame trench flow, heat shimmer, procedural planet with atmosphere rim, starfield, volumetric clouds, bloom, chromatic aberration.
- **Live instruments** for altitude, velocity, axial g, angle of attack, Mach, dynamic pressure, cold-gas remaining and nozzle deflection.
- **Telemetry-aware commentary**, spoken with the Web Speech API.

---

## Architecture and data flow

```
 webcam --> hand tracker --> finger count --> countdown state machine
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

- **Scale.** Altitude and lateral offset are multiplied by `ALTITUDE_SCALE = 0.05`, so one scene unit represents 20 m. The rocket model and launch complex are drawn at a larger, cinematic scale.
- **Pose.** The model's origin is at the base of its engine section, but the physics state describes the CG. The CG's world position is `(lateralOffset, altitude + cgHeightAboveBase)` where `cgHeightAboveBase = (1 - centerOfGravity / bodyLength) * modelHeight`. The group is rotated by `-bodyAngle` and its position is solved so the CG lands exactly where the physics puts it, so a flip rotates the model about its CG. A ground clamp prevents any tilted body from sinking below the pad (no effect for an upright rocket).
- **Camera.** Chase camera at a fixed offset of `(4, 3.5, 16)` from the CG, nearly side-on, looking at the CG, so left and right pitch are mirror images and the vehicle rotates about the centre of the frame.
- **Rocket model.** Multi-section body: flared engine skirt, five-nozzle cluster with a gimbal-driven nozzle group, steel booster with panel seam rings, thermal interstage and taper, painted upper section with cold-gas thruster pods, ogive payload fairing, four swept delta fins. Metallic surfaces use an environment map. Tone mapping is ACES filmic.
- **Launch complex.** Textured pad, support legs, flame deflector, hold-down arms, tower, scorch decal. At ignition a dual-sided flame-trench shader fans out horizontally and a ground ignition cloud billows independent of rocket altitude.
- **Plume.** A shader-deformed cone whose radius follows an expansion factor `1 - exp(-altitude / 8500 m)`: shock-disc structure at sea level, widening to a vacuum cone with altitude. Fresnel rim fade softens the silhouette. Exhaust particles are spawned at the nozzle and travel opposite to the body axis, so they follow the rocket through a flip.
- **Planet.** A smooth full sphere (radius 420 scene units, 192 x 96 segments) coloured per pixel from five-octave domain-warped 3D noise: deep and shallow ocean, coastal foam, sand, lowland, highland and rock bands. Land is biased around the pad so the launch site is always on land. Because only colour varies, the physics ground (`y = 0`) always matches what is drawn. White clouds fade in from 150 to 1,800 m; a back-faced additive atmosphere shell supplies the blue limb glow, fading in from 500 to 3,500 m (camera is inside the shell near the ground). Ground detail noise at metre scale gives a sense of speed near the surface.
- **Sky and stars.** Three-stop gradient dome. 2,000 stars fade in between 5 and 15 km.
- **Volumetric clouds.** Three layers (stratus 0 to 600 m, cumulus 600 m to 2 km, cirrus 6 to 12 km) raymarched against a gradient and cellular noise volume with exponential extinction and height-based colour.
- **Post-processing.** Heat scintillation pass masked around the rocket (peaks near 1,200 m, decays with a 8.5 km scale height), bloom, chromatic aberration ramping from 6 to 15 km, output pass.

---

## Hand tracking and countdown

- **Detection.** In-browser landmark detection with the GPU delegate; one hand is used. Each frame yields 21 landmarks per hand with handedness and a confidence score.
- **Finger count.** A joint-angle heuristic per finger, handedness-aware for the thumb, returning 0 to 5 or `null` when no hand is present.
- **State machine.**

```
idle -> counting(expected, heldFrames) -> armed -> launched
```

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
- The control fins are modelled in the physics and reported in telemetry (`finAngle`) but are not yet animated on the 3D model.
- Scene scale is compressed (`ALTITUDE_SCALE = 0.05`) for readability; the planet curvature is deliberately exaggerated relative to a true-scale Earth.

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

1. **Count down** with one hand: hold 5 fingers steady until it steps to 4, then 3, 2, 1, fist. Each digit must be held for about 0.5 s.
2. **Set parameters** once armed. Watch the derived thrust-to-weight and burn time update. Launch is blocked below thrust-to-weight 1.
3. **Launch.**
4. **Steer.** Hold the left or right arrow key to command a pitch rate of up to 30 deg/s in that direction. Release to hold the current attitude. Holding for about 6 s turns the vehicle through 180 degrees.
5. Watch the telemetry. Compare burn, coast, apogee, descent and touchdown against the reference flight, then change parameters and fly again.

---

## Project structure

```
src/
├── types.ts                    # Shared data shapes: hand types, countdown state, rocket params, telemetry, commentary
├── hand/
│   ├── handTracker.ts          # Hand landmark detector wrapper
│   └── fingerCount.ts          # Landmark-based finger count (0-5)
├── state/
│   └── countdownMachine.ts     # idle -> counting -> armed -> launched
├── physics/
│   └── rocketPhysics.ts        # Flight model: atmosphere, wind, aero, propulsion, mass, flight computer, recovery
├── render/
│   ├── Scene.tsx               # Scene, shaders, post-processing, pose and camera
│   ├── buildRocket.ts          # Rocket geometry (nozzle group, fins, fairing, seams)
│   ├── buildGround.ts          # Procedural planet and atmosphere rim
│   ├── buildHorizon.ts         # Horizon backdrop
│   ├── buildSun.ts             # Sun disc matched to the scene light
│   ├── CloudLayer.ts           # Volumetric cloud class (stratus, cumulus, cirrus)
│   └── noise.ts                # CPU gradient / cellular / fractal noise (GLSL port in CloudLayer)
├── commentary/
│   ├── commentaryEngine.ts     # Stage-transition and event trigger logic
│   └── lines.ts                # Line bank: telemetry-aware templates for all triggers
├── ui/
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

## License

Apache 2.0. See [LICENSE](LICENSE).