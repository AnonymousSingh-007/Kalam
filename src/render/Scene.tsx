import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { CloudPass } from './CloudPass'
import { buildVehicle, type VehicleModel } from './buildRocket'
import { buildGround, type GroundResult } from './buildGround'
import { buildSun } from './buildSun'
import { SmokeParticles } from './SmokeParticles'
import { buildLaunchPad, PAD_RELEASE, type LaunchPadRig } from './buildLaunchPad'
import { buildLaunchComplex } from './buildLaunchComplex'
import { PAD_RADIUS, padShapes } from './padFootprint'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { metresToScene } from '../constants/scale'
import { launchSite, launchSiteToRender } from '../constants/frames'
import type { Telemetry, VehicleId, QualityTier } from '../types'

interface SceneProps {
  telemetryRef: React.MutableRefObject<Telemetry | null>
  launched: boolean
  vehicleId: VehicleId
  selecting: boolean
  quality?: QualityTier
}

// ---- Liftoff smoke tuning (sizes/speeds in metres, converted with metresToScene) ----
const SMOKE_QUALITY: Record<QualityTier, number> = { low: 0.45, medium: 0.7, high: 1 }
const POOL_TRAIL = 0
const POOL_TRENCH = 1
const POOL_COLUMN = 2
const POOL_STEAM = 3
// count = pool size at 'high'; rate = particles/s at full strength; life = s
const SMOKE_TRAIL = { count: 2800, rate: 600, life: 7, size0M: 9, size1M: 85, fadeStartM: 10000, stopM: 12000 }
const SMOKE_TRENCH = { count: 1700, rate: 380, life: 10, size0M: 20, size1M: 190, speedMinMps: 140, speedMaxMps: 330 }
const SMOKE_COLUMN = { count: 1000, rate: 170, life: 9, size0M: 24, size1M: 220 }
// Deluge steam from the pad nozzles during the first seconds of ignition.
const SMOKE_STEAM = { count: 500, rate: 260, life: 5, size0M: 6, size1M: 70, durationS: 7 }
const SMOKE_OPACITY = 0.4          // overall smoke opacity (was 0.55)
const SMOKE_NEAR_FADE: [number, number] = [0.6, 3.0]   // view depth: smoke fades out this close to the lens
// ---- Engine light (warm rim/under-light on the rocket in the smoke) ----
const ENGINE_LIGHT_INTENSITY = 6
const ENGINE_LIGHT_RANGE = 3       // x rocketHeight
// ---- Launch camera: fixed tripod shot, then blend into the chase cam ----
const CAM_HOLD_S = 3
const CAM_BLEND_S = 1.5
const SMOKE_PAD_HEIGHT_M = 320     // pad clouds stop once the nozzle is this high
const LIFTOFF_ALT_M = 0.05         // physics liftedOff threshold (rocketPhysics.ts)
// ---- Ignition camera shake / hold-down vibration ----
const SHAKE_S = 4                  // seconds of shake after ignition
const SHAKE_RAD = 0.006            // peak camera jitter, radians (~3 px at 960x720)
const HOLD_VIBRATION = 0.0025      // rocket jitter while clamped, fraction of rocket height
const TRENCH_CLOUD_COUNT = 140
const HEAT_PEAK_ALTITUDE = 1200
const HEAT_SCALE_HEIGHT = 8500
const CHROMA_ALTITUDE_START = 6000
const CHROMA_ALTITUDE_FULL = 15000
const CHROMA_MAX_STRENGTH = 0.003
const STAR_FADE_START = 5000
const STAR_FADE_FULL = 15000
const STAR_MAX_OPACITY = 0.9

// ---- Plume tuning (world length = rocketHeight * factor) ----
// factor = (BASE + THROTTLE * throttle) * (1 + VACUUM * expansion)
// -> ~0.95x rocket height at liftoff full throttle, ~2.2x in thin air.
const PLUME_LEN_BASE = 0.55
const PLUME_LEN_THROTTLE = 0.4
const PLUME_LEN_VACUUM = 1.3

// ---- Recovery rig tuning ----
const CHUTE_INFLATE_S = 1.5     // canopy small -> full, seconds after deploy
const RISER_PAYOUT_S = 0.6      // riser reaches full length, seconds after deploy
const RISER_FRACTION = 0.3      // confluence point, fraction of riser length from the nose
const RISER_DIR_RATE = 3.0      // 1/s, how fast the riser direction follows the airflow
const HANG_BLEND_RATE = 1.6     // 1/s, body attitude: physics tumble -> hanging
const PEND_PERIOD_S = 2.4       // pendulum swing period of the hanging body
const PEND_ZETA = 0.14          // pendulum damping ratio (lower = more swings)
const PEND_K = (2 * Math.PI / PEND_PERIOD_S) ** 2
const PEND_C = 2 * PEND_ZETA * (2 * Math.PI / PEND_PERIOD_S)
const CHUTE_SWAY = 0.06         // riser-direction sway amplitude once open
const CHUTE_BREATHE = 0.035     // canopy breathing amplitude
const LINE_RADIUS = 0.014       // suspension line radius, scene units
const RISER_RADIUS = 0.03       // riser/bridle radius, scene units
const UP_AXIS = new THREE.Vector3(0, 1, 0)

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2))
}

