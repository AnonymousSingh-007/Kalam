import * as THREE from 'three'

export type CloudType = 'cumulus' | 'stratus' | 'cirrus'

// Radius of the enclosing sphere each layer uses as raymarch-trigger
// geometry — see the comment in CloudLayer.init() for why a sphere replaced
// the old flat plane. Matches the scene's fog-far distance (Scene.tsx) so
// cloud rendering doesn't stay crisp well past where everything else has
// already faded into fog.
const CLOUD_DOME_RADIUS = 600

const NOISE_GLSL = `
  float hash(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p.zxy, p.yxz + 19.19);
    return fract(p.x * p.y * p.z);
  }

  vec3 perlinGrad(vec3 p) {
    float h = hash(floor(p));
    float angle = h * 6.2832;
    float elev  = h * 3.1416 - 1.5708;
    return vec3(cos(elev) * cos(angle), sin(elev), cos(elev) * sin(angle));
  }

  float perlin3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

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

  float worley3(vec3 p) {
    vec3 i = floor(p);
    float minDist = 10.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          vec3 cell = i + vec3(float(dx), float(dy), float(dz));
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

  float perlinWorley(vec3 p) {
    float pn = (fbmPerlin(p, 4) + 1.0) * 0.5;
    float w  = fbmWorley(p, 3);
    return smoothstep(0.0, 1.0, pn) * w;
  }
`

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

const CLOUD_FRAGMENT = `
  uniform float uTime;
  uniform float uAltBase;
  uniform float uAltTop;
  uniform float uCoverage;
  uniform int   uCloudType;
  uniform vec3  uCameraPos;

  varying vec3 vWorldPos;
  varying vec2 vUv;

  ${NOISE_GLSL}

  float cloudDensity(vec3 p, float altNorm) {
    float d;
    if (uCloudType == 0) {
      vec3 sp = vec3(p.x * 0.15 + uTime * 0.008, p.y * 0.4, p.z * 0.15 + uTime * 0.005);
      float raw = perlinWorley(sp);
      float env = smoothstep(0.0, 0.15, altNorm) * (1.0 - smoothstep(0.4, 1.0, altNorm));
      d = max(0.0, raw * env * uCoverage);
    } else if (uCloudType == 1) {
      vec3 sp = vec3(p.x * 0.08 + uTime * 0.004, p.y * 0.2, p.z * 0.08 + uTime * 0.003);
      float pn = (fbmPerlin(sp, 3) + 1.0) * 0.5;
      float env = smoothstep(0.0, 0.1, altNorm) * (1.0 - smoothstep(0.85, 1.0, altNorm));
      // Soft threshold instead of a hard linear cutoff (pn - 0.3, clamped at
      // 0) — that had a discontinuous derivative right at the pn=0.3
      // contour, which is what made stratus read as a hard-edged sheet.
      float soft = smoothstep(0.25, 0.55, pn);
      d = soft * env * uCoverage;
    } else {
      vec3 sp = vec3(p.x * 0.3 + uTime * 0.015, p.y * 0.6, p.z * 0.08);
      float w = fbmWorley(sp, 2);
      float env = smoothstep(0.0, 0.05, altNorm) * (1.0 - smoothstep(0.9, 1.0, altNorm));
      d = max(0.0, w * 0.6 * env * uCoverage);
    }
    // Soft dissolve near the density field's own low-density boundary —
    // replaces an implicit hard 0/nonzero cutoff with a smooth ramp so
    // cloud silhouettes fade at the edge instead of cutting off sharply.
    return d * smoothstep(0.0, 0.12, d);
  }

  void main() {
    vec3 rayDir = normalize(vWorldPos - uCameraPos);

    float tBase, tTop;
    if (abs(rayDir.y) < 0.0001) {
      if (vWorldPos.y < uAltBase || vWorldPos.y > uAltTop) discard;
      tBase = 0.0; tTop = 200.0;
    } else {
      tBase = (uAltBase - uCameraPos.y) / rayDir.y;
      tTop  = (uAltTop  - uCameraPos.y) / rayDir.y;
      if (tBase > tTop) { float tmp = tBase; tBase = tTop; tTop = tmp; }
    }

    // The slab intersection above is unbounded — if the whole altitude band
    // lies behind the camera (e.g. looking down at the ground from below a
    // cumulus band), both tBase and tTop come out negative. Only tBase gets
    // clamped to 0 below, so an unguarded tTop<0 case would march backwards
    // (negative t = behind the camera) and could sample real noise values
    // that coincidentally land inside the band, producing phantom cloud
    // patches in the wrong part of the screen. This case was unreachable
    // before (a flat plane at a single altitude never rasterized downward
    // rays), but becomes reachable once the proxy geometry gives full
    // screen coverage — see the geometry change in init() below.
    if (tTop <= 0.0) discard;

    tBase = max(tBase, 0.0);
    float slabThickness = uAltTop - uAltBase;

    const int STEPS = 16;
    // Cap the marched distance so grazing/near-horizontal rays (very long
    // tTop-tBase) don't produce a handful of huge steps that each cross a
    // big chunk of optical depth in one jump. That mismatch — long steps on
    // shallow-angle rays, tiny steps on steep ones, with a fixed step COUNT
    // — is what made clouds read as either an opaque wall or barely-there
    // depending on view angle, rather than a genuine coverage/density issue.
    float rayLength = min(tTop - tBase, 140.0);
    float stepSize = rayLength / float(STEPS);

    float transmittance = 1.0;
    vec3 scatteredLight = vec3(0.0);

    // Warm dawn-lit tops (matches the sky dome's horizon glow ~0xe0875f),
    // cool muted purple-gray shadowed undersides (echoes the sky's
    // 0x241a3d mid-tone) instead of neutral white/gray.
    vec3 cloudTopColor  = vec3(1.0, 0.82, 0.62);
    vec3 cloudBaseColor = vec3(0.35, 0.32, 0.42);

    for (int i = 0; i < STEPS; i++) {
      float t = tBase + (float(i) + 0.5) * stepSize;
      vec3 samplePos = uCameraPos + rayDir * t;

      float altNorm = clamp(
        (samplePos.y - uAltBase) / max(slabThickness, 0.001),
        0.0, 1.0
      );

      float density = cloudDensity(samplePos, altNorm);
      if (density < 0.001) continue;

      float extinction = density * stepSize * 0.6;
      float sampleTransmittance = exp(-extinction);
      vec3 sampleColor = mix(cloudBaseColor, cloudTopColor, altNorm);

      scatteredLight += transmittance * (1.0 - sampleTransmittance) * sampleColor;
      transmittance  *= sampleTransmittance;

      if (transmittance < 0.01) break;
    }

    float alpha = 1.0 - transmittance;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(scatteredLight / max(alpha, 0.001), alpha * 0.9);
  }
`

