import * as THREE from 'three'

// Earth radius in scene units. We use a dramatically smaller value than
// real Earth (6371km) to make curvature visible at our altitude scale.
// Real ISS altitude (~400km) shows clear curvature. We want it visible
// at ~1-2km equivalent, so we compress the radius to ~800 scene units
// (equivalent to ~16km real radius at ALTITUDE_SCALE=0.05).
// Tune PLANET_RADIUS to taste — smaller = more dramatic curve.
const PLANET_RADIUS = 420

// How much of the sphere cap to show — controls how far the ground
// extends before curving away. Larger angle = more ground visible,
// less dramatic curve. Smaller = tighter horizon, more dramatic.
const CAP_HALF_ANGLE = Math.PI / 5.5 // ~33 degrees

export interface GroundResult {
  group: THREE.Group
  // Call each frame with current rocket altitude (in metres, not scene units)
  // so the atmosphere limb glow can respond to altitude.
  update: (altitudeMetres: number) => void
  dispose: () => void
}

export function buildGround(): GroundResult {
  const group = new THREE.Group()

  // ---- Procedural ground texture (same as before) ----
  const groundCanvas = document.createElement('canvas')
  groundCanvas.width = 512; groundCanvas.height = 512
  const groundCtx = groundCanvas.getContext('2d')!
  groundCtx.fillStyle = '#17151a'; groundCtx.fillRect(0, 0, 512, 512)

  for (let i = 0; i < 10; i++) {
    const cx = Math.random() * 512; const cy = Math.random() * 512
    const r = 70 + Math.random() * 90
    const shift = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 14)
    for (let ox = -512; ox <= 512; ox += 512) {
      for (let oy = -512; oy <= 512; oy += 512) {
        const gx = cx + ox; const gy = cy + oy
        if (gx < -r || gx > 512 + r || gy < -r || gy > 512 + r) continue
        const patchGrad = groundCtx.createRadialGradient(gx, gy, 0, gx, gy, r)
        patchGrad.addColorStop(0, `rgba(${23 + shift}, ${21 + shift}, ${26 + shift}, 0.5)`)
        patchGrad.addColorStop(1, 'rgba(23, 21, 26, 0)')
        groundCtx.fillStyle = patchGrad
        groundCtx.fillRect(gx - r, gy - r, r * 2, r * 2)
      }
    }
  }
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * 512; const y = Math.random() * 512
    const shade = 15 + Math.random() * 35
    groundCtx.fillStyle = `rgba(${shade + 10}, ${shade + 8}, ${shade + 12}, ${0.15 + Math.random() * 0.25})`
    groundCtx.beginPath(); groundCtx.arc(x, y, 0.6 + Math.random() * 1.8, 0, Math.PI * 2); groundCtx.fill()
  }
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * 512; const y = Math.random() * 512
    const shade = 40 + Math.random() * 60
    groundCtx.fillStyle = `rgba(${shade}, ${shade - 6}, ${shade - 10}, ${0.3 + Math.random() * 0.3})`
    groundCtx.beginPath(); groundCtx.arc(x, y, 1.5 + Math.random() * 3, 0, Math.PI * 2); groundCtx.fill()
  }
  const groundTexture = new THREE.CanvasTexture(groundCanvas)
  groundTexture.wrapS = THREE.RepeatWrapping; groundTexture.wrapT = THREE.RepeatWrapping
  groundTexture.repeat.set(24, 24) // more repeats over larger sphere surface

  // Normal map
  const groundNormalCanvas = document.createElement('canvas')
  groundNormalCanvas.width = 256; groundNormalCanvas.height = 256
  const groundNCtx = groundNormalCanvas.getContext('2d')!
  groundNCtx.fillStyle = 'rgb(128,128,255)'; groundNCtx.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * 256; const y = Math.random() * 256
    const nr = 128 + (Math.random() - 0.5) * 40
    const ng = 128 + (Math.random() - 0.5) * 40
    groundNCtx.fillStyle = `rgba(${nr}, ${ng}, 255, 0.5)`
    groundNCtx.beginPath(); groundNCtx.arc(x, y, 1 + Math.random() * 2.5, 0, Math.PI * 2); groundNCtx.fill()
  }
  const groundNormalTexture = new THREE.CanvasTexture(groundNormalCanvas)
  groundNormalTexture.wrapS = THREE.RepeatWrapping; groundNormalTexture.wrapT = THREE.RepeatWrapping
  groundNormalTexture.repeat.set(24, 24)

  // ---- Sphere cap geometry ----
  // SphereGeometry gives us the full sphere — we only want the top cap.
  // phiStart=0, phiLength=2PI gives full circle, thetaStart=0,
  // thetaLength=CAP_HALF_ANGLE gives just the cap we want.
  // High segment counts (96x48) so the curve is smooth at all camera
  // distances and the texture doesn't show polygon edges on the horizon.
  const sphereGeo = new THREE.SphereGeometry(
    PLANET_RADIUS,
    96,   // width segments — horizontal resolution
    48,   // height segments — vertical resolution
    0,    // phiStart
    Math.PI * 2, // phiLength — full circle
    0,    // thetaStart — from the top
    CAP_HALF_ANGLE // thetaLength — how far down the sphere we show
  )

  const sphereMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: groundTexture,
    normalMap: groundNormalTexture,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.92,
    metalness: 0.0
  })

  const sphere = new THREE.Mesh(sphereGeo, sphereMat)
  sphere.receiveShadow = true

  // Position the sphere so its top (the cap centre) sits at y = -0.5
  // (same as our old ground plane), with the sphere centre far below.
  // The cap top is at y = PLANET_RADIUS from the sphere centre,
  // so we drop the sphere centre to -(PLANET_RADIUS + 0.5).
  sphere.position.y = -(PLANET_RADIUS + 0.5)
  group.add(sphere)

  // ---- Scorch mark — stays flat, sits on top of the sphere cap ----
  const scorchCanvas = document.createElement('canvas')
  scorchCanvas.width = 256; scorchCanvas.height = 256
  const ctx = scorchCanvas.getContext('2d')!
  const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 128)
  grad.addColorStop(0, 'rgba(0,0,0,0.9)')
  grad.addColorStop(0.35, 'rgba(60,40,20,0.6)')
  grad.addColorStop(0.7, 'rgba(80,60,30,0.25)')
  grad.addColorStop(1, 'rgba(80,60,30,0)')
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 256)
  const scorchTexture = new THREE.CanvasTexture(scorchCanvas)
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(5, 32),
    new THREE.MeshBasicMaterial({ map: scorchTexture, transparent: true, depthWrite: false })
  )
  scorch.rotation.x = -Math.PI / 2
  scorch.position.y = -0.46 // just above sphere surface at cap centre
  group.add(scorch)

  // ---- Atmospheric limb glow ----
  // A large billboard ring at the horizon that brightens as altitude
  // increases — simulates Rayleigh scattering seen from altitude.
  // Uses a canvas-generated radial gradient texture:
  // transparent at centre → bright blue-white at the rim edge →
  // transparent again on the outside.
  const limbCanvas = document.createElement('canvas')
  limbCanvas.width = 512; limbCanvas.height = 512
  const limbCtx = limbCanvas.getContext('2d')!

  // Ring gradient: brightest at ~60% radius (the actual limb),
  // fading to transparent both inward and outward
  const limbGrad = limbCtx.createRadialGradient(256, 256, 80, 256, 256, 256)
  limbGrad.addColorStop(0.0,  'rgba(20, 40, 80, 0)')
  limbGrad.addColorStop(0.55, 'rgba(50, 100, 200, 0.05)')
  limbGrad.addColorStop(0.78, 'rgba(100, 170, 255, 0.55)')
  limbGrad.addColorStop(0.88, 'rgba(160, 210, 255, 0.35)')
  limbGrad.addColorStop(0.95, 'rgba(200, 230, 255, 0.1)')
  limbGrad.addColorStop(1.0,  'rgba(200, 230, 255, 0)')
  limbCtx.fillStyle = limbGrad
  limbCtx.fillRect(0, 0, 512, 512)
  const limbTexture = new THREE.CanvasTexture(limbCanvas)

  // Large ring geometry, sits at the horizon level of the sphere cap
  // The ring inner/outer radius covers the horizon band
  const LIMB_INNER = PLANET_RADIUS * Math.sin(CAP_HALF_ANGLE) * 0.65
  const LIMB_OUTER = PLANET_RADIUS * Math.sin(CAP_HALF_ANGLE) * 1.35

  const limbGeo = new THREE.RingGeometry(LIMB_INNER, LIMB_OUTER, 128)
  const limbMat = new THREE.MeshBasicMaterial({
    map: limbTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  })
  const limbMesh = new THREE.Mesh(limbGeo, limbMat)
  limbMesh.rotation.x = -Math.PI / 2

  // Position the limb ring at the horizon height of the sphere cap
  // The sphere cap edge is at y = PLANET_RADIUS * cos(CAP_HALF_ANGLE)
  // above the sphere centre, which is at -(PLANET_RADIUS + 0.5)
  const capEdgeY = PLANET_RADIUS * Math.cos(CAP_HALF_ANGLE) - (PLANET_RADIUS + 0.5)
  limbMesh.position.y = capEdgeY + 0.5 // just above the geometric horizon
  group.add(limbMesh)

  // ---- Update function ----
  // Drives limb glow opacity and slight y-scale with altitude.
  // At ground level: barely visible (opacity 0.15)
  // At high altitude: strongly visible (opacity 1.0)
  function update(altitudeMetres: number) {
    const t = Math.min(altitudeMetres / 8000, 1.0) // 0 at ground, 1 at 8km+
    // Exponential ramp so it's barely noticeable near the pad but
    // increasingly dramatic as the rocket climbs
    const limbOpacity = 0.08 + t * t * 0.92
    limbMat.opacity = limbOpacity

    // Also push the limb ring slightly upward as altitude increases —
    // the horizon rises relative to the observer
    limbMesh.position.y = capEdgeY + 0.5 + t * 8
  }

  function dispose() {
    sphereGeo.dispose()
    sphereMat.dispose()
    groundTexture.dispose()
    groundNormalTexture.dispose()
    scorchTexture.dispose()
    limbGeo.dispose()
    limbMat.dispose()
    limbTexture.dispose()
    group.clear()
  }

  return { group, update, dispose }
}