// Ten single-pass looks. Analytic shapes / short fixed loops only: no raymarch,
// feedback buffers, per-pixel JS, or resolution-dependent object counts.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';
import { BAND_PARAMS, bounded, reactiveEntry } from './band-reactive.js';

const HEADER = `${AUDIO_SHADER_HEADER}
  uniform float uPhase;
  uniform float uHue;
  uniform float uDetail;
  uniform float uWarp;
  vec3 palette(float shift) {
    return hsv2rgb(vec3(fract(uHue + shift + uHigh * 0.075), 0.8, 1.0));
  }
  float lineGlow(float distance, float width) {
    return exp(-abs(distance) / max(width, 0.001));
  }
  vec2 screenPoint() {
    return (vTexCoord - 0.5) * vec2(uResolution.x / max(1.0, uResolution.y), 1.0) * 2.0;
  }
  void finishColor(vec3 color) {
    gl_FragColor = vec4(filmicTone(color * (1.2 + uHigh * 0.6)), 1.0);
  }
`;

const LOOKS = [
  {
    id: 'beat-weave', name: 'Beat Weave', group: 'Rhythmic', detail: 'Weave Density',
    description: 'Interlaced ribbons: bass opens the weave, mids bend it, highs change its light.',
    body: `
      vec2 p = screenPoint();
      float a = sin(p.x * uDetail + sin(p.y * 3.0 + uPhase) * (uWarp + uMid));
      float b = sin(p.y * uDetail - uPhase * 2.0 + sin(p.x * 2.0) * uMid);
      float width = 0.04 + uSub * 0.1;
      vec3 col = palette(p.y * 0.1) * lineGlow(a, width);
      col += palette(0.45 + p.x * 0.1) * lineGlow(b, width);
      finishColor(col);
    `,
  },
  {
    id: 'ripple-lattice', name: 'Ripple Lattice', group: 'Rhythmic', detail: 'Lattice Density',
    description: 'Synchronized tiled ripples: bass expands rings, mids offset their rhythm, highs tint them.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.45;
      vec2 cell = floor(p);
      vec2 q = fract(p) - 0.5;
      float wave = sin(length(q) * (18.0 + uWarp * 6.0) - uPhase * 4.0
        - uSub * 3.0 + sin(cell.x + cell.y) * uMid * 3.0);
      float ring = lineGlow(wave, 0.15 + uSub * 0.12);
      finishColor(palette((cell.x + cell.y) * 0.035) * ring);
    `,
  },
  {
    id: 'polygon-tunnel', name: 'Polygon Tunnel', group: '3D', detail: 'Tunnel Sides',
    description: 'An endless polygon tunnel: bass pumps depth, mids twist it, highs illuminate the ribs.',
    body: `
      vec2 p = rotate2d(uPhase * 0.12 + uMid * 0.2) * screenPoint();
      float radius = max(length(p), 0.015);
      float angle = atan(p.y, p.x);
      float sector = VIZ_TAU / max(3.0, floor(uDetail));
      float polygon = radius * cos(mod(angle + sector * 0.5, sector) - sector * 0.5);
      float depth = -log(max(polygon, 0.01)) * (3.0 + uWarp);
      float ring = abs(fract(depth - uPhase * 1.2 - uSub * 0.5) - 0.5);
      float ribs = abs(sin(angle * max(3.0, floor(uDetail)) * 0.5));
      vec3 col = palette(depth * 0.07) * lineGlow(ring, 0.025 + uSub * 0.015);
      col += palette(0.4) * lineGlow(ribs, 0.025) * 0.5;
      finishColor(col * smoothstep(0.015, 0.12, radius));
    `,
  },
  {
    id: 'orbital-cages', name: 'Orbital Cages', group: '3D', detail: 'Orbit Count',
    description: 'Tilted orbital wire rings: bass expands the cage, mids change its tilt, highs color the edges.',
    body: `
      vec2 p = screenPoint() / (0.85 + uSub * 0.12);
      vec3 col = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        vec2 q = rotate2d(fi * 0.36 + uPhase * 0.3) * p;
        float tilt = 0.3 + abs(sin(fi * 0.6 + uPhase * 0.2 + uMid * 0.4)) * 0.7;
        float ring = length(q * vec2(1.0, 1.0 / tilt)) - (0.38 + fi * 0.045);
        col += palette(fi * 0.06) * lineGlow(ring, 0.003 + uWarp * 0.005);
      }
      finishColor(col);
    `,
  },
  {
    id: 'silk-flow', name: 'Silk Flow', group: 'Cinematic / Shaders', detail: 'Silk Folds',
    description: 'Iridescent flowing silk: bass lifts folds, mids curl the fabric, highs reveal highlights.',
    body: `
      vec2 p = screenPoint();
      float fold = p.y + sin(p.x * 2.2 + uPhase * 0.7) * (0.3 + uSub * 0.25);
      fold += sin(p.x * 3.7 - uPhase * 0.5 + uMid) * uWarp * 0.2;
      float wave = sin(fold * uDetail + sin(p.x + uPhase) * uMid * 2.0);
      float sheen = pow(0.5 + 0.5 * wave, 6.0);
      vec3 col = palette(fold * 0.18) * (0.08 + sheen * 1.3);
      col += palette(0.45) * pow(1.0 - abs(wave), 18.0) * 0.5;
      finishColor(col);
    `,
  },
  {
    id: 'prism-caustics', name: 'Prism Caustics', group: 'Cinematic / Shaders', detail: 'Caustic Scale',
    description: 'Liquid refracted light: bass swells cells, mids distort ripples, highs split their colors.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.45 / (1.0 + uSub * 0.2);
      vec2 q = p + vec2(sin(p.y + uPhase), cos(p.x - uPhase * 0.8)) * (uWarp + uMid * 0.6);
      float caustic = abs(sin(q.x + sin(q.y)) * cos(q.y + cos(q.x)));
      vec3 col = palette(q.x * 0.04) * pow(1.0 - caustic, 12.0);
      col += palette(0.4 + q.y * 0.03) * pow(caustic, 8.0) * 0.7;
      finishColor(col);
    `,
  },
  {
    id: 'laser-fan', name: 'Laser Fan', group: 'Neon / Lasers', detail: 'Beam Count',
    description: 'Sweeping laser fans: bass opens the beams, mids sweep them, highs heat their cores.',
    body: `
      vec2 p = screenPoint();
      vec2 origin = vec2(sin(uPhase * 0.5) * 0.45, -0.8);
      vec2 q = p - origin;
      float a = atan(q.x, q.y) + sin(uPhase) * 0.2 + uMid * 0.2;
      float beams = sin(a * uDetail * (1.0 + uSub * 0.15));
      float glow = lineGlow(beams, 0.025 + uWarp * 0.025);
      float fade = 1.0 / (1.0 + length(q) * 0.7);
      finishColor(palette(a * 0.15) * glow * fade * 2.0);
    `,
  },
  {
    id: 'neon-hex', name: 'Neon Hex', group: 'Neon / Lasers', detail: 'Hex Density',
    description: 'Pulsing neon honeycomb: bass opens cell cores, mids send waves, highs energize outlines.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.5;
      vec2 grid = vec2(1.7320508, 3.0);
      vec2 a = mod(p, grid) - grid * 0.5;
      vec2 b = mod(p - grid * 0.5, grid) - grid * 0.5;
      vec2 q = dot(a, a) < dot(b, b) ? a : b;
      float hex = max(abs(q.x), abs(q.x) * 0.5 + abs(q.y) * 0.8660254);
      float rim = lineGlow(hex - 0.8, 0.025 + uSub * 0.035);
      float wave = 0.55 + 0.45 * sin(length(p) * uWarp - uPhase * 3.0 + uMid * 3.0);
      finishColor(palette(length(p) * 0.025) * rim * (0.35 + wave));
    `,
  },
  {
    id: 'data-rain', name: 'Data Rain', group: 'Glitch / Effects', detail: 'Data Columns',
    description: 'Falling digital glyphs: bass lengthens streams, mids scramble glyphs, highs brighten heads.',
    body: `
      vec2 p = vTexCoord * vec2(uDetail * 2.0, uDetail * 1.5);
      vec2 cell = floor(p);
      vec2 q = fract(p);
      float rate = 0.5 + hash11(cell.x) * (1.0 + uWarp);
      float head = fract(cell.y / (uDetail * 1.5) + uPhase * rate * 0.2 + hash11(cell.x));
      float tail = pow(head, max(1.0, 6.0 - uSub * 2.0));
      float glyph = step(0.4, hash21(cell + floor(uPhase * 4.0 + uMid * 7.0)));
      float mask = step(0.2, q.x) * (1.0 - step(0.8, q.x)) * step(0.15, q.y) * (1.0 - step(0.85, q.y));
      finishColor(palette(cell.x * 0.006) * tail * (0.15 + glyph) * mask * 2.0);
    `,
  },
  {
    id: 'signal-tear', name: 'Signal Tear', group: 'Glitch / Effects', detail: 'Signal Bands',
    description: 'Broken neon signal: bass tears strips, mids bend interference, highs split color channels.',
    body: `
      vec2 p = screenPoint();
      float strip = floor(p.y * uDetail);
      float jitter = (hash11(strip + floor(uPhase * 8.0)) - 0.5) * (0.03 + uSub * 0.45) * uWarp;
      p.x += jitter;
      float wave = sin(p.x * 6.0 + sin(p.y * 4.0 + uPhase) * (1.0 + uMid));
      float split = 0.03 + uHigh * 0.15;
      vec3 col = vec3(lineGlow(wave - split, 0.09), lineGlow(wave, 0.09), lineGlow(wave + split, 0.09));
      col *= palette(strip * 0.025) + 0.3;
      finishColor(col * (0.65 + 0.35 * sin(p.y * uDetail * 5.0)));
    `,
  },
  // Second wave: four more looks per lightweight group.
  {
    id: 'pulse-grid', name: 'Pulse Grid', group: 'Rhythmic', detail: 'Cell Count',
    description: 'Flashing light cells: bass grows the dots, mids scan the flash order, highs spark the peaks.',
    body: `
      vec2 p = vTexCoord * vec2(uDetail, uDetail * 0.6);
      vec2 cell = floor(p);
      vec2 q = fract(p) - 0.5;
      float seq = hash21(cell);
      float flash = pow(0.5 + 0.5 * sin(uPhase * 4.0 + seq * 6.2831 + cell.x * 0.5 + uMid * 2.0), 4.0);
      float dot2 = lineGlow(length(q) - 0.16 * (1.0 + uSub * 0.7), 0.05 + uWarp * 0.05);
      vec3 col = palette(seq * 0.1) * dot2 * (0.30 + flash * (0.45 + uSub * 0.6));
      col += palette(0.4) * uHigh * pow(flash, 8.0) * dot2;
      finishColor(col);
    `,
  },
  {
    id: 'wave-stack', name: 'Wave Stack', group: 'Rhythmic', detail: 'Ribbon Count',
    description: 'Stacked waveform ribbons: bass lifts the amplitude, mids detune each line, highs brighten the traces.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        float y = -0.75 + fi * (1.5 / max(1.0, uDetail - 1.0));
        float wave = sin(p.x * (3.0 + fi * 0.35) + uPhase * 2.0 + fi * 0.7 + uMid * 2.5) * (0.06 + uSub * 0.14);
        float d = p.y - y * 0.8 - wave;
        col += palette(fi * 0.07) * lineGlow(d, 0.006 + uWarp * 0.008 + uHigh * 0.010);
      }
      finishColor(col);
    `,
  },
  {
    id: 'beat-orbit', name: 'Beat Orbit', group: 'Rhythmic', detail: 'Orbiter Count',
    description: 'A ring of pulsing orbiters: bass pumps the radius, mids slosh the orbit, highs streak the guide ring.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      float radius = 0.55 + uSub * 0.25;
      for (int i = 0; i < 16; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        float a = fi * 6.2831 / max(1.0, uDetail) + uPhase * 1.5 + uMid * 0.8;
        vec2 c = vec2(cos(a), sin(a)) * radius;
        float glow = lineGlow(length(p - c) - 0.02, 0.012 + uWarp * 0.012);
        col += palette(fi * 0.05) * glow * (0.5 + 0.5 * sin(fi + uPhase * 6.0));
      }
      col += palette(0.5) * lineGlow(length(p) - radius, 0.004 + uHigh * 0.008) * 0.6;
      finishColor(col);
    `,
  },
  {
    id: 'level-blocks', name: 'Level Blocks', group: 'Rhythmic', detail: 'Column Count',
    description: 'A chunky level meter: bass drives the column heights, mids tint the rows, highs trace the peaks.',
    body: `
      vec2 p = vTexCoord;
      float column = floor(p.x * uDetail);
      vec2 q = vec2(fract(p.x * uDetail), p.y);
      float level = 0.30 + 0.25 * sin(column * 1.7 + uPhase * 3.0) + uSub * 0.35;
      float on = step(q.y, level);
      float row = floor(q.y * 12.0);
      float gap = step(0.08, fract(q.y * 12.0)) * step(0.05, q.x) * (1.0 - step(0.95, q.x));
      float shade = 0.35 + 0.65 * (row / 12.0);
      vec3 col = palette(row * 0.02 + uMid * 0.1) * on * gap * shade;
      col += palette(0.45) * lineGlow(q.y - level, 0.010 + uWarp * 0.010 + uHigh * 0.015);
      finishColor(col);
    `,
  },
  {
    id: 'helix-tower', name: 'Helix Tower', group: '3D', detail: 'Helix Turns',
    description: 'Twin strands spiralling upward: bass widens the sway, mids twist the helix, highs light the rungs.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      for (int i = 0; i < 10; i++) {
        float fi = float(i);
        float y = -0.8 + fi * 0.18;
        float sway = sin(uPhase + fi * (1.1 - uDetail * 0.05) + uMid) * (0.35 + uSub * 0.2);
        vec2 c1 = vec2(sway, y);
        vec2 c2 = vec2(-sway, y);
        col += palette(fi * 0.06) * lineGlow(length(p - c1) - 0.015, 0.010 + uWarp * 0.008);
        col += palette(fi * 0.06 + 0.5) * lineGlow(length(p - c2) - 0.015, 0.010 + uWarp * 0.008);
        float rung = lineGlow(p.y - y, 0.004 + uHigh * 0.006)
          * (1.0 - smoothstep(0.0, abs(sway) + 0.02, abs(p.x)));
        col += palette(0.3) * rung * 0.5;
      }
      finishColor(col);
    `,
  },
  {
    id: 'perspective-floor', name: 'Perspective Floor', group: '3D', detail: 'Grid Density',
    description: 'A receding grid floor under a glowing sun: bass scrolls the grid, mids move the horizon, highs thicken the lines.',
    body: `
      vec2 p = screenPoint();
      float horizon = 0.12 + uMid * 0.15;
      vec3 col = palette(0.6) * lineGlow(p.y - horizon, 0.010 + uWarp * 0.010) * 0.8;
      if (p.y < horizon) {
        float depth = horizon - p.y;
        float z = 0.18 / max(depth, 0.02);
        vec2 g = vec2(p.x * z * uDetail * 0.35, z * 2.0 - uPhase * 3.0 - uSub * 1.5);
        vec2 grid = abs(fract(g) - 0.5);
        float lines = lineGlow(min(grid.x, grid.y), 0.035 + uHigh * 0.030);
        float fade = smoothstep(0.0, 0.25, depth);
        col += palette(z * 0.03) * lines * fade;
      }
      float sun = lineGlow(length(p - vec2(0.0, horizon + 0.28)) - 0.18 * (1.0 + uSub * 0.3), 0.02);
      col += palette(0.9) * sun * 0.7;
      finishColor(col);
    `,
  },
  {
    id: 'gyro-rings', name: 'Gyro Rings', group: '3D', detail: 'Ring Count',
    description: 'A nested gyroscope: bass expands the gimbal, mids tumble each ring, highs sharpen the metal edges.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        float tilt = sin(uPhase * 0.7 + fi * 0.9 + uMid * 1.2) * 0.85;
        float r = 0.22 + fi * 0.09 * (1.0 + uSub * 0.25);
        float d = length(p * vec2(1.0, 1.0 / max(0.18, abs(tilt)))) - r;
        col += palette(fi * 0.09) * lineGlow(d, 0.004 + uWarp * 0.006 + uHigh * 0.006);
      }
      finishColor(col);
    `,
  },
  {
    id: 'depth-frames', name: 'Depth Frames', group: '3D', detail: 'Frame Count',
    description: 'A fly-through of square frames: bass pushes the travel, mids rotate the corridor, highs etch the frames.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        float z = fract(fi / max(1.0, uDetail) + uPhase * 0.25 + uSub * 0.20);
        float scale = mix(1.4, 0.06, z);
        vec2 q = rotate2d(z * 0.6 + uMid * 0.4) * (p / scale);
        vec2 d = abs(q) - vec2(0.8);
        float frame = lineGlow(max(d.x, d.y), (0.003 + uHigh * 0.004) / scale);
        col += palette(z * 0.5 + uWarp * 0.1) * frame * (1.0 - z);
      }
      finishColor(col);
    `,
  },
  {
    id: 'ember-drift', name: 'Ember Drift', group: 'Cinematic / Shaders', detail: 'Ember Density',
    description: 'Rising embers over coals: bass feeds the fire, mids stir the flicker, highs white-heat the sparks.',
    body: `
      vec2 p = vTexCoord * vec2(uResolution.x / max(1.0, uResolution.y), 1.0) * uDetail * 0.5;
      vec2 cell = floor(p);
      vec2 q = fract(p) - 0.5;
      float seed = hash21(cell);
      vec2 drift = vec2(sin(uPhase + seed * 6.2831), cos(uPhase * 0.8 + seed * 12.0)) * 0.3;
      float ember = lineGlow(length(q - drift) - 0.05 * (0.5 + seed), 0.02 + uWarp * 0.02);
      float flicker = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(uPhase * 5.0 + seed * 40.0 + uMid * 3.0), 3.0);
      vec3 col = palette(seed * 0.06) * ember * (0.35 + flicker) * (0.5 + uSub * 0.8);
      col += vec3(1.0, 0.9, 0.75) * ember * uHigh * 0.35;
      finishColor(col);
    `,
  },
  {
    id: 'velvet-fog', name: 'Velvet Fog', group: 'Cinematic / Shaders', detail: 'Fog Scale',
    description: 'Layered velvet fog banks: bass swells the banks, mids steer the current, highs silver the wisps.',
    body: `
      vec2 p = screenPoint();
      vec2 q = p * (0.6 + uDetail * 0.08) * (0.6 + uWarp * 0.6);
      float f1 = fbm4(q + vec2(uPhase * 0.15, uMid * 0.5));
      float f2 = fbm4(q * 1.7 - vec2(uPhase * 0.10, f1 * 0.8));
      float fog = smoothstep(0.25, 0.95, f1 * 0.6 + f2 * 0.55);
      vec3 col = palette(f2 * 0.25) * fog * (0.35 + uSub * 0.45);
      col += palette(0.5 + f1 * 0.1) * pow(f2, 6.0) * (0.3 + uHigh * 0.7);
      finishColor(col);
    `,
  },
  {
    id: 'prism-flare', name: 'Prism Flare', group: 'Cinematic / Shaders', detail: 'Flare Streaks',
    description: 'Anamorphic lens flares: bass fattens the streaks, mids rotate the fan, highs ignite the core.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      float streaks = max(2.0, floor(uDetail * 0.5));
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        if (fi >= streaks) break;
        float a = fi * 3.14159 / streaks + uMid * 0.3;
        vec2 dir = vec2(cos(a), sin(a));
        float d = abs(dot(p, vec2(-dir.y, dir.x)));
        float along = dot(p, dir);
        float streak = lineGlow(d, 0.004 + uSub * 0.012 + uWarp * 0.006)
          * (1.0 - smoothstep(0.0, 1.2, abs(along)));
        col += palette(fi * 0.08) * streak;
      }
      col += vec3(1.0) * lineGlow(length(p), 0.05 + uHigh * 0.05) * 0.5;
      finishColor(col);
    `,
  },
  {
    id: 'molten-glass', name: 'Molten Glass', group: 'Cinematic / Shaders', detail: 'Flow Scale',
    description: 'Slow molten glass currents: bass folds the flow, mids ripple the surface, highs glint the creases.',
    body: `
      vec2 p = screenPoint() * (0.8 + uDetail * 0.1);
      vec2 q = p + vec2(fbm4(p + uPhase * 0.2), fbm4(p.yx - uPhase * 0.15)) * (0.6 + uWarp * 0.5 + uMid * 0.4);
      float bands = sin(q.x * 2.0 + sin(q.y * 1.5) * 2.0);
      float bands2 = sin(q.y * 1.7 + sin(q.x * 1.3 + uSub) * 2.0);
      vec3 col = palette(bands * 0.08) * pow(0.5 + 0.5 * bands, 3.0);
      col += palette(0.45 + bands2 * 0.06) * pow(0.5 + 0.5 * bands2, 5.0) * 0.8;
      col += vec3(1.0) * pow(abs(bands * bands2), 24.0) * uHigh;
      finishColor(col);
    `,
  },
  {
    id: 'laser-harp', name: 'Laser Harp', group: 'Neon / Lasers', detail: 'String Count',
    description: 'A harp of laser strings: bass plucks the strings, mids shift their color, highs heat the beams.',
    body: `
      vec2 p = vTexCoord;
      vec3 col = vec3(0.0);
      float n = max(2.0, floor(uDetail));
      float aspect = uResolution.x / max(1.0, uResolution.y);
      for (int i = 0; i < 16; i++) {
        float fi = float(i);
        if (fi >= n) break;
        float x = (fi + 0.5) / n;
        float pluck = sin(p.y * 9.0 + uPhase * 6.0 + fi * 1.3) * (0.002 + uSub * 0.020);
        float d = (p.x - x + pluck) * aspect;
        float beam = lineGlow(d, 0.0015 + uWarp * 0.002 + uHigh * 0.002);
        float fade = smoothstep(0.0, 0.12, p.y) * (1.0 - smoothstep(0.85, 1.0, p.y));
        col += palette(fi * 0.05 + uMid * 0.08) * beam * (0.35 + fade);
      }
      finishColor(col);
    `,
  },
  {
    id: 'neon-frame', name: 'Neon Frame', group: 'Neon / Lasers', detail: 'Frame Layers',
    description: 'Concentric flickering neon frames: bass pumps the tubes, mids shift the sign color, highs arc a center line.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      float aspect = uResolution.x / max(1.0, uResolution.y);
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        if (fi >= uDetail) break;
        float inset = 0.22 + fi * 0.16;
        vec2 d = abs(p) - vec2(inset * aspect * 0.55, inset);
        float edge = max(d.x, d.y);
        float flicker = 0.6 + 0.4 * sin(uPhase * 7.0 + fi * 2.1 + hash11(fi + 3.0) * 6.0);
        col += palette(fi * 0.07 + uMid * 0.1) * lineGlow(edge, 0.006 + uSub * 0.008 + uWarp * 0.004) * flicker;
      }
      col += palette(0.5) * lineGlow(abs(p.y) - 0.02, 0.004) * uHigh * 0.4;
      finishColor(col);
    `,
  },
  {
    id: 'beam-cascade', name: 'Beam Cascade', group: 'Neon / Lasers', detail: 'Beam Count',
    description: 'Crossing beams from the top corners: bass sweeps the fan, mids sway it, highs charge the light.',
    body: `
      vec2 p = screenPoint();
      vec3 col = vec3(0.0);
      float n = max(2.0, floor(uDetail * 0.5));
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        if (fi >= n) break;
        float side = mod(fi, 2.0) * 2.0 - 1.0;
        vec2 origin = vec2(side * 1.2, 0.95);
        float a = atan(p.x - origin.x, origin.y - p.y);
        float spread = (fi / n - 0.5) * 1.1 + sin(uPhase * 0.9 + fi + uMid * 1.5) * (0.15 + uSub * 0.25);
        float beam = lineGlow(a - spread, 0.006 + uWarp * 0.010);
        float fade = 1.0 - smoothstep(0.0, 1.9, length(p - origin));
        col += palette(fi * 0.09) * beam * fade * (0.9 + uHigh * 0.7);
      }
      finishColor(col);
    `,
  },
  {
    id: 'circuit-pulse', name: 'Circuit Pulse', group: 'Neon / Lasers', detail: 'Trace Density',
    description: 'Circuit traces firing in waves: bass surges the nodes, mids recolor the board, highs speed the pulses.',
    body: `
      vec2 p = vTexCoord * vec2(uDetail, uDetail * 0.7);
      vec2 cell = floor(p);
      vec2 q = fract(p);
      float dir = step(0.5, hash21(cell));
      float trace = dir < 0.5
        ? lineGlow(q.y - 0.5, 0.04 + uWarp * 0.03)
        : lineGlow(q.x - 0.5, 0.04 + uWarp * 0.03);
      float node = lineGlow(length(q - 0.5) - 0.08, 0.03);
      float pulse = pow(0.5 + 0.5 * sin(uPhase * (3.0 + uHigh * 4.0) - (cell.x + cell.y) * 0.9), 6.0);
      vec3 col = palette((cell.x + cell.y) * 0.02) * (trace * 0.4 + node * (0.2 + pulse * (0.5 + uSub)));
      col += palette(0.45 + uMid * 0.1) * trace * pulse * 0.8;
      finishColor(col);
    `,
  },
  {
    id: 'pixel-sort', name: 'Pixel Sort', group: 'Glitch / Effects', detail: 'Sort Rows',
    description: 'Smears of sorted streaks: bass drags the rows, mids stretch the smear, highs rim the streaks.',
    body: `
      vec2 p = vTexCoord;
      float row = floor(p.y * uDetail);
      float seed = hash11(row + floor(uPhase * 3.0));
      float shift = pow(seed, 3.0) * uWarp * (0.2 + uSub * 0.6) * (1.0 + uMid * 0.5);
      float x = fract(p.x + shift);
      float streak = sin(x * 40.0 + row * 3.0);
      vec3 col = palette(seed + row * 0.01) * (0.25 + 0.75 * step(0.0, streak));
      col *= 0.35 + 0.65 * step(0.2, x);
      col += vec3(lineGlow(streak, 0.2) * uHigh * 0.5);
      finishColor(col);
    `,
  },
  {
    id: 'vhs-tracking', name: 'VHS Tracking', group: 'Glitch / Effects', detail: 'Track Bands',
    description: 'Tracking-error bands: bass jumps the picture, mids wobble the lines, highs flash the track seams.',
    body: `
      vec2 p = vTexCoord;
      float band = floor(p.y * uDetail);
      float wobble = sin(p.y * 60.0 + uPhase * 8.0) * 0.002 * (1.0 + uMid);
      float jump = (hash11(band + floor(uPhase * 6.0)) - 0.5) * 0.05 * uWarp * (0.4 + uSub);
      float x = fract(p.x + wobble + jump);
      vec3 col = palette(band * 0.03) * (0.3 + 0.7 * hash21(vec2(band, floor(x * 30.0))));
      float seam = smoothstep(0.0, 0.06, abs(fract(p.y * uDetail) - 0.5));
      col *= 0.55 + 0.45 * seam;
      col += vec3(0.8, 0.9, 1.0) * (1.0 - seam) * uHigh * 0.6;
      finishColor(col);
    `,
  },
  {
    id: 'block-shift', name: 'Block Shift', group: 'Glitch / Effects', detail: 'Block Size',
    description: 'Datamosh-style displaced blocks: bass shoves the blocks, mids reseed the colors, highs flash rare cells.',
    body: `
      vec2 p = vTexCoord * uDetail;
      vec2 cell = floor(p);
      float t = floor(uPhase * 5.0);
      float r = hash21(cell + t);
      vec2 offset = (vec2(hash21(cell + t + 7.0), hash21(cell + t + 13.0)) - 0.5)
        * step(0.75, r) * uWarp * (0.3 + uSub);
      vec2 q = fract(p + offset) - 0.5;
      float block = lineGlow(max(abs(q.x), abs(q.y)) - 0.4, 0.05);
      vec3 col = palette(r * 0.2 + uMid * 0.12) * block * step(0.5, r);
      col += vec3(1.0) * step(0.92, r) * uHigh * block * 0.5;
      finishColor(col);
    `,
  },
  {
    id: 'interference', name: 'Interference', group: 'Glitch / Effects', detail: 'Wave Density',
    description: 'Colliding signal moire: bass drives the carrier, mids detune one wave, highs blow out the nodes.',
    body: `
      vec2 p = screenPoint() * uDetail * 0.3;
      float w1 = sin(p.x * 2.0 + uPhase * 3.0 + uMid * 2.0);
      float w2 = sin(p.y * 2.3 - uPhase * 2.0);
      float rings = sin(length(p) * 3.0 - uPhase * 4.0);
      float moire = w1 * w2 * rings;
      vec3 col = vec3(lineGlow(moire - 0.6, 0.08 + uWarp * 0.05), lineGlow(moire, 0.08), lineGlow(moire + 0.6, 0.08));
      col *= palette(length(p) * 0.02) * (0.5 + uSub * 0.5);
      col += vec3(0.9) * pow(abs(moire), 16.0) * uHigh * 0.5;
      finishColor(col);
    `,
  },
];

