# Kalam 🚀

> *"If you want to shine like a sun, first burn like a sun."* — Dr. A.P.J. Abdul Kalam

An interactive rocket launch simulator driven by hand gestures, real physics, and sarcastic AI commentary. Count down from 5 to 0 with your hand, configure your rocket's parameters, and watch it fly — with live telemetry, a 3D render that follows every stage of the flight, and a voice that has opinions about all of it.

Named after Dr. APJ Abdul Kalam — aerospace engineer, missile scientist, and the 11th President of India.

---

## What it does

- **Hand-tracked countdown** — MediaPipe hand landmark detection reads your finger count (5 → 0) to arm the launch sequence. No buttons, no keyboard.
- **Parametric rocket physics** — configure thrust, propellant mass, burn rate, drag, and cross-section. The engine computes thrust-to-weight ratio live, blocks launch if T/W < 1, and simulates altitude-dependent gravity, exponential atmospheric density falloff, engine thrust ramp, wind drift with lateral drag, and a gravity-turn pitch-over after pad clearance.
- **Thrust vectoring** — hold left/right arrow keys during powered ascent to gimbal the engine nozzle up to ±15°, visibly arcing the trajectory. The nozzle cluster animates with the deflection. AoA gauge responds in real time.
- **Staged flight model** — powered-ascent → max-Q → burnout → coast → apogee → descent, each with physically derived transitions. Drogue chute deploys visually at apogee/descent.
- **3D render** — multi-stage Atlas-Centaur/Vostok-style rocket: boat-tail engine section, 5-nozzle cluster (RD-180 main bell + 4 canted verniers with rim glow), panel seam rings, propellant fill ports, RCS thruster pods, ogive payload fairing, swept delta fins. Environment map reflections on metallic surfaces. ACES filmic tone mapping.
- **Launch complex** — structured pad with support legs, flame deflector, hold-down arms, and scorch mark. Flame trench flow redirection (dual horizontal exhaust fans) at ignition. Ground ignition cloud that billows outward independent of rocket altitude.
- **Plume expansion** — Mach disc shock pattern at sea level transitions to a wide vacuum cone at altitude, driven by ambient pressure. Fresnel rim-fade on the plume silhouette. Heat scintillation shimmer around the exhaust.
- **Planet curvature** — ground is a sphere cap (not a flat plane), with an atmospheric limb glow ring that intensifies with altitude. Sky is a 3-stop gradient shader (deep space → blue-purple → dawn horizon).
- **Starfield** — 2000 stars fade in above 5km as the sky darkens toward space.
- **Volumetric clouds** — cumulus, stratus, and cirrus layers at physically correct altitude bands, raymarched with Beer-Lambert extinction and height-based colour (warm dawn-lit tops, cool shadowed undersides).
- **Chromatic aberration** — subtle colour fringing at extreme altitude, tied to the same scale-height model as the atmosphere.
- **Live instrument gauges** — altitude, velocity, axial G-load, angle of attack, and gimbal angle. Danger thresholds highlighted in red.
- **Sarcastic AI commentary** — telemetry-aware lines (references actual altitude, velocity, G-load numbers), event-reactive triggers (high-G, steep AoA, fast descent), periodic lines during long coast/descent phases, and spoken aloud via Web Speech API. Includes a 12-line no-repeat ring buffer so the same line doesn't fire twice in a row.
- **Ground-anchored tracking camera** — fixed position near the pad, lerped lookAt that pans to follow the rocket, FOV tightens from 50° to 22° as altitude climbs — feels like a real ground camera, not a camera glued to the rocket.

---

## Tech stack

| Layer | Tech |
|---|---|
| Hand tracking | MediaPipe HandLandmarker (in-browser, GPU delegate) |
| Finger counting | Joint-angle heuristic, handedness-aware |
| Physics engine | Custom TypeScript sim — Tsiolkovsky, ISA atmosphere, thrust vectoring gimbal |
| 3D render | Three.js + custom GLSL shaders (plume expansion, flame trench, heat shimmer, chromatic aberration, sky dome) |
| Volumetric clouds | Perlin-Worley noise (CPU + GLSL port), raymarched slab shader, Beer-Lambert extinction |
| Post-processing | Three.js EffectComposer — UnrealBloomPass, heat scintillation ShaderPass, chromatic aberration ShaderPass, OutputPass |
| Commentary | Web Speech API + rule-based trigger engine with telemetry-aware line templating |
| Frontend | React + TypeScript + Vite |

---

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Allow webcam access when prompted.

---

## How to launch

1. **Count down** with your left hand — hold 5 fingers steady until it steps to 4, then 3, 2, 1, fist. Each digit needs to be held for ~0.5s to register.
2. **Set parameters** once armed — thrust, dry mass, propellant mass, burn rate, drag coefficient, cross-section area. Watch the live derived stats (T/W ratio, burn duration) update as you type. Launch is blocked if T/W < 1.
3. **Hit Launch.**
4. Hold **← →** arrow keys during powered ascent to vector thrust and steer the trajectory.
5. Watch the flight. Listen to the commentary. Try again with different parameters.

---

## Project structure
src/
├── hand/
│ ├── handTracker.ts # MediaPipe HandLandmarker wrapper
│ └── fingerCount.ts # Landmark-based finger count (0-5)
├── state/
│ └── countdownMachine.ts # idle → counting → armed → launched
├── physics/
│ └── rocketPhysics.ts # Full flight sim — atmosphere, gimbal, wind, gravity turn
├── render/
│ ├── Scene.tsx # Three.js scene, shaders, post-processing, camera
│ ├── buildRocket.ts # Rocket geometry (nozzle group, fins, fairing, seams)
│ ├── buildGround.ts # Sphere cap ground, atmospheric limb glow
│ ├── CloudLayer.ts # Volumetric cloud class (cumulus/stratus/cirrus)
│ └── noise.ts # CPU Perlin/Worley/FBM noise (GLSL port in CloudLayer)
├── commentary/
│ ├── commentaryEngine.ts # Stage transition + event-reactive trigger logic
│ └── lines.ts # Line bank — telemetry-aware templates, 9 triggers
├── ui/
│ ├── ParamPanel.tsx # Launch parameter input with live derived stats
│ └── InstrumentPanel.tsx # Circular gauges: ALT, VEL, G-AX, AoA, gimbal
└── App.tsx # Pipeline: webcam → hand → physics → render → commentary


---

## Built by

**Samratth Singh**  · **Lakshit Saini**

---

## License

Apache 2.0 — see [LICENSE](LICENSE)