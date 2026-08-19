import * as THREE from 'three'

export function buildRocket(scene: THREE.Scene): THREE.Group {
  const rocket = new THREE.Group()

  // ---- Environment cube for reflections ----
  // Procedural cubemap: warm horizon (dawn), deep space top,
  // dark ground bottom — matches our sky dome palette.
  const cubeRT = new THREE.WebGLCubeRenderTarget(128)
  const cubeScene = new THREE.Scene()
  const cubeCamera = new THREE.CubeCamera(0.1, 10, cubeRT)

  // Bake a simple gradient into each face instead of a real env capture
  // (real capture would need the full scene built first + a render pass)
  const envColors = {
    px: 0x241a3d, nx: 0x241a3d,
    py: 0x00000f, ny: 0x14141c,
    pz: 0xe0875f, nz: 0x241a3d
  }
  const envCube = cubeRT.texture
  // We'll use a simpler approach — just set envMapIntensity on materials

  // ---- Materials ----
  // Steel lower body — brushed stainless look
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xb8bcc2,
    roughness: 0.28,
    metalness: 0.85,
    envMapIntensity: 0.6
  })

  // Thermal protection — matte black ablative coating
  const thermalMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    roughness: 0.9,
    metalness: 0.1
  })

  // Engine hardware — dark oily metal
  const engineMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1e,
    roughness: 0.5,
    metalness: 0.8
  })

  // White upper stage (Centaur) — painted aluminium
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0,
    roughness: 0.35,
    metalness: 0.3,
    envMapIntensity: 0.4
  })

  // Nose fairing — slightly off-white, smoother
  const fairingMat = new THREE.MeshStandardMaterial({
    color: 0xeeeee8,
    roughness: 0.25,
    metalness: 0.2,
    envMapIntensity: 0.5
  })

  // Panel line material — thin dark seam rings
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x050505,
    roughness: 0.9,
    metalness: 0.1
  })

  // Fin material — bare aluminium
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x8a8e94,
    roughness: 0.35,
    metalness: 0.7
  })

  // RCS thruster pod material
  const rcsMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.6,
    metalness: 0.7
  })

  let y = 0

  // ============================================================
  // ENGINE SECTION
  // ============================================================

  // Engine skirt (flared base, widest point)
  const skirtHeight = 0.55
  const skirtGeo = new THREE.CylinderGeometry(0.34, 0.44, skirtHeight, 24)
  const skirt = new THREE.Mesh(skirtGeo, engineMat)
  skirt.position.y = y + skirtHeight / 2
  skirt.castShadow = true
  rocket.add(skirt)
  y += skirtHeight

  // Engine nozzle cluster (5 bells — central + 4 outer, like Atlas V RD-180 + verniers)
  const mainNozzleGeo = new THREE.ConeGeometry(0.12, 0.45, 16, 1, true)
  const mainNozzle = new THREE.Mesh(mainNozzleGeo, engineMat)
  mainNozzle.position.set(0, 0.02, 0)
  mainNozzle.rotation.x = Math.PI
  mainNozzle.castShadow = true
  rocket.add(mainNozzle)

  // Inner nozzle glow ring (visible combustion chamber rim)
  const nozzleRimGeo = new THREE.TorusGeometry(0.1, 0.015, 8, 16)
  const nozzleRimMat = new THREE.MeshStandardMaterial({
    color: 0x443322,
    roughness: 0.3,
    metalness: 0.9,
    emissive: 0x221100,
    emissiveIntensity: 0.3
  })
  const nozzleRim = new THREE.Mesh(nozzleRimGeo, nozzleRimMat)
  nozzleRim.position.set(0, -0.18, 0)
  nozzleRim.rotation.x = Math.PI / 2
  rocket.add(nozzleRim)

  // Vernier nozzles (4 smaller, angled outward slightly)
  const vernierGeo = new THREE.ConeGeometry(0.05, 0.25, 10, 1, true)
  const vernierPositions: [number, number, number][] = [
    [0.22, 0.08, 0],
    [-0.22, 0.08, 0],
    [0, 0.08, 0.22],
    [0, 0.08, -0.22]
  ]
  for (const [vx, vy, vz] of vernierPositions) {
    const vernier = new THREE.Mesh(vernierGeo, engineMat)
    vernier.position.set(vx, vy, vz)
    vernier.rotation.x = Math.PI
    // Slight outward cant — real verniers angle 5-10° out for roll control
    const cantAngle = 0.12
    vernier.rotation.z = Math.atan2(vx, 1) * cantAngle
    vernier.rotation.x += Math.atan2(vz, 1) * cantAngle
    vernier.castShadow = true
    rocket.add(vernier)
  }

  // ============================================================
  // BOOSTER STAGE (lower body — stainless steel)
  // ============================================================

  // Panel seam ring at engine/body junction
  addSeamRing(rocket, seamMat, 0.345, y)

  const boosterHeight = 2.4
  const boosterGeo = new THREE.CylinderGeometry(0.32, 0.34, boosterHeight, 24)
  const booster = new THREE.Mesh(boosterGeo, steelMat)
  booster.position.y = y + boosterHeight / 2
  booster.castShadow = true
  rocket.add(booster)

  // Mid-body panel seam
  addSeamRing(rocket, seamMat, 0.325, y + boosterHeight * 0.45)

  // Propellant fill/drain port (small cylindrical bump, visual detail only)
  const portGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8)
  const portMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.5, metalness: 0.6 })
  const port = new THREE.Mesh(portGeo, portMat)
  port.position.set(0.34, y + boosterHeight * 0.3, 0)
  port.rotation.z = Math.PI / 2
  rocket.add(port)

  y += boosterHeight

  // Panel seam at top of booster
  addSeamRing(rocket, seamMat, 0.325, y)

  // ============================================================
  // INTERSTAGE (thermal protection zone — black)
  // ============================================================

  // Dark interstage band
  const bandHeight = 0.2
  const bandGeo = new THREE.CylinderGeometry(0.32, 0.32, bandHeight, 24)
  const band = new THREE.Mesh(bandGeo, thermalMat)
  band.position.y = y + bandHeight / 2
  band.castShadow = true
  rocket.add(band)
  y += bandHeight

  // Interstage taper (Centaur adapter — narrows to upper stage)
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

  // Mid-upper panel seam
  addSeamRing(rocket, seamMat, 0.225, y + upperHeight * 0.5)

  // ---- RCS thruster pods (4, equally spaced around the upper stage) ----
  const rcsGeo = new THREE.BoxGeometry(0.06, 0.08, 0.04)
  const rcsConeGeo = new THREE.ConeGeometry(0.02, 0.04, 8)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const rx = Math.cos(angle) * 0.24
    const rz = Math.sin(angle) * 0.24
    const ry = y + upperHeight * 0.7

    // Pod body
    const pod = new THREE.Mesh(rcsGeo, rcsMat)
    pod.position.set(rx, ry, rz)
    pod.rotation.y = -angle
    pod.castShadow = true
    rocket.add(pod)

    // Thruster nozzle (tiny cone pointing outward)
    const rcsCone = new THREE.Mesh(rcsConeGeo, engineMat)
    rcsCone.position.set(
      Math.cos(angle) * 0.28,
      ry,
      Math.sin(angle) * 0.28
    )
    rcsCone.rotation.z = -Math.PI / 2
    rcsCone.rotation.y = -angle
    rocket.add(rcsCone)
  }

  y += upperHeight

  addSeamRing(rocket, seamMat, 0.225, y)

  // ============================================================
  // PAYLOAD FAIRING (ogive nose — not a simple cone)
  // ============================================================

  // Build an ogive (tangent ogive curve) via LatheGeometry for a
  // more realistic nose shape than ConeGeometry's straight sides.
  const fairingHeight = 0.9
  const fairingRadius = 0.22
  const fairingPoints: THREE.Vector2[] = []
  const FAIRING_SEGMENTS = 16

  for (let i = 0; i <= FAIRING_SEGMENTS; i++) {
    const t = i / FAIRING_SEGMENTS // 0 = base, 1 = tip
    // Ogive curve: radius = R * sqrt(1 - (t)^2) with a power tweak
    // for a sharper tip than a pure hemisphere
    const r = fairingRadius * Math.pow(1 - Math.pow(t, 1.8), 0.5)
    const yp = t * fairingHeight
    fairingPoints.push(new THREE.Vector2(Math.max(r, 0.005), yp)) // min radius to avoid degenerate tip
  }
  // Close at tip
  fairingPoints.push(new THREE.Vector2(0.001, fairingHeight))

  const fairingGeo = new THREE.LatheGeometry(fairingPoints, 24)
  const fairing = new THREE.Mesh(fairingGeo, fairingMat)
  fairing.position.y = y
  fairing.castShadow = true
  rocket.add(fairing)

  // Fairing separation line (visual detail — the split line where
  // the two halves separate to release the payload)
  const sepLineGeo = new THREE.RingGeometry(
    fairingRadius * 0.65 - 0.005,
    fairingRadius * 0.65 + 0.005,
    24
  )
  const sepLine = new THREE.Mesh(sepLineGeo, seamMat)
  sepLine.position.y = y + fairingHeight * 0.35
  sepLine.rotation.x = -Math.PI / 2
  rocket.add(sepLine)

  y += fairingHeight

  // ============================================================
  // FINS — swept delta, mounted at the engine skirt
  // ============================================================

  // Swept delta fin shape (like Atlas V / Falcon 9 grid fins proportions,
  // but solid panels — more Vostok/Atlas-Centaur era)
  const finShape = new THREE.Shape()
  finShape.moveTo(0, 0)          // root leading edge
  finShape.lineTo(0.55, 0.1)     // tip leading edge (swept back)
  finShape.lineTo(0.5, 0.5)      // tip trailing edge
  finShape.lineTo(0.05, 0.65)    // root trailing edge
  finShape.lineTo(0, 0)          // close

  const finExtrude = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.035,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.008,
    bevelSegments: 2
  })

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4 // offset 45° so fins sit between nozzles

    const fin = new THREE.Mesh(finExtrude, finMat)
    fin.position.set(
      Math.cos(angle) * 0.36,
      0.55 * 0.15, // sits near the bottom of the skirt
      Math.sin(angle) * 0.36
    )
    fin.rotation.y = -angle
    fin.rotation.x = -Math.PI / 2
    fin.castShadow = true
    rocket.add(fin)
  }

  rocket.position.y = 0
  scene.add(rocket)
  return rocket
}

// Panel seam ring — thin dark torus at body junctions
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