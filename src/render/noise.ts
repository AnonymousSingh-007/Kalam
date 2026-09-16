/**
 * Multi-octave Perlin-Worley noise for volumetric cloud density fields.
 *
 * Perlin: gradient noise — smooth large-scale variation, drives overall cloud shape.
 * Worley: cellular/distance noise — produces interior detail, the cauliflower
 *   billowing seen in real cumulus. Inverted (1 - F1) so cells are bright
 *   at centres and dark at boundaries, matching how cloud density concentrates
 *   around convective cells.
 * Perlin-Worley remap: standard technique from Guerrilla Games (Horizon ZD):
 *   remap Perlin into [worleyLow, worleyHigh] so Worley detail only appears
 *   inside the Perlin-defined cloud mass, not in clear-air regions.
 */

// ---- Utility ----


function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function fade(t: number): number {
  // Quintic interpolation (Perlin's improved version) — C2 continuous,
  // eliminates gradient discontinuities at lattice boundaries.
  return t * t * t * (t * (t * 6 - 15) + 10)
}

// ---- Hash / pseudo-random ----
// Simple integer hash for lattice point gradient lookup.
// Based on the classic permutation table approach but computed inline
// without a full 512-entry table — fast enough for CPU noise sampling.

function hash3(ix: number, iy: number, iz: number): number {
  let h = ix * 1619 ^ iy * 31337 ^ iz * 6971
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}

function gradient(hash: number, x: number, y: number, z: number): number {
  // Map hash to one of 12 gradient directions (edges of a cube)
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

// ---- Perlin noise ----

export function perlin3(x: number, y: number, z: number): number {
  const X = Math.floor(x)
  const Y = Math.floor(y)
  const Z = Math.floor(z)

  const xf = x - X
  const yf = y - Y
  const zf = z - Z

  const u = fade(xf)
  const v = fade(yf)
  const w = fade(zf)

  // Gradient contributions from 8 lattice corners
  const n000 = gradient(hash3(X,   Y,   Z  ), xf,     yf,     zf    )
  const n100 = gradient(hash3(X+1, Y,   Z  ), xf-1,   yf,     zf    )
  const n010 = gradient(hash3(X,   Y+1, Z  ), xf,     yf-1,   zf    )
  const n110 = gradient(hash3(X+1, Y+1, Z  ), xf-1,   yf-1,   zf    )
  const n001 = gradient(hash3(X,   Y,   Z+1), xf,     yf,     zf-1  )
  const n101 = gradient(hash3(X+1, Y,   Z+1), xf-1,   yf,     zf-1  )
  const n011 = gradient(hash3(X,   Y+1, Z+1), xf,     yf-1,   zf-1  )
  const n111 = gradient(hash3(X+1, Y+1, Z+1), xf-1,   yf-1,   zf-1  )

  // Trilinear interpolation with fade curves
  return lerp(
    lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
    lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
    w
  )
}

// ---- Worley (cellular) noise ----
// F1 = distance to nearest feature point.
// We return 1 - F1 (inverted) so density is highest at cell centres.

export function worley3(x: number, y: number, z: number): number {
  const Xi = Math.floor(x)
  const Yi = Math.floor(y)
  const Zi = Math.floor(z)

  let minDist = Infinity

  // Search 3x3x3 neighbourhood of lattice cells
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = Xi + dx
        const cy = Yi + dy
        const cz = Zi + dz

        // Pseudo-random feature point within this cell
        const h = hash3(cx, cy, cz)
        // Decompose hash into three independent fractions [0,1)
        const fx = (h & 0xFF) / 255
        const fy = ((h >>> 8) & 0xFF) / 255
        const fz = ((h >>> 16) & 0xFF) / 255

        const px = cx + fx
        const py = cy + fy
        const pz = cz + fz

        const dist = Math.sqrt(
          (x - px) * (x - px) +
          (y - py) * (y - py) +
          (z - pz) * (z - pz)
        )
        if (dist < minDist) minDist = dist
      }
    }
  }

  // Invert and clamp: 0 at cell boundaries, 1 at feature points
  return Math.max(0, 1 - minDist)
}

// ---- FBM (Fractional Brownian Motion) stacking ----
// Stacks multiple octaves of a noise function, each at double frequency
// and half amplitude. Produces natural multi-scale detail.

