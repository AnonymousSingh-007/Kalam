import * as THREE from 'three'

// Subtle grime/panel-variation base-color texture — same canvas-texture
// technique already used for the ground/pad in Scene.tsx, just generated
// here since it's rocket-specific. Mostly-white with faint speckle grain
// and a few long soft streaks (exhaust wash / handling wear), multiplied
// against each zone's own `color` so the steel/white tint is unchanged and
// only surface variation is added.
function makeGrimeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 3000; i++) {
    const x = Math.random() * 256
    const y = Math.random() * 256
    const v = 190 + Math.random() * 50
    ctx.fillStyle = `rgba(${v}, ${v}, ${v}, ${0.08 + Math.random() * 0.12})`
    ctx.fillRect(x, y, 1, 1)
  }
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * 256
    const len = 40 + Math.random() * 120
    const y0 = Math.random() * (256 - len)
    const grad = ctx.createLinearGradient(x, y0, x, y0 + len)
    grad.addColorStop(0, 'rgba(80,75,70,0)')
    grad.addColorStop(0.5, `rgba(80,75,70,${0.05 + Math.random() * 0.08})`)
    grad.addColorStop(1, 'rgba(80,75,70,0)')
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.5 + Math.random() * 2.5
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + len); ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(6, 10)
  return tex
}

