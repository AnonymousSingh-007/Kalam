import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { CloudLayer } from './CloudLayer'
import { buildRocket } from './buildRocket'
import { buildGround, type GroundResult } from './buildGround'
import type { Telemetry } from '../types'

interface SceneProps {
  telemetryRef: React.MutableRefObject<Telemetry | null>
  launched: boolean
}

const ALTITUDE_SCALE = 0.05
const GROUND_CLOUD_COUNT = 260
const GROUND_CLOUD_WINDOW = 3.0
const TRENCH_CLOUD_COUNT = 140
const HEAT_PEAK_ALTITUDE = 1200
const HEAT_SCALE_HEIGHT = 8500
const CHROMA_ALTITUDE_START = 6000
const CHROMA_ALTITUDE_FULL = 15000
const CHROMA_MAX_STRENGTH = 0.003
const STAR_FADE_START = 5000
const STAR_FADE_FULL = 15000
const STAR_MAX_OPACITY = 0.9

const PLUME_VERTEX = `
  uniform float expansionFactor;
  uniform float time;
  varying float vY;
  varying float vRadius;
  varying float vFresnel;

  void main() {
    vec3 pos = position;
    float t = clamp(-pos.y, 0.0, 1.0);
    float machDisc = 1.0 - 0.35 * sin(t * 3.14159 * 3.0) * (1.0 - expansionFactor);
    float baseRadius = t * (0.18 + expansionFactor * 0.55) * machDisc;
    float flutter = 0.018 * sin(time * 8.0 + t * 12.0) * cos(time * 5.5 + t * 7.0);
    baseRadius += flutter * (0.4 + expansionFactor * 0.6);
    pos.x = pos.x * baseRadius * 2.0;
    pos.z = pos.z * baseRadius * 2.0;
    vY = t;
    vRadius = baseRadius;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vec3 transformedNormal = normalize(normalMatrix * normal);
    vec3 viewDir = normalize(-mvPosition.xyz);
    vFresnel = 1.0 - abs(dot(viewDir, transformedNormal));
    gl_Position = projectionMatrix * mvPosition;
  }
`

const PLUME_FRAGMENT = `
  uniform float expansionFactor;
  varying float vY;
  varying float vRadius;
  varying float vFresnel;

  void main() {
    float core = 1.0 - smoothstep(0.0, 0.35, vY);
    float mid  = smoothstep(0.0, 0.5, vY) * (1.0 - smoothstep(0.5, 1.0, vY));
    float edge = smoothstep(0.6, 1.0, vY);
    vec3 coreColor = vec3(1.0, 0.97, 0.88);
    vec3 midColor  = vec3(1.0, 0.55, 0.12);
    vec3 edgeColor = vec3(0.6, 0.15, 0.05);
    vec3 color = coreColor * core + midColor * mid + edgeColor * edge;
    float opacity = (1.0 - vY * 0.85) * (0.9 - expansionFactor * 0.3);
    float rimSoftness = 2.2;
    float edgeFade = 1.0 - pow(vFresnel, rimSoftness);
    opacity *= mix(0.35, 1.0, edgeFade);
    opacity = clamp(opacity, 0.0, 1.0);
    gl_FragColor = vec4(color, opacity);
  }
`

