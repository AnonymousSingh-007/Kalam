import * as THREE from 'three'

// World-space billowing smoke: ONE THREE.Points object (one draw call)
// holding several independent particle POOLS (contiguous index ranges,
// each its own ring buffer), e.g. the rocket's exhaust trail, the trench
// cloud rolling along the ground, and the vertical column above the pad.
// Pools keep a long-lived ground cloud from being overwritten by a
// high-rate trail, while still rendering everything in a single call.
//
// Particles live in WORLD coordinates (the Points object sits in the scene
// with an identity transform), so the rocket climbs away from them. All
// motion is integrated with real dt and nothing is allocated per frame.
//
// The renderer uses a logarithmic depth buffer, so both shaders include
// the logdepthbuf chunks (see the comment above PLUME_VERTEX in Scene.tsx).

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aAge;
  attribute float aSeed;
  attribute vec3  aSize;          // x: size at birth, y: size at death (world units), z: hot fraction of life
  uniform float uPxPerUnit;
  uniform vec3  uGlowPos;
  uniform float uGlowRadius;
  varying float vAge;
  varying float vSeed;
  varying float vHot;
  varying float vGlow;
  varying float vSpin;

  void main() {
    vAge = aAge;
    vSeed = aSeed;
    vHot = aSize.z;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Puffs swell quickly at first, then keep slowly growing.
    float grow = 1.0 - pow(1.0 - clamp(aAge, 0.0, 1.0), 2.2);
    float size = mix(aSize.x, aSize.y, grow);
    gl_PointSize = aAge >= 1.0 ? 0.0 : clamp(size * uPxPerUnit / max(-mvPosition.z, 0.001), 0.0, 640.0);
    // Engine light falling on nearby smoke (world-space distance; the
    // Points object has an identity transform so position is world).
    vec3 dg = position - uGlowPos;
    vGlow = exp(-dot(dg, dg) / max(uGlowRadius * uGlowRadius, 1e-4));
    vSpin = aSeed * 6.2831 + aAge * (aSeed - 0.5) * 2.0;
    #include <logdepthbuf_vertex>
  }
`

const FRAG = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform float uDensity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uSmokeColor;
  uniform vec3  uShadowColor;
  varying float vAge;
  varying float vSeed;
  varying float vHot;
  varying float vGlow;
  varying float vSpin;

  void main() {
    if (vAge >= 1.0) discard;
    // Slowly rotating puff texture (lumpy cauliflower sprite).
    vec2 c = gl_PointCoord - 0.5;
    float cs = cos(vSpin), sn = sin(vSpin);
    vec2 uv = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
    float puff = texture2D(uMap, uv).a;
    if (puff < 0.01) discard;

    // Fake top-lighting in SCREEN space (unrotated): sunlit upper side,
    // shadowed underside, so the cloud reads as billowing volume.
    float lit = clamp(0.58 + 0.8 * (0.5 - gl_PointCoord.y) + 0.3 * puff, 0.0, 1.25);
    vec3 col = mix(uShadowColor, uSmokeColor, lit) * (0.9 + 0.2 * vSeed);

    // Colour over life: hot orange-white at spawn -> grey smoke.
    float hot = 1.0 - smoothstep(0.0, max(vHot, 1e-4), vAge);
    col = mix(col, vec3(1.0, 0.72, 0.38) * 1.7, hot * 0.9);
    // Warm light from the engine / ignition on smoke near the nozzle,
    // strongest on the underside facing the flame.
    col += vec3(1.0, 0.48, 0.14) * uGlow * vGlow * (1.25 - lit * 0.7);

    float fadeIn = smoothstep(0.0, 0.03, vAge);
    float fadeOut = 1.0 - smoothstep(0.45, 1.0, vAge);
    float a = puff * fadeIn * fadeOut * uOpacity * uDensity;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    #include <logdepthbuf_fragment>
  }
`

