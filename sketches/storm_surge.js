// Storm Surge — a brooding volumetric storm: ray-marched FBM clouds drift
// across a dark sky while crepuscular god rays fan from a hidden sun and
// forked lightning tears open on every detected kick. Bass thickens the
// cloud cover, mids roll the billows, and highs crackle the edges.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCover;
  uniform float uGodrays;
  uniform float uDrift;
  uniform float uBloom;

  // A layered cloud density built from domain-warped FBM. Marching it along
  // the view ray yields soft, self-shadowing billows rather than a flat sprite.
  float cloudDensity(vec3 p, float time) {
    vec3 q = p;
    q.x += time * 0.12;
    // Domain warp for turbulent, cauliflower-edged billows.
    float warp = fbm4(q.xy * 0.6 + time * 0.04) - 0.5;
    q.xy += vec2(warp * 0.5, warp * 0.3) * (0.6 + uMid * 0.5);
    float density = fbm4(q.xy * 1.3 + q.z * 0.25);
    // Vertical falloff keeps clouds in a band of the sky.
    float band = smoothstep(0.05, 0.4, p.y) * (1.0 - smoothstep(0.7, 1.1, p.y));
    density = smoothstep(0.52 - uCover * 0.12, 0.78, density);
    return density * band;
  }

  // Distance from a point to a line segment — used to draw forked lightning.
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * t);
  }

  // A jagged lightning bolt from the top of the screen toward an anchor.
  // Deterministic per-flash so it does not strobe randomly across frames.
  float lightning(vec2 p, float seed, float time, float flash) {
    float glow = 0.0;
    vec2 a = vec2(0.5 + (hash11(seed) - 0.5) * 0.6, 1.05);
    vec2 cur = a;
    float bolt = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      // Each vertex jitters downward and sideways, seeded deterministically.
      float h = hash11(seed + fi * 1.7);
      vec2 next = vec2(
        cur.x + (h - 0.5) * 0.34,
        cur.y - (0.12 + h * 0.08)
      );
      float d = segDist(p, cur, next);
      // Core plasma + soft halo; thickness shrinks toward the tip.
      float thick = (0.004 + 0.002 * (1.0 - fi / 6.0)) * flash;
      bolt += exp(-d * 70.0) * thick * 30.0;
      bolt += exp(-d * 14.0) * thick * 3.0;
      // Occasional side branches on a few segments.
      if (h > 0.62) {
        vec2 fork = cur + normalize(next - cur) * 0.3 + vec2((h - 0.7) * 0.6, -h * 0.3);
        float fd = segDist(p, cur, fork);
        bolt += exp(-fd * 90.0) * thick * 18.0;
      }
      cur = next;
    }
    return bolt * flash;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.10 + uDrift * 0.30);

    // Camera tilted to look up into the storm, swaying with the music.
    vec3 rd = normalize(vec3(uv.x, uv.y * 0.9 + 0.25, -1.0));
    rd.xz = rotate2d(sin(time * 0.08) * 0.05 + uMid * 0.02) * rd.xz;

    // A low, hidden sun — the source of the god rays and rim light.
    vec2 sunDir = normalize(vec2(0.35 + sin(time * 0.12) * 0.1, 0.18));
    float sunAngle = atan(sunDir.y, sunDir.x);

    vec3 color = vec3(0.01, 0.012, 0.02);
    float sky = smoothstep(-0.05, 0.5, uv.y);
    color = mix(vec3(0.02, 0.018, 0.03), vec3(0.04, 0.05, 0.09), sky);

    // Volumetric cloud march with cheap directional self-shadowing.
    float densityAccum = 0.0;
    vec3 cloudColor = vec3(0.0);
    for (int i = 0; i < 18; i++) {
      float t = (float(i) + 0.5) / 18.0;
      vec3 pos = rd * mix(1.2, 6.0, t);
      pos.y = mix(0.1, 1.0, t) + uv.y * 0.4;
      float d = cloudDensity(pos, time);
      // Light direction from the sun; samples toward it for a soft shadow term.
      float light = 0.4 + 0.6 * smoothstep(0.4, 0.9,
        cloudDensity(pos - vec3(sunDir.x, sunDir.y, 0.0) * 0.6, time));
      float contrib = d * (1.0 - densityAccum * 0.6) * (0.55 + light * 0.8) / 18.0;
      densityAccum += contrib;
      // Storm-grey base lit warm toward the sun, cold in shadow.
      vec3 lit = mix(vec3(0.12, 0.14, 0.22), vec3(0.6, 0.45, 0.3), light);
      cloudColor += lit * contrib * (0.5 + uEnergy * 0.8);
    }
    color += cloudColor;

    // Crepuscular god rays: radial sampling toward the sun through cloud occlusion.
    float rays = 0.0;
    vec2 ruv = uv * vec2(uResolution.x / uResolution.y, 1.0) - sunDir * vec2(1.0, 2.0);
    float r = length(ruv);
    float a = atan(ruv.y, ruv.x);
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      float aa = a + (fi - 3.5) * 0.012;
      float occlusion = 0.0;
      for (int j = 0; j < 5; j++) {
        float fj = float(j);
        float rr = r * (0.4 + fj * 0.18);
        vec2 sampleUv = vec2(cos(aa), sin(aa)) * rr + sunDir * vec2(1.0, 2.0);
        vec3 sp = vec3(sampleUv.x, sampleUv.y * 0.9 + 0.25, -1.0);
        occlusion += cloudDensity(sp * 2.0, time);
      }
      occlusion /= 5.0;
      rays += (1.0 - occlusion) * exp(-r * (1.2 + fi * 0.1));
    }
    rays *= 0.05 * uGodrays;
    vec3 rayColor = mix(vec3(1.0, 0.7, 0.4), vec3(0.5, 0.7, 1.0), 0.5 + 0.5 * sin(time * 0.4));
    color += rayColor * rays * (0.6 + uHigh * 0.4 + uHat * 1.2);

    // Hidden sun glow piercing the cloud base.
    float sunGlow = exp(-length(ruv) * 3.0);
    color += mix(vec3(1.0, 0.6, 0.3), vec3(0.4, 0.5, 0.9), 0.5 + 0.5 * sin(time * 0.3))
      * sunGlow * (0.15 + uSub * 0.25 + uKick * 0.5) * uGodrays;

    // Forked lightning on detected beats. Each beat launches a new flash seed.
    float flash = uBeat * 0.9 + uKick * 0.6;
    float bolt = 0.0;
    // Use a quantised time so each detected beat owns one coherent bolt.
    float beatSeed = floor(uTime * 3.0) * 0.137 + floor(uBeat * 8.0) * 0.91;
    for (int b = 0; b < 2; b++) {
      bolt += lightning(uv, beatSeed + float(b) * 0.7, time, flash);
    }
    vec3 boltColor = mix(vec3(0.6, 0.8, 1.0), vec3(0.8, 0.6, 1.0), 0.5 + 0.5 * sin(time));
    color += boltColor * bolt * uBloom;
    // Whole-frame flash fill so the kick lights the clouds electrically.
    color += boltColor * flash * 0.06 * densityAccum * uBloom * 4.0;

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.3 + 0.7 * vignette;
    color = filmicTone(color * 1.15);
    color = pow(color, vec3(0.92));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uCover: P.cover ?? 1,
    uGodrays: P.godrays ?? 1,
    uDrift: P.drift ?? 1,
    uBloom: P.bloom ?? 1,
  }),
);
