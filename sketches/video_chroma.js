// Video Chroma Key — GPU keyer. Pulls the selected key hue out of the camera
// feed and composites the result over a solid or slowly animated gradient
// background. Bass widens the key tolerance so the matte breathes with the
// music; everything runs in a single fragment shader pass.
import { makeAudioFeatures } from './audio-features.js';
import { FULLSCREEN_VERT } from './shader-utils.js';

export default (audio, videoDeviceId, params, runtime) => (p) => {
  let capture;
  let isCaptureReady = false;
  let keyer;
  let elapsed = 0;
  const getFeatures = makeAudioFeatures();

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uTex;
    uniform vec2 uCover;
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

      // Cover-map the capture onto the screen and mirror it (selfie view)
      vec2 tuv = 0.5 + (uv - 0.5) * uCover;
      tuv = vec2(1.0 - tuv.x, 1.0 - tuv.y);
      vec3 vid = texture2D(uTex, tuv).rgb;
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

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    keyer = p.createShader(FULLSCREEN_VERT, frag);

    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    };

    capture = runtime?.createCapture(p, constraints, () => {
      isCaptureReady = true;
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
    });
    capture.hide();
  };

  p.draw = () => {
    const P = params || {};
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;

    p.background(0);
    if (!isCaptureReady || !capture.loadedmetadata || !capture.width) return;

    const frame = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
      ? audio.getAnalysisFrame()
      : null;
    const measured = getFeatures(frame, P, dt);
    const bands = frame
      ? measured
      : { sub: 0.16 + 0.12 * Math.sin(elapsed * 2.1), mid: 0.12, high: 0.08 };

    // Cover-crop scales so the capture fills the screen without stretching
    const A = p.width / Math.max(1, p.height);
    const T = capture.width / Math.max(1, capture.height);
    const cover = A > T ? [1, T / A] : [A / T, 1];

    p.shader(keyer);
    keyer.setUniform('uTex', capture);
    keyer.setUniform('uCover', cover);
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
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume(true);
  };
};
