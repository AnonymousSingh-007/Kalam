import * as THREE from 'three'

// Stylised "dummy Earth": a full procedural planet (green land, blue ocean,
// sandy coasts, white clouds, blue atmosphere rim). No image files, no
// textures: colour is computed per pixel from 3D noise on the sphere, so
// there are no tiling seams and no UV pole pinching.
//
// The pad sits at the top of the sphere (local +Y). Land is biased around
// the pad so the launch site is always on a green island, and the coast
// appears a few km out, which you notice as the rocket climbs.
//
// Colour only: the geometry is a perfectly smooth sphere, so the physics
// ground (y = 0) always matches what you see.

// ---- Tunables ---------------------------------------------------------
// Smaller radius = tighter, more dramatic curvature.
const PLANET_RADIUS = 420
// Atmosphere shell thickness in scene units.
const ATMOSPHERE_THICKNESS = 26
// 0.50 = half land / half ocean. Raise for more ocean, lower for more land.
const SEA_LEVEL = 0.5
// Land bias around the pad (radians of arc from the pad) and strength.
const PAD_LAND_RADIUS = 0.42
const PAD_LAND_BOOST = 0.3
// Change to get a different world layout.
const WORLD_SEED = new THREE.Vector3(1.7, 4.2, 9.1)
// Altitudes (metres) over which clouds and the rim glow fade in.
const CLOUD_FADE: [number, number] = [150, 1800]
const GLOW_FADE: [number, number] = [500, 3500]

export interface GroundResult {
  group: THREE.Group
  // Call each frame with current rocket altitude (in metres, not scene units)
  // so clouds and the atmosphere rim can fade in with height.
  update: (altitudeMetres: number) => void
  dispose: () => void
}

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
    mix(mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(7.1, 3.7, 5.3);
    a *= 0.5;
  }
  return s;
}
`

const PLANET_GLSL = /* glsl */ `
uniform float uCloud;
uniform float uSea;
uniform float uPadRadius;
uniform float uPadBoost;
uniform vec3  uSeed;
float gOcean = 0.0;

