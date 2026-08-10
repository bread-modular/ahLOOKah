// Video Kaleidoscope — mirror-folds the camera feed N ways around a movable
// center. The fold spins with the speed slider, bass pumps the zoom, and the
// whole transform is a single-pass fragment shader for 60fps at any size.
import { makeAudioFeatures } from './audio-features.js';
import { FULLSCREEN_VERT } from './shader-utils.js';

export default (audio, videoDeviceId, params, runtime) => (p) => {
  let capture;
  let isCaptureReady = false;
  let kaleido;
  let elapsed = 0;
  let spin = 0;
  const getFeatures = makeAudioFeatures();

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uTex;
    uniform vec2 uResolution;
    uniform vec2 uTexScale;
    uniform float uTime;
    uniform float uSub;
    uniform float uMid;
    uniform float uSegments;
    uniform float uSpin;
    uniform float uZoom;
    uniform float uCx;
    uniform float uCy;
    uniform float uAudioZoom;

    void main() {
      vec2 uv = vTexCoord;
      float aspect = uResolution.x / max(uResolution.y, 1.0);

      // Aspect-corrected screen space, center offset by the cx/cy sliders
      vec2 pos = (uv - 0.5) * vec2(aspect, 1.0);
      pos += vec2(uCx, uCy) * 0.42;

      float r = length(pos) + 1.0e-4;
      float a = atan(pos.y, pos.x) + uSpin;

      // Fold the angle into one mirrored wedge
      float seg = 6.28318530718 / max(uSegments, 1.0);
      a = mod(a, seg);
      a = abs(a - seg * 0.5);

      // Bass/mids pump the zoom when audio-reactive zoom is up
      float zoom = uZoom * (1.0 + uSub * uAudioZoom * 0.55 + uMid * uAudioZoom * 0.18);
      r /= zoom;

      vec2 q = vec2(cos(a), sin(a)) * r;
      vec2 tuv = 0.5 + q * uTexScale;
      tuv = vec2(1.0 - tuv.x, 1.0 - tuv.y);

      vec3 col = texture2D(uTex, tuv).rgb;

      // Subtle shimmer along the folds + soft corner falloff
      col *= 0.95 + 0.05 * cos((a / seg) * 6.2831853 + uTime * 2.0);
      float d = length((uv - 0.5) * vec2(aspect, 1.0));
      col *= 0.8 + 0.2 * (1.0 - smoothstep(0.55, 1.3, d));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    kaleido = p.createShader(FULLSCREEN_VERT, frag);

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
      : { sub: 0.14 + 0.1 * Math.sin(elapsed * 1.9), mid: 0.1, high: 0.06 };

    const speed = P.speed ?? 0.6;
    spin += dt * speed * (0.55 + bands.sub * 1.5);

    // Cover-fit mapping from screen space to texture coords
    const A = p.width / Math.max(1, p.height);
    const T = capture.width / Math.max(1, capture.height);
    const texScale = A > T ? [1 / A, T / A] : [1 / T, 1];

    p.shader(kaleido);
    kaleido.setUniform('uTex', capture);
    kaleido.setUniform('uResolution', [p.width, p.height]);
    kaleido.setUniform('uTexScale', texScale);
    kaleido.setUniform('uTime', elapsed);
    kaleido.setUniform('uSub', bands.sub);
    kaleido.setUniform('uMid', bands.mid);
    kaleido.setUniform('uSegments', Math.max(1, Math.round(P.segments ?? 6)));
    kaleido.setUniform('uSpin', spin);
    kaleido.setUniform('uZoom', Math.max(0.05, P.zoom ?? 1));
    kaleido.setUniform('uCx', P.cx ?? 0);
    kaleido.setUniform('uCy', P.cy ?? 0);
    kaleido.setUniform('uAudioZoom', P.audioZoom ?? 1);
    p.rect(0, 0, p.width, p.height);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume(true);
  };
};
