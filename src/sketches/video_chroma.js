// Video Chroma Key — GPU keyer. Pulls the selected key hue out of the camera
// feed and composites the result over a solid or slowly animated gradient
// background. Bass widens the key tolerance so the matte breathes with the
// music; everything runs in a single fragment shader pass.
// The opted-in path consumes render-ready sub/mid/high levels produced by the
// DOM-free capture-side controller; the legacy raw-frame path is kept intact.
import { makeAudioFeatures } from './audio-features.js';
import { FULLSCREEN_VERT } from './shader-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 1.6, neutral: 0 },
    mid: { min: 0, max: 1.6, neutral: 0 },
    high: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { sub: 0, mid: 0, high: 0 },
  },
});

// The controller owns the canonical feature mapping. The renderer previously
// derived sub/mid/high per frame through makeAudioFeatures(); the capture owner
// now supplies the same levels through the shared analysis view. The
// audioReact parameter is applied by the shader (uAudioReact), so the
// controller only emits the band levels themselves.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const features = shared?.getFeatures?.() || {};
      return {
        continuous: {
          sub: clamp(Number(features.sub) || 0, 0, 1.6),
          mid: clamp(Number(features.mid) || 0, 0, 1.6),
          high: clamp(Number(features.high) || 0, 0, 1.6),
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let capture;
  let isCaptureReady = false;
  let keyer;
  let elapsed = 0;
  const fxMode = runtimeContext?.inputMode === 'fx';
  const audioControls = runtimeContext?.audioControls || null;
  const getFeatures = makeAudioFeatures();

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uTex;
    uniform vec2 uCover;
    uniform float uFxMode;
    uniform float uTime;
    uniform float uSub;
    uniform float uMid;
    uniform float uHigh;
    uniform float uKeyHue;
    uniform float uTolerance;
    uniform float uSoftness;
    uniform float uBgMode;
    uniform float uBgHue;
    uniform float uBgSat;
    uniform float uBgBright;
    uniform float uAudioReact;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 q = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 r = mix(vec4(q.xyw, c.r), vec4(c.r, q.yzx), step(q.x, c.r));
      float d = r.x - min(r.w, r.y);
      float e = 1.0e-10;
      return vec3(abs(r.z + (r.w - r.y) / (6.0 * d + e)), d / (r.x + e), r.x);
    }

    vec3 hsv2rgb(vec3 c) {
      vec3 q = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      vec3 rgb = clamp(q - 1.0, 0.0, 1.0);
      rgb = rgb * rgb * (3.0 - 2.0 * rgb);
      return c.z * mix(vec3(1.0), rgb, c.y);
    }

    void main() {
      vec2 uv = vTexCoord;

      // Source: legacy cover crop + selfie mirror. FX: contain the graph image
      // without a horizontal flip; both need a Y flip for canvas texture upload.
      vec2 tuv = 0.5 + (uv - 0.5) * uCover;
      if (uFxMode > 0.5 && (any(lessThan(tuv, vec2(0.0))) || any(greaterThan(tuv, vec2(1.0))))) {
        gl_FragColor = vec4(0.0);
        return;
      }
      tuv = vec2(uFxMode > 0.5 ? tuv.x : 1.0 - tuv.x, 1.0 - tuv.y);
      vec4 texel = texture2D(uTex, tuv);
      // Canvas uploads are premultiplied; unpremultiply only the FX sample so
      // keying/colour calculations do not darken partially transparent inputs.
      vec3 vid = uFxMode > 0.5 ? texel.rgb / max(texel.a, 0.00001) : texel.rgb;
      vec3 hsv = rgb2hsv(vid);

      // Hue-distance matte: pixels near the key hue become transparent
      float hueDist = abs(hsv.x - uKeyHue);
      hueDist = min(hueDist, 1.0 - hueDist);
      float tol = uTolerance + uSub * uAudioReact * 0.16 + uHigh * uAudioReact * 0.05;
      float matte = smoothstep(tol, tol + max(uSoftness, 0.002), hueDist);
      // Only key chromatic, non-black pixels so skin/shadows/gray stay solid
      float gate = smoothstep(0.09, 0.30, hsv.y) * smoothstep(0.02, 0.14, hsv.z);
      float alpha = mix(1.0, matte, gate);

      // Background: solid color or drifting two-hue gradient
      float ang = uTime * 0.22;
      float axis = uv.x * cos(ang) + uv.y * sin(ang);
      float wave = 0.5 + 0.5 * sin(axis * 6.2831853 + uTime * 0.7);
      vec3 bgA = hsv2rgb(vec3(uBgHue, uBgSat, uBgBright));
      vec3 bgB = hsv2rgb(vec3(
        fract(uBgHue + 0.16 + 0.10 * sin(uTime * 0.13)), uBgSat, uBgBright));
      vec3 grad = mix(bgA, bgB, wave);
      grad += bgB * 0.05 * sin(uv.y * 34.0 + uTime * 1.8);
      vec3 bg = mix(bgA, grad, step(0.5, uBgMode));
      bg *= 0.92 + 0.08 * sin(uTime * 0.5) + uSub * 0.22;

      vec3 col = mix(bg, vid, alpha);

      // Soft chroma spill suppression near matte edges
      float spill = (1.0 - matte) * gate;
      col = mix(col, vec3(dot(col, vec3(0.333))), spill * 0.25);

      // The key is composited over the selected background as before; in FX
      // mode only the incoming image's coverage (including alpha) is retained.
      gl_FragColor = vec4(col, uFxMode > 0.5 ? texel.a : 1.0);
    }
  `;

  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    keyer = p.createShader(FULLSCREEN_VERT, frag);

    // A graph FX borrows a canvas; it must not even enter capture setup (a
    // missing shared capture would otherwise fall back to p.createCapture).
    if (fxMode) return;
    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    };

    capture = runtimeContext?.createCapture?.(p, constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    });
    capture.hide();
  };

  function imageFrame() {
    if (!fxMode) {
      return isCaptureReady && capture?.loadedmetadata && capture?.width
        ? { source: capture, width: capture.width, height: capture.height }
        : null;
    }
    const frame = runtimeContext?.getImageInput?.();
    // Only an actual, nonempty graph canvas is usable; never consult capture
    // metadata or cache a borrowed frame across draws.
    return frame?.source && frame.width > 0 && frame.height > 0
      && frame.source.width === frame.width && frame.source.height === frame.height
      ? frame : null;
  }

  function drawEffect(frame, bands, P) {
    const A = p.width / Math.max(1, p.height);
    const T = frame.width / Math.max(1, frame.height);
    // The source cover transform is unchanged. FX instead uses inverse
    // contain scaling, with transparent bars outside the upstream image.
    const fit = fxMode
      ? (A > T ? [A / T, 1] : [1, T / A])
      : (A > T ? [1, T / A] : [A / T, 1]);

    p.shader(keyer);
    keyer.setUniform('uTex', frame.source);
    keyer.setUniform('uCover', fit);
    keyer.setUniform('uFxMode', fxMode ? 1 : 0);
    keyer.setUniform('uTime', elapsed);
    keyer.setUniform('uSub', bands.sub);
    keyer.setUniform('uMid', bands.mid);
    keyer.setUniform('uHigh', bands.high);
    keyer.setUniform('uKeyHue', (((P.keyHue ?? 120) % 360) + 360) % 360 / 360);
    keyer.setUniform('uTolerance', P.tolerance ?? 0.16);
    keyer.setUniform('uSoftness', P.softness ?? 0.12);
    keyer.setUniform('uBgMode', P.bgMode ?? 1);
    keyer.setUniform('uBgHue', (((P.bgHue ?? 275) % 360) + 360) % 360 / 360);
    keyer.setUniform('uBgSat', P.bgSat ?? 0.7);
    keyer.setUniform('uBgBright', P.bgBright ?? 0.55);
    keyer.setUniform('uAudioReact', P.audioReact ?? 1);
    p.rect(0, 0, p.width, p.height);
  }

  p.draw = () => {
    const P = params || {};
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;
    if (fxMode) p.clear();
    else p.background(0);
    const frame = imageFrame();
    if (!frame) return;

    let bands;
    if (audioControls) {
      const controls = audioControls.read();
      const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
      bands = { sub: C.sub, mid: C.mid, high: C.high };
    } else {
      // Preserved raw-frame analysis/idle mapping for standalone callers.
      const analysis = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
        ? audio.getAnalysisFrame()
        : null;
      const measured = getFeatures(analysis, P, dt);
      bands = analysis
        ? measured
        : { sub: 0.16 + 0.12 * Math.sin(elapsed * 2.1), mid: 0.12, high: 0.08 };
    }
    drawEffect(frame, bands, P);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume(true);
  };
};