const TRENCH_VERTEX = `
  uniform float progress;
  uniform float side;
  varying float vDist;

  void main() {
    vec3 pos = position;
    pos.x *= (0.3 + progress * 2.2) * side;
    pos.y = pos.y * 0.4;
    vDist = length(pos.xz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const TRENCH_FRAGMENT = `
  uniform float progress;
  varying float vDist;

  void main() {
    float heat = 1.0 - smoothstep(0.0, 2.5, vDist);
    vec3 hotColor  = vec3(1.0, 0.92, 0.7);
    vec3 coolColor = vec3(0.8, 0.25, 0.05);
    vec3 color = mix(coolColor, hotColor, heat);
    float opacity = heat * (1.0 - progress * 0.85) * 0.9;
    gl_FragColor = vec4(color, clamp(opacity, 0.0, 1.0));
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

export function Scene({ telemetryRef, launched }: SceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rocketRef = useRef<THREE.Group | null>(null)
  const nozzleGroupRef = useRef<THREE.Group | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const particleVelocities = useRef<Float32Array | null>(null)
  const groundCloudRef = useRef<THREE.Points | null>(null)
  const groundCloudVel = useRef<Float32Array | null>(null)
  const groundCloudAge = useRef<Float32Array | null>(null)
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
  const cumulusLayerRef = useRef<CloudLayer | null>(null)
  const stratusLayerRef = useRef<CloudLayer | null>(null)
  const cirrusLayerRef = useRef<CloudLayer | null>(null)
  const groundResultRef = useRef<GroundResult | null>(null)
  const starMatRef = useRef<THREE.PointsMaterial | null>(null)
  const chuteRef = useRef<THREE.Mesh | null>(null)
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
      new THREE.SphereGeometry(2000, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false
      })
    ))
    scene.fog = new THREE.Fog(0xcf7c5c, 40, 600)

    // ---- Starfield ----
    const STAR_COUNT = 2000
    const STAR_RADIUS = 1900
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

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 4000)
    camera.position.set(9, 4, 13)
    camera.lookAt(0, 3, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, true)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
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

    const ignitionLight = new THREE.PointLight(0xff6600, 0, 8)
    ignitionLight.position.set(0, 0.5, 0)
    scene.add(ignitionLight)

    // ---- Cloud layers ----
    cumulusLayerRef.current = new CloudLayer(scene, 'cumulus', 30, 100, 0.65)
    stratusLayerRef.current = new CloudLayer(scene, 'stratus', 0, 30, 0.4)
    cirrusLayerRef.current  = new CloudLayer(scene, 'cirrus', 300, 600, 0.5)

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
    padTexture.wrapS = THREE.RepeatWrapping; padTexture.wrapT = THREE.RepeatWrapping; padTexture.repeat.set(3, 3)

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
    padRoughTexture.wrapS = THREE.RepeatWrapping; padRoughTexture.wrapT = THREE.RepeatWrapping; padRoughTexture.repeat.set(3, 3)

    const padGeo = new THREE.CylinderGeometry(2.2, 2.2, 0.16, 24)
    const padMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: padTexture,
      roughnessMap: padRoughTexture, roughness: 0.8, metalness: 0.3
    })
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.y = -0.08; pad.castShadow = true; pad.receiveShadow = true; scene.add(pad)

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
    const deflectorMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.7, metalness: 0.6 })

    const padRimGeo = new THREE.TorusGeometry(2.2, 0.05, 8, 32)
    const padRim = new THREE.Mesh(padRimGeo, structMat)
    padRim.rotation.x = Math.PI / 2
    padRim.castShadow = true
    scene.add(padRim)

    const LEG_COUNT = 6
    for (let i = 0; i < LEG_COUNT; i++) {
      const angle = (i / LEG_COUNT) * Math.PI * 2
      const top = new THREE.Vector3(Math.cos(angle) * 1.75, -0.15, Math.sin(angle) * 1.75)
      const bottom = new THREE.Vector3(Math.cos(angle) * 1.95, -0.5, Math.sin(angle) * 1.95)
      addStrut(top, bottom, 0.05, 0.07, structMat)
    }

    const deflector = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 0.3, 4, 1, true),
      deflectorMat
    )
    deflector.rotation.y = Math.PI / 4
    deflector.position.y = -0.42
    deflector.castShadow = true
    scene.add(deflector)

    for (const angle of [Math.PI / 2, -Math.PI / 2]) {
      const outer = new THREE.Vector3(Math.cos(angle) * 2.15, 0.05, Math.sin(angle) * 2.15)
      const inner = new THREE.Vector3(Math.cos(angle) * 0.42, 0.32, Math.sin(angle) * 0.42)
      addStrut(inner, outer, 0.035, 0.05, structMat)
    }

    const towerGeo = new THREE.BoxGeometry(0.15, 6, 0.15)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x555555 })
    const tower = new THREE.Mesh(towerGeo, towerMat)
    tower.position.set(2.6, 2.75, 0); scene.add(tower)

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

    // ---- Rocket ----
    const { rocket, nozzleGroup } = buildRocket(scene, envMap)
    rocketRef.current = rocket
    nozzleGroupRef.current = nozzleGroup

    // ---- Descent/recovery chute ----
    const rocketTopY = new THREE.Box3().setFromObject(rocket).max.y
    const chuteMat = new THREE.MeshStandardMaterial({ color: 0xdd5522, roughness: 0.8, metalness: 0.0 })
    const chute = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 12, 1, true), chuteMat)
    chute.rotation.x = Math.PI
    chute.position.y = rocketTopY + 0.3
    chute.visible = false
    rocket.add(chute)
    chuteRef.current = chute

    // ---- Plume ----
    const plumeGeo = new THREE.CylinderGeometry(0, 1, 1.5, 24, 32, true)
    plumeGeo.rotateX(Math.PI)
    const plumeMat = new THREE.ShaderMaterial({
      uniforms: { expansionFactor: { value: 0.0 }, time: { value: 0.0 } },
      vertexShader: PLUME_VERTEX, fragmentShader: PLUME_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    })
    const plume = new THREE.Mesh(plumeGeo, plumeMat)
    plume.visible = false; scene.add(plume)
    plumeRef.current = plume; plumeMaterialRef.current = plumeMat

    // ---- Exhaust particles ----
    const PARTICLE_COUNT = 200
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const velocities = new Float32Array(PARTICLE_COUNT * 3)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = 0; positions[i * 3 + 1] = 0; positions[i * 3 + 2] = 0
      velocities[i * 3] = 0; velocities[i * 3 + 1] = 0; velocities[i * 3 + 2] = 0
    }
    particleVelocities.current = velocities
    const particleGeo = new THREE.BufferGeometry()
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const particleMat = new THREE.PointsMaterial({ color: 0xffaa33, size: 0.15, transparent: true, opacity: 0.8 })
    const particles = new THREE.Points(particleGeo, particleMat)
    scene.add(particles); particlesRef.current = particles

    // ---- Ground ignition cloud ----
    const cloudPositions = new Float32Array(GROUND_CLOUD_COUNT * 3)
    const cloudVel = new Float32Array(GROUND_CLOUD_COUNT * 3)
    const cloudAge = new Float32Array(GROUND_CLOUD_COUNT)
    for (let i = 0; i < GROUND_CLOUD_COUNT; i++) { cloudPositions[i * 3 + 1] = -100; cloudAge[i] = 999 }
    groundCloudVel.current = cloudVel; groundCloudAge.current = cloudAge
    const cloudGeo = new THREE.BufferGeometry()
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(cloudPositions, 3))
    const cloudMat = new THREE.PointsMaterial({ color: 0xf0f0f0, size: 1.1, transparent: true, opacity: 0.75, depthWrite: false, sizeAttenuation: true })
    const groundCloud = new THREE.Points(cloudGeo, cloudMat)
    scene.add(groundCloud); groundCloudRef.current = groundCloud

    // ---- Post-processing ----
    const composer = new EffectComposer(renderer)
    composer.setSize(width, height)
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    composer.addPass(new RenderPass(scene, camera))

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
    composer.addPass(chromaPass)
    composer.addPass(new OutputPass())

    const rocketWorldPos = new THREE.Vector3()

    // ---- Fixed-offset chase camera ----
    // Equidistant from the rocket at all times — the offset vector is
    // constant, applied fresh each frame relative to the rocket's current
    // world position, so the camera moves in lockstep on every axis.
    const chaseOffset = new THREE.Vector3(9, 4, 13)

    // ---- Render loop ----
    function animate() {
      const telemetry = telemetryRef.current
      const r = rocketRef.current
      const ng = nozzleGroupRef.current
      const p = particlesRef.current
      const gc = groundCloudRef.current
      const plume = plumeRef.current
      const plumeMat = plumeMaterialRef.current
      const tLeft = trenchLeftRef.current
      const tRight = trenchRightRef.current
      const tLeftMat = trenchLeftMatRef.current
      const tRightMat = trenchRightMatRef.current
      const elapsed = clockRef.current.getElapsedTime()

      if (r && telemetry) {
        r.position.y = telemetry.altitude * ALTITUDE_SCALE
        r.position.x = telemetry.lateralOffset * ALTITUDE_SCALE
        r.rotation.z = -(telemetry.bodyAngle * Math.PI) / 180

        // ---- Nozzle gimbal rotation ----
        if (ng) {
          ng.rotation.z = THREE.MathUtils.lerp(
            ng.rotation.z,
            (telemetry.gimbalAngle * Math.PI) / 180,
            0.15
          )
        }

        if (p) {
          const zoomFactor = Math.min(r.position.y / 15, 1)
          ;(p.material as THREE.PointsMaterial).size = 0.15 + zoomFactor * 0.25
        }

        // ---- Descent/recovery chute ----
        if (chuteRef.current) {
          chuteRef.current.visible = telemetry.stage === 'apogee' || telemetry.stage === 'descent'
        }

        // ---- Fixed-offset chase camera ----
        camera.position.set(
          r.position.x + chaseOffset.x,
          r.position.y + chaseOffset.y,
          r.position.z + chaseOffset.z
        )
        camera.lookAt(r.position.x, r.position.y + 1, r.position.z)

        cumulusLayerRef.current?.update(elapsed, camera.position)
        stratusLayerRef.current?.update(elapsed, camera.position)
        cirrusLayerRef.current?.update(elapsed, camera.position)
        groundResultRef.current?.update(telemetry.altitude)

        const isThrusting = telemetry.stage === 'powered-ascent'

        if (plume && plumeMat) {
          plume.visible = isThrusting
          if (isThrusting) {
            const expansionFactor = 1.0 - Math.exp(-telemetry.altitude / 8500)
            plumeMat.uniforms.expansionFactor.value = expansionFactor
            plumeMat.uniforms.time.value = elapsed
            plume.position.set(r.position.x, r.position.y, r.position.z)
            // Plume is a standalone scene object (not parented to the
            // rocket group), so it needs the full world-space tilt:
            // body angle plus the nozzle's own gimbal deflection relative
            // to that body.
            plume.rotation.z = r.rotation.z + (telemetry.gimbalAngle * Math.PI) / 180
          }
        }

        if (isThrusting && telemetry.time < 5) {
          ignitionLight.intensity = (1.0 - telemetry.time / 5) * 3.0 * (0.8 + Math.random() * 0.4)
          ignitionLight.position.y = r.position.y
        } else {
          ignitionLight.intensity = 0
        }

        const trenchActive = isThrusting && telemetry.altitude * ALTITUDE_SCALE < 8
        if (tLeft && tRight && tLeftMat && tRightMat) {
          tLeft.visible = trenchActive; tRight.visible = trenchActive
          if (trenchActive) {
            const trenchProgress = Math.min(telemetry.altitude * ALTITUDE_SCALE / 8, 1.0)
            tLeftMat.uniforms.progress.value = trenchProgress
            tRightMat.uniforms.progress.value = trenchProgress
          }
        }

        const tc = trenchCloudRef.current
        const tcVel = trenchCloudVel.current
        const tcAge = trenchCloudAge.current
        if (tc && tcVel && tcAge) {
          const trenchActiveNow = isThrusting && telemetry.altitude * ALTITUDE_SCALE < 8
          const trenchProgressNow = Math.min(telemetry.altitude * ALTITUDE_SCALE / 8, 1.0)
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

        rocketWorldPos.set(r.position.x, r.position.y + 1, r.position.z)
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

        const starT = THREE.MathUtils.clamp(
          (telemetry.altitude - STAR_FADE_START) / (STAR_FADE_FULL - STAR_FADE_START),
          0, 1
        )
        starMat.opacity = starT * starT * (3 - 2 * starT) * STAR_MAX_OPACITY
      }

      if (p && telemetry) {
        const isThrusting = telemetry.stage === 'powered-ascent'
        const posAttr = p.geometry.getAttribute('position') as THREE.BufferAttribute
        const vel = particleVelocities.current!
        const baseY = r ? r.position.y : 0
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const idx = i * 3
          if (isThrusting && Math.random() < 0.3) {
            posAttr.array[idx] = (Math.random() - 0.5) * 0.25
            posAttr.array[idx + 1] = baseY
            posAttr.array[idx + 2] = (Math.random() - 0.5) * 0.25
            vel[idx] = (Math.random() - 0.5) * 0.05
            vel[idx + 1] = -Math.random() * 0.1 - 0.05
            vel[idx + 2] = (Math.random() - 0.5) * 0.05
          } else {
            posAttr.array[idx] += vel[idx]
            posAttr.array[idx + 1] += vel[idx + 1]
            posAttr.array[idx + 2] += vel[idx + 2]
          }
        }
        posAttr.needsUpdate = true
      }

      if (gc && telemetry) {
        const posAttr = gc.geometry.getAttribute('position') as THREE.BufferAttribute
        const vel = groundCloudVel.current!
        const age = groundCloudAge.current!
        const spawning = telemetry.stage === 'powered-ascent' && telemetry.time < GROUND_CLOUD_WINDOW
        const dt = 1 / 60
        for (let i = 0; i < GROUND_CLOUD_COUNT; i++) {
          const idx = i * 3
          if (spawning && Math.random() < 0.15) {
            const angle = Math.random() * Math.PI * 2
            const radius = Math.random() * 1.2
            posAttr.array[idx] = Math.cos(angle) * radius
            posAttr.array[idx + 1] = -0.3
            posAttr.array[idx + 2] = Math.sin(angle) * radius
            const outSpeed = 0.03 + Math.random() * 0.05
            vel[idx] = Math.cos(angle) * outSpeed
            vel[idx + 1] = 0.01 + Math.random() * 0.015
            vel[idx + 2] = Math.sin(angle) * outSpeed
            age[i] = 0
          } else if (age[i] < 4) {
            posAttr.array[idx] += vel[idx]
            posAttr.array[idx + 1] += vel[idx + 1]
            posAttr.array[idx + 2] += vel[idx + 2]
            vel[idx] *= 0.98; vel[idx + 2] *= 0.98; age[i] += dt
          } else if (posAttr.array[idx + 1] !== -100) {
            posAttr.array[idx + 1] = -100
          }
        }
        posAttr.needsUpdate = true
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
      cumulusLayerRef.current?.dispose()
      stratusLayerRef.current?.dispose()
      cirrusLayerRef.current?.dispose()
      groundResultRef.current?.dispose()
      heatPass.dispose()
      chromaPass.dispose()
      envRenderTarget.dispose()
      composer.dispose(); renderer.dispose(); mount.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    if (!launched && rocketRef.current) {
      rocketRef.current.position.y = 0
      rocketRef.current.rotation.z = 0
    }
    if (!launched) {
      if (groundCloudAge.current) groundCloudAge.current.fill(999)
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
    }
  }, [launched])

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', maxWidth: '960px', aspectRatio: '4 / 3', margin: '0 auto' }}
    />
  )
}