import * as THREE from 'three'
import type { QualityTier } from '../types'

// Volumetric cloud layer driven by one shared, pre-baked 3D noise texture.
//
// The previous version evaluated several octaves of procedural Perlin and
// Worley noise per ray step, which is far too expensive for integrated GPUs.
// Here the noise is baked once on the CPU into a small tileable RGBA volume
// (R = Perlin-Worley shape, G/B/A = Worley detail at rising frequency) and
// every ray step is a texture fetch.
//
// Each layer is still one enclosing dome mesh whose only job is to trigger a
// per-pixel march through its altitude slab (a ray crosses the dome once, so
// the integral is never double counted). The dome follows the camera.
//
// Quality tiers change the volume size, step counts and whether lighting
// samples the sun direction (self-shadowing) or uses a height gradient only.

export type CloudType = 'cumulus' | 'stratus' | 'cirrus'

const DOME_RADIUS = 600
// Matches buildGround's planet (centre at y = -radius so the surface sits at y = 0).
const PLANET_RADIUS = 420

// ═══════════════════════ baked 3D noise volume ═══════════════════════

const VOLUME_SIZE: Record<QualityTier, number> = { low: 32, medium: 48, high: 64 }

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  h = Math.imul(h ^ (h >>> 13), 3266489917)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n

// Tileable cellular noise: 1 at a feature point, falling to 0 a cell away.
function worley(x: number, y: number, z: number, freq: number, seed: number): number {
  const px = x * freq, py = y * freq, pz = z * freq
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz)
  let best = 4
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz
        const wx = wrap(cx, freq), wy = wrap(cy, freq), wz = wrap(cz, freq)
        const fx = cx + hash3(wx, wy, wz, seed) - px
        const fy = cy + hash3(wx, wy, wz, seed + 11) - py
        const fz = cz + hash3(wx, wy, wz, seed + 23) - pz
        const d = fx * fx + fy * fy + fz * fz
        if (d < best) best = d
      }
    }
  }
  return Math.max(0, 1 - Math.sqrt(best))
}

function worleyFbm(x: number, y: number, z: number, freq: number, seed: number): number {
  return 0.625 * worley(x, y, z, freq, seed) + 0.25 * worley(x, y, z, freq * 2, seed + 1) + 0.125 * worley(x, y, z, freq * 4, seed + 2)
}

function grad(ix: number, iy: number, iz: number, freq: number, seed: number, fx: number, fy: number, fz: number): number {
  const wx = wrap(ix, freq), wy = wrap(iy, freq), wz = wrap(iz, freq)
  let gx = hash3(wx, wy, wz, seed) * 2 - 1
  let gy = hash3(wx, wy, wz, seed + 5) * 2 - 1
  let gz = hash3(wx, wy, wz, seed + 9) * 2 - 1
  const l = Math.hypot(gx, gy, gz) || 1
  gx /= l; gy /= l; gz /= l
  return gx * fx + gy * fy + gz * fz
}

function perlin(x: number, y: number, z: number, freq: number, seed: number): number {
  const px = x * freq, py = y * freq, pz = z * freq
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz)
  const fx = px - ix, fy = py - iy, fz = pz - iz
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
  const g = (a: number, b: number, c: number): number => grad(ix + a, iy + b, iz + c, freq, seed, fx - a, fy - b, fz - c)
  const x00 = g(0, 0, 0) + u * (g(1, 0, 0) - g(0, 0, 0))
  const x10 = g(0, 1, 0) + u * (g(1, 1, 0) - g(0, 1, 0))
  const x01 = g(0, 0, 1) + u * (g(1, 0, 1) - g(0, 0, 1))
  const x11 = g(0, 1, 1) + u * (g(1, 1, 1) - g(0, 1, 1))
  const y0 = x00 + v * (x10 - x00)
  const y1 = x01 + v * (x11 - x01)
  return y0 + w * (y1 - y0)
}

function perlinFbm(x: number, y: number, z: number, freq: number, seed: number): number {
  return (perlin(x, y, z, freq, seed) * 0.5 + perlin(x, y, z, freq * 2, seed + 1) * 0.3 + perlin(x, y, z, freq * 4, seed + 2) * 0.2) * 0.5 + 0.5
}

