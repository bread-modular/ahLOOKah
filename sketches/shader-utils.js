// Shared full-screen GPU shader runtime for the premium audio-reactive effects.
// Each effect only supplies its fragment program and maps live panel parameters
// to uniforms; this module owns audio smoothing, a musical idle mode, sizing,
// and the full-screen WebGL draw call.
import { makeAudioFeatures } from './audio-features.js';

export const FULLSCREEN_VERT = `
  precision highp float;
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  varying vec2 vTexCoord;

  void main() {
    vTexCoord = aTexCoord;
    vec4 position = vec4(aPosition, 1.0);
    position.xy = position.xy * 2.0 - 1.0;
    gl_Position = position;
  }
`;

// Common GLSL helpers kept intentionally WebGL 1 / GLSL ES 1.00 compatible.
export const AUDIO_SHADER_HEADER = `
  precision highp float;
  varying vec2 vTexCoord;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uSub;
  uniform float uMid;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uKick;
  uniform float uSnare;
  uniform float uHat;
  uniform float uBeat;

  #define PI 3.141592653589793
  #define TAU 6.283185307179586

  float saturate(float x) {
    return clamp(x, 0.0, 1.0);
  }

  mat2 rotate2d(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
  }

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm4(vec2 p) {
    float f = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      f += a * valueNoise(p);
      p = rotate2d(0.57) * p * 2.03 + vec2(7.1, 3.7);
      a *= 0.5;
    }
    return f;
  }

  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
    rgb = rgb * rgb * (3.0 - 2.0 * rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
  }

  vec3 filmicTone(vec3 color) {
    color = max(color, 0.0);
    return 1.0 - exp(-color);
  }
`;

export function makeAudioShader(audio, params, fragmentSource, mapUniforms) {
  return (p) => {
    let effectShader;
    let elapsed = 0;
    const getFeatures = makeAudioFeatures();

    p.setup = () => {
      // A fixed 1x backing density keeps the heavier ray-marched looks smooth
      // at 1080p/4K while avoiding accidental 4x work on Retina projectors.
      p.pixelDensity(1);
      p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
      p.noStroke();
      effectShader = p.createShader(FULLSCREEN_VERT, fragmentSource);
    };

    p.draw = () => {
      const P = params || {};
      const deltaSeconds = Math.min(p.deltaTime || 16.667, 100) / 1000;
      elapsed += deltaSeconds;

      const frame = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
        ? audio.getAnalysisFrame()
        : null;
      const measured = getFeatures(frame, P, deltaSeconds);

      // Keep every effect stage-ready before an input is selected. The idle
      // loop includes the same kick/snare/hat vocabulary as live analysis, so
      // each visual still previews its real musical choreography.
      const bassGain = Math.max(0, P.bass ?? 1);
      const midGain = Math.max(0, P.mid ?? 1);
      const highGain = Math.max(0, P.high ?? 1);
      const punch = Math.max(0, P.punch ?? 1);
      const pulse = (rate, offset = 0, decay = 18) => {
        const phase = ((elapsed * rate + offset) % 1 + 1) % 1;
        return Math.exp(-phase * decay);
      };
      const rawKick = pulse(2.0);
      const idleKick = Math.min(1.4, rawKick * bassGain * punch);
      const idleSnare = Math.min(1.4, pulse(1.0, 0.5, 22) * midGain * punch);
      const idleHat = Math.min(1.4, pulse(4.0, 0.5, 28) * highGain * punch);
      const sway = 0.5 + 0.5 * Math.sin(elapsed * 1.37);
      const bands = frame
        ? measured
        : {
            sub: (0.14 + rawKick * 0.48) * bassGain,
            mid: (0.12 + sway * 0.14) * midGain,
            high: (0.08 + (1 - sway) * 0.16) * highGain,
            energy: 0.18 + rawKick * 0.16 + sway * 0.06,
            kick: idleKick,
            snare: idleSnare,
            hat: idleHat,
            beat: idleKick,
            impact: Math.max(idleKick, idleSnare * 0.72, idleHat * 0.42),
            inputLevel: 0,
          };

      // Development tests and live tuning tools can inspect the exact feature
      // frame that reached the shader without production-frame allocations.
      if (import.meta.env.DEV) {
        p.__audioFeatures = { ...bands, live: Boolean(frame) };
      }

      p.shader(effectShader);
      effectShader.setUniform('uResolution', [p.width, p.height]);
      effectShader.setUniform('uTime', elapsed);
      effectShader.setUniform('uSub', bands.sub);
      effectShader.setUniform('uMid', bands.mid);
      effectShader.setUniform('uHigh', bands.high);
      effectShader.setUniform('uEnergy', bands.energy);
      effectShader.setUniform('uKick', bands.kick);
      effectShader.setUniform('uSnare', bands.snare);
      effectShader.setUniform('uHat', bands.hat);
      effectShader.setUniform('uBeat', bands.beat);

      const custom = mapUniforms ? mapUniforms(P, bands, p) : {};
      for (const [name, value] of Object.entries(custom || {})) {
        effectShader.setUniform(name, value);
      }

      p.rect(0, 0, p.width, p.height);
    };

    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

    p.mousePressed = () => {
      if (audio) audio.resume(true);
    };
  };
}
