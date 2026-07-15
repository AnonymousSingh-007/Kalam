import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Telemetry } from '../types'

interface SceneProps {
  telemetryRef: React.MutableRefObject<Telemetry | null>
  launched: boolean
}

const ALTITUDE_SCALE = 0.05 // meters -> scene units, tune for visual pacing

export function Scene({ telemetryRef, launched }: SceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rocketRef = useRef<THREE.Group | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const particleVelocities = useRef<Float32Array | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const width = 640
    const height = 480

    // ---- Core scene setup ----
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0a12)

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
    camera.position.set(8, 4, 12)
    camera.lookAt(0, 3, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    mount.appendChild(renderer.domElement)

    // ---- Lighting ----
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const sun = new THREE.DirectionalLight(0xffffff, 1)
    sun.position.set(5, 10, 5)
    scene.add(sun)

    // ---- Launch pad ----
    const padGeo = new THREE.CylinderGeometry(2, 2.2, 0.5, 24)
    const padMat = new THREE.MeshStandardMaterial({ color: 0x444444 })
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.y = -0.25
    scene.add(pad)

    // Ground plane for scale reference
    const groundGeo = new THREE.PlaneGeometry(60, 60)
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1a1a24 })
    const ground = new THREE.Mesh(groundGeo, groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.5
    scene.add(ground)

    // ---- Rocket (body + nose cone + fins) ----
    const rocket = new THREE.Group()

    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 2.5, 16)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdddddd })
    const body = new THREE.Mesh(bodyGeo, bodyMat)
    body.position.y = 1.25
    rocket.add(body)

    const noseGeo = new THREE.ConeGeometry(0.3, 0.8, 16)
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xff3b30 })
    const nose = new THREE.Mesh(noseGeo, noseMat)
    nose.position.y = 2.9
    rocket.add(nose)

    const finGeo = new THREE.BoxGeometry(0.05, 0.6, 0.5)
    const finMat = new THREE.MeshStandardMaterial({ color: 0x888888 })
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, finMat)
      const angle = (i / 4) * Math.PI * 2
      fin.position.set(Math.cos(angle) * 0.3, 0.3, Math.sin(angle) * 0.3)
      fin.rotation.y = angle
      rocket.add(fin)
    }

    rocket.position.y = 0
    scene.add(rocket)
    rocketRef.current = rocket

    // ---- Exhaust particles ----
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

    // ---- Render loop ----
    function animate() {
      const telemetry = telemetryRef.current
      const r = rocketRef.current
      const p = particlesRef.current

      if (r && telemetry) {
        r.position.y = telemetry.altitude * ALTITUDE_SCALE
        // slight tilt based on velocity for visual dynamism
        r.rotation.z = THREE.MathUtils.clamp(telemetry.velocity * 0.002, -0.15, 0.15)
      }

      if (p && telemetry) {
        const isThrusting = telemetry.stage === 'powered-ascent'
        const posAttr = p.geometry.getAttribute('position') as THREE.BufferAttribute
        const vel = particleVelocities.current!

        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const idx = i * 3
          if (isThrusting && Math.random() < 0.3) {
            // respawn at rocket base
            posAttr.array[idx] = (Math.random() - 0.5) * 0.3
            posAttr.array[idx + 1] = r ? r.position.y : 0
            posAttr.array[idx + 2] = (Math.random() - 0.5) * 0.3
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
    // reset rocket position visually when re-armed/reset
    if (!launched && rocketRef.current) {
      rocketRef.current.position.y = 0
      rocketRef.current.rotation.z = 0
    }
  }, [launched])

  return <div ref={mountRef} />
}