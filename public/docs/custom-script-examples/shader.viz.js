api.requireVersion(1);
api.create({
  id: 'custom-shader', name: 'GLSL with offscreen texture', renderer: 'webgl',
  setup({ p, state, onCleanup }) {
    state.texture = p.createGraphics(64, 64);
    state.texture.background(20, 100, 220); state.texture.fill(250, 200, 40);
    state.texture.circle(32, 32, 32);
    onCleanup(() => state.texture.remove());
    state.shader = p.createShader(`
      precision highp float;
      attribute vec3 aPosition; attribute vec2 aTexCoord;
      varying vec2 uv;
      void main(){ uv=aTexCoord; gl_Position=vec4(aPosition.xy*2.0-1.0,0.0,1.0); }
    `, `
      precision highp float;
      varying vec2 uv; uniform float time; uniform sampler2D image;
      void main(){ vec2 q=fract(uv+vec2(sin(time)*0.1,0.0));
        gl_FragColor=texture2D(image,q)*vec4(0.7+0.3*sin(time+uv.x*6.28),1.0,1.0,1.0); }
    `);
  },
  draw({ p, state }) {
    p.shader(state.shader);
    state.shader.setUniform('time', p.millis() / 1000);
    state.shader.setUniform('image', state.texture);
    p.rect(0, 0, p.width, p.height); // custom shader draws a fullscreen quad
  },
});
