import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { QualityTier } from '../types'

// Volumetric clouds as a post-process pass that composites against the real
// opaque depth buffer.
//
// Opaque geometry (rocket, pad, ground, anything else) is rendered normally
// into a target that carries a depth texture. This pass then runs one
// full-screen ray march per pixel, ends each ray at the depth-buffer distance
// (so clouds can never draw over, or leak around, any opaque object: the cut
// is exactly the object's own silhouette), and blends the result over the
// scene colour. No proxy meshes and no analytic occluder shapes are involved.
//
// Three layers (stratus, cumulus, cirrus) are marched in one shader and
// composited far to near per pixel, so a camera above, inside or below any
// layer sorts correctly. All shaping noise comes from one baked 3D texture,
// so every ray step is a texture fetch.
//
// Quality only changes step counts, light samples and ray lengths (uniforms),
// so switching tier never recompiles the shader.

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


const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp sampler3D;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform sampler3D uNoise;
  uniform mat4  uInvProj;
  uniform mat4  uCamWorld;
  uniform vec3  uCamPos;
  uniform float uNear;
  uniform float uFar;
  uniform float uLogFarPlusOne;  // log2(far + 1) for log depth buffer decoding
  uniform float uTime;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uAmbTop;
  uniform vec3  uAmbBot;
  uniform vec3  uFogColor;
  uniform vec2  uFogRange;
  uniform vec3  uAltBase;    // per layer: 0 stratus, 1 cumulus, 2 cirrus
  uniform vec3  uAltTop;
  uniform vec3  uCoverage;
  uniform vec3  uSteps;
  uniform vec3  uLightSteps;
  uniform vec3  uMaxDist;

  varying vec2 vUv;

  float cloudDensity(int L, vec3 p, float h, float lod) {
    if (L == 1) {
      vec3 wind = vec3(uTime * 0.9, 0.0, uTime * 0.5);
      vec3 q = (p + wind) * vec3(1.0 / 120.0, 1.0 / 90.0, 1.0 / 120.0);
      float shape = textureLod(uNoise, q, lod).r;
      float cmap = textureLod(uNoise, vec3((p.x + wind.x * 0.3) * 0.0012, 0.37, p.z * 0.0012), lod).g;
      float cov = clamp(uCoverage.y + 0.12 + (cmap - 0.45), 0.0, 1.0);
      float hg = smoothstep(0.0, 0.10, h) * smoothstep(1.0, 0.45, h);
      float d = shape * hg;
      float thr = 1.0 - cov;
      d = clamp((d - thr) / max(1.0 - thr, 0.05), 0.0, 1.0);
      float det = textureLod(uNoise, q * 3.1, lod).g * 0.65 + textureLod(uNoise, q * 7.3, lod).b * 0.35;
      d = clamp(d - 0.30 * det * (1.0 - d), 0.0, 1.0);
      return d * 2.2;
    } else if (L == 0) {
      vec3 wind = vec3(uTime * 0.5, 0.0, uTime * 0.3);
      vec3 q = (p + wind) * vec3(1.0 / 300.0, 1.0 / 90.0, 1.0 / 300.0);
      float n = textureLod(uNoise, q, lod).r * 0.65 + textureLod(uNoise, q * 2.7, lod).g * 0.35;
      float hg = smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.6, h);
      float lo = 1.0 - uCoverage.x * 0.95;
      return smoothstep(lo, lo + 0.30, n) * hg * 0.9;
    } else {
      vec3 wind = vec3(uTime * 2.0, 0.0, 0.0);
      vec3 q = (p + wind) * vec3(1.0 / 900.0, 1.0 / 260.0, 1.0 / 190.0);
      float n = textureLod(uNoise, q, lod).b * 0.7 + textureLod(uNoise, q * 2.3, lod).a * 0.3;
      float hg = smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.6, h);
      float lo = 1.0 - uCoverage.z * 0.9;
      return smoothstep(lo, lo + 0.18, n) * hg * 0.16;
    }
  }

  float henyeyGreenstein(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
  }

  // Entry distance of the ray into layer L's slab (clamped to >= 0), or -1.
  float slabEntry(int L, vec3 ro, vec3 rd, float tOpaque) {
    float lo = uAltBase[L];
    float hi = uAltTop[L];
    float t0, t1;
    if (abs(rd.y) < 0.0001) {
      if (ro.y < lo || ro.y > hi) return -1.0;
      t0 = 0.0; t1 = 1e9;
    } else {
      t0 = (lo - ro.y) / rd.y;
      t1 = (hi - ro.y) / rd.y;
      if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
    }
    if (t1 <= 0.0) return -1.0;
    t0 = max(t0, 0.0);
    if (t0 > uMaxDist[L] || t0 >= tOpaque) return -1.0;
    return t0;
  }

  // Returns premultiplied light (rgb) and coverage (a) for one layer.
  vec4 marchLayer(int L, vec3 ro, vec3 rd, float tBase, float tOpaque, float jitter) {
    float lo = uAltBase[L];
    float hi = uAltTop[L];
    float t1 = abs(rd.y) < 0.0001 ? 1e9 : max((lo - ro.y) / rd.y, (hi - ro.y) / rd.y);
    float tEnd = min(min(t1, uMaxDist[L]), tOpaque);
    int steps = int(uSteps[L]);
    int lsteps = int(uLightSteps[L]);
    float stepSize = (tEnd - tBase) / float(steps);
    float thickness = max(hi - lo, 0.001);

    float cosSun = dot(rd, uSunDir);
    float phase = mix(henyeyGreenstein(cosSun, 0.55), henyeyGreenstein(cosSun, -0.2), 0.35) * 4.0 * 3.14159 * 0.35 + 0.65;

    float trans = 1.0;
    vec3 light = vec3(0.0);
    float firstT = -1.0;

    for (int i = 0; i < 32; i++) {
      if (i >= steps) break;
      float t = tBase + (float(i) + 0.5 + (jitter - 0.5) * 0.7) * stepSize;
      vec3 sp = ro + rd * t;
      float h = clamp((sp.y - lo) / thickness, 0.0, 1.0);
      float lod = clamp(log2(max(t, 1.0) / 40.0), 0.0, 3.0);
      float d = cloudDensity(L, sp, h, lod);
      // Fade out over the last third of the layer's distance range (measured from the camera) so the layer ends
      // softly instead of in a visible line.
      d *= 1.0 - smoothstep(0.65 * uMaxDist[L], uMaxDist[L], t);
      if (d < 0.004) continue;
      if (firstT < 0.0) firstT = t;

      float ext = d * min(stepSize, 14.0) * 0.14;
      float stepT = exp(-ext);

      float sunVis;
      if (lsteps > 0) {
        float od = 0.0;
        float ls = thickness * 0.35 / float(lsteps);
        for (int k = 1; k <= 4; k++) {
          if (k > lsteps) break;
          vec3 lp = sp + uSunDir * (ls * float(k));
          float lh = clamp((lp.y - lo) / thickness, 0.0, 1.0);
          od += cloudDensity(L, lp, lh, lod) * ls * 0.14;
        }
        sunVis = exp(-od * 1.6) * (1.0 - exp(-d * 6.0) * 0.35);
      } else {
        sunVis = mix(0.25, 1.0, h);
      }

      vec3 amb = mix(uAmbBot, uAmbTop, h);
      vec3 col = amb + uSunColor * sunVis * phase;
      light += trans * (1.0 - stepT) * col;
      trans *= stepT;
      if (trans < 0.02) break;
    }

    float alpha = 1.0 - trans;
    float dist = firstT < 0.0 ? tBase : firstT;
    float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
    light = mix(light, uFogColor * alpha, fog);
    alpha *= 1.0 - fog * 0.85;
    return vec4(light, alpha);
  }

  void main() {
    vec4 scene = texture2D(tDiffuse, vUv);

    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dirV = normalize(vp.xyz / vp.w);
    vec3 rd = normalize((uCamWorld * vec4(dirV, 0.0)).xyz);

    // Distance along this ray to the nearest opaque surface.
    // Logarithmic depth buffer: depth = log2(1+w) / log2(far+1).
    float depth = texture2D(tDepth, vUv).x;
    float tOpaque = 1e9;
    if (depth < 0.999999) {
      float viewZ = exp2(depth * uLogFarPlusOne) - 1.0;
      tOpaque = viewZ / max(-dirV.z, 1e-3);
    }

    float te[3];
    bool done[3];
    for (int L = 0; L < 3; L++) {
      te[L] = slabEntry(L, uCamPos, rd, tOpaque);
      done[L] = te[L] < 0.0;
    }

    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 col = scene.rgb;

    // Composite far to near.
    for (int k = 0; k < 3; k++) {
      int best = -1;
      float bt = -1.0;
      for (int j = 0; j < 3; j++) {
        if (!done[j] && te[j] > bt) { bt = te[j]; best = j; }
      }
      if (best < 0) break;
      done[best] = true;
      vec4 c = marchLayer(best, uCamPos, rd, te[best], tOpaque, jitter);
      col = c.rgb + (1.0 - c.a) * col;
    }

    gl_FragColor = vec4(col, scene.a);
  }
