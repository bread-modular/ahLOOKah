export default (audio, videoDeviceId, params) => (p) => {
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
    uniform float uShift;
    uniform float uScan;
    uniform float uResolution[2];

    void main() {
      vec2 uv = vTexCoord;
      // Correct coordinate mapping: Mirror horizontally and flip vertically
      uv.x = 1.0 - uv.x;
      uv.y = 1.0 - uv.y;

      // Subtle displacement based on sub-bass
      float distortion = sin(uv.y * 8.0 + uTime) * uSub * 0.015;
      uv.x += distortion;

      // Rhythmic Block Glitch (High peaks)
      float blockyUV = floor(uv.y * 50.0);
      float noiseShift = step(0.9, fract(sin(blockyUV + uTime * 5.0) * 43758.5453)) * uHigh * 0.05;
      uv.x += noiseShift;

      // Sampling with RGB Shift
      float shift = uHigh * 0.015 * uShift;
      vec4 rCol = texture2D(uTex, uv + vec2(shift, 0.0));
      vec4 gCol = texture2D(uTex, uv);
      vec4 bCol = texture2D(uTex, uv - vec2(shift, 0.0));
      
      // Grayscale and Contrast
      float luminance = (gCol.r + gCol.g + gCol.b) / 3.0;
      luminance = pow(luminance, 1.2); // Crushing blacks a bit

      // Edge-ish highlight on Mid Peaks
      float highlight = step(0.6, luminance) * uMid * 0.4;
      vec3 color = vec3(luminance + highlight);

      // Techno red pulse
      if (uHigh > 0.5) {
        color.r += 0.2;
      }

      // CRT Scanlines
      float scanline = sin(uv.y * uResolution[1] * 1.2) * 0.08 * uScan;
      color -= scanline;

      // Vignette
      float d = distance(vTexCoord, vec2(0.5));
      color *= smoothstep(0.8, 0.4, d);

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

    capture = p.createCapture(constraints, () => {
      isCaptureReady = true;
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
    if (!isCaptureReady || !capture.loadedmetadata) return;

    const freqs = audio.getFrequencies();
    const b = analyzeBands(freqs ? freqs.left : null);

    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const shift = P.shift ?? 1;
    const scan = P.scan ?? 1;
    const react = P.react ?? 1;

    p.shader(theShader);

    theShader.setUniform('uTex', capture);
    theShader.setUniform('uTime', p.frameCount * 0.05);
    theShader.setUniform('uSub', b.sub * react);
    theShader.setUniform('uMid', b.mid * react);
    theShader.setUniform('uHigh', b.high * react);
    theShader.setUniform('uShift', shift);
    theShader.setUniform('uScan', scan);
    theShader.setUniform('uResolution', [p.width, p.height]);

    p.rect(0, 0, p.width, p.height);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
