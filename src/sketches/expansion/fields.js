// Expansion GPU fields: two cinematic constructions (screen-space god rays,
// video-feedback zoom) and two signal-corruption constructions (VHS tracking,
// DCT block artifacts). Band roles are structural in the shader, not exposure
// trim: bass scales/reaches, mids reshape the field geometry, highs reseed
// fine accents (dust, dropouts, mosquito noise). Reference-style gated
// percussion rides the shared uniforms: uKick surges the bass structure,
// uSnare snaps the mid geometry, uHat bursts the treble reseeding, uBeat
// flashes the global energy. No fabricated idle beats — silence stays silent.
import { expansionEntry, expansionParams, shaderFactory } from './runtime.js';

// Crepuscular "god rays" through drifting occluders (GPU Gems 13 radial
// scattering approach, computed procedurally). Bass extends shaft reach and
// radiant energy, mids rotate and thicken the occluder field, highs reseed
// drifting dust motes across the beams. Kicks surge the shafts, snares snap
// the occluder field, hats burst the motes, energy lifts the source bloom.
const godrayForge = shaderFactory(`
float occluder(vec2 p, float t) {
  p = rotate2d(uMid * 1.3 + uSnare * .35) * p;          // mid + snare: field rotation snap
  float o = fbm4(p * (1.6 + uDetail) + vec2(0.0, -t * .35) + uMid * 1.7);
  return smoothstep(.34, .72, o + uMid * .28);        // mid: density geometry
}
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed;
  vec2 light = vec2(.18 * sin(t * .4), 1.12);
  vec2 delta = light - uv;
  float dist = max(length(delta), .0001);
  vec2 dir = delta / dist;
  float reach = mix(.3, 1.05, saturate(uSub + uKick * .3)); // bass + kick: shaft reach surge
  float ray = 0.0;
  for (int i = 0; i < 26; i++) {
    float fi = float(i) / 26.0;
    vec2 q = uv + dir * dist * fi * reach;
    ray += (1.0 - occluder(q * vec2(1.0, 1.35), t)) * (1.0 - fi) * (0.9 + fi * .2);
  }
  ray /= 26.0;
  float az = atan(uv.y - light.y, uv.x - light.x);
  float spokes = pow(.5 + .5 * sin(az * (7.0 + uDetail * 5.0) + fbm4(uv * 3.0 + t * .2) * 4.0), 3.0);
  float glow = .3 + uSub * 1.15 + uKick * .4;         // bass + kick: radiant energy surge
  vec3 warm = ink(.02), hot = ink(.48);
  vec3 col = vec3(.012, .014, .028);
  col += mix(warm, hot, saturate(ray * 1.4)) * ray * spokes * glow * (1.2 + uDetail * .3);
  col += hot * pow(ray, 3.0) * .5 * glow;
  col += warm * exp(-dist * 2.2) * (.25 + uSub * .5 + uEnergy * .25); // source bloom (energy lift)
  // high + hat: dust motes drifting through the shafts
  vec2 cellUv = uv * vec2(34.0, 22.0);
  vec2 cell = floor(cellUv + vec2(0.0, t * (1.0 + uHigh * 2.0 + uHat * .8)));
  float mote = step(1.0 - uHigh * .38 - uHat * .14, hash21(cell));
  vec2 cf = fract(cellUv + vec2(0.0, t)) - .5;
  mote *= exp(-dot(cf, cf) * 6.5);
  col += vec3(1.0, .95, .8) * mote * (.2 + uHigh * 1.3 + uHat * .6) * (ray * 2.0 + .15);
  float vignette = 1.0 - smoothstep(.7, 1.6, length(uv * vec2(.7, 1.0)));
  col *= .3 + .7 * vignette;
  gl_FragColor = vec4(filmicTone(col * 1.5), 1.0);
}`);

