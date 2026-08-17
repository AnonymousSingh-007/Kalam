import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type CloudType = 'cumulus' | 'stratus' | 'cirrus'

interface CloudLayerProps {
  scene: THREE.Scene
  type: CloudType
  altitudeBase: number   // scene units (metres × ALTITUDE_SCALE)
  altitudeTop: number    // scene units
  coverage: number       // 0-1, how much of the sky is covered
  enabled: boolean
}

// ---- GLSL noise functions ----
// Direct port of src/render/noise.ts — same math, runs on GPU.
// Perlin gradient hash, Worley F1 inversion, FBM stacking,
// Perlin-Worley remap, per-type density profile.

const NOISE_GLSL = `
  // ---- Hash ----
  float hash(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p.zxy, p.yxz + 19.19);
    return fract(p.x * p.y * p.z);
  }

  vec3 hash3v(vec3 p) {
    return vec3(
      hash(p),
      hash(p + vec3(1.0, 0.0, 0.0)),
      hash(p + vec3(0.0, 1.0, 0.0))
    );
  }

  // ---- Perlin ----
  vec3 perlinGrad(vec3 p) {
    float h = hash(floor(p));
    float angle = h * 6.2832;
    float elev  = h * 3.1416 - 1.5708;
    return vec3(cos(elev) * cos(angle), sin(elev), cos(elev) * sin(angle));
  }

  float perlin3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic fade

    float n000 = dot(perlinGrad(i + vec3(0,0,0)), f - vec3(0,0,0));
    float n100 = dot(perlinGrad(i + vec3(1,0,0)), f - vec3(1,0,0));
    float n010 = dot(perlinGrad(i + vec3(0,1,0)), f - vec3(0,1,0));
    float n110 = dot(perlinGrad(i + vec3(1,1,0)), f - vec3(1,1,0));
    float n001 = dot(perlinGrad(i + vec3(0,0,1)), f - vec3(0,0,1));
    float n101 = dot(perlinGrad(i + vec3(1,0,1)), f - vec3(1,0,1));
    float n011 = dot(perlinGrad(i + vec3(0,1,1)), f - vec3(0,1,1));
    float n111 = dot(perlinGrad(i + vec3(1,1,1)), f - vec3(1,1,1));

    return mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z
    );
  }

  float fbmPerlin(vec3 p, int octaves) {
    float value = 0.0;
    float amplitude = 1.0;
    float frequency = 1.0;
    float maxVal = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= octaves) break;
      value += perlin3(p * frequency) * amplitude;
      maxVal += amplitude;
      amplitude *= 0.5;
      frequency *= 2.0;
    }
    return value / maxVal;
  }

  // ---- Worley ----
  float worley3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float minDist = 10.0;

    for (int dz = -1; dz <= 1; dz++) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          vec3 offset = vec3(float(dx), float(dy), float(dz));
          vec3 cell = i + offset;
          // Feature point: random position within cell
          float hx = hash(cell);
          float hy = hash(cell + vec3(7.3, 0.0, 0.0));
          float hz = hash(cell + vec3(0.0, 13.7, 0.0));
          vec3 featurePoint = cell + vec3(hx, hy, hz);
          float dist = length(p - featurePoint);
          minDist = min(minDist, dist);
        }
      }
    }
    return max(0.0, 1.0 - minDist);
  }

  float fbmWorley(vec3 p, int octaves) {
    float value = 0.0;
    float amplitude = 1.0;
    float frequency = 1.0;
    float maxVal = 0.0;
    for (int i = 0; i < 3; i++) {
      if (i >= octaves) break;
      value += worley3(p * frequency) * amplitude;
      maxVal += amplitude;
      amplitude *= 0.5;
      frequency *= 2.0;
    }
    return value / maxVal;
  }

  // ---- Perlin-Worley remap ----
  float perlinWorley(vec3 p) {
    float pn = (fbmPerlin(p, 4) + 1.0) * 0.5;
    float w  = fbmWorley(p, 3);
    return smoothstep(0.0, 1.0, pn) * w;
  }
`

// Per cloud type vertex/fragment shaders
// The fragment shader raymarches through the cloud volume slab
// (altitudeBase → altitudeTop) accumulating density × colour.

