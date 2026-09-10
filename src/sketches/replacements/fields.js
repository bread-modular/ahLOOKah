// Each field implements a different construction, not a switch in a common look.
import { entry, shaderFactory } from './runtime.js';

const truchet = shaderFactory(`
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  vec2 grid = uv * (2.1 * uDetail) + vec2(uTime * uSpeed * .12, 0.0);
  grid.y += uMid * .6;
  vec2 cell = floor(grid), q = fract(grid);
  // Mid flips connectivity of entire tiles. Treble offsets paired inner tracks.
  if (hash21(cell) < .25 + uMid * .7) q.x = 1.0 - q.x;
  float d = min(abs(length(q) - .5), abs(length(q - 1.0) - .5));
  float outer = line(d, .06 + uSub * .15);
  float inner = line(d - .03 - uHigh * .19, .018);
  vec3 col = vec3(.015, .024, .04) + ink(.0) * outer * .76 + ink(.45) * inner * .8;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`);
const membrane = shaderFactory(`
void main() {
  vec2 p = (vTexCoord * 2.0 - 1.0); p.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed;
  // Two standing-wave eigenmodes. Audio changes nodal topology, not exposure.
  float x = p.x * (3.0 + uSub * 4.5) * uDetail;
  float y = p.y * (3.0 + uMid * 5.0) * uDetail;
  float f = cos(x + .12 * sin(t)) * cos(y) - cos(y * 1.6) * cos(x * .6);
  f += uHigh * .9 * sin(p.x * 17.0 + p.y * 11.0 + t);
  float nodes = exp(-abs(f) * 12.0);
  float sand = .55 + .45 * hash21(floor(vTexCoord * uResolution / 2.0));
  vec3 col = vec3(.01, .02, .03) + ink(.03) * nodes * sand + ink(.48) * line(f - .3, .035) * .45;
  gl_FragColor = vec4(col, 1.0);
}`);
const schlieren = shaderFactory(`
void main() {
  vec2 p = vTexCoord * 2.0 - 1.0; p.x *= uResolution.x / uResolution.y;
  float t = uTime * uSpeed * .3;
  // Domain-warped density with a knife-edge-like derivative accent.
  vec2 warp = vec2(fbm4(p * 1.8 + t), fbm4(p * 1.8 - t + 7.0));
  p += (warp - .5) * (1.1 + uSub * 3.8);
  p = rotate2d(uMid * 1.6) * p;
  float f = fbm4(p * (2.0 * uDetail) + vec2(t, -t));
  float contour = sin(f * (24.0 + uHigh * 45.0) + p.y * 2.0);
  float slope = fbm4(p * 2.0 + .035) - fbm4(p * 2.0 - .035);
  vec3 cold = ink(.0) * (.15 + .5 * f), hot = ink(.48);
  vec3 col = mix(cold, hot, smoothstep(.05, .9, contour)) * (.65 + slope * 2.0);
  col += vec3(.4, .6, .65) * pow(max(0.0, contour), 12.0) * .4;
  gl_FragColor = vec4(filmicTone(col * 1.65), 1.0);
}`);
const tidalGlass = shaderFactory(`
float softUnion(float a, float b) {
  float k = .32; float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * .25;
}
float glass(vec3 p) {
  float t = uTime * uSpeed * .4;
  p.xy = rotate2d(t + uMid * 1.7) * p.xy;
  float a = length(p - vec3(-.38 - uSub * .4, .05, 0.0)) - (.43 + uSub * .17);
  float b = length(p - vec3(.4, .12 + uMid * .5, .05)) - .48;
  float c = length(p - vec3(.05, -.42, .1)) - (.3 + uHigh * .35);
  return softUnion(softUnion(a, b), c) + sin(p.y * (12.0 * uDetail) + t) * uHigh * .04;
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
    col = mix(ink(.5) * .16, ink(.0) * .8, stripes) + fresnel * ink(.12) + spec * vec3(1.0);
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
  float t = floor(uTime * uSpeed * 6.0);
  vec2 address = floor(uv * (48.0 * uDetail + uSub * 110.0));
  float x = mod(address.x + floor(uMid * 57.0) + t, 256.0);
  float y = mod(address.y * (2.0 + floor(uHigh * 9.0)), 256.0);
  float v = xorByte(x * 3.0, y * 5.0);
  float mask = step(.45, v);
  vec3 col = mix(vec3(.018, .025, .04), ink(v * .45) * (.35 + .65 * v), mask);
  gl_FragColor = vec4(col, 1.0);
}`);
const stairWipe = shaderFactory(`
void main() {
  vec2 p = vTexCoord * 2.0 - 1.0;
  p = rotate2d(.4 + uMid * 1.9) * p;
  float steps = 5.0 * uDetail + uHigh * 22.0;
  float edge = floor(p.y * steps) / steps * .65 + sin(uTime * uSpeed * .5) * .08;
  float reveal = line(p.x - edge - (uSub - .2) * 1.5, .16 + uHigh * .09);
  gl_FragColor = vec4(ink(.0) * reveal, 1.0);
}`);
const cellular = shaderFactory(`
void main() {
  vec2 uv = vTexCoord * 2.0 - 1.0; uv.x *= uResolution.x / uResolution.y;
  vec2 p = uv * (2.0 * uDetail), cell = floor(p), f = fract(p);
  float first = 10.0, second = 10.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 offset = vec2(float(x), float(y)), id = cell + offset;
    vec2 site = .5 + (.14 + uMid * .32) * sin(vec2(hash21(id), hash21(id + 8.0)) * 6.28 + uTime * uSpeed * .3);
    float d = length(offset + site - f);
    if (d < first) { second = first; first = d; } else { second = min(second, d); }
  }
  // Distance-to-cell-edge matte; white channels thicken and independent internal
  // apertures open. Exact black remains available for the existing Alpha Blend.
  float wall = 1.0 - smoothstep(.035 + uSub * .27, .065 + uSub * .27, second - first);
  float holes = smoothstep(.09, .12, first);
  holes *= smoothstep(uHigh * 1.15 - .04, uHigh * 1.15 + .02, abs(sin(p.x * 5.0 + p.y * 3.0)));
  float matte = wall * holes;
  gl_FragColor = vec4(vec3(matte), 1.0);
}`);
export const FIELD_PATTERNS = [
  entry('truchet-relay', 'Truchet Relay', 'Simple', 'Connected quarter-circle tracks: bass widens paths, mids reconnect tiles, highs separate inset rails.', truchet, 'Tile Scale'),
  entry('membrane-modes', 'Membrane Modes', 'Rhythmic', 'Standing-wave nodal sand: bass and mids retune orthogonal modes; highs fracture the nodal lines.', membrane, 'Mode Scale'),
  entry('schlieren-flow', 'Schlieren Flow', 'Cinematic / Shaders', 'Refractive-density contours: bass warps the fluid, mids turn the density field, highs split fine ridges.', schlieren, 'Flow Scale'),
  entry('tidal-glass', 'Tidal Glass', 'Cinematic / Shaders', 'Raymarched glass lobes: bass separates bodies, mids lift and turn the upper lobe, highs grow the lower lobe and corrugations.', tidalGlass, 'Surface Frequency'),
  entry('bitplane-rewire', 'Bitplane Rewire', 'Glitch / Effects', 'XOR address-plane corruption: bass changes address scale, mids shift byte addresses, highs rewire row strides.', bitplane, 'Address Density'),
  entry('stair-wipe', 'Stair Wipe', 'Basics', 'Stepped diagonal wipe: bass translates the reveal, mids turn its axis, highs subdivide its staircase.', stairWipe, 'Step Count'),
  entry('cellular-gate', 'Cellular Gate', 'Alphas', 'Voronoi channel matte: bass dilates walls, mids move cell sites, highs punch internal apertures.', cellular, 'Cell Scale'),
];