`

interface TierParams { steps: number; light: number; maxDist: number }
// [stratus, cumulus, cirrus]
const TIERS: Record<QualityTier, TierParams[]> = {
  low:    [{ steps: 6,  light: 0, maxDist: 160 }, { steps: 12, light: 0, maxDist: 220 }, { steps: 4, light: 0, maxDist: 700 }],
  medium: [{ steps: 10, light: 0, maxDist: 200 }, { steps: 18, light: 2, maxDist: 260 }, { steps: 6, light: 0, maxDist: 900 }],
  high:   [{ steps: 14, light: 2, maxDist: 240 }, { steps: 28, light: 4, maxDist: 320 }, { steps: 8, light: 0, maxDist: 1100 }],
}

export class CloudPass extends Pass {
  private quad: FullScreenQuad
  private mat: THREE.ShaderMaterial
  private quality: QualityTier

  constructor(private camera: THREE.PerspectiveCamera, scene: THREE.Scene, quality: QualityTier = 'medium') {
    super()
    this.quality = quality
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:   { value: null },
        tDepth:     { value: null },
        uNoise:     { value: acquireVolume(quality) },
        uInvProj:   { value: new THREE.Matrix4() },
        uCamWorld:  { value: new THREE.Matrix4() },
        uCamPos:    { value: new THREE.Vector3() },
        uNear:      { value: camera.near },
        uFar:       { value: camera.far },
        uLogFarPlusOne: { value: Math.log2(camera.far + 1) },
        uTime:      { value: 0 },
        uSunDir:    { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
        uSunColor:  { value: new THREE.Color(1.0, 0.80, 0.58).multiplyScalar(1.1) },
        uAmbTop:    { value: new THREE.Color(0.62, 0.56, 0.64) },
        uAmbBot:    { value: new THREE.Color(0.26, 0.25, 0.34) },
        uFogColor:  { value: new THREE.Color(0xcf7c5c) },
        uFogRange:  { value: new THREE.Vector2(80, 600) },
        uAltBase:   { value: new THREE.Vector3(0, 30, 300) },
        uAltTop:    { value: new THREE.Vector3(30, 100, 600) },
        uCoverage:  { value: new THREE.Vector3(0.4, 0.65, 0.5) },
        uSteps:     { value: new THREE.Vector3() },
        uLightSteps:{ value: new THREE.Vector3() },
        uMaxDist:   { value: new THREE.Vector3() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.mat)
    this.applyQuality()
  }

  private applyQuality(): void {
    const t = TIERS[this.quality]
    const u = this.mat.uniforms
    u.uSteps.value.set(t[0].steps, t[1].steps, t[2].steps)
    u.uLightSteps.value.set(t[0].light, t[1].light, t[2].light)
    u.uMaxDist.value.set(t[0].maxDist, t[1].maxDist, t[2].maxDist)
  }

  /** Direction *towards* the sun (need not be normalised) and its colour. */
  setSun(direction: THREE.Vector3, color?: THREE.Color): void {
    this.mat.uniforms.uSunDir.value.copy(direction).normalize()
    if (color) this.mat.uniforms.uSunColor.value.copy(color).multiplyScalar(1.1)
  }

  setQuality(q: QualityTier): void {
    if (q === this.quality) return
    this.quality = q
    this.applyQuality()
  }

  setTime(t: number): void {
    this.mat.uniforms.uTime.value = t
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const u = this.mat.uniforms
    u.tDiffuse.value = readBuffer.texture
    u.tDepth.value = readBuffer.depthTexture
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse)
    u.uCamWorld.value.copy(this.camera.matrixWorld)
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld)
    u.uNear.value = this.camera.near
    u.uFar.value = this.camera.far
    u.uLogFarPlusOne.value = Math.log2(this.camera.far + 1)
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.quad.render(renderer)
  }

  dispose(): void {
    this.quad.dispose()
    this.mat.dispose()
    releaseVolume()
  }
}