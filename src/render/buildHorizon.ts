import * as THREE from 'three'

// Distant mountain/hill silhouette ring around the pad, so the ground
// doesn't just vanish into a flat horizon line. Positioned beyond the
// ground cap's horizon limb (buildGround.ts: PLANET_RADIUS=420,
// CAP_HALF_ANGLE≈33° puts the limb glow band's outer edge around radius
// ~310) and well inside both the fog-far distance (Scene.tsx: 600) and
// the sky dome radius (2000) — far enough to read as a hazy, fog-softened
// ridge rather than clipping through nearby ground geometry, close enough
// that fog (far=600) doesn't fully swallow it, just haze it appropriately.
const HORIZON_RADIUS = 450
const SEGMENT_COUNT = 48
const BASE_Y = -5
const PEAK_MIN_HEIGHT = 12
const PEAK_MAX_HEIGHT = 40

// Dark, desaturated version of the scene's warm horizon tones (fog
// 0xcf7c5c, sky dome bottomColor 0xe0875f — see Scene.tsx) rather than
// flat black, so the ridge reads as a shadowed silhouette against the
// warm glow instead of a hard cutout.
const HORIZON_COLOR = 0x3a2b24

// Single low-poly ring mesh: a flat base circle and a jagged "peak" circle
// (independently randomized height per angular step) stitched into a
// continuous strip — two triangles per segment, no gaps. This is a
// silhouette/backdrop element, not detailed terrain, so this is
// deliberately as simple as a mesh can be while still reading as a ridge.
export function buildHorizon(scene: THREE.Scene): void {
  const positions = new Float32Array((SEGMENT_COUNT + 1) * 2 * 3)

  for (let i = 0; i <= SEGMENT_COUNT; i++) {
    const angle = (i / SEGMENT_COUNT) * Math.PI * 2
    const cx = Math.cos(angle) * HORIZON_RADIUS
    const cz = Math.sin(angle) * HORIZON_RADIUS
    const peakY = BASE_Y + PEAK_MIN_HEIGHT + Math.random() * (PEAK_MAX_HEIGHT - PEAK_MIN_HEIGHT)

    const baseIdx = i * 2 * 3
    positions[baseIdx] = cx
    positions[baseIdx + 1] = BASE_Y
    positions[baseIdx + 2] = cz

    const peakIdx = baseIdx + 3
    positions[peakIdx] = cx
    positions[peakIdx + 1] = peakY
    positions[peakIdx + 2] = cz
  }

  const indices: number[] = []
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const base0 = i * 2
    const peak0 = base0 + 1
    const base1 = base0 + 2
    const peak1 = base0 + 3
    indices.push(base0, peak0, base1)
    indices.push(peak0, peak1, base1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(indices)

  // Unlit flat silhouette — no PBR response needed, and MeshBasicMaterial
  // respects scene.fog by default, so the ridge naturally softens toward
  // the fog color with distance instead of a crisp cutout. No
  // shadow-casting/receiving; this is a cheap distant backdrop.
  const mat = new THREE.MeshBasicMaterial({ color: HORIZON_COLOR, side: THREE.DoubleSide })

  scene.add(new THREE.Mesh(geo, mat))
}
