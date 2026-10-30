import * as THREE from 'three'

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  TRUE-SCALE PLANET                                                   ║
// ║                                                                      ║
// ║  A fan-fictional Earth: correct radius (6 371 km), procedural        ║
// ║  continents, oceans and mountains from 3D noise, atmosphere limb     ║
// ║  visible from space.                                                 ║
// ║                                                                      ║
// ║  Two meshes:                                                         ║
// ║   1. Globe sphere — medium poly, noise-coloured, the whole planet.   ║
// ║   2. Near patch — high-res disc at ground level for surface detail   ║
// ║      when the camera is low; fades out with altitude.                ║
// ║                                                                      ║
// ║  The pad sits at the top of the sphere (+Y). Land is biased around   ║
// ║  the pad so the launch site is always on a green island.             ║
// ╚═══════════════════════════════════════════════════════════════════════╝

// ---- Constants --------------------------------------------------------
const EARTH_RADIUS_M = 6_371_000
/** 1 scene unit = 20 metres (matching ALTITUDE_SCALE = 0.05 in Scene.tsx) */
export const ALTITUDE_SCALE = 0.05
export const PLANET_RADIUS = EARTH_RADIUS_M * ALTITUDE_SCALE  // 318 550

const ATMOSPHERE_THICKNESS_M = 80_000
const ATMOSPHERE_THICKNESS = ATMOSPHERE_THICKNESS_M * ALTITUDE_SCALE // 4000

const SEA_LEVEL = 0.50
const PAD_LAND_RADIUS = 0.42
const PAD_LAND_BOOST = 0.30
const WORLD_SEED = new THREE.Vector3(1.7, 4.2, 9.1)

// Near-patch: a high-res disc covering ~20 km radius, visible at low altitude.
const NEAR_PATCH_RADIUS_M = 20_000
const NEAR_PATCH_RADIUS = NEAR_PATCH_RADIUS_M * ALTITUDE_SCALE // 1000 units
const NEAR_PATCH_SEGMENTS = 160  // 160×160 grid — ~125 m per cell = good detail
const NEAR_PATCH_FADE_START_M = 8_000   // start fading the patch
const NEAR_PATCH_FADE_END_M = 40_000    // patch gone, globe takes over

// Altitudes (metres) for fade-ins.
const CLOUD_FADE: [number, number] = [300, 4000]
const GLOW_FADE: [number, number] = [2000, 60_000]

// ---- Types ------------------------------------------------------------
export interface GroundResult {
  group: THREE.Group
  /** Call each frame with altitude in metres. */
  update: (altitudeMetres: number) => void
  dispose: () => void
}

// ---- GLSL noise (shared by globe + near patch) -----------------------
const NOISE_GLSL = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i+vec3(0,0,0)), hash31(i+vec3(1,0,0)), f.x),
        mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
        mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(7.1, 3.7, 5.3);
    a *= 0.5;
  }
  return s;
}
`

const PLANET_COLOR_GLSL = /* glsl */ `
uniform float uCloud;
uniform float uSea;
uniform float uPadRadius;
uniform float uPadBoost;
uniform vec3  uSeed;
float gOcean = 0.0;

