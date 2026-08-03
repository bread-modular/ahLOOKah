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
      float dot = smoothstep(dotSize + 0.05, dotSize - 0.05, dist);
      
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
        float dotR = smoothstep(dotSize + 0.05, dotSize - 0.05, length(cellUV - vec2(0.5 - shift, 0.5)));
        float dotB = smoothstep(dotSize + 0.05, dotSize - 0.05, length(cellUV - vec2(0.5 + shift, 0.5)));
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
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
