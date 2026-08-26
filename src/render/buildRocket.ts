import * as THREE from 'three'

export interface RocketBuildResult {
  rocket: THREE.Group
  nozzleGroup: THREE.Group  // rotates for gimbal animation
}

export function buildRocket(scene: THREE.Scene): RocketBuildResult {
  const rocket = new THREE.Group()

  // ---- Materials ----
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xb8bcc2, roughness: 0.28, metalness: 0.85, envMapIntensity: 0.6
  })
  const thermalMat = new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.9, metalness: 0.1
  })
  const engineMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1e, roughness: 0.5, metalness: 0.8
  })
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0, roughness: 0.35, metalness: 0.3, envMapIntensity: 0.4
  })
  const fairingMat = new THREE.MeshStandardMaterial({
    color: 0xeeeee8, roughness: 0.25, metalness: 0.2, envMapIntensity: 0.5
  })
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x050505, roughness: 0.9, metalness: 0.1
  })
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x8a8e94, roughness: 0.35, metalness: 0.7
  })
  const rcsMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a, roughness: 0.6, metalness: 0.7
  })
  const portMat = new THREE.MeshStandardMaterial({
    color: 0x666666, roughness: 0.5, metalness: 0.6
  })
  const nozzleRimMat = new THREE.MeshStandardMaterial({
    color: 0x443322, roughness: 0.3, metalness: 0.9,
    emissive: new THREE.Color(0x221100), emissiveIntensity: 0.3
  })

  let y = 0

  // ============================================================
  // NOZZLE GROUP — everything that physically rotates with gimbal
  // Pivot point is at y=0 (the engine mount plane) so the rotation
  // correctly swings the nozzle exits outward.
  // ============================================================
  const nozzleGroup = new THREE.Group()

  // Boat-tail
  const boatTailHeight = 0.3
  const boatTail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.30, 0.40, boatTailHeight, 24),
    engineMat
  )
  boatTail.position.y = boatTailHeight / 2
  boatTail.castShadow = true
  nozzleGroup.add(boatTail)

  // Main nozzle bell
  const mainNozzle = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.55, 20, 1, true),
    engineMat
  )
  mainNozzle.position.set(0, -0.12, 0)
  mainNozzle.rotation.x = Math.PI
  mainNozzle.castShadow = true
  nozzleGroup.add(mainNozzle)

  // Main nozzle rim
  const nozzleRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.115, 0.016, 8, 20),
    nozzleRimMat
  )
  nozzleRim.position.set(0, -0.38, 0)
  nozzleRim.rotation.x = Math.PI / 2
  nozzleGroup.add(nozzleRim)

  // Vernier nozzles
  const vernierGeo = new THREE.ConeGeometry(0.045, 0.22, 12, 1, true)
  const vernierAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
  for (const angle of vernierAngles) {
    const vx = Math.cos(angle) * 0.22
    const vz = Math.sin(angle) * 0.22
    const vernier = new THREE.Mesh(vernierGeo, engineMat)
    vernier.position.set(vx, -0.05, vz)
    vernier.rotation.x = Math.PI
    const cantDir = new THREE.Vector3(vx, 0, vz).normalize()
    vernier.rotateOnWorldAxis(
      new THREE.Vector3(-cantDir.z, 0, cantDir.x).normalize(), 0.14
    )
    vernier.castShadow = true
    nozzleGroup.add(vernier)

    const vRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.038, 0.008, 6, 14),
      nozzleRimMat
    )
    vRim.position.set(vx, -0.24, vz)
    vRim.rotation.x = Math.PI / 2
    nozzleGroup.add(vRim)
  }

  // Add nozzle group to rocket — pivot at y=0
  rocket.add(nozzleGroup)
  y = boatTailHeight

  // Engine skirt sits above the boat-tail
  const skirtHeight = 0.45
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.40, skirtHeight, 24),
    engineMat
  )
  skirt.position.y = y + skirtHeight / 2
  skirt.castShadow = true
  rocket.add(skirt)
  y += skirtHeight

  addSeamRing(rocket, seamMat, 0.345, y)

  // ============================================================
  // FINS
  // ============================================================
  const finShape = new THREE.Shape()
  finShape.moveTo(0, 0)
  finShape.lineTo(0.5, -0.1)
  finShape.lineTo(0.48, 0.48)
  finShape.lineTo(0.0, 0.62)
  finShape.lineTo(0, 0)

  const finExtrude = new THREE.ExtrudeGeometry(finShape, {
    depth: 0.032, bevelEnabled: true,
    bevelThickness: 0.007, bevelSize: 0.007, bevelSegments: 2
  })

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
    const fin = new THREE.Mesh(finExtrude, finMat)
    fin.position.set(
      Math.cos(angle) * 0.38,
      boatTailHeight * 0.5,
      Math.sin(angle) * 0.38
    )
    fin.rotation.y = -angle
    fin.rotation.x = -Math.PI / 2
    fin.castShadow = true
    rocket.add(fin)
  }

  // ============================================================
  // BOOSTER STAGE
  // ============================================================
  const boosterHeight = 2.4
  const booster = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.34, boosterHeight, 24),
    steelMat
  )
  booster.position.y = y + boosterHeight / 2
  booster.castShadow = true
  rocket.add(booster)

  addSeamRing(rocket, seamMat, 0.325, y + boosterHeight * 0.45)

  const portGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8)
  const port = new THREE.Mesh(portGeo, portMat)
  port.position.set(0.34, y + boosterHeight * 0.3, 0)
  port.rotation.z = Math.PI / 2
  rocket.add(port)

  const port2 = new THREE.Mesh(portGeo, portMat)
  port2.position.set(-0.34, y + boosterHeight * 0.65, 0)
  port2.rotation.z = Math.PI / 2
  rocket.add(port2)

  y += boosterHeight
  addSeamRing(rocket, seamMat, 0.325, y)

  // ============================================================
  // INTERSTAGE
  // ============================================================
  const bandHeight = 0.2
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, bandHeight, 24),
    thermalMat
  )
  band.position.y = y + bandHeight / 2
  band.castShadow = true
  rocket.add(band)
  y += bandHeight

  const taperHeight = 0.45
  const taper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.32, taperHeight, 24),
    thermalMat
  )
  taper.position.y = y + taperHeight / 2
  taper.castShadow = true
  rocket.add(taper)
  y += taperHeight

  addSeamRing(rocket, seamMat, 0.225, y)

  // ============================================================
  // UPPER STAGE
  // ============================================================
  const upperHeight = 1.2
  const upper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, upperHeight, 24),
    whiteMat
  )
  upper.position.y = y + upperHeight / 2
  upper.castShadow = true
  rocket.add(upper)

  addSeamRing(rocket, seamMat, 0.225, y + upperHeight * 0.5)

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
  // PAYLOAD FAIRING
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

  const fairing = new THREE.Mesh(
    new THREE.LatheGeometry(fairingPoints, 24),
    fairingMat
  )
  fairing.position.y = y
  fairing.castShadow = true
  rocket.add(fairing)

  const sepLine = new THREE.Mesh(
    new THREE.RingGeometry(fairingRadius * 0.65 - 0.005, fairingRadius * 0.65 + 0.005, 24),
    seamMat
  )
  sepLine.position.y = y + fairingHeight * 0.35
  sepLine.rotation.x = -Math.PI / 2
  rocket.add(sepLine)

  rocket.position.y = 0
  scene.add(rocket)
  return { rocket, nozzleGroup }
}

function addSeamRing(group: THREE.Group, material: THREE.Material, radius: number, y: number) {
  const geo = new THREE.TorusGeometry(radius, 0.008, 6, 32)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = y
  mesh.rotation.x = Math.PI / 2
  group.add(mesh)
}