vec3 planetColor(vec3 n) {
  // Domain-warped continent noise — organic coastlines.
  vec3 q = n * 2.3 + uSeed;
  vec3 warp = vec3(fbm(q*1.7), fbm(q*1.7+11.0), fbm(q*1.7+23.0)) - 0.5;
  float h = fbm(q + warp * 0.9);

  // Bias: keep the launch site on land.
  float ang = acos(clamp(n.y, -1.0, 1.0));
  float padMask = smoothstep(uPadRadius, 0.05, ang);
  h += uPadBoost * padMask;

  float e = h - uSea;
  float eCol = mix(e, clamp(e, 0.0, 0.07), padMask);

  // Metre-scale detail (only matters on the near patch).
  float detail = vnoise(n * 420.0) * 0.6 + vnoise(n * 1680.0) * 0.4;

  vec3 col;
  if (e >= 0.0) {
    gOcean = 0.0;
    vec3 sand    = vec3(0.80, 0.74, 0.50);
    vec3 lowland = vec3(0.27, 0.62, 0.25);
    vec3 midland = vec3(0.16, 0.45, 0.19);
    vec3 hills   = vec3(0.42, 0.40, 0.24);
    vec3 peaks   = vec3(0.86, 0.88, 0.90);
    col = mix(sand, lowland, smoothstep(0.004, 0.03, eCol));
    col = mix(col, midland,  smoothstep(0.04,  0.10, eCol));
    col = mix(col, hills,    smoothstep(0.11,  0.17, eCol));
    col = mix(col, peaks,    smoothstep(0.19,  0.24, eCol));
    col *= 0.90 + 0.20 * detail;
  } else {
    gOcean = 1.0;
    float d = -e;
    vec3 shallow = vec3(0.12, 0.58, 0.72);
    vec3 mid     = vec3(0.06, 0.34, 0.60);
    vec3 deep    = vec3(0.03, 0.16, 0.42);
    col = mix(shallow, mid, smoothstep(0.0, 0.06, d));
    col = mix(col, deep,    smoothstep(0.05, 0.20, d));
    col = mix(col, vec3(0.88, 0.95, 0.97), 0.55 * smoothstep(0.012, 0.0, d));
    col *= 0.96 + 0.08 * detail;
  }

  // Soft white cloud patches on the globe (fade in with altitude).
  float c = fbm(n * 3.6 + vec3(5.2, 1.3, 8.8));
  float cloud = smoothstep(0.56, 0.74, c) * uCloud;
  col = mix(col, vec3(0.97, 0.98, 1.0), cloud * 0.92);
  if (cloud > 0.3) gOcean = 0.0;

  return col;
}
`

// ---- Shared uniforms (both meshes reference the same set) -------------
function makeUniforms() {
  return {
    uCloud:     { value: 0 },
    uSea:       { value: SEA_LEVEL },
    uPadRadius: { value: PAD_LAND_RADIUS },
    uPadBoost:  { value: PAD_LAND_BOOST },
    uSeed:      { value: WORLD_SEED.clone() }
  }
}

// ── BUILD ──────────────────────────────────────────────────────────────

export function buildGround(): GroundResult {
  const group = new THREE.Group()
  const uniforms = makeUniforms()
  const planetCenter = new THREE.Vector3(0, -PLANET_RADIUS, 0)

  // ════════════════════════ 1. Globe sphere ════════════════════════════
  // 256×128 gives ~2.5 km triangles at the equator — fine for the
  // orbital/high-altitude view. We need the near patch for close-up.
  const globeGeo = new THREE.SphereGeometry(PLANET_RADIUS, 256, 128)
  const globeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0
  })
  globeMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSphereNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSphereNormal = normalize(position);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vSphereNormal;\n${NOISE_GLSL}\n${PLANET_COLOR_GLSL}`)
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb = planetColor(vSphereNormal);')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.95, 0.32, gOcean);')
  }
  const globe = new THREE.Mesh(globeGeo, globeMat)
  globe.receiveShadow = true
  globe.position.copy(planetCenter)
  group.add(globe)

  // ════════════════════════ 2. Near patch ══════════════════════════════
  // A flat grid at y ≈ 0 coloured by the same noise. Gives close-up
  // surface detail the coarse globe sphere can't. Faded out with altitude.
  const nearGeo = new THREE.PlaneGeometry(
    NEAR_PATCH_RADIUS * 2, NEAR_PATCH_RADIUS * 2,
    NEAR_PATCH_SEGMENTS, NEAR_PATCH_SEGMENTS
  )
  nearGeo.rotateX(-Math.PI / 2) // flat on XZ

  const nearMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0, transparent: true
  })
  nearMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.uniforms.uPlanetCenter = { value: planetCenter }
    // Project the patch onto a radius slightly OUTSIDE the globe's own
    // radius, in the same world units the projection runs in. The patch's
    // local `position.y = 0.01` nudge (see where this mesh is created) has
    // no effect on z-fighting: every vertex's position is overwritten by
    // this projection, which previously targeted the exact same radius as
    // the globe sphere, so the two surfaces coincided exactly and the
    // renderer picked a winner per pixel per frame at random (depth-buffer
    // noise) -> the flicker. At this radius (~318,550 units) a fixed 0.01
    // offset is far below float precision at that magnitude, so the patch
    // is pushed out by a radius-relative amount instead.
    const patchRadiusOffset = PLANET_RADIUS * 2e-5 // ~6.4 units at Earth scale
    shader.uniforms.uPlanetRadius = { value: PLANET_RADIUS + patchRadiusOffset }
    shader.uniforms.uPatchOpacity = { value: 1.0 }
    shader.uniforms.uPatchRadius = { value: NEAR_PATCH_RADIUS }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uPatchRadius;
