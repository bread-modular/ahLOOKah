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

    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      // Flip UVs for correct webcam orientation
      vec2 uv = vec2(1.0 - vTexCoord.x, 1.0 - vTexCoord.y);
      
      // Subtle horizontal displacement on sub-bass hits
      float blockY = floor(uv.y * 15.0);
      float displace = step(0.5, uSub) * step(0.85, random(vec2(blockY, floor(uTime)))) * 0.03;
      uv.x += displace;
      
      // Dot grid spacing - denser with higher mids
      float dotSpacing = mix(uSpacing, 5.0, uMid);
      
      // Calculate grid cell
      vec2 gridPos = floor(uv * uResolution / dotSpacing);
      vec2 cellCenter = (gridPos + 0.5) * dotSpacing / uResolution;
      
      // Sample texture at cell center
      vec4 texColor = texture2D(uTex, cellCenter);
      float brightness = (texColor.r + texColor.g + texColor.b) / 3.0;
      
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
      
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    theShader = p.createShader(vert, frag);

    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };

    capture = runtimeContext?.createCapture(p, constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    });
    capture.hide();
  };

  function drawMigrated() {
    p.background(0);
    if (!isCaptureReady || !capture?.loadedmetadata) return;

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const spacing = P.spacing ?? 12;
    const glitch = P.glitch ?? 1;

    p.shader(theShader);
    theShader.setUniform('uTex', capture);
    theShader.setUniform('uTime', p.frameCount * 0.05);
    // Boosted band levels already include the legacy 2x + reactivity mapping
    theShader.setUniform('uSub', C.sub);
    theShader.setUniform('uMid', C.mid);
    theShader.setUniform('uHigh', C.high);
    theShader.setUniform('uSpacing', spacing);
    theShader.setUniform('uGlitch', glitch);
    theShader.setUniform('uResolution', [p.width, p.height]);

    p.rect(0, 0, p.width, p.height);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    p.background(0);
    if (!isCaptureReady || !capture?.loadedmetadata) return;

    if (!audio || !audio.isStarted) {
      p.fill(255);
      p.textAlign(p.CENTER, p.CENTER);
      p.text("CLICK TO START AUDIO", 0, 0);
      return;
    }

    const freqs = audio.getFrequencies();
    const b = analyzeBands(freqs ? freqs.left : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const spacing = P.spacing ?? 12;
    const glitch = P.glitch ?? 1;
    const react = P.react ?? 1;

    p.shader(theShader);
    theShader.setUniform('uTex', capture);
    theShader.setUniform('uTime', p.frameCount * 0.05);
    // Boost the values a bit to make effects more visible
    theShader.setUniform('uSub', b.sub * 2.0 * react);
    theShader.setUniform('uMid', b.mid * 2.0 * react);
    theShader.setUniform('uHigh', b.high * 2.0 * react);
    theShader.setUniform('uSpacing', spacing);
    theShader.setUniform('uGlitch', glitch);
    theShader.setUniform('uResolution', [p.width, p.height]);

    p.rect(0, 0, p.width, p.height);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