function bakeVolume(n: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(new ArrayBuffer(n * n * n * 4))
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)))
  let o = 0
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = i / n, y = j / n, z = k / n
        const pn = perlinFbm(x, y, z, 4, 3)
        const wf = worleyFbm(x, y, z, 4, 17)
        const lo = (1 - wf) * 0.6
        data[o++] = q((pn - lo) / (1 - lo))          // R: Perlin-Worley shape
        data[o++] = q(wf)                              // G: Worley detail, base frequency
        data[o++] = q(worleyFbm(x, y, z, 8, 31))      // B: Worley detail, 2x
        data[o++] = q(worley(x, y, z, 16, 47))        // A: fine Worley
      }
    }
  }
  return data
}

let sharedTex: THREE.Data3DTexture | null = null
let sharedRefs = 0

function acquireVolume(q: QualityTier): THREE.Data3DTexture {
  if (!sharedTex) {
    const n = VOLUME_SIZE[q]
    const tex = new THREE.Data3DTexture(bakeVolume(n), n, n, n)
    tex.format = THREE.RGBAFormat
    tex.type = THREE.UnsignedByteType
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping
    tex.generateMipmaps = true
    tex.unpackAlignment = 1
    tex.needsUpdate = true
    sharedTex = tex
  }
  sharedRefs++
  return sharedTex
}

function releaseVolume(): void {
  sharedRefs--
  if (sharedRefs <= 0 && sharedTex) {
    sharedTex.dispose()
    sharedTex = null
    sharedRefs = 0
  }
}

// ═══════════════════════ shaders ═══════════════════════