export function fbmPerlin(
  x: number, y: number, z: number,
  octaves = 4,
  lacunarity = 2.0,  // frequency multiplier per octave
  gain = 0.5         // amplitude multiplier per octave
): number {
  let value = 0
  let amplitude = 1.0
  let frequency = 1.0
  let maxValue = 0

  for (let i = 0; i < octaves; i++) {
    value += perlin3(x * frequency, y * frequency, z * frequency) * amplitude
    maxValue += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }

  // Normalize to [-1, 1]
  return value / maxValue
}

export function fbmWorley(
  x: number, y: number, z: number,
  octaves = 3,
  lacunarity = 2.0,
  gain = 0.5
): number {
  let value = 0
  let amplitude = 1.0
  let frequency = 1.0
  let maxValue = 0

  for (let i = 0; i < octaves; i++) {
    value += worley3(x * frequency, y * frequency, z * frequency) * amplitude
    maxValue += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }

  return value / maxValue
}

// ---- Perlin-Worley remap ----
// The key composition technique: remap the Perlin value into the range
// [worleyLow, worleyHigh] so Worley cellular detail is only visible
// inside the Perlin-defined cloud mass. Outside the Perlin mass the
// density collapses to zero regardless of Worley value.

export function perlinWorley(
  x: number, y: number, z: number,
  perlinOctaves = 4,
  worleyOctaves = 3
): number {
  const p = fbmPerlin(x, y, z, perlinOctaves)
  const w = fbmWorley(x, y, z, worleyOctaves)

  // Normalize Perlin from [-1,1] to [0,1]
  const pn = (p + 1) * 0.5

  // Remap: if Perlin is low (clear air), density is 0.
  // If Perlin is high (inside cloud mass), density follows Worley detail.
  return smoothstep(0.0, 1.0, pn) * w
}

// ---- Cloud type density profiles ----
// Each type has a characteristic altitude band and noise parameterisation.
// altitudeNorm: 0.0 = bottom of cloud layer, 1.0 = top.
// Returns density [0, 1] at the sampled 3D point.

export interface CloudSampleParams {
  x: number          // world-space X (horizontal)
  y: number          // world-space Y (altitude within the layer)
  z: number          // world-space Z (horizontal)
  time: number       // elapsed time for slow drift animation
  altitudeNorm: number // 0-1 within this layer's altitude band
}

export function cumulusDensity(p: CloudSampleParams): number {
  // Cumulus: 600–2000m. Billowing towers with strong Worley cellular detail.
  // Density peaks in the middle of the layer (anvil shape — wide base,
  // narrowing top), shaped by a vertical gradient envelope.
  const driftX = p.x * 0.15 + p.time * 0.008
  const driftZ = p.z * 0.15 + p.time * 0.005

  const raw = perlinWorley(driftX, p.y * 0.4, driftZ, 4, 3)

  // Vertical envelope: rises from 0 at base, peaks at 40%, narrows to 0 at top
  const vertEnvelope = smoothstep(0.0, 0.15, p.altitudeNorm) *
                       (1 - smoothstep(0.4, 1.0, p.altitudeNorm))

  return Math.max(0, raw * vertEnvelope)
}

export function stratusDensity(p: CloudSampleParams): number {
  // Stratus: flat, layered, uniform coverage. Thin vertical extent.
  // Mostly Perlin (smooth), very little Worley (not billowing).
  const driftX = p.x * 0.08 + p.time * 0.004
  const driftZ = p.z * 0.08 + p.time * 0.003

  const pn = (fbmPerlin(driftX, p.y * 0.2, driftZ, 3) + 1) * 0.5

  // Flat envelope — nearly full coverage across the entire layer height
  const vertEnvelope = smoothstep(0.0, 0.1, p.altitudeNorm) *
                       (1 - smoothstep(0.85, 1.0, p.altitudeNorm))

  return Math.max(0, (pn - 0.3) * 1.4 * vertEnvelope)
}

export function cirrusDensity(p: CloudSampleParams): number {
  // Cirrus: 6000–12000m. Wispy, high-frequency Worley streaks.
  // Very low density, stretched horizontally by jet-stream shear.
  const shearX = p.x * 0.3 + p.time * 0.015 // faster drift at altitude
  const shearZ = p.z * 0.08                   // stretched in Z = horizontal streaks

  // Pure Worley with high frequency — produces the characteristic hair-like filaments
  const w = fbmWorley(shearX, p.y * 0.6, shearZ, 2, 2.5, 0.4)

  // Thin flat envelope
  const vertEnvelope = smoothstep(0.0, 0.05, p.altitudeNorm) *
                       (1 - smoothstep(0.9, 1.0, p.altitudeNorm))

  return Math.max(0, w * 0.6 * vertEnvelope)
}