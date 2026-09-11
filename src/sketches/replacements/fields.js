// Each field implements a different construction, not a switch in a common look.
// Reference-style accents ride the gated percussion uniforms: uKick punches
// the bass-driven structure, uSnare snaps the mid-driven deformation, uHat
// bursts the fine treble accents. Sustained mapping is unchanged.
import { entry, shaderFactory } from './runtime.js';

const truchet = shaderFactory(`
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  vec2 grid = uv * (2.1 * uDetail) + vec2(uTime * uSpeed * .12, 0.0);
  grid.y += uMid * 1.2;
  vec2 cell = floor(grid), q = fract(grid);
  // Mid flips connectivity of entire tiles. Treble offsets paired inner tracks.
  if (hash21(cell) < .25 + uMid * 1.1 + uSnare * .18) q.x = 1.0 - q.x;
  float d = min(abs(length(q) - .5), abs(length(q - 1.0) - .5));
  float outer = line(d, .04 + uSub * .22 + uKick * .07);
  float inner = line(d - .03 - uHigh * .32 - uHat * .1, .018);
  vec3 col = vec3(.015, .024, .04) + ink(.0) * outer * .76 + ink(.45) * inner * (.8 + uHat * .6);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`);
const membrane = shaderFactory(`
void main() {
  vec2 p = (vTexCoord * 2.0 - 1.0); p.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed;
  // Two standing-wave eigenmodes. Audio changes nodal topology, not exposure.
  // Bass bows the whole membrane; mid shears/turns the nodal lattice.
  // Kick punches the bow, snare snaps the turn, hats fracture the fine lines.
  p *= 1.0 + (uSub * .9 + uKick * .3) * exp(-length(p) * .7);
  p = rotate2d(uMid * 1.5 + uSnare * .45) * p;
  p.x += (uMid * .7 + uSnare * .2) * sin(p.y * 2.5 + t);
  float x = p.x * 3.0 * uDetail;
  float y = p.y * 3.0 * uDetail;
  float f = cos(x + .12 * sin(t)) * cos(y) - cos(y * 1.6) * cos(x * .6);
  f += (uHigh * 1.5 + uHat * .7) * sin(p.x * 21.0 + p.y * 13.0 + t * 3.0);
  float nodes = exp(-abs(f) * 12.0);
  float sand = .55 + .45 * hash21(floor(vTexCoord * uResolution / 2.0));
  vec3 col = vec3(.01, .02, .03) + ink(.03) * nodes * sand + ink(.48) * line(f - .3, .035) * .45;
  gl_FragColor = vec4(col, 1.0);
}`);
const schlieren = shaderFactory(`
void main() {
  vec2 p = vTexCoord * 2.0 - 1.0; p.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed * .65;
  // Domain-warped density with a knife-edge-like derivative accent.
  vec2 warp = vec2(fbm4(p * 1.8 + t), fbm4(p * 1.8 - t + 7.0));
  p += (warp - .5) * (1.1 + uSub * 6.5 + uKick * 1.8);
  p = rotate2d(uMid * (2.2 + length(p) * 1.2) + uSnare * .55) * p;
  float f = fbm4(p * (2.0 * uDetail) + vec2(t, -t));
  float contour = sin(f * (24.0 + uHigh * 85.0 + uHat * 20.0) + p.y * 2.0);
  float slope = fbm4(p * 2.0 + .035) - fbm4(p * 2.0 - .035);
  vec3 cold = ink(.0) * (.15 + .5 * f), hot = ink(.48);
  vec3 col = mix(cold, hot, smoothstep(.05, .9, contour)) * (.65 + slope * 2.0);
  col += vec3(.4, .6, .65) * pow(max(0.0, contour), 12.0) * (.4 + uHat * .35);
  gl_FragColor = vec4(filmicTone(col * 1.65), 1.0);
}`);
const tidalGlass = shaderFactory(`
float softUnion(float a, float b) {
  float k = .32; float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * .25;
}
float glass(vec3 p) {
  float t = uTime * uSpeed * .4;
  p.xy = rotate2d(t + uMid * 2.6 + uSnare * .5) * p.xy;
  float a = length(p - vec3(-.3 - uSub * .85 - uKick * .22, .05, 0.0)) - (.43 + uSub * .12 + uKick * .05);
  float b = length(p - vec3(.4 + uSub * .3, .12 + uMid * .85 + uSnare * .2, .05)) - .48;
  float c = length(p - vec3(.05, -.42, .1)) - .34;
  return softUnion(softUnion(a, b), c) + sin(p.y * (18.0 * uDetail) + t * 3.0) * sin(p.x * 13.0) * (uHigh * .115 + uHat * .05);
}
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  vec3 ro = vec3(0.0, 0.0, 3.4), rd = normalize(vec3(uv, -2.7));
  float travel = 0.0, d = 1.0;
  for (int i = 0; i < 42; i++) {
    d = glass(ro + rd * travel);
    if (d < .002 || travel > 6.0) break;
    travel += max(.001, d * .7);
  }
  vec3 col = vec3(.014, .022, .043) + ink(.03) * .09 * exp(-abs(uv.y - .72) * 5.0);
  if (travel < 6.0 && d < .006) {
    vec3 p = ro + rd * travel; vec2 e = vec2(.004, 0.0);
    vec3 n = normalize(vec3(glass(p + e.xyy) - glass(p - e.xyy), glass(p + e.yxy) - glass(p - e.yxy), glass(p + e.yyx) - glass(p - e.yyx)));
    vec3 reflected = reflect(rd, n), refracted = refract(rd, n, .7);
    float stripes = .5 + .5 * sin(refracted.x * 14.0 + refracted.y * 8.0);
    float fresnel = pow(1.0 - max(0.0, dot(n, -rd)), 2.4);
    float spec = pow(max(0.0, dot(reflected, normalize(vec3(-.6, .9, 1.0)))), 28.0);
    col = mix(ink(.5) * .16, ink(.0) * .8, stripes) + fresnel * ink(.12) + spec * vec3(1.0) * (1.0 + uBeat * .8);
    col = filmicTone(col * 1.5);
  }
  gl_FragColor = vec4(col, 1.0);
}`);
const bitplane = shaderFactory(`
float xorByte(float a, float b) {
  float outValue = 0.0, weight = 1.0;
  for (int i = 0; i < 8; i++) {
    outValue += mod(mod(a, 2.0) + mod(b, 2.0), 2.0) * weight;
    a = floor(a / 2.0); b = floor(b / 2.0); weight *= 2.0;
  }
  return outValue / 255.0;
}
void main() {
  vec2 uv = vTexCoord;
  float t = floor(uTime * uSpeed * 3.0);
  vec2 address = floor(uv * (48.0 * uDetail / (1.0 + uSub * 2.6 + uKick * .9)));
  float x = mod(address.x + floor((uMid * 97.0 + uSnare * 24.0) * sin(address.y * .19 + uTime * uSpeed)) + t, 256.0);
  float y = mod(address.y * (2.0 + floor(uHigh * 23.0 + uHat * 7.0)), 256.0);
  float v = xorByte(x * 3.0, y * 5.0);
  float mask = step(.45, v);
  vec3 col = mix(vec3(.018, .025, .04), ink(v * .45) * (.35 + .65 * v), mask);
  gl_FragColor = vec4(col, 1.0);
}`);
const stairWipe = shaderFactory(`
void main() {
  vec2 p = vTexCoord * 2.0 - 1.0;
  p = rotate2d(.4 + uMid * 1.9 + uSnare * .4) * p;
  float steps = max(2.0, 8.0 * uDetail / (1.0 + uHigh * 3.2 + uHat * .9));
  float edge = floor(p.y * steps) / steps * .65 + sin(uTime * uSpeed * .5) * .08;
  // Bounded travel keeps the reveal on stage even with all gains at maximum.
  float shift = (uSub - .2) * 2.3 / (1.0 + uSub * 1.2) + uKick * .3 / (1.0 + uKick);
  float reveal = line(p.x - edge - shift, .12 + uHigh * .13);
  gl_FragColor = vec4(ink(.0) * reveal * (1.0 + uBeat * .5), 1.0);
}`);
const cellular = shaderFactory(`
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  vec2 p = uv * (2.0 * uDetail), cell = floor(p), f = fract(p);
  float first = 10.0, second = 10.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 offset = vec2(float(x), float(y)), id = cell + offset;
    vec2 site = .5 + (.14 + uMid * .72 + uSnare * .22) * sin(vec2(hash21(id), hash21(id + 8.0)) * 6.28 + uTime * uSpeed * .65);
    float d = length(offset + site - f);
    if (d < first) { second = first; first = d; } else { second = min(second, d); }
  }
  // Distance-to-cell-edge matte; white channels thicken and independent internal
  // apertures open. Exact black remains available for the existing Alpha Blend.
  // Both drives are capped: uncapped, maximum audio slid the wall edge past the
  // real second-first distances and pushed ventDrive beyond |sin|'s range,
  // erasing walls AND holes at once (black-out at maximum everything).
  float dilate = min(uSub * .38 + uKick * .12, .30);
  float wall = 1.0 - smoothstep(.025 + dilate, .055 + dilate, second - first);
  float holes = smoothstep(.09, .12, first);
  float ventDrive = min(uHigh * .95 + uHat * .3, 1.0);
  holes *= smoothstep(ventDrive - .04, ventDrive + .02, abs(sin(p.x * 7.0 + p.y * 5.0 + uTime * uSpeed * 2.0)));
  // Treble opens a separate ring of vents INSIDE each cell. The previous
  // tiny cuts only erased a few pixels on the existing wall at weak levels.
  float vents = line(first - (.11 + uHigh * .62 + uHat * .2), .012 + uHigh * .035) * smoothstep(0.0, .08, uHigh + uHat * .5);
  float matte = max(wall * holes, vents);
  gl_FragColor = vec4(vec3(matte), 1.0);
}`);
export const FIELD_PATTERNS = [
  entry('truchet-relay', 'Truchet Relay', 'Simple', 'Connected quarter-circle tracks: bass widens paths, mids reconnect tiles, highs separate inset rails; kicks pulse the path width, snares snap reconnections, hats flash the rails.', truchet, 'Tile Scale'),
  entry('membrane-modes', 'Membrane Modes', 'Rhythmic', 'Standing-wave nodal sand: bass bows the membrane, mids shear its nodal lattice, highs fracture fine lines; kicks punch the bow, snares snap the lattice, hats shiver the fracture.', membrane, 'Mode Scale', { accents: true }),
  entry('schlieren-flow', 'Schlieren Flow', 'Cinematic / Shaders', 'Refractive-density contours: bass warps the fluid, mids turn the density field, highs split fine ridges; kicks surge the warp, snares snap the turn, hats brighten the ridges.', schlieren, 'Flow Scale'),
  entry('tidal-glass', 'Tidal Glass', 'Cinematic / Shaders', 'Raymarched glass lobes: bass separates bodies, mids lift and turn the upper lobe, highs corrugate the glass surface; kicks push the lobes apart, snares snap the lift, hats shimmer the corrugation.', tidalGlass, 'Surface Frequency'),
  entry('bitplane-rewire', 'Bitplane Rewire', 'Glitch / Effects', 'XOR address-plane corruption: bass grows address blocks, mids displace scanline addresses, highs rewire row strides; kicks swell the blocks, snares burst the displacement, hats reseed the strides.', bitplane, 'Address Density'),
  entry('stair-wipe', 'Stair Wipe', 'Basics', 'Stepped diagonal wipe: bass translates the reveal, mids turn its axis, highs unfold deeper staircase teeth; kicks punch the travel, snares snap the axis, hats tighten the teeth.', stairWipe, 'Step Count'),
  entry('cellular-gate', 'Cellular Gate', 'Alphas', 'Voronoi channel matte: bass dilates walls, mids move cell sites, highs punch internal apertures; kicks surge the dilation, snares jitter the sites, hats flicker the vents.', cellular, 'Cell Scale'),
];