// The renderer uses logarithmicDepthBuffer (needed for the 0.1 .. 800 000
// near/far range of the true-scale planet). Every built-in material writes
// log depth via gl_FragDepth; a custom ShaderMaterial must include the
// logdepthbuf chunks itself, or its fragments are depth-tested with plain
// perspective depth (~0.99) against the log-depth buffer (~0.2 for nearby
// geometry) and get rejected wherever any opaque surface is behind them.
//
// Plume geometry: an open unit cylinder spanning local y in [-1, 0]
// (y = 0 at the nozzle exit plane, y = -1 at the tail), radius 1. The
// shader turns it into the real plume shape: length uLen, exit radius
// uExitR, flaring with altitude (uExpansion). The plume mesh is a child of
// nozzleGroup, so it inherits the gimbal tilt and the rocket's model scale.
const PLUME_VERTEX = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uLen;
  uniform float uExitR;
  uniform float uExpansion;
  uniform float uTime;
  varying float vT;
  varying float vFresnel;

  void main() {
    float t = clamp(-position.y, 0.0, 1.0);      // 0 at nozzle exit, 1 at tail
    // Sea level: a tight column that only widens a little. Thin air: the
    // exhaust balloons out (under-expanded plume).
    float flare = mix(0.6, 4.5, uExpansion);
    float r = uExitR * (1.0 + flare * pow(t, mix(1.3, 0.55, uExpansion)));
    // Over-expanded necking near the exit at low altitude.
    r *= 1.0 - 0.16 * (1.0 - uExpansion) * sin(t * PI * 5.0) * (1.0 - t);
    // Turbulent flicker, stronger toward the tail.
    r *= 1.0 + t * (0.07 * sin(uTime * 37.0 + t * 11.0) + 0.05 * sin(uTime * 23.0 + position.x * 6.0));
    vec3 pos = vec3(position.x * r, position.y * uLen, position.z * r);
    vT = t;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFresnel = 1.0 - abs(dot(normalize(-mvPosition.xyz), n));
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`

const PLUME_FRAGMENT = `
  #include <logdepthbuf_pars_fragment>
  uniform float uExpansion;
  uniform float uTime;
  uniform float uIntensity;
  varying float vT;
  varying float vFresnel;

  void main() {
    float t = vT;
    vec3 core   = vec3(1.0, 0.97, 0.88);
    vec3 yellow = vec3(1.0, 0.80, 0.38);
    vec3 orange = vec3(1.0, 0.45, 0.12);
    vec3 tail   = vec3(0.45, 0.20, 0.08);
    vec3 col = mix(core, yellow, smoothstep(0.0, 0.16, t));
    col = mix(col, orange, smoothstep(0.14, 0.50, t));
    col = mix(col, tail, smoothstep(0.50, 0.95, t));
    // Shock diamonds: bright bands near the exit, sea level only.
    float diamonds = pow(max(sin(t * 34.0 - 1.2), 0.0), 8.0)
                   * (1.0 - smoothstep(0.05, 0.45, t)) * (1.0 - uExpansion);
    col += vec3(1.0, 0.92, 0.75) * diamonds * 0.9;
    // HDR boost in the core so UnrealBloomPass (threshold 0.8) picks it up.
    col *= 1.0 + 1.4 * (1.0 - smoothstep(0.0, 0.3, t));
    float edge = 1.0 - pow(clamp(vFresnel, 0.0, 1.0), 1.6);   // dense centre, soft silhouette
    float flick = 0.88 + 0.12 * sin(uTime * 53.0 + t * 19.0);
    float a = pow(1.0 - t, 1.4) * mix(0.15, 1.0, edge) * flick * uIntensity;
    a *= mix(1.0, 0.6, uExpansion);                         // thinner, fainter in vacuum
    gl_FragColor = vec4(min(col, vec3(2.4)), clamp(a, 0.0, 1.0));
    #include <logdepthbuf_fragment>
  }
`

const TRENCH_VERTEX = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float progress;
  uniform float side;
  varying float vDist;

  void main() {
    vec3 pos = position;
    pos.x *= (0.3 + progress * 2.2) * side;
    pos.y = pos.y * 0.4;
    vDist = length(pos.xz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    #include <logdepthbuf_vertex>
  }
`

const TRENCH_FRAGMENT = `
  #include <logdepthbuf_pars_fragment>
  uniform float progress;
  varying float vDist;

  void main() {
    float heat = 1.0 - smoothstep(0.0, 2.5, vDist);
    vec3 hotColor  = vec3(1.0, 0.92, 0.7);
    vec3 coolColor = vec3(0.8, 0.25, 0.05);
    vec3 color = mix(coolColor, hotColor, heat);
    float opacity = heat * (1.0 - progress * 0.85) * 0.9;
    gl_FragColor = vec4(color, clamp(opacity, 0.0, 1.0));
    #include <logdepthbuf_fragment>
  }
`

const HEAT_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const HEAT_FRAGMENT_SHADER = `
  uniform sampler2D tDiffuse;
  uniform float time;
  uniform float strength;
  uniform float frequency;
  uniform float aspect;
  uniform vec2  rocketScreenPos;
  uniform float maskRadius;
  varying vec2 vUv;

  float turbulence(vec2 p, float t) {
    float n = sin(p.x + t * 2.0) * cos(p.y * 1.3 - t * 1.7);
    n += 0.5 * sin(p.x * 2.1 - t * 3.1) * cos(p.y * 1.7 + t * 2.3);
    return n * 0.6667;
  }

  void main() {
    vec2 uv = vUv;
    vec2 d = uv - rocketScreenPos;
    d.x *= aspect;
    float dist = length(d);
    float mask = 1.0 - smoothstep(0.0, maskRadius, dist);
    vec2 p = uv * frequency;
    float nx = turbulence(p, time);
    float ny = turbulence(p + 17.0, time);
    vec2 offset = vec2(nx, ny) * strength * mask;
    gl_FragColor = texture2D(tDiffuse, uv + offset);
  }
`

const CHROMA_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const CHROMA_FRAGMENT_SHADER = `
  uniform sampler2D tDiffuse;
  uniform float strength;
  varying vec2 vUv;

  void main() {
    vec2 dir = vUv - 0.5;
    vec2 offset = dir * strength;
    float r = texture2D(tDiffuse, vUv - offset).r;
    float g = texture2D(tDiffuse, vUv).g;
    float b = texture2D(tDiffuse, vUv + offset).b;
    float a = texture2D(tDiffuse, vUv).a;
    gl_FragColor = vec4(r, g, b, a);
  }
`

const SKY_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SKY_FRAGMENT_SHADER = `
  uniform vec3 topColor;
  uniform vec3 midColor;
  uniform vec3 bottomColor;
  uniform float offset;
  uniform float exponent;
  varying vec3 vWorldPosition;

  void main() {
    float h = normalize(vWorldPosition).y;
    float t = clamp(pow(max(h + offset, 0.0), exponent), 0.0, 1.0);
    vec3 color = mix(bottomColor, midColor, smoothstep(0.0, 0.5, t));
    color = mix(color, topColor, smoothstep(0.5, 1.0, t));
    gl_FragColor = vec4(color, 1.0);
  }
`

export function Scene({ telemetryRef, launched, vehicleId, selecting, quality = 'medium' }: SceneProps) {
  const swapRef = useRef<((id: VehicleId, q: QualityTier) => void) | null>(null)
  const vehicleRef = useRef<VehicleId>(vehicleId)
  const qualityRef = useRef<QualityTier>(quality)
  const selectingRef = useRef(selecting)
  const launchedRef = useRef(launched)
  vehicleRef.current = vehicleId
  selectingRef.current = selecting
  launchedRef.current = launched
  const mountRef = useRef<HTMLDivElement>(null)
  const rocketRef = useRef<THREE.Group | null>(null)
  const nozzleGroupRef = useRef<THREE.Group | null>(null)
  const plumeRef = useRef<THREE.Mesh | null>(null)
  const plumeMaterialRef = useRef<THREE.ShaderMaterial | null>(null)
  const trenchLeftRef = useRef<THREE.Mesh | null>(null)
  const trenchRightRef = useRef<THREE.Mesh | null>(null)
  const trenchLeftMatRef = useRef<THREE.ShaderMaterial | null>(null)
  const trenchRightMatRef = useRef<THREE.ShaderMaterial | null>(null)
  const trenchCloudRef = useRef<THREE.Points | null>(null)
  const trenchCloudVel = useRef<Float32Array | null>(null)
  const trenchCloudAge = useRef<Float32Array | null>(null)
  const heatStrengthRef = useRef<{ value: number } | null>(null)
  const cloudPassRef = useRef<CloudPass | null>(null)
  const groundResultRef = useRef<GroundResult | null>(null)
  const starMatRef = useRef<THREE.PointsMaterial | null>(null)
  // Simulated recovery rig: a canopy Group (dome mesh) plus N suspension-
  // line cylinders converging to one riser attachment at the rocket's
  // nose. Everything here is parented to the SCENE directly, not to the
  // rocket body -- it used to be a rocket child, which meant it inherited
  // the body's full rotation: a tumbling or nose-down vehicle pointed the
  // "up" offset toward the ground and hid the chute behind/inside the
  // body.
  //
  // "Simulated" means the canopy doesn't just snap to a fixed offset
  // above the rocket -- chuteWorldPosRef/chuteWorldUpRef are a damped
  // spring target the canopy eases toward each frame, so a swinging or
  // tumbling body visibly drags the canopy's position (with lag) and the
  // canopy's own orientation independently eases toward "airflow-aligned"
  // (world up) rather than snapping there instantly or inheriting body
  // roll. The suspension lines are real CylinderGeometry, stretched and
  // aimed fresh every frame between each rim point and the nose -- not
  // THREE.Line (1px, no thickness control in WebGL, which is why the
  // single riser line in the previous version always read as "just a
  // black line" no matter what color/width was set on it).
  const chuteRef = useRef<THREE.Group | null>(null)
  const chuteCanopyRef = useRef<THREE.Mesh | null>(null)
  const chuteLinesRef = useRef<THREE.Mesh[]>([])
  const chuteScaleRef = useRef(0)
  // This vehicle's fixed riser length (nose to canopy, at full extension),
  // set once per vehicle in swapVehicle from rocketHeight.
  const chuteRiserLenRef = useRef(1)
  // Damped-spring state for the simulated rig -- current (eased) world
  // position and up-vector of the canopy, chasing a fresh target computed
  // from the rocket's live pose every frame. Not reset to the target
  // instantly, which is what gives the "rig" its lag/sway rather than a
  // canopy rigidly glued above the nose.
  const chutePosRef = useRef(new THREE.Vector3())
  const chuteUpRef = useRef(new THREE.Vector3(0, 1, 0))
  // Rig animation state: seconds since deploy, and the rendered body
  // attitude's pendulum (angle/rate, radians) plus how far the body has
  // blended from the physics attitude to "hanging under the canopy".
  const chuteRigRef = useRef({ deployT: 0, phi: 0, phiVel: 0, hang: 0, active: false })
  // Clears both smoke systems (trail + pad cloud) on "Fly again".
  const smokeResetRef = useRef<(() => void) | null>(null)
  const launchPadRef = useRef<LaunchPadRig | null>(null)
  const rafRef = useRef<number>(0)
  const clockRef = useRef(new THREE.Clock())

  useEffect(() => {
    const mountEl = mountRef.current
    if (!mountEl) return
    const mount: HTMLDivElement = mountEl

    const width = mount.clientWidth || 640
    const height = mount.clientHeight || 480

    const scene = new THREE.Scene()

    const skyUniforms = {
      topColor:    { value: new THREE.Color(0x00000f) },
      midColor:    { value: new THREE.Color(0x241a3d) },
      bottomColor: { value: new THREE.Color(0xe0875f) },
      offset:      { value: 0.05 },
      exponent:    { value: 0.5 }
    }
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(600000, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false
      })
    ))
    // No scene fog — the true-scale planet is 318 km radius in scene units;
    // fog would hide the entire globe.

    // ---- Starfield ----
    const STAR_COUNT = 2000
    const STAR_RADIUS = 500000
    const starPositions = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const sx = Math.sin(phi) * Math.cos(theta)
      const sy = Math.cos(phi)
      const sz = Math.sin(phi) * Math.sin(theta)
      starPositions[i * 3] = sx * STAR_RADIUS
      starPositions[i * 3 + 1] = sy * STAR_RADIUS
      starPositions[i * 3 + 2] = sz * STAR_RADIUS
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    const starMat = new THREE.PointsMaterial({
      color: 0xfff4e0,
      size: 2.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
    scene.add(new THREE.Points(starGeo, starMat))
    starMatRef.current = starMat

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 800000)
    camera.position.set(9, 4, 13)
    camera.lookAt(0, 3, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, true)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    // Set explicitly rather than relying on the three.js default. OutputPass
    // is the single place in this chain meant to do the linear -> sRGB
    // conversion; if outputColorSpace ever diverges from that assumption
    // (e.g. a future three.js version change, or someone setting it on the
    // renderer without checking this file), every intermediate pass -- which
    // all operate on the HDR linear buffer -- silently gets the wrong input.
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    // ---- Lighting ----
    scene.add(new THREE.AmbientLight(0xffffff, 0.28))
    const sun = new THREE.DirectionalLight(0xffddaa, 1.2)
    sun.position.set(6, 12, 6)
    sun.castShadow = true
    sun.shadow.mapSize.width = 2048
    sun.shadow.mapSize.height = 2048
    sun.shadow.camera.left = -8
    sun.shadow.camera.right = 8
    sun.shadow.camera.top = 12
    sun.shadow.camera.bottom = -4
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 30
    sun.shadow.bias = -0.001
    sun.shadow.camera.updateProjectionMatrix()
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x6a7bff, 0.3)
    fill.position.set(-6, 4, -4)
    scene.add(fill)

    // Warm light at the nozzle while the engine burns, so the rocket stays
    // lit and readable inside its own smoke. Always present (intensity 0
    // when off) so the light count -- part of every program key -- never changes.
    const engineLight = new THREE.PointLight(0xffa458, 0, 10, 2)
    scene.add(engineLight)
    const ignitionLight = new THREE.PointLight(0xff6600, 0, 8)
    ignitionLight.position.set(0, 0.5, 0)
    scene.add(ignitionLight)

    // ---- Sun disc ----
    // Position/color read directly from the sun light above.
    // No buildHorizon — the true-scale planet curvature IS the horizon.
    buildSun(scene, sun.position, sun.color)

    // ---- Cloud layers ----

    // ---- Ground ----
    const groundResult = buildGround()
    groundResultRef.current = groundResult
    scene.add(groundResult.group)

    // ---- Launch pad ----
    const padCanvas = document.createElement('canvas')
    padCanvas.width = 256; padCanvas.height = 256
    const padCtx = padCanvas.getContext('2d')!
    padCtx.fillStyle = '#2f2f33'; padCtx.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 1200; i++) {
      const x = Math.random() * 256; const y = Math.random() * 256
      const shade = 35 + Math.random() * 30
      padCtx.fillStyle = `rgba(${shade}, ${shade}, ${shade + 4}, ${0.1 + Math.random() * 0.2})`
      padCtx.fillRect(x, y, 1, 1)
    }
    padCtx.strokeStyle = 'rgba(10,10,12,0.85)'; padCtx.lineWidth = 3
    const padCell = 256 / 4
    for (let i = 0; i <= 4; i++) {
      padCtx.beginPath(); padCtx.moveTo(i * padCell, 0); padCtx.lineTo(i * padCell, 256); padCtx.stroke()
      padCtx.beginPath(); padCtx.moveTo(0, i * padCell); padCtx.lineTo(256, i * padCell); padCtx.stroke()
    }
    padCtx.fillStyle = 'rgba(15,15,17,0.9)'
    for (let gx = 0; gx < 4; gx++) {
      for (let gy = 0; gy < 4; gy++) {
        padCtx.beginPath(); padCtx.arc(gx * padCell + 8, gy * padCell + 8, 2.5, 0, Math.PI * 2); padCtx.fill()
      }
    }
    for (let gx = 0; gx < 4; gx++) {
      for (let gy = 0; gy < 4; gy++) {
        const bx = gx * padCell + 8; const by = gy * padCell + 8
        const wearGrad = padCtx.createRadialGradient(bx, by, 2.5, bx, by, 9 + Math.random() * 4)
        wearGrad.addColorStop(0, 'rgba(15,12,10,0.55)')
        wearGrad.addColorStop(1, 'rgba(15,12,10,0)')
        padCtx.fillStyle = wearGrad
        padCtx.beginPath(); padCtx.arc(bx, by, 13, 0, Math.PI * 2); padCtx.fill()
        for (let s = 0; s < 3; s++) {
          const angle = Math.random() * Math.PI * 2
          const dist = 6 + Math.random() * 6
          const sx = bx + Math.cos(angle) * dist; const sy = by + Math.sin(angle) * dist
          padCtx.fillStyle = `rgba(180,175,165,${0.15 + Math.random() * 0.15})`
          padCtx.beginPath(); padCtx.arc(sx, sy, 1 + Math.random() * 1.5, 0, Math.PI * 2); padCtx.fill()
        }
      }
    }
    const padTexture = new THREE.CanvasTexture(padCanvas)
    padTexture.wrapS = THREE.RepeatWrapping; padTexture.wrapT = THREE.RepeatWrapping; padTexture.repeat.set(3 / (2 * PAD_RADIUS), 3 / (2 * PAD_RADIUS))

    const padRoughCanvas = document.createElement('canvas')
    padRoughCanvas.width = 256; padRoughCanvas.height = 256
    const padRCtx = padRoughCanvas.getContext('2d')!
    padRCtx.fillStyle = 'rgb(204,204,204)'; padRCtx.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * 256; const y = Math.random() * 256
      const v = 150 + Math.random() * 90
      padRCtx.fillStyle = `rgba(${v}, ${v}, ${v}, 0.3)`
      padRCtx.beginPath(); padRCtx.arc(x, y, 3 + Math.random() * 8, 0, Math.PI * 2); padRCtx.fill()
    }
    padRCtx.strokeStyle = 'rgba(120,120,120,0.5)'; padRCtx.lineWidth = 5
    for (let i = 0; i <= 4; i++) {
      padRCtx.beginPath(); padRCtx.moveTo(i * padCell, 0); padRCtx.lineTo(i * padCell, 256); padRCtx.stroke()
      padRCtx.beginPath(); padRCtx.moveTo(0, i * padCell); padRCtx.lineTo(256, i * padCell); padRCtx.stroke()
    }
    const padRoughTexture = new THREE.CanvasTexture(padRoughCanvas)
    padRoughTexture.wrapS = THREE.RepeatWrapping; padRoughTexture.wrapT = THREE.RepeatWrapping; padRoughTexture.repeat.set(3 / (2 * PAD_RADIUS), 3 / (2 * PAD_RADIUS))

    // Pad disc minus the flame-trench band (padFootprint.ts): the pit and
    // launch mount live in buildLaunchPad.ts, the ground is cut to match.
    const padGeo = new THREE.ExtrudeGeometry(padShapes(), { depth: 0.16, bevelEnabled: false, curveSegments: 24 })
    padGeo.rotateX(-Math.PI / 2)
    const padMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: padTexture,
      roughnessMap: padRoughTexture, roughness: 0.8, metalness: 0.3
    })
    const pad = new THREE.Mesh(padGeo, padMat)
    // Top sits 0.01 above the ground surface so the ground can't z-fight through it.
    pad.position.y = -0.15; pad.castShadow = true; pad.receiveShadow = true; scene.add(pad)

    // ---- Pad structure ----
    function addStrut(
      from: THREE.Vector3, to: THREE.Vector3,
      radiusAtTo: number, radiusAtFrom: number,
      material: THREE.Material
    ): THREE.Mesh {
      const dir = new THREE.Vector3().subVectors(to, from)
      const length = dir.length()
      const geo = new THREE.CylinderGeometry(radiusAtTo, radiusAtFrom, length, 8)
      const mesh = new THREE.Mesh(geo, material)
      mesh.position.copy(from).addScaledVector(dir, 0.5)
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
      mesh.castShadow = true
      scene.add(mesh)
      return mesh
    }

    const structMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.55, metalness: 0.75 })

    // Rim: two arcs, broken where the trench cuts through the pad.
    const rimGap = Math.asin(Math.min(PAD_RADIUS * 0.2 / PAD_RADIUS + 0.02, 0.99))
    const rimArcs = [0, Math.PI].map((a0) => {
      const g = new THREE.TorusGeometry(PAD_RADIUS, 0.05, 8, 24, Math.PI - 2 * rimGap)
      g.rotateZ(a0 + rimGap)
      g.rotateX(Math.PI / 2)
      return g.toNonIndexed()
    })
    const padRimGeo = mergeGeometries(rimArcs)!
    const padRim = new THREE.Mesh(padRimGeo, structMat)
    padRim.castShadow = true
    scene.add(padRim)

    // (Buried pad legs + cone deflector removed: the open flame-trench pit,
    // launch mount and wedge deflector are built in buildLaunchPad.ts.)

    for (const angle of [Math.PI / 2, -Math.PI / 2]) {
      const outer = new THREE.Vector3(Math.cos(angle) * 2.15, 0.05, Math.sin(angle) * 2.15)
      const inner = new THREE.Vector3(Math.cos(angle) * 0.42, 0.32, Math.sin(angle) * 0.42)
      addStrut(inner, outer, 0.035, 0.05, structMat)
    }

    // Launch tower, swing arms, umbilicals and hold-down clamps (replaces
    // the old single tower box). Fitted per vehicle in swapVehicle().
    const padRig = buildLaunchPad()
    scene.add(padRig.group)
    launchPadRef.current = padRig

    // Static launch-center backdrop (VAB, blockhouse, fuel farm, ...).
    const complex = buildLaunchComplex(qualityRef.current)
    scene.add(complex.group)

    // ---- Flame trench ----
    const trenchGeo = new THREE.CylinderGeometry(0, 1, 0.2, 24, 1, false)
    trenchGeo.rotateZ(Math.PI / 2)
    const trenchLeftMat = new THREE.ShaderMaterial({
      uniforms: { progress: { value: 0.0 }, side: { value: -1.0 } },
      vertexShader: TRENCH_VERTEX, fragmentShader: TRENCH_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    })
    const trenchRightMat = new THREE.ShaderMaterial({
      uniforms: { progress: { value: 0.0 }, side: { value: 1.0 } },
      vertexShader: TRENCH_VERTEX, fragmentShader: TRENCH_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    })
    const trenchLeft = new THREE.Mesh(trenchGeo, trenchLeftMat)
    const trenchRight = new THREE.Mesh(trenchGeo.clone(), trenchRightMat)
    trenchLeft.position.set(-1.2, -0.3, 0); trenchRight.position.set(1.2, -0.3, 0)
    trenchLeft.visible = false; trenchRight.visible = false
    scene.add(trenchLeft); scene.add(trenchRight)
    trenchLeftRef.current = trenchLeft; trenchRightRef.current = trenchRight
    trenchLeftMatRef.current = trenchLeftMat; trenchRightMatRef.current = trenchRightMat

    // ---- Trench billboard cloud ----
    const trenchCloudCanvas = document.createElement('canvas')
    trenchCloudCanvas.width = 64; trenchCloudCanvas.height = 64
    const tcCtx = trenchCloudCanvas.getContext('2d')!
    const tcGrad = tcCtx.createRadialGradient(32, 32, 0, 32, 32, 32)
    tcGrad.addColorStop(0, 'rgba(255,255,255,0.9)')
    tcGrad.addColorStop(0.4, 'rgba(255,220,180,0.5)')
    tcGrad.addColorStop(1, 'rgba(255,180,120,0)')
    tcCtx.fillStyle = tcGrad; tcCtx.fillRect(0, 0, 64, 64)
    const trenchCloudTexture = new THREE.CanvasTexture(trenchCloudCanvas)
    const trenchCloudPositions = new Float32Array(TRENCH_CLOUD_COUNT * 3)
    const trenchCloudVelocities = new Float32Array(TRENCH_CLOUD_COUNT * 3)
    const trenchCloudAges = new Float32Array(TRENCH_CLOUD_COUNT)
    for (let i = 0; i < TRENCH_CLOUD_COUNT; i++) { trenchCloudPositions[i * 3 + 1] = -100; trenchCloudAges[i] = 999 }
    trenchCloudVel.current = trenchCloudVelocities; trenchCloudAge.current = trenchCloudAges
    const trenchCloudGeo = new THREE.BufferGeometry()
    trenchCloudGeo.setAttribute('position', new THREE.BufferAttribute(trenchCloudPositions, 3))
    const trenchCloudMat = new THREE.PointsMaterial({
      map: trenchCloudTexture, color: 0xffbb77, size: 1.4,
      transparent: true, opacity: 0, depthWrite: false,
      sizeAttenuation: true, blending: THREE.AdditiveBlending
    })
    const trenchCloud = new THREE.Points(trenchCloudGeo, trenchCloudMat)
    scene.add(trenchCloud); trenchCloudRef.current = trenchCloud

    // ---- Environment map ----
    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    const envRenderTarget = pmremGenerator.fromScene(scene, 0.04)
    const envMap = envRenderTarget.texture
    pmremGenerator.dispose()

    // ---- Rocket (swappable vehicle) ----
    // The group origin sits at the base of the engine skirt; rocketHeight is
    // used to pivot the model about its centre of gravity (the physics tracks
    // the CG, not the tail).
    let rocketHeight = 6
    let rocketRadius = 0.36
    let model: VehicleModel | null = null
    // Per-vehicle plume fit, measured on swap. The plume lives in
    // nozzleGroup-local space, which is scaled by the rocket's model scale
    // (realistic height * ALTITUDE_SCALE / raw model height), so lengths
    // in world units have to be divided by rocketScale before going into
    // the shader.
    let rocketScale = 1
    let canopyRadius = 1.1
    let nozzleExitY = 0     // nozzleGroup-local y of the nozzle exit plane
    let nozzleExitR = 0.2   // nozzleGroup-local radius of the engine cluster
    const nozzleBox = new THREE.Box3()
    const nozzleGeoBox = new THREE.Box3()
    function fitPlume(p: THREE.Mesh | null) {
      if (!p) return
      p.position.set(0, nozzleExitY, 0)
      const m = p.material as THREE.ShaderMaterial
      m.uniforms.uExitR.value = nozzleExitR * 0.8
    }

    // ---- Recovery parachute: round canopy + simulated suspension lines ----
    // Round conventional canopy: a hemisphere with its DOME facing up/away
    // from the rocket and its open skirt facing down toward it -- i.e. the
    // natural orientation of SphereGeometry's upper hemisphere (theta 0 to
    // PI/2), with NO extra rotation applied. The previous version applied
    // `canopy.rotation.x = Math.PI` on top of that upper-hemisphere
    // geometry specifically to "face it down," which instead flipped the
    // dome to point its flat cut-face up and its curve down -- the
    // upside-down/inverted look reported. Removing that rotation is the
    // actual fix; the geometry was already correct as built.
    const CANOPY_SEGMENTS = 12
    const chuteMat = new THREE.MeshStandardMaterial({
      color: 0xdd5522, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
    })
    const chuteGroup = new THREE.Group()
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1, CANOPY_SEGMENTS, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      chuteMat
    )
    chuteGroup.add(canopy)
    // Gore seams: a wireframe overlay traces the same hemisphere's
    // longitude lines, reading as the radial fabric-panel seams a real
    // round canopy has, without building custom gored geometry.
    const seamMat = new THREE.LineBasicMaterial({ color: 0x5a2a16, transparent: true, opacity: 0.55 })
    const seams = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1.002, CANOPY_SEGMENTS, 4, 0, Math.PI * 2, 0, Math.PI / 2)),
      seamMat
    )
    chuteGroup.add(seams)

    // Suspension lines: real CylinderGeometry (not THREE.Line, which in
    // WebGL has no usable width control and reads as a flat 1px stroke no
    // matter what's set on it -- the "just a black line" complaint). Each
    // is a thin cylinder stretched and aimed fresh every frame between a
    // rim point on the canopy skirt and the single riser attachment at the
    // rocket's nose, giving it visible, lit geometry/thickness like a real
    // cord bundle.
    const LINE_COUNT = 8
    const lineMat = new THREE.MeshStandardMaterial({ color: 0x3a2518, roughness: 0.8 })
    const lineGeom = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true)
    const lines: THREE.Mesh[] = []
    for (let i = 0; i < LINE_COUNT; i++) {
      const line = new THREE.Mesh(lineGeom, lineMat)
      scene.add(line) // scene-parented like the canopy, aimed in world space every frame
      lines.push(line)
    }

    // Riser/bridle: one thicker cord from the nose attach point up to the
    // confluence point where all suspension lines meet.
    const riserMat = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.8 })
    const riser = new THREE.Mesh(lineGeom, riserMat)
    riser.visible = false
    scene.add(riser)
    for (const line of lines) line.visible = false

    chuteGroup.visible = false
    scene.add(chuteGroup)
    chuteRef.current = chuteGroup
    chuteCanopyRef.current = canopy
    chuteLinesRef.current = lines

    // Stretch/aim a unit cylinder (lineGeom: height 1, radius 1, centred)
    // between two world points. No allocations: uses the scratch vectors.
    const aimDelta = new THREE.Vector3()
    function aimCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
      aimDelta.subVectors(to, from)
      const len = Math.max(aimDelta.length(), 0.001)
      mesh.position.copy(from).addScaledVector(aimDelta, 0.5)
      mesh.scale.set(radius, len, radius)
      mesh.quaternion.setFromUnitVectors(UP_AXIS, aimDelta.divideScalar(len))
      mesh.visible = true
    }
    function hideChuteRig() {
      chuteGroup.visible = false
      riser.visible = false
      for (const line of lines) line.visible = false
    }
    const rigTargetDir = new THREE.Vector3()
    const rigTmp = new THREE.Vector3()
    const rigAttach = new THREE.Vector3()
    const rigConfluence = new THREE.Vector3()
    const rigCanopy = new THREE.Vector3()
    const rigRim = new THREE.Vector3()
    const rigRight = new THREE.Vector3()
    const rigFwd = new THREE.Vector3()

    const swapVehicle = (id: VehicleId, q: QualityTier) => {
      // The plume is a child of nozzleGroup (see "---- Plume ----" below),
      // so pull it out before the old model (and its nozzleGroup) gets
      // disposed, or it would be destroyed along with the vehicle it's
      // leaving. Three.js's add() on a new parent reparents in place --
      // no geometry/material recreation needed, so this is cheap and
      // keeps the shader uniforms untouched. fitPlume() below re-seats it on
      // the new vehicle's nozzle exit plane.
      const plume = plumeRef.current
      if (plume) scene.add(plume)  // temporary parent so it survives the old model's disposal

      if (model) {
        scene.remove(model.rocket)
        model.dispose()
      }
      model = buildVehicle(id, q, envMap)
      const rocket = model.rocket
      scene.add(rocket)
      rocketRef.current = rocket
      nozzleGroupRef.current = model.nozzleGroup
      rocketHeight = model.height
      padRig.fit(rocket, rocketHeight, q)
      padRig.reset()
      const bb = new THREE.Box3().setFromObject(rocket)
      rocketRadius = Math.max(Math.abs(bb.min.x), bb.max.x, 0.3)
      rocketScale = rocket.scale.x
      // Nozzle exit plane + cluster radius, from the gimballed nozzle
      // meshes' own geometry (nozzleGroup children carry no transform).
      nozzleBox.makeEmpty()
      for (const c of model.nozzleGroup.children) {
        const g = (c as THREE.Mesh).geometry
        if (!g) continue
        g.computeBoundingBox()
        if (g.boundingBox) nozzleBox.union(nozzleGeoBox.copy(g.boundingBox))
      }
      if (!nozzleBox.isEmpty()) {
        nozzleExitY = nozzleBox.min.y
        nozzleExitR = Math.max(nozzleBox.max.x, -nozzleBox.min.x, nozzleBox.max.z, -nozzleBox.min.z)
      }
      // Scale the canopy to this vehicle's size -- a skinny strap-on
      // vehicle and the broad Steel vehicle both get a proportionate,
      // clearly visible chute. canopy/riser are scene-parented (see
      // chuteRef's declaration above), so this is the mesh's own local
      // scale, independent of the rocket's scale/rotation.
      canopyRadius = Math.max(rocketRadius * 2.2, 1.1)
      chuteCanopyRef.current?.scale.setScalar(canopyRadius)
      seams.scale.setScalar(canopyRadius)
      // Riser length was previously derived from canopyRadius (rocket
      // WIDTH), which for a typical thin rocket (radius ~0.3-0.5) came out
      // to just ~1.1-1.8 scene units -- a sliver next to a 5-6-unit-tall
      // rocket, so the canopy ended up hanging barely above the CG,
      // overlapping the mid-body exactly as reported ("appearing from the
      // middle of the rocket"). Sized off rocketHeight instead (the
      // rocket's actual scene-space length, already known not to be a
      // sliver), generous enough that the gap between nose and canopy
      // reads clearly at the zoom level this game actually plays at --
      // "a few feet" in real units is sub-pixel at this render scale (see
      // ALTITUDE_SCALE), so this is sized for on-screen legibility, not a
      // literal unit conversion.
      chuteRiserLenRef.current = Math.max(rocketHeight * 0.9, 2.5)
      chuteGroup.visible = false
      chuteScaleRef.current = 0
      // Reset the rig's spring state too -- otherwise a fresh launch could
      // start the canopy easing in from wherever the LAST flight's chute
      // ended up (e.g. down at the previous flight's crash site), a stray
      // visible snap/drag across the whole map on the very first deploy.
      chutePosRef.current.set(0, rocketHeight + chuteRiserLenRef.current, 0)
      chuteUpRef.current.set(0, 1, 0)

      if (plume) model.nozzleGroup.add(plume)
      fitPlume(plume)
    }
    swapRef.current = swapVehicle
    swapVehicle(vehicleRef.current, qualityRef.current)

    // Selection-screen camera and adaptive quality bookkeeping.
    const selectCam = new THREE.Vector3(1.2, 3.6, 11.5)
    const idleCam = new THREE.Vector3(9, 4, 13)
    let frameAcc = 0
    let frameN = 0
    let lastFrameT = performance.now()

    // ---- Plume ----
    // Parented to the nozzle group so it inherits the engine position,
    // gimbal tilt and the rocket's model scale. Geometry is an open unit
    // cylinder spanning local y in [-1, 0]: y = 0 sits on the nozzle exit
    // plane (fitPlume positions it there), y = -1 is the tail, so the
    // plume points DOWN out of the engine. The vertex shader sets the real
    // length (uLen) and radius profile.
    //
    // (Previous bug: a 0->1 cone translated by +height/2, i.e. pointing UP
    // into the rocket, with the shader computing t = -y/len, which was 0
    // for every vertex -> radius ~0 -> an invisible needle inside the body.)
    const plumeGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 40, true)
    plumeGeo.translate(0, -0.5, 0)
    const plumeMat = new THREE.ShaderMaterial({
      uniforms: {
        uLen: { value: 1 },
        uExitR: { value: 0.2 },
        uExpansion: { value: 0 },
        uTime: { value: 0 },
        uIntensity: { value: 0 },
      },
      vertexShader: PLUME_VERTEX, fragmentShader: PLUME_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    })
    const plume = new THREE.Mesh(plumeGeo, plumeMat)
    plume.visible = false
    plume.renderOrder = 999
    plume.frustumCulled = false
    nozzleGroupRef.current?.add(plume)
    plumeRef.current = plume; plumeMaterialRef.current = plumeMat
    fitPlume(plume)
    // Smoothed plume drivers (time-based easing in the render loop).
    let plumeThrottle = 0
    let plumeLenWorld = 0

    // ---- Liftoff smoke: ONE Points draw call, three particle pools ----
    // (see SmokeParticles.ts)
    //  POOL_TRAIL  : exhaust trail spawned at the plume tail each frame and
    //                left in world space, so the rocket outruns it.
    //  POOL_TRENCH : flame-trench cloud blasted sideways along the ground in
    //                both directions, slowing, rising and swelling.
    //  POOL_COLUMN : vertical column billowing up around the pad.
    // NormalBlending (smoke); the hot core glow stays additive (plume mesh,
    // trench fans, trench puffs). Pool sizes scale with the quality tier.
    const smokeQ = SMOKE_QUALITY[qualityRef.current]
    const smoke = new SmokeParticles([
      { count: Math.round(SMOKE_TRAIL.count * smokeQ), life: SMOKE_TRAIL.life, drag: 0.9, buoyancy: 0.15, turbulence: 0.8, groundY: 0.1 },
      { count: Math.round(SMOKE_TRENCH.count * smokeQ), life: SMOKE_TRENCH.life, drag: 0.6, buoyancy: 0.3, turbulence: 1.2, groundY: 0.2 },
      { count: Math.round(SMOKE_COLUMN.count * smokeQ), life: SMOKE_COLUMN.life, drag: 0.7, buoyancy: 0.55, turbulence: 1.0, groundY: 0.2 },
      { count: Math.round(SMOKE_STEAM.count * smokeQ), life: SMOKE_STEAM.life, drag: 1.2, buoyancy: 0.6, turbulence: 1.5, groundY: 0.1 },
    ], { opacity: SMOKE_OPACITY, smokeColor: 0xedf0f3, shadowColor: 0x6a6f78 })   // cool grey-white; warm comes from the engine glow
    smoke.setNearFade(SMOKE_NEAR_FADE[0], SMOKE_NEAR_FADE[1])
    smoke.points.renderOrder = 5     // after opaque + trench fans; the plume (999) still draws on top
    scene.add(smoke.points)
    smokeResetRef.current = () => smoke.reset()
    // World units -> drawing-buffer pixels at distance 1, for gl_PointSize.
    function smokePxPerUnit(cssHeight: number): number {
      return (cssHeight * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    }
    smoke.setPxPerUnit(smokePxPerUnit(height))
    let trailSpawnAcc = 0
    let trenchSpawnAcc = 0
    let columnSpawnAcc = 0
    let smokePrevValid = false
    const smokePrev = new THREE.Vector3()
    const smokeTail = new THREE.Vector3()
    const smokeExit = new THREE.Vector3()
    const smokeDir = new THREE.Vector3()
    const smokeQuat = new THREE.Quaternion()
    const smokeLerp = new THREE.Vector3()
    // Release sequence: sim time of physics liftoff (altitude first > 0.05 m).
    let firstRiseT = -1
    let steamSpawnAcc = 0
    let steamNozzle = 0
    // Launch camera hold (tripod position captured on the first flight frame).
    let camHoldValid = false
    const camHold = new THREE.Vector3()
    const camChase = new THREE.Vector3()
    const axisBase = new THREE.Vector3()
    const axisNose = new THREE.Vector3()

    // ---- Post-processing ----
    // The scene is rendered into a target that keeps a depth texture, which
    // the cloud pass reads so clouds composite against the real opaque depth.
    const pr = Math.min(window.devicePixelRatio, 2)
    const sceneTarget = new THREE.WebGLRenderTarget(width * pr, height * pr, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(width * pr, height * pr, THREE.UnsignedIntType)
    })
    const composer = new EffectComposer(renderer, sceneTarget)
    composer.setSize(width, height)
    composer.setPixelRatio(pr)
    // The composer clones the target for its second buffer; give the clone its
    // own depth texture so the cloud pass never samples the depth it writes to.
    composer.renderTarget2.depthTexture = new THREE.DepthTexture(width * pr, height * pr, THREE.UnsignedIntType)
    composer.addPass(new RenderPass(scene, camera))
    const cloudPass = new CloudPass(camera, scene, qualityRef.current)
    cloudPass.setSun(sun.position, sun.color)
    composer.addPass(cloudPass)
    cloudPassRef.current = cloudPass

    const heatUniforms = {
      tDiffuse:        { value: null as THREE.Texture | null },
      time:            { value: 0 },
      strength:        { value: 0 },
      frequency:       { value: 6.0 },
      aspect:          { value: width / height },
      rocketScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
      maskRadius:      { value: 0.35 }
    }
    heatStrengthRef.current = heatUniforms.strength
    const heatPass = new ShaderPass({
      uniforms: heatUniforms,
      vertexShader: HEAT_VERTEX_SHADER,
      fragmentShader: HEAT_FRAGMENT_SHADER
    })
    // Starts disabled: strength is 0 until a launch happens, and the
    // pre-launch/selection branch below never updates heatUniforms, so there
    // is nothing for this pass to do before the first launch.
    heatPass.enabled = false
    composer.addPass(heatPass)
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 1.1, 0.4, 0.8))

    const chromaUniforms = {
      tDiffuse: { value: null as THREE.Texture | null },
      strength: { value: 0 }
    }
    const chromaPass = new ShaderPass({
      uniforms: chromaUniforms,
      vertexShader: CHROMA_VERTEX_SHADER,
      fragmentShader: CHROMA_FRAGMENT_SHADER
    })
    // Same reasoning as heatPass.enabled above: nothing to do before launch.
    chromaPass.enabled = false
    composer.addPass(chromaPass)
    composer.addPass(new OutputPass())

    // Compile every material up front (including ones that start hidden:
    // plume, trench fans, chute) so the first ignition frame does not stall
    // on shader compilation -- and any GLSL error shows at page load.
    {
      const hidden: THREE.Object3D[] = [plume, trenchLeft, trenchRight, chuteGroup]
      for (const o of hidden) o.visible = true
      renderer.compile(scene, camera)
      for (const o of hidden) o.visible = false
    }

    const rocketWorldPos = new THREE.Vector3()

    // ---- Dynamic chase camera ----
    // Pulls back with altitude so the globe becomes visible as the rocket
    // climbs. At ground level the offset matches the old fixed chase camera;
    // at orbital altitude the camera sits far enough to frame the planet.
    const baseChaseOffset = new THREE.Vector3(4, 3.5, 16)
    const chaseOffset = baseChaseOffset.clone()
    // User-adjustable zoom multiplier: 1 = default, <1 zoomed in, >1 zoomed out.
    // Controlled via scroll wheel; clamped so the user can't lose the rocket.
    //
    // The camera looks at the CG (cgX, cgY, ...), but the plume/nozzle sits
    // at the model's BASE, which is `cgFromBase` units below the CG
    // (cgFromBase ~= 0.45 * rocketHeight once a vehicle is loaded). At the
    // old ZOOM_MIN of 0.15, baseChaseOffset's length (~16.6) scaled down to
    // a camera distance of ~2.5 units -- *less* than that CG-to-nozzle gap,
    // so the nozzle (and the plume anchored there) fell outside the
    // frustum below the look-at point: visible zoomed out, gone zoomed in.
    // Floor userZoom so camera distance at minimum zoom always stays a
    // healthy multiple of the CG-to-base offset, independent of vehicle
    // height (rocketHeight is in scope and updated on vehicle swap).
    let userZoom = 1
    const ZOOM_MAX = 6
    function minZoomForHeight(height: number): number {
      const cgOffsetEstimate = 0.45 * height
      const baseOffsetLength = baseChaseOffset.length()
      // Keep camera distance >= 2x the CG-to-base gap at minimum zoom.
      const floor = (2 * cgOffsetEstimate) / baseOffsetLength
      return Math.max(0.15, floor)
    }
    function updateChaseScale(altitudeSceneUnits: number) {
      // Re-floor userZoom here (not just on wheel events) so a vehicle
      // swap that changes rocketHeight can't leave userZoom stuck below
      // the new minimum (which would re-introduce the clipped-plume bug
      // without the user having touched the scroll wheel at all).
      userZoom = Math.max(userZoom, minZoomForHeight(rocketHeight))
      // altitudeSceneUnits is altitude * ALTITUDE_SCALE (0.05).
      // Gentler log ramp than before (×2.5 instead of ×4).
      const altKm = altitudeSceneUnits * 0.02 // 1 unit = 20m = 0.02 km
      const scale = (1 + Math.log1p(altKm * 0.5) * 2.5) * userZoom
      chaseOffset.copy(baseChaseOffset).multiplyScalar(scale)
    }
    // Scroll-wheel zoom: shift the multiplier geometrically so each notch
    // feels like the same percentage change regardless of current zoom.
    renderer.domElement.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12
      const zoomMin = minZoomForHeight(rocketHeight)
      userZoom = Math.max(zoomMin, Math.min(ZOOM_MAX, userZoom * factor))
    }, { passive: false })

    // ---- Render loop ----
    function animate() {
      // App keeps the last flight's snapshot in telemetryRef (and keeps
      // stepping that engine) after "Fly again" sets launched=false, so
      // reading it unconditionally would keep the camera and rocket stuck
      // on the finished flight and undo the [launched] reset effect below.
      const telemetry = launchedRef.current ? telemetryRef.current : null
      const r = rocketRef.current
      const ng = nozzleGroupRef.current
      const plume = plumeRef.current
      const plumeMat = plumeMaterialRef.current
      const tLeft = trenchLeftRef.current
      const tRight = trenchRightRef.current
      const tLeftMat = trenchLeftMatRef.current
      const tRightMat = trenchRightMatRef.current
      const elapsed = clockRef.current.getElapsedTime()
      cloudPassRef.current?.setTime(elapsed)

      const nowT = performance.now()
      const frameMs = nowT - lastFrameT
      lastFrameT = nowT
      const frameDt = Math.min(Math.max(frameMs / 1000, 0), 0.1)
      padRig.blink(elapsed)
      // Adaptive quality: if the average frame is slower than ~30 fps while
      // sitting on the pad, step the vehicle detail down one tier.
      if (frameMs < 250) { frameAcc += frameMs; frameN++ }
      if (frameN >= 90) {
        const avg = frameAcc / frameN
        frameAcc = 0; frameN = 0
        if (avg > 33 && !launchedRef.current && !telemetry) {
          const next: QualityTier | null =
            qualityRef.current === 'high' ? 'medium' : qualityRef.current === 'medium' ? 'low' : null
          if (next) {
            qualityRef.current = next
            swapVehicle(vehicleRef.current, next)
            cloudPassRef.current?.setQuality(next)
          }
        }
      }

      if (!telemetry) {
        // Nothing flight-related is drawn on the pad / selection screen.
        hideChuteRig()
        smokePrevValid = false
        plumeThrottle = 0
        firstRiseT = -1
        camHoldValid = false
        engineLight.intensity = 0
        smoke.setRocketAxis(null)
      }

      if (r && !telemetry) {
        // ---- Pad / selection: turntable + framing camera ----
        let padAttach = false
        if (selectingRef.current) {
          r.rotation.y += (frameMs / 1000) * 0.6
          camera.position.lerp(selectCam, 0.08)
          camera.lookAt(0, rocketHeight * 0.48, 0)
        } else {
          const turn = Math.PI * 2
          const target = Math.round(r.rotation.y / turn) * turn
          r.rotation.y += (target - r.rotation.y) * 0.12
          camera.position.lerp(idleCam, 0.08)
          camera.lookAt(0, 3, 0)
          // Arms swing in and clamps close once the turntable has settled.
          padAttach = Math.abs(target - r.rotation.y) < 0.05
        }
        padRig.updateIdle(padAttach, frameDt, r)
      }

      if (r && telemetry) {
        // ---- Pose: rotate the model about its centre of gravity ----
        // The physics state is the CG's position and the body's pitch angle.
        // The model's origin is at its base, so rotating the group directly
        // would swing the whole rocket around its tail. Instead place the CG
        // where the physics says it is and derive the base position from it.
        const dt = Math.min(Math.max(frameMs / 1000, 0), 0.1)
        const rig = chuteRigRef.current
        const deployed = telemetry.chuteState === 1
        const flying = telemetry.outcome === 'flying'
        const physPhi = -(telemetry.bodyAngle * Math.PI) / 180     // CCW-positive on screen

        // ---- Recovery rig, part 1: riser direction + hanging attitude ----
        // chuteUpRef is the unit direction from the attach point (nose) to
        // the canopy. The canopy streams opposite the AIR-relative velocity
        // (it trails upstream of the airflow); at low airspeed it falls back
        // to world up. Only the DIRECTION is smoothed -- the canopy is then
        // placed at exactly riser length from this frame's nose, so it can
        // never trail sideways behind a fast-moving rocket.
        if (deployed) {
          if (!rig.active) {
            rig.active = true
            rig.deployT = 0
            rig.phi = physPhi
            rig.phiVel = 0
            rig.hang = 0
            chuteScaleRef.current = 0
            // The riser pays out of the nose, along the body axis.
            chuteUpRef.current.set(-Math.sin(physPhi), Math.cos(physPhi), 0)
          }
          rig.deployT += dt
          const ax = telemetry.lateralVelocity - telemetry.windSpeed
          const ay = telemetry.velocity
          const az = telemetry.velocityZ
          const airspeed = Math.hypot(ax, ay, az)
          rigTargetDir.set(0, 1, 0)
          if (airspeed > 1e-3) {
            rigTmp.set(-ax / airspeed, -ay / airspeed, -az / airspeed)
            rigTargetDir.lerp(rigTmp, THREE.MathUtils.smoothstep(airspeed, 2, 12))
          }
          // Slow canopy sway once it is open.
          rigTargetDir.x += CHUTE_SWAY * chuteScaleRef.current * Math.sin(elapsed * 1.3)
          if (rigTargetDir.lengthSq() < 1e-6) rigTargetDir.set(0, 1, 0)
          rigTargetDir.normalize()
          chuteUpRef.current.lerp(rigTargetDir, 1 - Math.exp(-RISER_DIR_RATE * dt)).normalize()

          // Inflation: riser pays out first, canopy opens over ~1.5 s from
          // the nose; on touchdown/crash it deflates.
          chuteScaleRef.current = flying
            ? THREE.MathUtils.smoothstep(rig.deployT, 0.15, CHUTE_INFLATE_S)
            : chuteScaleRef.current * Math.exp(-1.5 * dt)

          // Hanging attitude: a damped pendulum chasing "body axis along
          // the riser", started from the tumble attitude at deploy, so the
          // body swings through and settles under the canopy.
          const hangTarget = flying ? 1 : 0
          rig.hang += (hangTarget - rig.hang) * (1 - Math.exp(-HANG_BLEND_RATE * dt))
          const phiHang = Math.atan2(-chuteUpRef.current.x, chuteUpRef.current.y)
          const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
          const h = dt / steps
          for (let s = 0; s < steps; s++) {
            const err = wrapAngle(rig.phi - phiHang)
            rig.phiVel += (-PEND_K * err - PEND_C * rig.phiVel) * h
            rig.phi += rig.phiVel * h
          }
        } else {
          if (rig.active) { rig.active = false; rig.deployT = 0; chuteScaleRef.current = 0 }
          rig.hang = 0
          rig.phi = physPhi
          rig.phiVel = 0
        }
        const phi = physPhi + rig.hang * wrapAngle(rig.phi - physPhi)

        // ---- Pose: rotate the model about its centre of gravity ----
        // The physics state is the CG's position and the body's pitch angle.
        // The model's origin is at its base, so rotating the group directly
        // would swing the whole rocket around its tail. Instead place the CG
        // where the physics says it is and derive the base position from it.
        const cgFromBase = telemetry.bodyLength > 0
          ? (1 - telemetry.centerOfGravity / telemetry.bodyLength) * rocketHeight
          : 0.45 * rocketHeight
        // telemetry.lateralOffset/altitude/positionZ are the physics engine's
        // launch-site-frame position (metres, +X East / +Y Up / +Z North),
        // converted through the one shared launchSiteToRender().
        const cgPosLS = launchSite(telemetry.lateralOffset, telemetry.altitude, telemetry.positionZ)
        const cgPosRender = launchSiteToRender(cgPosLS)
        const cgX = cgPosRender[0]
        const cgY = cgPosRender[1] + cgFromBase
        r.rotation.z = phi
        r.position.x = cgX + cgFromBase * Math.sin(phi)
        r.position.y = cgY - cgFromBase * Math.cos(phi)
        r.position.z = cgPosRender[2]
        // Keep any tilted body above the pad/ground (matters after a crash or
        // a landing at an angle; zero effect for an upright rocket).
        const lowest =
          r.position.y + Math.min(0, rocketHeight * Math.cos(phi)) - rocketRadius * Math.abs(Math.sin(phi))
        if (lowest < 0) r.position.y -= lowest

        // ---- Hold-down release sequence (visual only; pose is physics) ----
        // Clamps let go at RELEASE_T, or at the moment physics lifts off if
        // that comes first, so they never visibly hold a rising rocket.
        if (firstRiseT < 0 && telemetry.altitude > LIFTOFF_ALT_M) firstRiseT = telemetry.time
        const releaseT = firstRiseT >= 0 ? Math.min(PAD_RELEASE.RELEASE_T, firstRiseT) : PAD_RELEASE.RELEASE_T
        // Slight vibration while the engine runs against the clamps.
        if (telemetry.stage === 'powered-ascent' && telemetry.time < releaseT) {
          const amp = rocketHeight * HOLD_VIBRATION * plumeThrottle
          r.position.x += amp * Math.sin(elapsed * 71.0)
          r.position.z += amp * Math.sin(elapsed * 53.0 + 1.3)
        }
        padRig.updateFlight(telemetry.time, releaseT, frameDt, r)

        // ---- Nozzle gimbal rotation (frame-rate independent easing) ----
        if (ng) {
          ng.rotation.z += ((telemetry.gimbalAngle * Math.PI) / 180 - ng.rotation.z) * (1 - Math.exp(-10 * dt))
        }

        // ---- Recovery rig, part 2: place canopy, lines and riser ----
        // Everything is computed from THIS frame's final body pose, so the
        // riser starts exactly at the nose and every suspension line ends
        // exactly at the confluence point on the riser.
        if (rig.active && chuteScaleRef.current > 0.005) {
          const inflate = chuteScaleRef.current
          const up = chuteUpRef.current
          // Attach point = nose tip, along the body's own axis.
          rigAttach.set(-Math.sin(phi), Math.cos(phi), 0)
            .multiplyScalar(rocketHeight).add(r.position)
          const payout = THREE.MathUtils.smoothstep(rig.deployT, 0, RISER_PAYOUT_S)
          const riserLen = chuteRiserLenRef.current * payout
          rigConfluence.copy(rigAttach).addScaledVector(up, riserLen * RISER_FRACTION)
          rigCanopy.copy(rigAttach).addScaledVector(up, riserLen)

          chuteGroup.visible = true
          chuteGroup.position.copy(rigCanopy)
          chuteGroup.quaternion.setFromUnitVectors(UP_AXIS, up)
          const open = 0.08 + 0.92 * inflate
          chuteGroup.scale.setScalar(open)
          // Breathing: the canopy pulses wider/flatter, then taller/narrower.
          const breathe = 1 + CHUTE_BREATHE * inflate * Math.sin(elapsed * Math.PI * 2 * 0.7)
          canopy.scale.set(canopyRadius * breathe, canopyRadius * (2 - breathe), canopyRadius * breathe)
          seams.scale.copy(canopy.scale)

          const rimR = canopyRadius * breathe * open
          rigRight.set(1, 0, 0).applyQuaternion(chuteGroup.quaternion)
          rigFwd.set(0, 0, 1).applyQuaternion(chuteGroup.quaternion)
          const lines = chuteLinesRef.current
          const n = lines.length
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2
            rigRim.copy(rigCanopy)
              .addScaledVector(rigRight, Math.cos(ang) * rimR)
              .addScaledVector(rigFwd, Math.sin(ang) * rimR)
            aimCylinder(lines[i], rigRim, rigConfluence, LINE_RADIUS)
          }
          aimCylinder(riser, rigConfluence, rigAttach, RISER_RADIUS)
        } else {
          hideChuteRig()
        }

        // ---- Dynamic chase camera ----
        // Follow the CG; pull back with altitude to reveal the globe.
        updateChaseScale(metresToScene(telemetry.altitude))
        camChase.set(
          cgX + chaseOffset.x,
          cgY + chaseOffset.y,
          cgPosRender[2] + chaseOffset.z
        )
        // Launch shot: hold a fixed tripod position for the first seconds
        // (rocket framed and centred as it clears the tower), then ease
        // into the chase camera. Always looks at the CG.
        if (!camHoldValid) { camHold.copy(camChase); camHoldValid = true }
        const camBlend = THREE.MathUtils.smoothstep(telemetry.time, CAM_HOLD_S, CAM_HOLD_S + CAM_BLEND_S)
        camera.position.lerpVectors(camHold, camChase, camBlend)
        camera.lookAt(cgX, cgY, cgPosRender[2])
        // Ignition / liftoff shake: small, decaying, a few pixels.
        if (telemetry.stage === 'powered-ascent' && telemetry.time < SHAKE_S) {
          const fade = 1 - telemetry.time / SHAKE_S
          const amp = SHAKE_RAD * plumeThrottle * fade * fade
          camera.rotateX(amp * Math.sin(elapsed * 37.0))
          camera.rotateY(amp * Math.sin(elapsed * 29.0 + 1.7))
        }

        groundResultRef.current?.update(telemetry.altitude)

        const isThrusting = telemetry.stage === 'powered-ascent'

        if (plume && plumeMat) {
          // Engine-on gate from physics; throttle eased (time-based) so the
          // flame grows/shrinks instead of popping.
          const burning = isThrusting && telemetry.thrustNewtons > 0
          const thrTarget = burning ? THREE.MathUtils.clamp(telemetry.throttle, 0.3, 1) : 0
          plumeThrottle += (thrTarget - plumeThrottle) * (1 - Math.exp(-8 * dt))
          plume.visible = plumeThrottle > 0.02
          if (plume.visible) {
            // Vacuum expansion: the plume flares wider and longer as
            // ambient pressure drops with altitude.
            const expansion = 1.0 - Math.exp(-telemetry.altitude / 8500)
            // World-space length as a multiple of the rocket's height:
            // ~0.95x at liftoff (full throttle), up to ~2.2x in thin air.
            plumeLenWorld = rocketHeight * (PLUME_LEN_BASE + PLUME_LEN_THROTTLE * plumeThrottle) * (1 + PLUME_LEN_VACUUM * expansion)
            const u = plumeMat.uniforms
            u.uLen.value = plumeLenWorld / rocketScale     // nozzleGroup-local units
            u.uExpansion.value = expansion
            u.uIntensity.value = plumeThrottle
            // Wall-clock time for the flicker: telemetry.time is rounded to
            // 0.01 s, which made the fast flicker terms step unevenly.
            u.uTime.value = elapsed
          }
        }

        if (isThrusting && telemetry.time < 5) {
          ignitionLight.intensity = (1.0 - telemetry.time / 5) * 3.0 * (0.8 + Math.random() * 0.4)
          ignitionLight.position.y = r.position.y
        } else {
          ignitionLight.intensity = 0
        }

        const trenchActive = isThrusting && metresToScene(telemetry.altitude) < 8
        if (tLeft && tRight && tLeftMat && tRightMat) {
          tLeft.visible = trenchActive; tRight.visible = trenchActive
          if (trenchActive) {
            const trenchProgress = Math.min(metresToScene(telemetry.altitude) / 8, 1.0)
            tLeftMat.uniforms.progress.value = trenchProgress
            tRightMat.uniforms.progress.value = trenchProgress
          }
        }

        const tc = trenchCloudRef.current
        const tcVel = trenchCloudVel.current
        const tcAge = trenchCloudAge.current
        if (tc && tcVel && tcAge) {
          const trenchActiveNow = isThrusting && metresToScene(telemetry.altitude) < 8
          const trenchProgressNow = Math.min(metresToScene(telemetry.altitude) / 8, 1.0)
          const posAttr = tc.geometry.getAttribute('position') as THREE.BufferAttribute
          for (let i = 0; i < TRENCH_CLOUD_COUNT; i++) {
            const idx = i * 3
            if (trenchActiveNow && Math.random() < 0.2) {
              const side = Math.random() < 0.5 ? -1 : 1
              const spread = 0.3 + trenchProgressNow * 2.2
              posAttr.array[idx] = side * (1.2 + Math.random() * spread)
              posAttr.array[idx + 1] = -0.35 + Math.random() * 0.25
              posAttr.array[idx + 2] = (Math.random() - 0.5) * 1.4
              tcVel[idx] = side * (0.02 + Math.random() * 0.03)
              tcVel[idx + 1] = 0.005 + Math.random() * 0.01
              tcVel[idx + 2] = (Math.random() - 0.5) * 0.02
              tcAge[i] = 0
            } else if (tcAge[i] < 1.5) {
              posAttr.array[idx] += tcVel[idx]
              posAttr.array[idx + 1] += tcVel[idx + 1]
              posAttr.array[idx + 2] += tcVel[idx + 2]
              tcAge[i] += 1 / 60
            } else if (posAttr.array[idx + 1] !== -100) {
              posAttr.array[idx + 1] = -100
            }
          }
          posAttr.needsUpdate = true
          ;(tc.material as THREE.PointsMaterial).opacity = trenchActiveNow
            ? 0.7 * (1.0 - trenchProgressNow * 0.85) : 0
        }

        const alt = telemetry.altitude
        const heatRampUp = Math.min(alt / 400, 1.0)
        const heatThinAirFalloff = Math.exp(-Math.max(alt - HEAT_PEAK_ALTITUDE, 0) / HEAT_SCALE_HEIGHT)
        const heatTarget = isThrusting ? 0.008 * heatRampUp * heatThinAirFalloff : 0
        heatUniforms.strength.value += (heatTarget - heatUniforms.strength.value) * 0.1
        heatUniforms.time.value = elapsed
        // Skip the full-screen heat-distortion shader entirely once its
        // strength has decayed to effectively zero, instead of running it
        // every frame (including the whole pre-launch/selection screen,
        // where isThrusting is always false and heatTarget is always 0 --
        // the pass still executed in full with no visible effect).
        heatPass.enabled = heatUniforms.strength.value > 0.0005
        // maskRadius was a fixed 0.35 in normalized screen space, which only
        // made sense at the old fixed chase distance. With zoom now variable
        // (chaseOffset.length() changes with userZoom and altitude pullback),
        // a fixed radius either barely covers the rocket zoomed in or floods
        // empty sky around it zoomed out. Derive it from the actual current
        // camera distance so the masked area tracks the rocket's real
        // on-screen size instead of an arbitrary constant.
        const camDist = chaseOffset.length()
        heatUniforms.maskRadius.value = THREE.MathUtils.clamp(2.6 / camDist, 0.08, 0.6)

        rocketWorldPos.set(cgX, cgY, cgPosRender[2])
        rocketWorldPos.project(camera)
        heatUniforms.rocketScreenPos.value.set(
          (rocketWorldPos.x + 1) / 2,
          (rocketWorldPos.y + 1) / 2
        )

        const chromaT = THREE.MathUtils.clamp(
          (telemetry.altitude - CHROMA_ALTITUDE_START) / (CHROMA_ALTITUDE_FULL - CHROMA_ALTITUDE_START),
          0, 1
        )
        chromaUniforms.strength.value = chromaT * chromaT * (3 - 2 * chromaT) * CHROMA_MAX_STRENGTH
        // Below CHROMA_ALTITUDE_START this is exactly 0; skip the full-screen
        // pass entirely rather than run a no-op shader every frame (this also
        // covers the whole pre-launch/selection screen, where this branch
        // never executes at all and the pass previously ran unconditionally).
        chromaPass.enabled = chromaUniforms.strength.value > 0.00001

        const starT = THREE.MathUtils.clamp(
          (telemetry.altitude - STAR_FADE_START) / (STAR_FADE_FULL - STAR_FADE_START),
          0, 1
        )
        starMat.opacity = starT * starT * (3 - 2 * starT) * STAR_MAX_OPACITY
      }

      if (telemetry && r) {
        // ---- Liftoff smoke: trail + trench cloud + column ----
        const sdt = frameDt
        const alt = telemetry.altitude
        // Wind (m/s along +X) -> scene units/s; old smoke drifts downwind.
        smoke.setWind(metresToScene(telemetry.windSpeed), 0)
        // Air density (1 at sea level): thick trail low, thin trail high.
        const rho = THREE.MathUtils.clamp(telemetry.airDensity / 1.225, 0, 1)
        smoke.setDensity(1)

        const burning = !!plume && plume.visible
        if (burning && plume) {
          plume.getWorldQuaternion(smokeQuat)
          smokeDir.set(0, -1, 0).applyQuaternion(smokeQuat)
          plume.getWorldPosition(smokeExit)
          smokeTail.copy(smokeExit).addScaledVector(smokeDir, plumeLenWorld * 0.6)

          // Engine light on the rocket (real PointLight) and on the smoke near
          // the nozzle (shader glow), plus the ignition flash.
          engineLight.position.copy(smokeExit).addScaledVector(smokeDir, rocketHeight * 0.15)
          engineLight.distance = rocketHeight * ENGINE_LIGHT_RANGE
          engineLight.intensity = ENGINE_LIGHT_INTENSITY * plumeThrottle * (0.9 + 0.1 * Math.sin(elapsed * 41.0))

          // Deluge steam bursts from the pad nozzles during the first seconds.
          if (telemetry.time < SMOKE_STEAM.durationS && padRig.steamNozzles.length > 0) {
            const fade = 1 - telemetry.time / SMOKE_STEAM.durationS
            steamSpawnAcc += SMOKE_STEAM.rate * smokeQ * fade * sdt
            const ns = Math.min(Math.floor(steamSpawnAcc), 80)
            steamSpawnAcc = ns === 80 ? 0 : steamSpawnAcc - ns
            const s0 = metresToScene(SMOKE_STEAM.size0M), s1 = metresToScene(SMOKE_STEAM.size1M)
            for (let k = 0; k < ns; k++) {
              const nz = padRig.steamNozzles[steamNozzle]
              steamNozzle = (steamNozzle + 1) % padRig.steamNozzles.length
              const out = metresToScene(8 + Math.random() * 25)
              smoke.emit(POOL_STEAM,
                nz.x + (Math.random() - 0.5) * 0.15, nz.y + 0.05, nz.z + (Math.random() - 0.5) * 0.15,
                nz.dx * out + (Math.random() - 0.5) * 0.4, metresToScene(25 + Math.random() * 45), nz.dz * out + (Math.random() - 0.5) * 0.4,
                s0, s1, 0,
              )
            }
          }

          // Engine light on the smoke near the nozzle (plus the ignition flash).
          smoke.setGlow(plumeThrottle * 0.7 + ignitionLight.intensity * 0.15, smokeExit, rocketHeight * 1.6)

          // -- Trail: spawned along the path the plume tail moved this frame.
          //    Scales with throttle and air density, stops above ~12 km
          //    (the plume itself keeps burning).
          const trailCut = 1 - THREE.MathUtils.smoothstep(alt, SMOKE_TRAIL.fadeStartM, SMOKE_TRAIL.stopM)
          const trailEmit = plumeThrottle * (0.25 + 0.75 * rho) * trailCut
          if (!smokePrevValid || smokePrev.distanceToSquared(smokeTail) > 2500) smokePrev.copy(smokeTail)
          trailSpawnAcc += SMOKE_TRAIL.rate * smokeQ * trailEmit * sdt
          const n = Math.min(Math.floor(trailSpawnAcc), 200)
          trailSpawnAcc = n === 200 ? 0 : trailSpawnAcc - n
          const spread = nozzleExitR * rocketScale * 2
          const thin = 1 - rho                          // thinner air -> wider, fainter puffs
          const tS0 = metresToScene(SMOKE_TRAIL.size0M) * (1 + 1.5 * thin)
          const tS1 = metresToScene(SMOKE_TRAIL.size1M) * (1 + 1.2 * thin)
          for (let k = 0; k < n; k++) {
            smokeLerp.lerpVectors(smokePrev, smokeTail, (k + 1) / n)
            const sv = metresToScene(20 + Math.random() * 50)     // along the exhaust
            const jit = metresToScene(25)
            smoke.emit(POOL_TRAIL,
              smokeLerp.x + (Math.random() - 0.5) * spread,
              smokeLerp.y + (Math.random() - 0.5) * spread,
              smokeLerp.z + (Math.random() - 0.5) * spread,
              smokeDir.x * sv + (Math.random() - 0.5) * jit,
              smokeDir.y * sv + (Math.random() - 0.5) * jit,
              smokeDir.z * sv + (Math.random() - 0.5) * jit,
              tS0, tS1, 0.06,
            )
          }
          smokePrev.copy(smokeTail)
          smokePrevValid = true

          // -- Pad clouds: strongest while the plume is still hitting the
          //    pad, fading out as the nozzle climbs above padHeightM.
          const padStrength = Math.pow(THREE.MathUtils.clamp(1 - smokeExit.y / metresToScene(SMOKE_PAD_HEIGHT_M), 0, 1), 1.5)
          const padEmit = padStrength * plumeThrottle
          // Trench: blasted sideways out of the flame trench (along X), fast
          // at first, then slowing, rising and swelling.
          trenchSpawnAcc += SMOKE_TRENCH.rate * smokeQ * padEmit * sdt
          const m = Math.min(Math.floor(trenchSpawnAcc), 150)
          trenchSpawnAcc = m === 150 ? 0 : trenchSpawnAcc - m
          const trS0 = metresToScene(SMOKE_TRENCH.size0M), trS1 = metresToScene(SMOKE_TRENCH.size1M)
          for (let k = 0; k < m; k++) {
            const side = Math.random() < 0.5 ? -1 : 1
            const sp = metresToScene(SMOKE_TRENCH.speedMinMps + Math.random() * (SMOKE_TRENCH.speedMaxMps - SMOKE_TRENCH.speedMinMps))
            smoke.emit(POOL_TRENCH,
              side * (PAD_RADIUS * 0.7 + Math.random() * PAD_RADIUS * 0.5), 0.25 + Math.random() * 0.5, (Math.random() - 0.5) * PAD_RADIUS * 0.7,
              side * sp, sp * (0.05 + Math.random() * 0.15), (Math.random() - 0.8) * sp * 0.35,   // biased to -Z, away from the lens
              trS0, trS1, 0.05,
            )
          }
          // Column: billowing straight up around the pad (exhaust deflected
          // up + deluge steam).
          columnSpawnAcc += SMOKE_COLUMN.rate * smokeQ * padEmit * sdt
          const c = Math.min(Math.floor(columnSpawnAcc), 100)
          columnSpawnAcc = c === 100 ? 0 : columnSpawnAcc - c
          const cS0 = metresToScene(SMOKE_COLUMN.size0M), cS1 = metresToScene(SMOKE_COLUMN.size1M)
          for (let k = 0; k < c; k++) {
            const ang = Math.random() * Math.PI * 2
            const rad = PAD_RADIUS * (0.4 + Math.random() * 0.6)
            const out = metresToScene(15 + Math.random() * 45)
            const up = metresToScene(40 + Math.random() * 80)
            smoke.emit(POOL_COLUMN,
              Math.cos(ang) * rad, 0.3 + Math.random() * 0.6, Math.sin(ang) * rad,
              Math.cos(ang) * out, up, Math.sin(ang) * out,
              cS0, cS1, 0.035,
            )
          }
        } else {
          smokePrevValid = false
          smoke.setGlow(0, smokeExit, 1)
          engineLight.intensity = 0
        }
        // Keep the rocket readable: smoke thins around its body and in front of it.
        axisBase.set(0, 0, 0).applyMatrix4(r.matrixWorld)
        axisNose.set(-Math.sin(r.rotation.z), Math.cos(r.rotation.z), 0).multiplyScalar(rocketHeight).add(axisBase)
        smoke.setRocketAxis(axisBase, axisNose, rocketRadius * 1.2)
        smoke.update(sdt)
      }

      composer.render()
      rafRef.current = requestAnimationFrame(animate)
    }
    animate()

    // ---- Responsive sizing ----
    function handleResize() {
      const w = mount.clientWidth; const h = mount.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h; camera.updateProjectionMatrix()
      renderer.setSize(w, h, true); composer.setSize(w, h)
      heatUniforms.aspect.value = w / h
      smoke.setPxPerUnit(smokePxPerUnit(h))
    }
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize); resizeObserver.observe(mount)
    } else {
      window.addEventListener('resize', handleResize)
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      if (resizeObserver) { resizeObserver.disconnect() } else { window.removeEventListener('resize', handleResize) }
      cloudPassRef.current?.dispose()
      groundResultRef.current?.dispose()
      smoke.dispose()
      padRig.dispose()
      complex.dispose()
      heatPass.dispose()
      chromaPass.dispose()
      envRenderTarget.dispose()
      composer.dispose(); renderer.dispose(); mount.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    if (!launchedRef.current) swapRef.current?.(vehicleId, qualityRef.current)
  }, [vehicleId])

  useEffect(() => {
    qualityRef.current = quality
    cloudPassRef.current?.setQuality(quality)
    if (!launchedRef.current) swapRef.current?.(vehicleRef.current, quality)
  }, [quality])

  useEffect(() => {
    if (!launched && rocketRef.current) {
      rocketRef.current.position.x = 0
      rocketRef.current.position.y = 0
      rocketRef.current.rotation.z = 0
    }
    if (!launched) {
      if (plumeRef.current) plumeRef.current.visible = false
      if (trenchLeftRef.current) trenchLeftRef.current.visible = false
      if (trenchRightRef.current) trenchRightRef.current.visible = false
      if (trenchLeftMatRef.current) trenchLeftMatRef.current.uniforms.progress.value = 0
      if (trenchRightMatRef.current) trenchRightMatRef.current.uniforms.progress.value = 0
      if (trenchCloudAge.current) trenchCloudAge.current.fill(999)
      if (trenchCloudRef.current) (trenchCloudRef.current.material as THREE.PointsMaterial).opacity = 0
      if (heatStrengthRef.current) heatStrengthRef.current.value = 0
      if (nozzleGroupRef.current) nozzleGroupRef.current.rotation.z = 0
      if (starMatRef.current) starMatRef.current.opacity = 0
      if (chuteRef.current) chuteRef.current.visible = false
      for (const line of chuteLinesRef.current) line.visible = false
      chuteScaleRef.current = 0
      const rig = chuteRigRef.current
      rig.active = false; rig.deployT = 0; rig.hang = 0; rig.phiVel = 0
      smokeResetRef.current?.()
      launchPadRef.current?.reset()
    }
  }, [launched])

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', maxWidth: '960px', aspectRatio: '4 / 3', margin: '0 auto' }}
    />
  )
}