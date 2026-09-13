// p5-compatible value noise: a shared random 4096-value lattice, cosine
// interpolation, four octaves and 0.5 amplitude falloff. Not gradient Perlin.
let noiseTable;
let noiseOctaves = 4;
let noiseFalloff = 0.5;
const cosineWeight = t => (1 - Math.cos(Math.PI * t)) / 2;
const mix = (a, b, t) => a + (b - a) * t;

export function noiseSeedValue(seed) {
  let state = seed == null ? (Math.random() * 4294967296) >>> 0 : seed >>> 0;
  noiseTable = Array.from({ length: 4096 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  });
}

export function noiseDetailValue(octaves, falloff) {
  if (octaves > 0) noiseOctaves = octaves;
  if (falloff > 0) noiseFalloff = falloff;
}

export function noiseValue(x = 0, y = 0, z = 0) {
  noiseTable ??= Array.from({ length: 4096 }, () => Math.random());
  x = Math.abs(x); y = Math.abs(y); z = Math.abs(z);
  let total = 0, amplitude = 0.5;
  for (let octave = 0; octave < noiseOctaves; octave += 1) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const wx = cosineWeight(x - ix), wy = cosineWeight(y - iy), wz = cosineWeight(z - iz);
    const index = ix + (iy << 4) + (iz << 8);
    const sample = offset => noiseTable[(index + offset) & 4095];
    const row = offset => mix(sample(offset), sample(offset + 1), wx);
    const plane = offset => mix(row(offset), row(offset + 16), wy);
    total += mix(plane(0), plane(256), wz) * amplitude;
    amplitude *= noiseFalloff;
    x *= 2; y *= 2; z *= 2;
  }
  return total;
}

export function randomValue(a, b) {
  if (Array.isArray(a)) return a[Math.floor(Math.random() * a.length)];
  if (a === undefined) return Math.random();
  if (b === undefined) return Math.random() * a;
  return Math.random() * (b - a) + a;
}

export function mapValue(value, start1, stop1, start2, stop2) {
  return start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1));
}

export function lerpValue(a, b, t) {
  return a + (b - a) * t;
}

export function constrainValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function distValue(...args) {
  if (args.length === 4) {
    const [x1, y1, x2, y2] = args;
    return Math.hypot(x2 - x1, y2 - y1);
  }
  if (args.length === 6) {
    const [x1, y1, z1, x2, y2, z2] = args;
    return Math.hypot(x2 - x1, y2 - y1, z2 - z1);
  }
  return 0;
}

export function magValue(x, y) {
  return y === undefined ? Math.abs(x) : Math.hypot(x, y);
}