export class CloudLayer {
  private mesh: THREE.Mesh | null = null
  private mat: THREE.ShaderMaterial | null = null

  constructor(
    private scene: THREE.Scene,
    private type: CloudType,
    private altitudeBase: number,
    private altitudeTop: number,
    private coverage: number
  ) {
    this.init()
  }

  private init() {
    const typeIndex = this.type === 'cumulus' ? 0 : this.type === 'stratus' ? 1 : 2

    // The fragment shader's tBase/tTop slab intersection (see CLOUD_FRAGMENT
    // above) is fully analytical — it intersects the ray against the
    // uAltBase/uAltTop world-space planes directly and doesn't care what
    // shape triggered the fragment. So the mesh here is purely a raymarch
    // trigger, not a bound on the volume.
    //
    // The old geometry was a single flat 400x400 PlaneGeometry sitting at
    // one fixed altitude. That's exactly why clouds read as flat slabs: a
    // flat disc at a single Y only rasterizes to a reasonable footprint when
    // viewed close to top-down. At the shallow, near-horizontal viewing
    // angles this scene's low camera actually uses most of the time, the
    // disc is seen near edge-on — it shrinks to almost nothing, or shows its
    // hard rectangular boundary cutting across the sky. No finite flat plane
    // fixes this; the screen-space footprint of a near-grazing ray against a
    // fixed-Y plane blows up towards infinity.
    //
    // Fix: swap the flat disc for a large sphere centered on the origin
    // (same technique as the sky dome above), rendered BackSide so the
    // camera — which stays well inside it — sees the inner surface. A
    // sphere presents a reasonable footprint from any viewing angle, and
    // being a single convex enclosing surface, a ray crosses it exactly
    // once — important because if a ray hit the geometry twice, the shader
    // would run its *entire* independent slab raymarch twice and alpha-blend
    // the results, roughly doubling apparent density/opacity. That
    // double-hit risk is exactly why a literal "stack of several planes"
    // fix was rejected: this shader already does a full analytical
    // tBase-to-tTop integral per fragment, so any proxy geometry a ray can
    // cross more than once would double-count that integral. A single
    // enclosing sphere avoids this by construction.
    const geo = new THREE.SphereGeometry(CLOUD_DOME_RADIUS, 32, 20)

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      { value: 0 },
        uAltBase:   { value: this.altitudeBase },
        uAltTop:    { value: this.altitudeTop },
        uCoverage:  { value: this.coverage },
        uCloudType: { value: typeIndex },
        uCameraPos: { value: new THREE.Vector3() }
      },
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.NormalBlending
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 1

    this.scene.add(mesh)
    this.mesh = mesh
    this.mat = mat
  }

  update(time: number, cameraPosition: THREE.Vector3) {
    if (!this.mat) return
    this.mat.uniforms.uTime.value = time
    this.mat.uniforms.uCameraPos.value.copy(cameraPosition)
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.ShaderMaterial).dispose()
      this.mesh = null
      this.mat = null
    }
  }
}