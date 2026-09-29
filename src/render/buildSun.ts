import * as THREE from 'three'

// Visible sun disc matching the scene's DirectionalLight, so the light
// source is visually grounded rather than implied. Position and color are
// passed in from Scene.tsx's existing sun light definition (not
// re-hardcoded here) so the two can't silently drift apart if the light
// is retuned later.
const SUN_DISTANCE = 1800 // scene units — inside the sky dome's 2000 radius
const SUN_RADIUS = 60

// Scene.tsx's UnrealBloomPass threshold is 0.8, and ACES tone mapping is
// active on the renderer. toneMapped=false on this material (below) skips
// the tonemapping shader chunk for this material's own draw call, so its
// raw (overbright) color reaches UnrealBloomPass's luminance threshold
// check at full strength while still inside the composer pipeline, instead
// of being compressed toward 1.0 by ACES first — the standard three.js
// technique for HDR-ish emissive elements feeding a tonemapped bloom
// pipeline. The final composited frame (scene + bloom glow) still gets
// tonemapped once, at OutputPass, same as everything else, so this reads
// as a bright core with a soft blown-out edge, not a flat colored circle.
const SUN_BRIGHTNESS = 3.5

export function buildSun(
  scene: THREE.Scene,
  lightPosition: THREE.Vector3,
  lightColor: THREE.ColorRepresentation
): void {
  const position = lightPosition.clone().normalize().multiplyScalar(SUN_DISTANCE)
  const color = new THREE.Color(lightColor).multiplyScalar(SUN_BRIGHTNESS)

  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 16, 12), mat)
  mesh.position.copy(position)

  scene.add(mesh)
}
