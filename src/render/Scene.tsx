import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Telemetry } from '../types'

interface SceneProps {
  telemetryRef: React.MutableRefObject<Telemetry | null>
  launched: boolean
}

const ALTITUDE_SCALE = 0.05 // meters -> scene units, tune for visual pacing
const GROUND_CLOUD_COUNT = 260
const GROUND_CLOUD_WINDOW = 3.0 // seconds after ignition the cloud keeps billowing

// Standard three-stop "sky dome" gradient shader: world-space height (y of the
// normalized direction from the sphere's center) drives two chained mixes,
// bottom->mid->top. Static uniforms only — no per-frame recalculation.
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
  const particlesRef = useRef<THREE.Points | null>(null)
  const particleVelocities = useRef<Float32Array | null>(null)
  const groundCloudRef = useRef<THREE.Points | null>(null)
  const groundCloudVel = useRef<Float32Array | null>(null)
  const groundCloudAge = useRef<Float32Array | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const mountEl = mountRef.current
    if (!mountEl) return
    const mount: HTMLDivElement = mountEl

    const width = mount.clientWidth || 640
    const height = mount.clientHeight || 480

    // ---- Core scene setup ----
    const scene = new THREE.Scene()

    // Sky gradient dome — large inverted sphere, static shader (no per-frame
    // uniform updates). Deep-space top, blue-purple midtone, warm horizon
    // glow at the bottom for a dawn-launch feel.
    const skyUniforms = {
      topColor: { value: new THREE.Color(0x00000f) },
      midColor: { value: new THREE.Color(0x241a3d) },
      bottomColor: { value: new THREE.Color(0xe0875f) },
      offset: { value: 0.05 },
      exponent: { value: 0.5 }
    }
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(500, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: skyUniforms,
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false
      })
    )
    scene.add(sky)

    // Fog color roughly matches the sky's horizon glow so distant geometry
    // fades into the gradient instead of a mismatched flat-color wall.
    scene.fog = new THREE.Fog(0xcf7c5c, 20, 80)

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
    camera.position.set(9, 4, 13)
    camera.lookAt(0, 3, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, true)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    // ---- Lighting ----
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(6, 12, 6)
    sun.castShadow = true
    sun.shadow.mapSize.width = 2048
    sun.shadow.mapSize.height = 2048
    // Frustum sized around the pad + low-altitude flight, not the full 80x80 ground —
    // first-pass numbers, eyeball/tune against the actual camera framing if needed.
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

    // ---- Launch pad ----
    // Procedural grating/panel-seam texture — same canvas-texture technique as
    // the scorch mark below, generated up front instead of loaded as an asset.
    const padCanvas = document.createElement('canvas')
    padCanvas.width = 256
    padCanvas.height = 256
    const padCtx = padCanvas.getContext('2d')!
    padCtx.fillStyle = '#2f2f33'
    padCtx.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 1200; i++) {
      const x = Math.random() * 256
      const y = Math.random() * 256
      const shade = 35 + Math.random() * 30
      padCtx.fillStyle = `rgba(${shade}, ${shade}, ${shade + 4}, ${0.1 + Math.random() * 0.2})`
      padCtx.fillRect(x, y, 1, 1)
    }
    padCtx.strokeStyle = 'rgba(10,10,12,0.85)'
    padCtx.lineWidth = 3
    const padCell = 256 / 4
    for (let i = 0; i <= 4; i++) {
      padCtx.beginPath()
      padCtx.moveTo(i * padCell, 0)
      padCtx.lineTo(i * padCell, 256)
      padCtx.stroke()
      padCtx.beginPath()
      padCtx.moveTo(0, i * padCell)
      padCtx.lineTo(256, i * padCell)
      padCtx.stroke()
    }
    padCtx.fillStyle = 'rgba(15,15,17,0.9)'
    for (let gx = 0; gx < 4; gx++) {
      for (let gy = 0; gy < 4; gy++) {
        padCtx.beginPath()
        padCtx.arc(gx * padCell + 8, gy * padCell + 8, 2.5, 0, Math.PI * 2)
        padCtx.fill()
      }
    }
    const padTexture = new THREE.CanvasTexture(padCanvas)
    padTexture.wrapS = THREE.RepeatWrapping
    padTexture.wrapT = THREE.RepeatWrapping
    padTexture.repeat.set(3, 3)

    const padGeo = new THREE.CylinderGeometry(2, 2.2, 0.5, 24)
    const padMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: padTexture,
      roughness: 0.8,
      metalness: 0.3
    })
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.y = -0.25
    pad.receiveShadow = true
    scene.add(pad)

    // Launch tower — simple lattice suggestion, purely visual scale reference
    const towerGeo = new THREE.BoxGeometry(0.15, 6, 0.15)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x555555 })
    const tower = new THREE.Mesh(towerGeo, towerMat)
    tower.position.set(2.6, 2.75, 0)
    scene.add(tower)

    // Ground plane for scale reference
    // Procedural mottled dirt/gravel texture — fine speckle grain plus sparse
    // larger flecks; deliberately no large-scale features, so tiling across
    // the 80x80 plane doesn't show obvious seams.
    const groundCanvas = document.createElement('canvas')
    groundCanvas.width = 512
    groundCanvas.height = 512
    const groundCtx = groundCanvas.getContext('2d')!
    groundCtx.fillStyle = '#17151a'
    groundCtx.fillRect(0, 0, 512, 512)
    for (let i = 0; i < 6000; i++) {
      const x = Math.random() * 512
      const y = Math.random() * 512
      const shade = 15 + Math.random() * 35
      groundCtx.fillStyle = `rgba(${shade + 10}, ${shade + 8}, ${shade + 12}, ${0.15 + Math.random() * 0.25})`
      groundCtx.beginPath()
      groundCtx.arc(x, y, 0.6 + Math.random() * 1.8, 0, Math.PI * 2)
      groundCtx.fill()
    }
    for (let i = 0; i < 220; i++) {
      const x = Math.random() * 512
      const y = Math.random() * 512
      const shade = 40 + Math.random() * 60
      groundCtx.fillStyle = `rgba(${shade}, ${shade - 6}, ${shade - 10}, ${0.3 + Math.random() * 0.3})`
      groundCtx.beginPath()
      groundCtx.arc(x, y, 1.5 + Math.random() * 3, 0, Math.PI * 2)
      groundCtx.fill()
    }
    const groundTexture = new THREE.CanvasTexture(groundCanvas)
    groundTexture.wrapS = THREE.RepeatWrapping
    groundTexture.wrapT = THREE.RepeatWrapping
    groundTexture.repeat.set(16, 16)

    const groundGeo = new THREE.PlaneGeometry(80, 80)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: groundTexture })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.5
    ground.receiveShadow = true
    scene.add(ground)

    // ---- Scorch mark — radial-gradient canvas texture on a flat ring under the pad ----
    const scorchCanvas = document.createElement('canvas')
    scorchCanvas.width = 256
    scorchCanvas.height = 256
    const ctx = scorchCanvas.getContext('2d')!
    const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 128)
    grad.addColorStop(0, 'rgba(0,0,0,0.9)')
    grad.addColorStop(0.35, 'rgba(60,40,20,0.6)')
    grad.addColorStop(0.7, 'rgba(80,60,30,0.25)')
    grad.addColorStop(1, 'rgba(80,60,30,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 256, 256)
    const scorchTexture = new THREE.CanvasTexture(scorchCanvas)

    const scorchGeo = new THREE.CircleGeometry(5, 32)
    const scorchMat = new THREE.MeshBasicMaterial({
      map: scorchTexture,
      transparent: true,
      depthWrite: false
    })
    const scorch = new THREE.Mesh(scorchGeo, scorchMat)
    scorch.rotation.x = -Math.PI / 2
    scorch.position.y = -0.48 // just above ground plane, avoids z-fighting
    scene.add(scorch)

    // ============================================================
    // ROCKET — multi-stage tapered body, Atlas-Centaur / Vostok
    // proportions: long slender core, tapered interstage, small
    // sustainer/upper section, gimbaled-look engine cluster at base.
    // ============================================================
    const rocket = new THREE.Group()

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe8e8e8,
      roughness: 0.4,
      metalness: 0.6
    })
    const darkBandMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.5,
      metalness: 0.4
    })
    const engineMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.6,
      metalness: 0.7
    })
    const noseMat = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2,
      roughness: 0.3,
      metalness: 0.5
    })

    let y = 0 // running height cursor, builds the stack bottom-up

    const skirtHeight = 0.5
    const skirtGeo = new THREE.CylinderGeometry(0.32, 0.42, skirtHeight, 20)
    const skirt = new THREE.Mesh(skirtGeo, engineMat)
    skirt.position.y = y + skirtHeight / 2
    skirt.castShadow = true
    rocket.add(skirt)
    y += skirtHeight

    const nozzleGeo = new THREE.ConeGeometry(0.09, 0.35, 12, 1, true)
    const nozzlePositions: [number, number][] = [
      [0, 0],
      [0.16, 0.16],
      [-0.16, 0.16]
    ]
    for (const [ox, oz] of nozzlePositions) {
      const nozzle = new THREE.Mesh(nozzleGeo, engineMat)
      nozzle.position.set(ox, 0.05, oz)
      nozzle.rotation.x = Math.PI
      nozzle.castShadow = true
      rocket.add(nozzle)
    }

    const boosterHeight = 2.2
    const boosterGeo = new THREE.CylinderGeometry(0.3, 0.32, boosterHeight, 20)
    const booster = new THREE.Mesh(boosterGeo, bodyMat)
    booster.position.y = y + boosterHeight / 2
    booster.castShadow = true
    rocket.add(booster)
    y += boosterHeight

    const bandHeight = 0.15
    const bandGeo = new THREE.CylinderGeometry(0.3, 0.3, bandHeight, 20)
    const band = new THREE.Mesh(bandGeo, darkBandMat)
    band.position.y = y + bandHeight / 2
    band.castShadow = true
    rocket.add(band)
    y += bandHeight

    const taperHeight = 0.4
    const taperGeo = new THREE.CylinderGeometry(0.2, 0.3, taperHeight, 20)
    const taper = new THREE.Mesh(taperGeo, bodyMat)
    taper.position.y = y + taperHeight / 2
    taper.castShadow = true
    rocket.add(taper)
    y += taperHeight

    const upperHeight = 1.1
    const upperGeo = new THREE.CylinderGeometry(0.2, 0.2, upperHeight, 20)
    const upper = new THREE.Mesh(upperGeo, bodyMat)
    upper.position.y = y + upperHeight / 2
    upper.castShadow = true
    rocket.add(upper)
    y += upperHeight

    const noseHeight = 0.7
    const noseGeo = new THREE.ConeGeometry(0.2, noseHeight, 20)
    const nose = new THREE.Mesh(noseGeo, noseMat)
    nose.position.y = y + noseHeight / 2
    nose.castShadow = true
    rocket.add(nose)
    y += noseHeight

    const finShape = new THREE.Shape()
    finShape.moveTo(0, 0)
    finShape.lineTo(0.45, 0.15)
    finShape.lineTo(0.4, 0.55)
    finShape.lineTo(0, 0.6)
    finShape.lineTo(0, 0)
    const finExtrude = new THREE.ExtrudeGeometry(finShape, {
      depth: 0.04,
      bevelEnabled: false
    })
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x999999,
      roughness: 0.5,
      metalness: 0.4
    })
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finExtrude, finMat)
      const angle = (i / 4) * Math.PI * 2
      fin.position.set(Math.cos(angle) * 0.28, skirtHeight * 0.3, Math.sin(angle) * 0.28)
      fin.rotation.y = -angle
      fin.rotation.x = -Math.PI / 2
      fin.castShadow = true
      rocket.add(fin)
    }

    rocket.position.y = 0
    scene.add(rocket)
    rocketRef.current = rocket

    // ---- Exhaust particles (trailing under the rocket) ----
    // Intentionally no castShadow/receiveShadow here — points-based shadows read as
    // noise and aren't worth the extra shadow-map draw calls.
    const PARTICLE_COUNT = 200
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const velocities = new Float32Array(PARTICLE_COUNT * 3)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = 0
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = 0
      velocities[i * 3] = 0
      velocities[i * 3 + 1] = 0
      velocities[i * 3 + 2] = 0
    }
    particleVelocities.current = velocities

    const particleGeo = new THREE.BufferGeometry()
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const particleMat = new THREE.PointsMaterial({
      color: 0xffaa33,
      size: 0.15,
      transparent: true,
      opacity: 0.8
    })
    const particles = new THREE.Points(particleGeo, particleMat)
    scene.add(particles)
    particlesRef.current = particles

    // ---- Ground ignition cloud — billows outward at the pad for the first
    // few seconds of powered-ascent, staying near ground level regardless
    // of how fast the rocket climbs ----
    const cloudPositions = new Float32Array(GROUND_CLOUD_COUNT * 3)
    const cloudVel = new Float32Array(GROUND_CLOUD_COUNT * 3)
    const cloudAge = new Float32Array(GROUND_CLOUD_COUNT)
    for (let i = 0; i < GROUND_CLOUD_COUNT; i++) {
      cloudPositions[i * 3 + 1] = -100
      cloudAge[i] = 999
    }
    groundCloudVel.current = cloudVel
    groundCloudAge.current = cloudAge

    const cloudGeo = new THREE.BufferGeometry()
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(cloudPositions, 3))
    const cloudMat = new THREE.PointsMaterial({
      color: 0xf0f0f0,
      size: 1.1,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      sizeAttenuation: true
    })
    const groundCloud = new THREE.Points(cloudGeo, cloudMat)
    scene.add(groundCloud)
    groundCloudRef.current = groundCloud

    // ---- Post-processing: bloom so exhaust/ignition particles read as glowing ----
    const composer = new EffectComposer(renderer)
    composer.setSize(width, height)
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    composer.addPass(new RenderPass(scene, camera))
    // Threshold kept high so only the brightest pixels (exhaust orange, pad
    // highlights) trigger bloom rather than the whole lit scene — tune live,
    // this is a first-pass estimate.
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.1, 0.4, 0.8)
    composer.addPass(bloomPass)
    // Required since three r152+: EffectComposer no longer applies the
    // renderer's output color-space transform automatically.
    composer.addPass(new OutputPass())

    // ---- Render loop ----
    function animate() {
      const telemetry = telemetryRef.current
      const r = rocketRef.current
      const p = particlesRef.current
      const gc = groundCloudRef.current

      if (r && telemetry) {
        r.position.y = telemetry.altitude * ALTITUDE_SCALE
        r.position.x = telemetry.lateralOffset * ALTITUDE_SCALE
        r.rotation.z = THREE.MathUtils.clamp(telemetry.velocity * 0.002, -0.15, 0.15)

        const zoomFactor = Math.min(r.position.y / 15, 1)
        const baseCamY = 4
        const camY = baseCamY + r.position.y
        const offsetX = 9 + zoomFactor * 6
        const offsetZ = 13 + zoomFactor * 9
        camera.position.set(offsetX, camY, offsetZ)

        const lookTarget = new THREE.Vector3(0, r.position.y + 1, 0)
        camera.lookAt(lookTarget)
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
        const spawning =
          telemetry.stage === 'powered-ascent' && telemetry.time < GROUND_CLOUD_WINDOW
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
            vel[idx] *= 0.98
            vel[idx + 2] *= 0.98
            age[i] += dt
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
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, true)
      composer.setSize(w, h)
    }

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(mount)
    } else {
      window.addEventListener('resize', handleResize)
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      if (resizeObserver) {
        resizeObserver.disconnect()
      } else {
        window.removeEventListener('resize', handleResize)
      }
      composer.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    if (!launched && rocketRef.current) {
      rocketRef.current.position.y = 0
      rocketRef.current.rotation.z = 0
    }
    if (!launched && groundCloudAge.current) {
      groundCloudAge.current.fill(999)
    }
  }, [launched])

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', maxWidth: '960px', aspectRatio: '4 / 3', margin: '0 auto' }}
    />
  )
}