// Procedural puff sprite: a cluster of soft radial blobs -> lumpy, billowy
// alpha mask. Built once and shared.
let puffTexture: THREE.CanvasTexture | null = null
function getPuffTexture(): THREE.CanvasTexture {
  if (puffTexture) return puffTexture
  const S = 128
  const cv = document.createElement('canvas')
  cv.width = S; cv.height = S
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, S, S)
  const blob = (x: number, y: number, r: number, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,255,255,${a})`)
    g.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
  }
  blob(S / 2, S / 2, S * 0.36, 0.75)
  // Deterministic lobes so every session gets the same sprite.
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let i = 0; i < 14; i++) {
    const ang = rnd() * Math.PI * 2
    const d = S * (0.08 + rnd() * 0.2)
    blob(S / 2 + Math.cos(ang) * d, S / 2 + Math.sin(ang) * d, S * (0.12 + rnd() * 0.12), 0.35 + rnd() * 0.3)
  }
  puffTexture = new THREE.CanvasTexture(cv)
  puffTexture.colorSpace = THREE.NoColorSpace
  return puffTexture
}

export interface SmokePoolOptions {
  count: number
  life: number          // seconds (per-particle life varies +-30%)
  drag: number          // 1/s, relaxes velocity toward the wind
  buoyancy: number      // world units / s^2 upward
  turbulence: number    // world units / s^2, curl-like drift amplitude
  groundY: number       // particles roll along this height instead of sinking
}

interface Pool extends SmokePoolOptions {
  start: number
  head: number
  live: boolean
}

export class SmokeParticles {
  readonly points: THREE.Points
  readonly material: THREE.ShaderMaterial
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly age: Float32Array
  private readonly size: Float32Array
  private readonly lifeInv: Float32Array
  private readonly seed: Float32Array
  private readonly posAttr: THREE.BufferAttribute
  private readonly ageAttr: THREE.BufferAttribute
  private readonly sizeAttr: THREE.BufferAttribute
  private readonly pools: Pool[] = []
  private windX = 0
  private windZ = 0
  private time = 0
  readonly capacity: number

  constructor(pools: SmokePoolOptions[], look: {
    opacity: number
    smokeColor: THREE.ColorRepresentation
    shadowColor: THREE.ColorRepresentation
  }) {
    let n = 0
    for (const p of pools) {
      this.pools.push({ ...p, start: n, head: 0, live: false })
      n += p.count
    }
    this.capacity = n
    this.pos = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.age = new Float32Array(n).fill(1)
    this.size = new Float32Array(n * 3)
    this.lifeInv = new Float32Array(n)
    this.seed = new Float32Array(n)
    for (let i = 0; i < n; i++) this.seed[i] = Math.random()

    const geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)
    this.ageAttr = new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage)
    this.sizeAttr = new THREE.BufferAttribute(this.size, 3).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.posAttr)
    geo.setAttribute('aAge', this.ageAttr)
    geo.setAttribute('aSize', this.sizeAttr)
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1))

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: getPuffTexture() },
        uPxPerUnit: { value: 1 },
        uDensity: { value: 1 },
        uOpacity: { value: look.opacity },
        uGlow: { value: 0 },
        uGlowPos: { value: new THREE.Vector3() },
        uGlowRadius: { value: 1 },
        uSmokeColor: { value: new THREE.Color(look.smokeColor) },
        uShadowColor: { value: new THREE.Color(look.shadowColor) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false   // particles move every frame; bounding sphere would go stale
  }

  setPxPerUnit(v: number): void { this.material.uniforms.uPxPerUnit.value = v }
  setDensity(v: number): void { this.material.uniforms.uDensity.value = v }
  /** Engine/ignition light on nearby smoke: strength, world position, falloff radius. */
  setGlow(strength: number, pos: THREE.Vector3, radius: number): void {
    const u = this.material.uniforms
    u.uGlow.value = strength
    u.uGlowPos.value.copy(pos)
    u.uGlowRadius.value = radius
  }
  /** Ambient wind, world units / s. Drag relaxes particles toward it, so old smoke drifts downwind. */
  setWind(x: number, z: number): void { this.windX = x; this.windZ = z }

  /** Spawn one particle into `pool` (overwrites that pool's oldest when full). */
  emit(pool: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
       size0: number, size1: number, hotFrac: number): void {
    const p = this.pools[pool]
    const i = p.start + p.head
    p.head = (p.head + 1) % p.count
    p.live = true
    const k = i * 3
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz
    this.size[k] = size0; this.size[k + 1] = size1; this.size[k + 2] = hotFrac
    this.age[i] = 0
    this.lifeInv[i] = 1 / (p.life * (0.7 + 0.6 * Math.random()))
  }

  update(dt: number): void {
    this.time += dt
    const t = this.time
    const P = this.pos, V = this.vel, A = this.age, L = this.lifeInv, S = this.seed
    let any = false
    for (const p of this.pools) {
      if (!p.live) continue
      const damp = Math.exp(-p.drag * dt)
      const turb = p.turbulence * dt
      let alive = false
      for (let i = p.start, end = p.start + p.count; i < end; i++) {
        if (A[i] >= 1) continue
        alive = true
        A[i] = Math.min(1, A[i] + dt * L[i])
        const k = i * 3
        const x = P[k], y = P[k + 1], z = P[k + 2], s = S[i] * 6.2831
        // Cheap curl-like turbulence: smooth, divergence-poor swirl from
        // crossed sin/cos of position + time, phase-shifted per particle.
        V[k] += turb * Math.sin(y * 0.55 + t * 0.7 + s)
        V[k + 1] += turb * 0.5 * Math.sin(z * 0.5 + t * 0.9 + s)
        V[k + 2] += turb * Math.cos(x * 0.6 + t * 0.8 + s)
        V[k] = this.windX + (V[k] - this.windX) * damp
        V[k + 1] = V[k + 1] * damp + p.buoyancy * dt
        V[k + 2] = this.windZ + (V[k + 2] - this.windZ) * damp
        P[k] = x + V[k] * dt
        P[k + 1] = y + V[k + 1] * dt
        P[k + 2] = z + V[k + 2] * dt
        if (P[k + 1] < p.groundY) {
          // Hit the ground: flatten out and roll outward instead of sinking.
          P[k + 1] = p.groundY
          const h = Math.abs(V[k + 1]) * 0.5
          const lat = Math.hypot(V[k], V[k + 2]) || 1
          V[k] += (V[k] / lat) * h
          V[k + 2] += (V[k + 2] / lat) * h
          V[k + 1] = 0
        }
      }
      p.live = alive
      any = any || alive
    }
    if (any || dt === 0) {
      this.posAttr.needsUpdate = true
      this.ageAttr.needsUpdate = true
      this.sizeAttr.needsUpdate = true
    }
  }

  reset(): void {
    this.age.fill(1)
    for (const p of this.pools) { p.head = 0; p.live = false }
    this.ageAttr.needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