vec3 planetColor(vec3 P) {
  vec3 n = normalize(P);

  // Domain-warped continent noise gives organic coastlines.
  vec3 q = n * 2.3 + uSeed;
  vec3 warp = vec3(fbm(q * 1.7), fbm(q * 1.7 + 11.0), fbm(q * 1.7 + 23.0)) - 0.5;
  float h = fbm(q + warp * 0.9);

  // Keep the launch site on land.
  float ang = acos(clamp(n.y, -1.0, 1.0));
  float padMask = smoothstep(uPadRadius, 0.05, ang);
  h += uPadBoost * padMask;

  float e = h - uSea;          // >0 land, <0 water
  // The boost decides land vs water, but must not turn the pad area into
  // mountains or snow: near the pad, cap the elevation used for colour.
  float eCol = mix(e, clamp(e, 0.0, 0.07), padMask);

  // Fine ground detail (metres-scale) so you can feel speed near the surface.
  float detail = vnoise(P * 0.9) * 0.6 + vnoise(P * 4.0) * 0.4;

  vec3 col;
  if (e >= 0.0) {
    gOcean = 0.0;
    vec3 sand     = vec3(0.80, 0.74, 0.50);
    vec3 lowland  = vec3(0.27, 0.62, 0.25);
    vec3 midland  = vec3(0.16, 0.45, 0.19);
    vec3 hills    = vec3(0.42, 0.40, 0.24);
    vec3 peaks    = vec3(0.86, 0.88, 0.90);
    col = mix(sand, lowland, smoothstep(0.004, 0.03, eCol));
    col = mix(col, midland, smoothstep(0.04, 0.10, eCol));
    col = mix(col, hills,   smoothstep(0.11, 0.17, eCol));
    col = mix(col, peaks,   smoothstep(0.19, 0.24, eCol));
    col *= 0.90 + 0.20 * detail;
  } else {
    gOcean = 1.0;
    float d = -e;
    vec3 shallow = vec3(0.12, 0.58, 0.72);
    vec3 mid     = vec3(0.06, 0.34, 0.60);
    vec3 deep    = vec3(0.03, 0.16, 0.42);
    col = mix(shallow, mid, smoothstep(0.0, 0.06, d));
    col = mix(col, deep,    smoothstep(0.05, 0.20, d));
    // Foam line at the coast.
    col = mix(col, vec3(0.88, 0.95, 0.97), 0.55 * smoothstep(0.012, 0.0, d));
    col *= 0.96 + 0.08 * detail;
  }

  // Soft white clouds, faded in with altitude.
  float c = fbm(n * 3.6 + vec3(5.2, 1.3, 8.8));
  float cloud = smoothstep(0.56, 0.74, c) * uCloud;
  col = mix(col, vec3(0.97, 0.98, 1.0), cloud * 0.92);
  if (cloud > 0.3) gOcean = 0.0;

  return col;
}
`

export function buildGround(): GroundResult {
  const group = new THREE.Group()

  // ---- Planet (full sphere, so the edge is never visible from altitude) ----
  const planetGeo = new THREE.SphereGeometry(PLANET_RADIUS, 192, 96)

  const planetUniforms = {
    uCloud: { value: 0 },
    uSea: { value: SEA_LEVEL },
    uPadRadius: { value: PAD_LAND_RADIUS },
    uPadBoost: { value: PAD_LAND_BOOST },
    uSeed: { value: WORLD_SEED.clone() }
  }

  const planetMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0
  })
  planetMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, planetUniforms)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPlanetPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlanetPos = position;')

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vPlanetPos;\n${NOISE_GLSL}\n${PLANET_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb = planetColor(vPlanetPos);'
      )
      // Water is glossy (sun glint), land is matte.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.95, 0.32, gOcean);'
      )
  }

  const planet = new THREE.Mesh(planetGeo, planetMat)
  planet.receiveShadow = true
  // Pad (top of the sphere) sits at y = -0.5, same as the old ground plane.
  planet.position.y = -(PLANET_RADIUS + 0.5)
  group.add(planet)

  // ---- Scorch mark under the pad (flat decal) ----
  const scorchCanvas = document.createElement('canvas')
  scorchCanvas.width = 256
  scorchCanvas.height = 256
  const sctx = scorchCanvas.getContext('2d')!
  const grad = sctx.createRadialGradient(128, 128, 10, 128, 128, 128)
  grad.addColorStop(0, 'rgba(0,0,0,0.9)')
  grad.addColorStop(0.35, 'rgba(60,40,20,0.6)')
  grad.addColorStop(0.7, 'rgba(80,60,30,0.25)')
  grad.addColorStop(1, 'rgba(80,60,30,0)')
  sctx.fillStyle = grad
  sctx.fillRect(0, 0, 256, 256)
  const scorchTexture = new THREE.CanvasTexture(scorchCanvas)
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(5, 32),
    new THREE.MeshBasicMaterial({ map: scorchTexture, transparent: true, depthWrite: false })
  )
  scorch.rotation.x = -Math.PI / 2
  scorch.position.y = -0.46
  group.add(scorch)

  // ---- Atmosphere rim glow ----
  // Back-faced shell; brightest next to the planet's limb, fading to nothing
  // at the shell's outer edge. Faded out near the ground because the camera
  // is inside the shell down there.
  const atmoGeo = new THREE.SphereGeometry(PLANET_RADIUS + ATMOSPHERE_THICKNESS, 96, 64)
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
        float g = pow(rim, 1.4);
        vec3 col = mix(vec3(0.25, 0.55, 1.0), vec3(0.65, 0.85, 1.0), g);
        gl_FragColor = vec4(col * g * 1.6 * uIntensity, 1.0);
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  })
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat)
  atmosphere.position.y = planet.position.y
  group.add(atmosphere)

  function ramp(v: number, [a, b]: [number, number]) {
    const t = Math.min(Math.max((v - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }

  function update(altitudeMetres: number) {
    planetUniforms.uCloud.value = ramp(altitudeMetres, CLOUD_FADE)
    atmoMat.uniforms.uIntensity.value = ramp(altitudeMetres, GLOW_FADE)
  }

  function dispose() {
    planetGeo.dispose()
    planetMat.dispose()
    scorchTexture.dispose()
    atmoGeo.dispose()
    atmoMat.dispose()
    group.clear()
  }

  return { group, update, dispose }
}