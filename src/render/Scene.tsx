import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Telemetry } from '../types'

interface SceneProps {
  telemetryRef: React.MutableRefObject<Telemetry | null>
  launched: boolean
}

const ALTITUDE_SCALE = 0.05 // meters -> scene units, tune for visual pacing
const GROUND_CLOUD_COUNT = 260
const GROUND_CLOUD_WINDOW = 3.0 // seconds after ignition the cloud keeps billowing

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
    const mount = mountRef.current
    if (!mount) return

    const width = 640
    const height = 480

    // ---- Core scene setup ----
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0a12)
    scene.fog = new THREE.Fog(0x0a0a12, 20, 80)

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
    camera.position.set(9, 4, 13)
    camera.lookAt(0, 3, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    mount.appendChild(renderer.domElement)

    // ---- Lighting ----
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(6, 12, 6)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x6a7bff, 0.3)
    fill.position.set(-6, 4, -4)
    scene.add(fill)

    // ---- Launch pad ----
    const padGeo = new THREE.CylinderGeometry(2, 2.2, 0.5, 24)
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a3a,
      roughness: 0.8,
      metalness: 0.3
    })
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.y = -0.25
    scene.add(pad)

    // Launch tower — simple lattice suggestion, purely visual scale reference
    const towerGeo = new THREE.BoxGeometry(0.15, 6, 0.15)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x555555 })
    const tower = new THREE.Mesh(towerGeo, towerMat)
    tower.position.set(2.6, 2.75, 0)
    scene.add(tower)

    // Ground plane for scale reference
    const groundGeo = new THREE.PlaneGeometry(80, 80)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x14141c })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.5
    scene.add(ground)

    // ---- Scorch mark — radial-gradient canvas texture on a flat ring under the pad ----
    const scorchCanvas = document.createElement('canvas')
    scorchCanvas.width = 256
    scorchCanvas.height = 256
    const ctx = scorchCanvas.getContext('2d')!
    const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 128)
    grad.addColorStop(0, 'rgba(10,10,10,0.85)')
    grad.addColorStop(0.4, 'rgba(20,20,20,0.55)')
    grad.addColorStop(0.75, 'rgba(30,30,30,0.2)')
    grad.addColorStop(1, 'rgba(30,30,30,0)')
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
    scorch.position.y = -0.49 // just above ground plane, avoids z-fighting
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
      rocket.add(nozzle)
    }

    const boosterHeight = 2.2
    const boosterGeo = new THREE.CylinderGeometry(0.3, 0.32, boosterHeight, 20)
    const booster = new THREE.Mesh(boosterGeo, bodyMat)
    booster.position.y = y + boosterHeight / 2
    rocket.add(booster)
    y += boosterHeight

    const bandHeight = 0.15
    const bandGeo = new THREE.CylinderGeometry(0.3, 0.3, bandHeight, 20)
    const band = new THREE.Mesh(bandGeo, darkBandMat)
    band.position.y = y + bandHeight / 2
    rocket.add(band)
    y += bandHeight

    const taperHeight = 0.4
    const taperGeo = new THREE.CylinderGeometry(0.2, 0.3, taperHeight, 20)
    const taper = new THREE.Mesh(taperGeo, bodyMat)
    taper.position.y = y + taperHeight / 2
    rocket.add(taper)
    y += taperHeight

    const upperHeight = 1.1
    const upperGeo = new THREE.CylinderGeometry(0.2, 0.2, upperHeight, 20)
    const upper = new THREE.Mesh(upperGeo, bodyMat)
    upper.position.y = y + upperHeight / 2
    rocket.add(upper)
    y += upperHeight

    const noseHeight = 0.7
    const noseGeo = new THREE.ConeGeometry(0.2, noseHeight, 20)
    const nose = new THREE.Mesh(noseGeo, noseMat)
    nose.position.y = y + noseHeight / 2
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
      rocket.add(fin)
    }

    rocket.position.y = 0
    scene.add(rocket)
    rocketRef.current = rocket

    // ---- Exhaust particles (trailing under the rocket) ----
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
      cloudPositions[i * 3 + 1] = -100 // parked off-screen until spawned
      cloudAge[i] = 999 // inactive
    }
    groundCloudVel.current = cloudVel
    groundCloudAge.current = cloudAge

    const cloudGeo = new THREE.BufferGeometry()
    cloudGeo.setAttribute('position', new THREE.BufferAttribute(cloudPositions, 3))
    const cloudMat = new THREE.PointsMaterial({
      color: 0xcccccc,
      size: 0.55,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    })
    const groundCloud = new THREE.Points(cloudGeo, cloudMat)
    scene.add(groundCloud)
    groundCloudRef.current = groundCloud

    // ---- Render loop ----
    function animate() {
      const telemetry = telemetryRef.current
      const r = rocketRef.current
      const p = particlesRef.current
      const gc = groundCloudRef.current

      if (r && telemetry) {
        r.position.y = telemetry.altitude * ALTITUDE_SCALE
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

      // Ground cloud: spawns near the pad for the first GROUND_CLOUD_WINDOW
      // seconds of powered-ascent, billows outward and slowly upward, then
      // parks off-screen once its age expires — independent of rocket height.
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
            const radius = Math.random() * 0.4
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
            vel[idx] *= 0.98 // drag, cloud slows as it expands
            vel[idx + 2] *= 0.98
            age[i] += dt
          } else if (posAttr.array[idx + 1] !== -100) {
            posAttr.array[idx + 1] = -100 // park off-screen once fully aged out
          }
        }
        posAttr.needsUpdate = true
      }

      renderer.render(scene, camera)
      rafRef.current = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(rafRef.current)
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
      groundCloudAge.current.fill(999) // reset cloud on re-arm
    }
  }, [launched])

  return <div ref={mountRef} />
}