varying vec3 vSphereNormal;
varying float vEdgeFade;`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
// Project flat grid vertex onto the planet sphere surface, offset
// slightly outward from the globe's own radius (uPlanetRadius here is
// PLANET_RADIUS + patchRadiusOffset, not the raw PLANET_RADIUS) so the
// two meshes never occupy the same depth and cannot z-fight.
vec3 worldFlat = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec3 toCenter = worldFlat - uPlanetCenter;
vec3 dir = normalize(toCenter);
transformed = (inverse(modelMatrix) * vec4(uPlanetCenter + dir * uPlanetRadius, 1.0)).xyz;
vSphereNormal = dir;
float r = length(worldFlat.xz);
vEdgeFade = 1.0 - smoothstep(uPatchRadius * 0.7, uPatchRadius, r);`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
varying vec3 vSphereNormal;
varying float vEdgeFade;
uniform float uPatchOpacity;
${NOISE_GLSL}
${PLANET_COLOR_GLSL}`)
      .replace('#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = planetColor(vSphereNormal);
diffuseColor.a = uPatchOpacity * vEdgeFade;`)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.95, 0.32, gOcean);')
  }

  const nearPatch = new THREE.Mesh(nearGeo, nearMat)
  nearPatch.receiveShadow = true
  // No local Y offset here: the vertex shader above overwrites `transformed`
  // completely (projecting onto the sphere), so any local position.y nudge
  // on this mesh has zero effect on the actual rendered geometry — the
  // anti-z-fight offset has to live in uPlanetRadius instead (see above).
  nearPatch.renderOrder = 1
  group.add(nearPatch)

  // ════════════════════════ 3. Scorch mark ════════════════════════════
  const scorchCanvas = document.createElement('canvas')
  scorchCanvas.width = 256; scorchCanvas.height = 256
  const sctx = scorchCanvas.getContext('2d')!
  const grad = sctx.createRadialGradient(128, 128, 10, 128, 128, 128)
  grad.addColorStop(0, 'rgba(0,0,0,0.9)')
  grad.addColorStop(0.35, 'rgba(60,40,20,0.6)')
  grad.addColorStop(0.7, 'rgba(80,60,30,0.25)')
  grad.addColorStop(1, 'rgba(80,60,30,0)')
  sctx.fillStyle = grad; sctx.fillRect(0, 0, 256, 256)
  const scorchTexture = new THREE.CanvasTexture(scorchCanvas)
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(5, 32),
    new THREE.MeshBasicMaterial({ map: scorchTexture, transparent: true, depthWrite: false })
  )
  scorch.rotation.x = -Math.PI / 2
  scorch.position.y = 0.02
  scorch.renderOrder = 2
  group.add(scorch)

  // ════════════════════════ 4. Atmosphere ═════════════════════════════
  // Back-faced shell with Rayleigh-ish rim glow. From the ground it's
  // invisible (camera inside); from orbit it shows the blue limb.
  const atmoGeo = new THREE.SphereGeometry(PLANET_RADIUS + ATMOSPHERE_THICKNESS, 128, 64)
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        float rim = clamp(-dot(normalize(vNormalV), normalize(vViewDir)), 0.0, 1.0);
        float g = pow(rim, 1.8);
        vec3 col = mix(vec3(0.22, 0.50, 1.0), vec3(0.60, 0.82, 1.0), g);
        gl_FragColor = vec4(col * g * 1.4 * uIntensity, 1.0);
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  })
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat)
  atmosphere.position.copy(planetCenter)
  group.add(atmosphere)

  // ── helpers ──
  function ramp(v: number, [a, b]: [number, number]) {
    const t = Math.min(Math.max((v - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }

  let patchOpacityUniform: { value: number } | null = null
  // Capture the uniform reference after the first compile.
  const origOnBeforeCompile = nearMat.onBeforeCompile
  nearMat.onBeforeCompile = (shader, renderer) => {
    origOnBeforeCompile.call(nearMat, shader, renderer)
    patchOpacityUniform = shader.uniforms.uPatchOpacity as { value: number }
  }

  function update(altitudeMetres: number) {
    // Globe cloud layer fades in with altitude.
    uniforms.uCloud.value = ramp(altitudeMetres, CLOUD_FADE)
    // Atmosphere limb glow fades in.
    atmoMat.uniforms.uIntensity.value = ramp(altitudeMetres, GLOW_FADE)
    // Near patch fades out as the globe takes over.
    const patchAlpha = 1 - ramp(altitudeMetres, [NEAR_PATCH_FADE_START_M, NEAR_PATCH_FADE_END_M])
    if (patchOpacityUniform) patchOpacityUniform.value = patchAlpha
    nearPatch.visible = patchAlpha > 0.01
  }

  function dispose() {
    globeGeo.dispose(); globeMat.dispose()
    nearGeo.dispose(); nearMat.dispose()
    scorchTexture.dispose()
    atmoGeo.dispose(); atmoMat.dispose()
    group.clear()
  }

  return { group, update, dispose }
}