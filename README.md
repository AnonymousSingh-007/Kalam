# Kalam 🚀

> *"If you want to shine like a sun, first burn like a sun."* — Dr. A.P.J. Abdul Kalam

An interactive rocket launch simulator driven by hand gestures, real physics, and sarcastic AI commentary. Count down from 5 to 0 with your hand, configure your rocket's parameters, and watch it fly — with live telemetry, a 3D render that follows every stage of the flight, and a voice that has opinions about all of it.

Named after Dr. APJ Abdul Kalam — aerospace engineer, missile scientist, and the 11th President of India.

---

## What it does

- **Hand-tracked countdown** — MediaPipe hand landmark detection reads your finger count (5 → 0) to arm the launch sequence. No buttons, no keyboard.
- **Parametric rocket physics** — configure thrust, propellant mass, burn rate, drag, and cross-section. The engine computes thrust-to-weight ratio live, blocks launch if T/W < 1, and simulates altitude-dependent gravity, exponential atmospheric density falloff, engine thrust ramp, and randomized wind drift with lateral drag.
- **Staged flight model** — powered-ascent → max-Q → burnout → coast → apogee → descent, each with physically derived transitions.
- **3D render** — multi-stage Atlas-Centaur/Vostok-style rocket with swept fins, engine nozzle cluster, scorch mark, ignition ground cloud, plume expansion envelope (Mach disc pattern at sea level → wide vacuum cone at altitude), and flame trench flow redirection. Bloom post-processing, shadow maps, procedural sky gradient, PBR ground/pad textures.
- **Live instrument gauges** — altitude and velocity circular gauges overlaid on the viewport, updating in real time.
- **Sarcastic AI commentary** — stage-triggered and periodic lines spoken aloud via Web Speech API. It has something to say about every phase of your flight, and none of it is reassuring.
- **Camera tracking** — locks vertically 1:1 with the rocket's altitude and follows lateral wind drift, zooming out gradually so the full rocket stays framed.

---

## Tech stack

| Layer | Tech |
|---|---|
| Hand tracking | MediaPipe HandLandmarker (in-browser, GPU delegate) |
| Finger counting | Joint-angle heuristic, handedness-aware |
| Physics engine | Custom TypeScript sim — Tsiolkovsky, ISA atmosphere, wind |
| 3D render | Three.js + custom GLSL shaders |
| Post-processing | Three.js EffectComposer, UnrealBloomPass |
| Commentary | Web Speech API + rule-based trigger engine |
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

1. **Set parameters** in the panel on the right — thrust, dry mass, propellant mass, burn rate, drag coefficient, cross-section area. Watch the live derived stats (T/W ratio, burn duration) update as you type. Launch is blocked if T/W < 1.
2. **Count down** with your left hand — hold 5 fingers steady until it steps to 4, then 3, 2, 1, fist. Each digit needs to be held for ~0.5s to register.
3. **Hit Launch** once the system is armed.
4. Watch the flight. Listen to the commentary. Try again with different parameters.

---

## Project structure

src/
├── hand/
│ ├── handTracker.ts # MediaPipe HandLandmarker wrapper
│ └── fingerCount.ts # Landmark-based finger count (0-5)
├── state/
│ └── countdownMachine.ts # idle → counting → armed → launched
├── physics/
│ └── rocketPhysics.ts # Full flight sim with atmosphere model
├── render/
│ └── Scene.tsx # Three.js scene, shaders, post-processing
├── commentary/
│ ├── commentaryEngine.ts # Stage transition + periodic trigger logic
│ └── lines.ts # Line bank (8 lines per trigger, 9 triggers)
├── ui/
│ ├── ParamPanel.tsx # Launch parameter input with live derived stats
│ └── InstrumentPanel.tsx # Altitude/velocity circular gauges
└── App.tsx # Pipeline wiring: webcam → physics → render → commentary


---

## Built by

**Samratth Singh** (lead) · **Lakshit Saini** (Three.js render + post-processing)

---

## License

Apache 2.0 — see [LICENSE](LICENSE)