export default (audio, videoDeviceId, params, runtime) => (p) => {
  let capture;
  let theShader;
  let isCaptureReady = false;

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
    uniform float uNoise;
    uniform float uThresh;
    uniform float uContrast;
    uniform vec2 uRes;

    float rand(vec2 n) { 
      return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
    }

    void main() {
      vec2 uv = vTexCoord;
      uv.x = 1.0 - uv.x;
      uv.y = 1.0 - uv.y;

      // 1. DYNAMIC SLICE GLITCH
      // Shift random horizontal slices based on high frequency peaks
      float sliceY = floor(uv.y * 30.0);
      float sliceShift = step(0.9, rand(vec2(sliceY, floor(uTime * 10.0)))) * uHigh * 0.1;
      uv.x += sliceShift;

      // 2. JITTER DISPLACEMENT
      // Sub-bass jitter
      uv.x += (rand(vec2(uTime)) - 0.5) * uSub * 0.05;

      vec4 tex = texture2D(uTex, uv);
      float lum = (tex.r * 0.3 + tex.g * 0.59 + tex.b * 0.11);

      // 3. BIT-CRUSH / QUANTIZATION
      // Mid-range energy reduces the tonal range
      float levels = 10.0 - (uMid * 8.0);
      lum = floor(lum * levels) / levels;

      // 4. INDUSTRIAL THRESHOLDING
      float thresh = uThresh - (uSub * 0.1);
      float softness = 0.05 + (1.0 - uMid) * 0.15;
      float c = smoothstep(thresh, thresh + softness, lum);
      c = (c - 0.5) * uContrast + 0.5;

      // 5. REACTIVE NOISE
      float noise = rand(uv + uTime) * (0.1 + uHigh * 0.3);
      c += noise;

      // 6. SCANLINES
      float scanline = sin(uv.y * uRes.y * 0.8) * 0.1;
      c -= scanline;

      // 7. FLASH & INVERT
      // Ch 2 Noise drives global strobe and rapid inversions
      if (uNoise > 0.4 && rand(vec2(uTime)) > 0.8) {
        c = 1.0 - c;
      }
      
      // Flash on sub peaks
      if (uSub > 0.6 && rand(vec2(uTime)) > 0.95) {
        c += 0.2;
      }

      vec3 finalColor = vec3(c);
      
      // Minimal Red tint only on extreme peaks
      if (uHigh > 0.7) {
        finalColor.r += 0.05;
      }

      gl_FragColor = vec4(finalColor, 1.0);
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

    capture = runtime?.createCapture(p, constraints, () => {
      isCaptureReady = true;
      runtime?.reportMediaReady?.();
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
      runtime?.reportMediaReady?.();
    });
    capture.hide();
  };

  function analyzeBands(freqs) {
    if (!freqs) return { sub: 0, mid: 0, high: 0 };
    let sub = 0, mid = 0, high = 0;
    for (let i = 0; i < 3; i++) sub += freqs[i];
    for (let i = 20; i < 100; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];
    return {
      sub: (sub / 3) / 255,
      mid: (mid / 80) / 255,
      high: (high / 350) / 255
    };
  }

  p.draw = () => {
    p.background(0);
    if (!isCaptureReady || !capture?.loadedmetadata) return;

    const freqs = audio.getFrequencies();
    const amps = audio.getAmplitudes();
    const b1 = analyzeBands(freqs ? freqs.left : null);
    const b2 = analyzeBands(freqs ? freqs.right : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const threshold = P.threshold ?? 0.35;
    const contrast = P.contrast ?? 1;
    const react = P.react ?? 1;

    p.shader(theShader);

    const noiseLevel = (b2.mid + b2.high) * 0.5;

    theShader.setUniform('uTex', capture);
    theShader.setUniform('uTime', p.frameCount * 0.1);
    theShader.setUniform('uSub', (b1.sub || 0) * react);
    theShader.setUniform('uMid', (b1.mid || 0) * react);
    theShader.setUniform('uHigh', (b1.high || 0) * react);
    theShader.setUniform('uNoise', noiseLevel * react || 0);
    theShader.setUniform('uThresh', threshold);
    theShader.setUniform('uContrast', contrast);
    theShader.setUniform('uRes', [p.width, p.height]);

    p.rect(0, 0, p.width, p.height);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