export function buildRocket(scene: THREE.Scene, envMap?: THREE.Texture | null): THREE.Group {
  const rocket = new THREE.Group()
  const grimeTexture = makeGrimeTexture()

  // ---- Materials ----
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xb8bcc2,
    map: grimeTexture,
    roughness: 0.28,
    metalness: 0.85,
    envMapIntensity: 0.6
  })

  const thermalMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    roughness: 0.9,
    metalness: 0.1
  })

  const engineMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1e,
    roughness: 0.5,
    metalness: 0.8
  })

  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0,
    map: grimeTexture,
    roughness: 0.35,
    metalness: 0.3,
    envMapIntensity: 0.4
  })

  const fairingMat = new THREE.MeshStandardMaterial({
    color: 0xeeeee8,
    roughness: 0.25,
    metalness: 0.2,
    envMapIntensity: 0.5
  })

  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x050505,
    roughness: 0.9,
    metalness: 0.1
  })

  const finMat = new THREE.MeshStandardMaterial({
    color: 0x8a8e94,
    roughness: 0.35,
    metalness: 0.7
  })

  const rcsMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.6,
    metalness: 0.7
  })

  const portMat = new THREE.MeshStandardMaterial({
    color: 0x666666,
    roughness: 0.5,
    metalness: 0.6
  })

  const nozzleRimMat = new THREE.MeshStandardMaterial({
    color: 0x443322,
    roughness: 0.3,
    metalness: 0.9,
    emissive: new THREE.Color(0x221100),
    emissiveIntensity: 0.3
  })

  // Only the polished/painted zones that already carry an envMapIntensity
  // (steel, white Centaur, fairing) get the reflection — matte thermal
  // protection, seams, engine bells etc. shouldn't show sky reflections.
  if (envMap) {
    steelMat.envMap = envMap
    whiteMat.envMap = envMap
    fairingMat.envMap = envMap
  }

  let y = 0

  // ============================================================
  // ENGINE SECTION — built bottom-up from y=0
  // All nozzle geometry is positioned relative to y=0 (base of
  // the rocket) so nothing floats or detaches when the group moves.
  // ============================================================

  // Boat-tail / engine bell fairing — closes the gap between the
  // structural skirt and the nozzle exits. Real rockets have this
  // heat-shielded structural member to protect the engine bay.
  // Slightly wider than the nozzle cluster, narrower than the skirt.
  const boatTailHeight = 0.3
  const boatTailGeo = new THREE.CylinderGeometry(0.30, 0.40, boatTailHeight, 24)
  const boatTail = new THREE.Mesh(boatTailGeo, engineMat)
  boatTail.position.y = boatTailHeight / 2
  boatTail.castShadow = true
  rocket.add(boatTail)

  // Main engine nozzle bell — sits flush against the boat-tail base
  // Central RD-180 style bell, large and prominent
  const mainNozzleGeo = new THREE.ConeGeometry(0.14, 0.55, 20, 1, true)
  const mainNozzle = new THREE.Mesh(mainNozzleGeo, engineMat)
  mainNozzle.position.set(0, -0.12, 0) // hangs below the boat-tail base
  mainNozzle.rotation.x = Math.PI
  mainNozzle.castShadow = true
  rocket.add(mainNozzle)

  // Nozzle rim — glowing combustion chamber exit ring
  const nozzleRimGeo = new THREE.TorusGeometry(0.115, 0.016, 8, 20)
  const nozzleRim = new THREE.Mesh(nozzleRimGeo, nozzleRimMat)
  nozzleRim.position.set(0, -0.38, 0) // at the nozzle exit plane
  nozzleRim.rotation.x = Math.PI / 2
  rocket.add(nozzleRim)

  // Vernier nozzles — 4 smaller bells angled outward from the boat-tail
  // These are the roll/pitch control engines, mounted near the base
  const vernierGeo = new THREE.ConeGeometry(0.045, 0.22, 12, 1, true)
  const vernierAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
  for (const angle of vernierAngles) {
    const vx = Math.cos(angle) * 0.22
    const vz = Math.sin(angle) * 0.22
    const vernier = new THREE.Mesh(vernierGeo, engineMat)
    vernier.position.set(vx, -0.05, vz)
    vernier.rotation.x = Math.PI
    // Cant 8° outward toward the vector away from center
    const cantDir = new THREE.Vector3(vx, 0, vz).normalize()
    vernier.rotateOnWorldAxis(
      new THREE.Vector3(-cantDir.z, 0, cantDir.x).normalize(),
      0.14
    )
    vernier.castShadow = true
    rocket.add(vernier)

    // Small vernier rim ring
    const vRimGeo = new THREE.TorusGeometry(0.038, 0.008, 6, 14)
    const vRim = new THREE.Mesh(vRimGeo, nozzleRimMat)
    vRim.position.set(vx, -0.24, vz)
    vRim.rotation.x = Math.PI / 2
    rocket.add(vRim)
  }

  // Engine skirt — main structural base, sits above the boat-tail
  const skirtHeight = 0.45
  const skirtGeo = new THREE.CylinderGeometry(0.34, 0.40, skirtHeight, 24)
  const skirt = new THREE.Mesh(skirtGeo, engineMat)
  skirt.position.y = boatTailHeight + skirtHeight / 2
  skirt.castShadow = true
  rocket.add(skirt)
  y = boatTailHeight + skirtHeight

  // Heat shield ring at skirt/booster junction
  addSeamRing(rocket, seamMat, 0.345, y)

  // ============================================================
  // FINS — swept delta, rooted at base, flare outward and downward
  // Positioned so the root sits at the boat-tail/skirt junction
  // and the fin body extends downward past the nozzle exits.
  // ============================================================

  const finShape = new THREE.Shape()
  finShape.moveTo(0, 0)        // root at attachment point
  finShape.lineTo(0.5, -0.1)   // leading edge sweeps down and out
  finShape.lineTo(0.48, 0.48)  // tip
  finShape.lineTo(0.0, 0.62)   // trailing edge root
  finShape.lineTo(0, 0)

  const finExtrude = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.032,
    bevelEnabled: true,
    bevelThickness: 0.007,
    bevelSize: 0.007,
    bevelSegments: 2
  })

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
    const fin = new THREE.Mesh(finExtrude, finMat)
    fin.position.set(
      Math.cos(angle) * 0.38,
      boatTailHeight * 0.5, // root sits at mid boat-tail, fin extends down naturally
      Math.sin(angle) * 0.38
    )
    fin.rotation.y = -angle
    fin.rotation.x = -Math.PI / 2
    fin.castShadow = true
    rocket.add(fin)
  }

  // ============================================================
  // BOOSTER STAGE (lower body — stainless steel)
  // ============================================================

  const boosterHeight = 2.4
  const boosterGeo = new THREE.CylinderGeometry(0.32, 0.34, boosterHeight, 24)
  const booster = new THREE.Mesh(boosterGeo, steelMat)
  booster.position.y = y + boosterHeight / 2
  booster.castShadow = true
  rocket.add(booster)

  // Mid-body panel seam
  addSeamRing(rocket, seamMat, 0.325, y + boosterHeight * 0.45)

  // Propellant fill/drain port
  const portGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8)
  const port = new THREE.Mesh(portGeo, portMat)
  port.position.set(0.34, y + boosterHeight * 0.3, 0)
  port.rotation.z = Math.PI / 2
  rocket.add(port)

  // Second port on opposite side (LOX and RP-1 fill separately)
  const port2 = new THREE.Mesh(portGeo, portMat)
  port2.position.set(-0.34, y + boosterHeight * 0.65, 0)
  port2.rotation.z = Math.PI / 2
  rocket.add(port2)

  y += boosterHeight
  addSeamRing(rocket, seamMat, 0.325, y)

  // ============================================================
  // INTERSTAGE (thermal protection zone — black)
  // ============================================================

  const bandHeight = 0.2
  const bandGeo = new THREE.CylinderGeometry(0.32, 0.32, bandHeight, 24)
  const band = new THREE.Mesh(bandGeo, thermalMat)
  band.position.y = y + bandHeight / 2
  band.castShadow = true
  rocket.add(band)
  y += bandHeight

  const taperHeight = 0.45
  const taperGeo = new THREE.CylinderGeometry(0.22, 0.32, taperHeight, 24)
  const taper = new THREE.Mesh(taperGeo, thermalMat)
  taper.position.y = y + taperHeight / 2
  taper.castShadow = true
  rocket.add(taper)
  y += taperHeight

  addSeamRing(rocket, seamMat, 0.225, y)

  // ============================================================
  // UPPER STAGE (Centaur — white painted aluminium)
  // ============================================================

  const upperHeight = 1.2
  const upperGeo = new THREE.CylinderGeometry(0.22, 0.22, upperHeight, 24)
  const upper = new THREE.Mesh(upperGeo, whiteMat)
  upper.position.y = y + upperHeight / 2
  upper.castShadow = true
  rocket.add(upper)

  addSeamRing(rocket, seamMat, 0.225, y + upperHeight * 0.5)

  // ---- RCS thruster pods ----
  const rcsGeo = new THREE.BoxGeometry(0.06, 0.08, 0.04)
  const rcsConeGeo = new THREE.ConeGeometry(0.02, 0.04, 8)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const rx = Math.cos(angle) * 0.24
    const rz = Math.sin(angle) * 0.24
    const ry = y + upperHeight * 0.7

    const pod = new THREE.Mesh(rcsGeo, rcsMat)
    pod.position.set(rx, ry, rz)
    pod.rotation.y = -angle
    pod.castShadow = true
    rocket.add(pod)

    const rcsCone = new THREE.Mesh(rcsConeGeo, engineMat)
    rcsCone.position.set(Math.cos(angle) * 0.28, ry, Math.sin(angle) * 0.28)
    rcsCone.rotation.z = -Math.PI / 2
    rcsCone.rotation.y = -angle
    rocket.add(rcsCone)
  }

  y += upperHeight
  addSeamRing(rocket, seamMat, 0.225, y)

  // ============================================================
  // PAYLOAD FAIRING — ogive nose via LatheGeometry
  // ============================================================

  const fairingHeight = 0.9
  const fairingRadius = 0.22
  const fairingPoints: THREE.Vector2[] = []
  const FAIRING_SEGMENTS = 18

  for (let i = 0; i <= FAIRING_SEGMENTS; i++) {
    const t = i / FAIRING_SEGMENTS
    const r = fairingRadius * Math.pow(Math.max(1 - Math.pow(t, 1.8), 0), 0.5)
    fairingPoints.push(new THREE.Vector2(Math.max(r, 0.004), t * fairingHeight))
  }
  fairingPoints.push(new THREE.Vector2(0.001, fairingHeight))

  const fairingGeo = new THREE.LatheGeometry(fairingPoints, 24)
  const fairing = new THREE.Mesh(fairingGeo, fairingMat)
  fairing.position.y = y
  fairing.castShadow = true
  rocket.add(fairing)

  // Payload fairing separation line
  const sepLineGeo = new THREE.RingGeometry(
    fairingRadius * 0.65 - 0.005,
    fairingRadius * 0.65 + 0.005,
    24
  )
  const sepLine = new THREE.Mesh(sepLineGeo, seamMat)
  sepLine.position.y = y + fairingHeight * 0.35
  sepLine.rotation.x = -Math.PI / 2
  rocket.add(sepLine)

  rocket.position.y = 0
  scene.add(rocket)
  return rocket
}

function addSeamRing(
  group: THREE.Group,
  material: THREE.Material,
  radius: number,
  y: number
) {
  const geo = new THREE.TorusGeometry(radius, 0.008, 6, 32)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = y
  mesh.rotation.x = Math.PI / 2
  group.add(mesh)
}