const CLOUD_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uNoise;
  const float MAXD = float(MAX_DIST);
  uniform float uTime;
  uniform float uAltBase;
  uniform float uAltTop;
  uniform float uCoverage;
  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uAmbTop;
  uniform vec3  uAmbBot;
  uniform vec3  uFogColor;
  uniform vec2  uFogRange;
  uniform vec4  uPlanet;    // xyz centre, w radius
  uniform vec4  uOccluder;  // xyz centre, w radius (the rocket); w = 0 disables

  varying vec3 vWorldPos;

  // CLOUD_TYPE: 0 cumulus, 1 stratus, 2 cirrus
  // STEPS, LIGHT_STEPS, MAX_DIST are injected as defines.

  float cloudDensity(vec3 p, float h) {
    #if CLOUD_TYPE == 0
      vec3 wind = vec3(uTime * 0.9, 0.0, uTime * 0.5);
      vec3 q = (p + wind) * vec3(1.0 / 120.0, 1.0 / 90.0, 1.0 / 120.0);
      float shape = texture(uNoise, q).r;
      float cmap = texture(uNoise, vec3((p.x + wind.x * 0.3) * 0.0012, 0.37, p.z * 0.0012)).g;
      float cov = clamp(uCoverage + 0.12 + (cmap - 0.45) * 1.0, 0.0, 1.0);
      float hg = smoothstep(0.0, 0.10, h) * smoothstep(1.0, 0.45, h);
      float d = shape * hg;
      float thr = 1.0 - cov;
      d = clamp((d - thr) / max(1.0 - thr, 0.05), 0.0, 1.0);
      float det = texture(uNoise, q * 3.1).g * 0.65 + texture(uNoise, q * 7.3).b * 0.35;
      d = clamp(d - 0.30 * det * (1.0 - d), 0.0, 1.0);
      return d * 2.2;
    #elif CLOUD_TYPE == 1
      vec3 wind = vec3(uTime * 0.5, 0.0, uTime * 0.3);
      vec3 q = (p + wind) * vec3(1.0 / 300.0, 1.0 / 90.0, 1.0 / 300.0);
      float n = texture(uNoise, q).r * 0.65 + texture(uNoise, q * 2.7).g * 0.35;
      float hg = smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.6, h);
      float lo = 1.0 - uCoverage * 0.95;
      float d = smoothstep(lo, lo + 0.30, n) * hg;
      return d * 0.9;
    #else
      vec3 wind = vec3(uTime * 2.0, 0.0, 0.0);
      vec3 q = (p + wind) * vec3(1.0 / 900.0, 1.0 / 260.0, 1.0 / 190.0);
      float n = texture(uNoise, q).b * 0.7 + texture(uNoise, q * 2.3).a * 0.3;
      float hg = smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.6, h);
      float lo = 1.0 - uCoverage * 0.9;
      return smoothstep(lo, lo + 0.18, n) * hg * 0.16;
    #endif
  }

  float henyeyGreenstein(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
  }

  void main() {
    vec3 rayDir = normalize(vWorldPos - uCameraPos);

    float tBase, tTop;
    if (abs(rayDir.y) < 0.0001) {
      if (uCameraPos.y < uAltBase || uCameraPos.y > uAltTop) discard;
      tBase = 0.0; tTop = MAXD;
    } else {
      tBase = (uAltBase - uCameraPos.y) / rayDir.y;
      tTop  = (uAltTop  - uCameraPos.y) / rayDir.y;
      if (tBase > tTop) { float tmp = tBase; tBase = tTop; tTop = tmp; }
    }
    if (tTop <= 0.0) discard;
    tBase = max(tBase, 0.0);
    if (tBase > MAXD) discard;
    float tEnd = min(tTop, min(tBase + MAXD, MAXD * 1.6));

    // The dome is drawn without depth testing (otherwise the ground hides
    // every cloud below the camera), so occlusion is done analytically here:
    // stop the march at the planet surface and at the rocket's bounding sphere.
    {
      vec3 oc = uCameraPos - uPlanet.xyz;
      float b = dot(oc, rayDir);
      float c = dot(oc, oc) - uPlanet.w * uPlanet.w;
      float disc = b * b - c;
      if (disc > 0.0 && c > 0.0) {
        float tg = -b - sqrt(disc);
        if (tg > 0.0) { if (tBase >= tg) discard; tEnd = min(tEnd, tg); }
      }
      if (uOccluder.w > 0.0) {
        vec3 ro = uCameraPos - uOccluder.xyz;
        float bo = dot(ro, rayDir);
        float co = dot(ro, ro) - uOccluder.w * uOccluder.w;
        float dO = bo * bo - co;
        if (dO > 0.0 && co > 0.0) {
          float to = -bo - sqrt(dO);
          if (to > 0.0) { if (tBase >= to) discard; tEnd = min(tEnd, to); }
        }
      }
    }
    float stepSize = (tEnd - tBase) / float(STEPS);
    float thickness = max(uAltTop - uAltBase, 0.001);

    // Per-pixel jitter hides step banding at low step counts.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

    float cosSun = dot(rayDir, uSunDir);
    float phase = mix(henyeyGreenstein(cosSun, 0.55), henyeyGreenstein(cosSun, -0.2), 0.35) * 4.0 * 3.14159 * 0.35 + 0.65;

    float trans = 1.0;
    vec3 light = vec3(0.0);
    float firstT = -1.0;

    for (int i = 0; i < STEPS; i++) {
      float t = tBase + (float(i) + 0.5 + (jitter - 0.5) * 0.7) * stepSize;
      vec3 sp = uCameraPos + rayDir * t;
      float h = clamp((sp.y - uAltBase) / thickness, 0.0, 1.0);
      float d = cloudDensity(sp, h);
      if (d < 0.004) continue;
      if (firstT < 0.0) firstT = t;

      float ext = d * min(stepSize, 14.0) * 0.14;
      float stepT = exp(-ext);

      // Sun visibility: march a few steps toward the sun, or fall back to a
      // height gradient (brighter tops) on the low tier.
      float sunVis;
      #if LIGHT_STEPS > 0
        float od = 0.0;
        float ls = thickness * 0.35 / float(LIGHT_STEPS);
        for (int k = 1; k <= LIGHT_STEPS; k++) {
          vec3 lp = sp + uSunDir * (ls * float(k));
          float lh = clamp((lp.y - uAltBase) / thickness, 0.0, 1.0);
          od += cloudDensity(lp, lh) * ls * 0.14;
        }
        sunVis = exp(-od * 1.6) * (1.0 - exp(-d * 6.0) * 0.35) + 0.0;
      #else
        sunVis = mix(0.25, 1.0, h);
      #endif

      vec3 amb = mix(uAmbBot, uAmbTop, h);
      vec3 col = amb + uSunColor * sunVis * phase;
      light += trans * (1.0 - stepT) * col;
      trans *= stepT;
      if (trans < 0.02) break;
    }

    float alpha = 1.0 - trans;
    if (alpha < 0.01) discard;

    vec3 color = light / max(alpha, 0.001);

    // Distance fade into the scene fog so layers dissolve at the horizon
    // together with everything else.
    float dist = firstT < 0.0 ? tBase : firstT;
    float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
    color = mix(color, uFogColor, fog);
    alpha *= 1.0 - fog * 0.85;

    gl_FragColor = vec4(color, alpha);
  }
