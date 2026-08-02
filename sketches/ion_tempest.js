// Ion Tempest — a volumetric electrical storm. Turbulent plasma clouds seed
// branching lightning bolts that fork on kicks, while mids thicken the arcs and
// highs spray corona sparks. Built for hard techno drops and festival LED walls.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uStorm;
  uniform float uBranch;
  uniform float uSpeed;
  uniform float uGlow;

  float boltField(vec2 p, float seed, float time) {
    // Domain-warped vertical channels create readable lightning trunks that still
    // feel organic when the storm intensifies.
    float warp = fbm4(p * vec2(2.4, 1.1) + vec2(seed * 3.1, time * 0.55));
    float trunk = abs(p.x + (warp - 0.5) * (0.55 + uBranch * 0.45));
    float mainBolt = exp(-trunk * (38.0 + uHigh * 10.0 - uStorm * 6.0));

    float forkWarp = fbm4(p * vec2(5.5, 2.2) - vec2(time * 1.3, seed * 7.0));
    float forks = exp(-abs(p.x + (forkWarp - 0.5) * 1.4 + sin(p.y * 9.0 + seed) * 0.08)
      * (52.0 - uBranch * 10.0));
    forks *= smoothstep(0.15, 0.75, abs(p.y));

    float micro = exp(-abs(sin(p.y * 28.0 + warp * 12.0 - time * 8.0 + seed))
      * (4.0 + uHat * 5.0)) * mainBolt;
    return mainBolt * 1.15 + forks * (0.45 + uBranch * 0.55) + micro * 0.35;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.22 + uSpeed * 0.7);
    float impact = max(uKick, uBeat * 0.9);
    vec2 p = uv;
    p.y += 0.08;
    p *= 1.0 - impact * 0.04;

    // Rolling storm body from layered fbm — denser near the horizon line.
    float cloud = fbm4(p * vec2(1.6, 2.4) + vec2(time * 0.18, -time * 0.09));
    cloud += fbm4(p * vec2(3.4, 5.1) - vec2(time * 0.31, time * 0.14)) * 0.45;
    float cloudMask = pow(saturate(cloud * 0.62 + 0.18 - abs(p.y) * 0.22), 1.7);
    cloudMask *= 0.55 + uStorm * 0.55 + uSub * 0.25;

    vec3 color = vec3(0.001, 0.004, 0.014);
    color += mix(vec3(0.02, 0.01, 0.08), vec3(0.0, 0.08, 0.18), cloud)
      * cloudMask * (0.55 + uEnergy * 0.7);

    // Three staggered bolt systems so the frame never feels empty between hits.
    float bolt = 0.0;
    bolt += boltField(p * vec2(1.15, 1.0) + vec2(0.12, 0.0), 1.7, time)
      * (0.35 + impact * 1.8 + uSnare * 0.55);
    bolt += boltField(p * vec2(0.92, 1.05) - vec2(0.35, 0.05), 4.2, time * 1.07)
      * (0.22 + uMid * 0.55 + uSnare * 1.1);
    bolt += boltField(rotate2d(0.4) * p * 1.1 + vec2(0.2, -0.1), 8.9, time * 0.93)
      * (0.12 + uHigh * 0.45 + uHat * 0.9);

    // Kick-gated flash bolts: sharp attack, readable decay via uBeat envelope.
    float flashGate = saturate(impact * 1.4 + uBeat * 0.5);
    bolt *= 0.25 + flashGate * 0.95 + uStorm * 0.2;

    vec3 boltCold = vec3(0.35, 0.7, 1.0);
    vec3 boltHot = vec3(0.85, 0.95, 1.0);
    vec3 boltPink = vec3(1.0, 0.25, 0.7);
    vec3 boltColor = mix(boltCold, boltPink, saturate(uMid * 0.35 + uSnare * 0.4));
    color += mix(boltColor, boltHot, saturate(bolt * 1.4)) * bolt * (1.4 + uGlow);

    // Soft bloom halo around the brightest channels.
    color += boltColor * pow(bolt, 1.6) * (0.55 + uGlow * 0.8);
    color += vec3(0.9, 0.95, 1.0) * pow(bolt, 4.5) * (0.4 + impact * 1.2);

    // Corona sparks ride the highs so hats glitter across the cloud deck.
    float sparkCell = floor((uv + 1.0) * vec2(42.0, 28.0)).x
      + floor((uv.y + 1.0) * 28.0) * 17.0;
    float spark = step(0.97 - uHigh * 0.03 - uHat * 0.12, hash11(sparkCell + floor(time * 11.0)));
    spark *= exp(-abs(uv.y - (hash11(sparkCell) * 1.4 - 0.7)) * 8.0);
    color += vec3(0.7, 0.85, 1.0) * spark * (0.15 + uHigh * 0.5 + uHat * 1.8) * uGlow;

    // Expanding shock ring on detected beats.
    float ringR = 0.18 + (1.0 - saturate(uBeat)) * 0.85;
    float ring = exp(-abs(length(uv) - ringR) * 48.0) * uBeat;
    color += mix(boltCold, boltPink, 0.45) * ring * (0.7 + uGlow * 0.5);

    // Ground glow / horizon sheet for stage depth.
    float ground = exp(-abs(uv.y + 0.72) * (6.0 - uSub * 1.5))
      * (0.08 + uSub * 0.2 + impact * 0.45);
    color += mix(vec3(0.0, 0.15, 0.45), vec3(0.45, 0.0, 0.35), 0.4) * ground * uStorm;

    float vignette = 1.0 - smoothstep(0.68, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.26 + 0.74 * vignette;
    color = filmicTone(color * 1.35);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uStorm: P.storm ?? 1,
    uBranch: P.branch ?? 1,
    uSpeed: P.speed ?? 1,
    uGlow: P.glow ?? 1,
  }),
);