function factoryFor(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, _videoDeviceId, params = {}, runtimeContext = {}) => {
    let phase = 0;
    return makeAudioShader(audio, params, fragment, (P, bands, p, controls) => {
      const C = controls?.continuous || { bass: bands.sub, mid: bands.mid, high: bands.high };
      phase = (phase + bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1) * bounded(P.speed, 0.7, 0, 3)) % 10000;
      return {
        uSub: C.bass, uMid: C.mid, uHigh: C.high,
        uPhase: phase, uHue: bounded(P.hue, 0.55, 0, 1),
        uDetail: bounded(P.detail, 8, 3, 20), uWarp: bounded(P.warp, 0.7, 0, 2),
      };
    }, { audioControls: runtimeContext.audioControls, renderScale: 1 });
  };
}

export const LIGHTWEIGHT_PATTERNS = LOOKS.map(({ id, name, group, description, detail, body }) => reactiveEntry({
  id, name, group, description, factory: factoryFor(body),
  params: [
    { key: 'detail', label: detail, min: 3, max: id === 'orbital-cages' ? 12 : 20, step: 1, default: 8 },
    { key: 'warp', label: 'Shape / Spread', min: 0, max: 2, step: 0.05, default: 0.7 },
    { key: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.05, default: 0.7 },
    { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.55 },
    ...BAND_PARAMS,
  ],
}));
