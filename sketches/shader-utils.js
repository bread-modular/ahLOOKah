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

// GLSL lint convention — smoothstep edge order:
//   ALWAYS call smoothstep(edge0, edge1, x) with edge0 < edge1.
//   For an inverted falloff use 1.0 - smoothstep(low, high, x), NEVER
//   smoothstep(high, low, x) which is undefined in GLSL when edge0 >= edge1.
//   This header documents the rule so future shaders don't regress.
// Common GLSL helpers kept intentionally WebGL 1 / GLSL ES 1.00 compatible.
export const AUDIO_SHADER_HEADER = `
  precision highp float;
  varying vec2 vTexCoord;

  uniform vec2 uResolution;
  // canvas vs buffer: single-density policy (pixelDensity(1)) — both are passed
  // consistently so shaders can pick the right one. uResolution is the drawing
  // buffer size (p.width/p.height after renderScale); the canvas uniforms are
  // the CSS/layout size (p.windowWidth/windowHeight). For aspect, either works
  // (same ratio); for pixel-frequency effects use the buffer or canvas explicitly.
  uniform vec2 uCanvasResolution;
  uniform vec2 uDrawingBufferResolution;
  uniform float uRenderScale;
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

  // Helper for inverted smoothstep falloff (lint-safe): use this instead of reversed edges.
  float smoothstepInv(float edge0, float edge1, float x) {
    return 1.0 - smoothstep(edge0, edge1, x);
  }
`;

export function makeAudioShader(audio, params, fragmentSource, mapUniforms, options = {}) {
  return (p) => {
    let effectShader;
    let elapsed = 0;
    // Opted-in patterns receive render-ready controls from the capture owner.
    // Do not even construct the local FFT feature extractor on that path.
    const controlsBinding = options.audioControls || null;
    const getFeatures = controlsBinding ? null : makeAudioFeatures();

    // Adaptive rendering: decide internal buffer scale. Heavy raymarch shaders
    // (large per-pixel loops) default to ~0.65-0.70 to avoid stalling LIVE/CUE/MERGE
    // on weak GPUs; light shaders stay at 1.0. Single density policy: pixelDensity(1)
    // always, so buffer size is explicitly controlled via renderScale, not by OS DPI.
    const loopCounts = [...fragmentSource.matchAll(/for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
    const maxLoop = loopCounts.length ? Math.max(...loopCounts) : 0;
    const hintHeavy = /mapCathedral|mandelbulb|mapScene|mapCrystals|calcNormal|sceneSDF/.test(fragmentSource);
    let renderScale = options.renderScale;
    if (renderScale == null) {
      if (maxLoop >= 90) renderScale = 0.65;
      else if (maxLoop >= 60 || hintHeavy) renderScale = 0.70;
      else if (maxLoop >= 18 && /cloudDensity|volumetric|raymarch/i.test(fragmentSource)) renderScale = 0.75;
      else renderScale = 1;
    }
    renderScale = Math.max(0.4, Math.min(1, renderScale));

    p.setup = () => {
      // Single density policy: fixed 1x backing density. Heavier ray-marched looks
      // use renderScale (<1) for adaptive internal resolution instead of DPI scaling,
      // keeping 1080p/4K smooth while avoiding accidental 4x work on Retina.
      p.pixelDensity(1);
      const bufferW = Math.max(1, Math.floor(p.windowWidth * renderScale));
      const bufferH = Math.max(1, Math.floor(p.windowHeight * renderScale));
      p.createCanvas(bufferW, bufferH, p.WEBGL);
      if (renderScale !== 1) {
        // Stretch the reduced buffer to full window via CSS — keeps visual look
        // close while quadratically cutting fragment work (0.7 -> ~0.49 fill rate).
        p.canvas.style.width = p.windowWidth + 'px';
        p.canvas.style.height = p.windowHeight + 'px';
      }
      p.canvas.style.display = 'block';
      p.noStroke();
      effectShader = p.createShader(FULLSCREEN_VERT, fragmentSource);
    };

    p.draw = () => {
      const P = params || {};
      const deltaSeconds = Math.min(p.deltaTime || 16.667, 100) / 1000;
      elapsed += deltaSeconds;

      const controls = controlsBinding?.read?.() || null;
      let frame = null;
      let bands;
      if (controlsBinding) {
        // The migrated path maps only the controller's final custom uniforms.
        // Header audio uniforms remain deterministic neutral values for shader
        // compatibility, without any local musical/idle calculation.
        bands = { sub: 0, mid: 0, high: 0, energy: 0, kick: 0, snare: 0, hat: 0, beat: 0, impact: 0, inputLevel: 0 };
      } else {
        frame = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
          ? audio.getAnalysisFrame()
          : null;
        const measured = getFeatures(frame, P, deltaSeconds);
        // Keep legacy shader effects stage-ready before an input is selected.
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
        const idleBands = {
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
        bands = frame ? measured : idleBands;
      }

      // Development tests and live tuning tools can inspect the exact feature
      // frame that reached the shader without production-frame allocations.
      if (import.meta.env.DEV) {
        p.__audioFeatures = { ...bands, live: controlsBinding ? Boolean(controls?.isFresh) : Boolean(frame) };
      }

      p.shader(effectShader);
      // Resolution policy: single density (pixelDensity(1)) + explicit renderScale.
      // Pass BOTH canvas (CSS/layout) and drawing-buffer (actual pixels) sizes
      // consistently. uResolution remains the buffer size for backward compat.
      effectShader.setUniform('uResolution', [p.width, p.height]);
      effectShader.setUniform('uCanvasResolution', [p.windowWidth, p.windowHeight]);
      effectShader.setUniform('uDrawingBufferResolution', [p.width, p.height]);
      effectShader.setUniform('uRenderScale', renderScale);
      effectShader.setUniform('uTime', elapsed);
      effectShader.setUniform('uSub', bands.sub);
      effectShader.setUniform('uMid', bands.mid);
      effectShader.setUniform('uHigh', bands.high);
      effectShader.setUniform('uEnergy', bands.energy);
      effectShader.setUniform('uKick', bands.kick);
      effectShader.setUniform('uSnare', bands.snare);
      effectShader.setUniform('uHat', bands.hat);
      effectShader.setUniform('uBeat', bands.beat);

      const custom = mapUniforms ? mapUniforms(P, bands, p, controls) : {};
      for (const [name, value] of Object.entries(custom || {})) {
        effectShader.setUniform(name, value);
      }

      p.rect(0, 0, p.width, p.height);
    };

    p.windowResized = () => {
      const bufferW = Math.max(1, Math.floor(p.windowWidth * renderScale));
      const bufferH = Math.max(1, Math.floor(p.windowHeight * renderScale));
      p.resizeCanvas(bufferW, bufferH);
      if (renderScale !== 1) {
        p.canvas.style.width = p.windowWidth + 'px';
        p.canvas.style.height = p.windowHeight + 'px';
      }
    };

    p.mousePressed = () => {
      if (audio) audio.resume(true);
    };
  };
}