// Video-feedback zoom (Paik-style camera-into-monitor recursion, procedural).
// Bass pumps the per-layer zoom, mids rotate successive layers (spiral
// geometry), highs fringing layer frames with hue-shifted edges and grain.
// Kicks surge the zoom, snares snap the spiral, hats burst the fringe, the
// detected beat flashes the inner glow.
const feedbackBloom = shaderFactory(`
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed;
  float zoom = 1.18 + uSub * .6 + uKick * .14 + .06 * sin(t * .8);  // bass + kick: zoom pump/surge
  vec2 p = uv;
  vec3 col = vec3(.008, .01, .02) + ink(.55) * .05;
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    p = rotate2d(uMid * .85 + uSnare * .28 + .08 * sin(t * .3 + fi)) * p; // mid + snare: spiral snap
    p *= zoom;
    vec2 q = abs(p) - vec2(1.0, .72);
    float ring = line(max(q.x, q.y), .014 + uSub * .01);
    vec3 layer = ink(fi * .07 + fbm4(p * .7 + t * .05) * .25);
    float fade = pow(.78, fi);
    col = mix(col, layer * (1.1 - fi * .07), ring * fade);
    float inner = 1.0 - smoothstep(.0, .35, max(q.x, q.y));
    col += layer * inner * fade * (.1 + uSub * .12 + uBeat * .08); // beat: inner glow flash
    // high + hat: chromatic fringe ghosts on each frame edge
    float fringe = line(max(q.x, q.y) + .02 + uHigh * .05 + uHat * .025, .008);
    col += ink(.5 + fi * .03) * fringe * fade * (uHigh + uHat * .5) * .8;
    total += ring * fade;
  }
  float grain = hash21(vTexCoord * uResolution + fract(t) * 91.0) - .5;
  col += grain * (.015 + uHigh * .07 + uHat * .035);  // high + hat: monitor grain
  col = filmicTone(col * 1.45);
  gl_FragColor = vec4(col, 1.0);
}`);

// VHS tracking errors: horizontal tear bands, head-switching noise, chroma
// bleed and dropouts over a synthesized broadcast signal. Bass tears the
// bands across the frame, mids restructure band count and wobble curvature,
// highs reseed dropouts, grain and chroma jitter. Kicks surge the tears,
// snares snap the band structure, hats burst the dropouts, the detected beat
// thickens the head-switching noise.
const vhsTracking = shaderFactory(`
vec3 signalScene(vec2 uv) {
  vec3 col;
  float x = clamp(uv.x, 0.0, 1.0);
  if (x < .63) {                                      // bars section
    float bar = floor(x / .09);
    col = hsv2rgb(vec3(fract(bar * .13 + .55), .68, .55 + .25 * mod(bar, 2.0)));
  } else {                                            // circle + gradient field
    vec2 q = (uv - vec2(.815, .5)) * vec2(1.6, 1.0);
    float r = length(q);
    col = mix(vec3(.85, .8, .2), vec3(.1, .2, .5), smoothstep(.2, .23, r));
    col = mix(col, vec3(.9), smoothstep(.06, .05, abs(r - .14)));
  }
  col *= .75 + .25 * uv.y;
  return col;
}
float lumaOf(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
void main() {
  vec2 uv = vTexCoord;
  float t = uTime * uSpeed;
  float bandCount = 3.0 + uMid * 6.0 + uSnare * 1.6;  // mid + snare: band structure snap
  float band = floor(uv.y * bandCount);
  float tearSeed = hash21(vec2(band, floor(t * 2.5)));
  float tear = (tearSeed - .5) * (uSub * .55 + uKick * .2) // bass + kick: tear surge
    * step(.35, tearSeed);
  float wobble = sin(uv.y * (30.0 + uMid * 60.0) + t * 5.0) * (uMid * .02 + uSnare * .008); // mid + snare: curvature
  vec2 suv = uv;
  suv.x += tear + wobble;
  // head-switching noise pinned to the bottom of the frame (beat thickens it)
  float head = 1.0 - smoothstep(.0, .07, uv.y);
  suv.x += head * (hash21(vec2(floor(uv.y * 220.0), floor(t * 30.0))) - .5) * (.04 + uSub * .12 + uBeat * .05);
  suv.x = fract(suv.x);
  vec3 col = signalScene(suv);
  // chroma bleed: luma/chroma split with shifted chroma
  vec3 blurred = signalScene(suv + vec2(.006 + uHigh * .012 + uHat * .005, 0.0));
  float l = lumaOf(col);
  col = mix(vec3(l) + (col - l) * (1.0 - uHigh * .6), col, .4);
  col = mix(col, blurred, .22 + uHigh * .25 + uHat * .1);
  // dropouts & grain (high + hat accents)
  float drop = step(1.0 - uHigh * .22 - uHat * .1, hash21(floor(suv * uResolution / vec2(3.0, 2.0)) + floor(t * 22.0)));
  col = mix(col, vec3(.92), drop * .85);
  col += (hash21(uv * uResolution + fract(t * 7.0)) - .5) * (.05 + uHigh * .22 + uHat * .1);
  col *= .88 + .12 * sin(uv.y * uResolution.y * 3.14159); // scanlines
  col = mix(col, col * (.6 + .4 * hash21(vec2(floor(t * 24.0), band))), head * .7);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`);