`

interface TierParams { steps: number; light: number; maxDist: number }

const TIER_PARAMS: Record<CloudType, Record<QualityTier, TierParams>> = {
  cumulus: {
    low:    { steps: 12, light: 0, maxDist: 220 },
    medium: { steps: 18, light: 2, maxDist: 260 },
    high:   { steps: 28, light: 4, maxDist: 320 },
  },
  stratus: {
    low:    { steps: 6,  light: 0, maxDist: 160 },
    medium: { steps: 10, light: 0, maxDist: 200 },
    high:   { steps: 14, light: 2, maxDist: 240 },
  },
  cirrus: {
    low:    { steps: 4, light: 0, maxDist: 700 },
    medium: { steps: 6, light: 0, maxDist: 900 },
    high:   { steps: 8, light: 0, maxDist: 1100 },
  },
}

export class CloudLayer {
  private mesh: THREE.Mesh | null = null
  private mat: THREE.ShaderMaterial | null = null
  private quality: QualityTier

  constructor(
    private scene: THREE.Scene,
    private type: CloudType,
    private altitudeBase: number,
    private altitudeTop: number,
    private coverage: number,
    quality: QualityTier = 'medium'
  ) {
    this.quality = quality
    this.init()
  }

  private defines(): Record<string, number> {
    const p = TIER_PARAMS[this.type][this.quality]
    return {
      CLOUD_TYPE: this.type === 'cumulus' ? 0 : this.type === 'stratus' ? 1 : 2,
      STEPS: p.steps,
      LIGHT_STEPS: p.light,
      MAX_DIST: p.maxDist,
    }
  }

  private init(): void {
    const fog = this.scene.fog as THREE.Fog | null
    const mat = new THREE.ShaderMaterial({
      defines: this.defines(),
      uniforms: {
        uNoise:     { value: acquireVolume(this.quality) },
        uTime:      { value: 0 },
        uAltBase:   { value: this.altitudeBase },
        uAltTop:    { value: this.altitudeTop },
        uCoverage:  { value: this.coverage },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir:    { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
        uSunColor:  { value: new THREE.Color(1.0, 0.80, 0.58).multiplyScalar(1.1) },
        uAmbTop:    { value: new THREE.Color(0.62, 0.56, 0.64) },
        uAmbBot:    { value: new THREE.Color(0.26, 0.25, 0.34) },
        uFogColor:  { value: fog ? fog.color.clone() : new THREE.Color(0xcf7c5c) },
        uPlanet:    { value: new THREE.Vector4(0, -PLANET_RADIUS, 0, PLANET_RADIUS) },
        uOccluder:  { value: new THREE.Vector4(0, 0, 0, 0) },
        uFogRange:  { value: new THREE.Vector2(fog ? fog.near * 2 : 80, fog ? fog.far : 600) },
      },
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
      blending: THREE.NormalBlending,
      fog: false,
    })

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 24, 14), mat)
    mesh.renderOrder = 1
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.mesh = mesh
    this.mat = mat
  }

  /** Direction *towards* the sun (need not be normalised) and its colour. */
  setSun(direction: THREE.Vector3, color?: THREE.Color): void {
    if (!this.mat) return
    this.mat.uniforms.uSunDir.value.copy(direction).normalize()
    if (color) this.mat.uniforms.uSunColor.value.copy(color).multiplyScalar(1.1)
  }

  /** Bounding sphere of the rocket so clouds behind it are not drawn over it. */
  setOccluder(center: THREE.Vector3, radius: number): void {
    if (!this.mat) return
    this.mat.uniforms.uOccluder.value.set(center.x, center.y, center.z, radius)
  }

  setQuality(q: QualityTier): void {
    if (!this.mat || q === this.quality) return
    this.quality = q
    this.mat.defines = this.defines()
    this.mat.needsUpdate = true
  }

  update(time: number, cameraPosition: THREE.Vector3): void {
    if (!this.mat || !this.mesh) return
    this.mat.uniforms.uTime.value = time
    this.mat.uniforms.uCameraPos.value.copy(cameraPosition)
    this.mesh.position.copy(cameraPosition)
  }

  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.ShaderMaterial).dispose()
      releaseVolume()
      this.mesh = null
      this.mat = null
    }
  }
}