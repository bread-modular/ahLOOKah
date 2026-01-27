export default (audio, videoDeviceId) => (p) => {
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
    uniform vec2 uResolution;

    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      // Flip UVs for correct webcam orientation
      vec2 uv = vec2(1.0 - vTexCoord.x, 1.0 - vTexCoord.y);
      
      // Dot grid spacing - denser with higher mids
      float dotSpacing = mix(8.0, 3.0, uMid);
      
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
      float baseSize = brightness * 0.45;
      float dotSize = baseSize * (1.0 + uSub * 1.5);
      
      // Draw dot
      float dot = smoothstep(dotSize + 0.05, dotSize - 0.05, dist);
      
      // Glitchy rectangles on high frequencies
      float glitch = step(0.4, uHigh) * step(0.9, random(gridPos + floor(uTime)));
      if (glitch > 0.5) {
        float rect = step(abs(cellUV.y - 0.5), 0.1) * step(abs(cellUV.x - 0.5), 0.4);
        dot = max(dot, rect);
      }
      
      // Only show if bright enough
      dot *= step(0.08, brightness);
      
      // Alpha varies with brightness  
      float alpha = mix(0.4, 1.0, brightness);
      vec3 color = vec3(dot * alpha);
      
      // Scanline noise on mid peaks
      if (uMid > 0.3) {
        float noise = step(0.97, random(vec2(uv.x, floor(uv.y * 80.0) + uTime)));
        color += noise * 0.2;
      }
      
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

    p.shader(theShader);
    theShader.setUniform('uTex', capture);
    theShader.setUniform('uTime', p.frameCount * 0.05);
    theShader.setUniform('uSub', b.sub);
    theShader.setUniform('uMid', b.mid);
    theShader.setUniform('uHigh', b.high);
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