const CLOUD_VERTEX = `
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// One fragment shader template, parameterised by cloud type via uniforms
const CLOUD_FRAGMENT = `
  uniform float uTime;
  uniform float uAltBase;     // scene-space bottom of slab
  uniform float uAltTop;      // scene-space top of slab
  uniform float uCoverage;    // 0-1
  uniform int   uCloudType;   // 0=cumulus, 1=stratus, 2=cirrus
  uniform vec3  uCameraPos;

  varying vec3 vWorldPos;
  varying vec2 vUv;

  ${NOISE_GLSL}

  float cloudDensity(vec3 p, float altNorm) {
    if (uCloudType == 0) {
      // Cumulus — Perlin-Worley, strong vertical envelope
      vec3 sp = vec3(p.x * 0.15 + uTime * 0.008, p.y * 0.4, p.z * 0.15 + uTime * 0.005);
      float raw = perlinWorley(sp);
      float env = smoothstep(0.0, 0.15, altNorm) * (1.0 - smoothstep(0.4, 1.0, altNorm));
      return max(0.0, raw * env * uCoverage);
    } else if (uCloudType == 1) {
      // Stratus — mostly Perlin, flat uniform layer
      vec3 sp = vec3(p.x * 0.08 + uTime * 0.004, p.y * 0.2, p.z * 0.08 + uTime * 0.003);
      float pn = (fbmPerlin(sp, 3) + 1.0) * 0.5;
      float env = smoothstep(0.0, 0.1, altNorm) * (1.0 - smoothstep(0.85, 1.0, altNorm));
      return max(0.0, (pn - 0.3) * 1.4 * env * uCoverage);
    } else {
      // Cirrus — pure Worley, high frequency horizontal streaks
      vec3 sp = vec3(p.x * 0.3 + uTime * 0.015, p.y * 0.6, p.z * 0.08);
      float w = fbmWorley(sp, 2);
      float env = smoothstep(0.0, 0.05, altNorm) * (1.0 - smoothstep(0.9, 1.0, altNorm));
      return max(0.0, w * 0.6 * env * uCoverage);
    }
  }

  void main() {
    // Raymarch from camera through this fragment's world position into the slab.
    // We shoot a ray from uCameraPos toward vWorldPos, find the intersection
    // with [uAltBase, uAltTop], then step through accumulating density.
    vec3 rayDir = normalize(vWorldPos - uCameraPos);

    // Ray-slab intersection (Y axis slab)
    float tBase, tTop;
    if (abs(rayDir.y) < 0.0001) {
      // Ray nearly horizontal — inside or outside slab
      if (vWorldPos.y < uAltBase || vWorldPos.y > uAltTop) {
        discard;
      }
      tBase = 0.0; tTop = 200.0;
    } else {
      tBase = (uAltBase - uCameraPos.y) / rayDir.y;
      tTop  = (uAltTop  - uCameraPos.y) / rayDir.y;
      if (tBase > tTop) { float tmp = tBase; tBase = tTop; tTop = tmp; }
    }

    tBase = max(tBase, 0.0);
    float slabThickness = uAltTop - uAltBase;

    // Fixed step count — 8 steps is enough for a convincing appearance
    // without hammering the fragment shader. More steps = better quality
    // but slower — tune via STEPS if needed.
    const int STEPS = 8;
    float stepSize = (tTop - tBase) / float(STEPS);

    float transmittance = 1.0;
    vec3  scatteredLight = vec3(0.0);

    // Cloud colour — lit from above (brighter top) and self-shadowed (darker base)
    vec3 cloudTopColor = vec3(0.97, 0.97, 1.0);
    vec3 cloudBaseColor = vec3(0.6, 0.62, 0.68);

    for (int i = 0; i < STEPS; i++) {
      float t = tBase + (float(i) + 0.5) * stepSize;
      vec3 samplePos = uCameraPos + rayDir * t;

      float altNorm = clamp(
        (samplePos.y - uAltBase) / max(slabThickness, 0.001),
        0.0, 1.0
      );

      float density = cloudDensity(samplePos, altNorm);
      if (density < 0.001) continue;

      // Beer-Lambert extinction
      float extinction = density * stepSize * 0.8;
      float sampleTransmittance = exp(-extinction);

      // Height-based colour: top of cloud is brighter (lit by sun),
      // base is darker (shadowed by cloud mass above)
      vec3 sampleColor = mix(cloudBaseColor, cloudTopColor, altNorm);

      // Accumulate scattered light (energy conserving)
      scatteredLight += transmittance * (1.0 - sampleTransmittance) * sampleColor;
      transmittance  *= sampleTransmittance;

      if (transmittance < 0.01) break; // early exit — fully opaque
    }

    float alpha = 1.0 - transmittance;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(scatteredLight / max(alpha, 0.001), alpha * 0.9);
  }
`

// ---- Component ----
// Doesn't mount its own canvas — receives the parent scene and adds
// cloud mesh objects directly into it, managed by useEffect lifecycle.

export function useCloudLayer({
  scene,
  type,
  altitudeBase,
  altitudeTop,
  coverage,
  enabled
}: CloudLayerProps) {
  const meshRef = useRef<THREE.Mesh | null>(null)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)

  useEffect(() => {
    if (!enabled) return

    const typeIndex = type === 'cumulus' ? 0 : type === 'stratus' ? 1 : 2

    // Large horizontal quad spanning the visible sky area.
    // The fragment shader raymarches into the slab above/below this quad.
    const geo = new THREE.PlaneGeometry(400, 400, 1, 1)
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      { value: 0 },
        uAltBase:   { value: altitudeBase },
        uAltTop:    { value: altitudeTop },
        uCoverage:  { value: coverage },
        uCloudType: { value: typeIndex },
        uCameraPos: { value: new THREE.Vector3() }
      },
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending
    })

    const mesh = new THREE.Mesh(geo, mat)
    // Position quad at mid-altitude of the slab so raymarching
    // intersects correctly from both below and inside the layer
    mesh.position.y = (altitudeBase + altitudeTop) / 2
    mesh.renderOrder = 1 // render after opaque geometry

    scene.add(mesh)
    meshRef.current = mesh
    matRef.current = mat

    return () => {
      scene.remove(mesh)
      geo.dispose()
      mat.dispose()
      meshRef.current = null
      matRef.current = null
    }
  }, [scene, type, altitudeBase, altitudeTop, coverage, enabled])

  // Called every frame from the parent animate() loop
  function update(time: number, cameraPosition: THREE.Vector3) {
    if (!matRef.current) return
    matRef.current.uniforms.uTime.value = time
    matRef.current.uniforms.uCameraPos.value.copy(cameraPosition)
  }

  return { update }
}