// JPEG/DCT compression artifacts over a synthesized still: block quantization,
// coefficient crush and mosquito noise. Bass swells the 8x8 block grid, mids
// crush coefficient levels and darken block-boundary DC bleed, highs swarm
// mosquito noise and flicker block DC. Kicks surge the blocks, snares snap
// the crush, hats burst the mosquito swarm.
const dctBlocks = shaderFactory(`
vec3 stillScene(vec2 uv) {
  vec3 sky = mix(vec3(.12, .25, .55), vec3(.55, .75, .9), uv.y);
  vec3 col = sky;
  float sun = length((uv - vec2(.74, .74)) * vec2(1.4, 1.0));
  col = mix(vec3(1.0, .85, .4), col, smoothstep(.09, .11, sun));
  float hills = .34 + .1 * sin(uv.x * 9.0) + .05 * sin(uv.x * 23.0);
  col = mix(col, vec3(.16, .3, .16), smoothstep(hills - .005, hills + .005, uv.y));
  float trunk = step(abs(uv.x - .3), .012) * step(uv.y, .45);
  float crown = length((uv - vec2(.3, .5)) * vec2(1.2, 1.0));
  col = mix(col, vec3(.25, .14, .07), trunk);
  col = mix(col, vec3(.1, .4, .12), 1.0 - smoothstep(.1, .12, crown));
  return col;
}
void main() {
  vec2 uv = vTexCoord;
  float bs = (6.0 + uSub * 26.0 + uKick * 7.0) * uDetail; // bass + kick: block scale surge
  vec2 block = floor(uv * uResolution / bs);
  vec2 bc = (block + .5) * bs / uResolution;
  vec3 col = stillScene(bc);                          // block-averaged (DCT DC)
  // mid + snare: coefficient crush + per-block DC scramble
  float levels = 26.0 - uMid * 21.0 - uSnare * 4.0;
  col = floor(col * levels + .5) / levels;
  float scramble = (hash21(block * 1.7 + floor(uTime * uSpeed * 5.0)) - .5) * (uMid * 1.1 + uSnare * .3);
  col = clamp(col + scramble * step(.04, abs(scramble)), 0.0, 1.0);
  vec2 f = fract(uv * uResolution / bs);
  vec2 dmin = min(f, 1.0 - f);
  float border = 1.0 - smoothstep(.0, .1, min(dmin.x, dmin.y));
  float dc = hash21(block + floor(uTime * uSpeed * 7.0));
  col *= 1.0 - border * (uMid * .45 + uSnare * .12);  // mid + snare: boundary DC bleed
  col += border * (dc - .5) * (.12 + uHigh * .8 + uHat * .3); // high + hat: ringing flicker
  float mosquito = step(1.0 - uHigh * .45 - uHat * .15, hash21(block * 3.1 + floor(uTime * uSpeed * 13.0)));
  col += (mosquito - .25) * (.35 + border) * (uHigh + uHat * .5) * .8; // high + hat: mosquito swarm burst
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`);

export const FIELD_PATTERNS = [
  expansionEntry({ id: 'godray-forge', name: 'Godray Forge', group: 'Cinematic / Shaders', factory: godrayForge, params: expansionParams('Ray Detail'), description: 'Volumetric light shafts: bass extends shaft reach and radiant energy, mids rotate and thicken the occluder field, highs reseed drifting dust motes in the beams; kicks surge the shafts, snares snap the field, hats burst the motes.' }),
  expansionEntry({ id: 'feedback-bloom', name: 'Feedback Bloom', group: 'Cinematic / Shaders', factory: feedbackBloom, params: expansionParams('Layer Detail'), description: 'Video-feedback recursion: bass pumps the per-layer zoom, mids rotate successive layers into spirals, highs fringe frame edges with hue-shifted ghosts and monitor grain; kicks surge the zoom, snares snap the spiral, hats burst the fringe.' }),
  expansionEntry({ id: 'vhs-head-switch', name: 'VHS Head Switch', group: 'Glitch / Effects', factory: vhsTracking, params: expansionParams('Signal Detail'), description: 'VHS head-switching and tracking errors over a synthesized broadcast signal: bass tears horizontal bands across the frame, mids restructure band count and wobble curvature, highs reseed dropouts, grain and chroma bleed; kicks surge the tears, snares snap the bands, hats burst the dropouts.' }),
  expansionEntry({ id: 'dct-blocks', name: 'DCT Blocks', group: 'Glitch / Effects', factory: dctBlocks, params: expansionParams('Artifact Scale'), description: 'JPEG/DCT compression artifacts: bass swells the block grid, mids crush coefficient levels and darken boundary DC bleed, highs swarm mosquito noise and flicker block DC; kicks surge the blocks, snares snap the crush, hats burst the swarm.' }),
];
