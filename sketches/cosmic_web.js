// Cosmic Web — plexus constellation (GPU fragment-shader port)
// Keeps the identical CPU node simulation (parallax drift, kick scatter, depth)
// and renders via a full-screen fragment shader for the O(n²) line bottleneck.
// Visual outcome, colors, additive blending and audio mappings stay faithful to
// the CPU original; only the rasterization moves to the GPU.

import { makeAudioShader, AUDIO_SHADER_HEADER } from './shader-utils.js';

const MAX_NODES = 200;
const MAX_LINKS = 256;
const MAX_PULSES = 64;

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uNodeCount;
  uniform vec4 uNodes[200];
  uniform float uHueOffset;
  uniform float uLinkCount;
  uniform vec4 uLinkPos[256];
  uniform vec2 uLinkCol[256];
  uniform float uPulseCount;
  uniform vec4 uPulses[64];
  uniform vec4 uShootingStar;

  void main(){
    // p5 WEBGL texcoords: (0,0) top-left, (1,1) bottom-right so fragCoord matches canvas2D y-down
    vec2 fragCoord = vTexCoord * uResolution;

    vec3 color = vec3(0.0);

    // Nodes — additive 4-layer glow matching viz-utils glowCircle
    for(int i=0;i<200;i++){
      if(float(i) >= uNodeCount) break;
      vec4 nd = uNodes[i];
      vec2 npos = nd.xy;
      float nz = nd.z;
      float nhue = nd.w;
      float d = length(fragCoord - npos);
      float r = (1.5 + uSub * 5.0) * nz;
      if(d > r * 3.0 + 1.0) continue;
      float a = 0.35 + nz * 0.4 + uEnergy * 0.3;
      float h = mod(uHueOffset + nhue, 360.0) / 360.0;
      float R; float m;
      R = r * 3.0;
      m = 1.0 - smoothstep(R - 1.0, R + 1.0, d);
      if(m > 0.001) color += hsv2rgb(vec3(h, 0.75, 0.95)) * (16.0 * a / 255.0) * m;
      R = r * 1.6;
      m = 1.0 - smoothstep(R - 1.0, R + 1.0, d);
      if(m > 0.001) color += hsv2rgb(vec3(h, 0.75, 0.95)) * (32.0 * a / 255.0) * m;
      R = r * 0.8;
      m = 1.0 - smoothstep(R - 0.9, R + 0.9, d);
      if(m > 0.001) color += hsv2rgb(vec3(h, 0.375, 1.0)) * (90.0 * a / 255.0) * m;
      R = r * 0.4;
      m = 1.0 - smoothstep(R - 0.8, R + 0.8, d);
      if(m > 0.001) color += hsv2rgb(vec3(h, 0.15, 1.0)) * (200.0 * a / 255.0) * m;
    }

    // Links — precomputed on CPU, additive thin lines (strokeWeight 0.8)
    for(int i=0;i<256;i++){
      if(float(i) >= uLinkCount) break;
      vec4 lp = uLinkPos[i];
      vec2 lc = uLinkCol[i];
      vec2 a = lp.xy;
      vec2 b = lp.zw;
      float h = lc.x;
      float alpha = lc.y;
      vec2 ab = b - a;
      float ab2 = dot(ab,ab);
      if(ab2 < 0.5) continue;
      float t = dot(fragCoord - a, ab) / ab2;
      if(t < 0.0 || t > 1.0) continue;
      vec2 closest = a + ab * t;
      float dline = length(fragCoord - closest);
      if(dline > 1.2) continue;
      float lineMask = 1.0 - smoothstep(0.35, 0.85, dline);
      color += hsv2rgb(vec3(h, 0.75, 0.90)) * alpha * lineMask;
    }

    // traveling light pulses (same 4-layer glow as nodes, r=2.5, sat 50)
    for(int i=0;i<64;i++){
      if(float(i) >= uPulseCount) break;
      vec4 pl = uPulses[i];
      vec2 ppos = pl.xy;
      float ph = pl.z / 360.0;
      float pa = pl.w;
      float d = length(fragCoord - ppos);
      float r = 2.5;
      if(d > r * 3.0 + 1.0) continue;
      float R; float m;
      R = r * 3.0;
      m = 1.0 - smoothstep(R - 1.0, R + 1.0, d);
      if(m > 0.001) color += hsv2rgb(vec3(ph, 0.50, 1.0)) * (16.0 * pa / 255.0) * m;
      R = r * 1.6;
      m = 1.0 - smoothstep(R - 1.0, R + 1.0, d);
      if(m > 0.001) color += hsv2rgb(vec3(ph, 0.50, 1.0)) * (32.0 * pa / 255.0) * m;
      R = r * 0.8;
      m = 1.0 - smoothstep(R - 0.9, R + 0.9, d);
      if(m > 0.001) color += hsv2rgb(vec3(ph, 0.25, 1.0)) * (90.0 * pa / 255.0) * m;
      R = r * 0.4;
      m = 1.0 - smoothstep(R - 0.8, R + 0.8, d);
      if(m > 0.001) color += hsv2rgb(vec3(ph, 0.10, 1.0)) * (200.0 * pa / 255.0) * m;
    }

    // shooting star (white circle, diameter sr)
    if(uShootingStar.w > 0.5){
      vec2 spos = uShootingStar.xy;
      float sr = uShootingStar.z;
      float d = length(fragCoord - spos);
      float radius = sr * 0.5;
      float m = 1.0 - smoothstep(radius - 0.7, radius + 0.7, d);
      color += vec3(1.0) * (240.0 / 255.0) * m;
    }

    // vignette — port of viz-utils vignette(p,0.5)
    vec2 center = uResolution * 0.5;
    float dist = length(fragCoord - center);
    float inner = min(uResolution.x, uResolution.y) * 0.25;
    float outer = max(uResolution.x, uResolution.y) * 0.675;
    float vt = smoothstep(inner, outer, dist);
    color *= 1.0 - vt * 0.5;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => {
  const nodes = [];
  const pulses = [];
  let hueOffset = 0;
  let prevSub = 0;

  function ensureNodes(n, pInst) {
    while (nodes.length < n) {
      nodes.push({
        x: pInst.random(pInst.width),
        y: pInst.random(pInst.height),
        vx: pInst.random(-0.4, 0.4),
        vy: pInst.random(-0.4, 0.4),
        z: pInst.random(0.4, 1),
        hue: pInst.random(360),
      });
    }
    nodes.length = Math.min(nodes.length, n);
  }

  return makeAudioShader(audio, params, frag, (P, bands, p) => {
    const count = Math.floor(P.nodes ?? 90);
    const linkBase = P.link ?? 130;
    const scatter = P.scatter ?? 1;
    const drift = P.drift ?? 1;

    const energy = bands.energy;
    const sub = bands.sub;
    const mid = bands.mid;
    const high = bands.high;

    hueOffset = (hueOffset + 0.25 + energy * 1.5) % 360;
    ensureNodes(count, p);

    const kicked = sub > 0.4 && sub > prevSub + 0.03;
    prevSub = sub;

    const linkDist = linkBase * (1 + mid * 0.6);
    const cx = p.width / 2;
    const cy = p.height / 2;

    for (const nd of nodes) {
      nd.x += nd.vx * drift * (0.4 + energy) * nd.z;
      nd.y += nd.vy * drift * (0.4 + energy) * nd.z;
      if (kicked) {
        const dx = nd.x - cx, dy = nd.y - cy;
        const d = Math.hypot(dx, dy) + 1;
        nd.vx += (dx / d) * sub * 2.4 * scatter;
        nd.vy += (dy / d) * sub * 2.4 * scatter;
      }
      nd.vx *= 0.985;
      nd.vy *= 0.985;
      if (nd.x < -20) nd.x = p.width + 20;
      if (nd.x > p.width + 20) nd.x = -20;
      if (nd.y < -20) nd.y = p.height + 20;
      if (nd.y > p.height + 20) nd.y = -20;
    }

    // precompute links for GPU — same pair logic as CPU
    const linkPos = new Array(MAX_LINKS * 4).fill(0);
    const linkCol = new Array(MAX_LINKS * 2).fill(0);
    let linkCount = 0;
    for (let i = 0; i < nodes.length && linkCount < MAX_LINKS; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length && linkCount < MAX_LINKS; j++) {
        const c = nodes[j];
        const dx = a.x - c.x, dy = a.y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < linkDist * linkDist) {
          const d = Math.sqrt(d2);
          const alpha = (1 - d / linkDist) * (50 + energy * 150) / 255;
          const hue = (hueOffset + (a.hue + c.hue) / 2) % 360 / 360;
          const idx4 = linkCount * 4;
          linkPos[idx4 + 0] = a.x;
          linkPos[idx4 + 1] = a.y;
          linkPos[idx4 + 2] = c.x;
          linkPos[idx4 + 3] = c.y;
          const idx2 = linkCount * 2;
          linkCol[idx2 + 0] = hue;
          linkCol[idx2 + 1] = alpha;
          linkCount++;

          if (kicked && p.random() < 0.06) {
            pulses.push({ x1: a.x, y1: a.y, x2: c.x, y2: c.y, t: 0, hue: (hueOffset + (a.hue + c.hue) / 2) % 360 });
            if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES);
          }
        }
      }
    }
    // If not kicked we didn't spawn pulses above; kicked already handled inside loop
    // Integrate pulse spawn when no link? nothing.

    for (let i = pulses.length - 1; i >= 0; i--) {
      const pl = pulses[i];
      pl.t += 0.06 + energy * 0.1;
      if (pl.t >= 1) pulses.splice(i, 1);
    }

    let shooting = [0, 0, 0, 0];
    if (high > 0.35 && p.random() < high * 0.1 && nodes.length > 1) {
      const a = nodes[Math.floor(p.random(nodes.length))];
      const c = nodes[Math.floor(p.random(nodes.length))];
      const tt = p.random();
      const x = a.x + (c.x - a.x) * tt;
      const y = a.y + (c.y - a.y) * tt;
      const r = 2 + high * 3;
      shooting = [x, y, r, 1];
    }

    const nodeData = new Array(MAX_NODES * 4).fill(0);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      nodeData[i * 4 + 0] = nd.x;
      nodeData[i * 4 + 1] = nd.y;
      nodeData[i * 4 + 2] = nd.z;
      nodeData[i * 4 + 3] = nd.hue;
    }

    const pulseData = new Array(MAX_PULSES * 4).fill(0);
    for (let i = 0; i < pulses.length; i++) {
      const pl = pulses[i];
      const x = pl.x1 + (pl.x2 - pl.x1) * pl.t;
      const y = pl.y1 + (pl.y2 - pl.y1) * pl.t;
      const a = 1 - pl.t;
      pulseData[i * 4 + 0] = x;
      pulseData[i * 4 + 1] = y;
      pulseData[i * 4 + 2] = pl.hue;
      pulseData[i * 4 + 3] = a;
    }

    return {
      uNodeCount: nodes.length,
      uNodes: nodeData,
      uHueOffset: hueOffset,
      uLinkCount: linkCount,
      uLinkPos: linkPos,
      uLinkCol: linkCol,
      uPulseCount: pulses.length,
      uPulses: pulseData,
      uShootingStar: shooting,
    };
  });
};
