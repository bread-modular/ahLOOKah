// Video Dots GPU — dot-matrix rendering of the camera feed with audio-reactive
// density, glitch rectangles and RGB shift. The opted-in path consumes the
// render-ready boosted band levels produced by the DOM-free capture-side
// controller; the legacy raw-frame path is kept intact.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 4, neutral: 0 },
    mid: { min: 0, max: 4, neutral: 0 },
    high: { min: 0, max: 4, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { sub: 0, mid: 0, high: 0 },
  },
});

export function analyzeBands(freqs) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0 };
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 3; i++) sub += freqs[i] || 0;
  for (let i = 20; i < 100; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  return {
    sub: (sub / 3) / 255,
    mid: (mid / 80) / 255,
    high: (high / 350) / 255
  };
}

// The controller owns the byte-spectrum band analysis and the reactivity gain.
// The old renderer boosted each band by 2x and scaled it by the react slider
// before uploading uniforms; that mapping now lives on the capture owner, so
// the renderer uploads the supplied levels directly.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeBands(freqs.left);
      const react = Math.max(0, Number(params.react ?? 1));
      return {
        continuous: {
          sub: clamp(b.sub * 2.0 * react, 0, 4),
          mid: clamp(b.mid * 2.0 * react, 0, 4),
          high: clamp(b.high * 2.0 * react, 0, 4),
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
  let theShader;
  let isCaptureReady = false;
  const fxMode = runtimeContext?.inputMode === 'fx';
  const audioControls = runtimeContext?.audioControls || null;

  const vert = `
    precision highp float;
    attribute vec3 aPosition;
    attribute vec2 aTexCoord;
    varying vec2 vTexCoord;
    void main() {
      vTexCoord = aTexCoord;
      vec4 positionVec4 = vec4(aPosition, 1.0);
      positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
      gl_Position = positionVec4;
    }
  `;

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uTex;
    uniform float uTime;
    uniform float uSub;
    uniform float uMid;
    uniform float uHigh;
    uniform float uSpacing;
    uniform float uGlitch;
    uniform vec2 uResolution;
    uniform vec2 uFxFit;
    uniform float uFxMode;

    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      // Source keeps its existing selfie transform. FX contains the upstream
      // image without mirroring, flipping Y for unflipped canvas uploads.
      vec2 uv = vec2(uFxMode > 0.5 ? vTexCoord.x : 1.0 - vTexCoord.x, 1.0 - vTexCoord.y);
      if (uFxMode > 0.5) {
        uv = 0.5 + (uv - 0.5) * uFxFit;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
          gl_FragColor = vec4(0.0);
          return;
        }
      }

      // Subtle horizontal displacement on sub-bass hits
      float blockY = floor(uv.y * 15.0);
      float displace = step(0.5, uSub) * step(0.85, random(vec2(blockY, floor(uTime)))) * 0.03;
      uv.x += displace;
      if (uFxMode > 0.5 && uv.x > 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      // Dot grid spacing - denser with higher mids
      float dotSpacing = mix(uSpacing, 5.0, uMid);
      
      // Calculate grid cell
      vec2 gridPos = floor(uv * uResolution / dotSpacing);
      vec2 cellCenter = (gridPos + 0.5) * dotSpacing / uResolution;
      
      // Sample texture at cell center (the last partial FX cell is clamped).
      vec4 texColor = texture2D(uTex, uFxMode > 0.5 ? clamp(cellCenter, vec2(0.0), vec2(1.0)) : cellCenter);
      vec3 sampleRgb = uFxMode > 0.5 ? texColor.rgb / max(texColor.a, 0.00001) : texColor.rgb;
      float brightness = (sampleRgb.r + sampleRgb.g + sampleRgb.b) / 3.0;
      
      // Position within cell (0 to 1)
      vec2 cellUV = fract(uv * uResolution / dotSpacing);
      float dist = length(cellUV - 0.5);
      
      // Dot size based on brightness and sub-bass
      float baseSize = brightness * 0.55;
      float dotSize = baseSize * (1.0 + uSub * 1.5);
      
      // Draw dot
      float dot = 1.0 - smoothstep(dotSize - 0.05, dotSize + 0.05, dist);
      
      // Glitchy rectangles on high frequencies (frequency scales with uGlitch)
      float glitch = step(0.5, uHigh) * step(0.98 - 0.06 * uGlitch, random(gridPos + floor(uTime)));
      if (glitch > 0.5) {
        float rect = step(abs(cellUV.y - 0.5), 0.1) * step(abs(cellUV.x - 0.5), 0.4);
        dot = max(dot, rect);
      }
      
      // Only show if bright enough
      dot *= step(0.08, brightness);
      
      // Alpha varies with brightness  
      float alpha = mix(0.4, 1.0, brightness);
      
      // Mild RGB shift on highs
      vec3 color;
      if (uHigh > 0.4) {
        float shift = 0.04;
        float dotR = 1.0 - smoothstep(dotSize - 0.05, dotSize + 0.05, length(cellUV - vec2(0.5 - shift, 0.5)));
        float dotB = 1.0 - smoothstep(dotSize - 0.05, dotSize + 0.05, length(cellUV - vec2(0.5 + shift, 0.5)));
        color = vec3(dotR, dot, dotB) * alpha;
      } else {
        color = vec3(dot * alpha);
      }
      
      // Occasional scanline on mids
      float scanline = step(0.4, uMid) * step(0.98, random(vec2(0.0, floor(uv.y * 50.0) + uTime)));
      color += scanline * 0.15;
      
      // Keep the original opaque camera look; FX respects the sampled cell's
      // alpha, including transparent source pixels and letterbox borders.
      gl_FragColor = vec4(color, uFxMode > 0.5 ? texColor.a : 1.0);
    }
  `;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    theShader = p.createShader(vert, frag);

    // FX borrows a graph-owned image; do not try shared OR raw capture.
    if (fxMode) return;
    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
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
      return isCaptureReady && capture?.loadedmetadata ? { source: capture } : null;
    }
    const frame = runtimeContext?.getImageInput?.();
    return frame?.source && frame.width > 0 && frame.height > 0
      && frame.source.width === frame.width && frame.source.height === frame.height
      ? frame : null;
  }

  function drawEffect(frame, bands, P) {
    const A = p.width / Math.max(1, p.height);
    const T = fxMode ? frame.width / frame.height : A;
    const fit = fxMode ? (A > T ? [A / T, 1] : [1, T / A]) : [1, 1];

    p.shader(theShader);
    // The core re-uploads a canvas texture on each uniform bind, including
    // when the graph reuses the same canvas for successive frame IDs.
    theShader.setUniform('uTex', frame.source);
    theShader.setUniform('uFxMode', fxMode ? 1 : 0);
    theShader.setUniform('uFxFit', fit);
    theShader.setUniform('uTime', p.frameCount * 0.05);
    theShader.setUniform('uSub', bands.sub);
    theShader.setUniform('uMid', bands.mid);
    theShader.setUniform('uHigh', bands.high);
    theShader.setUniform('uSpacing', P.spacing ?? 12);
    theShader.setUniform('uGlitch', P.glitch ?? 1);
    theShader.setUniform('uResolution', fxMode ? [frame.width, frame.height] : [p.width, p.height]);
    p.rect(0, 0, p.width, p.height);
  }

  p.draw = () => {
    if (fxMode) p.clear();
    else p.background(0);
    const frame = imageFrame();
    if (!frame) return;

    const P = params || {};
    let bands;
    if (audioControls) {
      const controls = audioControls.read();
      bands = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    } else {
      // The standalone camera prompt remains source-only: FX renders its image
      // with neutral levels when audio has not yet started.
      if ((!audio || !audio.isStarted) && !fxMode) {
        p.fill(255);
        p.textAlign(p.CENTER, p.CENTER);
        p.text("CLICK TO START AUDIO", 0, 0);
        return;
      }
      const freqs = audio?.isStarted ? audio.getFrequencies() : null;
      const b = analyzeBands(freqs ? freqs.left : null);
      const react = P.react ?? 1;
      bands = { sub: b.sub * 2.0 * react, mid: b.mid * 2.0 * react, high: b.high * 2.0 * react };
    }
    drawEffect(frame, bands, P);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
